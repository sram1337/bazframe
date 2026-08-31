import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { boundedStateJsonBytes } from '../profile-portability/profile-portability-policy.js';
import { readAtMostOneBeyond } from '../state/bounded-file-read.js';
import { isPortableRelativePath } from './portable-relative-path.js';
import { isSafeSkillId } from '../skills/skill-id.js';

export type SkillCollectionKind = 'library' | 'package';
export interface SkillCollectionKey { kind: SkillCollectionKind; id: string }
export interface LibraryRecord { schemaVersion: 1; library: string; root: string; digest: string }
export interface PackageRecord { schemaVersion: 1; package: string; root: string; digest: string; artifactRoot: string; skillsRoot: string }
export type SkillCollectionRecord = LibraryRecord | PackageRecord;
export interface SkillCollectionRecordSnapshot<T extends SkillCollectionRecord = SkillCollectionRecord> {
  record: T; path: string; device: bigint; inode: bigint; contentSha256: string;
}
export interface SkillCollectionRecordReadOptions {
  maxBytes?: number;
  testHooks?: { afterInitialStat?: () => void | Promise<void>; afterPathStat?: () => void | Promise<void>; afterClose?: () => void | Promise<void> };
}
export interface SkillCollectionRecordPath { key: SkillCollectionKey; path: string; relativePath: string }
export interface SkillCollectionNamespaceDiagnostic { key: SkillCollectionKey; path: string }
export interface SkillCollectionNamespace { records: SkillCollectionRecordPath[]; diagnostics: SkillCollectionNamespaceDiagnostic[] }
export const UNKNOWN_COLLECTION_ID = '<unknown>';

const LIBRARY_KEYS = ['digest', 'library', 'root', 'schemaVersion'] as const;
const PACKAGE_KEYS = ['artifactRoot', 'digest', 'package', 'root', 'schemaVersion', 'skillsRoot'] as const;

export function collectionKey(kind: SkillCollectionKind, id: string): string { return `${kind}:${id}`; }
export function idForRecord(record: SkillCollectionRecord): string { return 'library' in record ? record.library : record.package; }
export function kindForRecord(record: SkillCollectionRecord): SkillCollectionKind { return 'library' in record ? 'library' : 'package'; }
export function skillsRootForRecord(record: SkillCollectionRecord): string { return 'library' in record ? '.' : record.skillsRoot; }
export function globalLibrariesDirectory(home: string): string { return join(home, 'libraries'); }
export function globalPackagesDirectory(home: string): string { return join(home, 'packages'); }
export function globalCollectionDirectory(home: string, kind: SkillCollectionKind): string { return kind === 'library' ? globalLibrariesDirectory(home) : globalPackagesDirectory(home); }
export function globalCollectionPath(home: string, kind: SkillCollectionKind, id: string): string { return join(globalCollectionDirectory(home, kind), `${id}.json`); }
export function globalLibraryPath(home: string, id: string): string { return globalCollectionPath(home, 'library', id); }
export function globalPackagePath(home: string, id: string): string { return globalCollectionPath(home, 'package', id); }

export function encodeLibrary(record: LibraryRecord): string {
  return `${JSON.stringify({ schemaVersion: 1, library: record.library, root: record.root, digest: record.digest }, null, 2)}\n`;
}
export function encodePackage(record: PackageRecord): string {
  return `${JSON.stringify({ schemaVersion: 1, package: record.package, root: record.root, digest: record.digest, artifactRoot: record.artifactRoot, skillsRoot: record.skillsRoot }, null, 2)}\n`;
}
export function encodeSkillCollection(record: SkillCollectionRecord): string { return 'library' in record ? encodeLibrary(record) : encodePackage(record); }

function exactKeys(candidate: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(candidate).sort(); return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function common(candidate: Record<string, unknown>, kind: SkillCollectionKind, expectedId?: string): { id: string; root: string; digest: string } {
  if (candidate.schemaVersion !== 1) throw invalid(kind, 'unsupported schemaVersion');
  const value = candidate[kind];
  if (typeof value !== 'string' || !isSafeSkillId(value)) throw invalid(kind, `${kind} is invalid`);
  if (expectedId !== undefined && value !== expectedId) throw invalid(kind, `${kind} does not match record path`);
  if (typeof candidate.root !== 'string' || candidate.root.includes('\0') || !isAbsolute(candidate.root) || resolve(candidate.root) !== candidate.root) throw invalid(kind, 'root must be a canonical absolute path');
  if (basename(candidate.root) !== value) throw invalid(kind, `${kind} must match the canonical root basename`);
  if (typeof candidate.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.digest)) throw invalid(kind, 'digest must be lowercase SHA-256');
  return { id: value, root: candidate.root, digest: candidate.digest };
}
export function decodeLibrary(value: unknown, expectedId?: string): LibraryRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('library', 'record must be a JSON object');
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, LIBRARY_KEYS)) throw invalid('library', 'record must contain exactly the schema-v1 fields');
  const decoded = common(candidate, 'library', expectedId);
  return { schemaVersion: 1, library: decoded.id, root: decoded.root, digest: decoded.digest };
}
export function decodePackage(value: unknown, expectedId?: string): PackageRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('package', 'record must be a JSON object');
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, PACKAGE_KEYS)) throw invalid('package', 'record must contain exactly the schema-v1 fields');
  const decoded = common(candidate, 'package', expectedId);
  if (!isPortableRelativePath(candidate.artifactRoot)) throw invalid('package', 'artifactRoot is invalid');
  if (!isPortableRelativePath(candidate.skillsRoot)) throw invalid('package', 'skillsRoot is invalid');
  return { schemaVersion: 1, package: decoded.id, root: decoded.root, digest: decoded.digest, artifactRoot: candidate.artifactRoot, skillsRoot: candidate.skillsRoot };
}

export async function readLibrary(home: string, id: string): Promise<LibraryRecord> { return (await readLibrarySnapshot(home, id)).record; }
export async function readPackage(home: string, id: string): Promise<PackageRecord> { return (await readPackageSnapshot(home, id)).record; }
export async function readCollection(home: string, key: SkillCollectionKey): Promise<SkillCollectionRecord> { return key.kind === 'library' ? readLibrary(home, key.id) : readPackage(home, key.id); }
export async function readLibrarySnapshot(home: string, id: string, options: SkillCollectionRecordReadOptions = {}): Promise<SkillCollectionRecordSnapshot<LibraryRecord>> { return readRecord(home, 'library', id, options) as Promise<SkillCollectionRecordSnapshot<LibraryRecord>>; }
export async function readPackageSnapshot(home: string, id: string, options: SkillCollectionRecordReadOptions = {}): Promise<SkillCollectionRecordSnapshot<PackageRecord>> { return readRecord(home, 'package', id, options) as Promise<SkillCollectionRecordSnapshot<PackageRecord>>; }
export async function readCollectionSnapshot(home: string, key: SkillCollectionKey, options: SkillCollectionRecordReadOptions = {}): Promise<SkillCollectionRecordSnapshot> { return readRecord(home, key.kind, key.id, options); }

async function readRecord(home: string, kind: SkillCollectionKind, id: string, options: SkillCollectionRecordReadOptions): Promise<SkillCollectionRecordSnapshot> {
  if (!isSafeSkillId(id)) throw invalid(kind, `${kind} is invalid`);
  const maximum = boundedStateJsonBytes(options.maxBytes);
  const rootPath = globalCollectionDirectory(home, kind);
  const path = globalCollectionPath(home, kind, id);
  const directories: OpenDirectory[] = [];
  let handle: FileHandle | undefined;
  let result: SkillCollectionRecordSnapshot | undefined;
  let operationError: unknown;
  try {
    for (const directoryPath of [home, rootPath]) directories.push(await openExistingDirectory(directoryPath, 'record ancestor must be a physical directory', kind));
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) throw invalid(kind, `record must be a bounded physical regular file (${maximum} bytes)`);
    await options.testHooks?.afterInitialStat?.();
    const bytes = await readAtMostOneBeyond(handle, maximum);
    const afterRead = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    await options.testHooks?.afterPathStat?.();
    const final = await handle.stat({ bigint: true });
    const finalPathMetadata = await lstat(path, { bigint: true });
    if (bytes.byteLength > maximum || !afterRead.isFile() || !final.isFile() || pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || finalPathMetadata.isSymbolicLink() || !finalPathMetadata.isFile()
      || before.dev !== afterRead.dev || before.ino !== afterRead.ino || afterRead.dev !== pathMetadata.dev || afterRead.ino !== pathMetadata.ino
      || pathMetadata.dev !== final.dev || pathMetadata.ino !== final.ino
      || finalPathMetadata.dev !== final.dev || finalPathMetadata.ino !== final.ino
      || before.size !== afterRead.size || before.mtimeNs !== afterRead.mtimeNs || before.ctimeNs !== afterRead.ctimeNs
      || afterRead.size !== final.size || afterRead.mtimeNs !== final.mtimeNs || afterRead.ctimeNs !== final.ctimeNs
      || pathMetadata.size !== final.size || pathMetadata.mtimeNs !== final.mtimeNs || pathMetadata.ctimeNs !== final.ctimeNs
      || finalPathMetadata.size !== final.size || finalPathMetadata.mtimeNs !== final.mtimeNs || finalPathMetadata.ctimeNs !== final.ctimeNs
      || BigInt(bytes.byteLength) !== final.size) throw invalid(kind, 'record identity changed or exceeded its byte limit while reading');
    for (const directory of [...directories].reverse()) await assertDirectoryStable(directory);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new BazframeError('SKILL_COLLECTION_RECORD_INVALID', `Global ${kind} is not valid UTF-8.`, { cause: error }); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) { throw new BazframeError('SKILL_COLLECTION_RECORD_INVALID', `Global ${kind} is not valid JSON.`, { cause: error }); }
    result = { record: kind === 'library' ? decodeLibrary(value, id) : decodePackage(value, id), path, device: before.dev, inode: before.ino, contentSha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    operationError = error instanceof BazframeError
      ? error
      : errorCode(error) === 'ELOOP'
        ? invalid(kind, 'record and its namespace ancestors must be physical')
        : new BazframeError('SKILL_COLLECTION_RECORD_READ_FAILED', `Could not read global ${kind} ${path}${formatCode(error)}`, { cause: error });
  }
  if (handle !== undefined) {
    try { await handle.close(); await options.testHooks?.afterClose?.(); }
    catch (error) { operationError ??= new BazframeError('SKILL_COLLECTION_RECORD_READ_FAILED', `Could not close global ${kind} ${path}${formatCode(error)}`, { cause: error }); }
  }
  for (const directory of [...directories].reverse()) {
    try { await directory.handle.close(); }
    catch (error) { operationError ??= new BazframeError('SKILL_COLLECTION_RECORD_READ_FAILED', `Could not close global ${kind} namespace ${directory.path}${formatCode(error)}`, { cause: error }); }
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw new BazframeError('SKILL_COLLECTION_RECORD_READ_FAILED', `Could not read global ${kind} ${path}.`);
  return result;
}
export function sameCollectionSnapshot(left: SkillCollectionRecordSnapshot, right: SkillCollectionRecordSnapshot): boolean { return left.device === right.device && left.inode === right.inode && left.contentSha256 === right.contentSha256; }

export async function canonicalPhysicalCollectionRoot(path: string, kind: SkillCollectionKind): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) throw new BazframeError('SKILL_COLLECTION_ROOT_INVALID', `${title(kind)} root must be an absolute path: ${path}`);
  let canonical: string; try { canonical = await realpath(path); } catch (error) { throw new BazframeError('SKILL_COLLECTION_ROOT_INVALID', `Could not resolve ${kind} root ${path}${formatCode(error)}`, { cause: error }); }
  const metadata = await lstat(canonical); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('SKILL_COLLECTION_ROOT_INVALID', `${title(kind)} root must be a physical directory: ${canonical}`);
  return canonical;
}
export async function scanGlobalSkillCollections(home: string): Promise<SkillCollectionNamespace> {
  const [libraries, packages] = await Promise.all([scanNamespace(home, 'library'), scanNamespace(home, 'package')]);
  return { records: [...libraries.records, ...packages.records].sort((a,b) => compare(collectionKey(a.key.kind,a.key.id),collectionKey(b.key.kind,b.key.id))), diagnostics: [...libraries.diagnostics, ...packages.diagnostics] };
}

interface DirectoryIdentity { device: bigint; inode: bigint }
interface OpenDirectory { path: string; handle: FileHandle; identity: DirectoryIdentity }
async function scanNamespace(home: string, kind: SkillCollectionKind): Promise<SkillCollectionNamespace> {
  const rootPath = globalCollectionDirectory(home, kind); let rootMetadata;
  try { rootMetadata = await lstat(rootPath, { bigint: true }); } catch (error) { if (errorCode(error) === 'ENOENT') return { records: [], diagnostics: [] }; return invalidRoot(kind); }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return invalidRoot(kind);
  let root: OpenDirectory | undefined;
  try {
    root = await openDirectory(rootPath, identity(rootMetadata)); const records: SkillCollectionRecordPath[] = []; const diagnostics: SkillCollectionNamespaceDiagnostic[] = [];
    for (const name of await enumerateDirectory(root)) {
      const id = idFromName(name); const path = join(rootPath, name); let child;
      try { child = await lstat(path); } catch { diagnostics.push(diag(kind, id ?? UNKNOWN_COLLECTION_ID, name)); continue; }
      if (id === undefined || child.isSymbolicLink() || !child.isFile()) { diagnostics.push(diag(kind, id ?? UNKNOWN_COLLECTION_ID, name)); continue; }
      records.push({ key: { kind, id }, path, relativePath: name });
    }
    await assertDirectoryStable(root); return { records, diagnostics };
  } catch { return invalidRoot(kind); } finally { await root?.handle.close().catch(() => undefined); }
}
async function openExistingDirectory(path: string, detail: string, kind: SkillCollectionKind): Promise<OpenDirectory> { const metadata = await lstat(path, { bigint: true }); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid(kind, detail); return openDirectory(path, identity(metadata)); }
async function openDirectory(path: string, expected: DirectoryIdentity): Promise<OpenDirectory> { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { const opened = await handle.stat({ bigint: true }); if (!opened.isDirectory() || !sameIdentity(identity(opened), expected)) throw new Error('directory identity changed'); const directory = { path, handle, identity: expected }; await assertDirectoryStable(directory); return directory; } catch (error) { await handle.close().catch(() => undefined); throw error; } }
async function enumerateDirectory(directory: OpenDirectory): Promise<string[]> { await assertDirectoryStable(directory); const names = (await readdir(directory.path)).sort(compare); await assertDirectoryStable(directory); return names; }
async function assertDirectoryStable(directory: OpenDirectory): Promise<void> { const [opened,current] = await Promise.all([directory.handle.stat({bigint:true}),lstat(directory.path,{bigint:true})]); if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(identity(opened),directory.identity) || !sameIdentity(identity(current),directory.identity)) throw new Error('directory identity changed'); }
function identity(metadata:{dev:bigint;ino:bigint}):DirectoryIdentity{return{device:metadata.dev,inode:metadata.ino};} function sameIdentity(a:DirectoryIdentity,b:DirectoryIdentity):boolean{return a.device===b.device&&a.inode===b.inode;}
function idFromName(name:string):string|undefined{if(!name.endsWith('.json'))return undefined;const id=name.slice(0,-5);return isSafeSkillId(id)?id:undefined;}
function invalidRoot(kind:SkillCollectionKind):SkillCollectionNamespace{return{records:[],diagnostics:[diag(kind,UNKNOWN_COLLECTION_ID,'.')]};}
function diag(kind:SkillCollectionKind,id:string,path:string):SkillCollectionNamespaceDiagnostic{return{key:{kind,id},path};}
function invalid(kind:SkillCollectionKind,detail:string):BazframeError{return new BazframeError('SKILL_COLLECTION_RECORD_INVALID',`Invalid global ${kind}: ${detail}.`);}
function title(kind:SkillCollectionKind):string{return kind==='library'?'Library':'Package';} function formatCode(error:unknown):string{const code=errorCode(error);return code===undefined?'':` (${code})`;} function compare(a:string,b:string):number{return a<b?-1:a>b?1:0;}
