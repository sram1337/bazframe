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
import { readActiveProfile, writeActiveProfile } from '../../../src/profiles/profile-store.js';
import { encodeProfileSourceReference } from '../../../src/profiles/profile-source-reference.js';
import { addSource } from '../../../src/sources/source-lifecycle.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('Bazframe TUI service', () => {
  it('projects profiles, source skills, managed memberships, and diagnostics without CLI text', async () => {
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
    expect(first.availableSkillSources).toMatchObject([{
      id: 'default',
      artifactWritesSupported: false,
      skills: [{ id: 'demo-skill', sourceId: 'default' }]
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
      sourceId: 'default',
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
      sourceId: membership!.sourceId!,
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

  it('requires exact recursive-removal authorization and a recognized source', async () => {
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
      sourceId: 'other',
      skillId: 'demo-skill'
    })).rejects.toThrow(/Unknown skill source/u);
    await expect(fixture.service.removeMembership('reviewer', {
      membershipId: 'focused:default:demo-skill',
      sourceId: 'default',
      skillId: 'demo-skill'
    })).rejects.toThrow(/Stale profile skill membership reference/u);
    expect((await lstat(fixture.directory.path('home/profiles/reviewer'))).isDirectory())
      .toBe(true);
  });

  it('binds recursive authorization to the disclosed profile instance and metadata', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await fixture.service.addMembership('reviewer', {
      sourceId: 'default',
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
      sourceId: 'default',
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
    const source = (await fixture.service.loadDashboard()).availableSkillSources![0];
    expect(source).toMatchObject({
      id: 'default',
      label: '(default)',
      root: fixture.directory.path('home/skills'),
      canonicalRoot: await realpath(fixture.directory.path('home/skills')),
      skills: [{ id: 'demo-skill', directory: fixture.source }]
    });
  });

  it('uses the verified immutable snapshot root for a healthy zero-child managed source', async () => {
    const fixture = await createFixture();
    const sourceRoot = await fixture.directory.mkdir('empty');
    const added = await addSource({ bazframeHome: fixture.home }, sourceRoot);

    const dashboard = await fixture.service.loadDashboard();
    const root = dashboard.skillRoots?.find((source) => source.id === 'managed:empty');

    expect(root).toMatchObject({ skills: [] });
    expect(root?.root).toBe(await realpath(fixture.directory.path(
      'home/source-snapshots/sha256',
      added.digest,
      'artifact'
    )));
    expect(root?.root).not.toBe(sourceRoot);
  });

  it('keeps inactive-profile references visible with deterministic target availability diagnostics', async () => {
    const fixture = await createFixture();
    const sourceRoot = await fixture.directory.mkdir('unusable');
    await fixture.directory.write('unusable/demo/SKILL.md', skill('managed-demo'));
    const added = await addSource({ bazframeHome: fixture.home }, sourceRoot);
    const reference = (source: string) => encodeProfileSourceReference({ schemaVersion: 1, source });
    await fixture.directory.write('home/profiles/reviewer/sources/missing.json', reference('missing'));
    await fixture.directory.write('home/profiles/reviewer/sources/malformed.json', reference('malformed'));
    await fixture.directory.write('home/profiles/reviewer/sources/unusable.json', reference('unusable'));
    await fixture.directory.write('home/sources/malformed.json', '{}\n');
    const snapshotSkill = fixture.directory.path(
      'home/source-snapshots/sha256', added.digest, 'artifact', 'demo', 'SKILL.md'
    );
    if (process.platform !== 'win32') await chmod(snapshotSkill, 0o600);
    await writeFile(snapshotSkill, 'corrupt\n');
    const providerBefore = await readFile(fixture.directory.path('unusable/demo/SKILL.md'));

    const dashboard = await fixture.service.loadDashboard();
    const reviewer = dashboard.profiles.find((profile) => profile.id === 'reviewer');

    expect(reviewer?.active).toBe(false);
    expect(reviewer?.sourceReferences).toEqual([
      expect.objectContaining({
        id: 'malformed',
        availability: 'unavailable',
        diagnostic: expect.stringContaining('invalid-source')
      }),
      expect.objectContaining({
        id: 'missing',
        availability: 'unavailable',
        diagnostic: 'Global source target is unavailable.'
      }),
      expect.objectContaining({
        id: 'unusable',
        availability: 'unavailable',
        diagnostic: expect.stringContaining('broken-snapshot')
      })
    ]);
    expect(await readFile(fixture.directory.path('unusable/demo/SKILL.md'))).toEqual(providerBefore);
  });

  it('marks reference counts unknown and source health failed when the reference index is invalid', async () => {
    const fixture = await createFixture();
    const sourceRoot = await fixture.directory.mkdir('source');
    await fixture.directory.write('source/demo/SKILL.md', skill('demo'));
    await addSource({ bazframeHome: fixture.home }, sourceRoot);
    await fixture.directory.write('home/profiles/broken-profile', 'not a directory');

    const dashboard = await fixture.service.loadDashboard();

    expect(dashboard.managedSources).toEqual([expect.objectContaining({
      id: 'managed:source',
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
      sourceId: 'default', skillId: 'demo-skill'
    });
    expect(defaultSkill.contents).toContain('# Skill');

    const sourceRoot = await fixture.directory.mkdir('preview');
    await fixture.directory.write('preview/demo/SKILL.md', skill('managed-demo'));
    await addSource({ bazframeHome: fixture.home }, sourceRoot);
    const before = await fixture.service.loadSkillPreview({
      sourceId: 'managed:preview', skillId: 'managed-demo'
    });
    await fixture.directory.write('preview/demo/SKILL.md', skill('managed-demo').replace('# Skill', '# Changed'));
    const after = await fixture.service.loadSkillPreview({
      sourceId: 'managed:preview', skillId: 'managed-demo'
    });

    expect(after).toEqual(before);
    await expect(fixture.service.loadSkillPreview({
      sourceId: 'managed:preview', skillId: 'missing'
    })).rejects.toThrow(/no longer available/u);
  });

  it('browses physical directories and adds a manifest-free source without composing it', async () => {
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

    const candidate = await fixture.service.inspectSourceCandidate({ root: '~/Downloads/skills' });
    expect(candidate).toMatchObject({
      sourceId: 'skills',
      enteredRoot: fixture.directory.path('Downloads/skills'),
      canonicalRoot: await realpath(fixture.directory.path('Downloads/skills')),
      manifest: { state: 'absent' }
    });
    await fixture.service.addSource({ root: '~/Downloads/skills' });
    const dashboard = await fixture.service.loadDashboard();
    expect(dashboard.managedSources).toContainEqual(expect.objectContaining({
      id: 'managed:skills', health: 'ready', referenceCount: 0
    }));
    expect(dashboard.profiles.every((profile) => profile.sourceReferences?.length === 0)).toBe(true);
    expect(await readActiveProfile(fixture.home)).toBe('focused');
  });

  it('reports declared source builds and refuses to execute them through the TUI service', async () => {
    const fixture = await createFixture();
    await fixture.directory.write('declared/bazframe-source.json', `${JSON.stringify({
      schemaVersion: 1,
      build: [process.execPath, '-e', "require('node:fs').writeFileSync('ran', 'yes')"],
      artifactRoot: '.',
      sourceUnitRoot: '.'
    })}\n`);
    await fixture.directory.write('declared/demo/SKILL.md', skill('declared-demo'));
    const candidate = await fixture.service.inspectSourceCandidate({ root: fixture.directory.path('declared') });
    expect(candidate.manifest.state).toBe('present');
    await expect(fixture.service.addSource({ root: fixture.directory.path('declared') }))
      .rejects.toMatchObject({ code: 'SOURCE_BUILD_REQUIRES_CLI' });
    await expect(lstat(fixture.directory.path('declared/ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fixture.service.loadDashboard()).managedSources).not.toContainEqual(
      expect.objectContaining({ id: 'managed:declared' })
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
      sourceId: 'default', skillId: 'demo-skill'
    });
    disclosed.path = '/untrusted/preview/SKILL.md';

    await expect(service.editSkillDefinition({
      sourceId: 'default', skillId: 'demo-skill'
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
      sourceId: 'managed:bundle', skillId: 'demo-skill'
    })).rejects.toMatchObject({ code: 'SKILL_EDITOR_SOURCE_READ_ONLY' });
    expect(editorChildRunner).toHaveBeenCalledTimes(1);
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
      availableSkillSources: [{ id: 'default', skills: [] }],
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
    expect(dashboard.availableSkillSources).toEqual([]);
    expect(dashboard.status).toMatchObject({ state: 'available' });
    expect(dashboard.diagnostics).toContainEqual(expect.objectContaining({
      id: 'default-skill-source',
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
    expect(dashboard.availableSkillSources![0]?.skills.map((entry) => entry.id)).toEqual(['demo-skill']);
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
