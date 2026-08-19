import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { isPortableSourceRelativePath } from '../source-units/source-build-manifest.js';

const SOURCE_KEYS = ['digest', 'root', 'schemaVersion', 'source', 'sourceUnitRoot'] as const;

export interface GlobalSourceRecord {
  schemaVersion: 1;
  source: string;
  root: string;
  digest: string;
  sourceUnitRoot: string;
}

export interface GlobalSourceRecordSnapshot {
  record: GlobalSourceRecord;
  path: string;
  device: bigint;
  inode: bigint;
  contentSha256: string;
}

export interface GlobalSourcePath {
  source: string;
  path: string;
  relativePath: string;
}

export interface SourceNamespaceDiagnostic {
  source: string;
  path: string;
}

export interface GlobalSourceNamespace {
  sources: GlobalSourcePath[];
  diagnostics: SourceNamespaceDiagnostic[];
}

export const UNKNOWN_SOURCE = '<unknown-source>';

export function globalSourcesDirectory(home: string): string { return join(home, 'sources'); }
export function globalSourcePath(home: string, source: string): string {
  return join(globalSourcesDirectory(home), `${source}.json`);
}

export function encodeGlobalSource(record: GlobalSourceRecord): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    source: record.source,
    root: record.root,
    digest: record.digest,
    sourceUnitRoot: record.sourceUnitRoot
  }, null, 2)}\n`;
}

export function decodeGlobalSource(value: unknown, expectedSource?: string): GlobalSourceRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('source must be a JSON object');
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== SOURCE_KEYS.length || !keys.every((key, index) => key === SOURCE_KEYS[index])) {
    throw invalid('source must contain exactly the schema-v1 fields');
  }
  if (candidate.schemaVersion !== 1) throw invalid('unsupported schemaVersion');
  if (typeof candidate.source !== 'string' || !isSafeSkillId(candidate.source)) throw invalid('source is invalid');
  if (expectedSource !== undefined && candidate.source !== expectedSource) throw invalid('source does not match source path');
  if (typeof candidate.root !== 'string' || candidate.root.includes('\0') || !isAbsolute(candidate.root) || resolve(candidate.root) !== candidate.root) {
    throw invalid('root must be a canonical absolute path');
  }
  if (basename(candidate.root) !== candidate.source) throw invalid('source must match the canonical root basename');
  if (typeof candidate.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.digest)) throw invalid('digest must be lowercase SHA-256');
  if (typeof candidate.sourceUnitRoot !== 'string' || !isPortableSourceRelativePath(candidate.sourceUnitRoot)) throw invalid('sourceUnitRoot is invalid');
  return {
    schemaVersion: 1,
    source: candidate.source,
    root: candidate.root,
    digest: candidate.digest,
    sourceUnitRoot: candidate.sourceUnitRoot
  };
}

export async function readGlobalSource(home: string, source: string): Promise<GlobalSourceRecord> {
  return (await readGlobalSourceSnapshot(home, source)).record;
}

export async function readGlobalSourceSnapshot(home: string, source: string): Promise<GlobalSourceRecordSnapshot> {
  if (!isSafeSkillId(source)) throw invalid('source is invalid');
  const rootPath = globalSourcesDirectory(home);
  const path = globalSourcePath(home, source);
  const directoryPaths = [home, rootPath];
  const directories: OpenDirectory[] = [];
  let handle: FileHandle | undefined;
  try {
    for (const directoryPath of directoryPaths) {
      directories.push(await openExistingDirectory(directoryPath, 'source ancestor must be a physical directory'));
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw invalid('source must be a physical regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    if (!after.isFile() || pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== pathMetadata.dev || after.ino !== pathMetadata.ino) throw invalid('source identity changed while reading');
    for (const directory of [...directories].reverse()) await assertDirectoryStable(directory);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new BazframeError('SOURCE_RECORD_INVALID', 'Global source is not valid UTF-8.', { cause: error }); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) { throw new BazframeError('SOURCE_RECORD_INVALID', 'Global source is not valid JSON.', { cause: error }); }
    return {
      record: decodeGlobalSource(value, source),
      path,
      device: before.dev,
      inode: before.ino,
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    };
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) === 'ELOOP') throw invalid('source and its namespace ancestors must be physical');
    throw new BazframeError('SOURCE_RECORD_READ_FAILED', `Could not read global source ${path}${formatCode(error)}`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    for (const directory of [...directories].reverse()) await directory.handle.close().catch(() => undefined);
  }
}

export function sameGlobalSourceSnapshot(left: GlobalSourceRecordSnapshot, right: GlobalSourceRecordSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode && left.contentSha256 === right.contentSha256;
}

export async function canonicalPhysicalSourceRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) throw new BazframeError('SOURCE_ROOT_INVALID', `Source root must be an absolute path: ${path}`);
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) { throw new BazframeError('SOURCE_ROOT_INVALID', `Could not resolve source root ${path}${formatCode(error)}`, { cause: error }); }
  const metadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('SOURCE_ROOT_INVALID', `Source root must be a physical directory: ${canonical}`);
  return canonical;
}

export async function scanGlobalSourceNamespace(home: string): Promise<GlobalSourceNamespace> {
  return scanNamespace(globalSourcesDirectory(home));
}

interface DirectoryIdentity { device: bigint; inode: bigint }
interface OpenDirectory { path: string; handle: FileHandle; identity: DirectoryIdentity }

async function scanNamespace(rootPath: string): Promise<GlobalSourceNamespace> {
  let rootMetadata;
  try { rootMetadata = await lstat(rootPath, { bigint: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { sources: [], diagnostics: [] };
    return invalidRoot();
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return invalidRoot();
  let root: OpenDirectory | undefined;
  try {
    root = await openDirectory(rootPath, identity(rootMetadata));
    const sources: GlobalSourcePath[] = [];
    const diagnostics: SourceNamespaceDiagnostic[] = [];
    for (const name of await enumerateDirectory(root)) {
      const source = sourceFromName(name);
      const path = join(rootPath, name);
      let child;
      try { child = await lstat(path); }
      catch { diagnostics.push(diag(source ?? UNKNOWN_SOURCE, name)); continue; }
      if (source === undefined || child.isSymbolicLink() || !child.isFile()) {
        diagnostics.push(diag(source ?? UNKNOWN_SOURCE, name));
        continue;
      }
      sources.push({ source, path, relativePath: name });
    }
    await assertDirectoryStable(root);
    return { sources, diagnostics };
  } catch { return invalidRoot(); }
  finally { await root?.handle.close().catch(() => undefined); }
}

async function openExistingDirectory(path: string, invalidDetail: string): Promise<OpenDirectory> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid(invalidDetail);
  return openDirectory(path, identity(metadata));
}

async function openDirectory(path: string, expected: DirectoryIdentity): Promise<OpenDirectory> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(identity(opened), expected)) throw new Error('directory identity changed');
    const directory = { path, handle, identity: expected };
    await assertDirectoryStable(directory);
    return directory;
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}
async function enumerateDirectory(directory: OpenDirectory): Promise<string[]> {
  await assertDirectoryStable(directory);
  const names = (await readdir(directory.path)).sort(compare);
  await assertDirectoryStable(directory);
  return names;
}
async function assertDirectoryStable(directory: OpenDirectory): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }), lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !sameIdentity(identity(opened), directory.identity) || !sameIdentity(identity(current), directory.identity)) {
    throw new Error('directory identity changed');
  }
}
function identity(metadata: { dev: bigint; ino: bigint }): DirectoryIdentity { return { device: metadata.dev, inode: metadata.ino }; }
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.device === right.device && left.inode === right.inode; }

function sourceFromName(name: string): string | undefined {
  if (!name.endsWith('.json')) return undefined;
  const source = name.slice(0, -5);
  return isSafeSkillId(source) ? source : undefined;
}
function invalidRoot(): GlobalSourceNamespace { return { sources: [], diagnostics: [diag(UNKNOWN_SOURCE, '.')] }; }
function diag(source: string, path: string): SourceNamespaceDiagnostic { return { source, path }; }
function invalid(detail: string): BazframeError { return new BazframeError('SOURCE_RECORD_INVALID', `Invalid global source: ${detail}.`); }
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
