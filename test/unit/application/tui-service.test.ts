import { lstat, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(first.sources).toMatchObject([{
      id: 'skillbook',
      provider: 'skillbook',
      artifactWritesSupported: false,
      skills: [{ id: 'demo-skill', sourceId: 'skillbook' }]
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
      sourceId: 'skillbook',
      skillId: 'demo-skill'
    });
    expect(await readActiveProfile(fixture.home)).toBe('focused');
    expect(await readlink(fixture.directory.path(
      'home/profiles/reviewer/skills/demo-skill'
    ))).toBe(fixture.source);
    expect(await fixture.directory.readText(
      'skillbook/skills/demo-skill/SKILL.md'
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
      'skillbook/skills/demo-skill/SKILL.md'
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
      membershipId: 'focused:skillbook:demo-skill',
      sourceId: 'skillbook',
      skillId: 'demo-skill'
    })).rejects.toThrow(/Stale profile skill membership reference/u);
    expect((await lstat(fixture.directory.path('home/profiles/reviewer'))).isDirectory())
      .toBe(true);
  });

  it('binds recursive authorization to the disclosed profile instance and metadata', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await fixture.service.addMembership('reviewer', {
      sourceId: 'skillbook',
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
      sourceId: 'skillbook',
      skillId: 'demo-skill'
    });
    const membershipChanged = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer')!.removalIdentity;
    expect(membershipChanged.fingerprint).not.toBe(instructionsChanged.fingerprint);

    await fixture.directory.write('skillbook/skills/demo-skill/provider-only.txt', 'changed\n');
    const providerChanged = (await fixture.service.loadDashboard()).profiles
      .find((profile) => profile.id === 'reviewer')!.removalIdentity;
    expect(providerChanged).toEqual(membershipChanged);
  });

  it('projects display and canonical identity for a symlinked provider root', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    await directory.write('provider/skills/demo-skill/SKILL.md', skill('demo-skill'));
    await symlink(directory.path('provider'), directory.path('library-link'), 'dir');
    const service = createBazframeTuiService({
      bazframeHome: directory.path('missing-home'),
      bazframeVersion: '0.1.0-test',
      cwd: directory.root,
      environment: {
        PI_CODING_AGENT_DIR: directory.path('pi-agent'),
        SKILLBOOK_LIBRARY: directory.path('library-link')
      },
      userHome: directory.root
    });

    const source = (await service.loadDashboard()).sources[0];
    expect(source).toMatchObject({
      root: directory.path('library-link/skills'),
      canonicalRoot: await realpath(directory.path('provider/skills'))
    });
  });

  it('loads an empty dashboard without creating Bazframe state', async () => {
    const directory = await temporary();
    const home = directory.path('missing-home');
    const service = createBazframeTuiService({
      bazframeHome: home,
      bazframeVersion: '0.1.0-test',
      cwd: directory.root,
      environment: {
        PI_CODING_AGENT_DIR: directory.path('pi-agent'),
        SKILLBOOK_LIBRARY: directory.path('missing-library')
      },
      userHome: directory.root
    });

    await expect(service.loadDashboard()).resolves.toMatchObject({
      profiles: [],
      sources: [{ id: 'skillbook', skills: [] }],
      status: { state: 'available' }
    });
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps profiles and setup status available when source configuration is malformed', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await symlink(fixture.source, fixture.directory.path(
      'home/profiles/reviewer/skills/demo-skill'
    ));
    const service = createBazframeTuiService({
      ...fixture.options,
      environment: {
        ...fixture.options.environment,
        SKILLBOOK_LIBRARY: 'relative-library'
      }
    });

    const dashboard = await service.loadDashboard();

    expect(dashboard.profiles.map((profile) => profile.id)).toEqual(['focused', 'reviewer']);
    expect(dashboard.sources).toEqual([]);
    expect(dashboard.status).toMatchObject({
      state: 'available',
      value: {
        adapter: { state: 'missing' },
        repository: { kind: 'outside-git' },
        effectiveBehavior: { kind: 'outside-git', enabled: true, reason: 'global-enabled' },
        profile: { state: 'ready', id: 'focused' }
      }
    });
    expect(dashboard.diagnostics).toContainEqual(expect.objectContaining({
      id: 'skillbook-source',
      message: expect.stringContaining('SKILLBOOK_LIBRARY must be an absolute path')
    }));
    expect(dashboard.profiles.find((profile) => profile.id === 'reviewer')?.memberships)
      .toMatchObject([{
        skillId: 'demo-skill',
        target: fixture.source,
        kind: 'unmanaged',
        manageable: false,
        diagnostic: expect.stringContaining('membership authority cannot be verified')
      }]);
  });

  it('keeps profile and skill reads available when setup inspection fails', async () => {
    const fixture = await createFixture();
    await fixture.directory.write('home/global.json', '{bad json\n');

    const dashboard = await fixture.service.loadDashboard();

    expect(dashboard.profiles.map((profile) => profile.id)).toEqual(['focused', 'reviewer']);
    expect(dashboard.sources[0]?.skills.map((entry) => entry.id)).toEqual(['demo-skill']);
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
  const library = directory.path('skillbook');
  const source = directory.path('skillbook/skills/demo-skill');
  await directory.write('home/profiles/focused/AGENTS.md', 'focused\n');
  await directory.mkdir('home/profiles/focused/skills');
  await directory.write('home/profiles/reviewer/AGENTS.md', 'reviewer\n');
  await directory.mkdir('home/profiles/reviewer/skills');
  await directory.write('skillbook/skills/demo-skill/SKILL.md', skill('demo-skill'));
  await writeActiveProfile(home, 'focused');
  const options = {
    bazframeHome: home,
    bazframeVersion: '0.1.0-test',
    cwd: directory.root,
    environment: {
      PI_CODING_AGENT_DIR: directory.path('pi-agent'),
      SKILLBOOK_LIBRARY: library
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
