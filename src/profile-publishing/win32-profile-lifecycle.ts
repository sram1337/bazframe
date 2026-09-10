import { createProductionProfileLifecycleRemoteAdapter } from './profile-remote-materializer.js';
import { createWindowsProfileGithubEffects } from './win32-profile-github-effects.js';
import type { WindowsManagedGitOptions } from '../providers/win32-managed-git-services.js';
import { windowsPublicationEffects } from './win32-profile-publication.js';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend } from '../core/win32-native.js';
import { stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { encodeProfileFavorites, MAX_PROFILE_FAVORITES_BYTES, PROFILE_FAVORITES_FILE, type ProfileFavoriteServices } from '../profiles/profile-favorites.js';
import { loadProfile } from '../profiles/profile-store.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { readWindowsPrivateFileSnapshot, readWindowsSelectionSnapshot } from '../profiles/win32-profile-selection.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting, enumerateWindowsPrivateDirectory } from '../skills/added-skill-platform-services.js';
import { publishWindowsPrivateStateFile, publishWindowsSelection, type WindowsSelectionPublicationIo } from '../state/win32-atomic-file.js';
import { withWindowsOperationLock, type WindowsOperationLockIo } from '../state/win32-operation-lock.js';
import { admitWindowsPrivateDirectory, ensureWindowsPrivateDirectoryPath, createWindowsPrivateDirectory, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { samePhysicalProfileExpectation, serializeWindowsPhysicalProfileProof } from './physical-profile-closure.js';
import { lifecycleFavoritesFromBytes, type ProfileLifecycleServices } from './profile-lifecycle-services.js';
import { assertWindowsOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority, withWindowsProfileOperationLocksForInternalTesting } from './profile-operation-lock.js';
import { recoverProfilePublishingTransactions } from './profile-recovery.js';
import { createWindowsOrdinaryProfileReads } from './win32-physical-profile-reads.js';
import type { ProfileLifecycleDependencies } from './profile-lifecycle.js';
import { captureProfile, captureCatalogResource } from './profile-capture.js';
import { readProfileSystemView } from './profile-view.js';
import { createWindowsProfileDataReads } from './win32-profile-data-reads.js';
import { createWindowsProfileZipEffects } from './win32-profile-zip.js';
import { createWindowsProfileStorage, type WindowsProfileStorageIo } from './win32-profile-storage.js';
import { newTransactionId } from './transaction-journal.js';
import { readWindowsTransactionJournal, scanWindowsTransactionJournals, writeWindowsTransactionJournal, type WindowsTransactionJournalOptions } from './win32-transaction-journal.js';

export interface WindowsProfileLifecycleOptions {
  managedGit?: Pick<WindowsManagedGitOptions, 'process' | 'resolveExecutable' | 'environment' | 'packageProcessRunner' | 'resolvePackageExecutable'>;
  storageIo?: WindowsProfileStorageIo;
  stateIo?: WindowsSelectionPublicationIo;
  lockIo?: WindowsOperationLockIo;
  journal?: WindowsTransactionJournalOptions;
}
/** Internal effects composition only. All lifecycle phase decisions run in the shared functions. */
export function createWindowsProfileLifecycleServicesForInternalTesting(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsProfileLifecycleOptions = {}): ProfileLifecycleServices & ProfileFavoriteServices {
  const reads = createWindowsOrdinaryProfileReads(backend);
  const enumerate = (path: string) => enumerateWindowsPrivateDirectory(backend, path, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries);
  async function favoritesSnapshot(home: string) {
    let before;
    try { before = await enumerate(home); }
    catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return { digest: 'absent', bytes: undefined, inspection: undefined }; throw error; }
    const names = before.names.filter((name) => key(name) === key(PROFILE_FAVORITES_FILE));
    if (names.length === 0) return { digest: 'absent', bytes: undefined, inspection: undefined };
    if (names.length !== 1 || names[0] !== PROFILE_FAVORITES_FILE) throw refused('favorites alias');
    const file = await readWindowsPrivateFileSnapshot(backend, win32.join(home, PROFILE_FAVORITES_FILE), MAX_PROFILE_FAVORITES_BYTES);
    if ((await enumerate(home)).identity !== before.identity) throw refused('favorites namespace changed');
    return { ...file, digest: sha(Buffer.concat([Buffer.from(JSON.stringify(stableWindowsPathInspection(file.inspection))), file.bytes])) };
  }
  const services: ProfileLifecycleServices & ProfileFavoriteServices = {
    async profileIdentity(home, name) {
      if (!isSafeProfileId(name) || !isValidWindowsPathComponent(name)) throw refused('invalid favorite profile');
      let inspection;
      try { inspection = admitWindowsPrivateDirectory(backend, win32.join(home, 'profiles', name)); }
      catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') throw new BazframeError('PROFILE_NOT_FOUND', `Profile not found: ${name}`); throw error; }
      const object = inspection.object;
      return JSON.stringify(['windows', object.volumeIdentity, object.fileId, object.creationTime]);
    },
    loadProfile: (home, name) => loadProfile(home, name, { platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(backend) }),
    header: { schemaVersion: 2, identityDomain: 'win32-ntfs' },
    get publication() { return windowsPublicationEffects(backend, options, services); },
    path: (home, name) => win32.join(home, 'profiles', name),
    capture: (home, name, component = name) => reads.captureSibling(home, name, component),
    async createCandidate(home, component, authority) {
      const id = operationAuthorityTransactionId(authority);
      assertWindowsOperationMutationAuthority(authority, backend, home, ['@store'], id);
      if (component !== `.bazframe-candidate-${id}`) throw refused('candidate binding changed');
      createWindowsPrivateDirectory(backend, win32.join(home, 'profiles'), component);
      assertWindowsOperationMutationAuthority(authority, backend, home, ['@store'], id);
    },
    readManagedState: reads.readManagedState,
    async writeCandidateState(home, path, authority, state) {
      await createWindowsProfileStorage(backend, options.storageIo).writeCandidateState(home, path, authority, state);
      const { encodeManagedProfileState } = await import('./publication-state.js');
      const { capturedProfileLimitPolicy } = await import('./profile-publishing-policy.js');
      return { sha256: sha(Buffer.from(encodeManagedProfileState(state, capturedProfileLimitPolicy()))) };
    },
    proof: serializeWindowsPhysicalProfileProof,
    async assertAbsent(home, name) {
      if (!(isSafeProfileId(name) && isValidWindowsPathComponent(name)) && !/^\.bazframe-backup-[a-f0-9]{32}$/u.test(name)) throw refused('invalid sibling');
      if ((await enumerate(win32.join(home, 'profiles'))).names.some((entry) => key(entry) === key(name))) throw refused('occupied or aliased destination');
    },
    async move(home, source, destination, logicalName, expected, authority) {
      const id = operationAuthorityTransactionId(authority);
      if (!((source === logicalName && (isSafeProfileId(destination) || destination === `.bazframe-backup-${id}`)) || (source === `.bazframe-candidate-${id}` && destination === logicalName))) throw refused('move binding changed');
      const keys = [logicalName, '@store', ...(isSafeProfileId(destination) ? [destination] : [])];
      const assertHeld = () => assertWindowsOperationMutationAuthority(authority, backend, home, keys, id);
      assertHeld();
      const parent = admitWindowsPrivateDirectory(backend, win32.join(home, 'profiles'));
      const current = await reads.captureSibling(home, logicalName, source);
      if (current === undefined || !samePhysicalProfileExpectation(current, expected)) throw refused('source changed');
      await services.assertAbsent(home, destination);
      assertHeld();
      let rejected = false;
      try { await backend.renameDirectoryNoReplace(win32.join(home, 'profiles'), source, destination); }
      catch { rejected = true; }
      assertHeld();
      const afterParent = admitWindowsPrivateDirectory(backend, win32.join(home, 'profiles'));
      if (parent.canonicalPath !== afterParent.canonicalPath || parent.object.fileId !== afterParent.object.fileId || parent.object.volumeIdentity !== afterParent.object.volumeIdentity || JSON.stringify(parent.security) !== JSON.stringify(afterParent.security)) throw refused('move parent changed');
      const old = await reads.captureSibling(home, logicalName, source);
      const moved = await reads.captureSibling(home, logicalName, destination);
      if (old === undefined && moved !== undefined && samePhysicalProfileExpectation(moved, expected)) return;
      if (rejected && moved === undefined && old !== undefined && samePhysicalProfileExpectation(old, expected)) throw new BazframeError('WINDOWS_PROFILE_MOVE_NO_EFFECT', 'Directory move had no effect; retain journal and retry after resolving sharing.');
      throw refused('directory movement is ambiguous');
    },
    withOperationLocks: (home, keys, operation, id) => withWindowsProfileOperationLocksForInternalTesting(backend, home, keys, id ?? newTransactionId(), operation, { lockIo: options.lockIo }),
    async withStateLock(home, name, operation) {
      const root = win32.join(home, 'locks');
      ensureWindowsPrivateDirectoryPath(backend, root);
      return withWindowsOperationLock({ backend, lockRootPath: root, lockComponent: 'state.lock', details: { command: 'profile-managed-lifecycle', target: name }, io: options.lockIo }, operation);
    },
    async readSelection(home) {
      const value = await readWindowsSelectionSnapshot(backend, home);
      return value.profileId === undefined ? undefined : { profileId: value.profileId, contentSha256: sha(value.bytes!), binding: value.digest };
    },
    async publishSelection(home, name, authority, baseline, validateDependencies) {
      const expected = await readWindowsSelectionSnapshot(backend, home);
      if (expected.profileId !== baseline?.profileId || (baseline !== undefined && expected.digest !== baseline.binding)) throw refused('selection baseline changed');
      await publishWindowsSelection({ backend, home, expected, bytes: Buffer.from(`${name}\n`), authority, io: options.stateIo, validateDependencies });
    },
    async readFavorites(home) {
      const value = await favoritesSnapshot(home);
      return { ...lifecycleFavoritesFromBytes(value.bytes), binding: value.digest };
    },
    async publishFavorites(home, names, authority, baseline, validateDependencies) {
      const expected = await favoritesSnapshot(home);
      if (!baseline.valid || expected.digest !== baseline.binding) throw refused('favorites baseline changed');
      await publishWindowsPrivateStateFile({ backend, home, expected, bytes: Buffer.from(encodeProfileFavorites(names)), authority,
        component: PROFILE_FAVORITES_FILE, temporaryPrefix: 'favorites', maxBytes: MAX_PROFILE_FAVORITES_BYTES,
        readSnapshot: () => favoritesSnapshot(home), io: options.stateIo, validateDependencies });
    },
    removalIdentity: (home, name) => reads.captureExpectation(home, name),
    async writeJournal(home, authority, journal) {
      if (journal.schemaVersion !== 2) throw refused('wrong journal domain');
      return await writeWindowsTransactionJournal(backend, home, authority, journal, options.journal) as typeof journal;
    },
    async readJournal(home, id) {
      const journal = await readWindowsTransactionJournal(backend, home, id);
      if (journal === undefined) throw refused('discovered journal disappeared');
      return journal;
    },
    scanJournals: (home) => scanWindowsTransactionJournals(backend, home),
    async beforeMutation(home) {
      const results = await recoverProfilePublishingTransactions(home, undefined, services);
      if (results.some((value) => value.action === 'ambiguous' || value.action === 'skipped-busy')) throw refused('recovery is unresolved');
      await assertWindowsLifecycleJournalsTerminal(backend, home);
    }
  };
  return services;
}
/** Views only recognize supported, settled records. They never acquire locks or recover. */
export async function assertWindowsLifecycleJournalsTerminal(backend: BazframeWin32NativeBackend, home: string, operation?: { authority: OperationMutationAuthority; home: string }): Promise<void> {
  if (operation !== undefined) {
    if (home !== operation.home) throw refused('operation home changed');
    assertWindowsOperationMutationAuthority(operation.authority, backend, home, ['@store'], operationAuthorityTransactionId(operation.authority));
  }
  for (const name of await scanWindowsTransactionJournals(backend, home)) {
    const journal = await readWindowsTransactionJournal(backend, home, name.slice(0, -5));
    if (operation !== undefined && journal !== undefined && journal.transactionId === operationAuthorityTransactionId(operation.authority)) {
      if (home !== operation.home || journal.kind !== 'candidate-swap' && journal.kind !== 'publication') throw refused('operation journal scope changed');
      assertWindowsOperationMutationAuthority(operation.authority, backend, home, [journal.profileName, '@store'], journal.transactionId);
      continue;
    }
    if (journal === undefined || (journal.kind !== 'rename-profile' && journal.kind !== 'remove-profile' && journal.kind !== 'candidate-swap' && journal.kind !== 'publication') || (journal.phase !== 'COMMITTED' && journal.phase !== 'ABORTED')) throw refused('unsupported or unresolved lifecycle journal');
  }
}
function key(value: string): string { return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase(); }
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function refused(detail: string): BazframeError { return new BazframeError('WINDOWS_PROFILE_LIFECYCLE_REFUSED', `Windows ordinary profile lifecycle refused: ${detail}. State was retained.`); }

/** Internal ZIP lifecycle composition. Absent-home inspection is read-only; bootstrap follows destination consent. */
export function createWindowsProfileZipLifecycleDependencies(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsProfileLifecycleOptions & { zip?: Parameters<typeof createWindowsProfileZipEffects>[1] } = {}): ProfileLifecycleDependencies {
  const services = createWindowsProfileLifecycleServicesForInternalTesting(backend, options);
  const data = createWindowsProfileDataReads(backend, undefined, options.managedGit), storage = createWindowsProfileStorage(backend, options.storageIo);
  async function homeExists(home: string) {
    try { admitWindowsPrivateDirectory(backend, home); return true; }
    catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return false; throw error; }
  }
  return {
    copyExcluded: storage.copyExcluded,
    services, ...createWindowsProfileZipEffects(backend, options.zip), homeExists,
    readSelection: async (home) => (await services.readSelection(home))?.profileId,
    defaultZipPath: (name, cwd = process.cwd()) => win32.resolve(cwd, `${name}.bazframe-profile.zip`),
    capture: (input) => captureProfile(input, data.captureDependencies),
    captureCatalog: (input) => captureCatalogResource(input, data.captureDependencies),
    readSystemView: (home) => readProfileSystemView(home, data.viewReads),
    readSystemViewWithAuthority: (home, authority) => readProfileSystemView(home, createWindowsProfileDataReads(backend, { home, authority }, options.managedGit).viewReads),
    async captureCatalogWithAuthority(input, authority) {
      const assertHeld = () => assertWindowsOperationMutationAuthority(authority, backend, input.bazframeHome, ['@store'], operationAuthorityTransactionId(authority));
      assertHeld(); const result = await captureCatalogResource(input, createWindowsProfileDataReads(backend, { home: input.bazframeHome, authority }, options.managedGit).captureDependencies); assertHeld(); return result;
    },
    async profileExists(home, name) {
      if (!isSafeProfileId(name) || !isValidWindowsPathComponent(name)) throw refused('invalid destination profile name');
      if (!await homeExists(home)) return false;
      const root = win32.join(home, 'profiles');
      const names = (await enumerateWindowsPrivateDirectory(backend, root, PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries)).names;
      const matches = names.filter((entry) => key(entry) === key(name));
      if (matches.length === 0) return false;
      if (matches.length !== 1 || matches[0] !== name) throw refused('destination profile alias');
      await services.capture(home, name); return true;
    },
    async beforeImportInspection(home) { if (await homeExists(home)) await services.beforeMutation?.(home); },
    async prepareImport(home) {
      ensureWindowsPrivateDirectoryPath(backend, home);
      for (const component of ['profiles', 'skills', 'locks']) ensureWindowsPrivateDirectoryPath(backend, win32.join(home, component));
    },
    materializationEffects(home, authority) {
      const current = createWindowsProfileDataReads(backend, { home, authority }, options.managedGit);
      return storage.materializationEffects(home, authority, (root) => readProfileSystemView(root, current.viewReads));
    },
    remote: createProductionProfileLifecycleRemoteAdapter({ environment: options.managedGit?.environment, services: createWindowsProfileGithubEffects(backend, options).remoteServices })
  };
}

/** Shared imported-resource capture/copy/swap dependencies, not a second membership engine. */
export function createWindowsImportedResourceMembershipDependencies(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsProfileLifecycleOptions = {}): import('./profile-resource-membership.js').ProfileResourceMembershipDependencies {
  const services = createWindowsProfileLifecycleServicesForInternalTesting(backend, options);
  const storage = createWindowsProfileStorage(backend, options.storageIo);
  const reads = createWindowsProfileDataReads(backend, undefined, options.managedGit);
  return {
    services, capture: reads.viewReads.captureExpectation, readState: services.readManagedState,
    readSystemView: (home, authority) => readProfileSystemView(home, createWindowsProfileDataReads(backend, authority === undefined ? undefined : { home, authority }).viewReads),
    copyEffects: (home, authority) => storage.copyEffects(home, authority)
  };
}
