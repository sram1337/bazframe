import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { createWindowsApplicationServices, createBoundPiRuntimeServices } from '../../src/application/win32-application-services.js';
import type { BazframeWin32EditorBackend } from '../../src/core/win32-native.js';
import { windowsProvisioningFixture } from './windows-provisioning-fixture.js';
import { VERSION } from '../../src/cli/help.js';

export const HOME = 'C:\\boundary\\home', PI = 'C:\\boundary\\pi', PACKAGE = 'C:\\boundary\\package', REPOSITORY = 'C:\\boundary\\repo';
/** Only native receipts, byte I/O, executable/process boundaries are simulated. */
export function windowsApplicationFixture() {
  const f = windowsProvisioningFixture();
  const file = (path: string, contents: string) => { const parent = win32.dirname(path); directories(parent); f.file(path, contents); };
  function directories(path: string) { if (f.nodes.has(path)) return; directories(win32.dirname(path)); f.directory(path); }
  for (const root of [PI, PACKAGE, REPOSITORY]) directories(root);
  file(win32.join(PACKAGE, 'package.json'), JSON.stringify({ name: 'bazframe', version: VERSION }));
  file(win32.join(PACKAGE, 'artifacts', 'pi', 'bazframe.ts'), readFileSync(new URL('../../artifacts/pi/bazframe.ts', import.meta.url), 'utf8'));
  file(win32.join(PACKAGE, 'dist', 'application', 'win32-application-services.js'), 'export const fixture = true;\n');
  file(win32.join(PACKAGE, 'artifacts', 'native', 'win32-x64-msvc', 'bazframe-win32.node'), 'native integrity fixture, never executed');
  const editor: BazframeWin32EditorBackend = { inspectEditorTarget(root, targetPath) {
    const entry = f.backend.inspectPath(targetPath);
    return { root: f.backend.inspectPath(root), parent: f.backend.inspectPath(root), entryPath: entry.canonicalPath, entryObject: entry.object, target: entry, targetPath };
  } };
  const backend = Object.assign(f.backend, editor);
  const environment = { BAZFRAME_HOME: HOME, PI_CODING_AGENT_DIR: PI, USERPROFILE: 'C:\\boundary', VISUAL: 'editor.exe', PATH: 'C:\\tools' };
  const processes: string[][] = [];
  const options = { backend: () => backend, packageRoot: PACKAGE, parse: parseFrontmatter, environment,
    storageIo: f.io, stateIo: f.io, lockIo: f.io, journal: { io: f.io },
    zip: { temporaryRoot: 'C:\\boundary', io: { async *readInput(path: string) { yield f.nodes.get(path)!.bytes!; }, async writeExistingFile(path: string, chunks: AsyncIterable<Uint8Array>) { const data: Buffer[] = []; for await (const chunk of chunks) data.push(Buffer.from(chunk)); await f.io.writeExistingFile(path, Buffer.concat(data)); }, rename: f.io.rename } },
    readLinkPath: async (path: string) => { const link = backend.inspectMembershipLink(path); return `C:\\${link.normalizedTarget.slice(link.volume.canonicalVolumeGuidPath.length)}`; },
    executableEffects: { executable: async (path: string) => ['C:\\tools\\git.exe', 'C:\\tools\\editor.exe', 'C:\\tools\\pi.exe'].includes(path), canonical: async (path: string) => path, readShim: async () => { throw new Error('no shims'); } },
    resolveExecutable: async () => 'C:\\tools\\git.exe',
    process: async (_executable: string, args: readonly string[]) => { processes.push([...args]); return { status: 0, stdout: REPOSITORY + '\n', stderr: '', stdoutBytes: Buffer.from(REPOSITORY + '\n'), stderrBytes: Buffer.alloc(0) }; }
  };
  const application = createWindowsApplicationServices(options);
  return { ...f, file, directories, application, backend, environment, processes, options,
    runtime: () => createBoundPiRuntimeServices({ ...options, userHome: 'C:\\boundary' }) };
}
