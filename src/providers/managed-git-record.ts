import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { containsUnsafeDisplayCharacters, escapeUnsafeDisplayCharacters, replaceUnsafeDisplayCharacters } from '../core/safe-text.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import type { SkillCollectionKind } from '../skill-collections/skill-collection-store.js';

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
export interface ManagedGitRecordSnapshot {
  record: ManagedGitRecord;
  path: string;
  device: bigint;
  inode: bigint;
  contentSha256: string;
}
export type ManagedGitOperation = 'add' | 'update' | 'remove' | 'build';
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

const RECORD_KEYS = ['branch', 'fetchUrl', 'id', 'kind', 'remote', 'revision', 'root', 'schemaVersion', 'transport'] as const;
const JOURNAL_KEYS = ['backup', 'branch', 'fetchUrl', 'id', 'kind', 'nextRevision', 'operation', 'phase', 'previousRevision', 'remote', 'resourceStateSha256', 'root', 'schemaVersion', 'staging', 'transport'] as const;
const KINDS = new Set<ManagedGitResourceKind>(['skill', 'library', 'package']);
const OPERATIONS = new Set<ManagedGitOperation>(['add', 'update', 'remove', 'build']);
const MAX_RECORD_BYTES = 16 * 1024;

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
  const remote = decodeRemote(candidate.remote);
  const fetchUrl = decodeFetchUrl(candidate.fetchUrl);
  if (remoteForFetchUrl(fetchUrl) !== remote) throw invalid('fetchUrl does not match remote');
  if (candidate.transport !== 'git' && candidate.transport !== 'gh') throw invalid('transport is invalid');
  if (candidate.transport === 'gh' && !remote.startsWith('github.com/')) throw invalid('gh transport requires a GitHub remote');
  const branch = decodeBranch(candidate.branch);
  const revision = decodeRevision(candidate.revision);
  return { schemaVersion: 1, kind, id: candidate.id, root, remote, fetchUrl, transport: candidate.transport, branch, revision };
}

export function decodeManagedGitJournal(value: unknown, expected?: { kind: ManagedGitResourceKind; id: string }): ManagedGitJournal {
  const candidate = exactObject(value, JOURNAL_KEYS, 'journal', invalidJournal);
  if (candidate.schemaVersion !== 1) throw invalidJournal('unsupported schemaVersion');
  if (typeof candidate.operation !== 'string' || !OPERATIONS.has(candidate.operation as ManagedGitOperation)) throw invalidJournal('operation is invalid');
  if (typeof candidate.phase !== 'string' || candidate.phase.length === 0 || candidate.phase.length > 64 || !/^[a-z][a-z-]*$/u.test(candidate.phase)) throw invalidJournal('phase is invalid');
  const kind = decodeKind(candidate.kind);
  if (candidate.operation === 'build' && kind !== 'package') throw invalidJournal('build operation requires package kind');
  if (typeof candidate.id !== 'string' || !isSafeSkillId(candidate.id)) throw invalidJournal('id is invalid');
  if (expected !== undefined && (kind !== expected.kind || candidate.id !== expected.id)) throw invalidJournal('identity does not match its path');
  const root = decodeRoot(candidate.root);
  const remote = decodeRemote(candidate.remote);
  const fetchUrl = decodeFetchUrl(candidate.fetchUrl);
  if (remoteForFetchUrl(fetchUrl) !== remote) throw invalidJournal('fetchUrl does not match remote');
  if (candidate.transport !== 'git' && candidate.transport !== 'gh') throw invalidJournal('transport is invalid');
  if (candidate.transport === 'gh' && !remote.startsWith('github.com/')) throw invalidJournal('gh transport requires a GitHub remote');
  const branch = decodeBranch(candidate.branch);
  const previousRevision = candidate.previousRevision === null ? null : decodeRevision(candidate.previousRevision);
  const nextRevision = decodeRevision(candidate.nextRevision);
  const staging = candidate.staging === null ? null : decodeManagedPath(candidate.staging, 'staging');
  const backup = candidate.backup === null ? null : decodeManagedPath(candidate.backup, 'backup');
  const resourceStateSha256 = candidate.resourceStateSha256 === null ? null : decodeSha256(candidate.resourceStateSha256, 'resourceStateSha256');
  if ((candidate.operation === 'remove') !== (resourceStateSha256 !== null)) throw invalidJournal('resourceStateSha256 must be present exactly for remove operations');
  return { schemaVersion: 1, operation: candidate.operation as ManagedGitOperation, phase: candidate.phase, kind, id: candidate.id, remote, fetchUrl, transport: candidate.transport, branch, previousRevision, nextRevision, root, staging, backup, resourceStateSha256 };
}

export function assertValidManagedGitBranch(value: string): void { decodeBranch(value); }
export function assertValidManagedGitRevision(value: string): void { decodeRevision(value); }

export async function readManagedGitJournal(home: string, kind: ManagedGitResourceKind, id: string): Promise<ManagedGitJournalSnapshot> {
  if (!isSafeSkillId(id)) throw invalidJournal('id is invalid');
  const path = managedGitJournalPath(home, kind, id);
  const ancestors = [home, join(home, 'providers'), managedGitRoot(home), managedGitRecoveryRoot(home)];
  const ancestorIdentities = await Promise.all(ancestors.map(assertPhysicalJournalDirectory));
  const snapshot = await readBoundedJsonSnapshot(path);
  const journal = decodeManagedGitJournal(snapshot.value, { kind, id });
  const canonicalHome = await realpath(home);
  if (journal.root !== managedGitCheckoutRoot(canonicalHome, kind, id)) throw invalidJournal('root does not match the deterministic managed provider path');
  const currentAncestors = await Promise.all(ancestors.map(assertPhysicalJournalDirectory));
  if (!currentAncestors.every((identity, index) => sameIdentity(identity, ancestorIdentities[index]!))) throw invalidJournal('recovery namespace changed while reading');
  return { journal, path, device: snapshot.device, inode: snapshot.inode, contentSha256: snapshot.contentSha256 };
}

export async function readManagedGitRecord(home: string, kind: ManagedGitResourceKind, id: string): Promise<ManagedGitRecordSnapshot> {
  if (!isSafeSkillId(id)) throw invalid('id is invalid');
  const path = managedGitRecordPath(home, kind, id);
  const ancestors = managedGitRecordAncestors(home, kind);
  let ancestorIdentities: DirectoryIdentity[] = [];
  let handle: FileHandle | undefined;
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
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_RECORD_BYTES)) throw invalid('record must be a bounded physical regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!after.isFile() || current.isSymbolicLink() || !current.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw invalid('record identity changed while reading');
    const currentAncestors = await Promise.all(ancestors.map(assertPhysicalDirectory));
    if (!currentAncestors.every((identity, index) => sameIdentity(identity, ancestorIdentities[index]!))) throw invalid('record namespace changed while reading');
    const record = decodeManagedGitRecord(parseJson(bytes, path, 'MANAGED_GIT_RECORD_INVALID'), { kind, id });
    const canonicalHome = await realpath(home);
    if (record.root !== managedGitCheckoutRoot(canonicalHome, kind, id)) throw invalid('root does not match the deterministic managed provider path');
    return { record, path, device: before.dev, inode: before.ino, contentSha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    throw new BazframeError('MANAGED_GIT_RECORD_READ_FAILED', `Could not read managed Git record: ${path}${formatCode(error)}`, { cause: error });
  } finally { await handle?.close().catch(() => undefined); }
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
  if (canonical !== record.root || metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('MANAGED_GIT_ROOT_INVALID', `Managed Git provider root is invalid: ${record.root}`);
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
        : `manually inspect ${path} and its recorded root, staging, and backup paths, restore provider/provenance/registration consistency, then remove this recovery record before retrying ${command}`;
      diagnostics.push({ kind, id, path, message: escapeUnsafeDisplayCharacters(`${journal.operation} stopped in phase ${journal.phase}; remote ${journal.remote}; branch ${journal.branch}; revision ${journal.nextRevision}; ${recovery}`) });
    } catch (error) { diagnostics.push({ kind, id, path, message: `recovery record is invalid: ${safeMessage(error)}` }); }
  }
}

async function readBoundedJsonSnapshot(path: string): Promise<{ value: unknown; device: bigint; inode: bigint; contentSha256: string }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_RECORD_BYTES)) throw invalidJournal('record must be a bounded physical regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!after.isFile() || current.isSymbolicLink() || !current.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw invalidJournal('record changed while reading');
    return { value: parseJson(bytes, path, 'MANAGED_GIT_JOURNAL_INVALID'), device: before.dev, inode: before.ino, contentSha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle?.close(); }
}

interface DirectoryIdentity { device: bigint; inode: bigint }
function managedGitRecordAncestors(home: string, kind: ManagedGitResourceKind): string[] { return [home, join(home, 'providers'), managedGitRoot(home), managedGitRecordsRoot(home), join(managedGitRecordsRoot(home), kind)]; }
async function assertPhysicalDirectory(path: string): Promise<DirectoryIdentity> { const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid(`record namespace must be physical: ${path}`); return { device: metadata.dev, inode: metadata.ino }; }
async function assertPhysicalJournalDirectory(path: string): Promise<DirectoryIdentity> { const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalidJournal(`recovery namespace must be physical: ${path}`); return { device: metadata.dev, inode: metadata.ino }; }
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
function exactObject(value: unknown, keys: readonly string[], label: string, failure: (detail: string) => BazframeError): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure(`${label} must be a JSON object`); const candidate = value as Record<string, unknown>; const actual = Object.keys(candidate).sort(); if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index])) throw failure(`${label} must contain exactly the schema-v1 fields`); return candidate; }
function decodeKind(value: unknown): ManagedGitResourceKind { if (typeof value !== 'string' || !KINDS.has(value as ManagedGitResourceKind)) throw invalid('kind is invalid'); return value as ManagedGitResourceKind; }
function decodeRoot(value: unknown): string { if (typeof value !== 'string' || value.includes('\u0000') || !isAbsolute(value) || resolve(value) !== value) throw invalid('root is invalid'); return value; }
function decodeManagedPath(value: unknown, label: string): string { if (typeof value !== 'string' || value.includes('\u0000') || !isAbsolute(value) || resolve(value) !== value) throw invalidJournal(`${label} is invalid`); return value; }
function decodeRemote(value: unknown): string { if (typeof value !== 'string' || !/^[a-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9._~/-]+$/u.test(value) || value.includes('..') || value.includes('//')) throw invalid('remote is invalid'); return value; }
function decodeFetchUrl(value: unknown): string { if (typeof value !== 'string' || containsUnsafeDisplayCharacters(value) || value.includes('%')) throw invalid('fetchUrl is invalid'); try { const url = new URL(value); if ((url.protocol !== 'https:' && url.protocol !== 'ssh:') || url.href !== value || url.password !== '' || (url.protocol === 'https:' ? url.username !== '' : url.username !== '' && url.username !== 'git') || url.search !== '' || url.hash !== '' || !url.pathname.endsWith('.git')) throw new Error(); return value; } catch { throw invalid('fetchUrl is invalid'); } }
function remoteForFetchUrl(value: string): string { const url = new URL(value); const path = url.pathname.replace(/^\/+|\.git$/gu, ''); return `${url.hostname.toLowerCase()}${url.port === '' ? '' : `:${url.port}`}/${path}`; }
function decodeRevision(value: unknown): string { if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) throw invalid('revision is invalid'); return value; }
function decodeSha256(value: unknown, label: string): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw invalidJournal(`${label} is invalid`); return value; }
function decodeBranch(value: unknown): string { if (typeof value !== 'string' || value.length === 0 || value.length > 255 || containsUnsafeDisplayCharacters(value) || value === '@' || value.startsWith('-') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('@{') || value.includes('//') || [...value].some(forbiddenRefCharacter)) throw invalid('branch is invalid'); const components = value.split('/'); if (components.some((part) => part.length === 0 || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw invalid('branch is invalid'); return value; }
function forbiddenRefCharacter(character: string): boolean { const code = character.charCodeAt(0); return code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character); }
function parseJson(bytes: Uint8Array, path: string, code: string): unknown { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return JSON.parse(text); } catch (error) { throw new BazframeError(code, `Invalid managed Git JSON: ${path}`, { cause: error }); } }
function recoveryRetryCommand(journal: ManagedGitJournal): string {
  if (journal.operation === 'build') return `bazframe packages build ${journal.id}`;
  if (journal.operation === 'add') {
    if (journal.kind === 'skill') return `bazframe add skill ${journal.fetchUrl}`;
    return `bazframe ${journal.kind === 'library' ? 'libraries' : 'packages'} add ${journal.fetchUrl}`;
  }
  if (journal.operation === 'remove') {
    if (journal.kind === 'skill') return `bazframe remove skill ${journal.id}`;
    return `bazframe ${journal.kind === 'library' ? 'libraries' : 'packages'} remove ${journal.id}`;
  }
  if (journal.kind === 'skill') return `bazframe skill update ${journal.id}`;
  return `bazframe ${journal.kind === 'library' ? 'libraries' : 'packages'} update ${journal.id}`;
}
function safeName(value: string): string { return replaceUnsafeDisplayCharacters(value, '?').slice(0, 200); }
function safeMessage(error: unknown): string { return replaceUnsafeDisplayCharacters(error instanceof Error ? error.message : String(error), ' ').slice(0, 1000); }
function invalid(detail: string): BazframeError { return new BazframeError('MANAGED_GIT_RECORD_INVALID', `Invalid managed Git record: ${detail}.`); }
function invalidJournal(detail: string): BazframeError { return new BazframeError('MANAGED_GIT_JOURNAL_INVALID', `Invalid managed Git recovery record: ${detail}.`); }
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
