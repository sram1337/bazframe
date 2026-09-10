import { symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { windowsApplicationFixture, HOME, PI, PACKAGE } from '../../../helpers/windows-application-fixture.js';
import { createTempDirectory, type TempDirectory } from '../../../helpers/temp-directory.js';
import { installPiAdapter } from '../../../../src/adapters/pi/installer.js';
import { createBoundPiRuntimeServices } from '../../../../src/application/win32-application-services.js';
import { VERSION } from '../../../../src/cli/help.js';
const temporaries: TempDirectory[] = [];
afterEach(async () => { for (const temporary of temporaries.splice(0)) await temporary.cleanup(); });

async function installed() {
  const f = windowsApplicationFixture();
  const context = { bazframeHome: HOME, bazframeVersion: VERSION, environment: f.environment, userHome: 'C:\\boundary' };
  await installPiAdapter({ ...context, services: f.application.adapter!(context) });
  const temporary = await createTempDirectory(); temporaries.push(temporary);
  await symlink(resolve('node_modules'), temporary.path('node_modules'), 'dir');
  // Transpile exact installer-produced bytes, without modifying the gate or reference.
  const source = f.nodes.get(PI + '\\extensions\\bazframe.ts')!.bytes!.toString();
  const module = await temporary.write('installed.mjs', ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  const artifact = await import(module);
  let imports = 0; const handlers: string[] = [];
  const api = { on: (name: string) => { handlers.push(name); }, registerCommand: (name: string) => { handlers.push(name); }, getCommands: () => [] };
  const effects = {
    readFile: async (path: string, maximum: number) => (await f.backend.readStableFile(path, maximum)).bytes,
    importRuntime: async (url: string) => {
      imports++; expect(decodeURIComponent(url)).toContain('win32-application-services.js');
      // Module-import boundary only: execute the real packaged factory with native/I/O receipts.
      return { createBoundPiRuntimeServices: (options: object) => createBoundPiRuntimeServices({ ...f.options, ...options, environment: f.environment, userHome: 'C:\\boundary' }) };
    }
  };
  return { f, artifact, api, effects, handlers, imports: () => imports };
}
describe('exact installer-owned shipped Windows bootstrap', () => {
  it('validates installed bytes before importing and constructs the actual shared factory', async () => {
    const fixture = await installed();
    const before = fixture.f.snapshot();
    await fixture.artifact.createWindowsBoundPiAdapterForInternalTesting(fixture.api, fixture.effects);
    expect(fixture.imports()).toBe(1);
    expect(fixture.handlers).toEqual(['session_start', 'resources_discover', 'input', 'before_agent_start', 'bazframe']);
    expect(fixture.f.snapshot()).toBe(before);
  });
  it.each(['missing', 'arbitrary-record', 'package', 'runtime', 'native'])('refuses %s before any code import with actionable guidance', async (change) => {
    const fixture = await installed(), { f } = fixture;
    if (change === 'missing') f.nodes.delete(PI + '\\bazframe\\runtime.json');
    if (change === 'arbitrary-record') f.file(PI + '\\bazframe\\runtime.json', '{"runtimePath":"C:\\\\foreign\\\\run.js"}');
    if (change === 'package') f.file(PACKAGE + '\\package.json', '{"name":"bazframe","version":"different"}');
    if (change === 'runtime') f.file(PACKAGE + '\\dist\\application\\win32-application-services.js', 'changed');
    if (change === 'native') f.file(PACKAGE + '\\artifacts\\native\\win32-x64-msvc\\bazframe-win32.node', 'changed');
    await expect(fixture.artifact.createWindowsBoundPiAdapterForInternalTesting(fixture.api, fixture.effects)).rejects.toThrow(/Reinstall.*adapter install/);
    expect(fixture.imports()).toBe(0); expect(fixture.handlers).toEqual([]);
  });
});
