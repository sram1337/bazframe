import { randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, WindowsDirectoryEntryObservation, WindowsPathInspection } from '../core/win32-native.js';
import { stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { readWindowsPhysicalFileSnapshot } from '../profiles/win32-profile-selection.js';
import { enumerateWindowsPhysicalDirectory } from '../skills/added-skill-platform-services.js';
import { profilePublishingTransactionRoot } from '../state/paths.js';
import { requireDirectChild, requireEntryMatchesObject } from '../state/win32-directory-closure.js';
import { admitWindowsPhysicalDirectory, admitWindowsPhysicalFile, createWindowsPrivateDirectory, createWindowsPrivateFile } from '../state/win32-private-directory.js';
import { assertWindowsOperationMutationAuthority, type OperationMutationAuthority } from './profile-operation-lock.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { decodeTransactionJournalBytes, encodeTransactionJournal, isTransactionJournalName, transactionJournalRequiredAuthorityKeys, validateTransactionJournalUpdate, type TransactionJournalV2 } from './transaction-journal.js';

export interface WindowsTransactionJournalOptions {
  lower?: Partial<CapturedProfileLimitPolicy>;
  io?: {
    writeExistingFile(path: string, bytes: Uint8Array): Promise<void>;
    rename(source: string, destination: string): Promise<void>;
  };
  hooks?: {
    afterPrivateCreation?(): void | Promise<void>;
    afterCandidateRead?(): void | Promise<void>;
    beforeReplacement?(): void | Promise<void>;
    afterReplacement?(): void | Promise<void>;
  };
}
type FileSnapshot = Awaited<ReturnType<typeof readWindowsPhysicalFileSnapshot>>;
type Enumeration = Awaited<ReturnType<typeof enumerateWindowsPhysicalDirectory>>;
interface RequestedState {
  enumeration: Enumeration;
  payloads: Map<string, FileSnapshot>;
  anchors: WindowsPathInspection[];
}
const nativeIo: NonNullable<WindowsTransactionJournalOptions['io']> = {
  async writeExistingFile(path, bytes) {
    const handle = await open(path, 'r+');
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  },
  rename
};

/** Internal V2 transport only: no bootstrap, replay, profile movement, or public wiring. */
export async function readWindowsTransactionJournal(backend: BazframeWin32NativeBackend, home: string, transactionId: string, lower: Partial<CapturedProfileLimitPolicy> = {}): Promise<TransactionJournalV2 | undefined> {
  try {
    const name = finalName(transactionId), policy = capturedProfileLimitPolicy(lower);
    const namespace = await scan(backend, home, policy, [name]);
    const file = namespace?.payloads.get(name);
    return file === undefined ? undefined : decode(file.bytes, transactionId, policy);
  } catch (cause) { throw failure('REFUSED', cause); }
}

/** Bounded deterministic discovery; requested-ID reads above remain sibling-content independent. */
export async function scanWindowsTransactionJournals(backend: BazframeWin32NativeBackend, home: string): Promise<string[]> {
  const policy = capturedProfileLimitPolicy();
  const found = await scan(backend, home, policy, []);
  if (found === undefined) return [];
  const names = found.enumeration.names;
  for (const name of names) {
    if (!isTransactionJournalName(name) && !/^\.tmp-[a-f0-9]{32}$/u.test(name)) throw failure('REFUSED');
  }
  // Admit every discovered object, including temps, without buffering the namespace's
  // payloads. The recovery loop reads one bounded final at a time, again under locks.
  const root = win32.normalize(profilePublishingTransactionRoot(home));
  for (const entry of found.enumeration.nativeEntries) {
    reconcile(found.enumeration, entry, admitWindowsPhysicalFile(backend, win32.join(root, entry.name)));
  }
  const admitted = required(await scan(backend, home, policy, []));
  assertAnchors(found, admitted);
  if (JSON.stringify(found.enumeration.nativeEntries) !== JSON.stringify(admitted.enumeration.nativeEntries)) throw failure('REFUSED');
  return names.filter(isTransactionJournalName).sort();
}

export async function writeWindowsTransactionJournal<T extends TransactionJournalV2>(backend: BazframeWin32NativeBackend, home: string, authority: OperationMutationAuthority, journal: T, options: WindowsTransactionJournalOptions = {}): Promise<T> {
  let next: TransactionJournalV2, bytes: Buffer, policy: CapturedProfileLimitPolicy;
  let previous: FileSnapshot | undefined, baseline: RequestedState, candidate: FileSnapshot;
  let component: string;
  const root = win32.normalize(profilePublishingTransactionRoot(home));
  const io = options.io ?? nativeIo;
  const assertHeld = () => assertWindowsOperationMutationAuthority(authority, backend, home, transactionJournalRequiredAuthorityKeys(next), next.transactionId);
  try {
    policy = capturedProfileLimitPolicy(options.lower);
    // Encoding alone does not enforce the serialized byte ceiling. Own and decode before effects.
    bytes = Buffer.from(encodeTransactionJournal(journal, policy));
    const decoded = decodeTransactionJournalBytes(bytes, policy);
    if (decoded.schemaVersion !== 2 || decoded.identityDomain !== 'win32-ntfs') throw failure('REFUSED');
    next = decoded;
    const name = finalName(next.transactionId);
    assertHeld();
    const admittedHome = ownInspection(admitWindowsPhysicalDirectory(backend, home));
    const initial = await scan(backend, home, policy, [name]);
    previous = initial?.payloads.get(name);
    validateTransactionJournalUpdate(previous === undefined ? undefined : decode(previous.bytes, next.transactionId, policy), next, policy);
    await ensureRoot(backend, home, policy, assertHeld);
    baseline = required(await scan(backend, home, policy, [name]));
    if (!sameDirectoryAnchor(admittedHome, baseline.anchors[0]!)) throw failure('REFUSED');
    if (initial !== undefined) assertRequestedUnchanged(initial, baseline, name);
    previous = baseline.payloads.get(name);
    validateTransactionJournalUpdate(previous === undefined ? undefined : decode(previous.bytes, next.transactionId, policy), next, policy);
    room(baseline.enumeration, policy);
    assertHeld();
    const fresh = required(await scan(backend, home, policy, [name]));
    assertRequestedUnchanged(baseline, fresh, name);
    room(fresh.enumeration, policy);
    baseline = fresh;
    component = previous === undefined ? name : `.tmp-${randomBytes(16).toString('hex')}`;
    assertHeld();
    if (!sameDirectoryAnchor(baseline.enumeration.inspection, admitWindowsPhysicalDirectory(backend, root))) throw failure('REFUSED');
    const created = ownInspection(createWindowsPrivateFile(backend, root, component));
    await options.hooks?.afterPrivateCreation?.();
    assertHeld();
    const empty = await readFile(backend, win32.join(root, component), policy.maxManifestBytes);
    if (!exactInspection(created, empty.inspection) || empty.bytes.length !== 0) throw failure('REFUSED');
    // A rejected write includes flush/close uncertainty: never infer completion from readable bytes.
    assertHeld();
    if (!sameDirectoryAnchor(baseline.enumeration.inspection, admitWindowsPhysicalDirectory(backend, root))) throw failure('REFUSED');
    await io.writeExistingFile(win32.join(root, component), Buffer.from(bytes));
    candidate = await readFile(backend, win32.join(root, component), policy.maxManifestBytes);
    if (!sameDirectoryAnchor(created, candidate.inspection) || !candidate.bytes.equals(bytes)) throw failure('REFUSED');
    decode(candidate.bytes, next.transactionId, policy);
    await options.hooks?.afterCandidateRead?.();
    const completed = required(await scan(backend, home, policy, [name, component]));
    assertAnchors(baseline, completed);
    if (previous !== undefined) assertRequestedUnchanged(baseline, completed, name);
    if (!exactFile(candidate, required(completed.payloads.get(component)))) throw failure('REFUSED');
    assertHeld();
    if (previous === undefined) return decode(candidate.bytes, next.transactionId, policy) as T;
    await options.hooks?.beforeReplacement?.();
    assertHeld();
    const final = required(await scan(backend, home, policy, [name, component]));
    assertAnchors(completed, final);
    if (!exactFile(candidate, required(final.payloads.get(component))) || !exactFile(previous, required(final.payloads.get(name)))) throw failure('REFUSED');
    assertHeld();
  } catch (cause) { throw failure('BEFORE_REPLACEMENT', cause); }

  let rejected = false, renameCause: unknown;
  try { await io.rename(win32.join(root, component), win32.join(root, finalName(next.transactionId))); }
  catch (cause) { rejected = true; renameCause = cause; }
  try { await options.hooks?.afterReplacement?.(); }
  catch (cause) { renameCause ??= cause; }
  try {
    assertHeld();
    const name = finalName(next.transactionId);
    const current = required(await scan(backend, home, policy, [name, component]));
    assertHeld();
    assertAnchors(baseline, current);
    const final = required(current.payloads.get(name)), retained = current.payloads.get(component);
    // This is the attempted journal FILE movement predicate, not unchanged-path or profile relocation.
    if (retained === undefined && sameObject(candidate.inspection, final.inspection)
      && candidate.inspection.object.size === final.inspection.object.size
      && candidate.inspection.object.allocationSize === final.inspection.object.allocationSize
      && candidate.inspection.object.lastWriteTime === final.inspection.object.lastWriteTime
      && final.bytes.equals(bytes)) {
      return decode(final.bytes, next.transactionId, policy) as T;
    }
    if (!rejected || retained === undefined || !exactFile(previous, final) || !exactFile(candidate, retained)) throw failure('AMBIGUOUS', renameCause);
  } catch (cause) { throw failure('AMBIGUOUS', cause); }
  // Only our proved tuple can produce NO_EFFECT, never an injected read error's code.
  throw failure('NO_EFFECT', renameCause);
}

/** Stable parent enumeration, not missing-read exceptions, is the only absence authority. */
async function directoryChild(backend: BazframeWin32NativeBackend, parent: string, component: string, policy: CapturedProfileLimitPolicy): Promise<{ enumeration: Enumeration; child?: WindowsPathInspection }> {
  const enumeration = await enumerateWindowsPhysicalDirectory(backend, parent, policy.maxEntries);
  const matches = enumeration.nativeEntries.filter((entry) => key(entry.name) === key(component));
  let child: WindowsPathInspection | undefined;
  if (matches.length !== 0) {
    if (matches.length !== 1 || matches[0]!.name !== component) throw failure('REFUSED');
    child = ownInspection(admitWindowsPhysicalDirectory(backend, win32.join(parent, component)));
    reconcile(enumeration, matches[0]!, child);
  }
  if (!sameDirectoryAnchor(enumeration.inspection, admitWindowsPhysicalDirectory(backend, parent))) throw failure('REFUSED');
  return { enumeration, ...(child === undefined ? {} : { child }) };
}
async function ensureRoot(backend: BazframeWin32NativeBackend, home: string, policy: CapturedProfileLimitPolicy, assertHeld: () => void): Promise<void> {
  let parent = home;
  admitWindowsPhysicalDirectory(backend, parent);
  for (const component of ['profile-publishing', 'transactions']) {
    const before = await directoryChild(backend, parent, component, policy);
    if (before.child === undefined) {
      room(before.enumeration, policy);
      assertHeld();
      if (!sameDirectoryAnchor(before.enumeration.inspection, admitWindowsPhysicalDirectory(backend, parent))) throw failure('REFUSED');
      try { createWindowsPrivateDirectory(backend, parent, component); }
      catch (cause) { if (errorCode(cause) !== 'WINDOWS_PRIVATE_DIRECTORY_OCCUPIED') throw cause; }
      // Exact occupied races may be freshly admitted; ambiguous creation never retries.
      const after = await directoryChild(backend, parent, component, policy);
      required(after.child);
      if (!sameDirectoryAnchor(before.enumeration.inspection, after.enumeration.inspection)) throw failure('REFUSED');
    }
    parent = win32.join(parent, component);
  }
}
async function scan(backend: BazframeWin32NativeBackend, home: string, policy: CapturedProfileLimitPolicy, readNames: readonly string[]): Promise<RequestedState | undefined> {
  let parent = home;
  const anchors = [ownInspection(admitWindowsPhysicalDirectory(backend, home))];
  const paths = [home];
  for (const component of ['profile-publishing', 'transactions']) {
    const found = await directoryChild(backend, parent, component, policy);
    if (!sameDirectoryAnchor(anchors[anchors.length - 1]!, found.enumeration.inspection)) throw failure('REFUSED');
    if (found.child === undefined) {
      revalidateAnchors();
      return undefined;
    }
    anchors.push(found.child);
    parent = win32.join(parent, component);
    paths.push(parent);
  }
  const enumeration = await enumerateWindowsPhysicalDirectory(backend, parent, policy.maxEntries);
  if (!sameDirectoryAnchor(anchors[anchors.length - 1]!, enumeration.inspection)) throw failure('REFUSED');
  const payloads = new Map<string, FileSnapshot>();
  for (const name of new Set(readNames)) {
    const matches = enumeration.nativeEntries.filter((entry) => key(entry.name) === key(name));
    if (matches.length === 0) continue;
    if (matches.length !== 1 || matches[0]!.name !== name) throw failure('REFUSED');
    const path = win32.join(parent, name);
    const inspection = ownInspection(admitWindowsPhysicalFile(backend, path));
    reconcile(enumeration, matches[0]!, inspection);
    const file = await readFile(backend, path, policy.maxManifestBytes);
    if (!exactInspection(inspection, file.inspection)) throw failure('REFUSED');
    payloads.set(name, file);
  }
  revalidateAnchors();
  return { enumeration, payloads, anchors };
  function revalidateAnchors() {
    for (const [index, path] of paths.entries()) {
      if (!sameDirectoryAnchor(anchors[index]!, admitWindowsPhysicalDirectory(backend, path))) throw failure('REFUSED');
    }
  }
}
function reconcile(parent: Enumeration, entry: WindowsDirectoryEntryObservation, child: WindowsPathInspection): void {
  requireDirectChild(parent.inspection, child, entry.name);
  if (win32.basename(child.canonicalPath) !== entry.name) throw failure('REFUSED');
  requireEntryMatchesObject(entry, child.object, child.kind === 'directory' ? 'entry-vs-directory-open' : 'entry-vs-file-open');
}
function assertRequestedUnchanged(before: RequestedState, after: RequestedState, name: string): void {
  assertAnchors(before, after);
  const previous = before.payloads.get(name), current = after.payloads.get(name);
  if (previous === undefined ? current !== undefined : current === undefined || !exactFile(previous, current)) throw failure('REFUSED');
}
function assertAnchors(before: RequestedState, after: RequestedState): void {
  if (before.anchors.length !== after.anchors.length || before.anchors.some((anchor, index) => !sameDirectoryAnchor(anchor, after.anchors[index]!))) throw failure('REFUSED');
}
/** Directory identity and private admission survive unrelated namespace changes. */
function sameDirectoryAnchor(a: WindowsPathInspection, b: WindowsPathInspection): boolean {
  return a.canonicalPath === b.canonicalPath && sameObject(a, b) && JSON.stringify(a.volume) === JSON.stringify(b.volume) && a.ancestryReparseFree === b.ancestryReparseFree;
}
function sameObject(a: WindowsPathInspection, b: WindowsPathInspection): boolean {
  return a.kind === b.kind && a.object.volumeIdentity === b.object.volumeIdentity && a.object.fileId === b.object.fileId
    && a.object.creationTime === b.object.creationTime && a.object.numberOfLinks === b.object.numberOfLinks
    && a.object.attributes === b.object.attributes;
}
function ownInspection(value: WindowsPathInspection): WindowsPathInspection {
  return { ...value, volume: { ...value.volume }, object: { ...value.object } };
}
async function readFile(backend: BazframeWin32NativeBackend, path: string, maxBytes: number): Promise<FileSnapshot> {
  const value = await readWindowsPhysicalFileSnapshot(backend, path, maxBytes);
  return { bytes: Buffer.from(value.bytes), inspection: ownInspection(value.inspection) };
}
function exactInspection(a: WindowsPathInspection, b: WindowsPathInspection): boolean { return JSON.stringify(stableWindowsPathInspection(a)) === JSON.stringify(stableWindowsPathInspection(b)); }
function exactFile(a: FileSnapshot, b: FileSnapshot): boolean { return a.bytes.equals(b.bytes) && exactInspection(a.inspection, b.inspection); }
function decode(bytes: Buffer, transactionId: string, policy: CapturedProfileLimitPolicy): TransactionJournalV2 {
  const journal = decodeTransactionJournalBytes(bytes, policy);
  if (journal.schemaVersion !== 2 || journal.identityDomain !== 'win32-ntfs' || journal.transactionId !== transactionId) throw failure('REFUSED');
  return journal;
}
function finalName(transactionId: string): string { if (typeof transactionId !== 'string' || !/^[a-f0-9]{32}$/u.test(transactionId)) throw failure('REFUSED'); return `${transactionId}.json`; }
function key(value: string): string { return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase(); }
function room(enumeration: Enumeration, policy: CapturedProfileLimitPolicy): void { if (enumeration.names.length >= policy.maxEntries) throw failure('REFUSED'); }
function required<T>(value: T | undefined): T { if (value === undefined) throw failure('REFUSED'); return value; }
function failure(detail: 'REFUSED' | 'BEFORE_REPLACEMENT' | 'NO_EFFECT' | 'AMBIGUOUS', cause?: unknown): BazframeError {
  return new BazframeError(`WINDOWS_TRANSACTION_JOURNAL_${detail}`, 'Windows transaction journal storage refused or uncertain; retain occupied journal state. No recovery or cleanup was attempted.', { cause });
}
