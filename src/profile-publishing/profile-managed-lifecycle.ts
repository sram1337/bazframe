import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BazframeError } from '../core/errors.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { type ProfileRemovalIdentity } from '../profiles/profile-removal-identity.js';
import { readOptionalActiveProfileSnapshot } from '../profiles/profile-store.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { duplicateManagedProfileState } from './profile-state-migration.js';
import { copyPhysicalProfileClosureToCandidate, type ProfileClosureCopyEffects } from './profile-publication.js';
import {
  assertPhysicalProfileExpectation,
  capturePhysicalProfileExpectation,
  captureOrdinaryProfileExpectation,
  assertOrdinaryProfileExpectation,
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
  type RenamePhase,
} from './transaction-journal.js';

import { defaultProfileLifecycleServices, lifecycleFavoritesAfter, type ProfileLifecycleServices, type RenameLifecycleJournal, type RemoveLifecycleJournal, type LifecycleFavorites, type LifecycleSelection } from './profile-lifecycle-services.js';

export interface ManagedProfileDuplicateResult { profileName: string; sourceProfileName: string; active: false; managed: boolean; transactionId: string }
export interface ManagedProfileRenameResult { oldName: string; newName: string; activeSelectionUpdated: boolean; transactionId: string; journal: RenameLifecycleJournal }
export interface ManagedProfileActivationInspection { profile: ProfileDomainView; incomplete: boolean; warning: string | null; expectation: PhysicalProfileExpectation }
export interface ManagedProfileActivationResult extends ManagedProfileActivationInspection { active: true }
export interface ManagedProfileRemovalResult { profileName: string; action: 'removed' | 'absent'; retainedPath: string | null; transactionId?: string }

export interface ManagedProfileDuplicateHooks { afterCandidateCopy?(): void | Promise<void> }
export interface ManagedProfileRenameHooks {
  afterPhase?(phase: RenamePhase): void | Promise<void>;
  afterDirectoryRename?(): void | Promise<void>;
}
export type ManagedProfileRemovalHooks = ProfileRemovalRecoveryHooks & { expectedRemovalIdentity?: ProfileRemovalIdentity | PhysicalProfileExpectation; requireGeneratedEmpty?: boolean };

export async function duplicateManagedProfile(home: string, sourceProfileName: string, profileName: string, hooks: ManagedProfileDuplicateHooks = {}, services: ProfileLifecycleServices = defaultProfileLifecycleServices, copyEffects?: (authority: import('./profile-operation-lock.js').OperationMutationAuthority) => ProfileClosureCopyEffects): Promise<ManagedProfileDuplicateResult> {
  assertSafeProfileId(sourceProfileName); assertSafeProfileId(profileName);
  if (sourceProfileName === profileName) throw invalid('duplicate source and destination must differ');
  await services.beforeMutation?.(home);
  const sourceExpectation = await requiredProfile(services, home, sourceProfileName);
  const sourceStateSnapshot = await services.readManagedState(home, sourceProfileName);
  if ((sourceStateSnapshot?.sha256 ?? null) !== sourceExpectation.sidecarSha256) throw changed('source sidecar does not match its physical closure');
  const duplicateState = duplicateManagedProfileState(sourceStateSnapshot?.state, randomUUID(), physicalProfileLocalSkillNames(sourceExpectation.closure));
  await assertProfile(services, home, sourceProfileName, sourceExpectation);
  const assertSource = () => services.header.schemaVersion === 1 ? assertPhysicalProfileExpectation(home, sourceProfileName, sourceExpectation) : assertProfile(services, home, sourceProfileName, sourceExpectation);
  const swapped = await executeProfileCandidateSwap({
    home, services,
    profileName,
    operation: 'fresh-import',
    freshImportMustRemainInactive: true,
    additionalOperationLockKeys: [sourceProfileName],
    beforePublication: assertSource,
    materialize: async (candidatePath, context) => {
      assertOperationMutationAuthority(context.authority, home, [sourceProfileName, profileName, '@store'], context.transactionId);
      await copyPhysicalProfileClosureToCandidate(home, sourceProfileName, sourceExpectation, candidatePath, copyEffects?.(context.authority));
      await hooks.afterCandidateCopy?.();
      await assertSource();
      return duplicateState === undefined ? {} : { state: duplicateState };
    }
  });
  return { profileName, sourceProfileName, active: false, managed: duplicateState !== undefined, transactionId: swapped.transactionId };
}

export async function renameManagedProfile(home: string, oldName: string, newName: string, hooks: ManagedProfileRenameHooks = {}, services: ProfileLifecycleServices = defaultProfileLifecycleServices): Promise<ManagedProfileRenameResult> {
  assertSafeProfileId(oldName); assertSafeProfileId(newName);
  if (oldName === newName) throw invalid('rename source and destination must differ');
  await services.beforeMutation?.(home);
  const transactionId = newTransactionId();
  return services.withOperationLocks(home, [oldName, newName, '@store'], async (authority) => {
    const old = await requiredProfile(services, home, oldName);
    await services.assertAbsent(home, newName);
    const activeBefore = await services.readSelection(home);
    const favoritesBefore = await services.readFavorites(home);
    const activeAfter = activeBefore?.profileId === oldName ? newName : activeBefore?.profileId ?? null;
    const favoritesAfter = favoritesBefore.favorites.map((name) => name === oldName ? newName : name);
    const favoritesAfterSha256 = lifecycleFavoritesAfter(favoritesBefore, favoritesAfter);
    let journal: RenameLifecycleJournal = {
      ...services.header,
      kind: 'rename-profile',
      transactionId,
      oldName,
      newName,
      expectedOld: services.proof(old),
      expectedNew: { kind: 'absent' },
      activeBefore: activeBefore?.profileId ?? null,
      activeAfter,
      favoritesBeforeSha256: favoritesBefore.sha256,
      favoritesAfterCanonicalBytesSha256: favoritesAfterSha256,
      phase: 'INTENT'
    } as RenameLifecycleJournal;
    journal = await services.writeJournal(home, authority, journal);
    await hooks.afterPhase?.(journal.phase);
    const advance = async (phase: RenamePhase) => {
      journal = await services.writeJournal(home, authority, { ...journal, phase });
      await hooks.afterPhase?.(phase);
    };
    try {
      await services.withStateLock(home, oldName, async (lockAuthority) => {
        const stateAuthority = { assertHeld() { lockAuthority.assertHeld(); assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId); } };
        assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId);
        await assertProfile(services, home, oldName, old);
        await services.assertAbsent(home, newName);
        await assertSameActive(activeBefore, await services.readSelection(home));
        await assertFavoriteSnapshot(services, home, favoritesBefore);

        await advance('DIRECTORY_RENAME_INTENT');
        assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId);
        await services.move(home, oldName, newName, oldName, old, authority);
        await hooks.afterDirectoryRename?.();
        await assertRenamedProfile(services, home, newName, oldName, old);
        await advance('DIRECTORY_RENAME_PROVEN');

        await advance('ACTIVE_SELECTION_INTENT');
        assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId);
        if (activeAfter !== (activeBefore?.profileId ?? null)) await services.publishSelection(home, activeAfter!, stateAuthority, activeBefore, () => assertRenamedProfile(services, home, newName, oldName, old));
        if (((await services.readSelection(home))?.profileId ?? null) !== activeAfter) throw changed('active selection did not converge after rename');
        await advance('ACTIVE_SELECTION_PROVEN');

        await advance('FAVORITES_INTENT');
        assertOperationMutationAuthority(authority, home, [oldName, newName, '@store'], transactionId);
        if (favoritesAfterSha256 !== favoritesBefore.sha256) await services.publishFavorites(home, favoritesAfter, stateAuthority, favoritesBefore, () => assertRenamedProfile(services, home, newName, oldName, old));
        const finalFavorites = await services.readFavorites(home);
        if (finalFavorites.sha256 !== favoritesAfterSha256) throw changed('favorites did not converge after rename');
        await advance('FAVORITES_PROVEN');
        await assertRenamedProfile(services, home, newName, oldName, old);
        if (((await services.readSelection(home))?.profileId ?? null) !== activeAfter
          || (await services.readFavorites(home)).sha256 !== favoritesAfterSha256) throw changed('rename metadata changed before commit');
        await advance('COMMITTED');
      });
      return { oldName, newName, activeSelectionUpdated: activeAfter !== (activeBefore?.profileId ?? null), transactionId, journal };
    } catch (error) {
      if (services.header.schemaVersion === 1 && journal.phase !== 'COMMITTED' && journal.phase !== 'ABORTED' && journal.phase !== 'AMBIGUOUS') {
        const phase = journal.phase === 'INTENT' ? 'ABORTED' : 'AMBIGUOUS';
        await services.writeJournal(home, authority, { ...journal, phase }).catch(() => undefined);
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
  beforeMutation?(home: string): Promise<void>;
  beforeReturn?(): void | Promise<void>;
}
const defaultActivationServices: ManagedProfileActivationServices = {
  captureExpectation: captureOrdinaryProfileExpectation,
  assertExpectation: assertOrdinaryProfileExpectation,
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
  await reads.beforeMutation?.(home);
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

export async function removeManagedProfile(home: string, profileName: string, hooks: ManagedProfileRemovalHooks = {}, services: ProfileLifecycleServices = defaultProfileLifecycleServices): Promise<ManagedProfileRemovalResult> {
  assertSafeProfileId(profileName);
  await services.beforeMutation?.(home);
  const transactionId = newTransactionId();
  return services.withOperationLocks(home, [profileName, '@store'], async (authority) => {
    if(hooks.expectedRemovalIdentity!==undefined){const current=await services.removalIdentity(home,profileName);if(JSON.stringify(current)!==JSON.stringify(hooks.expectedRemovalIdentity))throw new BazframeError('PROFILE_REMOVE_AUTHORIZATION_STALE','Profile removal authorization is stale; review the profile again.');}
    const expected = await services.capture(home, profileName);
    // Windows confirmation is the physical expectation itself. Bind the journal baseline
    // to that exact token; POSIX keeps its distinct removal-identity representation.
    if (services.header.schemaVersion === 2 && hooks.expectedRemovalIdentity !== undefined
      && JSON.stringify(expected) !== JSON.stringify(hooks.expectedRemovalIdentity)) {
      throw new BazframeError('PROFILE_REMOVE_AUTHORIZATION_STALE', 'Profile removal authorization is stale; review the profile again.');
    }
    if(expected!==undefined&&(hooks.requireGeneratedEmpty===true||(services.header.schemaVersion===2&&hooks.expectedRemovalIdentity===undefined))){const content=expected.closure.entries.filter((entry)=>entry.kind!=='managed-sidecar'&&(services.header.schemaVersion!==2||entry.path!=='.bazframe-win32-executable.json'));if(content.length!==1||content[0]?.kind!=='file'||content[0].path!=='AGENTS.md'||content[0].bytes!==0)throw new BazframeError('PROFILE_NOT_EMPTY',`Profile is not generated-empty and cannot be removed without recursive confirmation: ${profileName}`);}
    if (expected === undefined) {
      await services.withStateLock(home, profileName, async (lockAuthority) => {
        const stateAuthority = { assertHeld() { lockAuthority.assertHeld(); assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId); } };
        assertOperationMutationAuthority(authority, home, [profileName, '@store'], transactionId);
        const favorites = await services.readFavorites(home);
        if (favorites.valid && favorites.favorites.includes(profileName)) await services.publishFavorites(home, favorites.favorites.filter((name) => name !== profileName), stateAuthority, favorites);
      });
      return { profileName, action: 'absent', retainedPath: null };
    }

    const active = await services.readSelection(home);
    if (active?.profileId === profileName) throw new BazframeError('ACTIVE_PROFILE_REMOVE_REFUSED', `Cannot remove active profile ${JSON.stringify(profileName)}.`);
    const favorites = await services.readFavorites(home);
    const afterNames = favorites.favorites.filter((name) => name !== profileName);
    const favoritesAfterSha256 = lifecycleFavoritesAfter(favorites, afterNames);
    let journal: RemoveLifecycleJournal = {
      ...services.header,
      kind: 'remove-profile',
      transactionId,
      profileName,
      expectedProfile: services.proof(expected),
      quarantine: { token: backupTransactionToken(transactionId) },
      activeBefore: active?.profileId ?? null,
      activeBeforeSha256: active?.contentSha256 ?? null,
      favoritesBeforeSha256: favorites.sha256,
      favoritesAfterCanonicalBytesSha256: favoritesAfterSha256,
      phase: 'INTENT'
    } as RemoveLifecycleJournal;
    journal = await services.writeJournal(home, authority, journal);
    await hooks.afterPhase?.('INTENT');
    try {
      journal = await completeProfileRemovalTransaction(home, journal, authority, hooks, services);
    } catch (error) {
      if (!(error instanceof BazframeError) || error.code !== 'PROFILE_RECOVERY_AMBIGUOUS') throw error;
      const current = await services.readJournal(home, transactionId);
      if (current.kind !== 'remove-profile') throw changed('remove journal kind changed');
      if (current.phase !== 'COMMITTED' && current.phase !== 'AMBIGUOUS') await services.writeJournal(home, authority, { ...current, phase: 'AMBIGUOUS' });
      throw error;
    }
    return { profileName, action: 'removed', retainedPath: services.path(home, physicalProfileSiblingForTransactionToken(journal.quarantine.token)), transactionId };
  }, transactionId);
}

async function requiredProfile(services: ProfileLifecycleServices, home: string, name: string): Promise<PhysicalProfileExpectation> {
  const value = await services.capture(home, name);
  if (value === undefined) throw changed('profile is absent');
  return value;
}
async function assertProfile(services: ProfileLifecycleServices, home: string, name: string, expected: PhysicalProfileExpectation): Promise<void> {
  const value = await requiredProfile(services, home, name);
  if (JSON.stringify(services.proof(value)) !== JSON.stringify(services.proof(expected))) throw changed('profile closure changed');
}
async function assertRenamedProfile(services: ProfileLifecycleServices, home: string, newName: string, oldName: string, expected: PhysicalProfileExpectation): Promise<void> {
  const current = await requiredProfile(services, home, newName);
  if (current.identity !== expected.identity || current.sidecarSha256 !== expected.sidecarSha256
    || JSON.stringify(current.closure.entries) !== JSON.stringify(expected.closure.entries)
    || current.closure.profileName !== newName || expected.closure.profileName !== oldName) throw changed('renamed profile does not preserve the source closure');
}
async function assertFavoriteSnapshot(services: ProfileLifecycleServices, home: string, expected: LifecycleFavorites): Promise<void> {
  const current = await services.readFavorites(home);
  if (current.sha256 !== expected.sha256 || current.valid !== expected.valid) throw changed('favorites changed before rename');
}
async function assertSameActive(left: LifecycleSelection | undefined, right: LifecycleSelection | undefined): Promise<void> {
  if (left?.binding !== right?.binding || left?.profileId !== right?.profileId) throw changed('active selection changed before rename');
}
function changed(detail: string): BazframeError { return new BazframeError('PROFILE_MANAGED_LIFECYCLE_CHANGED', `Managed profile lifecycle changed or became ambiguous: ${detail}.`); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_MANAGED_LIFECYCLE_INVALID', `Invalid managed profile lifecycle: ${detail}.`); }
