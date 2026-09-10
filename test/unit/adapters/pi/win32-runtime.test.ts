import { createWindowsApplicationServices } from '../../../../src/application/win32-application-services.js';
import { inspectStatus } from '../../../../src/status/status.js';
import { VERSION } from '../../../../src/cli/help.js';
import { readlink } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { windowsApplicationFixture, HOME, PI, REPOSITORY } from '../../../helpers/windows-application-fixture.js';
import { runCliForInternalTesting } from '../../../../src/cli/run-cli.js';

vi.mock('node:fs/promises', async (original) => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, readlink: vi.fn(actual.readlink) }; });

async function command(f: ReturnType<typeof windowsApplicationFixture>, argv: string[], expectedStatus = 0) {
  vi.mocked(readlink).mockImplementation(async (path) => f.options.readLinkPath(String(path)));
  let error = '', output = '';
  const status = await runCliForInternalTesting(argv, { application: f.application, environment: f.environment, cwd: () => REPOSITORY, userHome: 'C:\\boundary', writeStdout: (text) => { output += text; }, writeStderr: (text) => { error += text; } });
  expect(status, `${argv.join(' ')}: ${error}`).toBe(expectedStatus);
  return output;
}
async function adapter(f: ReturnType<typeof windowsApplicationFixture>, occupied = ['demo']) {
  const url = new URL('../../../../artifacts/pi/bazframe.ts', import.meta.url).href;
  const artifact = await import(url);
  const notifications: string[] = [], handlers = new Map<string, (event: unknown, context: typeof ctx) => unknown>();
  let registered: { handler: (args: string, context: typeof ctx) => Promise<void> } | undefined;
  let reloaded = false;
  const commands = occupied.map((name) => ({ name: `skill:${name}`, source: 'skill' }));
  const ctx = { cwd: REPOSITORY, hasUI: true, ui: { notify: (message: string) => { notifications.push(message); }, setStatus() {} }, getSystemPromptOptions: () => ({ contextFiles: [] as Array<{ path: string; content: string }> }), reload: async () => { await Promise.resolve(); reloaded = true; } };
  artifact.createBazframePiAdapterForInternalTesting({ on: (name: string, handler: (event: unknown, context: typeof ctx) => unknown) => handlers.set(name, handler), registerCommand: (_name: string, definition: typeof registered) => { registered = definition; }, getCommands: () => commands }, f.runtime());
  return { handlers, notifications, ctx, commands, registered: () => registered!, reloaded: () => reloaded };
}
describe('actual shipped Pi handlers with concrete shared Windows runtime', () => {
  it('connects bounded local/derived metadata, protected collision wrappers, prompts, info, policy and awaited reload', async () => {
    const f = windowsApplicationFixture();
    f.file('C:\\boundary\\source\\demo\\SKILL.md', '---\nname: demo\ndescription: "original description"\ndisable-model-invocation: true\n---\nOriginal body\n');
    f.file('C:\\boundary\\library\\nested\\SKILL.md', '---\nname: nested\ndescription: Derived description\n---\nDerived body\n');
    f.file(PI + '\\AGENTS.md', 'Global context body\n');
    await command(f, ['profile', 'add', 'work']);
    await command(f, ['profile', 'use', 'work']);
    await command(f, ['skill', 'add', 'C:\\boundary\\source\\demo']);
    await command(f, ['profile', 'skill', 'add', 'demo']);
    await command(f, ['library', 'add', 'C:\\boundary\\library']);
    await command(f, ['profile', 'library', 'add', 'library']);
    const runtime = await f.runtime().loadProfile(HOME);
    expect(runtime.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'demo', description: 'original description', disableModelInvocation: true }), expect.objectContaining({ name: 'nested', description: 'Derived description' })]));
    const pi = await adapter(f);
    await pi.handlers.get('session_start')!({}, pi.ctx);
    const resources = await pi.handlers.get('resources_discover')!({ cwd: REPOSITORY }, pi.ctx) as { skillPaths: string[] };
    expect(resources, pi.notifications.join('\n')).toBeDefined();
    expect(resources.skillPaths).toContain(HOME + '\\adapter-cache\\pi\\skill-aliases\\work\\demo-x-bazframe\\SKILL.md');
    const alias = f.nodes.get(resources.skillPaths.find((path) => path.includes('demo-x-bazframe'))!)!.bytes!.toString();
    expect(alias).toContain('description: "original description"'); expect(alias).toContain('disable-model-invocation: true');
    expect(alias).toContain(JSON.stringify('C:\\boundary\\source\\demo\\SKILL.md'));
    expect(alias).toContain(JSON.stringify('C:\\boundary\\source\\demo'));
    const prompt = pi.handlers.get('before_agent_start')!({ systemPrompt: 'native prompt', systemPromptOptions: { contextFiles: [] } }, pi.ctx) as { systemPrompt: string };
    expect(prompt.systemPrompt.startsWith('native prompt\n\n')).toBe(true);
    expect(prompt.systemPrompt).toContain('Global context body\n');
    expect(prompt.systemPrompt).toContain('AGENTS.md');
    pi.commands.push({ name: 'skill:demo-x-bazframe', source: 'skill' });
    await pi.registered().handler('info', pi.ctx);
    expect(pi.notifications.join('\n')).toContain('demo -> demo-x-bazframe');
    await pi.registered().handler('reload', pi.ctx); expect(pi.reloaded()).toBe(true);
    await command(f, ['global', 'disable']);
    expect(await pi.handlers.get('resources_discover')!({ cwd: REPOSITORY }, pi.ctx)).toBeUndefined();
    expect(pi.handlers.get('before_agent_start')!({ systemPrompt: 'native' }, pi.ctx)).toBeUndefined();
  });
  it('withholds the complete profile projection on generated alias collision', async () => {
    const f = windowsApplicationFixture(); f.file('C:\\boundary\\source\\demo\\SKILL.md', '---\nname: demo\ndescription: Demo\n---\n');
    await command(f, ['profile', 'add', 'work']); await command(f, ['profile', 'use', 'work']);
    await command(f, ['skill', 'add', 'C:\\boundary\\source\\demo']); await command(f, ['profile', 'skill', 'add', 'demo']);
    const pi = await adapter(f, ['demo', 'demo-x-bazframe']);
    expect(await pi.handlers.get('resources_discover')!({ cwd: REPOSITORY }, pi.ctx)).toBeUndefined();
    expect(pi.notifications.join('\n')).toContain('also collides');
    expect(pi.handlers.get('before_agent_start')!({ systemPrompt: 'native' }, pi.ctx)).toEqual({ systemPrompt: expect.stringContaining('failed before agent start') });
  });
  it.each(['library', 'package'] as const)('withholds a whole already-active %s identically in imported runtime, CLI prose/JSON lists, status and actual Pi handlers', async (kind) => {
    const f = windowsApplicationFixture(); f.file('C:\\boundary\\source\\local\\SKILL.md', '---\nname: local\ndescription: Imported local\n---\n');
    await command(f, ['profile', 'add', 'work']); await command(f, ['profile', 'use', 'work']);
    await command(f, ['skill', 'add', 'C:\\boundary\\source\\local']); await command(f, ['profile', 'skill', 'add', 'local']);
    await command(f, ['profile', 'export', '--output', 'C:\\boundary\\work.zip']); await command(f, ['profile', 'import', 'C:\\boundary\\work.zip', '--yes']); await command(f, ['profile', 'use', 'work-1']);
    expect(f.nodes.has(HOME + '\\profiles\\work-1\\skills')).toBe(false);
    const root = 'C:\\boundary\\conflicting', namespace = kind === 'library' ? 'libraries' : 'packages';
    const prepareBytes = (destination: string) => {
      f.file(destination + '\\local\\SKILL.md', '---\nname: local\ndescription: Conflict\n---\n');
      f.file(destination + '\\other\\SKILL.md', '---\nname: other\ndescription: Withheld too\n---\n');
    };
    if (kind === 'library') prepareBytes(root);
    else {
      f.file(root + '\\bazframe-package.json', JSON.stringify({ schemaVersion: 1, build: ['node', 'build.js'], artifactRoot: 'dist', skillsRoot: '.' }));
      // Inject only executable/child effects; real preparation publishes and validates the snapshot.
      f.application = createWindowsApplicationServices({ ...f.options,
        resolvePackageExecutable: async (argv) => ({ executable: argv[0]!, args: argv.slice(1) }),
        packageProcessRunner: async () => { prepareBytes(root + '\\dist'); return { exitCode: 0, signal: null }; }
      });
    }
    await command(f, [kind, 'add', root]);
    await command(f, ['profile', 'add', 'ordinary']); await command(f, ['profile', kind, 'add', 'conflicting', '--profile', 'ordinary']);
    // Exact valid older/adverse reference state, not fixture repair or immutable-content alteration.
    f.file(`${HOME}\\profiles\\work-1\\${namespace}\\conflicting.json`, f.nodes.get(`${HOME}\\profiles\\ordinary\\${namespace}\\conflicting.json`)!.bytes!.toString());
    const before = JSON.stringify([...f.nodes]), writesBefore = [...f.writes];
    const runtime = await f.runtime().loadProfile(HOME); expect(runtime.skills.map((skill) => skill.name)).toEqual(['local']); expect(runtime.derivedSkills).toEqual([]);
    const status = await inspectStatus({ bazframeHome: HOME, bazframeVersion: VERSION, environment: f.environment, cwd: REPOSITORY, application: f.application });
    expect(status.profile).toMatchObject({ state: 'ready', flatSkillCount: 0, derivedSkillCount: 0, collectionDiagnostics: expect.arrayContaining([expect.objectContaining({ category: 'duplicate-name' })]) });
    expect(status.correctiveActions.find((action) => action.id === 'collections')!.message).toContain(`bazframe profile ${kind} list`);
    expect(await command(f, ['status'], 3)).toContain('duplicate-name');
    const statusJson = JSON.parse(await command(f, ['status', '--json'], 3));
    expect(statusJson).toMatchObject({ schemaVersion: 1, ok: true, result: { profile: { flatSkillCount: 0, collectionReferenceCount: 1, derivedSkills: [], diagnostics: [expect.objectContaining({ category: 'duplicate-name', kind })] } } });
    const pi = await adapter(f, []); const resources = await pi.handlers.get('resources_discover')!({ cwd: REPOSITORY }, pi.ctx) as { skillPaths: string[] };
    expect(resources.skillPaths).toEqual([runtime.skills[0]!.filePath]); expect(pi.notifications.join('\n')).toContain('duplicate-name');
    const prose = await command(f, ['profile', kind, 'list']);
    expect.soft(prose).toContain('Effective Skills:\n  (none)');
    expect.soft(prose).toContain('duplicate-name');
    const listing = JSON.parse(await command(f, ['profile', kind, 'list', '--json']));
    expect.soft(listing).toMatchObject({ schemaVersion: 1, ok: true, command: `profile.${kind}.list`, result: {
      profileId: 'work-1', kind, references: [expect.objectContaining({ kind, id: 'conflicting' })],
      effectiveSkills: [], diagnostics: [expect.objectContaining({ category: 'duplicate-name', kind, id: 'conflicting', name: 'local' })], importedReferences: []
    } });
    expect(JSON.stringify([...f.nodes])).toBe(before); expect(f.writes).toEqual(writesBefore);
  });

});
