import { createHash, randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend, WindowsPathInspection } from '../core/win32-native.js';
import { stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { readWindowsPrivateFileSnapshot } from '../profiles/win32-profile-selection.js';
import { enumerateWindowsPrivateDirectory } from '../skills/added-skill-platform-services.js';
import { publishWindowsPrivateStateFile, type WindowsSelectionPublicationIo } from '../state/win32-atomic-file.js';
import { withWindowsOperationLock, type WindowsOperationLockIo } from '../state/win32-operation-lock.js';
import { admitWindowsPrivateDirectory, ensureWindowsPrivateDirectoryPath, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import type { PolicyServices, PolicySnapshot } from './policy-services.js';

const key = (value: string) => value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
const same = (a: WindowsPathInspection, b: WindowsPathInspection) => a.object.volumeIdentity === b.object.volumeIdentity && a.object.fileId === b.object.fileId && a.object.creationTime === b.object.creationTime && JSON.stringify(a.security) === JSON.stringify(b.security);
type Snapshot = PolicySnapshot & { inspection?: WindowsPathInspection };
interface WindowsFileServiceOptions {
  stateIo?: WindowsSelectionPublicationIo;
  lockIo?: WindowsOperationLockIo;
}
export function createWindowsPolicyServices(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsFileServiceOptions = {}): PolicyServices {
  return createWindowsOwnedFileServices(backend, { ...options, lockComponent: 'state.lock', retainedPrefix: 'policy', authorizeDestination(home, file) {
    const relative = win32.relative(home, file);
    return relative === 'global.json' || /^projects\\[a-f0-9]{64}\.json$/u.test(relative);
  } });
}
/** Protected file effects shared by policy and independently rooted adapter installation. */
export function createWindowsOwnedFileServices(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsFileServiceOptions & {
  lockComponent: string;
  retainedPrefix: 'policy' | 'pi';
  authorizeDestination(home: string, file: string): boolean;
  assertAdditionalAuthority?(): void;
}): PolicyServices {
  async function entries(directory: string): Promise<string[]> {
    try { return (await enumerateWindowsPrivateDirectory(backend, directory, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries)).names; }
    catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND' && await absent(directory)) return []; throw error; }
  }
  async function absent(file: string): Promise<boolean> {
    const parent = win32.dirname(file), component = win32.basename(file);
    if (parent === file || !isValidWindowsPathComponent(component)) throw refused('invalid path');
    let names;
    try { names = (await enumerateWindowsPrivateDirectory(backend, parent, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries, (_backend, path) => backend.inspectPath(path))).names; }
    catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return absent(parent); throw error; }
    const matches = names.filter((name) => key(name) === key(component));
    if (matches.length === 0) return true;
    if (matches.length !== 1 || matches[0] !== component) throw refused('aliased path');
    return false;
  }
  async function snapshot(file: string, max: number): Promise<Snapshot> {
    if (await absent(file)) return { identity: 'absent' };
    const value = await readWindowsPrivateFileSnapshot(backend, file, max);
    return { ...value, identity: createHash('sha256').update(JSON.stringify(stableWindowsPathInspection(value.inspection))).update(value.bytes).digest('hex') };
  }
  return {
    paths: win32, entries, snapshot,
    retained: (name) => new RegExp(`^\\.bazframe-${options.retainedPrefix}-[a-f0-9]{32}\\.retained$`, 'u').test(name),
    async withLock(home, command, operation) {
      ensureWindowsPrivateDirectoryPath(backend, win32.join(home, 'locks'));
      return withWindowsOperationLock({ backend, lockRootPath: win32.join(home, 'locks'), lockComponent: options.lockComponent, details: { command, target: home }, io: options.lockIo }, async (authority) => {
        const assertHeld = () => { authority.assertHeld(); options.assertAdditionalAuthority?.(); };
        const assertDestination = (file: string) => {
          assertHeld();
          if (!options.authorizeDestination(home, file)) throw refused('invalid owned destination');
        };
        const result = await operation({
          assertHeld,
          async publish(file, bytes, expected, maxBytes) {
            assertDestination(file);
            ensureWindowsPrivateDirectoryPath(backend, win32.dirname(file));
            const readSnapshot = async () => { const value = await snapshot(file, maxBytes); return { ...value, digest: value.identity }; };
            const current = await readSnapshot();
            if (current.identity !== expected.identity) throw refused('policy changed');
            await publishWindowsPrivateStateFile({ backend, home: win32.dirname(file), component: win32.basename(file), temporaryPrefix: 'resource', noReplaceOnAbsent: true, expected: current, bytes, maxBytes, authority: { assertHeld }, io: options.stateIo, readSnapshot });
            assertHeld();
          },
          async detach(file, expected, maxBytes) {
            assertDestination(file);
            const initial = await snapshot(file, maxBytes);
            if (initial.identity !== expected.identity || initial.inspection === undefined) throw refused('policy changed');
            const parentPath = win32.dirname(file), parent = admitWindowsPrivateDirectory(backend, parentPath);
            const retained = `.bazframe-${options.retainedPrefix}-${randomBytes(16).toString('hex')}.retained`;
            assertHeld(); let rejected = false;
            try { await backend.renameFileNoReplace(parentPath, win32.basename(file), retained); } catch { rejected = true; }
            assertHeld();
            if (!same(parent, admitWindowsPrivateDirectory(backend, parentPath))) throw refused('parent changed; retain both leaves');
            const current = await snapshot(file, maxBytes), moved = await snapshot(win32.join(parentPath, retained), maxBytes);
            if (current.bytes === undefined && moved.inspection !== undefined && same(initial.inspection, moved.inspection) && moved.bytes?.equals(initial.bytes!)) return;
            if (rejected && moved.bytes === undefined && current.identity === initial.identity) throw refused('sharing failure; no effect');
            throw refused('ambiguous detachment; retain both leaves');
          }
        });
        assertHeld(); return result;
      });
    }
  };
}
function refused(detail: string) { return new BazframeError('WINDOWS_POLICY_REFUSED', `Windows policy refused: ${detail}.`); }
