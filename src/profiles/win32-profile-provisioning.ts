import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { BazframeWin32LockBackend, BazframeWin32NativeBackend } from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  ADDED_SKILL_NAMESPACE_ENTRY_LIMIT,
  createWindowsAddedSkillPlatformServicesForInternalTesting
} from '../skills/added-skill-platform-services.js';
import {
  executeWindowsDirectoryPublication,
  newWindowsDirectoryPublicationTransactionId,
  readWindowsDirectoryPublicationJournal,
  recoverWindowsDirectoryPublication,
  type WindowsDirectoryPublicationHooks,
  type WindowsDirectoryPublicationIo
} from '../state/win32-directory-publication.js';
import { withWindowsOperationLock, type WindowsOperationLockIo } from '../state/win32-operation-lock.js';
import {
  admitWindowsPrivateDirectory,
  admitWindowsPrivateFile,
  ensureWindowsPrivateDirectoryPath,
  isValidWindowsPathComponent
} from '../state/win32-private-directory.js';
import { assertSafeProfileId, isSafeProfileId } from './profile-id.js';
import type { ProfileListResult, ProfileProvisioningServices } from './profile-management.js';
import { decodeActiveProfileState, loadProfile, MAX_ACTIVE_PROFILE_STATE_BYTES } from './profile-store.js';

export interface WindowsProfileProvisioningTestOptions {
  publicationIo?: WindowsDirectoryPublicationIo;
  lockIo?: WindowsOperationLockIo;
  hooks?: WindowsDirectoryPublicationHooks & { afterStateLock?(): void | Promise<void> };
}

/** Internal inactive-profile onboarding only. No public caller constructs this service. */
export function createWindowsProfileProvisioningServicesForInternalTesting(
  backend: BazframeWin32NativeBackend & BazframeWin32LockBackend,
  options: WindowsProfileProvisioningTestOptions = {}
): ProfileProvisioningServices {
  const services = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
  const enumerate = (path: string) => services.enumeratePrivateDirectory(path, ADDED_SKILL_NAMESPACE_ENTRY_LIMIT);
  const ensure = (path: string) => ensureWindowsPrivateDirectoryPath(backend, path);

  async function activeSnapshot(home: string): Promise<{ profileId?: string; digest: string }> {
    const namespace = await enumerate(home);
    const names = namespace.names.filter((name) => key(name) === key('active-profile'));
    if (names.length === 0) return { digest: digest('absent') };
    if (names[0] !== 'active-profile') throw invalid('Active selection uses an alias spelling.');
    const path = win32.join(home, 'active-profile');
    const before = admitWindowsPrivateFile(backend, path);
    const receipt = await backend.readStableFile(path, MAX_ACTIVE_PROFILE_STATE_BYTES);
    const after = admitWindowsPrivateFile(backend, path);
    if (JSON.stringify(before) !== JSON.stringify(after)
      || JSON.stringify(before.object) !== JSON.stringify(receipt.before)
      || JSON.stringify(receipt.before) !== JSON.stringify(receipt.after)
      || BigInt(receipt.bytes.byteLength) !== BigInt(`0x${receipt.after.size}`)) {
      throw invalid('Active selection changed during its bounded read.');
    }
    return {
      profileId: decodeActiveProfileState(receipt.bytes, path),
      digest: digest(JSON.stringify(after), receipt.bytes)
    };
  }

  async function absentAliasCache(home: string, profileId: string): Promise<void> {
    let parent = home;
    for (const component of ['adapter-cache', 'pi', 'skill-aliases', profileId]) {
      const entries = await enumerate(parent);
      const found = entries.names.find((name) => key(name) === key(component));
      if (found === undefined) return;
      if (found !== component) throw invalid('Profile alias cache uses an alias spelling.');
      parent = win32.join(parent, component);
      admitWindowsPrivateDirectory(backend, parent);
    }
    throw invalid('Profile alias cache is occupied; Windows cache reclamation is not supported.');
  }

  async function current(home: string, profileId: string): Promise<boolean> {
    const entries = await enumerate(win32.join(home, 'profiles'));
    const found = entries.names.find((name) => key(name) === key(profileId));
    if (found === undefined) return false;
    if (found !== profileId) throw invalid('Profile destination uses an alias spelling.');
    await loadProfile(home, profileId, { platformServices: services });
    return true;
  }

  return {
    async addProfile(home, profileId) {
      assertSafeProfileId(profileId);
      if (!isValidWindowsPathComponent(profileId)) throw invalid('Profile ID is reserved on Windows.');
      ensure(home);
      const locks = win32.join(home, 'locks');
      ensure(locks);
      return withWindowsOperationLock({
        backend, lockRootPath: locks, lockComponent: 'state.lock',
        details: { command: 'bazframe profile add', target: home },
        ...(options.lockIo === undefined ? {} : { io: options.lockIo })
      }, async (held) => {
        await options.hooks?.afterStateLock?.();
        held.assertHeld();
        const selection = await activeSnapshot(home);
        const parentPath = win32.join(home, 'profiles');
        ensure(parentPath);
        // The accepted Skill lifecycle needs this lock root, not pre-provisioned fixtures.
        ensure(win32.join(locks, 'profiles'));
        const journalRootPath = win32.join(home, 'windows-transactions', 'profile-add', profileId);
        ensure(journalRootPath);
        const dependentState = {
          expectedSha256: selection.digest,
          observeSha256: async () => (await activeSnapshot(home)).digest
        };
        const common = {
          backend, parentPath, journalRootPath, destinationName: profileId, dependentState,
          ...(options.publicationIo === undefined ? {} : { io: options.publicationIo }),
          ...(options.hooks === undefined ? {} : { hooks: options.hooks })
        };
        const journals = await enumerate(journalRootPath);
        for (const entry of journals.entries) {
          if (!/^[a-f0-9]{32}$/u.test(entry.name) || !entry.directory || entry.reparseTag !== null) {
            throw invalid('Profile-add recovery namespace contains an unrecognized entry; retained privately.');
          }
          const journal = await readWindowsDirectoryPublicationJournal(
            backend, parentPath, journalRootPath, win32.join(journalRootPath, entry.name), entry.name
          );
          if (journal.mode !== 'fresh' || journal.destinationName !== profileId) {
            throw invalid('Profile-add journal is not an owned fresh-profile transaction.');
          }
          // A validated completed add does not freeze later legitimate profile edits.
          if (journal.phase === 'COMMITTED' || journal.phase === 'ABORTED') continue;
          await absentAliasCache(home, profileId);
          if (selection.profileId === profileId && !await current(home, profileId)) {
            throw invalid('A missing profile is already named by active selection.');
          }
          const recovered = await recoverWindowsDirectoryPublication({
            ...common, transactionId: entry.name,
            authority: { transactionId: entry.name, assertHeld: () => held.assertHeld() }
          });
          if (recovered.action === 'ambiguous') throw invalid('Profile-add recovery is ambiguous; transaction state retained privately.');
        }
        const directory = win32.join(parentPath, profileId);
        if (await current(home, profileId)) {
          if ((await activeSnapshot(home)).digest !== selection.digest) throw invalid('Active selection changed.');
          held.assertHeld();
          return { action: 'current', profileId, directory };
        }
        if (selection.profileId === profileId) throw invalid('A missing profile is already named by active selection.');
        await absentAliasCache(home, profileId);
        const transactionId = newWindowsDirectoryPublicationTransactionId();
        const result = await executeWindowsDirectoryPublication({
          ...common, operation: { mode: 'fresh' },
          authority: { transactionId, assertHeld: () => held.assertHeld() },
          async materialize(candidate) {
            await candidate.createPrivateFile('AGENTS.md', Buffer.alloc(0));
            await candidate.createEmptyPrivateDirectory('skills');
          }
        });
        if (result.action !== 'committed') throw invalid('Profile-add publication is ambiguous; transaction state retained privately.');
        held.assertHeld();
        return { action: 'added', profileId, directory };
      });
    },

    async listProfiles(home): Promise<ProfileListResult> {
      // Read-only: no home/lock creation and no recovery, including pending journals.
      try { admitWindowsPrivateDirectory(backend, home); }
      catch (error) {
        if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return { profileIds: [], diagnostics: [] };
        throw error;
      }
      await activeSnapshot(home);
      let entries;
      try { entries = await enumerate(win32.join(home, 'profiles')); }
      catch (error) {
        if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return { profileIds: [], diagnostics: [] };
        throw error;
      }
      const result: ProfileListResult = { profileIds: [], diagnostics: [] };
      for (const name of entries.names) {
        if (!isSafeProfileId(name) || !isValidWindowsPathComponent(name)) {
          result.diagnostics.push(`Skipping unsafe profile entry ${JSON.stringify(name)}.`);
          continue;
        }
        try {
          await loadProfile(home, name, { platformServices: services });
          result.profileIds.push(name);
        } catch {
          result.diagnostics.push(`Skipping invalid profile ${JSON.stringify(name)}.`);
        }
      }
      const after = await enumerate(win32.join(home, 'profiles'));
      if (after.identity !== entries.identity) throw invalid('Profile namespace changed during listing.');
      return result;
    }
  };
}

function key(value: string): string { return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase(); }
function digest(value: string, bytes?: Uint8Array): string {
  const hash = createHash('sha256').update('bazframe-win32-profile-add-selection-v1\0').update(value);
  if (bytes !== undefined) hash.update(bytes);
  return hash.digest('hex');
}
function invalid(message: string): BazframeError {
  return new BazframeError('WINDOWS_PROFILE_PROVISIONING_REFUSED', message);
}
