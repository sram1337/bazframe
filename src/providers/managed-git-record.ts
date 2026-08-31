import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { readAtMostOneBeyond } from '../state/bounded-file-read.js';
import { containsUnsafeDisplayCharacters, escapeUnsafeDisplayCharacters, replaceUnsafeDisplayCharacters } from '../core/safe-text.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import type { SkillCollectionKind } from '../skill-collections/skill-collection-store.js';
import { canonicalManagedGitSourceForIdentity, parseManagedGitSource } from './managed-git-source.js';

export type ManagedGitResourceKind = 'skill' | SkillCollectionKind;
export interface ManagedGitRecord {
  schemaVersion: 1;
  kind: ManagedGitResourceKind;
  id: string;
  root: string;
  remote: string;
  fetchUrl: string;
  transport: 'git' | 'gh';
  branch: string;
  revision: string;
}
export interface PathFreeManagedGitIdentity {
  remote: string;
  fetchUrl: string;
  branch: string;
  revision: string;
}
export interface ManagedGitRecordSnapshot {
  record: ManagedGitRecord;
  path: string;
  device: bigint;
  inode: bigint;
  contentSha256: string;
}
export type ManagedGitOperation = 'add' | 'add-exact' | 'update' | 'remove' | 'build';
export interface ManagedGitJournal {
  schemaVersion: 1;
  operation: ManagedGitOperation;
  phase: string;
  kind: ManagedGitResourceKind;
  id: string;
  remote: string;
  fetchUrl: string;
  transport: 'git' | 'gh';
  branch: string;
  previousRevision: string | null;
  nextRevision: string;
  root: string;
  staging: string | null;
  backup: string | null;
  resourceStateSha256: string | null;
}
export interface ManagedGitJournalSnapshot {
  journal: ManagedGitJournal;
  path: string;
  device: bigint;
  inode: bigint;
  contentSha256: string;
}
export interface ManagedGitRecordDiagnostic {
  kind: ManagedGitResourceKind;
  id: string;
  path: string;
  message: string;
}
export interface ManagedGitRecordReadOptions {
  maxBytes?: number;
  testHooks?: { afterInitialStat?: () => void | Promise<void>; afterPathStat?: () => void | Promise<void>; afterClose?: () => void | Promise<void> };
}

const RECORD_KEYS = ['branch', 'fetchUrl', 'id', 'kind', 'remote', 'revision', 'root', 'schemaVersion', 'transport'] as const;
const PATH_FREE_IDENTITY_KEYS = ['branch', 'fetchUrl', 'remote', 'revision'] as const;
const JOURNAL_KEYS = ['backup', 'branch', 'fetchUrl', 'id', 'kind', 'nextRevision', 'operation', 'phase', 'previousRevision', 'remote', 'resourceStateSha256', 'root', 'schemaVersion', 'staging', 'transport'] as const;
const KINDS = new Set<ManagedGitResourceKind>(['skill', 'library', 'package']);
const OPERATIONS = new Set<ManagedGitOperation>(['add', 'add-exact', 'update', 'remove', 'build']);
export const MAX_MANAGED_GIT_RECORD_BYTES = 16 * 1024;

export function managedGitRoot(home: string): string { return join(home, 'providers', 'git'); }
export function managedGitCheckoutsRoot(home: string): string { return join(managedGitRoot(home), 'checkouts'); }
export function managedGitCheckoutRoot(home: string, kind: ManagedGitResourceKind, id: string): string { return join(managedGitCheckoutsRoot(home), kind, id); }
export function managedGitRecordsRoot(home: string): string { return join(managedGitRoot(home), 'records'); }
export function managedGitRecordPath(home: string, kind: ManagedGitResourceKind, id: string): string { return join(managedGitRecordsRoot(home), kind, `${id}.json`); }
export function managedGitStagingRoot(home: string): string { return join(managedGitRoot(home), 'staging'); }
export function managedGitRecoveryRoot(home: string): string { return join(managedGitRoot(home), 'recovery'); }
export function managedGitJournalPath(home: string, kind: ManagedGitResourceKind, id: string): string { return join(managedGitRecoveryRoot(home), `${kind}-${id}.json`); }

export function encodeManagedGitRecord(record: ManagedGitRecord): string {
  return `${JSON.stringify({ schemaVersion: 1, kind: record.kind, id: record.id, root: record.root, remote: record.remote, fetchUrl: record.fetchUrl, transport: record.transport, branch: record.branch, revision: record.revision }, null, 2)}\n`;
}
export function encodeManagedGitJournal(journal: ManagedGitJournal): string {
  return `${JSON.stringify({ schemaVersion: 1, operation: journal.operation, phase: journal.phase, kind: journal.kind, id: journal.id, remote: journal.remote, fetchUrl: journal.fetchUrl, transport: journal.transport, branch: journal.branch, previousRevision: journal.previousRevision, nextRevision: journal.nextRevision, root: journal.root, staging: journal.staging, backup: journal.backup, resourceStateSha256: journal.resourceStateSha256 }, null, 2)}\n`;
}

export function decodeManagedGitRecord(value: unknown, expected?: { kind: ManagedGitResourceKind; id: string }): ManagedGitRecord {
  const candidate = exactObject(value, RECORD_KEYS, 'record', invalid);
  if (candidate.schemaVersion !== 1) throw invalid('unsupported schemaVersion');
  const kind = decodeKind(candidate.kind);
  if (typeof candidate.id !== 'string' || !isSafeSkillId(candidate.id)) throw invalid('id is invalid');
  if (expected !== undefined && (kind !== expected.kind || candidate.id !== expected.id)) throw invalid('record identity does not match its path');
  const root = decodeRoot(candidate.root);
  if (basename(root) !== candidate.id) throw invalid('root basename does not match id');
  const identity = decodePathFreeManagedGitIdentity({
    remote: candidate.remote,
    fetchUrl: candidate.fetchUrl,
    branch: candidate.branch,
    revision: candidate.revision
  }, candidate.id);
  if (candidate.transport !== 'git' && candidate.transport !== 'gh') throw invalid('transport is invalid');
  if (candidate.transport === 'gh' && !identity.remote.startsWith('github.com/')) throw invalid('gh transport requires a GitHub remote');
  return { schemaVersion: 1, kind, id: candidate.id, root, ...identity, transport: candidate.transport };
}

export function decodePathFreeManagedGitIdentity(value: unknown, expectedId?: string): PathFreeManagedGitIdentity {
  const candidate = exactObject(value, PATH_FREE_IDENTITY_KEYS, 'path-free identity', invalid);
  assertBoundedPathFreeIdentityInput(candidate);
  let source;
  try {
    source = expectedId === undefined
      ? parseManagedGitSource(candidate.fetchUrl)
      : canonicalManagedGitSourceForIdentity(expectedId, { remote: candidate.remote, fetchUrl: candidate.fetchUrl });
  } catch { throw invalid('fetchUrl or remote Git source identity is not canonical'); }
  if (source.remote !== candidate.remote || source.fetchUrl !== candidate.fetchUrl) throw invalid('fetchUrl does not match canonical remote identity');
  const branch = decodeBranch(candidate.branch);
  const revision = decodeRevision(candidate.revision);
  const identity = { remote: source.remote, fetchUrl: source.fetchUrl, branch, revision };
  if (Buffer.byteLength(`${JSON.stringify(identity, null, 2)}\n`, 'utf8') > MAX_MANAGED_GIT_RECORD_BYTES) {
    throw invalid(`path-free identity exceeds the ${MAX_MANAGED_GIT_RECORD_BYTES}-byte remote Git provenance record limit`);
  }
  return identity;
}

export function pathFreeManagedGitIdentityFromRecord(record: ManagedGitRecord): PathFreeManagedGitIdentity {
  return decodePathFreeManagedGitIdentity({
    remote: record.remote,
    fetchUrl: record.fetchUrl,
    branch: record.branch,
    revision: record.revision
  }, record.id);
}

function assertBoundedPathFreeIdentityInput(candidate: Record<string, unknown>): asserts candidate is Record<keyof PathFreeManagedGitIdentity, string> {
  let totalBytes = 0;
  for (const key of PATH_FREE_IDENTITY_KEYS) {
    const field = candidate[key];
    if (typeof field !== 'string') throw invalid(`${key} is invalid`);
    totalBytes += Buffer.byteLength(field, 'utf8');
    if (totalBytes > MAX_MANAGED_GIT_RECORD_BYTES) {
      throw invalid(`path-free identity exceeds the ${MAX_MANAGED_GIT_RECORD_BYTES}-byte remote Git provenance record limit`);
    }
  }
}

export function decodeManagedGitJournal(value: unknown, expected?: { kind: ManagedGitResourceKind; id: string }): ManagedGitJournal {
  const candidate = exactObject(value, JOURNAL_KEYS, 'journal', invalidJournal);
  if (candidate.schemaVersion !== 1) throw invalidJournal('unsupported schemaVersion');
  if (typeof candidate.operation !== 'string' || !OPERATIONS.has(candidate.operation as ManagedGitOperation)) throw invalidJournal('operation is invalid');
  if (typeof candidate.phase !== 'string' || candidate.phase.length === 0 || candidate.phase.length > 64 || !/^[a-z][a-z-]*$/u.test(candidate.phase)) throw invalidJournal('phase is invalid');
  const kind = decodeKind(candidate.kind);
  if (candidate.operation === 'build' && kind !== 'package') throw invalidJournal('build operation requires package kind');
  if (candidate.operation === 'add-exact' && kind === 'package') throw invalidJournal('add-exact operation supports only Skill and library kinds');
  if (typeof candidate.id !== 'string' || !isSafeSkillId(candidate.id)) throw invalidJournal('id is invalid');
  if (expected !== undefined && (kind !== expected.kind || candidate.id !== expected.id)) throw invalidJournal('identity does not match its path');
  const root = decodeRoot(candidate.root);
  let identity: PathFreeManagedGitIdentity;
  try {
    identity = decodePathFreeManagedGitIdentity({ remote: candidate.remote, fetchUrl: candidate.fetchUrl, branch: candidate.branch, revision: candidate.nextRevision }, candidate.id);
  } catch { throw invalidJournal('remote Git source identity is invalid'); }
  if (candidate.transport !== 'git' && candidate.transport !== 'gh') throw invalidJournal('transport is invalid');
  if (candidate.transport === 'gh' && !identity.remote.startsWith('github.com/')) throw invalidJournal('gh transport requires a GitHub remote');
  const previousRevision = candidate.previousRevision === null ? null : decodeRevision(candidate.previousRevision);
  const nextRevision = identity.revision;
  const staging = candidate.staging === null ? null : decodeManagedPath(candidate.staging, 'staging');
  const backup = candidate.backup === null ? null : decodeManagedPath(candidate.backup, 'backup');
  const resourceStateSha256 = candidate.resourceStateSha256 === null ? null : decodeSha256(candidate.resourceStateSha256, 'resourceStateSha256');
  if ((candidate.operation === 'remove') !== (resourceStateSha256 !== null)) throw invalidJournal('resourceStateSha256 must be present exactly for remove operations');
  return { schemaVersion: 1, operation: candidate.operation as ManagedGitOperation, phase: candidate.phase, kind, id: candidate.id, remote: identity.remote, fetchUrl: identity.fetchUrl, transport: candidate.transport, branch: identity.branch, previousRevision, nextRevision, root, staging, backup, resourceStateSha256 };
}

export function assertValidManagedGitBranch(value: string): void { decodeBranch(value); }
export function assertValidManagedGitRevision(value: string): void { decodeRevision(value); }

export async function readManagedGitJournal(home: string, kind: ManagedGitResourceKind, id: string, options: ManagedGitRecordReadOptions = {}): Promise<ManagedGitJournalSnapshot> {
  if (!isSafeSkillId(id)) throw invalidJournal('id is invalid');
  const path = managedGitJournalPath(home, kind, id);
  const ancestors = [home, join(home, 'providers'), managedGitRoot(home), managedGitRecoveryRoot(home)];
  const ancestorIdentities = await Promise.all(ancestors.map(assertPhysicalJournalDirectory));
  const snapshot = await readBoundedJsonSnapshot(path, 'journal', options);
  const journal = decodeManagedGitJournal(snapshot.value, { kind, id });
  const canonicalHome = await realpath(home);
  if (journal.root !== managedGitCheckoutRoot(canonicalHome, kind, id)) throw invalidJournal('root does not match the deterministic Bazframe-managed checkout path');
  const currentAncestors = await Promise.all(ancestors.map(assertPhysicalJournalDirectory));
  if (!currentAncestors.every((identity, index) => sameIdentity(identity, ancestorIdentities[index]!))) throw invalidJournal('recovery namespace changed while reading');
  return { journal, path, device: snapshot.device, inode: snapshot.inode, contentSha256: snapshot.contentSha256 };
}

export async function readManagedGitRecord(home: string, kind: ManagedGitResourceKind, id: string, options: ManagedGitRecordReadOptions = {}): Promise<ManagedGitRecordSnapshot> {
  if (!isSafeSkillId(id)) throw invalid('id is invalid');
  const path = managedGitRecordPath(home, kind, id);
  const ancestors = managedGitRecordAncestors(home, kind);
  let ancestorIdentities: DirectoryIdentity[] = [];
  let handle: FileHandle | undefined;
  let result: ManagedGitRecordSnapshot | undefined;
  let operationError: unknown;
  try {
    ancestorIdentities = await Promise.all(ancestors.map(assertPhysicalDirectory));
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') {
        const currentAncestors = await Promise.all(ancestors.map(assertPhysicalDirectory));
        if (!currentAncestors.every((identity, index) => sameIdentity(identity, ancestorIdentities[index]!))) throw invalid('record namespace changed while checking absence');
      }
      throw error;
    }
    const maximum = boundedManagedGitRecordBytes(options.maxBytes, invalid);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) throw invalid('record must be a bounded physical regular file');
    await options.testHooks?.afterInitialStat?.();
    const bytes = await readAtMostOneBeyond(handle, maximum);
    const afterRead = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    await options.testHooks?.afterPathStat?.();
    const final = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (bytes.byteLength > maximum || !afterRead.isFile() || !final.isFile() || current.isSymbolicLink() || !current.isFile()
      || finalPath.isSymbolicLink() || !finalPath.isFile()
      || before.dev !== afterRead.dev || before.ino !== afterRead.ino || afterRead.dev !== current.dev || afterRead.ino !== current.ino
      || current.dev !== final.dev || current.ino !== final.ino || finalPath.dev !== final.dev || finalPath.ino !== final.ino
      || before.size !== afterRead.size || before.mtimeNs !== afterRead.mtimeNs || before.ctimeNs !== afterRead.ctimeNs
      || afterRead.size !== final.size || afterRead.mtimeNs !== final.mtimeNs || afterRead.ctimeNs !== final.ctimeNs
      || current.size !== final.size || current.mtimeNs !== final.mtimeNs || current.ctimeNs !== final.ctimeNs
      || finalPath.size !== final.size || finalPath.mtimeNs !== final.mtimeNs || finalPath.ctimeNs !== final.ctimeNs
      || BigInt(bytes.byteLength) !== final.size) throw invalid('record identity changed or exceeded its byte limit while reading');
    const currentAncestors = await Promise.all(ancestors.map(assertPhysicalDirectory));
    if (!currentAncestors.every((identity, index) => sameIdentity(identity, ancestorIdentities[index]!))) throw invalid('record namespace changed while reading');
    const record = decodeManagedGitRecord(parseJson(bytes, path, 'MANAGED_GIT_RECORD_INVALID'), { kind, id });
    const canonicalHome = await realpath(home);
    if (record.root !== managedGitCheckoutRoot(canonicalHome, kind, id)) throw invalid('root does not match the deterministic Bazframe-managed checkout path');
    result = { record, path, device: before.dev, inode: before.ino, contentSha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    operationError = error instanceof BazframeError
      ? error
      : new BazframeError('MANAGED_GIT_RECORD_READ_FAILED', `Could not read remote Git provenance record: ${path}${formatCode(error)}`, { cause: error });
  }
  if (handle !== undefined) {
    try { await handle.close(); await options.testHooks?.afterClose?.(); }
    catch (error) { operationError ??= new BazframeError('MANAGED_GIT_RECORD_READ_FAILED', `Could not close remote Git provenance record: ${path}${formatCode(error)}`, { cause: error }); }
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw new BazframeError('MANAGED_GIT_RECORD_READ_FAILED', `Could not read remote Git provenance record: ${path}.`);
  return result;
}

export async function optionalManagedGitRecord(home: string, kind: ManagedGitResourceKind, id: string): Promise<ManagedGitRecordSnapshot | undefined> {
  try { return await readManagedGitRecord(home, kind, id); }
  catch (error) {
    if (error instanceof BazframeError && error.code === 'MANAGED_GIT_RECORD_READ_FAILED' && errorCode(error.cause) === 'ENOENT') return undefined;
    throw error;
  }
}

export async function optionalManagedGitRecordInExistingNamespace(home: string, kind: ManagedGitResourceKind, id: string): Promise<ManagedGitRecordSnapshot | undefined> {
  const ancestors = managedGitRecordAncestors(home, kind);
  const before = await Promise.all(ancestors.map(assertPhysicalDirectory));
  const record = await optionalManagedGitRecord(home, kind, id);
  const after = await Promise.all(ancestors.map(assertPhysicalDirectory));
  if (!after.every((identity, index) => sameIdentity(identity, before[index]!))) throw invalid('record namespace changed while checking optional provenance');
  return record;
}

export async function managedGitRecordForRoot(home: string, kind: ManagedGitResourceKind, root: string): Promise<ManagedGitRecord | undefined> {
  const id = basename(root);
  const canonicalHome = await realpath(home).catch(() => resolve(home));
  if (!isSafeSkillId(id) || resolve(root) !== managedGitCheckoutRoot(canonicalHome, kind, id)) return undefined;
  const snapshot = await optionalManagedGitRecord(canonicalHome, kind, id);
  return snapshot?.record.root === root ? snapshot.record : undefined;
}

export async function scanManagedGitRecords(home: string): Promise<{ records: ManagedGitRecord[]; diagnostics: ManagedGitRecordDiagnostic[] }> {
  const records: ManagedGitRecord[] = [];
  const diagnostics: ManagedGitRecordDiagnostic[] = [];
  for (const kind of ['skill', 'library', 'package'] as const) {
    const directory = join(managedGitRecordsRoot(home), kind);
    let names: string[];
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('namespace must be a physical directory');
      names = (await readdir(directory)).sort(compare);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      diagnostics.push({ kind, id: '<unknown>', path: directory, message: 'record namespace is invalid' });
      continue;
    }
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!isSafeSkillId(id)) { diagnostics.push({ kind, id: '<unknown>', path: join(directory, safeName(name)), message: 'record path is invalid' }); continue; }
      try { records.push((await readManagedGitRecord(home, kind, id)).record); }
      catch (error) { diagnostics.push({ kind, id, path: join(directory, id + '.json'), message: safeMessage(error) }); }
    }
  }
  await scanRecovery(home, diagnostics);
  return { records: records.sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`)), diagnostics };
}

export async function canonicalManagedGitRoot(record: ManagedGitRecord): Promise<string> {
  const canonical = await realpath(record.root);
  const metadata = await lstat(canonical);
  if (canonical !== record.root || metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Bazframe-managed checkout root is invalid: ${record.root}`);
  return canonical;
}

async function scanRecovery(home: string, diagnostics: ManagedGitRecordDiagnostic[]): Promise<void> {
  const root = managedGitRecoveryRoot(home);
  let names: string[];
  try {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('recovery namespace must be physical');
    names = (await readdir(root)).sort(compare);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') diagnostics.push({ kind: 'skill', id: '<unknown>', path: root, message: 'recovery namespace is invalid' });
    return;
  }
  for (const name of names) {
    const match = /^(skill|library|package)-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/u.exec(name);
    if (match === null || !isSafeSkillId(match[2]!)) { diagnostics.push({ kind: 'skill', id: '<unknown>', path: join(root, safeName(name)), message: 'recovery record path is invalid' }); continue; }
    const kind = match[1] as ManagedGitResourceKind;
    const id = match[2]!;
    const path = join(root, name);
    try {
      const journal = (await readManagedGitJournal(home, kind, id)).journal;
      const command = recoveryRetryCommand(journal);
      const recovery = journal.operation === 'remove'
        ? `manually inspect ${path} and its recorded root, staging, and backup paths, then retry ${command} with this recovery record retained to finish identity-verified forward removal`
        : `manually inspect ${path} and its recorded root, staging, and backup paths, restore source checkout/provenance/registration consistency, then remove this recovery record before retrying ${command}`;
      diagnostics.push({ kind, id, path, message: escapeUnsafeDisplayCharacters(`${journal.operation} stopped in phase ${journal.phase}; remote ${journal.remote}; branch ${journal.branch}; revision ${journal.nextRevision}; ${recovery}`) });
    } catch (error) { diagnostics.push({ kind, id, path, message: `recovery record is invalid: ${safeMessage(error)}` }); }
  }
}

async function readBoundedJsonSnapshot(
  path: string,
  _kind: 'journal',
  options: ManagedGitRecordReadOptions
): Promise<{ value: unknown; device: bigint; inode: bigint; contentSha256: string }> {
  let handle: FileHandle | undefined;
  let result: { value: unknown; device: bigint; inode: bigint; contentSha256: string } | undefined;
  let operationError: unknown;
  try {
    const maximum = boundedManagedGitRecordBytes(options.maxBytes, invalidJournal);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) throw invalidJournal('record must be a bounded physical regular file');
    await options.testHooks?.afterInitialStat?.();
    const bytes = await readAtMostOneBeyond(handle, maximum);
    const afterRead = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    await options.testHooks?.afterPathStat?.();
    const final = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (bytes.byteLength > maximum || !afterRead.isFile() || !final.isFile() || current.isSymbolicLink() || !current.isFile()
      || finalPath.isSymbolicLink() || !finalPath.isFile()
      || before.dev !== afterRead.dev || before.ino !== afterRead.ino || afterRead.dev !== current.dev || afterRead.ino !== current.ino
      || current.dev !== final.dev || current.ino !== final.ino || finalPath.dev !== final.dev || finalPath.ino !== final.ino
      || before.size !== afterRead.size || before.mtimeNs !== afterRead.mtimeNs || before.ctimeNs !== afterRead.ctimeNs
      || afterRead.size !== final.size || afterRead.mtimeNs !== final.mtimeNs || afterRead.ctimeNs !== final.ctimeNs
      || current.size !== final.size || current.mtimeNs !== final.mtimeNs || current.ctimeNs !== final.ctimeNs
      || finalPath.size !== final.size || finalPath.mtimeNs !== final.mtimeNs || finalPath.ctimeNs !== final.ctimeNs
      || BigInt(bytes.byteLength) !== final.size) throw invalidJournal('record changed or exceeded its byte limit while reading');
    result = { value: parseJson(bytes, path, 'MANAGED_GIT_JOURNAL_INVALID'), device: before.dev, inode: before.ino, contentSha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) { operationError = error; }
  if (handle !== undefined) {
    try { await handle.close(); await options.testHooks?.afterClose?.(); }
    catch (error) { operationError ??= new BazframeError('MANAGED_GIT_JOURNAL_INVALID', `Could not close remote Git recovery record: ${path}${formatCode(error)}`, { cause: error }); }
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw invalidJournal('could not read record');
  return result;
}

interface DirectoryIdentity { device: bigint; inode: bigint }
function managedGitRecordAncestors(home: string, kind: ManagedGitResourceKind): string[] { return [home, join(home, 'providers'), managedGitRoot(home), managedGitRecordsRoot(home), join(managedGitRecordsRoot(home), kind)]; }
async function assertPhysicalDirectory(path: string): Promise<DirectoryIdentity> { const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid(`record namespace must be physical: ${path}`); return { device: metadata.dev, inode: metadata.ino }; }
async function assertPhysicalJournalDirectory(path: string): Promise<DirectoryIdentity> { const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalidJournal(`recovery namespace must be physical: ${path}`); return { device: metadata.dev, inode: metadata.ino }; }
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
function boundedManagedGitRecordBytes(
  maximum: number | undefined,
  failure: (detail: string) => BazframeError
): number {
  const value = maximum ?? MAX_MANAGED_GIT_RECORD_BYTES;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MANAGED_GIT_RECORD_BYTES) {
    throw failure(`byte limit must be a finite nonnegative integer no greater than ${MAX_MANAGED_GIT_RECORD_BYTES}`);
  }
  return value;
}
function exactObject(value: unknown, keys: readonly string[], label: string, failure: (detail: string) => BazframeError): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure(`${label} must be a JSON object`); const candidate = value as Record<string, unknown>; const actual = Object.keys(candidate).sort(); if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index])) throw failure(`${label} must contain exactly the schema-v1 fields`); return candidate; }
function decodeKind(value: unknown): ManagedGitResourceKind { if (typeof value !== 'string' || !KINDS.has(value as ManagedGitResourceKind)) throw invalid('kind is invalid'); return value as ManagedGitResourceKind; }
function decodeRoot(value: unknown): string { if (typeof value !== 'string' || value.includes('\u0000') || !isAbsolute(value) || resolve(value) !== value) throw invalid('root is invalid'); return value; }
function decodeManagedPath(value: unknown, label: string): string { if (typeof value !== 'string' || value.includes('\u0000') || !isAbsolute(value) || resolve(value) !== value) throw invalidJournal(`${label} is invalid`); return value; }
function decodeRevision(value: unknown): string { if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) throw invalid('revision is invalid'); return value; }
function decodeSha256(value: unknown, label: string): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw invalidJournal(`${label} is invalid`); return value; }
function decodeBranch(value: unknown): string { if (typeof value !== 'string' || value.length === 0 || value.length > 255 || containsUnsafeDisplayCharacters(value) || value === '@' || value.toLowerCase() === 'head' || value.startsWith('-') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('@{') || value.includes('//') || [...value].some(forbiddenRefCharacter)) throw invalid('branch is invalid'); const components = value.split('/'); if (components.some((part) => part.length === 0 || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw invalid('branch is invalid'); return value; }
function forbiddenRefCharacter(character: string): boolean { const code = character.charCodeAt(0); return code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character); }
function parseJson(bytes: Uint8Array, path: string, code: string): unknown { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return JSON.parse(text); } catch (error) { throw new BazframeError(code, `Invalid remote Git provenance JSON: ${path}`, { cause: error }); } }
function recoveryRetryCommand(journal: ManagedGitJournal): string {
  if (journal.operation === 'build') return `bazframe package build ${journal.id}`;
  if (journal.operation === 'add') {
    if (journal.kind === 'skill') return `bazframe skill add ${journal.fetchUrl}`;
    return `bazframe ${journal.kind} add ${journal.fetchUrl}`;
  }
  if (journal.operation === 'add-exact') {
    return `the originating exact profile import for ${journal.fetchUrl} at branch ${journal.branch} and revision ${journal.nextRevision}`;
  }
  if (journal.operation === 'remove') {
    if (journal.kind === 'skill') return `bazframe skill remove ${journal.id}`;
    return `bazframe ${journal.kind} remove ${journal.id}`;
  }
  if (journal.kind === 'skill') return `bazframe skill update ${journal.id}`;
  return `bazframe ${journal.kind} update ${journal.id}`;
}
function safeName(value: string): string { return replaceUnsafeDisplayCharacters(value, '?').slice(0, 200); }
function safeMessage(error: unknown): string { return replaceUnsafeDisplayCharacters(error instanceof Error ? error.message : String(error), ' ').slice(0, 1000); }
function invalid(detail: string): BazframeError { return new BazframeError('MANAGED_GIT_RECORD_INVALID', `Invalid remote Git provenance record: ${detail}.`); }
function invalidJournal(detail: string): BazframeError { return new BazframeError('MANAGED_GIT_JOURNAL_INVALID', `Invalid remote Git recovery record: ${detail}.`); }
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
