import { createWindowsProfileLifecycleServicesForInternalTesting } from './win32-profile-lifecycle.js';
import { win32 } from 'node:path';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend } from '../core/win32-native.js';
import { BazframeError } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { readWindowsSelectionSnapshot } from '../profiles/win32-profile-selection.js';
import { enumerateWindowsPhysicalDirectory } from '../skills/added-skill-platform-services.js';
import { publishWindowsSelection, type WindowsSelectionPublicationIo, type WindowsSelectionPublicationHooks } from '../state/win32-atomic-file.js';
import { withWindowsOperationLock, type WindowsOperationLockIo } from '../state/win32-operation-lock.js';
import { ensureWindowsPrivateDirectoryPath } from '../state/win32-private-directory.js';
import { createWindowsProfileDataReads } from './win32-profile-data-reads.js';
import type { ManagedProfileActivationServices, ManagedProfileActivationAuthority } from './profile-managed-lifecycle.js';
import { assertOperationMutationAuthority, withWindowsProfileOperationLocksForInternalTesting } from './profile-operation-lock.js';
import { readProfileSystemView } from './profile-view.js';

export interface WindowsProfileActivationTestOptions {
  selectionIo?: WindowsSelectionPublicationIo;
  lockIo?: WindowsOperationLockIo;
  journal?: import('./win32-transaction-journal.js').WindowsTransactionJournalOptions;
  hooks?: WindowsSelectionPublicationHooks & {
    afterOperationLock?(key: string): void | Promise<void>;
    afterStateLock?(): void | Promise<void>;
    beforeReturn?(): void | Promise<void>;
  };
}

/** Internal rich profile data composition; never constructed by public dispatch. */
export function createWindowsProfileActivationServicesForInternalTesting(
  backend: BazframeWin32NativeBackend & BazframeWin32LockBackend,
  options: WindowsProfileActivationTestOptions = {}
): ManagedProfileActivationServices {
  const enumerate = (path: string, max: number = PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) => enumerateWindowsPhysicalDirectory(backend, path, max);
  const { viewReads } = createWindowsProfileDataReads(backend);
  const { captureExpectation: capture, assertExpectation } = viewReads;
  return {
    beforeMutation: createWindowsProfileLifecycleServicesForInternalTesting(backend, { lockIo: options.lockIo, stateIo: options.selectionIo, journal: options.journal }).beforeMutation!,
    captureExpectation: capture, assertExpectation,
    async readSystemView(home) {
      const before = await enumerate(win32.join(home, 'profiles'));
      const view = await readProfileSystemView(home, viewReads);
      if ((await enumerate(win32.join(home, 'profiles'))).identity !== before.identity) throw changed();
      return view;
    },
    async withOperationLocks<T>(home: string, keys: readonly string[], transactionId: string, operation: (authority: ManagedProfileActivationAuthority) => Promise<T>): Promise<T> {
      return withWindowsProfileOperationLocksForInternalTesting(backend, home, keys, transactionId, async (authority) => operation({
        assertHeld(requestedHome = home, profileName) {
          try {
            assertOperationMutationAuthority(authority, requestedHome, profileName === undefined ? [] : ['@store', profileName], transactionId);
          } catch (error) {
            if (error instanceof BazframeError && error.code === 'PROFILE_OPERATION_AUTHORITY_INVALID') throw changed();
            throw error;
          }
        }
      }), {
        ...(options.lockIo === undefined ? {} : { lockIo: options.lockIo }),
        afterOperationLock: (key) => options.hooks?.afterOperationLock?.(key)
      });
    },
    async withStateLock(home, profileName, operation) {
      const root = win32.join(home, 'locks');
      ensureWindowsPrivateDirectoryPath(backend, root);
      return withWindowsOperationLock({ backend, lockRootPath: root, lockComponent: 'state.lock',
        details: { command: 'profile-managed-use', target: profileName },
        ...(options.lockIo === undefined ? {} : { io: options.lockIo }) }, async (authority) => {
        await options.hooks?.afterStateLock?.();
        return operation({ assertHeld(requestedHome = home, requestedProfile = profileName) {
          if (win32.normalize(requestedHome) !== win32.normalize(home) || requestedProfile !== profileName) throw changed();
          authority.assertHeld();
        } });
      });
    },
    async publishSelection(home, profileName, authority, expectation) {
      authority.assertHeld(home, profileName);
      const expected = await readWindowsSelectionSnapshot(backend, home);
      await publishWindowsSelection({ backend, home, expected, bytes: Buffer.from(`${profileName}\n`), authority: { assertHeld: () => authority.assertHeld(home, profileName) },
        async validateDependencies() {
          await readProfileSystemView(home, viewReads);
          await assertExpectation(home, profileName, expectation);
        },
        ...(options.selectionIo === undefined ? {} : { io: options.selectionIo }),
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }) });
    },
    async readSelection(home) { return (await readWindowsSelectionSnapshot(backend, home)).profileId; },
    ...(options.hooks?.beforeReturn === undefined ? {} : { beforeReturn: options.hooks.beforeReturn })
  };
}
function changed(): BazframeError { return new BazframeError('WINDOWS_PROFILE_ACTIVATION_CHANGED', 'Physical profile activation observations changed or authority expired.'); }
