import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { isPortableSourceRelativePath } from './source-build-manifest.js';

export interface SnapshotDirectoryEntry { path: string; type: 'directory' }
export interface SnapshotFileEntry { path: string; type: 'file'; executable: boolean; sha256: string }
export type SnapshotEntry = SnapshotDirectoryEntry | SnapshotFileEntry;
export interface SnapshotManifest { schemaVersion: 1; entries: SnapshotEntry[] }
export interface PublishedSnapshot { digest: string; snapshotRoot: string; artifactRoot: string; manifest: SnapshotManifest; manifestBytes: Buffer }
export interface SourceSnapshotDependencies {
  beforePublish?: (stagingRoot: string) => Promise<void>;
  duringArtifactVerification?: (artifactRoot: string) => Promise<void>;
}

const MODES_SUPPORTED = process.platform !== 'win32';
const DIRECTORY_MODE = 0o500;
const FILE_MODE = 0o400;
const EXECUTABLE_FILE_MODE = 0o500;

export function snapshotStoreRoot(bazframeHome: string): string { return join(bazframeHome, 'source-snapshots', 'sha256'); }
export function snapshotPath(bazframeHome: string, digest: string): string { return join(snapshotStoreRoot(bazframeHome), digest); }
export function encodeSnapshotManifest(manifest: SnapshotManifest): Buffer { return Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'); }

/** Snapshot paths describe physical basenames, not portable provider-build paths. */
export function isSnapshotEntryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  if (value === '.') return true;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function decodeSnapshotManifest(value: unknown): SnapshotManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw corrupt('manifest must be an object');
  const root = value as Record<string, unknown>;
  if (Object.keys(root).join(',') !== 'schemaVersion,entries' || root.schemaVersion !== 1 || !Array.isArray(root.entries)) throw corrupt('manifest shape is invalid');
  let previous: string | undefined;
  const entries: SnapshotEntry[] = root.entries.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw corrupt('entry is invalid');
    const item = raw as Record<string, unknown>;
    if (!isSnapshotEntryPath(item.path)) throw corrupt('entry path is invalid');
    if (previous !== undefined && compare(previous, item.path) >= 0) throw corrupt('entries are not in lexical path order');
    previous = item.path;
    if (item.type === 'directory' && Object.keys(item).join(',') === 'path,type') return { path: item.path, type: 'directory' };
    if (item.type === 'file' && Object.keys(item).join(',') === 'path,type,executable,sha256'
      && typeof item.executable === 'boolean' && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)) {
      return { path: item.path, type: 'file', executable: item.executable, sha256: item.sha256 };
    }
    throw corrupt('entry shape is invalid');
  });
  if (entries[0]?.path !== '.' || entries[0].type !== 'directory') throw corrupt('manifest root entry is missing');
  return { schemaVersion: 1, entries };
}

export async function resolvePhysicalRelativeDirectory(root: string, relativePath: string): Promise<string> {
  if (!isPortableSourceRelativePath(relativePath)) throw new BazframeError('SOURCE_PATH_INVALID', `Invalid source-relative directory: ${relativePath}`);
  const canonicalRoot = await physicalDirectory(root, 'Root');
  let current = canonicalRoot;
  if (relativePath !== '.') for (const segment of relativePath.split('/')) {
    const next = join(current, segment);
    const metadata = await lstat(next).catch((error: unknown) => { throw pathError(next, error); });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('SOURCE_PATH_INVALID', `Source path component must be a physical directory: ${next}`);
    const canonical = await realpath(next);
    if (!within(canonicalRoot, canonical)) throw new BazframeError('SOURCE_PATH_INVALID', `Source path escapes its root: ${relativePath}`);
    current = canonical;
  }
  return current;
}

export async function publishSourceSnapshot(
  bazframeHome: string,
  inputArtifactRoot: string,
  dependencies: SourceSnapshotDependencies = {}
): Promise<PublishedSnapshot> {
  const canonicalInput = await physicalDirectory(inputArtifactRoot, 'Artifact root');
  const store = snapshotStoreRoot(bazframeHome);
  await ensureManagedDirectory(bazframeHome, store);
  const canonicalStore = await realpath(store);
  if (within(canonicalInput, canonicalStore) || within(canonicalStore, canonicalInput)) {
    throw new BazframeError('SOURCE_SNAPSHOT_PATH_OVERLAP', 'Artifact root and Bazframe snapshot storage must not overlap.');
  }
  const staging = join(canonicalStore, `.staging-${process.pid}-${randomUUID()}`);
  const stagedArtifact = join(staging, 'artifact');
  let published = false;
  let renamedToFinal: string | undefined;
  try {
    await mkdir(stagedArtifact, { recursive: true, mode: 0o700 });
    const entries: SnapshotEntry[] = [{ path: '.', type: 'directory' }];
    await copyTree(canonicalInput, stagedArtifact, '.', entries, canonicalInput);
    entries.sort((a, b) => compare(a.path, b.path));
    const manifest: SnapshotManifest = { schemaVersion: 1, entries };
    const manifestBytes = encodeSnapshotManifest(manifest);
    const digest = createHash('sha256').update(manifestBytes).digest('hex');
    await writePhysicalFile(join(staging, 'manifest.json'), manifestBytes);
    await normalizeSnapshot(staging, manifest.entries);
    await verifySnapshotAt(staging, digest);
    await dependencies.beforePublish?.(staging);
    await verifySnapshotAt(staging, digest);
    const final = join(canonicalStore, digest);
    try {
      await verifySnapshotAt(final, digest);
      await makeTreeWritable(staging);
      await rm(staging, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof BazframeError) || error.code !== 'SOURCE_SNAPSHOT_CORRUPT' || await pathExists(final)) throw error;
      try {
        await rename(staging, final);
        renamedToFinal = final;
        published = true;
      } catch (renameError) {
        if (errorCode(renameError) === 'EACCES' && MODES_SUPPORTED && !await pathExists(final)) {
          // Darwin refuses to rename a non-writable directory even when both parents are writable.
          // Keep the artifact and manifest immutable; the digest remains inactive until descriptor commit.
          await chmod(staging, 0o700);
          await rename(staging, final);
          renamedToFinal = final;
          await chmod(final, DIRECTORY_MODE);
          published = true;
        } else {
          if (!new Set(['EEXIST', 'ENOTEMPTY', 'EACCES']).has(errorCode(renameError) ?? '')) throw renameError;
          await verifySnapshotAt(final, digest);
          await makeTreeWritable(staging);
          await rm(staging, { recursive: true, force: true });
        }
      }
    }
    return await verifySnapshotAt(final, digest);
  } catch (error) {
    if (!published) {
      const unpublished = renamedToFinal ?? staging;
      await makeTreeWritable(unpublished).catch(() => undefined);
      await rm(unpublished, { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof BazframeError) throw error;
    throw new BazframeError('SOURCE_SNAPSHOT_PUBLISH_FAILED', `Could not publish source snapshot${formatCode(error)}`, { cause: error });
  }
}

export async function verifySourceSnapshot(
  bazframeHome: string,
  digest: string,
  dependencies: SourceSnapshotDependencies = {}
): Promise<PublishedSnapshot> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw corrupt('snapshot digest is invalid');
  return verifySnapshotAt(snapshotPath(bazframeHome, digest), digest, dependencies);
}

async function verifySnapshotAt(
  root: string,
  expectedDigest: string,
  dependencies: SourceSnapshotDependencies = {}
): Promise<PublishedSnapshot> {
  let openedRoot: OpenPhysicalDirectory | undefined;
  let openedArtifact: OpenPhysicalDirectory | undefined;
  try {
    openedRoot = await openPhysicalDirectory(root, 'snapshot root');
    assertMode(openedRoot.identity.mode, DIRECTORY_MODE, 'snapshot root');
    const snapshotRoot = await realpath(root);
    await assertOpenDirectoryStable(openedRoot);
    const names = (await readdir(root)).sort(compare);
    await assertOpenDirectoryStable(openedRoot);
    if (names.join(',') !== 'artifact,manifest.json') throw corrupt('snapshot root contains unexpected entries');
    const manifestFile = await readStablePhysicalFile(join(root, 'manifest.json'), 'manifest');
    assertMode(manifestFile.mode, FILE_MODE, 'manifest');
    const manifestBytes = manifestFile.bytes;
    const digest = createHash('sha256').update(manifestBytes).digest('hex');
    if (digest !== expectedDigest) throw corrupt('manifest digest does not match snapshot identity');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); } catch (error) { throw corrupt('manifest bytes are invalid', error); }
    const manifest = decodeSnapshotManifest(parsed);
    if (!encodeSnapshotManifest(manifest).equals(manifestBytes)) throw corrupt('manifest bytes are not canonical');
    openedArtifact = await openPhysicalDirectory(join(root, 'artifact'), 'snapshot artifact');
    assertMode(openedArtifact.identity.mode, DIRECTORY_MODE, 'snapshot artifact');
    const artifactRoot = await realpath(openedArtifact.path);
    if (artifactRoot === snapshotRoot || !within(snapshotRoot, artifactRoot)) throw corrupt('artifact escapes snapshot root');
    await assertOpenDirectoryStable(openedRoot);
    await assertOpenDirectoryStable(openedArtifact);
    await dependencies.duringArtifactVerification?.(artifactRoot);
    await assertOpenDirectoryStable(openedArtifact);
    await assertOpenDirectoryStable(openedRoot);
    const actual: SnapshotEntry[] = [{ path: '.', type: 'directory' }];
    await inspectTree(artifactRoot, '.', actual, openedArtifact);
    actual.sort((a, b) => compare(a.path, b.path));
    if (JSON.stringify(actual) !== JSON.stringify(manifest.entries)) throw corrupt('artifact tree does not match manifest');
    await assertOpenDirectoryStable(openedArtifact);
    await assertOpenDirectoryStable(openedRoot);
    if (await realpath(root) !== snapshotRoot || await realpath(openedArtifact.path) !== artifactRoot) throw corrupt('snapshot directory canonical identity changed');
    return { digest, snapshotRoot: root, artifactRoot, manifest, manifestBytes };
  } catch (error) {
    if (error instanceof BazframeError && error.code === 'SOURCE_SNAPSHOT_CORRUPT') throw error;
    throw corrupt(`snapshot cannot be verified${formatCode(error)}`, error);
  } finally {
    await openedArtifact?.handle.close().catch(() => undefined);
    await openedRoot?.handle.close().catch(() => undefined);
  }
}

async function copyTree(source: string, destination: string, relativePath: string, entries: SnapshotEntry[], root: string): Promise<void> {
  const identity = await physicalDirectoryIdentity(source, 'snapshot input directory', invalidEntry);
  for (const name of (await readdir(source)).sort(compare)) {
    const from = join(source, name); const to = join(destination, name);
    const path = relativePath === '.' ? name : `${relativePath}/${name}`;
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink()) throw new BazframeError('SOURCE_SNAPSHOT_INVALID_ENTRY', `Snapshot input contains a symbolic link: ${path}`);
    const canonical = await realpath(from);
    if (!within(root, canonical)) throw new BazframeError('SOURCE_SNAPSHOT_INVALID_ENTRY', `Snapshot input escapes its root: ${path}`);
    if (metadata.isDirectory()) {
      await mkdir(to, { mode: 0o700 }); entries.push({ path, type: 'directory' }); await copyTree(from, to, path, entries, root);
    } else if (metadata.isFile()) {
      const physical = await readStablePhysicalFile(from, `snapshot input file ${path}`, invalidEntry);
      await writePhysicalFile(to, physical.bytes);
      entries.push({ path, type: 'file', executable: executable(physical.mode), sha256: sha256(physical.bytes) });
    } else throw new BazframeError('SOURCE_SNAPSHOT_INVALID_ENTRY', `Snapshot input contains an unsupported entry: ${path}`);
  }
  await assertDirectoryIdentity(source, identity, 'snapshot input directory', invalidEntry);
}

async function inspectTree(root: string, relativePath: string, entries: SnapshotEntry[], heldRoot: OpenPhysicalDirectory): Promise<void> {
  await assertOpenDirectoryStable(heldRoot);
  const directory = relativePath === '.' ? root : join(root, ...relativePath.split('/'));
  const identity = await physicalDirectoryIdentity(directory, `artifact directory ${relativePath}`);
  assertMode(identity.mode, DIRECTORY_MODE, `artifact directory ${relativePath}`);
  for (const name of (await readdir(directory)).sort(compare)) {
    const absolute = join(directory, name); const path = relativePath === '.' ? name : `${relativePath}/${name}`;
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw corrupt(`artifact contains a symbolic link: ${path}`);
    const canonical = await realpath(absolute); if (!within(root, canonical)) throw corrupt(`artifact escapes its root: ${path}`);
    if (metadata.isDirectory()) { entries.push({ path, type: 'directory' }); await inspectTree(root, path, entries, heldRoot); }
    else if (metadata.isFile()) {
      const physical = await readStablePhysicalFile(absolute, `artifact file ${path}`);
      const isExecutable = executable(physical.mode);
      assertMode(physical.mode, isExecutable ? EXECUTABLE_FILE_MODE : FILE_MODE, `artifact file ${path}`);
      entries.push({ path, type: 'file', executable: isExecutable, sha256: sha256(physical.bytes) });
    } else throw corrupt(`artifact contains an unsupported entry: ${path}`);
  }
  await assertDirectoryIdentity(directory, identity, `artifact directory ${relativePath}`);
  await assertOpenDirectoryStable(heldRoot);
}

interface FileSystemIdentity { device: bigint; inode: bigint; mode: number }
interface OpenPhysicalDirectory { path: string; handle: FileHandle; identity: FileSystemIdentity }
async function openPhysicalDirectory(path: string, label: string): Promise<OpenPhysicalDirectory> {
  let handle: FileHandle | undefined;
  try {
    const before = await physicalDirectoryIdentity(path, label);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.device || opened.ino !== before.inode) throw new Error('directory identity changed');
    const result = { path, handle, identity: before };
    await assertOpenDirectoryStable(result);
    return result;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw corrupt(`${label} could not be opened as a stable physical directory`, error);
  }
}
async function assertOpenDirectoryStable(directory: OpenPhysicalDirectory): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || opened.dev !== directory.identity.device || opened.ino !== directory.identity.inode
    || current.dev !== directory.identity.device || current.ino !== directory.identity.inode) {
    throw corrupt(`${directory.path} directory identity changed`);
  }
}
async function physicalDirectoryIdentity(path: string, label: string, failure: (detail: string, cause?: unknown) => BazframeError = corrupt): Promise<FileSystemIdentity> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('not a physical directory');
    return { device: metadata.dev, inode: metadata.ino, mode: Number(metadata.mode) };
  } catch (error) { throw failure(`${label} changed during inspection`, error); }
}
async function assertDirectoryIdentity(path: string, expected: FileSystemIdentity, label: string, failure: (detail: string, cause?: unknown) => BazframeError = corrupt): Promise<void> {
  try {
    const actual = await lstat(path, { bigint: true });
    if (actual.isSymbolicLink() || !actual.isDirectory() || actual.dev !== expected.device || actual.ino !== expected.inode) throw new Error('directory identity changed');
  } catch (error) { throw failure(`${label} changed during inspection`, error); }
}

interface PhysicalFile { bytes: Buffer; mode: number }
async function readStablePhysicalFile(path: string, label: string, failure: (detail: string, cause?: unknown) => BazframeError = corrupt): Promise<PhysicalFile> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) throw new Error('not a physical file');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await lstat(path, { bigint: true });
    if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()
      || before.dev !== opened.dev || before.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('file identity changed');
    return { bytes, mode: Number(opened.mode) };
  } catch (error) { throw failure(`${label} changed during inspection`, error); }
  finally { await handle?.close().catch(() => undefined); }
}

async function writePhysicalFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function normalizeSnapshot(staging: string, entries: readonly SnapshotEntry[]): Promise<void> {
  if (!MODES_SUPPORTED) return;
  const artifact = join(staging, 'artifact');
  for (const entry of [...entries].reverse()) {
    const path = entry.path === '.' ? artifact : join(artifact, ...entry.path.split('/'));
    await chmod(path, entry.type === 'directory' ? DIRECTORY_MODE : entry.executable ? EXECUTABLE_FILE_MODE : FILE_MODE);
  }
  await chmod(join(staging, 'manifest.json'), FILE_MODE);
  await chmod(staging, DIRECTORY_MODE);
}
async function makeTreeWritable(root: string): Promise<void> {
  let metadata; try { metadata = await lstat(root); } catch { return; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  await chmod(root, 0o700).catch(() => undefined);
  for (const name of await readdir(root)) {
    const path = join(root, name); const child = await lstat(path);
    if (child.isDirectory() && !child.isSymbolicLink()) await makeTreeWritable(path);
    else await chmod(path, 0o600).catch(() => undefined);
  }
}
function assertMode(mode: number, expected: number, label: string): void { if (MODES_SUPPORTED && (mode & 0o777) !== expected) throw corrupt(`${label} mode is writable or otherwise invalid`); }
function executable(mode: number): boolean { return MODES_SUPPORTED && (mode & 0o111) !== 0; }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
async function physicalDirectory(path: string, label: string): Promise<string> { const metadata = await lstat(path); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('SOURCE_PATH_INVALID', `${label} must be a physical directory: ${path}`); const canonical = await realpath(path); if (!isAbsolute(canonical)) throw new BazframeError('SOURCE_PATH_INVALID', `${label} is invalid: ${path}`); return canonical; }
function within(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function compare(a: string, b: string): number { const left = [...a]; const right = [...b]; for (let index = 0; index < Math.min(left.length, right.length); index += 1) { const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!; if (difference !== 0) return difference; } return left.length - right.length; }
function corrupt(detail: string, cause?: unknown): BazframeError { return new BazframeError('SOURCE_SNAPSHOT_CORRUPT', `Source snapshot is corrupt: ${detail}.`, cause === undefined ? undefined : { cause }); }
function invalidEntry(detail: string, cause?: unknown): BazframeError { return new BazframeError('SOURCE_SNAPSHOT_INVALID_ENTRY', `Invalid snapshot input: ${detail}.`, cause === undefined ? undefined : { cause }); }
function pathError(path: string, error: unknown): BazframeError { return new BazframeError('SOURCE_PATH_INVALID', `Could not resolve source path ${path}${formatCode(error)}`, { cause: error }); }
async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
