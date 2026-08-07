import { readFile, readdir, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureProviderManifest } from '../../helpers/provider-manifest.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];
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
        ...sourceInfoLines(),
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
      ...sourceInfoLines(),
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
      ...sourceInfoLines(),
      'Skills: (none)'
    ].join('\n'));
    expect(notification.message).not.toContain('Aliases:');
  });

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

  it('projects live derived definitions individually without passing a grouping root', async () => {
    const fixture = await activeFixture('source-projection');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    const alphaDefinition = await fixture.directory.write(
      'provider-root/nested/alpha/SKILL.md',
      '---\nname: alpha\ndescription: alpha\n---\n\nalpha\n'
    );
    await fixture.directory.write(
      'bazframe-home/profiles/focused/source-units/provider/source.json',
      `${JSON.stringify({
        schemaVersion: 1,
        providerId: 'provider',
        sourceId: 'source',
        sourceRoot: provider
      })}\n`
    );
    const descriptorPath = fixture.directory.path(
      'bazframe-home/profiles/focused/source-units/provider/source.json'
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
    expect(first).toEqual({ skillPaths: [await realpath(alphaDefinition)] });
    expect((first as { skillPaths: string[] }).skillPaths).not.toContain(provider);

    const infoNotification = await runCommand(required(harness.commands, 'bazframe'), 'info', []);
    expect(infoNotification.message).toContain('Flat direct skills: 0');
    expect(infoNotification.message).toContain('Direct source units: 1');
    expect(infoNotification.message).toContain('Derived effective skills: 1');
    expect(infoNotification.message).toContain('alpha (provider/source:nested/alpha/SKILL.md)');
    expect(infoNotification.message).toContain('Source failures: 0');

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
    expect(reloaded).toEqual({
      skillPaths: [await realpath(betaDefinition), await realpath(alphaDefinition)]
    });
  });

  it('uses Pi-loaded folded and directory-fallback names in the artifact projection', async () => {
    const fixture = await activeFixture('source-name-parity');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    const fallbackDefinition = await fixture.directory.write(
      'provider-root/directory-fallback/SKILL.md',
      '---\ndescription: fallback\n---\n\nfallback\n'
    );
    const foldedDefinition = await fixture.directory.write(
      'provider-root/folded-directory/SKILL.md',
      '---\nname: >-\n  folded-name\ndescription: folded\n---\n\nfolded\n'
    );
    const descriptorPath = await fixture.directory.write(
      'bazframe-home/profiles/focused/source-units/provider/source.json',
      `${JSON.stringify({
        schemaVersion: 1,
        providerId: 'provider',
        sourceId: 'source',
        sourceRoot: provider
      })}\n`
    );
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
      skillPaths: [await realpath(fallbackDefinition), await realpath(foldedDefinition)]
    });
    const infoNotification = await runCommand(required(harness.commands, 'bazframe'), 'info', []);
    expect(infoNotification.message).toContain(
      'directory-fallback (provider/source:directory-fallback/SKILL.md)'
    );
    expect(infoNotification.message).toContain(
      'folded-name (provider/source:folded-directory/SKILL.md)'
    );
  });

  it('withholds an artifact source and normalizes every rejecting Pi diagnostic exactly', async () => {
    const fixture = await activeFixture('source-pi-rejection');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write(
      'provider-root/rejected/SKILL.md',
      '---\nname: rejected\ndescription: rejected\n---\n\nrejected\n'
    );
    await fixture.directory.write(
      'bazframe-home/profiles/focused/source-units/provider/source.json',
      `${JSON.stringify({
        schemaVersion: 1,
        providerId: 'provider',
        sourceId: 'source',
        sourceRoot: provider
      })}\n`
    );
    const harness = register(await loadArtifact(fixture.directory, 'reject'), []);
    const descriptorPath = fixture.directory.path(
      'bazframe-home/profiles/focused/source-units/provider/source.json'
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
    expect(infoNotification.message).toContain('Source failures: 2');
    expect(infoNotification.message).toContain(
      'provider/source:rejected/SKILL.md pi-loader[0]: first Pi diagnostic'
    );
    expect(infoNotification.message).toContain(
      'provider/source:rejected/SKILL.md pi-loader[1]: second Pi diagnostic'
    );
  });

  it('aliases a native collision from the derived skill original base and definition', async () => {
    const fixture = await activeFixture('source-alias');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    const definition = await fixture.directory.write(
      'provider-root/alpha/SKILL.md',
      '---\nname: alpha\ndescription: derived alpha\n---\n\nalpha\n'
    );
    await fixture.directory.write(
      'bazframe-home/profiles/focused/source-units/provider/source.json',
      `${JSON.stringify({
        schemaVersion: 1,
        providerId: 'provider',
        sourceId: 'source',
        sourceRoot: provider
      })}\n`
    );
    const runtimeCommands = [{ name: 'skill:alpha', source: 'skill' }];
    const harness = register(await loadArtifact(fixture.directory, true), runtimeCommands);
    const descriptorPath = fixture.directory.path(
      'bazframe-home/profiles/focused/source-units/provider/source.json'
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
    expect(alias).toContain(JSON.stringify(await realpath(definition)));
    expect(alias).toContain(JSON.stringify(await realpath(fixture.directory.path('provider-root/alpha'))));
  });

  it('fails a generated-alias collision visibly without replacing cache bytes or adding an alias', async () => {
    const fixture = await activeFixture('source-alias-collision');
    const provider = await realpath(await fixture.directory.mkdir('provider-root'));
    await fixture.directory.write(
      'provider-root/alpha/SKILL.md',
      '---\nname: alpha\ndescription: derived alpha\n---\n\nalpha\n'
    );
    await fixture.directory.write(
      'bazframe-home/profiles/focused/source-units/provider/source.json',
      `${JSON.stringify({
        schemaVersion: 1,
        providerId: 'provider',
        sourceId: 'source',
        sourceRoot: provider
      })}\n`
    );
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
      'bazframe-home/profiles/focused/source-units/provider/source.json'
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
        ...sourceInfoLines(),
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
        ...sourceInfoLines(),
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
      ...sourceInfoLines([
        ['alpha', fixture.directory.path('bazframe-home/profiles/focused/skills/alpha/SKILL.md')],
        ['zeta', fixture.directory.path('bazframe-home/profiles/focused/skills/zeta/SKILL.md')]
      ]),
      'Skills: alpha, alpha-x-bazframe, zeta, zeta-x-bazframe',
      'Aliases: alpha -> alpha-x-bazframe, zeta -> zeta-x-bazframe'
    ].join('\n'));
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
        ...sourceInfoLines(),
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
        ...sourceInfoLines(),
        'Skills: (none)'
      ].join('\n'),
      level: 'error'
    });
    expect(required(harness.events, 'input')({}, { hasUI: true, ui: { notify: () => undefined } }))
      .toEqual({ action: 'handled' });
  });
});

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
  loadSkills: false | true | 'reject' | 'parity' = false
): Promise<LoadedAdapter> {
  const source = await readFile(
    new URL('../../../artifacts/pi/bazframe.ts', import.meta.url),
    'utf8'
  );
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
          'export const VERSION = "0.82.0";',
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
            'export const VERSION = "0.82.0";',
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
            'export const VERSION = "0.82.0";',
            'export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;',
            'export const loadSkillsFromDir = ({ dir: directory }) => ({',
            '  skills: [{ name: basename(directory), filePath: join(directory, "SKILL.md"), baseDir: directory }],',
            '  diagnostics: []',
            '});',
            ''
          ].join('\n')
          : [
            'export const VERSION = "0.82.0";',
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

function sourceInfoLines(flatSkills: readonly (readonly [string, string])[] = []): string[] {
  return [
    `Flat direct skills: ${flatSkills.length}`,
    ...(flatSkills.length === 0
      ? ['  (none)']
      : flatSkills.map(([name, path]) => `  - ${name} (${path})`)),
    'Direct source units: 0',
    '  (none)',
    'Derived effective skills: 0',
    '  (none)',
    'Source failures: 0',
    '  (none)'
  ];
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
