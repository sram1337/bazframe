import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installPiAdapter } from '../../../src/adapters/pi/installer.js';
import { disableGlobally } from '../../../src/policy/global-policy.js';
import { writeActiveProfile } from '../../../src/profiles/profile-store.js';
import { findGitRoot } from '../../../src/project/git-root.js';
import { repositoryRegistrationPath } from '../../../src/project/registration.js';
import { disableRepository, enableRepository } from '../../../src/project/registration-store.js';
import {
  buildStatus,
  formatStatus,
  inspectStatus,
  statusExitStatus,
  type StatusInspection,
  type StatusOptions
} from '../../../src/status/status.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

async function temporary(): Promise<TempDirectory> {
  const directory = await createTempDirectory();
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('Bazframe status', () => {
  it('reports healthy file-free global and project defaults', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    await readyProfile(directory, options);
    await installPiAdapter(options);

    const inspection = await inspectStatus(options);
    const status = await buildStatus(options);

    expect(inspection).toMatchObject({
      adapter: { state: 'current', installedBazframeVersion: '0.1.0-test' },
      globalPolicy: { policy: 'enabled' },
      repository: { kind: 'git-worktree', projectState: 'inherit' },
      effectiveBehavior: { kind: 'git-worktree', enabled: true, reason: 'global-enabled' },
      profile: { state: 'ready', id: 'focused', skillCount: 1 },
      cachedCollisionAliasCount: 0,
      correctiveActions: []
    });
    expect(status).toEqual({
      exitStatus: 0,
      text: [
        'Bazframe status',
        `Bazframe home: ${options.bazframeHome}`,
        `Pi agent directory: ${directory.path('pi-agent')}`,
        'Pi adapter: current',
        'Pi adapter version: 0.1.0-test',
        `Pi extension: ${directory.path('pi-agent/extensions/bazframe.ts')}`,
        'Global policy: enabled',
        'Global state: none (enabled default)',
        `Repository: ${options.cwd}`,
        'Project state: none (inherits global policy)',
        'Effective behavior: enabled (global-enabled)',
        'Active profile: focused',
        `Profile instructions: ${directory.path('bazframe-home/profiles/focused/AGENTS.md')}`,
        'Profile skills: 1',
        'Cached collision aliases: 0',
        'Launch:',
        '  pi       # native Pi context + active profile',
        '  pi -nc   # global Pi context + active profile',
        'Corrective actions:',
        '  (none)',
        ''
      ].join('\n')
    });
  });

  it('treats project disable under global enable as healthy without adapter or profile', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    await disableRepository(
      options.bazframeHome,
      await findGitRoot(options.cwd, options.environment)
    );

    const status = await buildStatus(options);

    expect(status).toEqual({
      exitStatus: 0,
      text: [
        'Bazframe status',
        `Bazframe home: ${options.bazframeHome}`,
        `Pi agent directory: ${directory.path('pi-agent')}`,
        'Pi adapter: missing',
        'Pi adapter version: (none)',
        `Pi extension: ${directory.path('pi-agent/extensions/bazframe.ts')}`,
        'Global policy: enabled',
        'Global state: none (enabled default)',
        `Repository: ${options.cwd}`,
        'Project state: disabled override',
        'Effective behavior: disabled (project-disabled-override; native Pi behavior)',
        'Active profile: (not used: disabled: project-disabled-override)',
        'Profile instructions: (not used: disabled: project-disabled-override)',
        'Profile skills: (not used: disabled: project-disabled-override)',
        'Cached collision aliases: 0',
        'Launch:',
        '  pi       # native Pi behavior (Bazframe disabled by effective policy)',
        'Corrective actions:',
        '  (none)',
        ''
      ].join('\n')
    });
  });

  it('treats inherited global disable as healthy without adapter or profile', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    await disableGlobally(options.bazframeHome);

    const status = await buildStatus(options);

    expect(status.exitStatus, status.text).toBe(0);
    expect(status.text).toContain('Global policy: disabled');
    expect(status.text).toContain('Project state: none (inherits global policy)');
    expect(status.text).toContain('Effective behavior: disabled (global-disabled');
    expect(status.text).toContain('Corrective actions:\n  (none)');
  });

  it('requires adapter and profile for project enable under global disable', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    const repository = await findGitRoot(options.cwd, options.environment);
    await disableGlobally(options.bazframeHome);
    await enableRepository(options.bazframeHome, repository);

    const status = await buildStatus(options);

    expect(status.exitStatus).toBe(3);
    expect(status.text).toContain('Project state: enabled override');
    expect(status.text).toContain('Effective behavior: enabled (project-enabled-override)');
    expect(status.text).toContain('bazframe adapter install pi');
    expect(status.text).toContain('bazframe profile add <profile>');
  });

  it('applies the file-free global enabled policy outside Git', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    options.cwd = await directory.mkdir('outside-git');
    await readyProfile(directory, options);
    await installPiAdapter(options);

    const status = await buildStatus(options);

    expect(status).toEqual({
      exitStatus: 0,
      text: [
        'Bazframe status',
        `Bazframe home: ${options.bazframeHome}`,
        `Pi agent directory: ${directory.path('pi-agent')}`,
        'Pi adapter: current',
        'Pi adapter version: 0.1.0-test',
        `Pi extension: ${directory.path('pi-agent/extensions/bazframe.ts')}`,
        'Global policy: enabled',
        'Global state: none (enabled default)',
        'Repository: (outside a Git worktree)',
        'Project state: not applicable',
        'Effective behavior: enabled (global-enabled)',
        'Active profile: focused',
        `Profile instructions: ${directory.path('bazframe-home/profiles/focused/AGENTS.md')}`,
        'Profile skills: 1',
        'Cached collision aliases: 0',
        'Launch:',
        '  pi       # native Pi context + active profile',
        '  pi -nc   # global Pi context + active profile',
        'Corrective actions:',
        '  (none)',
        ''
      ].join('\n')
    });
  });

  it('reports incomplete globally enabled setup outside Git', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    options.cwd = await directory.mkdir('outside-git');

    const status = await buildStatus(options);

    expect(status.exitStatus).toBe(3);
    expect(status.text).toContain('Repository: (outside a Git worktree)');
    expect(status.text).toContain('Project state: not applicable');
    expect(status.text).toContain('Effective behavior: enabled (global-enabled)');
    expect(status.text).toContain('bazframe adapter install pi');
    expect(status.text).toContain('bazframe profile add <profile>');
  });

  it('keeps globally disabled non-Git directories native without requiring setup', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    options.cwd = await directory.mkdir('outside-git');
    await disableGlobally(options.bazframeHome);

    const status = await buildStatus(options);

    expect(status.exitStatus).toBe(0);
    expect(status.text).toContain('Repository: (outside a Git worktree)');
    expect(status.text).toContain('Project state: not applicable');
    expect(status.text).toContain('Effective behavior: disabled (global-disabled; native Pi behavior)');
    expect(status.text).toContain('Active profile: (not used: disabled: global-disabled)');
    expect(status.text).toContain('Corrective actions:\n  (none)');
  });

  it('fails visibly on malformed current project or global state', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    const repository = await findGitRoot(options.cwd, options.environment);
    const statePath = repositoryRegistrationPath(options.bazframeHome, repository);
    await directory.write(relativeToRoot(directory, statePath), '{bad json\n');
    await expect(buildStatus(options)).rejects.toThrow(/Invalid JSON/u);

    await directory.cleanup();
    temporaryDirectories.pop();
    const second = await temporary();
    const secondOptions = await statusOptions(second);
    secondOptions.cwd = await second.mkdir('outside-git');
    await second.write('bazframe-home/global.json', '{bad json\n');
    await expect(buildStatus(secondOptions)).rejects.toThrow(/Invalid JSON/u);
  });

  it('reports drift when effective behavior is enabled', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    await readyProfile(directory, options);
    const installed = await installPiAdapter(options);
    await directory.write(relativeToRoot(directory, installed.targetPath), 'changed\n');

    const status = await buildStatus(options);

    expect(status).toEqual({
      exitStatus: 3,
      text: [
        'Bazframe status',
        `Bazframe home: ${options.bazframeHome}`,
        `Pi agent directory: ${directory.path('pi-agent')}`,
        'Pi adapter: drifted',
        'Pi adapter version: 0.1.0-test',
        `Pi extension: ${directory.path('pi-agent/extensions/bazframe.ts')}`,
        'Global policy: enabled',
        'Global state: none (enabled default)',
        `Repository: ${options.cwd}`,
        'Project state: none (inherits global policy)',
        'Effective behavior: enabled (global-enabled)',
        'Active profile: focused',
        `Profile instructions: ${directory.path('bazframe-home/profiles/focused/AGENTS.md')}`,
        'Profile skills: 1',
        'Cached collision aliases: 0',
        'Launch:',
        '  Complete the corrective actions below.',
        'Corrective actions:',
        '  - Review the changed artifact, then restore it with `bazframe adapter install pi --force`.',
        ''
      ].join('\n')
    });
  });

  it('formats the structured model with the legacy CLI bytes', () => {
    const inspection: StatusInspection = {
      bazframeHome: '/home/.bazframe',
      piAgentDirectory: '/home/.pi/agent',
      adapter: {
        state: 'missing',
        targetPath: '/home/.pi/agent/extensions/bazframe.ts'
      },
      globalPolicy: { policy: 'enabled' },
      repository: {
        kind: 'git-worktree',
        root: '/work/repository',
        projectState: 'inherit'
      },
      effectiveBehavior: {
        kind: 'git-worktree',
        enabled: true,
        reason: 'global-enabled'
      },
      profile: { state: 'unselected' },
      cachedCollisionAliasCount: 2,
      correctiveActions: [
        {
          id: 'adapter',
          message: 'Install or update the adapter with `bazframe adapter install pi`.'
        },
        {
          id: 'active-profile',
          message: 'Create a profile with `bazframe profile add <profile>` if needed, then select it with `bazframe profile use <profile>`.'
        }
      ]
    };

    expect(formatStatus(inspection)).toBe([
      'Bazframe status',
      'Bazframe home: /home/.bazframe',
      'Pi agent directory: /home/.pi/agent',
      'Pi adapter: missing',
      'Pi adapter version: (none)',
      'Pi extension: /home/.pi/agent/extensions/bazframe.ts',
      'Global policy: enabled',
      'Global state: none (enabled default)',
      'Repository: /work/repository',
      'Project state: none (inherits global policy)',
      'Effective behavior: enabled (global-enabled)',
      'Active profile: (none)',
      'Profile instructions: (none)',
      'Profile skills: 0',
      'Cached collision aliases: 2',
      'Launch:',
      '  Complete the corrective actions below.',
      'Corrective actions:',
      '  - Install or update the adapter with `bazframe adapter install pi`.',
      '  - Create a profile with `bazframe profile add <profile>` if needed, then select it with `bazframe profile use <profile>`.',
      ''
    ].join('\n'));
    expect(statusExitStatus(inspection)).toBe(3);
  });
});

async function readyProfile(directory: TempDirectory, options: StatusOptions): Promise<void> {
  await directory.write('bazframe-home/profiles/focused/AGENTS.md', 'profile\n');
  await directory.write('bazframe-home/profiles/focused/skills/review/SKILL.md', 'skill\n');
  await writeActiveProfile(options.bazframeHome, 'focused');
}

async function statusOptions(directory: TempDirectory): Promise<StatusOptions> {
  const repository = await directory.initGit('repository');
  const artifact = await directory.write('artifact.ts', 'adapter artifact\n');
  const environment = { PI_CODING_AGENT_DIR: directory.path('pi-agent') };
  return {
    bazframeHome: directory.path('bazframe-home'),
    bazframeVersion: '0.1.0-test',
    environment,
    cwd: await findGitRoot(repository, environment),
    artifactUrl: pathToFileURL(artifact)
  };
}

function relativeToRoot(directory: TempDirectory, path: string): string {
  const prefix = `${directory.root}/`;
  if (!path.startsWith(prefix)) throw new Error(`Path is outside fixture: ${path}`);
  return path.slice(prefix.length);
}
