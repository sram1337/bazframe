import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { captureProfileRemovalIdentity, type ProfileRemovalIdentity } from '../profiles/profile-removal-identity.js';
import { encodeProfileFavorites, profileFavoritesPath, readProfileFavorites, writeProfileFavoritesUnlocked } from '../profiles/profile-favorites.js';
import { profileDirectory, readOptionalActiveProfileSnapshot, type ActiveProfileSnapshot } from '../profiles/profile-store.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { readOptionalManagedProfileState } from './managed-profile-state.js';
import { duplicateManagedProfileState } from './profile-state-migration.js';
import { copyPhysicalProfileClosureToCandidate } from './profile-publication.js';
import {
  assertPhysicalProfileExpectation,
  capturePhysicalProfileExpectation,
  physicalProfileLocalSkillNames,
  type PhysicalProfileExpectation
} from './physical-profile-closure.js';
import { assertOperationMutationAuthority, withProfileOperationLocks } from './profile-operation-lock.js';
import { completeProfileRemovalTransaction, type ProfileRemovalRecoveryHooks } from './profile-recovery.js';
import { projectActivationProfileApplication } from './profile-application-projection.js';
import { readProfileSystemView, type ProfileDomainView } from './profile-view.js';
import { executeProfileCandidateSwap } from './profile-transaction.js';
import {
  backupTransactionToken,
  newTransactionId,
  physicalProfileSiblingForTransactionToken,
  readTransactionJournal,
  writeTransactionJournal,
  type RemoveProfileJournalV1,
  type RenamePhase,
  type RenameProfileJournalV1
} from './transaction-journal.js';

export interface ManagedProfileDuplicateResult { profileName: string; sourceProfileName: string; active: false; managed: boolean; transactionId: string }
export interface ManagedProfileRenameResult { oldName: string; newName: string; activeSelectionUpdated: boolean; transactionId: string; journal: RenameProfileJournalV1 }
export interface ManagedProfileActivationInspection { profile: ProfileDomainView; incomplete: boolean; warning: string | null; expectation: PhysicalProfileExpectation }
export interface ManagedProfileActivationResult extends ManagedProfileActivationInspection { active: true }
export interface ManagedProfileRemovalResult { profileName: string; action: 'removed' | 'absent'; retainedPath: string | null; transactionId?: string }

export interface ManagedProfileDuplicateHooks { afterCandidateCopy?(): void | Promise<void> }
export interface ManagedProfileRenameHooks {
  afterPhase?(phase: RenamePhase): void | Promise<void>;
  afterDirectoryRename?(): void | Promise<void>;
}
export type ManagedProfileRemovalHooks = ProfileRemovalRecoveryHooks & { expectedRemovalIdentity?: ProfileRemovalIdentity; requireGeneratedEmpty?: boolean };

export async function duplicateManagedProfile(home: string, sourceProfileName: string, profileName: string, hooks: ManagedProfileDuplicateHooks = {}): Promise<ManagedProfileDuplicateResult> {
  assertSafeProfileId(sourceProfileName); assertSafeProfileId(profileName);
  if (sourceProfileName === profileName) throw invalid('duplicate source and destination must differ');
  const sourceExpectation = await capturePhysicalProfileExpectation(home, sourceProfileName);
  const sourceStateSnapshot = await readOptionalManagedProfileState(home, sourceProfileName);
  if ((sourceStateSnapshot?.sha256 ?? null) !== sourceExpectation.sidecarSha256) throw changed('source sidecar does not match its physical closure');
  const duplicateState = duplicateManagedProfileState(sourceStateSnapshot?.state, randomUUID(), physicalProfileLocalSkillNames(sourceExpectation.closure));
  await assertPhysicalProfileExpectation(home, sourceProfileName, sourceExpectation);
  const swapped = await executeProfileCandidateSwap({
    home,
    profileName,
    operation: 'fresh-import',
    freshImportMustRemainInactive: true,
    additionalOperationLockKeys: [sourceProfileName],
    beforePublication: () => assertPhysicalProfileExpectation(home, sourceProfileName, sourceExpectation),
    materialize: async (candidatePath, context) => {
      assertOperationMutationAuthority(context.authority, home, [sourceProfileName, profileName, '@store'], context.transactionId);
      await copyPhysicalProfileClosureToCandidate(home, sourceProfileName, sourceExpectation, candidatePath);
      await hooks.afterCandidateCopy?.();
      await assertPhysicalProfileExpectation(home, sourceProfileName, sourceExpectation);
      return duplicateState === undefined ? {} : { state: duplicateState };
    }
  });
  return { profileName, sourceProfileName, active: false, managed: duplicateState !== undefined, transactionId: swapped.transactionId };
}

export async function renameManagedProfile(home: string, oldName: string, newName: string, hooks: ManagedProfileRenameHooks = {}): Promise<ManagedProfileRenameResult> {
  assertSafeProfileId(oldName); assertSafeProfileId(newName);
  if (oldName === newName) throw invalid('rename source and destination must differ');
  const transactionId = newTransactionId();
  return withProfileOperationLocks(home, [oldName, newName, '@store'], async (authority) => {
    const old = await capturePhysicalProfileExpectation(home, oldName);
    await assertProfileAbsent(home, newName);
    const activeBefore = await readOptionalActiveProfileSnapshot(home);
    const favoritesBefore = await readFavoriteSnapshot(home);
    const activeAfter = activeBefore?.profileId === oldName ? newName : activeBefore?.profileId ?? null;
    const favoritesAfter = favoritesBefore.favorites.map((name) => name === oldName ? newName : name);
    const favoritesAfterSha256 = favoritesBefore.sha256 === null && !favoritesBefore.favorites.includes(oldName)
      ? null
      : sha(Buffer.from(encodeProfileFavorites(favoritesAfter)));
    let journal: RenameProfileJournalV1 = {
      schemaVersion: 1,
      kind: 'rename-profile',
      transactionId,
      oldName,
      newName,
      expectedOld: persisted(old),
      expectedNew: { kind: 'absent' },
      activeBefore: activeBefore?.profileId ?? null,
      activeAfter,
      favoritesBeforeSha256: favoritesBefore.sha256,
      favoritesAfterCanonicalBytesSha256: favoritesAfterSha256,
      phase: 'INTENT'
    };
    journal = await writeTransactionJournal(home, authority, journal);
    await hooks.afterPhase?.(journal.phase);
    const advance = async (phase: RenamePhase) => {
      journal = await writeTransactionJournal(home, authority, { ...journal, phase });
      await hooks.afterPhase?.(phase);
    };
    try {
      await withStateLock(join(home, 'locks', 'state.lock'), { command: 'profile-managed-rename', target: oldName }, async () => {
        assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId);
        await assertPhysicalProfileExpectation(home, oldName, old);
        await assertProfileAbsent(home, newName);
        await assertSameActive(activeBefore, await readOptionalActiveProfileSnapshot(home));
        await assertFavoriteSnapshot(home, favoritesBefore);

        await advance('DIRECTORY_RENAME_INTENT');
        assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId);
        await rename(profileDirectory(home, oldName), profileDirectory(home, newName));
        await syncDirectory(join(home, 'profiles'));
        await hooks.afterDirectoryRename?.();
        await assertRenamedProfile(home, newName, oldName, old);
        await advance('DIRECTORY_RENAME_PROVEN');

        await advance('ACTIVE_SELECTION_INTENT');
        assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId);
        if (activeAfter !== (activeBefore?.profileId ?? null)) await writeFileAtomic(join(home, 'active-profile'), `${activeAfter}\n`, { managedRoot: home, commitOnRename: true });
        if (((await readOptionalActiveProfileSnapshot(home))?.profileId ?? null) !== activeAfter) throw changed('active selection did not converge after rename');
        await advance('ACTIVE_SELECTION_PROVEN');

        await advance('FAVORITES_INTENT');
        assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId);
        if (favoritesAfterSha256 !== favoritesBefore.sha256) await writeProfileFavoritesUnlocked(home, favoritesAfter);
        const finalFavorites = await readFavoriteSnapshot(home);
        if (finalFavorites.sha256 !== favoritesAfterSha256) throw changed('favorites did not converge after rename');
        await advance('FAVORITES_PROVEN');
        await assertRenamedProfile(home, newName, oldName, old);
        await advance('COMMITTED');
      }, { managedRoot: home });
      return { oldName, newName, activeSelectionUpdated: activeAfter !== (activeBefore?.profileId ?? null), transactionId, journal };
    } catch (error) {
      if (journal.phase !== 'COMMITTED' && journal.phase !== 'ABORTED' && journal.phase !== 'AMBIGUOUS') {
        const phase = journal.phase === 'INTENT' ? 'ABORTED' : 'AMBIGUOUS';
        await writeTransactionJournal(home, authority, { ...journal, phase }).catch(() => undefined);
      }
      throw error;
    }
  }, transactionId);
}

export interface ManagedProfileActivationAuthority { assertHeld(home?: string, profileName?: string): void }
export interface ManagedProfileActivationServices {
  captureExpectation: typeof capturePhysicalProfileExpectation;
  assertExpectation: typeof assertPhysicalProfileExpectation;
  readSystemView: typeof readProfileSystemView;
  withOperationLocks<T>(home: string, keys: readonly string[], transactionId: string, operation: (authority: ManagedProfileActivationAuthority) => Promise<T>): Promise<T>;
  withStateLock<T>(home: string, profileName: string, operation: (authority: ManagedProfileActivationAuthority) => Promise<T>): Promise<T>;
  publishSelection(home: string, profileName: string, authority: ManagedProfileActivationAuthority, expectation: PhysicalProfileExpectation): Promise<void>;
  readSelection(home: string): Promise<string | undefined>;
  beforeReturn?(): void | Promise<void>;
}
const defaultActivationServices: ManagedProfileActivationServices = {
  captureExpectation: capturePhysicalProfileExpectation,
  assertExpectation: assertPhysicalProfileExpectation,
  readSystemView: readProfileSystemView,
  withOperationLocks: (home, keys, transactionId, operation) => withProfileOperationLocks(home, keys,
    (authority) => operation({ assertHeld: () => assertOperationMutationAuthority(authority, home, keys, transactionId) }), transactionId),
  withStateLock: (home, profileName, operation) => withStateLock(join(home, 'locks', 'state.lock'),
    { command: 'profile-managed-use', target: profileName }, () => operation({ assertHeld() {} }), { managedRoot: home }),
  publishSelection: (home, profileName) => writeFileAtomic(join(home, 'active-profile'), `${profileName}\n`, { managedRoot: home, commitOnRename: true }),
  async readSelection(home) { return (await readOptionalActiveProfileSnapshot(home))?.profileId; }
};

export async function inspectManagedProfileActivation(home: string, profileName: string, services?: ManagedProfileActivationServices): Promise<ManagedProfileActivationInspection> {
  assertSafeProfileId(profileName);
  const reads = services ?? defaultActivationServices;
  const expectation = await reads.captureExpectation(home, profileName);
  let view;
  try { view = await reads.readSystemView(home); }
  catch (error) {
    // Supported-platform legacy fallback stays unchanged; injected read failures never hide state.
    if (services !== undefined || expectation.sidecarSha256 !== null) throw error;
    await reads.assertExpectation(home, profileName, expectation);
    const profile: ProfileDomainView = { name: profileName, profileInstanceId: null, publication: null, publicationVersionState: 'unpublished', incomplete: false, missingResources: [], resourceIdentities: [] };
    return { profile, incomplete: false, warning: null, expectation };
  }
  const profile = view.profiles.find((candidate) => candidate.name === profileName);
  if (profile === undefined) throw changed('profile disappeared while inspecting activation');
  await reads.assertExpectation(home, profileName, expectation);
  return { profile: structuredClone(profile), incomplete: profile.incomplete, warning: projectActivationProfileApplication(view, profileName, null).activationWarning, expectation };
}

export async function useManagedProfile(home: string, profileName: string, services?: ManagedProfileActivationServices): Promise<ManagedProfileActivationResult> {
  const reads = services ?? defaultActivationServices;
  const inspection = await inspectManagedProfileActivation(home, profileName, services);
  const transactionId = newTransactionId();
  let committed = false;
  try {
    await reads.withOperationLocks(home, [profileName, '@store'], transactionId, async (operationAuthority) => {
      await reads.withStateLock(home, profileName, async (stateAuthority) => {
        const authority = { assertHeld(requestedHome = home, requestedProfile = profileName) {
          if (requestedHome !== home || requestedProfile !== profileName) throw changed('activation authority binding changed');
          operationAuthority.assertHeld(home, profileName); stateAuthority.assertHeld(home, profileName);
        } };
        await reads.assertExpectation(home, profileName, inspection.expectation);
        if (services !== undefined) {
          const finalView = await reads.readSystemView(home);
          if (JSON.stringify(finalView.profiles.find((profile) => profile.name === profileName)) !== JSON.stringify(inspection.profile)) throw changed('activation projection changed');
          await reads.assertExpectation(home, profileName, inspection.expectation);
        }
        authority.assertHeld();
        await reads.publishSelection(home, profileName, authority, inspection.expectation);
        committed = true;
        await reads.assertExpectation(home, profileName, inspection.expectation);
        if (await reads.readSelection(home) !== profileName) throw changed('active selection did not converge');
        authority.assertHeld();
        await reads.beforeReturn?.();
      });
    });
  } catch (error) {
    if (services !== undefined && committed) throw new BazframeError('WINDOWS_PROFILE_ACTIVATION_COMMITTED_CHECK_FAILED', 'Selection committed, but dependent profile validation or lock release failed. No rollback was attempted; inspect current selection before retry.', { cause: error });
    throw error;
  }
  return { ...inspection, active: true };
}

export async function removeManagedProfile(home: string, profileName: string, hooks: ManagedProfileRemovalHooks = {}): Promise<ManagedProfileRemovalResult> {
  assertSafeProfileId(profileName);
  const transactionId = newTransactionId();
  return withProfileOperationLocks(home, [profileName, '@store'], async (authority) => {
    if(hooks.expectedRemovalIdentity!==undefined){const current=await captureProfileRemovalIdentity(profileDirectory(home,profileName));if(JSON.stringify(current)!==JSON.stringify(hooks.expectedRemovalIdentity))throw new BazframeError('PROFILE_REMOVE_AUTHORIZATION_STALE','Profile removal authorization is stale; review the profile again.');}
    let expected: PhysicalProfileExpectation | undefined;
    try { expected = await capturePhysicalProfileExpectation(home, profileName); }
    catch (error) { if (!absent(error)) throw error; }
    if(expected!==undefined&&hooks.requireGeneratedEmpty===true){const content=expected.closure.entries.filter((entry)=>entry.kind!=='managed-sidecar');if(content.length!==1||content[0]?.kind!=='file'||content[0].path!=='AGENTS.md'||content[0].bytes!==0)throw new BazframeError('PROFILE_NOT_EMPTY',`Profile is not generated-empty and cannot be removed without recursive confirmation: ${profileName}`);}
    if (expected === undefined) {
      await withStateLock(join(home, 'locks', 'state.lock'), { command: 'profile-managed-remove-absent', target: profileName }, async () => {
        assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
        const favorites = await readProfileFavorites(home);
        if (favorites.favorites.includes(profileName)) await writeProfileFavoritesUnlocked(home, favorites.favorites.filter((name) => name !== profileName));
      }, { managedRoot: home });
      return { profileName, action: 'absent', retainedPath: null };
    }

    const active = await readOptionalActiveProfileSnapshot(home);
    if (active?.profileId === profileName) throw new BazframeError('ACTIVE_PROFILE_REMOVE_REFUSED', `Cannot remove active profile ${JSON.stringify(profileName)}.`);
    const favorites = await readFavoriteSnapshot(home);
    const afterNames = favorites.favorites.filter((name) => name !== profileName);
    const favoritesAfterSha256 = favorites.sha256 === null && afterNames.length === 0 ? null : sha(Buffer.from(encodeProfileFavorites(afterNames)));
    let journal: RemoveProfileJournalV1 = {
      schemaVersion: 1,
      kind: 'remove-profile',
      transactionId,
      profileName,
      expectedProfile: persisted(expected),
      quarantine: { token: backupTransactionToken(transactionId) },
      activeBefore: active?.profileId ?? null,
      activeBeforeSha256: active?.contentSha256 ?? null,
      favoritesBeforeSha256: favorites.sha256,
      favoritesAfterCanonicalBytesSha256: favoritesAfterSha256,
      phase: 'INTENT'
    };
    journal = await writeTransactionJournal(home, authority, journal);
    await hooks.afterPhase?.('INTENT');
    try {
      journal = await completeProfileRemovalTransaction(home, journal, authority, hooks);
    } catch (error) {
      if (!(error instanceof BazframeError) || error.code !== 'PROFILE_RECOVERY_AMBIGUOUS') throw error;
      const current = await readTransactionJournal(home, transactionId);
      if (current.kind !== 'remove-profile') throw changed('remove journal kind changed');
      if (current.phase !== 'COMMITTED' && current.phase !== 'AMBIGUOUS') await writeTransactionJournal(home, authority, { ...current, phase: 'AMBIGUOUS' });
      throw error;
    }
    return { profileName, action: 'removed', retainedPath: join(home, 'profiles', physicalProfileSiblingForTransactionToken(journal.quarantine.token)), transactionId };
  }, transactionId);
}

async function assertProfileAbsent(home: string, profileName: string): Promise<void> {
  try { await lstat(profileDirectory(home, profileName)); }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
  throw new BazframeError('PROFILE_RENAME_DESTINATION_OCCUPIED', `Profile rename destination ${JSON.stringify(profileName)} is occupied.`);
}

async function assertRenamedProfile(home: string, newName: string, oldName: string, expected: PhysicalProfileExpectation): Promise<void> {
  const current = await capturePhysicalProfileExpectation(home, newName);
  if (current.identity !== expected.identity || current.sidecarSha256 !== expected.sidecarSha256
    || JSON.stringify(current.closure.entries) !== JSON.stringify(expected.closure.entries)
    || current.closure.profileName !== newName || expected.closure.profileName !== oldName) throw changed('renamed profile does not preserve the source closure');
}

async function readFavoriteSnapshot(home: string): Promise<{ sha256: string | null; favorites: string[] }> {
  const path = profileFavoritesPath(home);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const bytes = await handle.readFile();
      const state = await readProfileFavorites(home);
      if (!bytes.equals(Buffer.from(encodeProfileFavorites(state.favorites)))) throw changed('favorites bytes are not canonical');
      return { sha256: sha(bytes), favorites: state.favorites };
    } finally { await handle.close(); }
  } catch (error) { if (errorCode(error) === 'ENOENT') return { sha256: null, favorites: [] }; throw error; }
}

async function assertFavoriteSnapshot(home: string, expected: { sha256: string | null; favorites: string[] }): Promise<void> {
  const current = await readFavoriteSnapshot(home);
  if (current.sha256 !== expected.sha256 || JSON.stringify(current.favorites) !== JSON.stringify(expected.favorites)) throw changed('favorites changed before rename');
}

async function assertSameActive(left: ActiveProfileSnapshot | undefined, right: ActiveProfileSnapshot | undefined): Promise<void> {
  if (left === undefined || right === undefined) { if (left === right) return; throw changed('active selection changed before rename'); }
  if (left.profileId !== right.profileId || left.device !== right.device || left.inode !== right.inode || left.contentSha256 !== right.contentSha256) throw changed('active selection changed before rename');
}

function persisted(value: PhysicalProfileExpectation): RenameProfileJournalV1['expectedOld'] { return { identity: value.identity, sidecarSha256: value.sidecarSha256, profileClosureSha256: value.profileClosureSha256 }; }
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function absent(error: unknown): boolean { return errorCode(error) === 'ENOENT' || (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT'); }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
function changed(detail: string): BazframeError { return new BazframeError('PROFILE_MANAGED_LIFECYCLE_CHANGED', `Managed profile lifecycle changed or became ambiguous: ${detail}.`); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_MANAGED_LIFECYCLE_INVALID', `Invalid managed profile lifecycle: ${detail}.`); }
