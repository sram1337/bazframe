import { realpath } from 'node:fs/promises';
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
import { encodeProfileCollectionReference } from '../../../src/profiles/profile-skill-collection-reference.js';
import { encodeLibrary, encodePackage } from '../../../src/skill-collections/skill-collection-store.js';
import { publishSkillSnapshot } from '../../../src/skill-collections/skill-snapshot.js';
import { captureProviderManifest } from '../../helpers/provider-manifest.js';
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
        'Flat direct skills: 1',
        'Profile library/package references: 0',
        'Derived effective skills: 0',
        '  (none)',
        'Library/package failures:',
        '  (none)',
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
        'Flat direct skills: (not used: disabled: project-disabled-override)',
        'Profile library/package references: (not used: disabled: project-disabled-override)',
        'Derived effective skills: (not used: disabled: project-disabled-override)',
        '  (none)',
        'Library/package failures:',
        '  (none)',
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
        'Flat direct skills: 1',
        'Profile library/package references: 0',
        'Derived effective skills: 0',
        '  (none)',
        'Library/package failures:',
        '  (none)',
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

  it('uses Pi directory fallback for direct duplicate analysis and withholds the complete library', async () => {
    const directory = await temporary(); const options = await statusOptions(directory); await readyProfile(directory, options);
    await directory.write('bazframe-home/profiles/focused/skills/review/SKILL.md', '---\ndescription: fallback flat name\n---\n');
    const provider = await realpath(await directory.mkdir('library'));
    await directory.write('library/derived/SKILL.md', '---\nname: review\ndescription: derived\n---\n');
    const snapshot = await publishSkillSnapshot(options.bazframeHome, provider);
    const recordPath = await directory.write('bazframe-home/libraries/library.json', encodeLibrary({ schemaVersion: 1, library: 'library', root: provider, digest: snapshot.digest }));
    await directory.write('bazframe-home/profiles/focused/libraries/library.json', encodeProfileCollectionReference({ schemaVersion: 1, library: 'library' }));
    const providerBefore = await captureProviderManifest([provider]); const recordBefore = await captureProviderManifest([recordPath]);
    const inspection = await inspectStatus(options);
    expect(await captureProviderManifest([provider])).toEqual(providerBefore); expect(await captureProviderManifest([recordPath])).toEqual(recordBefore);
    expect(inspection.profile).toMatchObject({ state: 'ready', flatSkillCount: 1, collectionReferenceCount: 1, derivedSkillCount: 0, collectionDiagnostics: [{ category: 'duplicate-name', collectionKind: 'library', collectionId: 'library', path: 'derived/SKILL.md', name: 'review' }] });
  });

  it('reports a healthy same-ID zero-Skill library and package independently', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    await readyProfile(directory, options);
    await installPiAdapter(options);
    const libraryRoot = await realpath(await directory.mkdir('library-provider/toolkit'));
    const packageRoot = await realpath(await directory.mkdir('package-provider/toolkit'));
    const librarySnapshot = await publishSkillSnapshot(options.bazframeHome, libraryRoot);
    const packageSnapshot = await publishSkillSnapshot(options.bazframeHome, packageRoot);
    await directory.write('bazframe-home/libraries/toolkit.json', encodeLibrary({
      schemaVersion: 1, library: 'toolkit', root: libraryRoot, digest: librarySnapshot.digest
    }));
    await directory.write('bazframe-home/packages/toolkit.json', encodePackage({
      schemaVersion: 1, package: 'toolkit', root: packageRoot, digest: packageSnapshot.digest,
      artifactRoot: '.', skillsRoot: '.'
    }));
    await directory.write('bazframe-home/profiles/focused/libraries/toolkit.json', encodeProfileCollectionReference({ schemaVersion: 1, library: 'toolkit' }));
    await directory.write('bazframe-home/profiles/focused/packages/toolkit.json', encodeProfileCollectionReference({ schemaVersion: 1, package: 'toolkit' }));

    const inspection = await inspectStatus(options);
    expect(inspection.profile).toMatchObject({
      state: 'ready',
      collectionReferenceCount: 2,
      derivedSkillCount: 0,
      collectionDiagnostics: [],
      collections: [
        { collectionKind: 'library', collectionId: 'toolkit', preparationState: 'ready' },
        { collectionKind: 'package', collectionId: 'toolkit', preparationState: 'ready' }
      ]
    });
    expect(statusExitStatus(inspection)).toBe(0);
    const text = formatStatus(inspection);
    expect(text).toContain('Profile library/package references: 2');
    expect(text).toContain('library toolkit: ready;');
    expect(text).toContain('package toolkit: ready;');
    expect(text).toContain('Derived effective skills: 0');
    expect(text).toContain('Library/package failures:\n  (none)');
  });

  it('reports the canonical kind-qualified refresh correction for a failed library', async () => {
    const directory = await temporary(); const options = await statusOptions(directory); await readyProfile(directory, options); await installPiAdapter(options);
    const provider = await realpath(await directory.mkdir('library'));
    await directory.write('bazframe-home/libraries/library.json', encodeLibrary({ schemaVersion: 1, library: 'library', root: provider, digest: '0'.repeat(64) }));
    await directory.write('bazframe-home/profiles/focused/libraries/library.json', encodeProfileCollectionReference({ schemaVersion: 1, library: 'library' }));
    const status = await buildStatus(options);
    expect(status.exitStatus).toBe(3); expect(status.text).toContain('library library: failed; refresh available;');
    expect(status.text).toContain('Refresh the affected libraries/packages with: `bazframe libraries update library`.');
  });

  it('uses kind-specific wording for an invalid library record', async () => {
    const directory = await temporary(); const options = await statusOptions(directory); await readyProfile(directory, options); await installPiAdapter(options);
    await directory.write('bazframe-home/libraries/broken.json', '{}\n');
    await directory.write('bazframe-home/profiles/focused/libraries/broken.json', encodeProfileCollectionReference({ schemaVersion: 1, library: 'broken' }));
    const status = await buildStatus(options);
    expect(status.text).toContain('library broken:broken.json invalid-library');
    expect(status.text).not.toContain('invalid-collection');
  });

  it('keeps flat status ready while reporting sorted library/package failures and corrections', async () => {
    const directory = await temporary(); const options = await statusOptions(directory); await readyProfile(directory, options); await installPiAdapter(options);
    const libraryRoot = await realpath(await directory.mkdir('library')); const packageRoot = await realpath(await directory.mkdir('package'));
    await directory.write('bazframe-home/libraries/library.json', encodeLibrary({ schemaVersion: 1, library: 'library', root: libraryRoot, digest: '0'.repeat(64) }));
    await directory.write('bazframe-home/packages/package.json', encodePackage({ schemaVersion: 1, package: 'package', root: packageRoot, digest: '1'.repeat(64), artifactRoot: 'dist', skillsRoot: 'skills' }));
    await directory.write('bazframe-home/profiles/focused/libraries/library.json', encodeProfileCollectionReference({ schemaVersion: 1, library: 'library' }));
    await directory.write('bazframe-home/profiles/focused/packages/package.json', encodeProfileCollectionReference({ schemaVersion: 1, package: 'package' }));
    const inspection = await inspectStatus(options); expect(inspection.profile).toMatchObject({ state: 'ready', flatSkillCount: 1, collectionReferenceCount: 2, derivedSkillCount: 0 });
    expect(statusExitStatus(inspection)).toBe(3);
    const text = formatStatus(inspection);
    expect(text).toContain('Library/package failures:\n  - library library:. broken-snapshot\n  - package package:. broken-snapshot');
    expect(text).toContain('`bazframe libraries update library`, `bazframe packages build package`');
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
        'Flat direct skills: 1',
        'Profile library/package references: 0',
        'Derived effective skills: 0',
        '  (none)',
        'Library/package failures:',
        '  (none)',
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
      'Flat direct skills: 0',
      'Profile library/package references: 0',
      'Derived effective skills: 0',
      '  (none)',
      'Library/package failures:',
      '  (none)',
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

  it('formats inspectable managed Git provenance and resource-specific update guidance', () => {
    const text = formatStatus({
      bazframeHome: '/home/.bazframe',
      piAgentDirectory: '/home/.pi/agent',
      adapter: { state: 'current', targetPath: '/home/.pi/agent/extensions/bazframe.ts' },
      globalPolicy: { policy: 'disabled', statePath: '/home/.bazframe/global-policy.json' },
      repository: { kind: 'outside-git' },
      effectiveBehavior: { kind: 'outside-git', enabled: false, reason: 'global-disabled' },
      profile: { state: 'not-used', reason: 'global-disabled' },
      cachedCollisionAliasCount: 0,
      managedGitProviders: [{
        health: `ready${String.fromCharCode(0x9b)}31m\u202e`,
        record: {
          schemaVersion: 1, kind: 'package', id: 'personal-agent-network',
          root: `/home/.bazframe/providers/git/checkouts/package/personal-agent-network${String.fromCharCode(0x9b)}`,
          remote: 'github.com/sram1337/personal-agent-network',
          fetchUrl: 'https://github.com/sram1337/personal-agent-network.git',
          transport: 'gh',
          branch: 'main', revision: 'a'.repeat(40)
        }
      }],
      managedGitDiagnostics: [`recovery${String.fromCharCode(0x9b)}\u202e`],
      correctiveActions: []
    });
    expect(text).toContain('Managed Git providers:');
    expect(text).toContain(`package personal-agent-network: ready\\u009b31m\\u202e; github.com/sram1337/personal-agent-network; branch:main; revision:${'a'.repeat(40)}`);
    expect(text).toContain('provider:/home/.bazframe/providers/git/checkouts/package/personal-agent-network\\u009b');
    expect(text).toContain('recovery\\u009b\\u202e');
    expect(text).not.toContain(String.fromCharCode(0x9b));
    expect(text).not.toContain('\u202e');
    expect(text).toContain('update:bazframe packages update personal-agent-network');
  });
});

async function readyProfile(directory: TempDirectory, options: StatusOptions): Promise<void> {
  await directory.write('bazframe-home/profiles/focused/AGENTS.md', 'profile\n');
  await directory.write(
    'bazframe-home/profiles/focused/skills/review/SKILL.md',
    '---\nname: review\ndescription: review\n---\n\nskill\n'
  );
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
