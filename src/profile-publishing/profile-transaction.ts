import { BazframeError } from '../core/errors.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import type { ManagedProfileStateV1 } from './publication-state.js';
import { serializePosixBackupProof, samePhysicalProfileExpectation, type PhysicalProfileExpectation } from './physical-profile-closure.js';
import { assertOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from './profile-operation-lock.js';
import { backupTransactionToken, candidateTransactionToken, newTransactionId, type CandidatePhase } from './transaction-journal.js';
import { defaultProfileLifecycleServices, type ProfileLifecycleServices, type CandidateLifecycleJournal, type LifecycleSelection } from './profile-lifecycle-services.js';

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
  services?: ProfileLifecycleServices;
  profileName: string;
  operation: CandidateSwapOperation;
  /** Exact caller-observed baseline for existing-profile CAS operations. */
  expectedOld?: PhysicalProfileExpectation;
  /** Fresh import invariant: a dangling active-profile entry must not become active by creation. */
  freshImportMustRemainInactive?: true;
  /** Additional safe profile IDs whose source state is revalidated by the operation. */
  additionalOperationLockKeys?: readonly string[];
  /** Runs under operation locks and the global state lock immediately before any rename. */
  beforePublication?: (authority: OperationMutationAuthority) => void | Promise<void>;
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
  journal: CandidateLifecycleJournal;
  backupRetained: boolean;
  active: boolean;
}

export async function executeProfileCandidateSwap(options: ProfileCandidateSwapOptions): Promise<ProfileCandidateSwapResult> {
  assertSafeProfileId(options.profileName);
  if (options.freshImportMustRemainInactive === true && options.operation !== 'fresh-import') throw new BazframeError('PROFILE_TRANSACTION_INVALID', 'Inactive-fresh invariant applies only to fresh import.');
  const services = options.services ?? defaultProfileLifecycleServices;
  await services.beforeMutation?.(options.home);
  const destinationExists = await services.capture(options.home, options.profileName) !== undefined;
  if ((options.operation === 'fresh-import') === destinationExists) {
    throw new BazframeError(
      options.operation === 'fresh-import' ? 'PROFILE_IMPORT_DESTINATION_OCCUPIED' : 'PROFILE_NOT_FOUND',
      options.operation === 'fresh-import'
        ? `Profile ${JSON.stringify(options.profileName)} already exists.`
        : `Profile ${JSON.stringify(options.profileName)} does not exist.`
    );
  }
  if (options.freshImportMustRemainInactive === true) await assertFreshImportInactive(options.home, options.profileName, services);
  const transactionId = newTransactionId();
  return services.withOperationLocks(
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
  const services = options.services ?? defaultProfileLifecycleServices;
  const candidateToken = candidateTransactionToken(transactionId);
  const backupToken = backupTransactionToken(transactionId);
  const candidateComponent = `.bazframe-candidate-${transactionId}`;
  const backupComponent = `.bazframe-backup-${transactionId}`;
  const candidatePath = services.path(options.home, candidateComponent);
  if (options.operation === 'fresh-import' && options.expectedOld !== undefined) throw new BazframeError('PROFILE_TRANSACTION_INVALID', 'Fresh import cannot carry an existing-profile expectation.');
  const expectedOld = options.operation === 'fresh-import'
    ? undefined
    : options.expectedOld ?? await requiredCapture(services, options.home, options.profileName);
  const activeBefore = await services.readSelection(options.home);
  if (options.freshImportMustRemainInactive === true && activeBefore?.profileId === options.profileName) throw danglingActive(options.profileName);
  await assertDestinationState(options.home, options.profileName, expectedOld, services);
  const previousMissingIds = expectedOld === undefined ? new Set<string>() : await oldMissingSet(options.home, options.profileName, services);
  assertOperationMutationAuthority(authority, options.home, [options.profileName, '@store'], transactionId);
  await services.createCandidate(options.home, candidateComponent, authority);

  let journal: CandidateLifecycleJournal = {
    ...services.header,
    kind: 'candidate-swap',
    transactionId,
    operation: options.operation,
    profileName: options.profileName,
    expectedOld: expectedOld === undefined
      ? { kind: 'absent' }
      : {
          kind: 'physical-directory',
          ...services.proof(expectedOld)
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
  } as CandidateLifecycleJournal;
  journal = await services.writeJournal(options.home, authority, journal);
  await options.hooks?.afterPhase?.(journal.phase);

  let packagePhaseStarted = false;
  const advance = async (phase: CandidatePhase, updates: Partial<CandidateLifecycleJournal> = {}): Promise<void> => {
    journal = await services.writeJournal(options.home, authority, { ...journal, ...updates, phase } as CandidateLifecycleJournal);
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
    const sidecar = materialized.state === undefined ? undefined : await services.writeCandidateState(options.home, candidatePath, authority, materialized.state);
    const candidate = await requiredCapture(services, options.home, options.profileName, candidateComponent);
    if (candidate.sidecarSha256 !== (sidecar?.sha256 ?? null)) throw changed('candidate sidecar changed after materialization');
    if (expectedOld !== undefined && materialized.state !== undefined && !isSubset(missingSet(materialized.state), previousMissingIds)) {
      throw new BazframeError('PROFILE_MUTATION_WOULD_WORSEN', 'Existing profile mutation would add a missing resource.');
    }
    await advance('CANDIDATE_READY', {
      candidate: {
        token: candidateToken,
        ...services.proof(candidate)
      }
    });

    await services.withStateLock(
      options.home, options.profileName,
      async (stateAuthority) => {
        stateAuthority.assertHeld();
        await assertDestinationState(options.home, options.profileName, expectedOld, services);
        await assertSameActiveSelection(options.home, activeBefore, services);
        if (options.freshImportMustRemainInactive === true) await assertFreshImportInactive(options.home, options.profileName, services);
        await options.beforePublication?.(authority);
        if (options.freshImportMustRemainInactive === true) await assertFreshImportInactive(options.home, options.profileName, services);
        stateAuthority.assertHeld();
        const revalidatedCandidate = await requiredCapture(services, options.home, options.profileName, candidateComponent);
        if (!samePhysicalProfileExpectation(revalidatedCandidate, candidate)) throw changed('candidate changed before publication');
        if (expectedOld !== undefined) {
          await services.assertAbsent(options.home, backupComponent);
          await advance('OLD_RENAME_INTENT');
          assertOperationMutationAuthority(authority, options.home, [options.profileName, '@store'], transactionId);
          stateAuthority.assertHeld();
          await services.move(options.home, options.profileName, backupComponent, options.profileName, expectedOld, authority);
          await options.hooks?.afterOldRename?.();
          const backup = await requiredCapture(services, options.home, options.profileName, backupComponent);
          if (!samePhysicalProfileExpectation(backup, expectedOld)) throw changed('backup does not prove the expected profile');
          await advance('OLD_RENAME_PROVEN', {
            backup: { token: backupToken, ...(services.header.schemaVersion === 1 ? serializePosixBackupProof(backup) : services.proof(backup)) }
          });
        }
        await advance('CANDIDATE_RENAME_INTENT');
        assertOperationMutationAuthority(authority, options.home, [options.profileName, '@store'], transactionId);
        stateAuthority.assertHeld();
        await services.move(options.home, candidateComponent, options.profileName, options.profileName, candidate, authority);
        await options.hooks?.afterCandidateRename?.();
        const published = await requiredCapture(services, options.home, options.profileName);
        if (!samePhysicalProfileExpectation(published, candidate)) throw changed('published candidate proof changed');
        await advance('CANDIDATE_RENAME_PROVEN');
        await assertSameActiveSelection(options.home, activeBefore, services);
        await advance('ACTIVE_SELECTION_PROVEN');
        stateAuthority.assertHeld();
        await advance('COMMITTED');
      }
    );
    return { transactionId, profileName: options.profileName, journal, backupRetained: expectedOld !== undefined, active: activeBefore?.profileId === options.profileName };
  } catch (error) {
    if (services.header.schemaVersion === 1) await retainFailurePhase(options.home, authority, transactionId, services).catch(() => undefined);
    throw error;
  }
}

async function retainFailurePhase(home: string, authority: OperationMutationAuthority, transactionId: string, services: ProfileLifecycleServices): Promise<void> {
  const current = await services.readJournal(home, transactionId);
  if (current.kind !== 'candidate-swap' || current.phase === 'COMMITTED' || current.phase === 'ABORTED' || current.phase === 'AMBIGUOUS') return;
  const destructive = ['OLD_RENAME_INTENT', 'OLD_RENAME_PROVEN', 'CANDIDATE_RENAME_INTENT', 'CANDIDATE_RENAME_PROVEN', 'ACTIVE_SELECTION_PROVEN'].includes(current.phase);
  await services.writeJournal(home, authority, { ...current, phase: destructive ? 'AMBIGUOUS' : 'ABORTED' });
}

async function requiredCapture(services: ProfileLifecycleServices, home: string, name: string, component = name): Promise<PhysicalProfileExpectation> {
  const value = await services.capture(home, name, component);
  if (value === undefined) throw changed('profile is absent'); return value;
}
async function assertDestinationState(home: string, name: string, expected: PhysicalProfileExpectation | undefined, services: ProfileLifecycleServices): Promise<void> {
  if (expected === undefined) { await services.assertAbsent(home, name); return; }
  if (!samePhysicalProfileExpectation(await requiredCapture(services, home, name), expected)) throw changed('destination changed');
}
async function assertSameActiveSelection(home: string, expected: LifecycleSelection | undefined, services: ProfileLifecycleServices): Promise<void> {
  const current = await services.readSelection(home);
  if (current?.profileId !== expected?.profileId || current?.binding !== expected?.binding) throw changed('active profile selection changed');
}
async function oldMissingSet(home: string, name: string, services: ProfileLifecycleServices): Promise<Set<string>> {
  const state = await services.readManagedState(home, name); return state === undefined ? new Set() : missingSet(state.state);
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

async function assertFreshImportInactive(home: string, profileName: string, services: ProfileLifecycleServices): Promise<void> {
  if ((await services.readSelection(home))?.profileId === profileName) throw danglingActive(profileName);
}

function danglingActive(profileName: string): BazframeError {
  return new BazframeError('PROFILE_IMPORT_DANGLING_ACTIVE', `Fresh import cannot create ${JSON.stringify(profileName)} while active-profile already names that absent destination.`);
}

function changed(detail: string): BazframeError {
  return new BazframeError('PROFILE_TRANSACTION_CHANGED', `Profile transaction changed or became ambiguous: ${detail}.`);
}
