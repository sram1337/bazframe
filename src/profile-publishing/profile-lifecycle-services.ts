import { createHash } from 'node:crypto';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { captureProfileRemovalIdentity } from '../profiles/profile-removal-identity.js';
import { decodeProfileFavorites, encodeProfileFavorites, MAX_PROFILE_FAVORITES_BYTES, PROFILE_FAVORITES_FILE, writeProfileFavoritesUnlocked } from '../profiles/profile-favorites.js';
import { profileDirectory, readOptionalActiveProfileSnapshot } from '../profiles/profile-store.js';
import { readOptionalManagedProfileState, writeCandidateManagedProfileState, type ManagedProfileStateContentSnapshot } from './managed-profile-state.js';
import type { ManagedProfileStateV1 } from './publication-state.js';
import { ensureManagedDirectory, writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import { capturePhysicalCandidateExpectation, capturePhysicalProfileExpectation, serializePosixPhysicalProfileProof, type PhysicalProfileExpectation, type PhysicalProfileProof } from './physical-profile-closure.js';
import { openStablePhysicalDirectory, assertPhysicalDirectoryIdentity, stableReadChildPath, readStablePhysicalFile } from './profile-filesystem.js';
import { withProfileOperationLocks, type OperationMutationAuthority } from './profile-operation-lock.js';
import { readTransactionJournal, writeTransactionJournal, type CandidateSwapJournalV1, type CandidateSwapJournalV2, type RenameProfileJournalV1, type RenameProfileJournalV2, type RemoveProfileJournalV1, type RemoveProfileJournalV2, type PublicationJournalV1, type PublicationJournalV2, type TransactionJournal } from './transaction-journal.js';

export type PublicationLifecycleJournal = PublicationJournalV1 | PublicationJournalV2;
export type CandidateLifecycleJournal = CandidateSwapJournalV1 | CandidateSwapJournalV2;
export type RenameLifecycleJournal = RenameProfileJournalV1 | RenameProfileJournalV2;
export type RemoveLifecycleJournal = RemoveProfileJournalV1 | RemoveProfileJournalV2;
export interface LifecycleFavorites { sha256: string | null; favorites: string[]; valid: boolean; binding?: string }
export interface LifecycleSelection { profileId: string; contentSha256: string; binding: string }
export interface LifecycleStateAuthority { assertHeld(): void }
/** Effects used by the live shared lifecycle and its recovery phase policy. */
export interface ProfileLifecycleServices {
  header: { schemaVersion: 1 } | { schemaVersion: 2; identityDomain: 'win32-ntfs' };
  path(home: string, component: string): string;
  capture(home: string, name: string, component?: string): Promise<PhysicalProfileExpectation | undefined>;
  createCandidate(home: string, component: string, authority: OperationMutationAuthority): Promise<void>;
  readManagedState(home: string, name: string): Promise<ManagedProfileStateContentSnapshot | undefined>;
  writeCandidateState(home: string, path: string, authority: OperationMutationAuthority, state: ManagedProfileStateV1): Promise<{ sha256: string }>;
  proof(value: PhysicalProfileProof): PhysicalProfileProof;
  assertAbsent(home: string, name: string): Promise<void>;
  move(home: string, source: string, destination: string, name: string, expected: PhysicalProfileExpectation, authority: OperationMutationAuthority): Promise<void>;
  withOperationLocks: typeof withProfileOperationLocks;
  withStateLock<T>(home: string, name: string, operation: (authority: LifecycleStateAuthority) => Promise<T>): Promise<T>;
  readSelection(home: string): Promise<LifecycleSelection | undefined>;
  publishSelection(home: string, name: string, authority: LifecycleStateAuthority, expected: LifecycleSelection | undefined, validateDependencies?: () => Promise<void>): Promise<void>;
  readFavorites(home: string): Promise<LifecycleFavorites>;
  publishFavorites(home: string, names: string[], authority: LifecycleStateAuthority, expected: LifecycleFavorites, validateDependencies?: () => Promise<void>): Promise<void>;
  removalIdentity(home: string, name: string): Promise<import('../profiles/profile-removal-identity.js').ProfileRemovalIdentity | PhysicalProfileExpectation>;
  writeJournal<T extends CandidateLifecycleJournal | RenameLifecycleJournal | RemoveLifecycleJournal | PublicationLifecycleJournal>(home: string, authority: OperationMutationAuthority, journal: T): Promise<T>;
  readJournal(home: string, id: string): Promise<TransactionJournal>;
  scanJournals?(home: string): Promise<string[]>;
  beforeMutation?(home: string): Promise<void>;
  publication?: {
    capture(options: Parameters<typeof import('./profile-capture.js').captureProfile>[0], authority?: OperationMutationAuthority): ReturnType<typeof import('./profile-capture.js').captureProfile>;
    assertRoot?(home: string, name: string, expected: PhysicalProfileProof, authority: OperationMutationAuthority): void;
    publishSidecar(home: string, name: string, expected: PhysicalProfileProof, state: ManagedProfileStateV1, authority: OperationMutationAuthority): Promise<void>;
    readPrevious(home: string, journal: PublicationLifecycleJournal): Promise<ManagedProfileStateContentSnapshot | undefined>;
  };
}
export const defaultProfileLifecycleServices: ProfileLifecycleServices = {
  header: { schemaVersion: 1 }, path: (home, name) => join(home, 'profiles', name),
  async capture(home, name, component = name) {
    try { return component === name ? await capturePhysicalProfileExpectation(home, name) : await capturePhysicalCandidateExpectation(home, join(home, 'profiles', component), name); }
    catch (error) { if (absent(error)) return undefined; throw error; }
  },
  async createCandidate(home, component) {
    const root = join(home, 'profiles'); await ensureManagedDirectory(home, root);
    const path = join(root, component); await mkdir(path, { mode: 0o700 });
    const [parent, child] = await Promise.all([lstat(root, { bigint: true }), lstat(path, { bigint: true })]);
    if (!parent.isDirectory() || !child.isDirectory() || child.isSymbolicLink() || parent.dev !== child.dev) throw new BazframeError('PROFILE_TRANSACTION_CROSS_DEVICE', 'Profile candidate must share its parent filesystem.');
  },
  readManagedState: readOptionalManagedProfileState,
  writeCandidateState: (home, path, _authority, state) => writeCandidateManagedProfileState(home, path, state),
  proof: serializePosixPhysicalProfileProof,
  async assertAbsent(home, name) {
    const backup = /^\.bazframe-backup-[a-f0-9]{32}$/u.test(name);
    try { await lstat(backup ? join(home, 'profiles', name) : profileDirectory(home, name)); }
    catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
    throw new BazframeError(backup ? 'PROFILE_TRANSACTION_BACKUP_OCCUPIED' : 'PROFILE_RENAME_DESTINATION_OCCUPIED', 'Profile rename destination is occupied.');
  },
  async move(home, source, destination) {
    await rename(join(home, 'profiles', source), join(home, 'profiles', destination));
    const handle = await open(join(home, 'profiles'), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  },
  withOperationLocks: withProfileOperationLocks,
  withStateLock: (home, name, operation) => withStateLock(join(home, 'locks', 'state.lock'), { command: 'profile-managed-lifecycle', target: name }, () => operation({ assertHeld() {} }), { managedRoot: home }),
  async readSelection(home) {
    const value = await readOptionalActiveProfileSnapshot(home);
    return value === undefined ? undefined : { profileId: value.profileId, contentSha256: value.contentSha256, binding: `${value.device}:${value.inode}:${value.contentSha256}` };
  },
  publishSelection: (home, name) => writeFileAtomic(join(home, 'active-profile'), `${name}\n`, { managedRoot: home, commitOnRename: true }),
  readFavorites: readLifecycleFavoriteSnapshot,
  publishFavorites: (home, names) => writeProfileFavoritesUnlocked(home, names),
  removalIdentity: (home, name) => captureProfileRemovalIdentity(profileDirectory(home, name)),
  async writeJournal(home, authority, journal) {
    if (journal.schemaVersion !== 1) throw new BazframeError('PROFILE_TRANSACTION_JOURNAL_INVALID', 'POSIX lifecycle refuses Windows journals.');
    return await writeTransactionJournal(home, authority, journal) as typeof journal;
  },
  readJournal: readTransactionJournal
};

/** Malformed optional bytes are retained: before/after hashes are equal, so no new wire field is needed. */
export function lifecycleFavoritesFromBytes(bytes: Buffer | undefined): LifecycleFavorites {
  if (bytes === undefined) return { sha256: null, favorites: [], valid: true };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('NUL');
    return { sha256, favorites: decodeProfileFavorites(text).favorites, valid: true };
  } catch { return { sha256, favorites: [], valid: false }; }
}
export function lifecycleFavoritesAfter(before: LifecycleFavorites, names: string[]): string | null {
  if (!before.valid || (before.sha256 === null && names.length === 0)) return before.sha256;
  return createHash('sha256').update(encodeProfileFavorites(names)).digest('hex');
}
async function readLifecycleFavoriteSnapshot(home: string): Promise<LifecycleFavorites> {
  let directory;
  try {
    directory = await openStablePhysicalDirectory(home, home);
    await assertPhysicalDirectoryIdentity(directory);
    let bytes: Buffer | undefined;
    try { bytes = (await readStablePhysicalFile(stableReadChildPath(directory, PROFILE_FAVORITES_FILE), MAX_PROFILE_FAVORITES_BYTES)).bytes; }
    catch (error) { if (!absent(error)) throw error; }
    await assertPhysicalDirectoryIdentity(directory);
    return lifecycleFavoritesFromBytes(bytes);
  } catch (error) { if (absent(error)) return lifecycleFavoritesFromBytes(undefined); throw error; }
  finally { await directory?.handle.close(); }
}
function absent(error: unknown): boolean { return errorCode(error) === 'ENOENT' || (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT'); }
