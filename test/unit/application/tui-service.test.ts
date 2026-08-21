import { chmod, lstat, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBazframeTuiService,
  type BazframeTuiServiceOptions
} from '../../../src/application/tui-service.js';
import {
  addProfile,
  listProfiles,
  renameProfile
} from '../../../src/profiles/profile-management.js';
import {
  encodeProfileFavorites,
  profileFavoritesPath,
  readProfileFavorites
} from '../../../src/profiles/profile-favorites.js';
import { readActiveProfile, writeActiveProfile } from '../../../src/profiles/profile-store.js';
import { encodeProfileCollectionReference } from '../../../src/profiles/profile-skill-collection-reference.js';
import { addLibrary } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('Bazframe TUI service', () => {
  it('projects profiles, available Skills, managed memberships, and diagnostics without CLI text', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await symlink(fixture.source, fixture.directory.path(
      'home/profiles/reviewer/skills/demo-skill'
    ));
    await fixture.directory.write(
      'home/profiles/reviewer/skills/local-skill/SKILL.md',
      skill('local-skill')
    );

    const first = await fixture.service.loadDashboard();
    expect(first.revision).toBe(1);
    expect(first.activeProfileId).toBe('focused');
    expect(() => JSON.stringify(first.profiles.map((profile) => profile.removalIdentity)))
      .not.toThrow();
    expect(first.profiles.map((profile) => profile.id)).toEqual(['focused', 'reviewer']);
    expect(first.availableSkillGroups).toMatchObject([{
      id: 'default',
      artifactWritesSupported: false,
      skills: [{ id: 'demo-skill', originId: 'default' }]
    }]);
    expect(first.status).toMatchObject({
      state: 'available',
      value: {
        adapter: { state: 'missing' },
        repository: { kind: 'outside-git' },
        effectiveBehavior: { kind: 'outside-git', enabled: true, reason: 'global-enabled' },
        profile: { state: 'ready', id: 'focused' }
      }
    });
    const reviewer = first.profiles.find((profile) => profile.id === 'reviewer');
    expect(reviewer?.memberships).toMatchObject([
      { skillId: 'demo-skill', kind: 'managed', manageable: true },
      { skillId: 'local-skill', kind: 'unmanaged', manageable: false }
    ]);
    expect((await fixture.service.loadDashboard()).revision).toBe(2);
  });

  it('mutates an explicit inactive profile and preserves active selection and provider content', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();

    await fixture.service.addMembership('reviewer', {
      originId: 'default',
      skillId: 'demo-skill'
    });
    expect(await readActiveProfile(fixture.home)).toBe('focused');
    expect(await readlink(fixture.directory.path(
      'home/profiles/reviewer/skills/demo-skill'
    ))).toBe(fixture.source);
    expect(await fixture.directory.readText(
      'provider/demo-skill/SKILL.md'
    )).toBe(skill('demo-skill'));

    const reviewer = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer');
    const membership = reviewer?.memberships.find((entry) => entry.skillId === 'demo-skill');
    expect(membership).toBeDefined();
    await fixture.service.removeMembership('reviewer', {
      membershipId: membership!.membershipId,
      originId: membership!.originId!,
      skillId: membership!.skillId
    });
    await expect(lstat(fixture.directory.path(
      'home/profiles/reviewer/skills/demo-skill'
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fixture.directory.readText(
      'provider/demo-skill/SKILL.md'
    )).toBe(skill('demo-skill'));
  });

  it('keeps a CLI-valid AGENTS-only profile visible while disabling membership writes', async () => {
    const fixture = await createFixture();
    await rm(fixture.directory.path('home/profiles/reviewer/skills'), { recursive: true });

    expect((await listProfiles(fixture.home)).profileIds).toContain('reviewer');
    const dashboard = await fixture.service.loadDashboard();
    expect(dashboard.profiles.find((profile) => profile.id === 'reviewer')).toMatchObject({
      membershipWritable: false,
      memberships: [],
      membershipDiagnostic: expect.stringContaining('no skills directory')
    });
    expect(dashboard.diagnostics.map((entry) => entry.message).join('\n'))
      .toContain('no skills directory');
  });

  it('requires exact recursive-removal authorization and a recognized Skill origin', async () => {
    const fixture = await createFixture();
    const reviewer = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer');
    expect(reviewer).toBeDefined();
    await expect(fixture.service.removeProfile('reviewer', {
      kind: 'recursive',
      confirmedProfileId: 'focused',
      removalIdentity: reviewer!.removalIdentity
    })).rejects.toThrow(/exactly match/u);
    await expect(fixture.service.addMembership('reviewer', {
      originId: 'other',
      skillId: 'demo-skill'
    })).rejects.toThrow(/Unknown Skill origin/u);
    await expect(fixture.service.removeMembership('reviewer', {
      membershipId: 'focused:default:demo-skill',
      originId: 'default',
      skillId: 'demo-skill'
    })).rejects.toThrow(/Stale profile skill membership reference/u);
    expect((await lstat(fixture.directory.path('home/profiles/reviewer'))).isDirectory())
      .toBe(true);
  });

  it('binds recursive authorization to the disclosed profile instance and metadata', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await fixture.service.addMembership('reviewer', {
      originId: 'default',
      skillId: 'demo-skill'
    });
    const reviewed = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer');
    expect(reviewed).toBeDefined();

    // A cooperating second client replaces the reviewed ID while holding the
    // same core global state lock used by all profile lifecycle operations.
    await renameProfile(fixture.home, 'reviewer', 'archived-reviewer');
    await addProfile(fixture.home, 'reviewer');
    await fixture.directory.write(
      'home/profiles/reviewer/AGENTS.md',
      'replacement instructions\n'
    );

    await expect(fixture.service.removeProfile('reviewer', {
      kind: 'recursive',
      confirmedProfileId: 'reviewer',
      removalIdentity: reviewed!.removalIdentity
    })).rejects.toMatchObject({ code: 'PROFILE_REMOVE_AUTHORIZATION_STALE' });
    expect(await fixture.directory.readText('home/profiles/reviewer/AGENTS.md'))
      .toBe('replacement instructions\n');
    expect(await fixture.directory.readText('home/profiles/archived-reviewer/AGENTS.md'))
      .toBe('reviewer\n');
  });

  it('invalidates snapshots for AGENTS and membership metadata without reading provider targets', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    const original = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer')!.removalIdentity;

    await fixture.directory.write('home/profiles/reviewer/AGENTS.md', 'changed instructions\n');
    const instructionsChanged = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer')!.removalIdentity;
    expect(instructionsChanged.fingerprint).not.toBe(original.fingerprint);

    await fixture.service.addMembership('reviewer', {
      originId: 'default',
      skillId: 'demo-skill'
    });
    const membershipChanged = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer')!.removalIdentity;
    expect(membershipChanged.fingerprint).not.toBe(instructionsChanged.fingerprint);

    await fixture.directory.write('provider/demo-skill/provider-only.txt', 'changed\n');
    const providerChanged = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer')!.removalIdentity;
    expect(providerChanged).toEqual(membershipChanged);
  });

  it('projects the physical default catalog and canonical external targets', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.loadDashboard()).availableSkillGroups![0];
    expect(source).toMatchObject({
      id: 'default',
      label: '(default)',
      root: fixture.directory.path('home/skills'),
      canonicalRoot: await realpath(fixture.directory.path('home/skills')),
      skills: [{ id: 'demo-skill', directory: fixture.source }]
    });
  });

  it('uses the verified immutable snapshot root for a healthy zero-Skill library', async () => {
    const fixture = await createFixture();
    const sourceRoot = await fixture.directory.mkdir('empty');
    const added = await addLibrary({ bazframeHome: fixture.home }, sourceRoot);

    const dashboard = await fixture.service.loadDashboard();
    const root = dashboard.skillGroups?.find((source) => source.id === 'library:empty');

    expect(root).toMatchObject({ skills: [] });
    expect(root?.root).toBe(await realpath(fixture.directory.path(
      'home/skill-snapshots/sha256',
      added.digest,
      'artifact'
    )));
    expect(root?.root).not.toBe(sourceRoot);
  });

  it('keeps inactive-profile references visible with deterministic target availability diagnostics', async () => {
    const fixture = await createFixture();
    const sourceRoot = await fixture.directory.mkdir('unusable');
    await fixture.directory.write('unusable/demo/SKILL.md', skill('managed-demo'));
    const added = await addLibrary({ bazframeHome: fixture.home }, sourceRoot);
    const reference = (source: string) => encodeProfileCollectionReference({ schemaVersion: 1, library: source });
    await fixture.directory.write('home/profiles/reviewer/libraries/missing.json', reference('missing'));
    await fixture.directory.write('home/profiles/reviewer/libraries/malformed.json', reference('malformed'));
    await fixture.directory.write('home/profiles/reviewer/libraries/unusable.json', reference('unusable'));
    await fixture.directory.write('home/libraries/malformed.json', '{}\n');
    const snapshotSkill = fixture.directory.path(
      'home/skill-snapshots/sha256', added.digest, 'artifact', 'demo', 'SKILL.md'
    );
    if (process.platform !== 'win32') await chmod(snapshotSkill, 0o600);
    await writeFile(snapshotSkill, 'corrupt\n');
    const providerBefore = await readFile(fixture.directory.path('unusable/demo/SKILL.md'));

    const dashboard = await fixture.service.loadDashboard();
    const reviewer = dashboard.profiles.find((profile) => profile.id === 'reviewer');

    expect(reviewer?.active).toBe(false);
    expect(reviewer?.libraryReferences).toEqual([
      expect.objectContaining({
        id: 'malformed',
        availability: 'unavailable',
        diagnostic: expect.stringContaining('invalid-library')
      }),
      expect.objectContaining({
        id: 'missing',
        availability: 'unavailable',
        diagnostic: 'Global library target is unavailable.'
      }),
      expect.objectContaining({
        id: 'unusable',
        availability: 'unavailable',
        diagnostic: expect.stringContaining('broken-snapshot')
      })
    ]);
    expect(await readFile(fixture.directory.path('unusable/demo/SKILL.md'))).toEqual(providerBefore);
  });

  it('marks reference counts unknown and object health failed when the reference index is invalid', async () => {
    const fixture = await createFixture();
    const sourceRoot = await fixture.directory.mkdir('source');
    await fixture.directory.write('source/demo/SKILL.md', skill('demo'));
    await addLibrary({ bazframeHome: fixture.home }, sourceRoot);
    await fixture.directory.write('home/profiles/broken-profile', 'not a directory');

    const dashboard = await fixture.service.loadDashboard();

    expect(dashboard.collections).toEqual([expect.objectContaining({
      key: 'library:source',
      referenceCount: 'unknown',
      health: 'failed',
      diagnostics: expect.arrayContaining(['reference index unavailable'])
    })]);
    expect(dashboard.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining('Reference index unavailable')
    }));
  });

  it('loads authoritative (default) and immutable managed SKILL.md previews', async () => {
    const fixture = await createFixture();
    const defaultSkill = await fixture.service.loadSkillPreview({
      originId: 'default', skillId: 'demo-skill'
    });
    expect(defaultSkill.contents).toContain('# Skill');

    const sourceRoot = await fixture.directory.mkdir('preview');
    await fixture.directory.write('preview/demo/SKILL.md', skill('managed-demo'));
    await addLibrary({ bazframeHome: fixture.home }, sourceRoot);
    const before = await fixture.service.loadSkillPreview({
      originId: 'library:preview', skillId: 'managed-demo'
    });
    await fixture.directory.write('preview/demo/SKILL.md', skill('managed-demo').replace('# Skill', '# Changed'));
    const after = await fixture.service.loadSkillPreview({
      originId: 'library:preview', skillId: 'managed-demo'
    });

    expect(after).toEqual(before);
    await expect(fixture.service.loadSkillPreview({
      originId: 'library:preview', skillId: 'missing'
    })).rejects.toThrow(/no longer available/u);
  });

  it('browses physical directories and adds a prepared library without composing it', async () => {
    const fixture = await createFixture();
    await fixture.directory.mkdir('Downloads/skills');
    await fixture.directory.mkdir('Documents');
    await fixture.directory.write('Downloads/skills/SKILL.md', skill('downloaded'));

    const partial = await fixture.service.browseDirectories('~/Down');
    expect(partial.entries).toEqual([{
      name: 'Downloads', path: await realpath(fixture.directory.path('Downloads'))
    }]);
    const exact = await fixture.service.browseDirectories('~/Downloads/skills');
    expect(exact.selectablePath).toBe(fixture.directory.path('Downloads/skills'));
    await expect(fixture.service.browseDirectories('relative/path')).rejects.toThrow(/absolute/u);
    if (process.platform !== 'win32') {
      await symlink(fixture.directory.path('Downloads'), fixture.directory.path('Downloads-link'), 'dir');
      await expect(fixture.service.browseDirectories('~/Downloads-link/skills'))
        .rejects.toThrow(/symbolic link/u);
      await expect(fixture.service.browseDirectories('~/Downloads-link/sk'))
        .rejects.toThrow(/symbolic link/u);
      await expect(fixture.service.browseDirectories('~/Downloads-link/skills/sk'))
        .rejects.toThrow(/symbolic link/u);
    }

    const candidate = await fixture.service.inspectLibraryCandidate({ root: '~/Downloads/skills' });
    expect(candidate).toMatchObject({
      libraryId: 'skills', enteredRoot: fixture.directory.path('Downloads/skills'),
      canonicalRoot: await realpath(fixture.directory.path('Downloads/skills')),
      packageManifest: { state: 'absent' }
    });
    await fixture.service.addLibrary({ root: '~/Downloads/skills' });
    const dashboard = await fixture.service.loadDashboard();
    expect(dashboard.collections).toContainEqual(expect.objectContaining({
      key: 'library:skills', health: 'ready', referenceCount: 0
    }));
    expect(dashboard.profiles.every((profile) => profile.libraryReferences?.length === 0)).toBe(true);
    expect(await readActiveProfile(fixture.home)).toBe('focused');
  });

  it('preserves actionable nested-Skill validation diagnostics through library add', async () => {
    const fixture = await createFixture();
    await fixture.directory.write('skilllib/myskill/SKILL.md', '# Missing frontmatter\n');

    const failure = await fixture.service.addLibrary({ root: fixture.directory.path('skilllib') })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'SKILL_COLLECTION_CANDIDATE_INVALID',
      message: 'library skilllib:myskill/SKILL.md pi-loader[0]: description is required'
    });
    expect(failure).not.toHaveProperty('message', 'collection resolution failed');
  });

  it('reports package declarations and refuses to execute package builds through the TUI service', async () => {
    const fixture = await createFixture();
    await fixture.directory.write('declared/bazframe-package.json', `${JSON.stringify({
      schemaVersion: 1,
      build: [process.execPath, '-e', "require('node:fs').writeFileSync('ran', 'yes')"],
      artifactRoot: '.',
      skillsRoot: '.'
    })}\n`);
    await fixture.directory.write('declared/demo/SKILL.md', skill('declared-demo'));
    const candidate = await fixture.service.inspectLibraryCandidate({ root: fixture.directory.path('declared') });
    expect(candidate.packageManifest.state).toBe('present');
    await expect(fixture.service.addLibrary({ root: fixture.directory.path('declared') }))
      .rejects.toMatchObject({ code: 'LIBRARY_IS_PACKAGE' });
    await expect(lstat(fixture.directory.path('declared/ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fixture.service.loadDashboard()).collections).not.toContainEqual(
      expect.objectContaining({ key: 'library:declared' })
    );
  });

  it('edits an inactive profile by ID using a freshly derived target without changing selection', async () => {
    const fixture = await createFixture();
    const editorChildRunner = vi.fn(async () => ({ exitCode: 0, signal: null }));
    const environment = { ...fixture.options.environment, EDITOR: '/editor executable' };
    const service = createBazframeTuiService({
      ...fixture.options,
      environment,
      editorChildRunner
    });
    const dashboard = await service.loadDashboard();
    const disclosed = dashboard.profiles.find((profile) => profile.id === 'reviewer')!;
    disclosed.instructionsPath = '/untrusted/snapshot/AGENTS.md';

    await expect(service.editProfileInstructions('reviewer')).resolves.toEqual({
      exitCode: 0, signal: null
    });
    expect(editorChildRunner).toHaveBeenCalledWith(
      '/editor executable',
      [fixture.directory.path('home/profiles/reviewer/AGENTS.md')],
      {
        cwd: fixture.directory.path('home/profiles/reviewer'),
        environment,
        ignoreParentSignals: ['SIGINT']
      }
    );
    expect(await readActiveProfile(fixture.home)).toBe('focused');
  });

  it('edits only an authoritative live default skill target and rejects managed preview references', async () => {
    const fixture = await createFixture();
    const editorChildRunner = vi.fn(async () => ({ exitCode: 0, signal: null }));
    const environment = { ...fixture.options.environment, EDITOR: '/editor executable' };
    const service = createBazframeTuiService({
      ...fixture.options,
      environment,
      editorChildRunner
    });
    const disclosed = await service.loadSkillPreview({
      originId: 'default', skillId: 'demo-skill'
    });
    disclosed.path = '/untrusted/preview/SKILL.md';

    await expect(service.editSkillDefinition({
      originId: 'default', skillId: 'demo-skill'
    })).resolves.toEqual({ exitCode: 0, signal: null });
    expect(editorChildRunner).toHaveBeenCalledWith(
      '/editor executable',
      [join(fixture.source, 'SKILL.md')],
      {
        cwd: fixture.source,
        environment,
        ignoreParentSignals: ['SIGINT']
      }
    );

    await expect(service.editSkillDefinition({
      originId: 'library:bundle', skillId: 'demo-skill'
    })).rejects.toMatchObject({ code: 'SKILL_EDITOR_SOURCE_READ_ONLY' });
    expect(editorChildRunner).toHaveBeenCalledTimes(1);
  });

  it('persists favorites across service instances and orders current, favorites, then remaining profiles', async () => {
    const fixture = await createFixture();
    await addProfile(fixture.home, 'alpha');
    await addProfile(fixture.home, 'beta');
    await addProfile(fixture.home, 'zeta');

    await fixture.service.toggleProfileFavorite('reviewer');
    await fixture.service.toggleProfileFavorite('beta');
    const secondService = createBazframeTuiService(fixture.options);
    let dashboard = await secondService.loadDashboard();
    expect(dashboard.profiles.map((profile) => ({
      id: profile.id,
      active: profile.active,
      favorite: profile.favorite
    }))).toEqual([
      { id: 'focused', active: true, favorite: false },
      { id: 'beta', active: false, favorite: true },
      { id: 'reviewer', active: false, favorite: true },
      { id: 'alpha', active: false, favorite: false },
      { id: 'zeta', active: false, favorite: false }
    ]);

    await secondService.toggleProfileFavorite('focused');
    dashboard = await createBazframeTuiService(fixture.options).loadDashboard();
    expect(dashboard.profiles[0]).toMatchObject({
      id: 'focused', active: true, favorite: true
    });
    expect((await readProfileFavorites(fixture.home)).favorites)
      .toEqual(['beta', 'focused', 'reviewer']);
  });

  it('diagnoses malformed favorite state while projecting profiles with no favorites', async () => {
    const fixture = await createFixture();
    const malformed = '{"schemaVersion":1,"favorites":["reviewer"],"extra":true}\n';
    await writeFile(profileFavoritesPath(fixture.home), malformed);

    const dashboard = await fixture.service.loadDashboard();
    expect(dashboard.profiles.map((profile) => profile.id)).toEqual(['focused', 'reviewer']);
    expect(dashboard.profiles.every((profile) => !profile.favorite)).toBe(true);
    expect(dashboard.diagnostics).toContainEqual(expect.objectContaining({
      id: 'profile-favorites',
      severity: 'error',
      message: expect.stringContaining('exactly the schema-v1 fields')
    }));
    await expect(fixture.service.toggleProfileFavorite('reviewer')).rejects.toMatchObject({
      code: 'PROFILE_FAVORITES_INVALID'
    });
    expect(await readFile(profileFavoritesPath(fixture.home), 'utf8')).toBe(malformed);
  });

  it('retains and reports externally stale favorite IDs without projecting them', async () => {
    const fixture = await createFixture();
    await writeFile(
      profileFavoritesPath(fixture.home),
      encodeProfileFavorites(['ghost', 'reviewer'])
    );

    const dashboard = await fixture.service.loadDashboard();
    expect(dashboard.profiles.find((profile) => profile.id === 'reviewer')?.favorite).toBe(true);
    expect(dashboard.profiles.some((profile) => profile.id === 'ghost')).toBe(false);
    expect(dashboard.diagnostics).toContainEqual(expect.objectContaining({
      id: 'profile-favorite-stale-ghost',
      severity: 'warning',
      message: expect.stringContaining('retained but not displayed')
    }));
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual(['ghost', 'reviewer']);
  });

  it('loads an empty dashboard without creating Bazframe state', async () => {
    const directory = await temporary();
    const home = directory.path('missing-home');
    const service = createBazframeTuiService({
      bazframeHome: home,
      bazframeVersion: '0.1.0-test',
      cwd: directory.root,
      environment: { PI_CODING_AGENT_DIR: directory.path('pi-agent') },
      userHome: directory.root
    });

    await expect(service.loadDashboard()).resolves.toMatchObject({
      profiles: [],
      availableSkillGroups: [{ id: 'default', skills: [] }],
      status: { state: 'available' }
    });
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps profiles and setup status available when the default catalog root is malformed', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await symlink(fixture.source, fixture.directory.path('home/profiles/reviewer/skills/demo-skill'));
    await rm(fixture.directory.path('home/skills'), { recursive: true });
    await symlink(fixture.directory.path('provider'), fixture.directory.path('home/skills'));

    const dashboard = await fixture.service.loadDashboard();

    expect(dashboard.profiles.map((profile) => profile.id)).toEqual(['focused', 'reviewer']);
    expect(dashboard.availableSkillGroups).toEqual([]);
    expect(dashboard.status).toMatchObject({ state: 'available' });
    expect(dashboard.diagnostics).toContainEqual(expect.objectContaining({
      id: 'default-skill-group',
      message: expect.stringContaining('physical directory')
    }));
    expect(dashboard.profiles.find((profile) => profile.id === 'reviewer')?.memberships)
      .toMatchObject([{ skillId: 'demo-skill', kind: 'unmanaged', manageable: false }]);
  });

  it('keeps profile and skill reads available when setup inspection fails', async () => {
    const fixture = await createFixture();
    await fixture.directory.write('home/global.json', '{bad json\n');

    const dashboard = await fixture.service.loadDashboard();

    expect(dashboard.profiles.map((profile) => profile.id)).toEqual(['focused', 'reviewer']);
    expect(dashboard.availableSkillGroups![0]?.skills.map((entry) => entry.id)).toEqual(['demo-skill']);
    expect(dashboard.status).toMatchObject({
      state: 'unavailable',
      diagnostic: { id: 'setup-status', severity: 'error' }
    });
    expect(dashboard.diagnostics).toContainEqual(expect.objectContaining({
      id: 'setup-status',
      message: expect.stringContaining('Invalid JSON')
    }));
  });
});

async function createFixture(): Promise<{
  directory: TempDirectory;
  home: string;
  source: string;
  options: BazframeTuiServiceOptions;
  service: ReturnType<typeof createBazframeTuiService>;
}> {
  const directory = await temporary();
  const home = directory.path('home');
  let source = directory.path('provider/demo-skill');
  await directory.write('home/profiles/focused/AGENTS.md', 'focused\n');
  await directory.mkdir('home/profiles/focused/skills');
  await directory.write('home/profiles/reviewer/AGENTS.md', 'reviewer\n');
  await directory.mkdir('home/profiles/reviewer/skills');
  await directory.write('provider/demo-skill/SKILL.md', skill('demo-skill'));
  source = await realpath(source);
  await directory.mkdir('home/skills');
  await symlink(source, directory.path('home/skills/demo-skill'), 'dir');
  await writeActiveProfile(home, 'focused');
  const options = {
    bazframeHome: home,
    bazframeVersion: '0.1.0-test',
    cwd: directory.root,
    environment: {
      PI_CODING_AGENT_DIR: directory.path('pi-agent')
    },
    userHome: directory.root
  };
  return {
    directory,
    home,
    source,
    options,
    service: createBazframeTuiService(options)
  };
}

async function temporary(): Promise<TempDirectory> {
  const directory = await createTempDirectory();
  temporaryDirectories.push(directory);
  return directory;
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Test skill.\n---\n\n# Skill\n`;
}
