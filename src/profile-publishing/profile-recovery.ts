import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { encodeProfileFavorites, profileFavoritesPath, readProfileFavorites, writeProfileFavoritesUnlocked } from '../profiles/profile-favorites.js';
import { profileDirectory, readOptionalActiveProfileSnapshot } from '../profiles/profile-store.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import {
  assertBlobBytes,
  capturedProfileContentBaselineSha256,
  decodeCapturedProfileBytes,
  encodeCapturedProfile,
  profileInstanceIdFromPhysicalIdentity,
  type CapturedProfileV1,
  type Sha256
} from './captured-profile.js';
import { readOptionalManagedProfileState } from './managed-profile-state.js';
import { assertPhysicalDirectoryIdentity, openStablePhysicalDirectory } from './profile-filesystem.js';
import { encodeManagedProfileState, type ManagedProfileStateV1, type PublicationState } from './publication-state.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import {
  capturePhysicalCandidateExpectation,
  capturePhysicalProfileExpectation,
  type PhysicalProfileExpectation
} from './physical-profile-closure.js';
import { assertOperationMutationAuthority, tryWithProfileOperationLocks, type OperationMutationAuthority } from './profile-operation-lock.js';
import { buildPublishedProfileState, recoverPublishedSidecarCandidate } from './profile-publication.js';
import {
  backupTransactionToken,
  isTransactionJournalName,
  physicalProfileSiblingForTransactionToken,
  readTransactionJournal,
  writeTransactionJournal,
  type CandidatePhase,
  type CandidateSwapJournalV1,
  type PublicationJournalV1,
  type RemovePhase,
  type RemoveProfileJournalV1,
  type RenamePhase,
  type RenameProfileJournalV1,
  type TransactionJournalV1
} from './transaction-journal.js';

export interface PublicationRecoveryBlob { sha256: Sha256; bytes: number; bytesValue: Uint8Array }
export interface PublicationRecoveryProof {
  repositoryIdentityProven: boolean;
  repositoryId: number;
  origin: string;
  visibility: 'private' | 'public';
  tip: string;
  tipParent: string | null;
  tree: string;
  canonicalTreeProven: boolean;
  capturedManifestSha256: Sha256;
  manifestBytes: Uint8Array;
  profile: CapturedProfileV1;
  blobs: readonly PublicationRecoveryBlob[];
}
export type PublicationRecoveryRepositoryProof = Pick<
  PublicationRecoveryProof,
  'repositoryIdentityProven' | 'repositoryId' | 'origin' | 'visibility'
>;
export interface ProfilePublicationRecoveryAdapter {
  /** Repository-only proof supports pre-push recovery when refs/heads/main is still absent. */
  proveRepository?(journal: PublicationJournalV1): Promise<PublicationRecoveryRepositoryProof>;
  prove(journal: PublicationJournalV1): Promise<PublicationRecoveryProof>;
  setRepositoryVisibility?(journal: PublicationJournalV1, visibility: 'private' | 'public'): Promise<PublicationRecoveryRepositoryProof>;
  setVisibility?(journal: PublicationJournalV1, visibility: 'private' | 'public'): Promise<PublicationRecoveryProof>;
}
export interface ProfileRecoveryResult {
  transactionId: string;
  kind: 'candidate-swap' | 'rename-profile' | 'remove-profile' | 'publication';
  action: 'skipped-busy' | 'aborted' | 'committed' | 'ambiguous' | 'terminal';
}

const CANDIDATE_EXISTING: CandidatePhase[] = ['PLANNED','MATERIALIZING','PACKAGES_LAST','CANDIDATE_READY','OLD_RENAME_INTENT','OLD_RENAME_PROVEN','CANDIDATE_RENAME_INTENT','CANDIDATE_RENAME_PROVEN','ACTIVE_SELECTION_PROVEN','COMMITTED'];
const CANDIDATE_FRESH: CandidatePhase[] = ['PLANNED','MATERIALIZING','PACKAGES_LAST','CANDIDATE_READY','CANDIDATE_RENAME_INTENT','CANDIDATE_RENAME_PROVEN','ACTIVE_SELECTION_PROVEN','COMMITTED'];
const PUBLICATION_PHASES: PublicationJournalV1['phase'][] = ['INTENT','REPOSITORY_CREATED','PRIVATE_BEFORE_PUSH_INTENT','PRIVATE_BEFORE_PUSH_PROVEN','PUSH_INTENT','COMMIT_PUSH_PROVEN','PUBLIC_AFTER_PUSH_INTENT','PUBLIC_AFTER_PUSH_PROVEN','LOCAL_STATE_INTENT','LOCAL_STATE_PROVEN','COMMITTED'];
const RENAME_PHASES: RenamePhase[] = ['INTENT','DIRECTORY_RENAME_INTENT','DIRECTORY_RENAME_PROVEN','ACTIVE_SELECTION_INTENT','ACTIVE_SELECTION_PROVEN','FAVORITES_INTENT','FAVORITES_PROVEN','COMMITTED'];
const REMOVE_PHASES: RemovePhase[] = ['INTENT','FAVORITES_MUTATION_INTENT','FAVORITES_MUTATION_PROVEN','DIRECTORY_QUARANTINE_INTENT','DIRECTORY_QUARANTINE_PROVEN','COMMITTED'];
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const TEMPORARY_JOURNAL = /^\.tmp-[a-f0-9]{32}$/u;

export async function recoverProfilePublishingTransactions(home: string, publication?: ProfilePublicationRecoveryAdapter): Promise<ProfileRecoveryResult[]> {
  const names = await scanTransactionNamespace(home);
  const results: ProfileRecoveryResult[] = [];
  for (const name of names) {
    const transactionId = name.slice(0, -5);
    const discovered = await readTransactionJournal(home, transactionId);
    const keys = operationKeys(discovered);
    const attempted = await tryWithProfileOperationLocks(home, keys, async (authority) => {
      const journal = await readTransactionJournal(home, transactionId);
      if (!sameOperationIdentity(discovered, journal)) throw invalid('transaction journal identity changed while acquiring its operation locks');
      assertOperationMutationAuthority(authority, home, operationKeys(journal), transactionId);
      if (isTerminal(journal)) {
        if (journal.phase === 'COMMITTED') {
          try { await cleanupCommittedJournal(home, journal, authority); }
          catch (error) { if (isPredicateMismatch(error)) return result(journal, 'ambiguous'); throw error; }
        }
        return result(journal, 'terminal');
      }
      if (journal.kind === 'candidate-swap') return recoverCandidate(home, journal, authority);
      if (journal.kind === 'rename-profile') return recoverRename(home, journal, authority);
      if (journal.kind === 'remove-profile') return recoverRemove(home, journal, authority);
      return recoverPublication(home, journal, authority, publication);
    }, transactionId);
    results.push(attempted.kind === 'busy' ? { transactionId, kind: discovered.kind, action: 'skipped-busy' } : attempted.value);
  }
  return results;
}

async function scanTransactionNamespace(home: string): Promise<string[]> {
  const root = join(home, 'profile-publishing', 'transactions');
  let stable: Awaited<ReturnType<typeof openStablePhysicalDirectory>>;
  try { stable = await openStablePhysicalDirectory(root, home); }
  catch (error) { if (errorCode(error) === 'ENOENT' || (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT')) return []; throw error; }
  const journals: string[] = [];
  let count = 0;
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    await assertPhysicalDirectoryIdentity(stable);
    directory = await opendir(stable.handlePath ?? stable.path);
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      count += 1;
      if (count > PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) throw invalid('transaction journal namespace exceeds its bounded entry limit');
      if (isTransactionJournalName(entry.name) && entry.isFile()) journals.push(entry.name);
      else if (!(TEMPORARY_JOURNAL.test(entry.name) && entry.isFile())) throw invalid('transaction journal namespace contains an unknown or non-file entry');
    }
    await assertPhysicalDirectoryIdentity(stable);
  } finally {
    await directory?.close().catch(() => undefined);
    await stable.handle.close().catch(() => undefined);
  }
  return journals.sort();
}

async function recoverCandidate(home: string, initial: CandidateSwapJournalV1, authority: OperationMutationAuthority): Promise<ProfileRecoveryResult> {
  let journal = initial;
  const profiles = join(home, 'profiles');
  const destination = profileDirectory(home, journal.profileName);
  const candidatePath = join(profiles, physicalProfileSiblingForTransactionToken(journal.candidate.token));
  const backupPath = join(profiles, physicalProfileSiblingForTransactionToken(backupTransactionToken(journal.transactionId)));
  const advance = async (phase: CandidatePhase, updates: Partial<CandidateSwapJournalV1> = {}) => {
    journal = await writeTransactionJournal(home, authority, { ...journal, ...updates, phase } as CandidateSwapJournalV1);
  };
  try {
    const active = await readOptionalActiveProfileSnapshot(home);
    if ((active?.profileId ?? null) !== journal.activeProfileBefore) throw ambiguous();
    const [current, candidate, backup] = await Promise.all([
      optionalProfile(home, journal.profileName), optionalCandidate(home, candidatePath, journal.profileName), optionalCandidate(home, backupPath, journal.profileName)
    ]);
    const old = journal.expectedOld.kind === 'physical-directory' ? journal.expectedOld : undefined;
    const candidateExpected = journal.candidate.identity === null || journal.candidate.profileClosureSha256 === null
      ? undefined
      : { identity: journal.candidate.identity, sidecarSha256: journal.candidate.sidecarSha256, profileClosureSha256: journal.candidate.profileClosureSha256 };
    const oldMatches = (value: PhysicalProfileExpectation | undefined) => old !== undefined && matches(value, old);
    const candidateMatches = (value: PhysicalProfileExpectation | undefined) => candidateExpected !== undefined && matches(value, candidateExpected);
    if (journal.phase === 'PLANNED' || journal.phase === 'MATERIALIZING' || journal.phase === 'PACKAGES_LAST') {
      if ((old === undefined ? current === undefined : oldMatches(current)) && backup === undefined) { await advance('ABORTED'); return result(journal, 'aborted'); }
      throw ambiguous();
    }
    if (journal.phase === 'CANDIDATE_READY' && old !== undefined && oldMatches(current) && backup === undefined) {
      if (candidateMatches(candidate)) await removeProvedDirectory(profiles, candidatePath, candidate!);
      else if (candidate !== undefined) throw ambiguous();
      await advance('ABORTED');
      return result(journal, 'aborted');
    }
    await withStateLock(join(home, 'locks', 'state.lock'), { command: 'profile-recovery', target: journal.profileName }, async () => {
      assertOperationMutationAuthority(authority, home, [journal.profileName, '@store'], journal.transactionId);
      if ((await readOptionalActiveProfileSnapshot(home))?.profileId !== (journal.activeProfileBefore ?? undefined)) throw ambiguous();
      if (old === undefined) {
        if (current === undefined && candidateMatches(candidate)) {
          await advanceCandidateTo(advance, () => journal, 'CANDIDATE_RENAME_INTENT');
          await rename(candidatePath, destination); await syncDirectory(profiles);
        } else if (!candidateMatches(current) || candidate !== undefined) throw ambiguous();
      } else {
        if (oldMatches(current) && candidateMatches(candidate) && backup === undefined) {
          await advanceCandidateTo(advance, () => journal, 'OLD_RENAME_INTENT');
          await rename(destination, backupPath); await syncDirectory(profiles);
        }
        const nowCurrent = await optionalProfile(home, journal.profileName);
        const nowCandidate = await optionalCandidate(home, candidatePath, journal.profileName);
        const nowBackup = await optionalCandidate(home, backupPath, journal.profileName);
        if (nowCurrent === undefined && oldMatches(nowBackup) && candidateMatches(nowCandidate)) {
          await advanceCandidateTo(advance, () => journal, 'OLD_RENAME_PROVEN', nowBackup!);
          await advanceCandidateTo(advance, () => journal, 'CANDIDATE_RENAME_INTENT');
          await rename(candidatePath, destination); await syncDirectory(profiles);
        } else if (candidateMatches(nowCurrent) && oldMatches(nowBackup) && nowCandidate === undefined) {
          await advanceCandidateTo(advance, () => journal, 'CANDIDATE_RENAME_INTENT', nowBackup!);
        } else throw ambiguous();
      }
      const published = await capturePhysicalProfileExpectation(home, journal.profileName);
      if (!candidateMatches(published)) throw ambiguous();
      if ((await readOptionalActiveProfileSnapshot(home))?.profileId !== (journal.activeProfileBefore ?? undefined)) throw ambiguous();
      await advanceCandidateTo(advance, () => journal, 'COMMITTED');
    }, { managedRoot: home });
    if (old !== undefined) {
      assertOperationMutationAuthority(authority, home, [journal.profileName, '@store'], journal.transactionId);
      await cleanupExactOrAbsentCandidate(profiles, backupPath, journal.profileName, old);
    }
    return result(journal, 'committed');
  } catch (error) {
    if (!isPredicateMismatch(error)) throw error;
    if (!isTerminal(journal)) await advance('AMBIGUOUS');
    return result(journal, 'ambiguous');
  }
}

async function advanceCandidateTo(
  advance: (phase: CandidatePhase, updates?: Partial<CandidateSwapJournalV1>) => Promise<void>,
  current: () => CandidateSwapJournalV1,
  target: CandidatePhase,
  backup?: PhysicalProfileExpectation
): Promise<void> {
  const route = current().expectedOld.kind === 'absent' ? CANDIDATE_FRESH : CANDIDATE_EXISTING;
  while (current().phase !== target) {
    const index = route.indexOf(current().phase);
    const targetIndex = route.indexOf(target);
    if (index < 0 || targetIndex < index) return;
    const next = route[index + 1];
    if (next === undefined) throw ambiguous();
    const updates = next === 'OLD_RENAME_PROVEN'
      ? { backup: backup === undefined ? current().backup : { token: backupTransactionToken(current().transactionId), identity: backup.identity, profileClosureSha256: backup.profileClosureSha256 } }
      : {};
    if (next === 'OLD_RENAME_PROVEN' && updates.backup === null) throw ambiguous();
    await advance(next, updates);
  }
}

async function recoverRename(home: string, initial: RenameProfileJournalV1, authority: OperationMutationAuthority): Promise<ProfileRecoveryResult> {
  let journal = initial;
  const profiles = join(home, 'profiles');
  const oldPath = profileDirectory(home, journal.oldName);
  const newPath = profileDirectory(home, journal.newName);
  const advance = async (phase: RenamePhase) => { journal = await writeTransactionJournal(home, authority, { ...journal, phase }); };
  try {
    await withStateLock(join(home, 'locks', 'state.lock'), { command: 'profile-rename-recovery', target: journal.oldName }, async () => {
      let old = await optionalProfile(home, journal.oldName);
      let renamed = await optionalProfile(home, journal.newName);
      if (journal.phase === 'INTENT') {
        if (!matches(old, journal.expectedOld) || renamed !== undefined || !await renameMetadataAtBefore(home, journal)) throw ambiguous();
        await advance('ABORTED');
        return;
      }
      assertOperationMutationAuthority(authority, home, [journal.oldName, journal.newName, '@store'], journal.transactionId);
      if (matches(old, journal.expectedOld) && renamed === undefined && journal.phase === 'DIRECTORY_RENAME_INTENT') {
        await rename(oldPath, newPath); await syncDirectory(profiles);
        old = undefined; renamed = await optionalProfile(home, journal.newName);
      }
      if (old !== undefined || !matchesRenamed(renamed, journal.expectedOld, journal.oldName)) throw ambiguous();
      await advanceRenameTo(advance, () => journal, 'DIRECTORY_RENAME_PROVEN');
      await advanceRenameTo(advance, () => journal, 'ACTIVE_SELECTION_INTENT');
      assertOperationMutationAuthority(authority, home, [journal.oldName, journal.newName, '@store'], journal.transactionId);
      await recoverActiveRename(home, journal);
      await advanceRenameTo(advance, () => journal, 'ACTIVE_SELECTION_PROVEN');
      await advanceRenameTo(advance, () => journal, 'FAVORITES_INTENT');
      assertOperationMutationAuthority(authority, home, [journal.oldName, journal.newName, '@store'], journal.transactionId);
      await recoverFavoriteRename(home, journal);
      await advanceRenameTo(advance, () => journal, 'FAVORITES_PROVEN');
      await advanceRenameTo(advance, () => journal, 'COMMITTED');
    }, { managedRoot: home });
    return result(journal, journal.phase === 'ABORTED' ? 'aborted' : 'committed');
  } catch (error) {
    if (!isPredicateMismatch(error)) throw error;
    if (!isTerminal(journal)) await writeTransactionJournal(home, authority, { ...journal, phase: 'AMBIGUOUS' });
    return result(journal, 'ambiguous');
  }
}

export interface ProfileRemovalRecoveryHooks {
  afterPhase?(phase: RemovePhase): void | Promise<void>;
  afterFavoritesMutation?(): void | Promise<void>;
  afterDirectoryQuarantine?(): void | Promise<void>;
}

/** Continue an authorized present-profile removal from its last durable phase. */
export async function completeProfileRemovalTransaction(
  home: string,
  initial: RemoveProfileJournalV1,
  authority: OperationMutationAuthority,
  hooks: ProfileRemovalRecoveryHooks = {}
): Promise<RemoveProfileJournalV1> {
  let journal = initial;
  if (!REMOVE_PHASES.includes(journal.phase)) throw ambiguous();
  const profiles = join(home, 'profiles');
  const sourcePath = profileDirectory(home, journal.profileName);
  const quarantinePath = join(profiles, physicalProfileSiblingForTransactionToken(journal.quarantine.token));
  const advance = async (phase: RemovePhase) => {
    journal = await writeTransactionJournal(home, authority, { ...journal, phase });
    await hooks.afterPhase?.(phase);
  };
  await withStateLock(join(home, 'locks', 'state.lock'), { command: 'profile-remove-recovery', target: journal.profileName }, async () => {
    assertOperationMutationAuthority(authority, home, [journal.profileName, '@store'], journal.transactionId);
    await assertRemoveActiveBaseline(home, journal);

    if (journal.phase === 'INTENT') {
      const source = await optionalRemoveProfile(home, journal.profileName);
      const quarantine = await optionalRemoveCandidate(home, quarantinePath, journal.profileName);
      if (!matches(source, journal.expectedProfile) || quarantine !== undefined) throw ambiguous();
      const favorites = await readFavoriteSnapshot(home);
      if (favorites.sha256 !== journal.favoritesBeforeSha256) throw ambiguous();
      await advance('FAVORITES_MUTATION_INTENT');
    }

    if (journal.phase === 'FAVORITES_MUTATION_INTENT') {
      await assertRemoveActiveBaseline(home, journal);
      const source = await optionalRemoveProfile(home, journal.profileName);
      const quarantine = await optionalRemoveCandidate(home, quarantinePath, journal.profileName);
      if (!matches(source, journal.expectedProfile) || quarantine !== undefined) throw ambiguous();
      let favorites = await readFavoriteSnapshot(home);
      if (favorites.sha256 === journal.favoritesBeforeSha256) {
        const afterNames = favorites.favorites.filter((name) => name !== journal.profileName);
        const expectedAfter = favorites.sha256 === null && afterNames.length === 0
          ? null
          : sha(Buffer.from(encodeProfileFavorites(afterNames)));
        if (expectedAfter !== journal.favoritesAfterCanonicalBytesSha256) throw ambiguous();
        if (expectedAfter !== favorites.sha256) {
          assertOperationMutationAuthority(authority, home, [journal.profileName, '@store'], journal.transactionId);
          await writeProfileFavoritesUnlocked(home, afterNames);
          await hooks.afterFavoritesMutation?.();
          favorites = await readFavoriteSnapshot(home);
        }
      }
      if (favorites.sha256 !== journal.favoritesAfterCanonicalBytesSha256) throw ambiguous();
      await advance('FAVORITES_MUTATION_PROVEN');
    }

    if (journal.phase === 'FAVORITES_MUTATION_PROVEN') await advance('DIRECTORY_QUARANTINE_INTENT');

    if (journal.phase === 'DIRECTORY_QUARANTINE_INTENT') {
      await assertRemoveActiveBaseline(home, journal);
      if ((await readFavoriteSnapshot(home)).sha256 !== journal.favoritesAfterCanonicalBytesSha256) throw ambiguous();
      let source = await optionalRemoveProfile(home, journal.profileName);
      let quarantine = await optionalRemoveCandidate(home, quarantinePath, journal.profileName);
      if (matches(source, journal.expectedProfile) && quarantine === undefined) {
        assertOperationMutationAuthority(authority, home, [journal.profileName, '@store'], journal.transactionId);
        await rename(sourcePath, quarantinePath);
        await syncDirectory(profiles);
        await hooks.afterDirectoryQuarantine?.();
        source = await optionalRemoveProfile(home, journal.profileName);
        quarantine = await optionalRemoveCandidate(home, quarantinePath, journal.profileName);
      }
      if (source !== undefined || !matches(quarantine, journal.expectedProfile)) throw ambiguous();
      await advance('DIRECTORY_QUARANTINE_PROVEN');
    }

    if (journal.phase === 'DIRECTORY_QUARANTINE_PROVEN') {
      if ((await readFavoriteSnapshot(home)).sha256 !== journal.favoritesAfterCanonicalBytesSha256
        || await optionalRemoveProfile(home, journal.profileName) !== undefined
        || !matches(await optionalRemoveCandidate(home, quarantinePath, journal.profileName), journal.expectedProfile)) throw ambiguous();
      await assertRemoveActiveBaseline(home, journal);
      await advance('COMMITTED');
    }
    if (journal.phase !== 'COMMITTED') throw ambiguous();
  }, { managedRoot: home });
  return journal;
}

async function recoverRemove(home: string, initial: RemoveProfileJournalV1, authority: OperationMutationAuthority): Promise<ProfileRecoveryResult> {
  let journal = initial;
  try {
    journal = await completeProfileRemovalTransaction(home, journal, authority);
    return result(journal, 'committed');
  } catch (error) {
    if (!isRemovePredicateMismatch(error)) throw error;
    const current = await readTransactionJournal(home, initial.transactionId);
    if (current.kind !== 'remove-profile') throw invalid('remove journal kind changed during recovery');
    journal = current;
    if (!isTerminal(journal)) journal = await writeTransactionJournal(home, authority, { ...journal, phase: 'AMBIGUOUS' });
    return result(journal, 'ambiguous');
  }
}

async function assertRemoveActiveBaseline(home: string, journal: RemoveProfileJournalV1): Promise<void> {
  let current;
  try { current = await readOptionalActiveProfileSnapshot(home); }
  catch (error) { if (isRemoveStructuralMismatch(error)) throw ambiguous(); throw error; }
  if ((current?.profileId ?? null) !== journal.activeBefore || (current?.contentSha256 ?? null) !== journal.activeBeforeSha256) throw ambiguous();
}

async function optionalRemoveProfile(home: string, profileName: string): Promise<PhysicalProfileExpectation | undefined> {
  try { return await optionalProfile(home, profileName); }
  catch (error) { if (isRemoveStructuralMismatch(error)) throw ambiguous(); throw error; }
}
async function optionalRemoveCandidate(home: string, path: string, profileName: string): Promise<PhysicalProfileExpectation | undefined> {
  try { return await optionalCandidate(home, path, profileName); }
  catch (error) { if (isRemoveStructuralMismatch(error)) throw ambiguous(); throw error; }
}
function isRemovePredicateMismatch(error: unknown): boolean {
  return isPredicateMismatch(error) || isRemoveStructuralMismatch(error);
}
function isRemoveStructuralMismatch(error: unknown): boolean {
  return error instanceof BazframeError && [
    'INVALID_ACTIVE_PROFILE_STATE', 'PROFILE_FAVORITES_INVALID',
    'PROFILE_PHYSICAL_CLOSURE_INVALID', 'PROFILE_PHYSICAL_CLOSURE_CHANGED',
    'PROFILE_PUBLISHING_DIRECTORY_INVALID', 'PROFILE_PUBLISHING_DIRECTORY_CHANGED',
    'PROFILE_PUBLISHING_FILE_INVALID', 'PROFILE_PUBLISHING_FILE_CHANGED'
  ].includes(error.code);
}

async function advanceRenameTo(advance: (phase: RenamePhase) => Promise<void>, current: () => RenameProfileJournalV1, target: RenamePhase): Promise<void> {
  while (current().phase !== target) {
    const index = RENAME_PHASES.indexOf(current().phase);
    const targetIndex = RENAME_PHASES.indexOf(target);
    if (index < 0 || targetIndex < index) return;
    const next = RENAME_PHASES[index + 1];
    if (next === undefined) throw ambiguous();
    await advance(next);
  }
}

async function recoverActiveRename(home: string, journal: RenameProfileJournalV1): Promise<void> {
  const current = (await readOptionalActiveProfileSnapshot(home))?.profileId ?? null;
  if (current === journal.activeAfter) return;
  if (current !== journal.activeBefore) throw ambiguous();
  if (journal.activeAfter === null) {
    if (journal.activeBefore !== null) throw ambiguous();
    return;
  }
  await writeFileAtomic(join(home, 'active-profile'), `${journal.activeAfter}\n`, { managedRoot: home, commitOnRename: true });
  if ((await readOptionalActiveProfileSnapshot(home))?.profileId !== journal.activeAfter) throw ambiguous();
}

async function recoverFavoriteRename(home: string, journal: RenameProfileJournalV1): Promise<void> {
  const before = await readFavoriteSnapshot(home);
  if (before.sha256 === journal.favoritesAfterCanonicalBytesSha256) return;
  if (before.sha256 !== journal.favoritesBeforeSha256) throw ambiguous();
  const afterNames = before.favorites.map((name) => name === journal.oldName ? journal.newName : name);
  const afterBytes = Buffer.from(encodeProfileFavorites(afterNames));
  if (sha(afterBytes) !== journal.favoritesAfterCanonicalBytesSha256) throw ambiguous();
  await writeProfileFavoritesUnlocked(home, afterNames);
  if ((await readFavoriteSnapshot(home)).sha256 !== journal.favoritesAfterCanonicalBytesSha256) throw ambiguous();
}

async function renameMetadataAtBefore(home: string, journal: RenameProfileJournalV1): Promise<boolean> {
  const active = (await readOptionalActiveProfileSnapshot(home))?.profileId ?? null;
  const favorites = await readFavoriteSnapshot(home);
  return active === journal.activeBefore && favorites.sha256 === journal.favoritesBeforeSha256;
}

async function readFavoriteSnapshot(home: string): Promise<{ sha256: string | null; favorites: string[] }> {
  const path = profileFavoritesPath(home);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const bytes = await handle.readFile();
      const state = await readProfileFavorites(home);
      const canonical = Buffer.from(encodeProfileFavorites(state.favorites));
      if (!bytes.equals(canonical)) throw ambiguous();
      return { sha256: sha(bytes), favorites: state.favorites };
    } finally { await handle.close(); }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { sha256: null, favorites: [] };
    if (isRemoveStructuralMismatch(error)) throw ambiguous();
    throw error;
  }
}

async function recoverPublication(home: string, initial: PublicationJournalV1, authority: OperationMutationAuthority, adapter?: ProfilePublicationRecoveryAdapter): Promise<ProfileRecoveryResult> {
  let journal = initial;
  const advance = async (phase: PublicationJournalV1['phase'], updates: Partial<PublicationJournalV1> = {}) => {
    journal = await writeTransactionJournal(home, authority, { ...journal, ...updates, phase } as PublicationJournalV1);
  };
  try {
    if (adapter === undefined) throw new BazframeError('PROFILE_RECOVERY_ADAPTER_REQUIRED', 'Publication recovery requires a GitHub recovery adapter.');
    if (journal.phase === 'PRIVATE_BEFORE_PUSH_INTENT' || journal.phase === 'PRIVATE_BEFORE_PUSH_PROVEN') {
      let privateProof = adapter.proveRepository === undefined
        ? await adapter.prove(journal)
        : await adapter.proveRepository(journal);
      validateRepositoryIdentity(journal, privateProof);
      const prePushVisibility = journal.originalVisibility === 'absent' || journal.desiredVisibility === 'private'
        ? 'private'
        : journal.originalVisibility;
      if (privateProof.visibility !== prePushVisibility) {
        if (adapter.setRepositoryVisibility !== undefined) privateProof = await adapter.setRepositoryVisibility(journal, prePushVisibility);
        else {
          if (adapter.setVisibility === undefined) throw ambiguous();
          privateProof = await adapter.setVisibility(journal, prePushVisibility);
        }
        validateRepositoryIdentity(journal, privateProof);
        if (privateProof.visibility !== prePushVisibility) throw ambiguous();
      }
      if (journal.phase === 'PRIVATE_BEFORE_PUSH_INTENT') await advance('PRIVATE_BEFORE_PUSH_PROVEN');
      throw ambiguous();
    }
    if (phaseIndex(PUBLICATION_PHASES, journal.phase) < phaseIndex(PUBLICATION_PHASES, 'PUSH_INTENT')) throw ambiguous();
    let proof = await adapter.prove(journal);
    let provedProfile = validateRemoteProof(journal, proof);
    if (journal.phase === 'PUSH_INTENT') await advance('COMMIT_PUSH_PROVEN', { observedCommit: proof.tip });
    else if (journal.observedCommit !== proof.tip) throw ambiguous();
    if (journal.phase === 'COMMIT_PUSH_PROVEN') await advance('PUBLIC_AFTER_PUSH_INTENT');
    const desired = journal.desiredVisibility === 'preserve'
      ? journal.originalVisibility === 'absent' ? 'private' : journal.originalVisibility
      : journal.desiredVisibility;
    if (proof.visibility !== desired) {
      if (adapter.setVisibility === undefined) throw ambiguous();
      proof = await adapter.setVisibility(journal, desired);
      provedProfile = validateRemoteProof(journal, proof);
      if (proof.visibility !== desired) throw ambiguous();
    }
    if (journal.phase === 'PUBLIC_AFTER_PUSH_INTENT') await advance('PUBLIC_AFTER_PUSH_PROVEN');
    const previousState = await exactPreviousState(home, journal);
    const publication: PublicationState = {
      transport: 'git', origin: journal.origin, installedCommit: proof.tip, latestSeenCommit: proof.tip,
      baselineCaptureSha256: capturedProfileContentBaselineSha256(provedProfile, capturedProfileLimitPolicy()), visibility: desired
    };
    const desiredState = await recoverableDesiredState(home, journal, previousState, provedProfile, publication);
    const desiredSha = sha(Buffer.from(encodeManagedProfileState(desiredState, capturedProfileLimitPolicy())));
    const local = await optionalManagedState(home, journal.profileName);
    if (local !== undefined && local.sha256 !== journal.expectedProfile.sidecarSha256 && local.sha256 !== desiredSha) throw ambiguous();
    if (journal.phase === 'PUBLIC_AFTER_PUSH_PROVEN') await advance('LOCAL_STATE_INTENT');
    await recoverPublishedSidecarCandidate(home, journal.profileName, journal.expectedProfile, desiredState, authority);
    const after = await readOptionalManagedProfileState(home, journal.profileName);
    if (after?.sha256 !== desiredSha) throw ambiguous();
    if (journal.phase === 'LOCAL_STATE_INTENT') await advance('LOCAL_STATE_PROVEN');
    if (journal.phase === 'LOCAL_STATE_PROVEN') await advance('COMMITTED');
    await cleanupPublicationBackup(home, journal);
    return result(journal, 'committed');
  } catch (error) {
    if (!isPredicateMismatch(error)) throw error;
    if (!isTerminal(journal)) await advance('AMBIGUOUS');
    return result(journal, 'ambiguous');
  }
}

function validateRepositoryIdentity(journal: PublicationJournalV1, proof: PublicationRecoveryRepositoryProof): void {
  if (!proof.repositoryIdentityProven || journal.repositoryId === null || proof.repositoryId !== journal.repositoryId || proof.origin !== journal.origin) throw ambiguous();
}

function validateRemoteProof(journal: PublicationJournalV1, proof: PublicationRecoveryProof): CapturedProfileV1 {
  validateRepositoryIdentity(journal, proof);
  if (proof.tipParent !== journal.expectedBaseCommit || !COMMIT.test(proof.tip)
    || !COMMIT.test(proof.tree) || !proof.canonicalTreeProven || (journal.observedCommit !== null && proof.tip !== journal.observedCommit)) throw ambiguous();
  const policy = capturedProfileLimitPolicy();
  let profile: CapturedProfileV1;
  try { profile = decodeCapturedProfileBytes(proof.manifestBytes, policy); }
  catch { throw ambiguous(); }
  let suppliedManifest: string;
  try { suppliedManifest = encodeCapturedProfile(proof.profile, policy); }
  catch { throw ambiguous(); }
  if (profile.profile.name !== journal.profileName || !Buffer.from(suppliedManifest).equals(Buffer.from(proof.manifestBytes))
    || sha(proof.manifestBytes) !== journal.capturedManifestSha256 || proof.capturedManifestSha256 !== journal.capturedManifestSha256
    || proof.blobs.length !== profile.blobs.length) throw ambiguous();
  for (let index = 0; index < profile.blobs.length; index += 1) {
    const expected = profile.blobs[index]!;
    const actual = proof.blobs[index];
    if (actual === undefined || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw ambiguous();
    try { assertBlobBytes(expected, actual.bytesValue); } catch { throw ambiguous(); }
  }
  return profile;
}

async function recoverableDesiredState(
  home: string,
  journal: PublicationJournalV1,
  previous: ManagedProfileStateV1 | undefined,
  profile: CapturedProfileV1,
  publication: PublicationState
): Promise<ManagedProfileStateV1> {
  if (previous !== undefined) return buildPublishedProfileState(previous, profile.resources, publication);
  const paths = [join(home, 'profiles', `.bazframe-candidate-${journal.transactionId}`), profileDirectory(home, journal.profileName)];
  for (const path of paths) {
    const found = await stateFromReserved(home, path);
    if (found === undefined) continue;
    const seed: ManagedProfileStateV1 = { schemaVersion: 1, profileInstanceId: found.state.profileInstanceId, publication: null, capturedResourceIds: [], importedResources: [] };
    const expected = buildPublishedProfileState(seed, profile.resources, publication);
    if (encodeManagedProfileState(expected, capturedProfileLimitPolicy()) === encodeManagedProfileState(found.state, capturedProfileLimitPolicy())) return expected;
  }
  return buildPublishedProfileState(undefined, profile.resources, publication, profileInstanceIdFromPhysicalIdentity(journal.expectedProfile.identity));
}

async function exactPreviousState(home: string, journal: PublicationJournalV1): Promise<ManagedProfileStateV1 | undefined> {
  if (journal.expectedProfile.sidecarSha256 === null) return undefined;
  const current = await optionalManagedState(home, journal.profileName);
  if (current?.sha256 === journal.expectedProfile.sidecarSha256) return current.state;
  const backup = await stateFromReserved(home, join(home, 'profiles', `.bazframe-backup-${journal.transactionId}`));
  if (backup?.sha256 === journal.expectedProfile.sidecarSha256) return backup.state;
  throw ambiguous();
}

async function optionalManagedState(home: string, profileName: string) {
  try { return await readOptionalManagedProfileState(home, profileName); }
  catch (error) { if (absent(error)) return undefined; throw error; }
}
async function stateFromReserved(home: string, path: string): Promise<{ state: ManagedProfileStateV1; sha256: string } | undefined> {
  const logicalName = path.includes('.bazframe-') ? undefined : path.split('/').at(-1);
  void logicalName;
  try {
    const file = await open(join(path, '.bazframe-profile-state.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const bytes = await file.readFile();
      const { decodeManagedProfileStateBytes } = await import('./publication-state.js');
      return { state: decodeManagedProfileStateBytes(bytes, capturedProfileLimitPolicy()), sha256: sha(bytes) };
    } finally { await file.close(); }
  } catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error; }
}

async function cleanupCommittedJournal(home: string, journal: TransactionJournalV1, authority: OperationMutationAuthority): Promise<void> {
  assertOperationMutationAuthority(authority, home, operationKeys(journal), journal.transactionId);
  if (journal.kind === 'candidate-swap') {
    if (journal.expectedOld.kind === 'physical-directory') await cleanupExactOrAbsentCandidate(join(home, 'profiles'), join(home, 'profiles', `.bazframe-backup-${journal.transactionId}`), journal.profileName, journal.expectedOld);
    return;
  }
  if (journal.kind === 'publication') await cleanupPublicationBackup(home, journal);
}

async function cleanupPublicationBackup(home: string, journal: PublicationJournalV1): Promise<void> {
  const profiles = join(home, 'profiles');
  const path = join(profiles, `.bazframe-backup-${journal.transactionId}`);
  const backup = await optionalCandidate(home, path, journal.profileName);
  if (backup === undefined) return;
  const current = await optionalProfile(home, journal.profileName);
  if (backup.identity !== journal.expectedProfile.identity || backup.sidecarSha256 !== journal.expectedProfile.sidecarSha256
    || current === undefined || !sameContentIgnoringSidecar(backup, current)) throw ambiguous();
  await removeProvedDirectory(profiles, path, backup);
}

async function cleanupExactOrAbsentCandidate(root: string, path: string, name: string, expected: { identity: string; sidecarSha256?: string | null; profileClosureSha256: string }): Promise<void> {
  const current = await optionalCandidate(join(root, '..'), path, name);
  if (current === undefined) return;
  if (!matches(current, expected)) throw ambiguous();
  await removeProvedDirectory(root, path, current);
}

async function removeProvedDirectory(root: string, path: string, expected: PhysicalProfileExpectation): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (`${current.dev}:${current.ino}` !== expected.identity || current.isSymbolicLink() || !current.isDirectory()) throw ambiguous();
  const quarantine = join(root, `.bazframe-backup-${randomBytes(16).toString('hex')}`);
  await rename(path, quarantine);
  await syncDirectory(root);
  const moved = await lstat(quarantine, { bigint: true });
  if (`${moved.dev}:${moved.ino}` !== expected.identity || moved.isSymbolicLink() || !moved.isDirectory()) throw ambiguous();
  // Retain the identity-proven quarantine. Node has no handle-relative recursive
  // removal primitive; deleting it by pathname would permit substitution after
  // the proof. A separately authorized GC may reclaim retained quarantines.
}

async function optionalProfile(home: string, name: string): Promise<PhysicalProfileExpectation | undefined> {
  try { return await capturePhysicalProfileExpectation(home, name); }
  catch (error) { if (absent(error)) return undefined; throw error; }
}
async function optionalCandidate(home: string, path: string, name: string): Promise<PhysicalProfileExpectation | undefined> {
  try { return await capturePhysicalCandidateExpectation(home, path, name); }
  catch (error) { if (absent(error)) return undefined; throw error; }
}
function matches(value: PhysicalProfileExpectation | undefined, expected: { identity: string; sidecarSha256?: string | null; profileClosureSha256: string }): boolean {
  return value !== undefined && value.identity === expected.identity && value.profileClosureSha256 === expected.profileClosureSha256
    && (expected.sidecarSha256 === undefined || value.sidecarSha256 === expected.sidecarSha256);
}
function matchesRenamed(value: PhysicalProfileExpectation | undefined, expected: { identity: string; sidecarSha256: string | null; profileClosureSha256: string }, oldName: string): boolean {
  if (value === undefined || value.identity !== expected.identity || value.sidecarSha256 !== expected.sidecarSha256) return false;
  const canonical = `${JSON.stringify({ ...value.closure, profileName: oldName }, null, 2)}\n`;
  return createHash('sha256').update('bazframe-physical-profile-closure-v1\0').update(canonical).digest('hex') === expected.profileClosureSha256;
}
function sameContentIgnoringSidecar(left: PhysicalProfileExpectation, right: PhysicalProfileExpectation): boolean {
  const withoutSidecar = (value: PhysicalProfileExpectation) => value.closure.entries.filter((entry) => entry.kind !== 'managed-sidecar');
  return JSON.stringify(withoutSidecar(left)) === JSON.stringify(withoutSidecar(right));
}
function operationKeys(journal: TransactionJournalV1): string[] { return journal.kind === 'rename-profile' ? [journal.oldName, journal.newName, '@store'] : [journal.profileName, '@store']; }
function sameOperationIdentity(left: TransactionJournalV1, right: TransactionJournalV1): boolean {
  if (left.kind !== right.kind || left.transactionId !== right.transactionId) return false;
  if (left.kind === 'rename-profile' && right.kind === 'rename-profile') return left.oldName === right.oldName && left.newName === right.newName;
  if (left.kind !== 'rename-profile' && right.kind !== 'rename-profile') return left.profileName === right.profileName;
  return false;
}
function isTerminal(journal: TransactionJournalV1): boolean { return journal.phase === 'COMMITTED' || journal.phase === 'ABORTED' || journal.phase === 'AMBIGUOUS'; }
function absent(error: unknown): boolean { return errorCode(error) === 'ENOENT' || (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT'); }
function phaseIndex<T extends string>(phases: readonly T[], phase: T): number { return phases.indexOf(phase); }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function result(journal: TransactionJournalV1, action: ProfileRecoveryResult['action']): ProfileRecoveryResult { return { transactionId: journal.transactionId, kind: journal.kind, action }; }
function ambiguous(): BazframeError { return new BazframeError('PROFILE_RECOVERY_AMBIGUOUS', 'Profile recovery predicates could not be proved; state was retained.'); }
function isPredicateMismatch(error: unknown): boolean { return error instanceof BazframeError && (error.code === 'PROFILE_RECOVERY_AMBIGUOUS' || error.code === 'PROFILE_PUBLICATION_CHANGED' || error.code === 'PROFILE_RECOVERY_REMOTE_REF_ABSENT'); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_RECOVERY_INVALID', `Invalid profile recovery: ${detail}.`); }
