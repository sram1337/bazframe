import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend } from '../core/win32-native.js';
import { stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { readWindowsPrivateFileSnapshot } from '../profiles/win32-profile-selection.js';
import { enumerateWindowsPrivateDirectory } from '../skills/added-skill-platform-services.js';
import { publishWindowsPrivateStateFile } from '../state/win32-atomic-file.js';
import { admitWindowsPrivateDirectory, ensureWindowsPrivateDirectoryPath } from '../state/win32-private-directory.js';
import { captureProfile } from './profile-capture.js';
import { windowsPhysicalIdentityText } from './profile-filesystem.js';
import { assertWindowsOperationMutationAuthority, operationAuthorityTransactionId } from './profile-operation-lock.js';
import type { ProfileLifecycleServices } from './profile-lifecycle-services.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { decodeManagedProfileStateBytes, encodeManagedProfileState, publicationSidecarName } from './publication-state.js';
import { createWindowsProfileDataReads } from './win32-profile-data-reads.js';
import type { WindowsProfileLifecycleOptions } from './win32-profile-lifecycle.js';
import { writeWindowsProfileFile } from './win32-profile-storage.js';

/** Sidecar-only physical effects beneath the shared publication/recovery phases. */
export function windowsPublicationEffects(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsProfileLifecycleOptions, services: ProfileLifecycleServices): NonNullable<ProfileLifecycleServices['publication']> {
  const policy = capturedProfileLimitPolicy();
  const snapshot = async (root: string, name: string) => {
    const namespace = await enumerateWindowsPrivateDirectory(backend, root, policy.maxEntries);
    const matches = namespace.names.filter((entry) => entry.normalize('NFC').toLowerCase() === name.toLowerCase());
    if (matches.length === 0) return { digest: 'absent', bytes: undefined, inspection: undefined };
    if (matches.length !== 1 || matches[0] !== name) throw changed();
    const value = await readWindowsPrivateFileSnapshot(backend, win32.join(root, name), policy.maxManifestBytes);
    return { ...value, digest: hash(Buffer.concat([Buffer.from(JSON.stringify(stableWindowsPathInspection(value.inspection))), value.bytes])) };
  };
  const retainedRoot = (home: string, id: string) => win32.join(home, 'profile-publishing', 'publication-state', id);
  return {
    async capture(input, authority) {
      const assertHeld = () => { if (authority !== undefined) assertWindowsOperationMutationAuthority(authority, backend, input.bazframeHome, [input.profileId, '@store'], operationAuthorityTransactionId(authority)); };
      assertHeld();
      const result = await captureProfile(input, createWindowsProfileDataReads(backend, authority === undefined ? undefined : { home: input.bazframeHome, authority }, options.managedGit).captureDependencies);
      assertHeld(); return result;
    },
    assertRoot(home, name, expected, authority) {
      assertWindowsOperationMutationAuthority(authority, backend, home, [name, '@store'], operationAuthorityTransactionId(authority));
      const current = admitWindowsPrivateDirectory(backend, services.path(home, name));
      if (windowsPhysicalIdentityText(current.object.volumeIdentity, current.object.fileId) !== expected.identity) throw changed();
    },
    async publishSidecar(home, name, expected, state, authority) {
      services.proof(expected);
      const id = operationAuthorityTransactionId(authority);
      const assertHeld = () => assertWindowsOperationMutationAuthority(authority, backend, home, [name, '@store'], id);
      const root = services.path(home, name);
      const desired = Buffer.from(encodeManagedProfileState(state, policy));
      const assertRoot = () => {
        assertHeld();
        const current = admitWindowsPrivateDirectory(backend, root);
        if (windowsPhysicalIdentityText(current.object.volumeIdentity, current.object.fileId) !== expected.identity) throw changed();
      };
      await services.withStateLock(home, name, async (stateAuthority) => {
        const authorityBoth = { assertHeld() { stateAuthority.assertHeld(); assertRoot(); } };
        authorityBoth.assertHeld();
        const before = await snapshot(root, publicationSidecarName());
        authorityBoth.assertHeld();
        if (before.bytes?.equals(desired)) return;
        if ((before.bytes === undefined ? null : hash(before.bytes)) !== expected.sidecarSha256) throw changed();
        if (before.bytes !== undefined) {
          const retained = retainedRoot(home, id);
          ensureWindowsPrivateDirectoryPath(backend, retained);
          authorityBoth.assertHeld();
          const old = await snapshot(retained, 'previous.json');
          authorityBoth.assertHeld();
          if (old.bytes === undefined) await writeWindowsProfileFile(backend, win32.join(retained, 'previous.json'), before.bytes, options.storageIo);
          else if (!old.bytes.equals(before.bytes)) throw changed();
          authorityBoth.assertHeld();
          const proved = await snapshot(retained, 'previous.json');
          if (proved.bytes === undefined || hash(proved.bytes) !== expected.sidecarSha256) throw changed();
        }
        authorityBoth.assertHeld();
        await publishWindowsPrivateStateFile({ backend, home: root, component: publicationSidecarName() as `${string}.json`, temporaryPrefix: 'resource', expected: before, bytes: desired, noReplaceOnAbsent: true, maxBytes: policy.maxManifestBytes, authority: authorityBoth, io: options.stateIo, validateDependencies: async () => { authorityBoth.assertHeld(); }, readSnapshot: () => snapshot(root, publicationSidecarName()) });
        authorityBoth.assertHeld();
        const final = await snapshot(root, publicationSidecarName());
        authorityBoth.assertHeld();
        if (!final.bytes?.equals(desired)) throw changed();
      });
    },
    async readPrevious(home, journal) {
      if (journal.schemaVersion !== 2) throw changed();
      if (journal.expectedProfile.sidecarSha256 === null) return undefined;
      const current = await services.readManagedState(home, journal.profileName);
      if (current?.sha256 === journal.expectedProfile.sidecarSha256) return current;
      let value;
      try { value = await snapshot(retainedRoot(home, journal.transactionId), 'previous.json'); }
      catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') throw changed(); throw error; }
      if (value.bytes === undefined || hash(value.bytes) !== journal.expectedProfile.sidecarSha256) throw changed();
      return { state: decodeManagedProfileStateBytes(value.bytes, policy), sha256: hash(value.bytes), bytes: value.bytes.length };
    }
  };
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function changed(): BazframeError { return new BazframeError('PROFILE_PUBLICATION_CHANGED', 'Windows publication sidecar/root predicates did not converge; private state was retained.'); }
