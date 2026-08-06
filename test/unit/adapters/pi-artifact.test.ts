import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
        'Skills: alpha, zeta'
      ].join('\n'),
      level: 'info'
    });

    let incompatibleMessage = '';
    await required(harness.commands, 'bazframe').handler('info', {
      getSystemPromptOptions: () => { throw new Error('missing structured context'); },
      ui: { notify: (message: string) => { incompatibleMessage = message; } }
    });
    expect(incompatibleMessage).toBe('Profile: (none)\nContext: (none)\nSkills: alpha, zeta');
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
      'Skills: (none)'
    ].join('\n'));
    expect(notification.message).not.toContain('Collisions:');
  });

  it('loads profile context and skill resources outside Git under global enable', async () => {
    const fixture = await activeFixture('outside-enabled', ['profile-skill'], false);
    const harness = register(await loadArtifact(fixture.directory, true), []);

    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));
    const resources = await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
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

  it('keeps globally disabled non-Git directories native', async () => {
    const fixture = await activeFixture('outside-disabled', ['profile-skill'], false);
    await fixture.directory.write(
      'bazframe-home/global.json',
      `${JSON.stringify({ schemaVersion: 1, disabled: true })}\n`
    );
    const harness = register(await loadArtifact(fixture.directory, true), []);

    await required(harness.events, 'session_start')({}, sessionContext(fixture.repository));
    expect(await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    )).toBeUndefined();
    expect(required(harness.events, 'before_agent_start')(
      {
        systemPrompt: 'native prompt',
        systemPromptOptions: { contextFiles: [{ path: '/pi/AGENTS.md' }] }
      },
      { hasUI: false, ui: { notify: () => undefined } }
    )).toBeUndefined();
    expect((await runCommand(required(harness.commands, 'bazframe'), 'info', ['/pi/AGENTS.md'])).message)
      .toBe('Profile: (none)\nContext:\n  (pi) /pi/AGENTS.md\nSkills: (none)');
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
      .toBe('Profile: (none)\nContext:\n  (pi) /pi/AGENTS.md\nSkills: (none)');
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
    await required(harness.events, 'resources_discover')(
      { cwd: fixture.repository },
      { hasUI: false, ui: { notify: () => undefined } }
    );
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
      'Skills: alpha, alpha-x-bazframe, zeta, zeta-x-bazframe',
      'Collisions: alpha -> alpha-x-bazframe, zeta -> zeta-x-bazframe'
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
      message: 'Profile: (none)\nContext:\n  (pi) /pi/AGENTS.md\nSkills: (none)',
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
      message: 'Profile: (none)\nContext: (none)\nSkills: (none)',
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

async function loadArtifact(directory: TempDirectory, loadSkills = false): Promise<LoadedAdapter> {
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
    loadSkills
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

function required<T>(map: Map<string, T>, name: string): T {
  const value = map.get(name);
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
