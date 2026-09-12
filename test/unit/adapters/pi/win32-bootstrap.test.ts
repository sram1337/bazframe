import { symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsApplicationFixture, HOME, PI, PACKAGE, REPOSITORY } from '../../../helpers/windows-application-fixture.js';
import { createTempDirectory, type TempDirectory } from '../../../helpers/temp-directory.js';
import { installPiAdapter } from '../../../../src/adapters/pi/installer.js';
import { createBoundPiRuntimeServices } from '../../../../src/application/win32-application-services.js';
import { VERSION } from '../../../../src/cli/help.js';
import { runCliForInternalTesting } from '../../../../src/cli/run-cli.js';
const temporaries: TempDirectory[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const temporary of temporaries.splice(0)) await temporary.cleanup();
});

async function installed(options: { defaultPlatform?: 'win32' | 'linux'; piVersion?: string; nodeVersion?: string; missingReference?: boolean; bootstrapReader?: boolean } = {}) {
  const f = windowsApplicationFixture();
  const context = { bazframeHome: HOME, bazframeVersion: VERSION, environment: f.environment, userHome: 'C:\\boundary' };
  await installPiAdapter({ ...context, services: f.application.adapter!(context) });
  const temporary = await createTempDirectory(); temporaries.push(temporary);
  await symlink(resolve('node_modules'), temporary.path('node_modules'), 'dir');
  let source = f.nodes.get(PI + '\\extensions\\bazframe.ts')!.bytes!.toString();
  // Exact installer-produced bytes for internal-bootstrap tests. Default-dispatch tests
  // simulate only host platform/version and byte/import boundaries, never routing.
  if (options.defaultPlatform !== undefined) {
    source = 'import { effects as fixtureEffects } from "./effects.mjs";\n' + source
      .replace('const BAZFRAME_RUNTIME_PLATFORM = process.platform;', `const BAZFRAME_RUNTIME_PLATFORM = ${JSON.stringify(options.defaultPlatform)};`)
      .replace('effects.readFile ?? readBootstrapBytes', options.bootstrapReader ? 'effects.readFile ?? readBootstrapBytes' : 'effects.readFile ?? fixtureEffects.readFile')
      .replace('await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)', 'await fixtureEffects.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)')
      .replace('((url: string) => import(url))', 'fixtureEffects.importRuntime');
    // A successful Windows path must pass services; standalone POSIX reads are poisoned.
    source = source.replace('function resolveBazframeHome(): string {', 'function resolveBazframeHome(): string { throw new Error("Standalone state reader reached");');
  }
  if (options.piVersion !== undefined) source = source.replace('VERSION as PI_VERSION,', 'VERSION as UNUSED_PI_VERSION,').replace('type Skill =', `const PI_VERSION = ${JSON.stringify(options.piVersion)};\ntype Skill =`);
  if (options.nodeVersion !== undefined) source = source.replaceAll('process.versions.node', JSON.stringify(options.nodeVersion));
  if (options.missingReference) source = source.replace(/const WINDOWS_INSTALL_REFERENCE = .*;/u, 'const WINDOWS_INSTALL_REFERENCE = null;');
  const effectsModule = await temporary.write('effects.mjs', 'export const effects = {};\n');
  const module = await temporary.write('installed.mjs', ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  const artifact = await import(module);
  const notifications: string[] = [], handlers: string[] = [], reads: string[] = [];
  const ctx = { cwd: REPOSITORY, hasUI: true, ui: { notify: (text: string) => { notifications.push(text); } }, getSystemPromptOptions: () => ({ contextFiles: [] }), reload: vi.fn(async () => undefined) };
  const events = new Map<string, (event: object, context: typeof ctx) => unknown>();
  let command: { handler(args: string, context: typeof ctx): Promise<void> };
  const api = {
    on: (name: string, handler: (event: object, context: typeof ctx) => unknown) => { handlers.push(name); events.set(name, handler); },
    registerCommand: (name: string, definition: typeof command) => { handlers.push(name); command = definition; },
    getCommands: () => []
  };
  let imports = 0, native = 0;
  const effects = {
    readFile: async (path: string, maximum: number) => { reads.push(path); return (await f.backend.readStableFile(path, maximum)).bytes; },
    importRuntime: async (url: string) => {
      imports++; expect(decodeURIComponent(url)).toContain('win32-application-services.js');
      return { createBoundPiRuntimeServices: (options: object) => createBoundPiRuntimeServices({ ...f.options, ...options, backend: () => { native++; return f.backend; }, environment: f.environment, userHome: 'C:\\boundary' }) };
    }
  };
  const injected = (await import(effectsModule)).effects;
  Object.assign(injected, effects);
  return { f, artifact, api, effects, injected, handlers, reads, events, ctx, notifications, command: () => command, imports: () => imports, native: () => native };
}
const registration = ['session_start', 'resources_discover', 'input', 'before_agent_start', 'bazframe'];
const bindingPath = PI + '\\bazframe\\runtime.json';
const remedy = /Windows Pi runtime binding.*Reinstall.*adapter install/;

async function expectClosed(fixture: Awaited<ReturnType<typeof installed>>, reason: RegExp = remedy) {
  const { events, ctx } = fixture;
  expect(fixture.handlers).toEqual(registration);
  expect(events.get('input')!({}, ctx)).toEqual({ action: 'handled' });
  await events.get('session_start')!({}, ctx);
  expect(await events.get('resources_discover')!({ cwd: REPOSITORY }, ctx)).toBeUndefined();
  const prompt = events.get('before_agent_start')!({ systemPrompt: 'native', systemPromptOptions: { contextFiles: [] } }, ctx) as { systemPrompt: string };
  expect(prompt.systemPrompt).toMatch(reason);
  expect(prompt.systemPrompt).toContain('Do not act on the user request');
  expect(prompt.systemPrompt).not.toContain('bazframe_profile_instructions');
  await fixture.command().handler('info', ctx);
  expect(fixture.notifications.at(-1)).toMatch(reason);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(events.get('input')!({}, { ...ctx, hasUI: false })).toEqual({ action: 'handled' });
  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(reason));
  expect(process.exitCode).toBe(1);
  const readsBefore = [...fixture.reads];
  await fixture.command().handler('reload', ctx);
  expect(ctx.reload).toHaveBeenCalledTimes(1);
  // The old instance stays closed; only Pi reloading the extension retries bootstrap.
  expect(events.get('input')!({}, ctx)).toEqual({ action: 'handled' });
  expect(fixture.reads).toEqual(readsBefore);
  expect(fixture.handlers).toEqual(registration);
}

describe('exact installer-owned shipped Windows bootstrap (host/injected evidence)', () => {
  it('validates installed bytes before importing and constructs the actual shared factory', async () => {
    const fixture = await installed();
    const before = fixture.f.snapshot();
    await fixture.artifact.createWindowsBoundPiAdapterForInternalTesting(fixture.api, fixture.effects);
    expect(fixture.imports()).toBe(1);
    expect(fixture.native()).toBe(1);
    expect(fixture.handlers).toEqual(registration);
    expect(fixture.f.snapshot()).toBe(before);
  });
  it.each(['missing', 'arbitrary-record', 'malformed', 'invalid-utf8', 'oversized', 'package', 'runtime', 'native'])('refuses %s before import/native and default remains fail-closed', async (change) => {
    const fixture = await installed({ defaultPlatform: 'win32' }), { f } = fixture;
    if (change === 'missing') f.nodes.delete(bindingPath);
    if (change === 'arbitrary-record') f.file(bindingPath, '{"runtimePath":"C:\\\\foreign\\\\run.js"}');
    if (change === 'malformed') f.file(bindingPath, '{');
    if (change === 'invalid-utf8') f.nodes.get(bindingPath)!.bytes = Buffer.from([0xff]);
    if (change === 'oversized') f.file(bindingPath, ' '.repeat(64 * 1024 + 1));
    if (change === 'package') f.file(PACKAGE + '\\package.json', '{"name":"bazframe","version":"different"}');
    if (change === 'runtime') f.file(PACKAGE + '\\dist\\application\\win32-application-services.js', 'changed');
    if (change === 'native') f.file(PACKAGE + '\\artifacts\\native\\win32-x64-msvc\\bazframe-win32.node', 'changed');
    const before = f.snapshot();
    await expect(fixture.artifact.createWindowsBoundPiAdapterForInternalTesting(fixture.api, fixture.effects)).rejects.toThrow(remedy);
    expect(fixture.handlers).toEqual([]);
    await fixture.artifact.default(fixture.api);
    await expectClosed(fixture);
    expect(fixture.imports()).toBe(0); expect(fixture.native()).toBe(0);
    expect(f.snapshot()).toBe(before);
  });
  it('catches a missing code-owned reference without any binding reads', async () => {
    const fixture = await installed({ defaultPlatform: 'win32', missingReference: true });
    await fixture.artifact.default(fixture.api);
    await expectClosed(fixture);
    expect(fixture.reads).toEqual([]); expect(fixture.imports()).toBe(0);
  });
  it.each(['0.84.3', '0.84.4-beta.1', '0.85.0', 'not-a-version'])('checks Pi %s before binding I/O in default dispatch', async (piVersion) => {
    const fixture = await installed({ defaultPlatform: 'win32', piVersion });
    await fixture.artifact.default(fixture.api);
    await expectClosed(fixture, /requires a stable Pi 0.84.4/);
    expect(fixture.reads).toEqual([]); expect(fixture.imports()).toBe(0); expect(fixture.native()).toBe(0);
  });
  it.each(['20.20.0', '22.18.0'])('checks Node %s before binding I/O in default dispatch', async (nodeVersion) => {
    const fixture = await installed({ defaultPlatform: 'win32', nodeVersion });
    await fixture.artifact.default(fixture.api);
    await expectClosed(fixture, /requires Node 22.19/);
    expect(fixture.reads).toEqual([]); expect(fixture.imports()).toBe(0); expect(fixture.native()).toBe(0);
  });
  it.each([['0.84.4', '22.19.0'], ['0.85.1', '24.14.1']])('default awaits bound initialization once on Pi %s / Node %s', async (piVersion, nodeVersion) => {
    const fixture = await installed({ defaultPlatform: 'win32', piVersion, nodeVersion });
    const { f, events, ctx } = fixture;
    for (const action of ['add', 'use']) {
      expect(await runCliForInternalTesting(['profile', action, 'work'], { application: f.application, environment: f.environment, cwd: () => REPOSITORY, userHome: 'C:\\boundary', writeStdout: () => undefined, writeStderr: () => undefined })).toBe(0);
    }
    const before = f.snapshot();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    fixture.injected.readFile = async (path: string, maximum: number) => { await pending; return fixture.effects.readFile(path, maximum); };
    let settled = false;
    const loading = fixture.artifact.default(fixture.api).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); expect(fixture.handlers).toEqual([]); expect(fixture.imports()).toBe(0);
    release(); await loading;
    expect(fixture.reads).toEqual([bindingPath, PACKAGE + '\\package.json', PACKAGE + '\\dist\\application\\win32-application-services.js', PACKAGE + '\\artifacts\\native\\win32-x64-msvc\\bazframe-win32.node']);
    expect(fixture.imports()).toBe(1); expect(fixture.native()).toBe(1);
    await events.get('session_start')!({}, ctx);
    await events.get('resources_discover')!({ cwd: REPOSITORY }, ctx);
    expect(events.get('input')!({}, ctx)).toEqual({ action: 'continue' });
    const prompt = events.get('before_agent_start')!({ systemPrompt: 'native', systemPromptOptions: { contextFiles: [] } }, ctx) as { systemPrompt: string };
    expect(prompt.systemPrompt).toContain('bazframe_profile_instructions');
    await fixture.command().handler('info', ctx);
    expect(fixture.notifications.at(-1)).toContain('Profile: work');
    await fixture.command().handler('reload', ctx);
    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(fixture.handlers).toEqual(registration);
    expect(f.snapshot()).toBe(before);
  });
  it.each(['changed-read', 'import', 'native-factory'])('keeps failed %s initialization active as closed handlers', async (failure) => {
    const fixture = await installed({ defaultPlatform: 'win32' });
    if (failure === 'changed-read') fixture.injected.readFile = async () => { throw new Error('Install-owned runtime file changed during validation.'); };
    else fixture.injected.importRuntime = async () => {
      if (failure === 'import') throw new Error('Runtime import failed');
      return { createBoundPiRuntimeServices: () => { throw new Error('Native contract/target/ABI/version unavailable'); } };
    };
    const before = fixture.f.snapshot();
    await fixture.artifact.default(fixture.api);
    await expectClosed(fixture);
    expect(fixture.f.snapshot()).toBe(before);
  });
  it.each(['not-file', 'hardlink', 'oversized', 'short', 'growth', 'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'read-error'])('actual bounded bootstrap reader refuses %s and closes before import', async (failure) => {
    const fixture = await installed({ defaultPlatform: 'win32', bootstrapReader: true });
    const data = fixture.f.nodes.get(bindingPath)!.bytes!;
    const metadata = { isFile: () => failure !== 'not-file', nlink: failure === 'hardlink' ? 2n : 1n, size: failure === 'oversized' ? 65537n : BigInt(data.length), dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n };
    let stats = 0;
    const close = vi.fn(async () => undefined);
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (failure === 'read-error') throw new Error('read failed');
      const bytes = failure === 'short' ? data.subarray(0, data.length - 1) : failure === 'growth' ? Buffer.concat([data, Buffer.from('x')]) : data;
      return { bytesRead: bytes.copy(buffer, offset, position, position + length) };
    });
    fixture.injected.open = vi.fn(async (path: string) => {
      expect(path).toBe(bindingPath);
      return {
        stat: async () => {
          stats++;
          const key = failure as 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs';
          return stats > 1 && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].includes(failure) ? { ...metadata, [key]: metadata[key] + 1n } : metadata;
        }, read, close
      };
    });
    const before = fixture.f.snapshot();
    await fixture.artifact.default(fixture.api);
    await expectClosed(fixture);
    expect(fixture.injected.open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    if (['not-file', 'hardlink', 'oversized'].includes(failure)) expect(read).not.toHaveBeenCalled();
    expect(fixture.imports()).toBe(0); expect(fixture.native()).toBe(0);
    expect(fixture.f.snapshot()).toBe(before);
  });
  it('keeps non-Windows registration synchronous with no binding/import/native work', async () => {
    const fixture = await installed({ defaultPlatform: 'linux' });
    // No events here: existing artifact tests exercise the unchanged standalone reader.
    const loading = fixture.artifact.default(fixture.api);
    expect(fixture.handlers).toEqual(registration);
    await loading;
    expect(fixture.reads).toEqual([]); expect(fixture.imports()).toBe(0); expect(fixture.native()).toBe(0);
  });
});
