import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, readFile, readdir, realpath, rename, symlink, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureProviderManifest } from '../../helpers/provider-manifest.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { publishSkillSnapshot } from '../../../src/skill-collections/skill-snapshot.js';
import { encodeLibrary, encodePackage } from '../../../src/skill-collections/skill-collection-store.js';
import { encodeProfileCollectionReference } from '../../../src/profiles/profile-skill-collection-reference.js';
import { importedResourceIdentity, resourceIdentityDigest } from '../../../src/profile-publishing/captured-profile.js';

const temporaryDirectories: TempDirectory[] = [];
const execFileAsync = promisify(execFile);
const originalBazframeHome = process.env.BAZFRAME_HOME;
const originalPiAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const originalPath = process.env.PATH;
const originalExitCode = process.exitCode;

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;
type CommandHandler = (args: string, context: Record<string, unknown>) => unknown;
type Completion = { value: string; label: string };
type Command = {
  handler: CommandHandler;
  getArgumentCompletions?: (prefix: string) => Completion[] | null;
};
type RuntimeCommand = { name: string; source: string };

interface LoadedAdapter {
  default: (pi: {
    on: (name: string, handler: Handler) => void;
    registerCommand: (name: string, command: Command) => void;
    getCommands: () => RuntimeCommand[];
  }) => void;
}

interface Harness {
  events: Map<string, Handler>;
  commands: Map<string, Command>;
}

afterEach(async () => {
  restoreEnvironment('BAZFRAME_HOME', originalBazframeHome);
  restoreEnvironment('PI_CODING_AGENT_DIR', originalPiAgentDirectory);
  restoreEnvironment('PATH', originalPath);
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('packaged Pi adapter command', () => {
  it('gates native Windows before state resolution, resources, agent start, and info', async () => {
    const directory = await createTempDirectory('bazframe-pi-artifact-win32-gate-');
    temporaryDirectories.push(directory);
    process.env.BAZFRAME_HOME = directory.path('must-not-be-read');
    process.env.PI_CODING_AGENT_DIR = directory.path('must-not-be-read-pi');
    const adapter = await loadArtifact(directory, false, '0.84.4', {
      runtimePlatform: 'win32',
      poisonResolveState: true
    });
    const harness = register(adapter, []);
    const notifications: Array<{ message: string; level: string }> = [];
    const context = {
      cwd: directory.path('cwd'),
      hasUI: true,
      ui: { notify: (message: string, level: string) => { notifications.push({ message, level }); } }
    };

    expect(required(harness.events, 'input')({}, context)).toEqual({ action: 'handled' });
    await expect(required(harness.events, 'session_start')({}, context)).resolves.toBeUndefined();
    await expect(required(harness.events, 'resources_discover')(
      { cwd: directory.path('other-cwd') }, context
    )).resolves.toBeUndefined();
    const beforeAgent = required(harness.events, 'before_agent_start')(
      { systemPrompt: 'native', systemPromptOptions: { contextFiles: [] } }, context
    ) as { systemPrompt: string };
    expect(beforeAgent.systemPrompt).toContain('Do not act on the user request.');
    expect(beforeAgent.systemPrompt).toContain('Native Windows support is not available');

    let reloaded = 0;
    let info = { message: '', level: '' };
    const command = required(harness.commands, 'bazframe');
    await command.handler('info', {
      getSystemPromptOptions: () => { throw new Error('info inspected Pi context'); },
      reload: async () => { reloaded += 1; },
      ui: { notify: (message: string, level: string) => { info = { message, level }; } }
    });
    expect(info).toEqual({
      message: 'Native Windows support is not available in this Bazframe release. Use Bazframe on macOS or Linux; help and version output remain available.',
      level: 'error'
    });
    await command.handler('reload', {
      reload: async () => { reloaded += 1; },
      ui: { notify: () => undefined }
    });
    expect(reloaded).toBe(1);
    await expect(required(harness.events, 'resources_discover')(
      { cwd: directory.path('after-reload') }, context
    )).resolves.toBeUndefined();
    expect(notifications.every(({ message }) => message.includes('Native Windows support is not available'))).toBe(true);
  });

  it.each([
    ['0.84.3', false],
    ['0.84.4-beta.1', false],
    ['not-a-version', false],
    ['0.84.4', true],
    ['0.85.0', true],
    ['1.0.0', true]
  ])('enforces the stable Pi minimum for %s', async (piVersion, supported) => {
    const fixture = await activeFixture(`pi-version-${piVersion.replaceAll('.', '-')}`);
    const harness = register(await loadArtifact(fixture.directory, false, piVersion), []);
    const notifications: Array<{ message: string; level: string }> = [];
    await required(harness.events, 'session_start')({}, {
      cwd: fixture.repository,
      hasUI: true,
      ui: {
        notify: (message: string, level: string) => { notifications.push({ message, level }); }
      }
    });

    if (supported) {
      expect(notifications).toEqual([]);
      const info = await runCommand(required(harness.commands, 'bazframe'), 'info', []);
      expect(info.level).toBe('info');
      expect(info.message).toContain('Profile: focused');
    } else {
      expect(notifications).toEqual([{
        message: `Bazframe profile failed to load: Bazframe requires a stable Pi 0.84.4 or newer; this process is Pi ${piVersion}.`,
        level: 'error'
      }]);
    }
  });

  it('registers only /bazframe, completes its subcommands, and reports exact active info', async () => {
    const fixture = await activeFixture('active-info');
    const runtimeCommands: RuntimeCommand[] = [
      { name: 'skill:zeta', source: 'skill' },
      { name: 'skill:alpha', source: 'skill' },
      { name: 'skill:alpha', source: 'skill' },
      { name: 'other', source: 'extension' }
    ];
    const harness = register(await loadArtifact(fixture.directory), runtimeCommands);

    expect([...harness.commands.keys()]).toEqual(['bazframe']);
    expect(harness.commands.has('bzf-explain')).toBe(false);
    expect(harness.commands.has('bzf-reload')).toBe(false);
    expect(required(harness.commands, 'bazframe').getArgumentCompletions?.('')).toEqual([
      { value: 'info', label: 'info' },
      { value: 'reload', label: 'reload' }
    ]);
    expect(required(harness.commands, 'bazframe').getArgumentCompletions?.('re')).toEqual([
      { value: 'reload', label: 'reload' }
    ]);

    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));
    const piContext = ['/pi/global/AGENTS.md', '/repo/AGENTS.md'];
    const notification = await runCommand(required(harness.commands, 'bazframe'), 'info', piContext);
    expect(notification).toEqual({
      message: [
        'Profile: focused',
        'Context:',
        '  (pi) /pi/global/AGENTS.md',
        '  (pi) /repo/AGENTS.md',
        `  (bazframe) ${fixture.profileInstructions}`,
        ...collectionInfoLines(),
        'Skills: alpha, zeta'
      ].join('\n'),
      level: 'info'
    });

    let incompatibleMessage = '';
    await required(harness.commands, 'bazframe').handler('info', {
      getSystemPromptOptions: () => { throw new Error('missing structured context'); },
      ui: { notify: (message: string) => { incompatibleMessage = message; } }
    });
    expect(incompatibleMessage).toBe([
      'Profile: (none)',
      'Context: (none)',
      ...collectionInfoLines(),
      'Skills: alpha, zeta'
    ].join('\n'));
  });

  it('shows restored global context for an empty Pi context list', async () => {
    const fixture = await activeFixture('empty-context');
    const harness = register(await loadArtifact(fixture.directory), []);
    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));

    const notification = await runCommand(required(harness.commands, 'bazframe'), '  info  ', []);
    expect(notification.message).toBe([
      'Profile: focused',
      'Context:',
      `  (bazframe) ${fixture.globalInstructions}`,
      `  (bazframe) ${fixture.profileInstructions}`,
      ...collectionInfoLines(),
      'Skills: (none)'
    ].join('\n'));
    expect(notification.message).not.toContain('Aliases:');
  });

  it('composes the exact Pi prompt order and reports each mode once per load', async () => {
    const fixture = await activeFixture('exact-prompt-order');
    const harness = register(await loadArtifact(fixture.directory), []);
    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));
    const notifications: Array<{ message: string; level: string }> = [];
    const uiContext = {
      hasUI: true,
      ui: {
        notify: (message: string, level: string) => { notifications.push({ message, level }); }
      }
    };

    const nativeContext = {
      systemPrompt: 'native prompt',
      systemPromptOptions: { contextFiles: [{ path: '/pi/AGENTS.md' }] }
    };
    const additive = required(harness.events, 'before_agent_start')(
      nativeContext,
      uiContext
    ) as { systemPrompt: string };
    expect(additive.systemPrompt).toBe([
      'native prompt',
      '',
      `<bazframe_profile_instructions path="${fixture.profileInstructions}">`,
      'profile instructions',
      '',
      '</bazframe_profile_instructions>'
    ].join('\n'));
    required(harness.events, 'before_agent_start')(nativeContext, uiContext);
    expect(notifications).toEqual([{
      message: 'Bazframe: Pi owns native global/project context; appended profile instructions only.',
      level: 'info'
    }]);

    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));
    notifications.length = 0;
    const replacementContext = {
      systemPrompt: 'native prompt',
      systemPromptOptions: { contextFiles: [] }
    };
    const replacement = required(harness.events, 'before_agent_start')(
      replacementContext,
      uiContext
    ) as { systemPrompt: string };
    expect(replacement.systemPrompt).toBe([
      'native prompt',
      '',
      `<bazframe_global_instructions path="${fixture.globalInstructions}">`,
      'global instructions',
      '',
      '</bazframe_global_instructions>',
      '',
      `<bazframe_profile_instructions path="${fixture.profileInstructions}">`,
      'profile instructions',
      '',
      '</bazframe_profile_instructions>'
    ].join('\n'));
    required(harness.events, 'before_agent_start')(replacementContext, uiContext);
    expect(notifications).toEqual([{
      message: 'Bazframe: Pi supplied no native context; restored global context and appended profile instructions.',
      level: 'info'
    }]);
  });

  it.skipIf(process.platform === 'win32')(
    'escapes instruction source attributes while preserving opaque bodies exactly',
    async () => {
      const fixture = await activeFixture('prompt-&"<>', [], false);
      await fixture.directory.write(
        'pi-agent/AGENTS.md',
        'global <opaque attr="&"> body\n'
      );
      await fixture.directory.write(
        'bazframe-home/profiles/focused/AGENTS.md',
        'profile <opaque attr="&"> body\n'
      );
      const harness = register(await loadArtifact(fixture.directory), []);
      await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));

      const composed = required(harness.events, 'before_agent_start')(
        { systemPrompt: 'native prompt', systemPromptOptions: { contextFiles: [] } },
        { hasUI: false, ui: { notify: () => undefined } }
      ) as { systemPrompt: string };
      expect(composed.systemPrompt).toBe([
        'native prompt',
        '',
        `<bazframe_global_instructions path="${escapedAttribute(fixture.globalInstructions)}">`,
        'global <opaque attr="&"> body',
        '',
        '</bazframe_global_instructions>',
        '',
        `<bazframe_profile_instructions path="${escapedAttribute(fixture.profileInstructions)}">`,
        'profile <opaque attr="&"> body',
        '',
        '</bazframe_profile_instructions>'
      ].join('\n'));
    }
  );

  it('loads profile context and skill resources outside Git under global enable', async () => {
    const fixture = await activeFixture('outside-enabled', ['profile-skill'], false);
    const harness = register(await loadArtifact(fixture.directory, true), []);

    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));
    const profileRoot = fixture.directory.path('bazframe-home/profiles/focused');
    const ownedBeforeProjection = await captureProviderManifest([profileRoot]);
    const providerBeforeProjection = await captureProviderManifest([]);
    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
    const providerAfterProjection = await captureProviderManifest([]);
    const ownedAfterProjection = await captureProviderManifest([profileRoot]);
    expect(providerAfterProjection).toEqual(providerBeforeProjection);
    expect(ownedAfterProjection).toEqual(ownedBeforeProjection);
    const beforeAgent = required(harness.events, 'before_agent_start')(
      {
        systemPrompt: 'native prompt',
        systemPromptOptions: { contextFiles: [{ path: '/pi/AGENTS.md' }] }
      },
      { hasUI: false, ui: { notify: () => undefined } }
    ) as { systemPrompt: string };

    expect(resources).toEqual({
      skillPaths: [fixture.directory.path('bazframe-home/profiles/focused/skills/profile-skill/SKILL.md')]
    });
    expect(beforeAgent.systemPrompt).toContain('native prompt');
    expect(beforeAgent.systemPrompt).toContain('profile instructions');
    expect(beforeAgent.systemPrompt).toContain(fixture.profileInstructions);
    expect((await runCommand(required(harness.commands, 'bazframe'), 'info', ['/pi/AGENTS.md'])).message)
      .toContain('Profile: focused');
  });

  it('accepts an imported artifact Skill manifest path with 64 total components', async () => {
    const { fixture, harness, treeId, skillPath } = await managedImportedArtifactFixture(64);
    const notifications: string[] = [];
    await required(harness.events, 'session_start')({}, {
      cwd: fixture.repository,
      hasUI: true,
      ui: { notify: (message: string) => { notifications.push(message); } }
    });
    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
    );
    expect(notifications).toEqual([]);
    expect(resources).toEqual({
      skillPaths: [fixture.directory.path(`bazframe-home/profile-publishing/trees/${treeId}/root/${skillPath}`)]
    });
  });

  it('rejects an imported artifact Skill manifest path with 65 total components', async () => {
    const { fixture, harness } = await managedImportedArtifactFixture(65);
    const notifications: string[] = [];
    await required(harness.events, 'session_start')({}, {
      cwd: fixture.repository,
      hasUI: true,
      ui: { notify: (message: string) => { notifications.push(message); } }
    });
    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
    );
    expect(resources).toBeUndefined();
    expect(notifications).toEqual([
      'Bazframe profile failed to load: Invalid managed artifact file'
    ]);
  });

  it('rejects symlinked profile ancestors before loading external instructions or flat skills', async () => {
    for (const scenario of ['home-root', 'profiles-root', 'profile-root'] as const) {
      const fixture = await activeFixture(`profile-ancestor-${scenario}`, ['external-skill']);
      const homeRoot = fixture.directory.path('bazframe-home');
      const profilesRoot = fixture.directory.path('bazframe-home/profiles');
      const profileRoot = fixture.directory.path('bazframe-home/profiles/focused');
      await fixture.directory.mkdir(`outside-${scenario}`);
      const outsidePath = fixture.directory.path(`outside-${scenario}`, scenario);
      const movedPath = scenario === 'home-root'
        ? homeRoot
        : scenario === 'profiles-root'
          ? profilesRoot
          : profileRoot;
      await rename(movedPath, outsidePath);
      await symlink(outsidePath, movedPath);
      const outsideProfile = scenario === 'home-root'
        ? `${outsidePath}/profiles/focused`
        : scenario === 'profiles-root'
          ? `${outsidePath}/focused`
          : outsidePath;

      const harness = register(await loadArtifact(fixture.directory, true), []);
      const resources = await required(harness.events, 'resources_discover')(
        { cwd: fixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
      );
      const beforeAgent = required(harness.events, 'before_agent_start')(
        { systemPrompt: 'native prompt', systemPromptOptions: { contextFiles: [{ path: '/pi/AGENTS.md' }] } },
        { hasUI: false, ui: { notify: () => undefined } }
      );
      const info = await runCommand(required(harness.commands, 'bazframe'), 'info', ['/pi/AGENTS.md']);

      expect(resources, scenario).toBeUndefined();
      expect(beforeAgent, scenario).toBeUndefined();
      expect(info.message, scenario).toContain('Profile: (none)');
      expect(info.message, scenario).not.toContain('profile instructions');
      expect(info.message, scenario).not.toContain('external-skill');
      await expect(readFile(`${outsideProfile}/AGENTS.md`, 'utf8'), scenario).resolves.toBe('profile instructions\n');
      await expect(readFile(`${outsideProfile}/skills/external-skill/SKILL.md`, 'utf8'), scenario)
        .resolves.toContain('name: external-skill');
    }
  });

  it('projects activated snapshot definitions individually without passing a grouping root', async () => {
    const fixture = await activeFixture('source-projection');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write(
      'provider-root/nested/alpha/SKILL.md',
      '---\nname: alpha\ndescription: alpha\n---\n\nalpha\n'
    );
    const activated = await writeLibrarySnapshotRecord(fixture.directory, provider);
    const descriptorPath = fixture.directory.path(
      'bazframe-home/libraries/provider-root.json'
    );
    const harness = register(await loadArtifact(fixture.directory, true), []);
    const ownedBeforeFirst = await captureProviderManifest([descriptorPath]);
    const beforeFirst = await captureProviderManifest([provider]);

    const first = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
    const afterFirst = await captureProviderManifest([provider]);
    const ownedAfterFirst = await captureProviderManifest([descriptorPath]);
    expect(afterFirst).toEqual(beforeFirst);
    expect(ownedAfterFirst).toEqual(ownedBeforeFirst);
    expect(first).toEqual({ skillPaths: [`${activated.artifactPath}/nested/alpha/SKILL.md`] });
    expect((first as { skillPaths: string[] }).skillPaths).not.toContain(provider);

    const infoNotification = await runCommand(required(harness.commands, 'bazframe'), 'info', []);
    expect(infoNotification.message).toContain('Flat direct skills: 0');
    expect(infoNotification.message).toContain('Profile library/package references: 1');
    expect(infoNotification.message).toContain('Derived effective skills: 1');
    expect(infoNotification.message).toContain('alpha (library provider-root:nested/alpha/SKILL.md)');
    expect(infoNotification.message).toContain('Library/package failures: 0');

    const betaDefinition = await fixture.directory.write(
      'provider-root/beta/SKILL.md',
      '---\nname: beta\ndescription: beta\n---\n\nbeta\n'
    );
    const ownedBeforeReload = await captureProviderManifest([descriptorPath]);
    const changedBeforeReload = await captureProviderManifest([provider]);
    const reloaded = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
    const changedAfterReload = await captureProviderManifest([provider]);
    const ownedAfterReload = await captureProviderManifest([descriptorPath]);
    expect(changedAfterReload).toEqual(changedBeforeReload);
    expect(ownedAfterReload).toEqual(ownedBeforeReload);
    expect(reloaded).toEqual({ skillPaths: [`${activated.artifactPath}/nested/alpha/SKILL.md`] });
    expect((reloaded as { skillPaths: string[] }).skillPaths).not.toContain(await realpath(betaDefinition));
  });

  it('keeps same-ID libraries/packages separate, shows healthy zero-Skill objects, and emits kind-qualified corrections', async () => {
    const fixture = await activeFixture('typed-collections');
    const libraryRoot = await realpath(await fixture.directory.mkdir('library/toolkit'));
    const packageRoot = await realpath(await fixture.directory.mkdir('package/toolkit'));
    const emptyRoot = await realpath(await fixture.directory.mkdir('package/empty'));
    await fixture.directory.write('library/toolkit/alpha/SKILL.md', '---\nname: alpha\ndescription: alpha\n---\n');
    await fixture.directory.write('package/toolkit/artifact/skills/beta/SKILL.md', '---\nname: beta\ndescription: beta\n---\n');
    await fixture.directory.mkdir('package/empty/artifact/skills');
    const librarySnapshot = await publishSkillSnapshot(fixture.directory.path('bazframe-home'), libraryRoot);
    const packageArtifact = await realpath(fixture.directory.path('package/toolkit/artifact'));
    const packageSnapshot = await publishSkillSnapshot(fixture.directory.path('bazframe-home'), packageArtifact);
    const emptyArtifact = await realpath(fixture.directory.path('package/empty/artifact'));
    const emptySnapshot = await publishSkillSnapshot(fixture.directory.path('bazframe-home'), emptyArtifact);
    await fixture.directory.write('bazframe-home/libraries/toolkit.json', encodeLibrary({ schemaVersion: 1, library: 'toolkit', root: libraryRoot, digest: librarySnapshot.digest }));
    await fixture.directory.write('bazframe-home/packages/toolkit.json', encodePackage({ schemaVersion: 1, package: 'toolkit', root: packageRoot, digest: packageSnapshot.digest, artifactRoot: 'artifact', skillsRoot: 'skills' }));
    await fixture.directory.write('bazframe-home/packages/empty.json', encodePackage({ schemaVersion: 1, package: 'empty', root: emptyRoot, digest: emptySnapshot.digest, artifactRoot: 'artifact', skillsRoot: 'skills' }));
    await fixture.directory.write('bazframe-home/profiles/focused/libraries/toolkit.json', encodeProfileCollectionReference({ schemaVersion: 1, library: 'toolkit' }));
    await fixture.directory.write('bazframe-home/profiles/focused/packages/toolkit.json', encodeProfileCollectionReference({ schemaVersion: 1, package: 'toolkit' }));
    await fixture.directory.write('bazframe-home/profiles/focused/packages/empty.json', encodeProfileCollectionReference({ schemaVersion: 1, package: 'empty' }));
    const harness = register(await loadArtifact(fixture.directory, true), []);
    const resources = await required(harness.events, 'resources_discover')({ cwd: fixture.repository }, { hasUI: false, ui: { notify: () => undefined } }) as { skillPaths: string[] };
    expect(resources.skillPaths).toHaveLength(2);
    const message = (await runCommand(required(harness.commands, 'bazframe'), 'info', [])).message;
    expect(message).toContain('library toolkit ->');
    expect(message).toContain('package toolkit ->');
    expect(message).toContain('package empty ->');
    expect(message).toContain('alpha (library toolkit:alpha/SKILL.md)');
    expect(message).toContain('beta (package toolkit:beta/SKILL.md)');
    expect(message).toContain('Library/package failures: 0');

    await fixture.directory.write('bazframe-home/libraries/broken.json', encodeLibrary({ schemaVersion: 1, library: 'broken', root: await realpath(await fixture.directory.mkdir('library/broken')), digest: '0'.repeat(64) }));
    await fixture.directory.write('bazframe-home/packages/broken.json', encodePackage({ schemaVersion: 1, package: 'broken', root: await realpath(await fixture.directory.mkdir('package/broken')), digest: '0'.repeat(64), artifactRoot: 'artifact', skillsRoot: 'skills' }));
    await fixture.directory.write('bazframe-home/profiles/focused/libraries/broken.json', encodeProfileCollectionReference({ schemaVersion: 1, library: 'broken' }));
    await fixture.directory.write('bazframe-home/profiles/focused/packages/broken.json', encodeProfileCollectionReference({ schemaVersion: 1, package: 'broken' }));
    const reloaded = register(await loadArtifact(fixture.directory, true), []);
    await required(reloaded.events, 'session_start')({}, sessionContext(fixture.repository));
    const failed = (await runCommand(required(reloaded.commands, 'bazframe'), 'info', [])).message;
    expect(failed).toContain('library broken:. broken-snapshot');
    expect(failed).toContain('package broken:. broken-snapshot');
    expect(failed).toContain('bazframe library update broken');
    expect(failed).toContain('bazframe package build broken');
  });

  it('does not fall back to legacy nested or provider-shaped global source state', async () => {
    const nestedFixture = await activeFixture('legacy-nested-global-source');
    const nestedProvider = await realpath(await nestedFixture.directory.mkdir('provider-root'));
    await nestedFixture.directory.write('provider-root/alpha/SKILL.md', '---\nname: alpha\ndescription: alpha\n---\n');
    const nestedActivated = await writeLibrarySnapshotRecord(nestedFixture.directory, nestedProvider);
    const nestedRecord = JSON.parse(await readFile(nestedActivated.descriptorPath, 'utf8')) as Record<string, unknown>;
    await unlink(nestedActivated.descriptorPath);
    await nestedFixture.directory.write(
      'bazframe-home/libraries/legacy/provider-root.json',
      `${JSON.stringify({ ...nestedRecord, provider: 'legacy' }, null, 2)}\n`
    );
    const nestedHarness = register(await loadArtifact(nestedFixture.directory, true), []);
    const nestedResources = await required(nestedHarness.events, 'resources_discover')(
      { cwd: nestedFixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
    );
    const nestedMessage = (await runCommand(required(nestedHarness.commands, 'bazframe'), 'info', [])).message;
    expect(nestedResources).toBeUndefined();
    expect(nestedMessage).toContain('library provider-root:provider-root.json invalid-library');
    expect(nestedMessage).not.toContain('alpha (provider-root:');

    const shapedFixture = await activeFixture('legacy-provider-shaped-global-source');
    const shapedProvider = await realpath(await shapedFixture.directory.mkdir('provider-root'));
    await shapedFixture.directory.write('provider-root/alpha/SKILL.md', '---\nname: alpha\ndescription: alpha\n---\n');
    const shapedActivated = await writeLibrarySnapshotRecord(shapedFixture.directory, shapedProvider);
    const shapedRecord = JSON.parse(await readFile(shapedActivated.descriptorPath, 'utf8')) as Record<string, unknown>;
    await shapedFixture.directory.write(
      'bazframe-home/libraries/provider-root.json',
      `${JSON.stringify({ ...shapedRecord, provider: 'legacy' }, null, 2)}\n`
    );
    const shapedHarness = register(await loadArtifact(shapedFixture.directory, true), []);
    const shapedResources = await required(shapedHarness.events, 'resources_discover')(
      { cwd: shapedFixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
    );
    const shapedMessage = (await runCommand(required(shapedHarness.commands, 'bazframe'), 'info', [])).message;
    expect(shapedResources).toBeUndefined();
    expect(shapedMessage).toContain('library provider-root:provider-root.json invalid-library');
    expect(shapedMessage).not.toContain('alpha (provider-root:');
  });

  it('rejects symlinked library/package and reference namespace ancestors in the artifact', async () => {
    const globalFixture = await activeFixture('global-source-ancestor');
    const globalProvider = await realpath(await globalFixture.directory.mkdir('provider-root'));
    await globalFixture.directory.write('provider-root/alpha/SKILL.md', '---\nname: alpha\ndescription: alpha\n---\n');
    await writeLibrarySnapshotRecord(globalFixture.directory, globalProvider);
    await globalFixture.directory.mkdir('outside-global');
    const globalNamespace = globalFixture.directory.path('bazframe-home/libraries');
    const outsideGlobal = globalFixture.directory.path('outside-global/libraries');
    await rename(globalNamespace, outsideGlobal);
    await symlink(outsideGlobal, globalNamespace);
    const globalHarness = register(await loadArtifact(globalFixture.directory, true), []);
    const globalResources = await required(globalHarness.events, 'resources_discover')(
      { cwd: globalFixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
    );
    const globalMessage = (await runCommand(required(globalHarness.commands, 'bazframe'), 'info', [])).message;
    expect(globalResources).toBeUndefined();
    expect(globalMessage).toContain('library provider-root:provider-root.json invalid-library');
    await expect(readFile(`${outsideGlobal}/provider-root.json`, 'utf8')).resolves.toContain('"library": "provider-root"');

    const referenceFixture = await activeFixture('reference-source-ancestor');
    const referenceProvider = await realpath(await referenceFixture.directory.mkdir('provider-root'));
    await referenceFixture.directory.write('provider-root/alpha/SKILL.md', '---\nname: alpha\ndescription: alpha\n---\n');
    await writeLibrarySnapshotRecord(referenceFixture.directory, referenceProvider);
    await referenceFixture.directory.mkdir('outside-reference');
    const referenceNamespace = referenceFixture.directory.path('bazframe-home/profiles/focused/libraries');
    const outsideReference = referenceFixture.directory.path('outside-reference/libraries');
    await rename(referenceNamespace, outsideReference);
    await symlink(outsideReference, referenceNamespace);
    const referenceHarness = register(await loadArtifact(referenceFixture.directory, true), []);
    const referenceResources = await required(referenceHarness.events, 'resources_discover')(
      { cwd: referenceFixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
    );
    const referenceMessage = (await runCommand(required(referenceHarness.commands, 'bazframe'), 'info', [])).message;
    expect(referenceResources).toBeUndefined();
    expect(referenceMessage).toContain('library <unknown>:. invalid-reference');
    await expect(readFile(`${outsideReference}/provider-root.json`, 'utf8')).resolves.toContain('"library": "provider-root"');
  });

  it('fails the independent artifact reference reader closed across its physical-file matrix', async () => {
    const cases = [
      'profiles-root',
      'profile-root',
      'sources-root',
      'final-link',
      'invalid-utf8',
      'invalid-json',
      ...(process.platform === 'win32' ? [] : ['fifo'] as const)
    ] as const;
    for (const scenario of cases) {
      const fixture = await activeFixture(`reference-reader-${scenario}`);
      const provider = await realpath(await fixture.directory.mkdir('provider-root'));
      await fixture.directory.write('provider-root/alpha/SKILL.md', '---\nname: alpha\ndescription: alpha\n---\n');
      await writeLibrarySnapshotRecord(fixture.directory, provider);
      const profilesRoot = fixture.directory.path('bazframe-home/profiles');
      const profileRoot = fixture.directory.path('bazframe-home/profiles/focused');
      const sourcesRoot = fixture.directory.path('bazframe-home/profiles/focused/libraries');
      const referencePath = fixture.directory.path('bazframe-home/profiles/focused/libraries/provider-root.json');
      let outsideReference: string | undefined;
      if (scenario.endsWith('-root')) {
        const movedPath = scenario === 'profiles-root'
          ? profilesRoot
          : scenario === 'profile-root'
            ? profileRoot
            : sourcesRoot;
        await fixture.directory.mkdir(`outside-${scenario}`);
        const outsidePath = fixture.directory.path(`outside-${scenario}`, scenario);
        await rename(movedPath, outsidePath);
        await symlink(outsidePath, movedPath);
        outsideReference = scenario === 'profiles-root'
          ? `${outsidePath}/focused/libraries/provider-root.json`
          : scenario === 'profile-root'
            ? `${outsidePath}/libraries/provider-root.json`
            : `${outsidePath}/provider-root.json`;
      } else if (scenario === 'final-link') {
        await fixture.directory.mkdir('outside-final-link');
        outsideReference = fixture.directory.path('outside-final-link/provider-root.json');
        await rename(referencePath, outsideReference);
        await symlink(outsideReference, referencePath);
      } else if (scenario === 'invalid-utf8') {
        await fixture.directory.write('bazframe-home/profiles/focused/libraries/provider-root.json', new Uint8Array([0xff]));
      } else if (scenario === 'invalid-json') {
        await fixture.directory.write('bazframe-home/profiles/focused/libraries/provider-root.json', '{');
      } else {
        await unlink(referencePath);
        await execFileAsync('mkfifo', [referencePath]);
      }

      const harness = register(await loadArtifact(fixture.directory, true), []);
      const resources = await required(harness.events, 'resources_discover')(
        { cwd: fixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
      );
      const message = (await runCommand(required(harness.commands, 'bazframe'), 'info', [])).message;
      expect(resources, scenario).toBeUndefined();
      if (scenario === 'profiles-root' || scenario === 'profile-root') {
        expect(message, scenario).toContain('Profile: (none)');
      } else {
        expect(message, scenario).toContain('invalid-reference');
      }
      if (outsideReference !== undefined) {
        await expect(readFile(outsideReference, 'utf8'), scenario).resolves.toContain('"library": "provider-root"');
      }
    }
  });

  it('ignores inert pre-alpha source-units content and rejects writable snapshot mode drift', async () => {
    const fixture = await activeFixture('source-state-parity');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write('provider-root/alpha/SKILL.md', '---\nname: alpha\ndescription: alpha\n---\n');
    const activated = await writeLibrarySnapshotRecord(fixture.directory, provider);
    if (process.platform !== 'win32') await chmod(`${activated.snapshotRoot}/manifest.json`, 0o600);
    const legacyRoot = fixture.directory.path('missing-legacy');
    await fixture.directory.write('bazframe-home/profiles/focused/source-units/provider/legacy.json', `${JSON.stringify({
      schemaVersion: 1, providerId: 'provider', sourceId: 'legacy', sourceRoot: legacyRoot
    })}\n`);
    const harness = register(await loadArtifact(fixture.directory, true), []);
    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
    );
    if (process.platform !== 'win32') expect(resources).toBeUndefined();
    const message = (await runCommand(required(harness.commands, 'bazframe'), 'info', [])).message;
    expect(message).not.toContain('provider/legacy');
    if (process.platform !== 'win32') {
      expect(message).toContain('provider-root ->');
      expect(message).toContain('(failed; refresh:available;');
      expect(message).toContain('provider-root:. broken-snapshot');
      expect(message).toContain('bazframe library update provider-root');
    }
  });

  it('withholds a valid referenced object when a sibling reference is malformed in the artifact', async () => {
    const fixture = await activeFixture('source-diagnostic-parity', ['flat-skill']);
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write('provider-root/valid/SKILL.md', '---\nname: valid\ndescription: valid\n---\n');
    await writeLibrarySnapshotRecord(fixture.directory, provider);
    await fixture.directory.write('bazframe-home/profiles/focused/libraries/broken.json', '{');
    await fixture.directory.write(
      'bazframe-home/profiles/focused/libraries/malformed.json',
      '{\n  "schemaVersion": 1,\n  "provider": "provider",\n  "source": "malformed"\n}\n'
    );
    await fixture.directory.write('bazframe-home/libraries/malformed.json', '{}\n');
    await fixture.directory.write(
      'bazframe-home/profiles/focused/libraries/missing.json',
      '{\n  "schemaVersion": 1,\n  "provider": "provider",\n  "source": "missing"\n}\n'
    );
    const harness = register(await loadArtifact(fixture.directory, true), []);

    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository }, { hasUI: false, ui: { notify: () => undefined } }
    );
    const message = (await runCommand(required(harness.commands, 'bazframe'), 'info', [])).message;

    expect(resources).toEqual({
      skillPaths: [fixture.directory.path('bazframe-home/profiles/focused/skills/flat-skill/SKILL.md')]
    });
    expect(message).toContain('Flat direct skills: 1');
    expect(message).toContain('broken:broken.json invalid-reference');
    expect(message).toContain('Profile library/package references: 0');
    expect(message).not.toContain('valid (provider-root:');
    expect(message).not.toContain('provider/malformed (failed; target unavailable)');
    expect(message).not.toContain('provider/missing (failed; target unavailable)');
    expect(message).not.toContain(' invalid-source');
  });

  it('uses Pi-loaded folded and directory-fallback names in the artifact projection', async () => {
    const fixture = await activeFixture('source-name-parity');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write(
      'provider-root/directory-fallback/SKILL.md',
      '---\ndescription: fallback\n---\n\nfallback\n'
    );
    await fixture.directory.write(
      'provider-root/folded-directory/SKILL.md',
      '---\nname: >-\n  folded-name\ndescription: folded\n---\n\nfolded\n'
    );
    const activated = await writeLibrarySnapshotRecord(fixture.directory, provider);
    const descriptorPath = activated.descriptorPath;
    const harness = register(await loadArtifact(fixture.directory, 'parity'), []);
    const ownedBefore = await captureProviderManifest([descriptorPath]);
    const providerBefore = await captureProviderManifest([provider]);

    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
    const providerAfter = await captureProviderManifest([provider]);
    const ownedAfter = await captureProviderManifest([descriptorPath]);

    expect(providerAfter).toEqual(providerBefore);
    expect(ownedAfter).toEqual(ownedBefore);
    expect(resources).toEqual({
      skillPaths: [`${activated.artifactPath}/directory-fallback/SKILL.md`, `${activated.artifactPath}/folded-directory/SKILL.md`]
    });
    const infoNotification = await runCommand(required(harness.commands, 'bazframe'), 'info', []);
    expect(infoNotification.message).toContain(
      'directory-fallback (library provider-root:directory-fallback/SKILL.md)'
    );
    expect(infoNotification.message).toContain(
      'folded-name (library provider-root:folded-directory/SKILL.md)'
    );
  });

  it('withholds an artifact-backed object and normalizes every rejecting Pi diagnostic exactly', async () => {
    const fixture = await activeFixture('source-pi-rejection');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write(
      'provider-root/rejected/SKILL.md',
      '---\nname: rejected\ndescription: rejected\n---\n\nrejected\n'
    );
    await writeLibrarySnapshotRecord(fixture.directory, provider);
    const harness = register(await loadArtifact(fixture.directory, 'reject'), []);
    const descriptorPath = fixture.directory.path(
      'bazframe-home/libraries/provider-root.json'
    );
    const ownedBeforeProjection = await captureProviderManifest([descriptorPath]);
    const beforeProjection = await captureProviderManifest([provider]);

    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
    const afterProjection = await captureProviderManifest([provider]);
    const ownedAfterProjection = await captureProviderManifest([descriptorPath]);

    expect(afterProjection).toEqual(beforeProjection);
    expect(ownedAfterProjection).toEqual(ownedBeforeProjection);
    expect(resources).toBeUndefined();
    const infoNotification = await runCommand(required(harness.commands, 'bazframe'), 'info', []);
    expect(infoNotification.message).toContain('Derived effective skills: 0');
    expect(infoNotification.message).toContain('Library/package failures: 2');
    expect(infoNotification.message).toContain(
      'provider-root:rejected/SKILL.md pi-loader[0]: first Pi diagnostic'
    );
    expect(infoNotification.message).toContain(
      'provider-root:rejected/SKILL.md pi-loader[1]: second Pi diagnostic'
    );
  });

  it('aliases a native collision from the derived skill original base and definition', async () => {
    const fixture = await activeFixture('source-alias');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write(
      'provider-root/alpha/SKILL.md',
      '---\nname: alpha\ndescription: derived alpha\n---\n\nalpha\n'
    );
    const activated = await writeLibrarySnapshotRecord(fixture.directory, provider);
    const runtimeCommands = [{ name: 'skill:alpha', source: 'skill' }];
    const harness = register(await loadArtifact(fixture.directory, true), runtimeCommands);
    const descriptorPath = fixture.directory.path(
      'bazframe-home/libraries/provider-root.json'
    );
    const aliasRoot = fixture.directory.path(
      'bazframe-home/adapter-cache/pi/skill-aliases/focused'
    );
    const ownedBefore = await captureProviderManifest([descriptorPath, aliasRoot]);
    const before = await captureProviderManifest([provider]);

    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    ) as { skillPaths: string[] };
    const after = await captureProviderManifest([provider]);
    const ownedAfter = await captureProviderManifest([descriptorPath, aliasRoot]);
    expect(after).toEqual(before);
    expect(ownedAfter).not.toEqual(ownedBefore);
    expect(resources.skillPaths).toHaveLength(1);
    expect(resources.skillPaths[0]).toContain('alpha-x-bazframe/SKILL.md');
    const alias = await readFile(resources.skillPaths[0], 'utf8');
    expect(alias).toContain(JSON.stringify(`${activated.artifactPath}/alpha/SKILL.md`));
    expect(alias).toContain(JSON.stringify(`${activated.artifactPath}/alpha`));
  });

  it('fails a generated-alias collision visibly without replacing cache bytes or adding an alias', async () => {
    const fixture = await activeFixture('source-alias-collision');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write(
      'provider-root/alpha/SKILL.md',
      '---\nname: alpha\ndescription: derived alpha\n---\n\nalpha\n'
    );
    await writeLibrarySnapshotRecord(fixture.directory, provider);
    const cachedAlias = await fixture.directory.write(
      'bazframe-home/adapter-cache/pi/skill-aliases/focused/alpha-x-bazframe/SKILL.md',
      'preserve existing cache\n'
    );
    const runtimeCommands = [
      { name: 'skill:alpha', source: 'skill' },
      { name: 'skill:alpha-x-bazframe', source: 'skill' }
    ];
    const harness = register(await loadArtifact(fixture.directory, true), runtimeCommands);
    let notification = '';
    const descriptorPath = fixture.directory.path(
      'bazframe-home/libraries/provider-root.json'
    );
    const ownedBeforeProjection = await captureProviderManifest([descriptorPath, cachedAlias]);
    const beforeProjection = await captureProviderManifest([provider]);

    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: true, ui: { notify: (message: string) => { notification = message; } } }
    );
    const afterProjection = await captureProviderManifest([provider]);
    const ownedAfterProjection = await captureProviderManifest([descriptorPath, cachedAlias]);

    expect(afterProjection).toEqual(beforeProjection);
    expect(ownedAfterProjection).toEqual(ownedBeforeProjection);
    expect(resources).toBeUndefined();
    expect(notification).toContain(
      'Bazframe skill preparation failed: Bazframe skill alias also collides: alpha -> alpha-x-bazframe'
    );
    expect(await readFile(cachedAlias, 'utf8')).toBe('preserve existing cache\n');
    expect(await readdir(
      fixture.directory.path('bazframe-home/adapter-cache/pi/skill-aliases/focused')
    )).toEqual(['alpha-x-bazframe']);
    expect(runtimeCommands).toHaveLength(2);
  });

  it('keeps globally disabled non-Git directories native', async () => {
    const fixture = await activeFixture('outside-disabled', ['profile-skill'], false);
    await fixture.directory.write(
      'bazframe-home/global.json',
      `${JSON.stringify({ schemaVersion: 1, disabled: true })}\n`
    );
    const harness = register(await loadArtifact(fixture.directory, true), []);

    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));
    const profileRoot = fixture.directory.path('bazframe-home/profiles/focused');
    const ownedBeforeProjection = await captureProviderManifest([profileRoot]);
    const providerBeforeProjection = await captureProviderManifest([]);
    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
    const providerAfterProjection = await captureProviderManifest([]);
    const ownedAfterProjection = await captureProviderManifest([profileRoot]);
    expect(providerAfterProjection).toEqual(providerBeforeProjection);
    expect(ownedAfterProjection).toEqual(ownedBeforeProjection);
    expect(resources).toBeUndefined();
    expect(required(harness.events, 'before_agent_start')(
      {
        systemPrompt: 'native prompt',
        systemPromptOptions: { contextFiles: [{ path: '/pi/AGENTS.md' }] }
      },
      { hasUI: false, ui: { notify: () => undefined } }
    )).toBeUndefined();
    expect((await runCommand(required(harness.commands, 'bazframe'), 'info', ['/pi/AGENTS.md'])).message)
      .toBe([
        'Profile: (none)',
        'Context:',
        '  (pi) /pi/AGENTS.md',
        ...collectionInfoLines(),
        'Skills: (none)'
      ].join('\n'));
  });

  it('keeps globally disabled Git worktrees native', async () => {
    const disabled = await activeFixture('disabled');
    await disabled.directory.write(
      'bazframe-home/global.json',
      `${JSON.stringify({ schemaVersion: 1, disabled: true })}\n`
    );
    const disabledHarness = register(await loadArtifact(disabled.directory), []);
    await required(disabledHarness.events, 'session_start')({}, sessionContext(disabled.repository));
    expect((await runCommand(required(disabledHarness.commands, 'bazframe'), 'info', ['/pi/AGENTS.md'])).message)
      .toBe([
        'Profile: (none)',
        'Context:',
        '  (pi) /pi/AGENTS.md',
        ...collectionInfoLines(),
        'Skills: (none)'
      ].join('\n'));
  });

  it('reports malformed global policy outside Git before an agent turn', async () => {
    const directory = await createTempDirectory('bazframe-pi-artifact-outside-malformed-');
    temporaryDirectories.push(directory);
    process.env.BAZFRAME_HOME = directory.path('bazframe-home');
    process.env.PI_CODING_AGENT_DIR = directory.path('pi-agent');
    const cwd = await directory.mkdir('plain');
    await directory.write('bazframe-home/global.json', '{bad json\n');
    const harness = register(await loadArtifact(directory), []);
    let notification = '';

    await required(harness.events, 'session_start')({}, {
      cwd,
      hasUI: true,
      ui: { notify: (message: string) => { notification = message; } }
    });

    expect(notification).toContain('Bazframe profile failed to load:');
    expect(notification).toContain('Invalid JSON in global policy');
    expect(required(harness.events, 'input')({}, {
      hasUI: true,
      ui: { notify: () => undefined }
    })).toEqual({ action: 'handled' });
  });

  it('shows deterministic collision mappings only when present', async () => {
    const fixture = await activeFixture('collision', ['zeta', 'alpha']);
    const runtimeCommands: RuntimeCommand[] = [
      { name: 'skill:zeta', source: 'skill' },
      { name: 'skill:alpha', source: 'skill' }
    ];
    const harness = register(await loadArtifact(fixture.directory, true), runtimeCommands);
    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));
    const aliasRoot = fixture.directory.path(
      'bazframe-home/adapter-cache/pi/skill-aliases/focused'
    );
    const ownedBeforeProjection = await captureProviderManifest([aliasRoot]);
    const providerBeforeProjection = await captureProviderManifest([]);
    await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
    const providerAfterProjection = await captureProviderManifest([]);
    const ownedAfterProjection = await captureProviderManifest([aliasRoot]);
    expect(providerAfterProjection).toEqual(providerBeforeProjection);
    expect(ownedAfterProjection).not.toEqual(ownedBeforeProjection);
    runtimeCommands.push(
      { name: 'skill:zeta-x-bazframe', source: 'skill' },
      { name: 'skill:alpha-x-bazframe', source: 'skill' }
    );

    const notification = await runCommand(required(harness.commands, 'bazframe'), 'info', []);
    expect(notification.message).toBe([
      'Profile: focused',
      'Context:',
      `  (bazframe) ${fixture.globalInstructions}`,
      `  (bazframe) ${fixture.profileInstructions}`,
      ...collectionInfoLines([
        ['alpha', fixture.directory.path('bazframe-home/profiles/focused/skills/alpha/SKILL.md')],
        ['zeta', fixture.directory.path('bazframe-home/profiles/focused/skills/zeta/SKILL.md')]
      ]),
      'Skills: alpha, alpha-x-bazframe, zeta, zeta-x-bazframe',
      'Aliases: alpha -> alpha-x-bazframe, zeta -> zeta-x-bazframe'
    ].join('\n'));
  });

  it('truncates a 64-character colliding flat name to one free 64-character Pi alias', async () => {
    const originalName = 'a'.repeat(64);
    const aliasName = `${'a'.repeat(53)}-x-bazframe`;
    expect(aliasName).toHaveLength(64);
    const fixture = await activeFixture('long-flat-alias', [originalName]);
    const runtimeCommands: RuntimeCommand[] = [{ name: `skill:${originalName}`, source: 'skill' }];
    const harness = register(await loadArtifact(fixture.directory, true), runtimeCommands);
    let notification = '';

    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: true, ui: { notify: (message: string) => { notification = message; } } }
    ) as { skillPaths: string[] };

    const expectedAliasPath = fixture.directory.path(
      `bazframe-home/adapter-cache/pi/skill-aliases/focused/${aliasName}/SKILL.md`
    );
    expect(resources).toEqual({ skillPaths: [expectedAliasPath] });
    expect(notification).toBe(`Bazframe skill aliases: ${originalName} -> ${aliasName}`);
    expect(await readFile(expectedAliasPath, 'utf8')).toContain(`name: ${aliasName}\n`);
    runtimeCommands.push({ name: `skill:${aliasName}`, source: 'skill' });
    expect((await runCommand(required(harness.commands, 'bazframe'), 'info', [])).message)
      .toContain(`Aliases: ${originalName} -> ${aliasName}`);
  });

  it('fails a truncation-induced flat alias collision visibly with no fallback', async () => {
    const originalName = `${'a'.repeat(52)}-bbbbbbbbbbb`;
    const aliasName = `${'a'.repeat(52)}-x-bazframe`;
    expect(originalName).toHaveLength(64);
    const fixture = await activeFixture('long-flat-alias-collision', [originalName]);
    const cachedAlias = await fixture.directory.write(
      `bazframe-home/adapter-cache/pi/skill-aliases/focused/${aliasName}/SKILL.md`,
      'preserve truncation collision cache\n'
    );
    const runtimeCommands: RuntimeCommand[] = [
      { name: `skill:${originalName}`, source: 'skill' },
      { name: `skill:${aliasName}`, source: 'skill' }
    ];
    const harness = register(await loadArtifact(fixture.directory, true), runtimeCommands);
    let notification = '';

    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: true, ui: { notify: (message: string) => { notification = message; } } }
    );

    expect(resources).toBeUndefined();
    expect(notification).toBe(
      `Bazframe skill preparation failed: Bazframe skill alias also collides: ${originalName} -> ${aliasName}`
    );
    expect(await readFile(cachedAlias, 'utf8')).toBe('preserve truncation collision cache\n');
    expect(await readdir(
      fixture.directory.path('bazframe-home/adapter-cache/pi/skill-aliases/focused')
    )).toEqual([aliasName]);
    expect(runtimeCommands).toHaveLength(2);
  });

  it('awaits trimmed reload and rejects bare, unknown, and extra arguments without reloading', async () => {
    const directory = await createTempDirectory('bazframe-pi-artifact-dispatch-');
    temporaryDirectories.push(directory);
    const command = required(register(await loadArtifact(directory), []).commands, 'bazframe');
    let reloadCount = 0;
    let reloadFinished = false;
    const messages: string[] = [];
    const context = {
      reload: async () => {
        await Promise.resolve();
        reloadCount += 1;
        reloadFinished = true;
      },
      ui: { notify: (message: string) => { messages.push(message); } },
      getSystemPromptOptions: () => ({ contextFiles: [] })
    };

    await command.handler('  reload  ', context);
    expect(reloadFinished).toBe(true);
    for (const args of ['', 'unknown', 'info extra', 'reload extra']) {
      await command.handler(args, context);
    }
    expect(reloadCount).toBe(1);
    expect(messages).toEqual(Array(4).fill('Usage: /bazframe info | /bazframe reload'));
  });

  it('keeps Git discovery failures fail-closed without verbose info diagnostics', async () => {
    const directory = await createTempDirectory('bazframe-pi-artifact-missing-git-');
    temporaryDirectories.push(directory);
    const cwd = await directory.mkdir('working-directory');
    const emptyPath = await directory.mkdir('empty-path');
    process.env.BAZFRAME_HOME = directory.path('bazframe-home');
    process.env.PI_CODING_AGENT_DIR = directory.path('pi-agent');
    const harness = register(await loadArtifact(directory), []);
    process.env.PATH = emptyPath;

    await required(harness.events, 'session_start')({}, sessionContext(cwd));
    const notification = await runCommand(required(harness.commands, 'bazframe'), 'info', ['/pi/AGENTS.md']);
    expect(notification).toEqual({
      message: [
        'Profile: (none)',
        'Context:',
        '  (pi) /pi/AGENTS.md',
        ...collectionInfoLines(),
        'Skills: (none)'
      ].join('\n'),
      level: 'error'
    });
    expect(notification.message).not.toContain('Error:');

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(required(harness.events, 'input')({}, { hasUI: false })).toEqual({ action: 'handled' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Git worktree discovery failed'));
    expect(process.exitCode).toBe(1);
  });

  it('keeps an uncanonicalizable cwd fail-closed', async () => {
    const directory = await createTempDirectory('bazframe-pi-artifact-bad-cwd-');
    temporaryDirectories.push(directory);
    process.env.BAZFRAME_HOME = directory.path('bazframe-home');
    process.env.PI_CODING_AGENT_DIR = directory.path('pi-agent');
    const harness = register(await loadArtifact(directory), []);

    await required(harness.events, 'session_start')(
      {},
      sessionContext(directory.path('does-not-exist'))
    );
    const notification = await runCommand(required(harness.commands, 'bazframe'), 'info', []);
    expect(notification).toEqual({
      message: [
        'Profile: (none)',
        'Context: (none)',
        ...collectionInfoLines(),
        'Skills: (none)'
      ].join('\n'),
      level: 'error'
    });
    expect(required(harness.events, 'input')({}, { hasUI: true, ui: { notify: () => undefined } }))
      .toEqual({ action: 'handled' });
  });
});


async function managedImportedArtifactFixture(componentCount: 64 | 65): Promise<{
  fixture: Awaited<ReturnType<typeof activeFixture>>;
  harness: Harness;
  treeId: string;
  skillPath: string;
}> {
  const fixture = await activeFixture(`managed-imported-library-${componentCount}`);
  const definition = Buffer.from('---\nname: imported-skill\ndescription: Imported.\n---\n');
  const skillPath = `${Array.from({ length: componentCount - 2 }, (_, index) => `d${index}`).join('/')}/imported-skill/SKILL.md`;
  expect(skillPath.split('/')).toHaveLength(componentCount);
  const manifest = `${JSON.stringify({
    schemaVersion: 1,
    kind: 'bazframe-artifact-tree',
    role: 'library',
    files: [{
      path: skillPath,
      sha256: createHash('sha256').update(definition).digest('hex'),
      bytes: definition.byteLength,
      executable: false
    }]
  }, null, 2)}\n`;
  const treeId = createHash('sha256').update(manifest).digest('hex');
  await fixture.directory.write(`bazframe-home/profile-publishing/trees/${treeId}/root/${skillPath}`, definition);
  await fixture.directory.write(`bazframe-home/profile-publishing/trees/${treeId}/manifest.json`, manifest);
  await fixture.directory.write(`bazframe-home/profile-publishing/trees/${treeId}/COMMITTED`, `${treeId}\n`);
  await fixture.directory.write('bazframe-home/profiles/focused/.bazframe-profile-state.json', `${JSON.stringify({
    schemaVersion: 1,
    profileInstanceId: '00000000-0000-4000-8000-000000000001',
    publication: null,
    capturedResourceIds: [{
      resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity('00000000-0000-4000-8000-000000000002')),
      capturedResourceId: '0'.repeat(64),
      identityKind: 'imported',
      instanceId: '00000000-0000-4000-8000-000000000002'
    }],
    importedResources: [{
      instanceId: '00000000-0000-4000-8000-000000000002',
      capturedResourceId: '0'.repeat(64),
      key: { kind: 'library', name: 'imported-library' },
      source: { kind: 'artifact', treeId }
    }]
  }, null, 2)}\n`);
  return { fixture, harness: register(await loadArtifact(fixture.directory, true), []), treeId, skillPath };
}

async function writeLibrarySnapshotRecord(directory: TempDirectory, provider: string): Promise<{ descriptorPath: string; artifactPath: string; snapshotRoot: string }> {
  const snapshot = await publishSkillSnapshot(directory.path('bazframe-home'), provider);
  const library = provider.split('/').filter(Boolean).at(-1)!;
  const descriptorPath = await directory.write(
    `bazframe-home/libraries/${library}.json`,
    encodeLibrary({ schemaVersion: 1, library, root: provider, digest: snapshot.digest })
  );
  await directory.write(
    `bazframe-home/profiles/focused/libraries/${library}.json`,
    encodeProfileCollectionReference({ schemaVersion: 1, library })
  );
  return { descriptorPath, artifactPath: snapshot.artifactPath, snapshotRoot: snapshot.snapshotRoot };
}

async function activeFixture(
  name: string,
  skills: string[] = [],
  git = true
): Promise<{
  directory: TempDirectory;
  repository: string;
  globalInstructions: string;
  profileInstructions: string;
}> {
  const directory = await createTempDirectory(`bazframe-pi-artifact-${name}-`);
  temporaryDirectories.push(directory);
  const repository = await realpath(git
    ? await directory.initGit('repository')
    : await directory.mkdir('plain'));
  process.env.BAZFRAME_HOME = directory.path('bazframe-home');
  process.env.PI_CODING_AGENT_DIR = directory.path('pi-agent');
  await directory.write('bazframe-home/active-profile', 'focused\n');
  const profileInstructions = await directory.write(
    'bazframe-home/profiles/focused/AGENTS.md',
    'profile instructions\n'
  );
  await directory.mkdir('bazframe-home/profiles/focused/skills');
  for (const skill of skills) {
    await directory.write(
      `bazframe-home/profiles/focused/skills/${skill}/SKILL.md`,
      `---\nname: ${skill}\ndescription: ${skill}\n---\n\n${skill}\n`
    );
  }
  const globalInstructions = await directory.write('pi-agent/AGENTS.md', 'global instructions\n');
  return { directory, repository, globalInstructions, profileInstructions };
}

function register(adapter: LoadedAdapter, runtimeCommands: RuntimeCommand[]): Harness {
  const events = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  adapter.default({
    on: (name, handler) => { events.set(name, handler); },
    registerCommand: (name, command) => { commands.set(name, command); },
    getCommands: () => runtimeCommands
  });
  return { events, commands };
}

async function loadArtifact(
  directory: TempDirectory,
  loadSkills: false | true | 'reject' | 'parity' = false,
  piVersion = '0.84.4',
  testOptions: { runtimePlatform?: NodeJS.Platform; poisonResolveState?: boolean } = {}
): Promise<LoadedAdapter> {
  let source = await readFile(
    new URL('../../../artifacts/pi/bazframe.ts', import.meta.url),
    'utf8'
  );
  if (testOptions.runtimePlatform !== undefined) {
    const marker = 'const BAZFRAME_RUNTIME_PLATFORM = process.platform;';
    if (!source.includes(marker)) throw new Error('Packaged Pi platform seam is missing');
    source = source.replace(
      marker,
      `const BAZFRAME_RUNTIME_PLATFORM = ${JSON.stringify(testOptions.runtimePlatform)};`
    );
  }
  if (testOptions.poisonResolveState === true) {
    const marker = 'async function resolveState(cwd: string): Promise<AdapterState> {';
    if (!source.includes(marker)) throw new Error('Packaged Pi state resolver marker is missing');
    source = source.replace(marker, `${marker}\n\tthrow new Error("resolveState reached on gated platform");`);
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'bazframe.ts'
  }).outputText;
  await directory.write('runtime/package.json', '{"type":"module"}\n');
  await directory.write(
    'runtime/node_modules/@earendil-works/pi-coding-agent/package.json',
    '{"name":"@earendil-works/pi-coding-agent","type":"module","exports":"./index.js"}\n'
  );
  await directory.write(
    'runtime/node_modules/@earendil-works/pi-coding-agent/index.js',
    loadSkills === 'reject'
      ? [
          `export const VERSION = ${JSON.stringify(piVersion)};`,
          'export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;',
          'export const loadSkillsFromDir = () => ({',
          '  skills: [],',
          '  diagnostics: [',
          '    { type: "warning", message: "first Pi diagnostic" },',
          '    { type: "warning", message: "second Pi diagnostic" }',
          '  ]',
          '});',
          ''
        ].join('\n')
      : loadSkills === 'parity'
        ? [
            'import { basename, join } from "node:path";',
            `export const VERSION = ${JSON.stringify(piVersion)};`,
            'export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;',
            'export const loadSkillsFromDir = ({ dir: directory }) => ({',
            '  skills: [{',
            '    name: basename(directory) === "folded-directory" ? "folded-name" : basename(directory),',
            '    filePath: join(directory, "SKILL.md"),',
            '    baseDir: directory',
            '  }],',
            '  diagnostics: []',
            '});',
            ''
          ].join('\n')
        : loadSkills
          ? [
            'import { basename, join } from "node:path";',
            `export const VERSION = ${JSON.stringify(piVersion)};`,
            'export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;',
            'export const loadSkillsFromDir = ({ dir: directory }) => ({',
            '  skills: [{ name: basename(directory), filePath: join(directory, "SKILL.md"), baseDir: directory }],',
            '  diagnostics: []',
            '});',
            ''
          ].join('\n')
          : [
            `export const VERSION = ${JSON.stringify(piVersion)};`,
            'export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;',
            'export const loadSkillsFromDir = () => ({ skills: [], diagnostics: [] });',
            ''
          ].join('\n')
  );
  const artifactPath = await directory.write('runtime/bazframe.mjs', compiled);
  return import(`${pathToFileURL(artifactPath).href}?test=${Date.now()}-${Math.random()}`) as Promise<LoadedAdapter>;
}

function sessionContext(cwd: string): Record<string, unknown> {
  return { cwd, hasUI: false, ui: { notify: () => undefined } };
}

async function runCommand(
  command: Command,
  args: string,
  contextFiles: string[]
): Promise<{ message: string; level: string }> {
  let notification = { message: '', level: '' };
  await command.handler(args, {
    reload: async () => undefined,
    getSystemPromptOptions: () => ({ contextFiles: contextFiles.map((path) => ({ path })) }),
    ui: {
      notify: (message: string, level: string) => { notification = { message, level }; }
    }
  });
  return notification;
}

function collectionInfoLines(flatSkills: readonly (readonly [string, string])[] = []): string[] {
  return [
    `Flat direct skills: ${flatSkills.length}`,
    ...(flatSkills.length === 0
      ? ['  (none)']
      : flatSkills.map(([name, path]) => `  - ${name} (${path})`)),
    'Profile library/package references: 0',
    '  (none)',
    'Derived effective skills: 0',
    '  (none)',
    'Library/package failures: 0',
    '  (none)',
    'Corrective actions:',
    '  (none)'
  ];
}

function escapedAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function required<T>(map: Map<string, T>, name: string): T {
  const value = map.get(name);
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
