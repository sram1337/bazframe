import { ensureWindowsPrivateDirectoryPath } from '../../state/win32-private-directory.js';
import { withWindowsOperationLock } from '../../state/win32-operation-lock.js';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend } from '../../core/win32-native.js';
import { createWindowsOwnedFileServices } from '../../policy/win32-policy-services.js';
import { createWindowsPhysicalReads } from '../../profile-publishing/win32-physical-profile-reads.js';
import { detachWindowsAliasCache } from '../../profiles/win32-profile-provisioning.js';
import type { WindowsSelectionPublicationIo } from '../../state/win32-atomic-file.js';
import type { WindowsOperationLockIo } from '../../state/win32-operation-lock.js';
import { resolvePiAgentDirectory } from '../../state/paths.js';
import type { PiAdapterServices } from './adapter-services.js';
import { createInstallerRuntimeBinding, PI_ARTIFACT_MAX_BYTES } from './runtime-binding.js';

/** Installer context only: never discover a package through PATH or project data. */
export function createWindowsPiAdapterServices(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, environment: NodeJS.ProcessEnv, userHome: string, options: {
  stateIo?: WindowsSelectionPublicationIo; lockIo?: WindowsOperationLockIo;
  packageRoot?: string;
} = {}): PiAdapterServices {
  const piRoot = resolvePiAgentDirectory(environment, userHome, win32);
  const packageRoot = options.packageRoot ?? fileURLToPath(new URL('../../../', import.meta.url));
  const read = async (path: string, max: number) => (await createWindowsPhysicalReads(backend, undefined, {}, true).readFile(path, max)).bytes;
  const fileOptions = { ...options, lockComponent: 'adapter-pi.lock', retainedPrefix: 'pi' as const, authorizeDestination(home: string, file: string) {
    return file === win32.join(home, 'adapters', 'pi.json') || file === win32.join(piRoot, 'extensions', 'bazframe.ts') || file === win32.join(piRoot, 'bazframe', 'runtime.json');
  } };
  const files = createWindowsOwnedFileServices(backend, fileOptions);
  files.withLock = async (home, command, operation) => {
    const lockRootPath = win32.join(piRoot, 'bazframe', 'locks');
    ensureWindowsPrivateDirectoryPath(backend, lockRootPath);
    return withWindowsOperationLock({ backend, lockRootPath, lockComponent: 'adapter-pi.lock', details: { command, target: piRoot }, io: options.lockIo }, (piAuthority) =>
      createWindowsOwnedFileServices(backend, { ...fileOptions, assertAdditionalAuthority: () => piAuthority.assertHeld() }).withLock(home, command, operation));
  };
  return {
    paths: win32, files,
    readPackagedArtifact: () => read(win32.join(packageRoot, 'artifacts', 'pi', 'bazframe.ts'), PI_ARTIFACT_MAX_BYTES),
    desiredBinding: (version) => createInstallerRuntimeBinding(version, read, packageRoot),
    detachAliasCache: (home, writer) => detachWindowsAliasCache(backend, home, ['adapter-cache', 'pi'], writer)
  };
}
