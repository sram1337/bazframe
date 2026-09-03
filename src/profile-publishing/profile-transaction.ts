import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { profileDirectory, readOptionalActiveProfileSnapshot, type ActiveProfileSnapshot } from '../profiles/profile-store.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import type { ManagedProfileStateV1 } from './publication-state.js';
import { writeCandidateManagedProfileState } from './managed-profile-state.js';
import {
  assertPhysicalProfileExpectation,
  capturePhysicalCandidateExpectation,
  capturePhysicalProfileExpectation,
  samePhysicalProfileExpectation,
  type PhysicalProfileExpectation
} from './physical-profile-closure.js';
import {
  assertOperationMutationAuthority,
  operationAuthorityTransactionId,
  withProfileOperationLocks,
  type OperationMutationAuthority
} from './profile-operation-lock.js';
import {
  backupTransactionToken,
  candidateTransactionToken,
  newTransactionId,
  readTransactionJournal,
  writeTransactionJournal,
  type CandidatePhase,
  type CandidateSwapJournalV1
} from './transaction-journal.js';

export type CandidateSwapOperation = 'fresh-import' | 'overwrite' | 'update' | 'repair' | 'version-use';

export interface CandidateMaterializationContext {
  authority: OperationMutationAuthority;
  transactionId: string;
  beginPackageEffects(capturedPackageIds?: readonly string[]): Promise<void>;
}

export interface CandidateMaterializationResult {
  /** Omit only when duplicating a sidecar-free profile without eager migration. */
  state?: ManagedProfileStateV1;
}

export interface ProfileCandidateSwapOptions {
  home: string;
  profileName: string;
  operation: CandidateSwapOperation;
  /** Exact caller-observed baseline for existing-profile CAS operations. */
  expectedOld?: PhysicalProfileExpectation;
  /** Fresh import invariant: a dangling active-profile entry must not become active by creation. */
  freshImportMustRemainInactive?: true;
  /** Additional safe profile IDs whose source state is revalidated by the operation. */
  additionalOperationLockKeys?: readonly string[];
  /** Runs under operation locks and the global state lock immediately before any rename. */
  beforePublication?: () => void | Promise<void>;
  materialize(candidateDirectory: string, context: CandidateMaterializationContext): Promise<CandidateMaterializationResult>;
  hooks?: {
    afterPhase?: (phase: CandidatePhase) => void | Promise<void>;
    afterOldRename?: () => void | Promise<void>;
    afterCandidateRename?: () => void | Promise<void>;
  };
}

export interface ProfileCandidateSwapResult {
  transactionId: string;
  profileName: string;
  journal: CandidateSwapJournalV1;
  backupRetained: boolean;
  active: boolean;
}

export async function executeProfileCandidateSwap(options: ProfileCandidateSwapOptions): Promise<ProfileCandidateSwapResult> {
  assertSafeProfileId(options.profileName);
  if (options.freshImportMustRemainInactive === true && options.operation !== 'fresh-import') throw new BazframeError('PROFILE_TRANSACTION_INVALID', 'Inactive-fresh invariant applies only to fresh import.');
  const destinationExists = await physicalProfileExists(options.home, options.profileName);
  if ((options.operation === 'fresh-import') === destinationExists) {
    throw new BazframeError(
      options.operation === 'fresh-import' ? 'PROFILE_IMPORT_DESTINATION_OCCUPIED' : 'PROFILE_NOT_FOUND',
      options.operation === 'fresh-import'
        ? `Profile ${JSON.stringify(options.profileName)} already exists.`
        : `Profile ${JSON.stringify(options.profileName)} does not exist.`
    );
  }
  if (options.freshImportMustRemainInactive === true) await assertFreshImportInactive(options.home, options.profileName);
  const transactionId = newTransactionId();
  return withProfileOperationLocks(
    options.home,
    [...new Set([options.profileName, ...(options.additionalOperationLockKeys ?? []), '@store'])],
    (authority) => executeWithAuthority(options, authority),
    transactionId
  );
}

async function executeWithAuthority(
  options: ProfileCandidateSwapOptions,
  authority: OperationMutationAuthority
): Promise<ProfileCandidateSwapResult> {
  const transactionId = operationAuthorityTransactionId(authority);
  const profilesRoot = join(options.home, 'profiles');
  await ensureManagedDirectory(options.home, profilesRoot);
  const candidateToken = candidateTransactionToken(transactionId);
  const backupToken = backupTransactionToken(transactionId);
  const candidatePath = join(profilesRoot, `.bazframe-candidate-${transactionId}`);
  const backupPath = join(profilesRoot, `.bazframe-backup-${transactionId}`);
  const destinationPath = profileDirectory(options.home, options.profileName);
  if (options.operation === 'fresh-import' && options.expectedOld !== undefined) throw new BazframeError('PROFILE_TRANSACTION_INVALID', 'Fresh import cannot carry an existing-profile expectation.');
  const expectedOld = options.operation === 'fresh-import'
    ? undefined
    : options.expectedOld ?? await capturePhysicalProfileExpectation(options.home, options.profileName);
  const activeBefore = await readOptionalActiveProfileSnapshot(options.home);
  if (options.freshImportMustRemainInactive === true && activeBefore?.profileId === options.profileName) throw danglingActive(options.profileName);
  await assertDestinationState(options.home, options.profileName, expectedOld);
  const previousMissingIds = expectedOld === undefined ? new Set<string>() : await oldMissingSet(options.home, options.profileName);
  assertOperationMutationAuthority(authority, options.home, [options.profileName, '@store'], transactionId);
  await mkdir(candidatePath, { mode: 0o700 });
  await assertSameDevice(profilesRoot, candidatePath);

  let journal: CandidateSwapJournalV1 = {
    schemaVersion: 1,
    kind: 'candidate-swap',
    transactionId,
    operation: options.operation,
    profileName: options.profileName,
    expectedOld: expectedOld === undefined
      ? { kind: 'absent' }
      : {
          kind: 'physical-directory',
          identity: expectedOld.identity,
          sidecarSha256: expectedOld.sidecarSha256,
          profileClosureSha256: expectedOld.profileClosureSha256
        },
    candidate: {
      token: candidateToken,
      identity: null,
      sidecarSha256: null,
      profileClosureSha256: null
    },
    backup: null,
    activeProfileBefore: activeBefore?.profileId ?? null,
    phase: 'PLANNED',
    possiblePackageEffects: []
  };
  journal = await writeTransactionJournal(options.home, authority, journal);
  await options.hooks?.afterPhase?.(journal.phase);

  let packagePhaseStarted = false;
  const advance = async (phase: CandidatePhase, updates: Partial<CandidateSwapJournalV1> = {}): Promise<void> => {
    journal = await writeTransactionJournal(options.home, authority, { ...journal, ...updates, phase } as CandidateSwapJournalV1);
    await options.hooks?.afterPhase?.(phase);
  };

  try {
    await advance('MATERIALIZING');
    const materialized = await options.materialize(candidatePath, {
      authority,
      transactionId,
      beginPackageEffects: async (capturedPackageIds = []) => {
        if (packagePhaseStarted) throw new BazframeError('PROFILE_PACKAGE_PHASE_INVALID', 'Profile package effects were already begun.');
        packagePhaseStarted = true;
        const effects = [...new Set(capturedPackageIds)].sort();
        await advance('PACKAGES_LAST', { possiblePackageEffects: effects });
      }
    });
    if (!packagePhaseStarted) {
      packagePhaseStarted = true;
      await advance('PACKAGES_LAST');
    }
    const sidecar = materialized.state === undefined ? undefined : await writeCandidateManagedProfileState(options.home, candidatePath, materialized.state);
    const candidate = await capturePhysicalCandidateExpectation(options.home, candidatePath, options.profileName);
    if (candidate.sidecarSha256 !== (sidecar?.sha256 ?? null)) throw changed('candidate sidecar changed after materialization');
    if (expectedOld !== undefined && materialized.state !== undefined && !isSubset(missingSet(materialized.state), previousMissingIds)) {
      throw new BazframeError('PROFILE_MUTATION_WOULD_WORSEN', 'Existing profile mutation would add a missing resource.');
    }
    await advance('CANDIDATE_READY', {
      candidate: {
        token: candidateToken,
        identity: candidate.identity,
        sidecarSha256: candidate.sidecarSha256,
        profileClosureSha256: candidate.profileClosureSha256
      }
    });

    await withStateLock(
      join(options.home, 'locks', 'state.lock'),
      { command: `profile-${options.operation}`, target: options.profileName },
      async () => {
        await assertDestinationState(options.home, options.profileName, expectedOld);
        await assertSameActiveSelection(options.home, activeBefore);
        if (options.freshImportMustRemainInactive === true) await assertFreshImportInactive(options.home, options.profileName);
        await options.beforePublication?.();
        if (options.freshImportMustRemainInactive === true) await assertFreshImportInactive(options.home, options.profileName);
        const revalidatedCandidate = await capturePhysicalCandidateExpectation(options.home, candidatePath, options.profileName);
        if (!samePhysicalProfileExpectation(revalidatedCandidate, candidate)) throw changed('candidate changed before publication');
        if (expectedOld !== undefined) {
          await assertAbsentBackup(backupPath);
          await advance('OLD_RENAME_INTENT');
          assertOperationMutationAuthority(authority, options.home, [options.profileName, '@store'], transactionId);
          await rename(destinationPath, backupPath);
          await syncDirectory(profilesRoot);
          await options.hooks?.afterOldRename?.();
          const backup = await capturePhysicalCandidateExpectation(options.home, backupPath, options.profileName);
          if (!samePhysicalProfileExpectation(backup, expectedOld)) throw changed('backup does not prove the expected profile');
          await advance('OLD_RENAME_PROVEN', {
            backup: { token: backupToken, identity: backup.identity, profileClosureSha256: backup.profileClosureSha256 }
          });
        }
        await advance('CANDIDATE_RENAME_INTENT');
        assertOperationMutationAuthority(authority, options.home, [options.profileName, '@store'], transactionId);
        await rename(candidatePath, destinationPath);
        await syncDirectory(profilesRoot);
        await options.hooks?.afterCandidateRename?.();
        const published = await capturePhysicalProfileExpectation(options.home, options.profileName);
        if (!samePhysicalProfileExpectation(published, candidate)) throw changed('published candidate proof changed');
        await advance('CANDIDATE_RENAME_PROVEN');
        await assertSameActiveSelection(options.home, activeBefore);
        await advance('ACTIVE_SELECTION_PROVEN');
        await advance('COMMITTED');
      },
      { managedRoot: options.home }
    );
    return { transactionId, profileName: options.profileName, journal, backupRetained: expectedOld !== undefined, active: activeBefore?.profileId === options.profileName };
  } catch (error) {
    await retainFailurePhase(options.home, authority, transactionId).catch(() => undefined);
    throw error;
  }
}

async function retainFailurePhase(home: string, authority: OperationMutationAuthority, transactionId: string): Promise<void> {
  const current = await readTransactionJournal(home, transactionId);
  if (current.kind !== 'candidate-swap' || current.phase === 'COMMITTED' || current.phase === 'ABORTED' || current.phase === 'AMBIGUOUS') return;
  const destructive = ['OLD_RENAME_INTENT', 'OLD_RENAME_PROVEN', 'CANDIDATE_RENAME_INTENT', 'CANDIDATE_RENAME_PROVEN', 'ACTIVE_SELECTION_PROVEN'].includes(current.phase);
  await writeTransactionJournal(home, authority, { ...current, phase: destructive ? 'AMBIGUOUS' : 'ABORTED' });
}

async function assertDestinationState(home: string, profileName: string, expected: PhysicalProfileExpectation | undefined): Promise<void> {
  if (expected !== undefined) {
    await assertPhysicalProfileExpectation(home, profileName, expected);
    return;
  }
  try {
    await lstat(profileDirectory(home, profileName));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new BazframeError('PROFILE_IMPORT_DESTINATION_OCCUPIED', `Profile ${JSON.stringify(profileName)} already exists.`);
}

async function assertSameActiveSelection(home: string, expected: ActiveProfileSnapshot | undefined): Promise<void> {
  const current = await readOptionalActiveProfileSnapshot(home);
  if (expected === undefined || current === undefined) {
    if (expected === current) return;
    throw changed('active profile selection changed');
  }
  if (expected.profileId !== current.profileId || expected.contentSha256 !== current.contentSha256 || expected.device !== current.device || expected.inode !== current.inode) {
    throw changed('active profile selection changed');
  }
}

async function physicalProfileExists(home: string, profileName: string): Promise<boolean> {
  try {
    const metadata = await lstat(profileDirectory(home, profileName));
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw changed('profile destination is not a physical directory');
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function assertSameDevice(parent: string, child: string): Promise<void> {
  const [parentMetadata, childMetadata] = await Promise.all([lstat(parent, { bigint: true }), lstat(child, { bigint: true })]);
  if (!parentMetadata.isDirectory() || childMetadata.isSymbolicLink() || !childMetadata.isDirectory() || parentMetadata.dev !== childMetadata.dev) {
    throw new BazframeError('PROFILE_TRANSACTION_CROSS_DEVICE', 'Profile candidate and destination must share one physical filesystem.');
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function oldMissingSet(home: string, profileName: string): Promise<Set<string>> {
  const { readOptionalManagedProfileState } = await import('./managed-profile-state.js');
  const state = await readOptionalManagedProfileState(home, profileName);
  return state === undefined ? new Set() : missingSet(state.state);
}

function missingSet(state: ManagedProfileStateV1): Set<string> {
  return new Set(state.importedResources.flatMap((resource) => resource.source.kind !== 'missingRemoteGit' ? [] : [JSON.stringify({
    capturedResourceId: resource.capturedResourceId,
    key: resource.key,
    identity: resource.source.identity
  })]));
}

function isSubset(candidate: ReadonlySet<string>, previous: ReadonlySet<string>): boolean {
  for (const id of candidate) if (!previous.has(id)) return false;
  return true;
}

async function assertAbsentBackup(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
  throw new BazframeError('PROFILE_TRANSACTION_BACKUP_OCCUPIED', 'Profile transaction backup destination is occupied.');
}

async function assertFreshImportInactive(home: string, profileName: string): Promise<void> {
  if ((await readOptionalActiveProfileSnapshot(home))?.profileId === profileName) throw danglingActive(profileName);
}

function danglingActive(profileName: string): BazframeError {
  return new BazframeError('PROFILE_IMPORT_DANGLING_ACTIVE', `Fresh import cannot create ${JSON.stringify(profileName)} while active-profile already names that absent destination.`);
}

function changed(detail: string): BazframeError {
  return new BazframeError('PROFILE_TRANSACTION_CHANGED', `Profile transaction changed or became ambiguous: ${detail}.`);
}
