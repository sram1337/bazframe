import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWindowsPiAdapterServices } from '../../../../src/adapters/pi/win32-adapter-services.js';
import { windowsApplicationFixture, HOME, PI, PACKAGE } from '../../../helpers/windows-application-fixture.js';
import { inspectPiAdapter, installPiAdapter, uninstallPiAdapter } from '../../../../src/adapters/pi/installer.js';
import { VERSION } from '../../../../src/cli/help.js';
import { decodePiRuntimeBinding } from '../../../../src/adapters/pi/runtime-binding.js';

vi.mock('node:url', async (original) => ({ ...await original<typeof import('node:url')>(), fileURLToPath: vi.fn((...args: Parameters<typeof fileURLToPath>) => actualFileURLToPath(...args)) }));
const { fileURLToPath: actualFileURLToPath } = await vi.importActual<typeof import('node:url')>('node:url');
afterEach(() => vi.restoreAllMocks());

function options(f: ReturnType<typeof windowsApplicationFixture>) {
  const context = { bazframeHome: HOME, bazframeVersion: VERSION, environment: f.environment, userHome: 'C:\\boundary' };
  return { ...context, services: f.application.adapter!(context) };
}
const extension = PI + '\\extensions\\bazframe.ts', binding = PI + '\\bazframe\\runtime.json', manifest = HOME + '\\adapters\\pi.json';
describe('Windows installer/binding/retained discovery (concrete shared engine)', () => {
  it('uses the actual Windows directory file-URL spelling without a packageRoot override and inspection never bootstraps', async () => {
    const f = windowsApplicationFixture();
    const rootFromUrl = actualFileURLToPath(new URL('file:///C:/boundary/package/'), { windows: true });
    expect(rootFromUrl).toBe(PACKAGE + '\\');
    vi.mocked(fileURLToPath).mockReturnValueOnce(rootFromUrl);
    const context = { ...options(f), services: createWindowsPiAdapterServices(f.backend, f.environment, 'C:\\boundary', { stateIo: f.io, lockIo: f.io }) };
    expect(fileURLToPath).toHaveBeenCalledWith(expect.any(URL));
    const before = f.snapshot();
    expect((await inspectPiAdapter(context)).state).toBe('missing');
    expect(f.snapshot()).toBe(before);
    await installPiAdapter(context);
    const record = decodePiRuntimeBinding(f.nodes.get(binding)!.bytes!.toString());
    expect(record.packageRoot).toBe(PACKAGE);
    for (const root of [PACKAGE + '\\', 'C:/boundary/package', 'C:boundary\\package', '\\\\server\\share\\package', PACKAGE + '\\..\\package']) {
      expect(() => decodePiRuntimeBinding(JSON.stringify({ ...record, packageRoot: root }))).toThrow();
    }
    const installed = f.snapshot();
    expect((await inspectPiAdapter(context)).state).toBe('current');
    expect(f.snapshot()).toBe(installed);
    await uninstallPiAdapter(context);
    expect(f.nodes.has(extension)).toBe(false);
  });
  it('observes missing/current/adoptable/managed-missing and binds only its exact package independently of runtime home', async () => {
    const f = windowsApplicationFixture(), context = options(f), before = f.snapshot();
    expect((await inspectPiAdapter(context)).state).toBe('missing'); expect(f.snapshot()).toBe(before);
    await installPiAdapter(context);
    const installed = f.nodes.get(extension)!.bytes!.toString(), record = JSON.parse(f.nodes.get(binding)!.bytes!.toString());
    expect(installed).toContain('const WINDOWS_INSTALL_REFERENCE = {');
    expect(record.packageRoot).toBe(PACKAGE); expect(JSON.stringify(record)).not.toContain(HOME.replaceAll('\\', '\\\\'));
    expect((await inspectPiAdapter(context)).state).toBe('current');
    const saved = f.nodes.get(manifest)!; f.nodes.delete(manifest);
    expect((await inspectPiAdapter(context)).state).toBe('adoptable');
    await installPiAdapter(context);
    f.nodes.delete(extension);
    expect((await inspectPiAdapter(context)).state).toBe('managed-missing');
    await installPiAdapter(context);
    expect((await inspectPiAdapter(context)).state).toBe('current');
    expect(saved.bytes?.equals(f.nodes.get(manifest)!.bytes!)).toBe(true);
  });
  it.each(['missing-binding', 'changed-binding', 'changed-runtime', 'changed-extension'])('is not ready after %s and converges only through explicit installation', async (change) => {
    const f = windowsApplicationFixture(), context = options(f); await installPiAdapter(context);
    if (change === 'missing-binding') f.nodes.delete(binding);
    if (change === 'changed-binding') f.file(binding, '{}');
    if (change === 'changed-runtime') f.file(PACKAGE + '\\dist\\application\\win32-application-services.js', 'changed version bytes');
    if (change === 'changed-extension') f.file(extension, f.nodes.get(extension)!.bytes!.toString() + '\n// drift');
    const before = f.snapshot(), inspection = await inspectPiAdapter(context);
    expect(inspection.state).not.toBe('current'); expect(f.snapshot()).toBe(before);
    if (inspection.state === 'drifted') await expect(installPiAdapter(context)).rejects.toThrow();
    await installPiAdapter(context, true);
    expect((await inspectPiAdapter(context)).state).toBe('current');
  });
  it('refuses foreign loadable bytes even with force and never repairs independently unsafe Pi ancestry', async () => {
    const f = windowsApplicationFixture(); f.file(extension, 'foreign extension');
    await expect(installPiAdapter(options(f), true)).rejects.toThrow(); expect(f.nodes.get(extension)!.bytes!.toString()).toBe('foreign extension');
    f.nodes.delete(extension); f.reparse(PI + '\\extensions');
    await expect(installPiAdapter(options(f), true)).rejects.toThrow(); expect(f.nodes.get(PI + '\\extensions')!.kind).toBe('reparse');
  });
  it('preserves sharing-denied and interrupted detach evidence without claiming uninstalled', async () => {
    const f = windowsApplicationFixture(), context = options(f); await installPiAdapter(context);
    const rename = f.backend.renameFileNoReplace;
    f.backend.renameFileNoReplace = async (parent, source, target) => { if (source === 'bazframe.ts') throw new Error('sharing violation'); return rename(parent, source, target); };
    await expect(uninstallPiAdapter(context)).rejects.toThrow(/sharing|effect|policy/);
    expect(f.nodes.has(extension)).toBe(true);
    f.backend.renameFileNoReplace = async (parent, source, target) => { await rename(parent, source, target); if (source === 'bazframe.ts') throw new Error('after rename'); };
    await uninstallPiAdapter(context);
    expect(f.nodes.has(extension)).toBe(false);
    expect([...f.nodes.keys()].filter((path) => path.startsWith(PI + '\\extensions\\')).every((path) => path.endsWith('.retained'))).toBe(true);
  });
  it('strictly rejects arbitrary binding path fields and missing/extra keys', () => {
    expect(() => decodePiRuntimeBinding(JSON.stringify({ schemaVersion: 1, runtimePath: 'C:\\foreign\\run.js' }))).toThrow();
  });
  it.each(['managed-missing', 'managed-outdated'])('requires force for corrupt binding even when %s', async (state) => {
    const f = windowsApplicationFixture(), context = options(f); await installPiAdapter(context);
    if (state === 'managed-missing') f.nodes.delete(extension);
    else f.file(PACKAGE + '\\dist\\application\\win32-application-services.js', 'new runtime');
    for (const text of ['{"foreign":true}', JSON.stringify({ ...JSON.parse(f.nodes.get(binding)!.bytes!.toString()), runtimeSha256: 'a'.repeat(64) })]) {
      f.file(binding, text);
      expect((await inspectPiAdapter(context)).state).toBe('drifted');
      await expect(installPiAdapter(context)).rejects.toThrow(/changed|force/);
      await expect(uninstallPiAdapter(context)).rejects.toThrow(/changed|preserved/);
      expect(f.nodes.get(binding)!.bytes!.toString()).toBe(text);
    }
    await installPiAdapter(context, true); expect((await inspectPiAdapter(context)).state).toBe('current');
  });
  it('updates a manifest-proved intact prior binding without force', async () => {
    const f = windowsApplicationFixture(), context = options(f); await installPiAdapter(context);
    f.file(PACKAGE + '\\dist\\application\\win32-application-services.js', 'new runtime');
    expect((await inspectPiAdapter(context)).state).toBe('managed-outdated');
    await installPiAdapter(context); expect((await inspectPiAdapter(context)).state).toBe('current');
  });
  it.each(['candidate', 'detach'])('checks both lock capabilities adjacent to the %s effect', async (phase) => {
    const f = windowsApplicationFixture(), context = options(f);
    if (phase === 'detach') await installPiAdapter(context);
    let expired = false;
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (...args) => { const value = acquire(...args); if (args[0].startsWith(PI) && value.state === 'acquired') { const assert = value.capability.assertHeld; value.capability.assertHeld = () => { assert(); if (expired) throw new Error('Pi lock expired'); }; } return value; };
    if (phase === 'candidate') { const write = f.io.writeExistingFile; f.io.writeExistingFile = async (path, bytes) => { await write(path, bytes); if (path.startsWith(PI + '\\extensions\\resource-')) expired = true; }; }
    else { const read = f.backend.readStableFile; let reads = 0; f.backend.readStableFile = async (...args) => { const value = await read(...args); if (args[0] === extension && ++reads === 2) expired = true; return value; }; }
    await expect(phase === 'candidate' ? installPiAdapter(context) : uninstallPiAdapter(context)).rejects.toThrow();
    expect(expired).toBe(true); expect(f.nodes.has(extension)).toBe(phase === 'detach');
  });

});
