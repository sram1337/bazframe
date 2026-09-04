import { createHash, randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { win32 } from 'node:path';
import type {
  BazframeWin32NativeBackend,
  WindowsDirectoryEntryObservation,
  WindowsPathInspection,
  WindowsSecurityObservation,
  WindowsStableDirectoryEnumerationReceipt
} from '../core/win32-native.js';
import { BazframeError } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import {
  captureWindowsDirectoryClosure,
  type WindowsDirectoryClosureExpectation
} from './win32-directory-closure.js';
import {
  admitWindowsPrivateDirectory,
  createWindowsPrivateDirectory,
  isValidWindowsPathComponent
} from './win32-private-directory.js';

const TRANSACTION_ID = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOWS_IDENTITY = /^[a-f0-9]{16}:[a-f0-9]{32}$/u;
const RECORD_NAME = /^([0-9]{8})\.json$/u;
const JOURNAL_RECORD_BYTES = PROFILE_PORTABILITY_PRODUCTION_LIMITS.artifactManifestBytes;

export type WindowsDirectoryPublicationPhase =
  | 'PLANNED'
  | 'CANDIDATE_READY'
  | 'OLD_RENAME_INTENT'
  | 'OLD_RENAME_PROVEN'
  | 'CANDIDATE_RENAME_INTENT'
  | 'CANDIDATE_RENAME_PROVEN'
  | 'DEPENDENT_STATE_PROVEN'
  | 'COMMITTED'
  | 'ABORTED'
  | 'AMBIGUOUS';

export interface WindowsDirectoryPublicationExpectation {
  rootIdentity: string;
  closureSha256: string;
}

export interface WindowsDirectoryPublicationJournalV1 {
  schemaVersion: 1;
  kind: 'windows-directory-publication';
  sequence: number;
  transactionId: string;
  mode: 'fresh' | 'replacement';
  overwriteAuthorization: 'not-authorized' | 'explicit-overwrite';
  parentIdentity: string;
  journalRootIdentity: string;
  journalDirectoryIdentity: string;
  destinationName: string;
  candidateName: string;
  backupName: string;
  expectedOld: WindowsDirectoryPublicationExpectation | null;
  candidate: WindowsDirectoryPublicationExpectation | null;
  backup: WindowsDirectoryPublicationExpectation | null;
  dependentStateSha256: string;
  phase: WindowsDirectoryPublicationPhase;
}

export interface WindowsDirectoryPublicationAuthority {
  readonly transactionId: string;
  assertHeld(): void;
}

export interface WindowsDirectoryPublicationIo {
  appendFileExclusive(path: string, bytes: Uint8Array): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

export interface WindowsDirectoryPublicationHooks {
  afterPhase?(phase: WindowsDirectoryPublicationPhase): void | Promise<void>;
  afterOldRename?(): void | Promise<void>;
  afterCandidateRename?(): void | Promise<void>;
}

interface CommonOptions {
  backend: BazframeWin32NativeBackend;
  parentPath: string;
  journalRootPath: string;
  destinationName: string;
  dependentState: {
    expectedSha256: string;
    observeSha256(): string | Promise<string>;
  };
  authority: WindowsDirectoryPublicationAuthority;
  io?: WindowsDirectoryPublicationIo;
  hooks?: WindowsDirectoryPublicationHooks;
}

export interface ExecuteWindowsDirectoryPublicationOptions extends CommonOptions {
  operation:
    | { mode: 'fresh' }
    | {
        mode: 'replacement';
        expectedOld: WindowsDirectoryPublicationExpectation;
        overwriteAuthorization: 'explicit-overwrite';
      };
  materialize(candidatePath: string): void | Promise<void>;
}

export interface RecoverWindowsDirectoryPublicationOptions extends CommonOptions {
  transactionId: string;
}

export interface WindowsDirectoryPublicationResult {
  transactionId: string;
  action: 'committed' | 'aborted' | 'ambiguous' | 'terminal';
  phase: WindowsDirectoryPublicationPhase;
  backupRetained: boolean;
}

type ChildObservation =
  | { kind: 'absent' }
  | { kind: 'directory'; expectation: WindowsDirectoryPublicationExpectation }
  | { kind: 'occupied' };

type NamespaceObservation = {
  destination: ChildObservation;
  candidate: ChildObservation;
  backup: ChildObservation;
};

const FRESH_ROUTE: readonly WindowsDirectoryPublicationPhase[] = [
  'PLANNED',
  'CANDIDATE_READY',
  'CANDIDATE_RENAME_INTENT',
  'CANDIDATE_RENAME_PROVEN',
  'DEPENDENT_STATE_PROVEN',
  'COMMITTED'
];
const REPLACEMENT_ROUTE: readonly WindowsDirectoryPublicationPhase[] = [
  'PLANNED',
  'CANDIDATE_READY',
  'OLD_RENAME_INTENT',
  'OLD_RENAME_PROVEN',
  'CANDIDATE_RENAME_INTENT',
  'CANDIDATE_RENAME_PROVEN',
  'DEPENDENT_STATE_PROVEN',
  'COMMITTED'
];
const MAX_JOURNAL_RECORDS = REPLACEMENT_ROUTE.length;

/**
 * Internal composition seam. The supplied authority must be backed by a
 * separately accepted exclusive-operation mechanism before product wiring.
 * This function does not bypass the public Windows gate.
 */
export async function executeWindowsDirectoryPublication(
  options: ExecuteWindowsDirectoryPublicationOptions
): Promise<WindowsDirectoryPublicationResult> {
  const transactionId = assertAuthority(options.authority);
  validateCommon(options, transactionId);
  if (options.operation.mode === 'replacement'
    && options.operation.overwriteAuthorization !== 'explicit-overwrite') {
    throw overwriteRequired();
  }
  const io = options.io ?? nodeWindowsDirectoryPublicationIo();
  const paths = transactionPaths(
    options.parentPath,
    options.journalRootPath,
    transactionId,
    options.destinationName
  );
  const roots = admitRoots(options.backend, options.parentPath, options.journalRootPath);
  await assertDependentState(options);
  const initial = await observeNamespace(options.backend, options.parentPath, paths.names);
  const expectedOld = options.operation.mode === 'replacement'
    ? validateExpectation(options.operation.expectedOld, 'expected old directory')
    : null;
  requireInitialNamespace(initial, expectedOld, options.destinationName);

  const journalDirectory = createWindowsPrivateDirectory(
    options.backend,
    options.journalRootPath,
    transactionId
  );
  requireSameVolumeAndUser(roots.parent, roots.journalRoot, journalDirectory);
  let journal: WindowsDirectoryPublicationJournalV1 = validateJournal({
    schemaVersion: 1,
    kind: 'windows-directory-publication',
    sequence: 0,
    transactionId,
    mode: options.operation.mode,
    overwriteAuthorization: options.operation.mode === 'replacement'
      ? options.operation.overwriteAuthorization
      : 'not-authorized',
    parentIdentity: identity(roots.parent),
    journalRootIdentity: identity(roots.journalRoot),
    journalDirectoryIdentity: identity(journalDirectory),
    destinationName: options.destinationName,
    candidateName: paths.names.candidateName,
    backupName: paths.names.backupName,
    expectedOld,
    candidate: null,
    backup: null,
    dependentStateSha256: options.dependentState.expectedSha256,
    phase: 'PLANNED'
  });
  journal = await appendJournal(options, io, paths.journalDirectory, undefined, journal);
  await options.hooks?.afterPhase?.('PLANNED');

  try {
    assertAuthority(options.authority, transactionId);
    createWindowsPrivateDirectory(options.backend, options.parentPath, paths.names.candidateName);
    await options.materialize(paths.candidate);
    assertAuthority(options.authority, transactionId);
    const candidate = expectation(await captureWindowsDirectoryClosure(options.backend, paths.candidate));
    const readyState = await observeNamespace(options.backend, options.parentPath, paths.names);
    if (!childMatches(readyState.candidate, candidate)
      || !childMatchesExpectedOld(readyState.destination, expectedOld)
      || readyState.backup.kind !== 'absent') {
      throw ambiguous('candidate or destination changed before publication');
    }
    journal = await advance(options, io, paths.journalDirectory, journal, 'CANDIDATE_READY', {
      candidate
    });
    await notifyPhase(options, journal);
  } catch (error) {
    if (journal.phase === 'PLANNED') {
      const terminalPhase = isPublicationAmbiguity(error) ? 'AMBIGUOUS' : 'ABORTED';
      await advance(options, io, paths.journalDirectory, journal, terminalPhase).catch(() => undefined);
    }
    throw error;
  }

  return continuePublication(options, io, paths, journal);
}

/** Recovers one exact transaction. It never scans or trusts arbitrary paths. */
export async function recoverWindowsDirectoryPublication(
  options: RecoverWindowsDirectoryPublicationOptions
): Promise<WindowsDirectoryPublicationResult> {
  assertAuthority(options.authority, options.transactionId);
  validateCommon(options, options.transactionId);
  const io = options.io ?? nodeWindowsDirectoryPublicationIo();
  const paths = transactionPaths(
    options.parentPath,
    options.journalRootPath,
    options.transactionId,
    options.destinationName
  );
  let journal = await readJournal(
    options.backend,
    options.parentPath,
    options.journalRootPath,
    paths.journalDirectory,
    options.transactionId
  );
  if (journal.destinationName !== options.destinationName) {
    throw journalInvalid('the requested destination does not match the journal');
  }
  assertJournalBindings(options.backend, options.parentPath, options.journalRootPath, paths.journalDirectory, journal);

  if (journal.phase === 'COMMITTED') {
    const state = await observeNamespace(options.backend, options.parentPath, paths.names);
    if (!committedState(state, journal)) return result(journal, 'ambiguous');
    return result(journal, 'terminal');
  }
  if (journal.phase === 'ABORTED') return result(journal, 'terminal');
  if (journal.phase === 'AMBIGUOUS') return result(journal, 'ambiguous');

  try {
    await assertDependentState(options, journal.dependentStateSha256);
  } catch (error) {
    if (!(error instanceof BazframeError)
      || error.code !== 'WINDOWS_DIRECTORY_PUBLICATION_CHANGED') throw error;
    journal = await advance(options, io, paths.journalDirectory, journal, 'AMBIGUOUS');
    await notifyPhase(options, journal);
    return result(journal, 'ambiguous');
  }
  const state = await observeNamespace(options.backend, options.parentPath, paths.names);
  if (journal.phase === 'PLANNED') {
    const initial = childMatchesExpectedOld(state.destination, journal.expectedOld)
      && state.candidate.kind === 'absent' && state.backup.kind === 'absent';
    journal = await advance(
      options,
      io,
      paths.journalDirectory,
      journal,
      initial ? 'ABORTED' : 'AMBIGUOUS'
    );
    await notifyPhase(options, journal);
    return result(journal, initial ? 'aborted' : 'ambiguous');
  }
  if (journal.phase === 'CANDIDATE_READY') {
    const unchanged = journal.candidate !== null
      && childMatchesExpectedOld(state.destination, journal.expectedOld)
      && childMatches(state.candidate, journal.candidate)
      && state.backup.kind === 'absent';
    journal = await advance(
      options,
      io,
      paths.journalDirectory,
      journal,
      unchanged ? 'ABORTED' : 'AMBIGUOUS'
    );
    await notifyPhase(options, journal);
    return result(journal, unchanged ? 'aborted' : 'ambiguous');
  }

  try {
    return await continuePublication(options, io, paths, journal);
  } catch (error) {
    if (!isRetainedRetry(error)) {
      const current = await readJournal(
        options.backend,
        options.parentPath,
        options.journalRootPath,
        paths.journalDirectory,
        options.transactionId
      );
      if (!terminal(current.phase)) {
        journal = await advance(options, io, paths.journalDirectory, current, 'AMBIGUOUS');
        await notifyPhase(options, journal);
        return result(journal, 'ambiguous');
      }
    }
    throw error;
  }
}

export function encodeWindowsDirectoryPublicationJournal(
  value: WindowsDirectoryPublicationJournalV1
): string {
  return `${JSON.stringify(validateJournal(value), null, 2)}\n`;
}

export function decodeWindowsDirectoryPublicationJournal(
  bytes: Uint8Array
): WindowsDirectoryPublicationJournalV1 {
  if (bytes.byteLength > JOURNAL_RECORD_BYTES) throw journalInvalid('record exceeds its byte limit');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw journalInvalid('record is not valid UTF-8 JSON', error);
  }
  const journal = validateJournal(value);
  if (!Buffer.from(encodeWindowsDirectoryPublicationJournal(journal)).equals(Buffer.from(bytes))) {
    throw journalInvalid('record bytes are not canonical');
  }
  return journal;
}

export function newWindowsDirectoryPublicationTransactionId(): string {
  return randomBytes(16).toString('hex');
}

function nodeWindowsDirectoryPublicationIo(): WindowsDirectoryPublicationIo {
  return {
    async appendFileExclusive(path, bytes) {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename
  };
}

async function continuePublication(
  options: CommonOptions,
  io: WindowsDirectoryPublicationIo,
  paths: ReturnType<typeof transactionPaths>,
  initial: WindowsDirectoryPublicationJournalV1
): Promise<WindowsDirectoryPublicationResult> {
  let journal = initial;
  try {
    if (journal.candidate === null) throw ambiguous('journal has no complete candidate proof');
    await assertDependentState(options, journal.dependentStateSha256);

    if (journal.mode === 'replacement') {
      if (journal.overwriteAuthorization !== 'explicit-overwrite' || journal.expectedOld === null) {
        throw overwriteRequired();
      }
      if (journal.phase === 'OLD_RENAME_INTENT') {
        const state = await observeNamespace(options.backend, options.parentPath, paths.names);
        if (oldDetachedState(state, journal)) {
          journal = await advance(options, io, paths.journalDirectory, journal, 'OLD_RENAME_PROVEN', {
            backup: journal.expectedOld
          });
          await notifyPhase(options, journal);
        } else if (replacementInitialState(state, journal)) {
          await attemptRename(
            options,
            io,
            paths.destination,
            paths.backup,
            replacementInitialState,
            oldDetachedState,
            journal,
            paths.names,
            'old destination to backup',
            options.hooks?.afterOldRename
          );
          journal = await advance(options, io, paths.journalDirectory, journal, 'OLD_RENAME_PROVEN', {
            backup: journal.expectedOld
          });
          await notifyPhase(options, journal);
        } else {
          throw ambiguous('replacement predicates do not match old-rename intent');
        }
      }
      if (journal.phase === 'OLD_RENAME_PROVEN') {
        const state = await observeNamespace(options.backend, options.parentPath, paths.names);
        if (!oldDetachedState(state, journal)) throw ambiguous('old-rename proof no longer holds');
        journal = await advance(options, io, paths.journalDirectory, journal, 'CANDIDATE_RENAME_INTENT');
        await notifyPhase(options, journal);
      }
      if (journal.phase === 'CANDIDATE_READY') {
        const state = await observeNamespace(options.backend, options.parentPath, paths.names);
        if (!replacementInitialState(state, journal)) throw ambiguous('replacement changed before old-rename intent');
        journal = await advance(options, io, paths.journalDirectory, journal, 'OLD_RENAME_INTENT');
        await notifyPhase(options, journal);
        return continuePublication(options, io, paths, journal);
      }
    } else if (journal.phase === 'CANDIDATE_READY') {
      const state = await observeNamespace(options.backend, options.parentPath, paths.names);
      if (!freshInitialState(state, journal)) throw ambiguous('fresh destination changed before publication intent');
      journal = await advance(options, io, paths.journalDirectory, journal, 'CANDIDATE_RENAME_INTENT');
      await notifyPhase(options, journal);
    }

    if (journal.phase === 'CANDIDATE_RENAME_INTENT') {
      const state = await observeNamespace(options.backend, options.parentPath, paths.names);
      if (!committedState(state, journal)) {
        const before = journal.mode === 'fresh' ? freshInitialState : oldDetachedState;
        if (!before(state, journal)) throw ambiguous('candidate publication predicates do not match intent');
        await attemptRename(
          options,
          io,
          paths.candidate,
          paths.destination,
          before,
          committedState,
          journal,
          paths.names,
          'candidate to destination',
          options.hooks?.afterCandidateRename
        );
      }
      journal = await advance(options, io, paths.journalDirectory, journal, 'CANDIDATE_RENAME_PROVEN');
      await notifyPhase(options, journal);
    }

    if (journal.phase === 'CANDIDATE_RENAME_PROVEN') {
      const state = await observeNamespace(options.backend, options.parentPath, paths.names);
      if (!committedState(state, journal)) throw ambiguous('published candidate proof no longer holds');
      await assertDependentState(options, journal.dependentStateSha256);
      journal = await advance(options, io, paths.journalDirectory, journal, 'DEPENDENT_STATE_PROVEN');
      await notifyPhase(options, journal);
    }
    if (journal.phase === 'DEPENDENT_STATE_PROVEN') {
      const state = await observeNamespace(options.backend, options.parentPath, paths.names);
      if (!committedState(state, journal)) throw ambiguous('publication changed before commit');
      await assertDependentState(options, journal.dependentStateSha256);
      journal = await advance(options, io, paths.journalDirectory, journal, 'COMMITTED');
      await notifyPhase(options, journal);
    }
    if (journal.phase !== 'COMMITTED') throw ambiguous('journal phase cannot complete publication');
    return result(journal, 'committed');
  } catch (error) {
    if (isRetainedRetry(error)) throw error;
    if (isPublicationPredicateFailure(error)) {
      if (!terminal(journal.phase)) {
        journal = await advance(options, io, paths.journalDirectory, journal, 'AMBIGUOUS');
        await notifyPhase(options, journal);
      }
      return result(journal, 'ambiguous');
    }
    throw error;
  }
}

async function attemptRename(
  options: CommonOptions,
  io: WindowsDirectoryPublicationIo,
  source: string,
  destination: string,
  before: (state: NamespaceObservation, journal: WindowsDirectoryPublicationJournalV1) => boolean,
  after: (state: NamespaceObservation, journal: WindowsDirectoryPublicationJournalV1) => boolean,
  journal: WindowsDirectoryPublicationJournalV1,
  names: ReturnType<typeof transactionPaths>['names'],
  label: string,
  afterRename?: () => void | Promise<void>
): Promise<void> {
  assertAuthority(options.authority, journal.transactionId);
  await assertDependentState(options, journal.dependentStateSha256);
  let renameError: unknown;
  try {
    await io.rename(source, destination);
  } catch (error) {
    renameError = error;
  }
  await afterRename?.();
  const state = await observeNamespace(options.backend, options.parentPath, names);
  await assertDependentState(options, journal.dependentStateSha256);
  if (after(state, journal)) return;
  if (renameError !== undefined && before(state, journal)) {
    throw new BazframeError(
      'WINDOWS_DIRECTORY_PUBLICATION_RETRY_REQUIRED',
      `Windows directory publication did not complete the ${label} rename; private transaction state was retained for recovery.`,
      { cause: renameError }
    );
  }
  throw ambiguous(`${label} rename outcome could not be proved`, renameError);
}

async function appendJournal(
  options: CommonOptions,
  io: WindowsDirectoryPublicationIo,
  journalDirectory: string,
  previous: WindowsDirectoryPublicationJournalV1 | undefined,
  next: WindowsDirectoryPublicationJournalV1
): Promise<WindowsDirectoryPublicationJournalV1> {
  assertAuthority(options.authority, next.transactionId);
  if (previous === undefined) {
    if (next.sequence !== 0 || next.phase !== 'PLANNED') throw journalInvalid('initial record is invalid');
  } else {
    assertJournalUpdate(previous, next);
  }
  const bytes = Buffer.from(encodeWindowsDirectoryPublicationJournal(next));
  const recordPath = win32.join(journalDirectory, journalRecordName(next.sequence));
  let writeError: unknown;
  try {
    await io.appendFileExclusive(recordPath, bytes);
  } catch (error) {
    writeError = error;
  }
  try {
    const persisted = await readJournal(
      options.backend,
      options.parentPath,
      options.journalRootPath,
      journalDirectory,
      next.transactionId
    );
    if (!same(persisted, next)) throw journalInvalid('persisted record differs from intended state');
    return persisted;
  } catch (error) {
    throw new BazframeError(
      'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_WRITE_AMBIGUOUS',
      'The publication journal write could not be proved; private transaction state was retained.',
      { cause: writeError ?? error }
    );
  }
}

async function advance(
  options: CommonOptions,
  io: WindowsDirectoryPublicationIo,
  journalDirectory: string,
  previous: WindowsDirectoryPublicationJournalV1,
  phase: WindowsDirectoryPublicationPhase,
  updates: Partial<WindowsDirectoryPublicationJournalV1> = {}
): Promise<WindowsDirectoryPublicationJournalV1> {
  const next = validateJournal({ ...previous, ...updates, sequence: previous.sequence + 1, phase });
  return appendJournal(options, io, journalDirectory, previous, next);
}

async function notifyPhase(
  options: CommonOptions,
  journal: WindowsDirectoryPublicationJournalV1
): Promise<void> {
  await options.hooks?.afterPhase?.(journal.phase);
}

async function readJournal(
  backend: BazframeWin32NativeBackend,
  parentPath: string,
  journalRootPath: string,
  journalDirectory: string,
  transactionId: string
): Promise<WindowsDirectoryPublicationJournalV1> {
  const closure = await captureWindowsDirectoryClosure(backend, journalDirectory, {
    maxEntries: MAX_JOURNAL_RECORDS,
    maxDepth: 0,
    maxPathBytes: Buffer.byteLength(journalRecordName(MAX_JOURNAL_RECORDS - 1), 'utf8'),
    maxFileBytes: JOURNAL_RECORD_BYTES,
    maxAggregateBytes: JOURNAL_RECORD_BYTES * MAX_JOURNAL_RECORDS
  });
  if (closure.closure.entries.length === 0
    || closure.closure.entries.some((entry) => entry.kind !== 'file')) {
    throw journalInvalid('journal directory has no complete record sequence');
  }
  let previous: WindowsDirectoryPublicationJournalV1 | undefined;
  for (let index = 0; index < closure.closure.entries.length; index += 1) {
    const entry = closure.closure.entries[index]!;
    if (entry.kind !== 'file') throw journalInvalid('journal contains a non-file entry');
    const match = RECORD_NAME.exec(entry.path);
    if (match === null || Number(match[1]) !== index) throw journalInvalid('record names are not contiguous');
    const receipt = await backend.readStableFile(win32.join(journalDirectory, entry.path), JOURNAL_RECORD_BYTES);
    if (receipt.bytes.byteLength !== entry.bytes
      || createHash('sha256').update(receipt.bytes).digest('hex') !== entry.sha256
      || receipt.before.volumeIdentity !== entry.volumeIdentity
      || receipt.after.volumeIdentity !== entry.volumeIdentity
      || receipt.before.fileId !== entry.fileId
      || receipt.after.fileId !== entry.fileId) {
      throw journalInvalid('record bytes differ from the admitted journal closure');
    }
    const current = decodeWindowsDirectoryPublicationJournal(receipt.bytes);
    if (current.sequence !== index || current.transactionId !== transactionId) {
      throw journalInvalid('record sequence or transaction identity changed');
    }
    if (previous === undefined) {
      if (current.phase !== 'PLANNED') throw journalInvalid('journal does not begin at PLANNED');
    } else {
      assertJournalUpdate(previous, current);
    }
    previous = current;
  }
  if (previous === undefined) throw journalInvalid('journal is empty');
  const finalClosure = await captureWindowsDirectoryClosure(backend, journalDirectory, {
    maxEntries: MAX_JOURNAL_RECORDS,
    maxDepth: 0,
    maxPathBytes: Buffer.byteLength(journalRecordName(MAX_JOURNAL_RECORDS - 1), 'utf8'),
    maxFileBytes: JOURNAL_RECORD_BYTES,
    maxAggregateBytes: JOURNAL_RECORD_BYTES * MAX_JOURNAL_RECORDS
  });
  if (finalClosure.rootIdentity !== closure.rootIdentity
    || finalClosure.closureSha256 !== closure.closureSha256) {
    throw journalInvalid('journal closure changed while records were read');
  }
  assertJournalBindings(backend, parentPath, journalRootPath, journalDirectory, previous);
  return previous;
}

function assertJournalBindings(
  backend: BazframeWin32NativeBackend,
  parentPath: string,
  journalRootPath: string,
  journalDirectory: string,
  journal: WindowsDirectoryPublicationJournalV1
): void {
  const parent = admitWindowsPrivateDirectory(backend, parentPath);
  const journalRoot = admitWindowsPrivateDirectory(backend, journalRootPath);
  const directory = admitWindowsPrivateDirectory(backend, journalDirectory);
  if (windowsPathsOverlap(parent.canonicalPath, journalRoot.canonicalPath)) {
    throw new BazframeError(
      'WINDOWS_DIRECTORY_PUBLICATION_STORAGE_INVALID',
      'Publication and journal roots must be physically disjoint.'
    );
  }
  if (identity(parent) !== journal.parentIdentity
    || identity(journalRoot) !== journal.journalRootIdentity
    || identity(directory) !== journal.journalDirectoryIdentity) {
    throw journalInvalid('bound directory identity changed');
  }
  requireSameVolumeAndUser(parent, journalRoot, directory);
}

async function observeNamespace(
  backend: BazframeWin32NativeBackend,
  parentPath: string,
  names: { destinationName: string; candidateName: string; backupName: string }
): Promise<NamespaceObservation> {
  const parent = admitWindowsPrivateDirectory(backend, parentPath);
  const before = await backend.enumerateStableDirectory(
    parentPath,
    PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries
  );
  requireSameDirectory(parent, before.directoryBefore);
  requireSameSecurity(parent.security, before.directoryBefore.security);
  requireSameDirectory(before.directoryBefore, before.directoryAfter);
  requireSameSecurity(before.directoryBefore.security, before.directoryAfter.security);
  const matched = new Map<keyof typeof names, WindowsDirectoryEntryObservation | undefined>();
  for (const key of Object.keys(names) as Array<keyof typeof names>) {
    const targetKey = portableKey(names[key]);
    const entries = before.entries.filter((entry) => portableKey(entry.name) === targetKey);
    if (entries.length > 1) throw ambiguous('parent contains equivalent publication names');
    matched.set(key, entries[0]);
  }
  const used = [...matched.values()].filter((entry): entry is WindowsDirectoryEntryObservation => entry !== undefined);
  if (new Set(used).size !== used.length) throw ambiguous('publication names resolve to one colliding entry');

  const capture = async (entry: WindowsDirectoryEntryObservation | undefined): Promise<ChildObservation> => {
    if (entry === undefined) return { kind: 'absent' };
    if (!entry.directory || entry.reparseTag !== null) return { kind: 'occupied' };
    try {
      const found = expectation(await captureWindowsDirectoryClosure(
        backend,
        win32.join(parentPath, entry.name)
      ));
      if (found.rootIdentity !== `${parent.object.volumeIdentity}:${entry.fileId}`) return { kind: 'occupied' };
      return { kind: 'directory', expectation: found };
    } catch {
      return { kind: 'occupied' };
    }
  };
  const [destination, candidate, backup] = await Promise.all([
    capture(matched.get('destinationName')),
    capture(matched.get('candidateName')),
    capture(matched.get('backupName'))
  ]);
  const after = await backend.enumerateStableDirectory(
    parentPath,
    PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries
  );
  if (!sameEnumeration(before, after)) throw ambiguous('parent namespace changed while it was observed');
  const finalParent = admitWindowsPrivateDirectory(backend, parentPath);
  requireSameDirectory(parent, finalParent);
  requireSameSecurity(parent.security, finalParent.security);
  return { destination, candidate, backup };
}

function validateJournal(value: unknown): WindowsDirectoryPublicationJournalV1 {
  const root = exactRecord(value, [
    'schemaVersion', 'kind', 'sequence', 'transactionId', 'mode',
    'overwriteAuthorization', 'parentIdentity', 'journalRootIdentity',
    'journalDirectoryIdentity', 'destinationName', 'candidateName', 'backupName',
    'expectedOld', 'candidate', 'backup', 'dependentStateSha256', 'phase'
  ]);
  if (root.schemaVersion !== 1 || root.kind !== 'windows-directory-publication') {
    throw journalInvalid('schema identity is invalid');
  }
  if (!Number.isSafeInteger(root.sequence) || Number(root.sequence) < 0
    || Number(root.sequence) >= MAX_JOURNAL_RECORDS) throw journalInvalid('sequence is invalid');
  const transactionId = tx(root.transactionId);
  const mode = enumValue(root.mode, ['fresh', 'replacement'] as const, 'mode');
  const overwriteAuthorization = enumValue(
    root.overwriteAuthorization,
    ['not-authorized', 'explicit-overwrite'] as const,
    'overwrite authorization'
  );
  const destinationName = component(root.destinationName, 'destination name');
  const candidateName = component(root.candidateName, 'candidate name');
  const backupName = component(root.backupName, 'backup name');
  if (candidateName !== `.bazframe-candidate-${transactionId}`
    || backupName !== `.bazframe-backup-${transactionId}`
    || new Set([portableKey(destinationName), portableKey(candidateName), portableKey(backupName)]).size !== 3) {
    throw journalInvalid('publication sibling names are invalid or collide');
  }
  const expectedOld = nullableExpectation(root.expectedOld, 'expectedOld');
  const candidate = nullableExpectation(root.candidate, 'candidate');
  const backup = nullableExpectation(root.backup, 'backup');
  if ((mode === 'fresh') !== (expectedOld === null)
    || (mode === 'fresh') !== (overwriteAuthorization === 'not-authorized')) {
    throw journalInvalid('mode, old expectation, and overwrite authorization disagree');
  }
  const phase = enumValue(root.phase, [
    ...REPLACEMENT_ROUTE, 'ABORTED', 'AMBIGUOUS'
  ] as const, 'phase');
  const route = mode === 'fresh' ? FRESH_ROUTE : REPLACEMENT_ROUTE;
  if (!route.includes(phase) && phase !== 'ABORTED' && phase !== 'AMBIGUOUS') {
    throw journalInvalid('phase is invalid for the publication mode');
  }
  const routeIndex = route.indexOf(phase);
  if (phase === 'PLANNED' && (candidate !== null || backup !== null)) {
    throw journalInvalid('planned record cannot contain candidate or backup proof');
  }
  if (!terminal(phase) && routeIndex >= route.indexOf('CANDIDATE_READY') && candidate === null) {
    throw journalInvalid('candidate proof is required after candidate readiness');
  }
  if (mode === 'replacement' && !terminal(phase)) {
    const oldProven = REPLACEMENT_ROUTE.indexOf('OLD_RENAME_PROVEN');
    if (routeIndex < oldProven && backup !== null) {
      throw journalInvalid('backup proof appears before old rename is proven');
    }
    if (routeIndex >= oldProven && backup === null) {
      throw journalInvalid('backup proof is required after old rename');
    }
  }
  if (mode === 'fresh' && backup !== null) throw journalInvalid('fresh publication cannot contain backup proof');
  if (backup !== null && (expectedOld === null || !same(backup, expectedOld))) {
    throw journalInvalid('backup proof does not match the expected old directory');
  }
  return {
    schemaVersion: 1,
    kind: 'windows-directory-publication',
    sequence: Number(root.sequence),
    transactionId,
    mode,
    overwriteAuthorization,
    parentIdentity: windowsIdentity(root.parentIdentity, 'parent identity'),
    journalRootIdentity: windowsIdentity(root.journalRootIdentity, 'journal root identity'),
    journalDirectoryIdentity: windowsIdentity(root.journalDirectoryIdentity, 'journal directory identity'),
    destinationName,
    candidateName,
    backupName,
    expectedOld,
    candidate,
    backup,
    dependentStateSha256: sha(root.dependentStateSha256, 'dependent state digest'),
    phase
  };
}

function assertJournalUpdate(
  previous: WindowsDirectoryPublicationJournalV1,
  next: WindowsDirectoryPublicationJournalV1
): void {
  if (next.sequence !== previous.sequence + 1) throw journalInvalid('record sequence is not monotonic');
  const immutable = (value: WindowsDirectoryPublicationJournalV1) => ({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    transactionId: value.transactionId,
    mode: value.mode,
    overwriteAuthorization: value.overwriteAuthorization,
    parentIdentity: value.parentIdentity,
    journalRootIdentity: value.journalRootIdentity,
    journalDirectoryIdentity: value.journalDirectoryIdentity,
    destinationName: value.destinationName,
    candidateName: value.candidateName,
    backupName: value.backupName,
    expectedOld: value.expectedOld,
    dependentStateSha256: value.dependentStateSha256
  });
  if (!same(immutable(previous), immutable(next))) throw journalInvalid('immutable fields changed');
  const candidateIntroduction = previous.phase === 'PLANNED'
    && next.phase === 'CANDIDATE_READY'
    && previous.candidate === null
    && next.candidate !== null;
  if (!candidateIntroduction && !same(previous.candidate, next.candidate)) {
    throw journalInvalid('candidate proof changed outside candidate readiness');
  }
  const backupIntroduction = previous.phase === 'OLD_RENAME_INTENT'
    && next.phase === 'OLD_RENAME_PROVEN'
    && previous.backup === null
    && next.backup !== null;
  if (!backupIntroduction && !same(previous.backup, next.backup)) {
    throw journalInvalid('backup proof changed outside old-rename proof');
  }
  const route = previous.mode === 'fresh' ? FRESH_ROUTE : REPLACEMENT_ROUTE;
  if (terminal(previous.phase)) throw journalInvalid('terminal record cannot transition');
  if (next.phase === 'ABORTED') {
    if (previous.phase !== 'PLANNED' && previous.phase !== 'CANDIDATE_READY') {
      throw journalInvalid('publication cannot abort after rename intent');
    }
    return;
  }
  if (next.phase === 'AMBIGUOUS') return;
  const index = route.indexOf(previous.phase);
  if (index < 0 || route[index + 1] !== next.phase) {
    throw journalInvalid('phase transition is not monotonic');
  }
}

function requireInitialNamespace(
  state: NamespaceObservation,
  expectedOld: WindowsDirectoryPublicationExpectation | null,
  destinationName: string
): void {
  if (state.candidate.kind !== 'absent' || state.backup.kind !== 'absent') {
    throw new BazframeError(
      'WINDOWS_DIRECTORY_PUBLICATION_STAGING_OCCUPIED',
      'Windows directory publication candidate or backup is already occupied.'
    );
  }
  if (expectedOld === null) {
    if (state.destination.kind !== 'absent') {
      throw new BazframeError(
        'WINDOWS_DIRECTORY_PUBLICATION_DESTINATION_OCCUPIED',
        `Windows directory publication destination ${JSON.stringify(destinationName)} is occupied and was not replaced.`
      );
    }
    return;
  }
  if (!childMatches(state.destination, expectedOld)) {
    throw changed('replacement destination does not match the expected old directory');
  }
}

function replacementInitialState(
  state: NamespaceObservation,
  journal: WindowsDirectoryPublicationJournalV1
): boolean {
  return journal.expectedOld !== null && journal.candidate !== null
    && childMatches(state.destination, journal.expectedOld)
    && childMatches(state.candidate, journal.candidate)
    && state.backup.kind === 'absent';
}

function freshInitialState(
  state: NamespaceObservation,
  journal: WindowsDirectoryPublicationJournalV1
): boolean {
  return journal.mode === 'fresh' && journal.candidate !== null
    && state.destination.kind === 'absent'
    && childMatches(state.candidate, journal.candidate)
    && state.backup.kind === 'absent';
}

function oldDetachedState(
  state: NamespaceObservation,
  journal: WindowsDirectoryPublicationJournalV1
): boolean {
  return journal.mode === 'replacement' && journal.expectedOld !== null && journal.candidate !== null
    && state.destination.kind === 'absent'
    && childMatches(state.candidate, journal.candidate)
    && childMatches(state.backup, journal.expectedOld);
}

function committedState(
  state: NamespaceObservation,
  journal: WindowsDirectoryPublicationJournalV1
): boolean {
  if (journal.candidate === null
    || !childMatches(state.destination, journal.candidate)
    || state.candidate.kind !== 'absent') return false;
  return journal.mode === 'fresh'
    ? state.backup.kind === 'absent'
    : journal.expectedOld !== null && childMatches(state.backup, journal.expectedOld);
}

function childMatches(
  observed: ChildObservation,
  expected: WindowsDirectoryPublicationExpectation
): boolean {
  return observed.kind === 'directory' && same(observed.expectation, expected);
}

function childMatchesExpectedOld(
  observed: ChildObservation,
  expected: WindowsDirectoryPublicationExpectation | null
): boolean {
  return expected === null ? observed.kind === 'absent' : childMatches(observed, expected);
}

function expectation(value: WindowsDirectoryClosureExpectation): WindowsDirectoryPublicationExpectation {
  return validateExpectation({ rootIdentity: value.rootIdentity, closureSha256: value.closureSha256 }, 'directory');
}

function validateExpectation(value: unknown, label: string): WindowsDirectoryPublicationExpectation {
  const record = exactRecord(value, ['rootIdentity', 'closureSha256']);
  return {
    rootIdentity: windowsIdentity(record.rootIdentity, `${label} identity`),
    closureSha256: sha(record.closureSha256, `${label} closure digest`)
  };
}

function nullableExpectation(value: unknown, label: string): WindowsDirectoryPublicationExpectation | null {
  return value === null ? null : validateExpectation(value, label);
}

function admitRoots(
  backend: BazframeWin32NativeBackend,
  parentPath: string,
  journalRootPath: string
): { parent: WindowsPathInspection; journalRoot: WindowsPathInspection } {
  const parent = admitWindowsPrivateDirectory(backend, parentPath);
  const journalRoot = admitWindowsPrivateDirectory(backend, journalRootPath);
  if (windowsPathsOverlap(parent.canonicalPath, journalRoot.canonicalPath)) {
    throw new BazframeError(
      'WINDOWS_DIRECTORY_PUBLICATION_STORAGE_INVALID',
      'Publication and journal roots must be physically disjoint.'
    );
  }
  requireSameVolumeAndUser(parent, journalRoot);
  return { parent, journalRoot };
}

function requireSameVolumeAndUser(...values: WindowsPathInspection[]): void {
  const first = values[0];
  if (first === undefined || values.some((value) => value.volume.identity !== first.volume.identity
    || value.object.volumeIdentity !== first.object.volumeIdentity
    || value.security.currentUserSid !== first.security.currentUserSid)) {
    throw new BazframeError(
      'WINDOWS_DIRECTORY_PUBLICATION_STORAGE_INVALID',
      'Publication parent, journal, candidate, and backup must share one admitted local NTFS volume and current user.'
    );
  }
}

async function assertDependentState(
  options: CommonOptions,
  expected = options.dependentState.expectedSha256
): Promise<void> {
  sha(expected, 'dependent state digest');
  const observed = await options.dependentState.observeSha256();
  if (observed !== expected) throw changed('dependent state changed');
}

function validateCommon(options: CommonOptions, transactionId: string): void {
  tx(transactionId);
  component(options.destinationName, 'destination name');
  sha(options.dependentState.expectedSha256, 'dependent state digest');
  if (options.authority.transactionId !== transactionId) {
    throw authorityInvalid('authority transaction does not match the requested transaction');
  }
}

function journalRecordName(sequence: number): string {
  return `${String(sequence).padStart(8, '0')}.json`;
}

function identity(value: WindowsPathInspection): string {
  return `${value.object.volumeIdentity}:${value.object.fileId}`;
}

function requireSameDirectory(a: WindowsPathInspection, b: WindowsPathInspection): void {
  if (a.canonicalPath.toLowerCase() !== b.canonicalPath.toLowerCase()
    || a.kind !== 'directory' || b.kind !== 'directory'
    || identity(a) !== identity(b) || a.volume.identity !== b.volume.identity
    || a.object.reparseTag !== null || b.object.reparseTag !== null
    || a.object.deletePending || b.object.deletePending) {
    throw ambiguous('directory identity changed');
  }
}

function requireSameSecurity(a: WindowsSecurityObservation, b: WindowsSecurityObservation): void {
  if (a.descriptorControl !== b.descriptorControl || a.daclPresent !== b.daclPresent
    || a.daclNull !== b.daclNull || a.daclDefaulted !== b.daclDefaulted
    || !a.daclBytes.equals(b.daclBytes) || a.ownerSid !== b.ownerSid
    || a.ownerDefaulted !== b.ownerDefaulted || a.groupSid !== b.groupSid
    || a.groupDefaulted !== b.groupDefaulted || a.currentUserSid !== b.currentUserSid) {
    throw ambiguous('directory security changed');
  }
}

function sameEnumeration(
  a: WindowsStableDirectoryEnumerationReceipt,
  b: WindowsStableDirectoryEnumerationReceipt
): boolean {
  try {
    requireSameDirectory(a.directoryBefore, b.directoryBefore);
    requireSameDirectory(a.directoryAfter, b.directoryAfter);
    requireSameSecurity(a.directoryBefore.security, b.directoryBefore.security);
    requireSameSecurity(a.directoryAfter.security, b.directoryAfter.security);
    return JSON.stringify(a.entries) === JSON.stringify(b.entries);
  } catch {
    return false;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw journalInvalid('record must be a plain object');
  }
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) throw journalInvalid('record must be a plain object');
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw journalInvalid('record fields or key order are invalid');
  }
  return record;
}

function tx(value: unknown): string {
  if (typeof value !== 'string' || !TRANSACTION_ID.test(value)) throw journalInvalid('transaction ID is invalid');
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw journalInvalid(`${label} is invalid`);
  return value;
}

function windowsIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !WINDOWS_IDENTITY.test(value)) throw journalInvalid(`${label} is invalid`);
  return value;
}

function component(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isValidWindowsPathComponent(value)) throw journalInvalid(`${label} is invalid`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw journalInvalid(`${label} is invalid`);
  return value as T;
}

function portableKey(value: string): string {
  return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}

function windowsPathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\]+$/u, '').toLowerCase();
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}

function terminal(phase: WindowsDirectoryPublicationPhase): boolean {
  return phase === 'COMMITTED' || phase === 'ABORTED' || phase === 'AMBIGUOUS';
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertAuthority(authority: WindowsDirectoryPublicationAuthority, expected?: string): string {
  if (authority === null || typeof authority !== 'object'
    || typeof authority.transactionId !== 'string'
    || typeof authority.assertHeld !== 'function') {
    throw authorityInvalid('exclusive publication authority is missing');
  }
  const transactionId = tx(authority.transactionId);
  if (expected !== undefined && transactionId !== expected) {
    throw authorityInvalid('exclusive publication authority changed');
  }
  try {
    authority.assertHeld();
  } catch (error) {
    throw authorityInvalid('exclusive publication authority is not held', error);
  }
  return transactionId;
}

function result(
  journal: WindowsDirectoryPublicationJournalV1,
  action: WindowsDirectoryPublicationResult['action']
): WindowsDirectoryPublicationResult {
  return {
    transactionId: journal.transactionId,
    action,
    phase: journal.phase,
    backupRetained: journal.mode === 'replacement'
      && (journal.backup !== null || journal.phase === 'COMMITTED')
  };
}

function isRetainedRetry(error: unknown): boolean {
  return error instanceof BazframeError
    && error.code === 'WINDOWS_DIRECTORY_PUBLICATION_RETRY_REQUIRED';
}

function isPublicationAmbiguity(error: unknown): boolean {
  return error instanceof BazframeError && [
    'WINDOWS_DIRECTORY_PUBLICATION_AMBIGUOUS',
    'WINDOWS_DIRECTORY_PUBLICATION_CHANGED'
  ].includes(error.code);
}

function isPublicationPredicateFailure(error: unknown): boolean {
  return isPublicationAmbiguity(error) || (error instanceof BazframeError && [
    'WINDOWS_NATIVE_',
    'WINDOWS_PRIVATE_',
    'WINDOWS_DIRECTORY_CLOSURE_'
  ].some((prefix) => error.code.startsWith(prefix)));
}

function overwriteRequired(): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_PUBLICATION_OVERWRITE_REQUIRED',
    'Replacement requires explicit overwrite authorization; routine confirmation is insufficient.'
  );
}

function authorityInvalid(detail: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_PUBLICATION_AUTHORITY_INVALID',
    `Windows directory publication authority is invalid: ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}

function journalInvalid(detail: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_INVALID',
    `Invalid Windows directory publication journal: ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}

function changed(detail: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_PUBLICATION_CHANGED',
    `Windows directory publication changed: ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}

function ambiguous(detail: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_PUBLICATION_AMBIGUOUS',
    `Windows directory publication outcome is ambiguous: ${detail}; private state was retained.`,
    cause === undefined ? undefined : { cause }
  );
}

// Transaction-derived siblings cannot be caller-controlled.
function transactionPaths(
  parentPath: string,
  journalRootPath: string,
  transactionId: string,
  destinationName: string
) {
  const candidateName = `.bazframe-candidate-${transactionId}`;
  const backupName = `.bazframe-backup-${transactionId}`;
  return {
    names: { destinationName, candidateName, backupName },
    candidate: win32.join(parentPath, candidateName),
    backup: win32.join(parentPath, backupName),
    destination: win32.join(parentPath, destinationName),
    journalDirectory: win32.join(journalRootPath, transactionId)
  };
}
