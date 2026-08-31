import { createHash, randomUUID, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  rmdir,
  type FileHandle
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { isPortableRelativePath } from './portable-relative-path.js';

export interface SnapshotDirectoryEntry { path: string; type: 'directory' }
export interface SnapshotFileEntry { path: string; type: 'file'; executable: boolean; sha256: string }
export type SnapshotEntry = SnapshotDirectoryEntry | SnapshotFileEntry;
export interface SnapshotManifest { schemaVersion: 1; entries: SnapshotEntry[] }
export interface PublishedSnapshot { digest: string; snapshotRoot: string; artifactPath: string; manifest: SnapshotManifest; manifestBytes: Buffer }

export interface SkillSnapshotLimitPolicy {
  maxManifestBytes: number;
  maxEntries: number;
  maxDepth: number;
  maxPathBytes: number;
  maxFileBytes: number;
  maxAggregateFileBytes: number;
}

export const SKILL_SNAPSHOT_LIMITS: Readonly<SkillSnapshotLimitPolicy> = Object.freeze({
  maxManifestBytes: 4 * 1024 * 1024,
  maxEntries: 8192,
  maxDepth: 32,
  maxPathBytes: 4096,
  maxFileBytes: 64 * 1024 * 1024,
  maxAggregateFileBytes: 512 * 1024 * 1024
});

export type SkillSnapshotHandleTarget =
  | 'source-file'
  | 'destination-file'
  | 'manifest-file'
  | 'enumeration-directory'
  | 'snapshot-root-directory'
  | 'artifact-root-directory'
  | 'cleanup-directory';

export interface SkillSnapshotDependencies {
  beforePublish?: (stagingRoot: string) => Promise<void>;
  duringArtifactVerification?: (artifactPath: string) => Promise<void>;
  /** Internal exact source precondition for a caller that already inspected the physical root. */
  expectedInputRootIdentity?: { canonicalPath: string; device: bigint; inode: bigint };
  /** Internal deterministic substitution seam immediately before snapshot input capture. */
  beforeInputRootIdentityCapture?: () => Promise<void>;
  /** Deterministic source-mutation seam used only by lifecycle tests. */
  duringSourceFileCopy?: (sourcePath: string) => void | Promise<void>;
  /** Deterministic artifact-mutation seam used only by verification tests. */
  duringArtifactFileHash?: (artifactPath: string) => void | Promise<void>;
  /** Deterministic staged-substitution seam used only by publication tests. */
  beforeStagedDirectoryNormalization?: (stagingRoot: string) => void | Promise<void>;
  /** Deterministic zero-progress seam used only by lifecycle tests. */
  destinationWrite?: (destinationPath: string, requestedBytes: number) => number | Promise<number>;
  /** Deterministic close-failure seam used only by lifecycle tests. */
  afterHandleClose?: (target: SkillSnapshotHandleTarget, path: string) => void | Promise<void>;
  /** Tests may lower, but never raise, the production ceilings. */
  limitPolicy?: SkillSnapshotLimitPolicy;
}

const MODES_SUPPORTED = process.platform !== 'win32';
const DIRECTORY_MODE = 0o500;
const FILE_MODE = 0o400;
const EXECUTABLE_FILE_MODE = 0o500;
const COPY_BUFFER_BYTES = 64 * 1024;

interface TraversalBudget {
  entries: number;
  aggregateFileBytes: number;
}

interface OwnedStagingEntry {
  type: 'directory' | 'file';
  device: bigint;
  inode: bigint;
}

type OwnedStagingTree = Map<string, OwnedStagingEntry>;

export function snapshotStoreRoot(bazframeHome: string): string { return join(bazframeHome, 'skill-snapshots', 'sha256'); }
export function snapshotPath(bazframeHome: string, digest: string): string { return join(snapshotStoreRoot(bazframeHome), digest); }

export function encodeSnapshotManifest(
  manifest: SnapshotManifest,
  limitPolicy: SkillSnapshotLimitPolicy = SKILL_SNAPSHOT_LIMITS
): Buffer {
  const policy = copyLimitPolicy(limitPolicy);
  const decoded = decodeSnapshotManifest(manifest, policy);
  const prefix = '{"schemaVersion":1,"entries":[';
  const suffix = ']}\n';
  let byteCount = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  const encodedEntries: string[] = [];
  for (const entry of decoded.entries) {
    const encoded = JSON.stringify(entry);
    byteCount += Buffer.byteLength(encoded, 'utf8') + (encodedEntries.length === 0 ? 0 : 1);
    if (byteCount > policy.maxManifestBytes) throw corrupt(`manifest exceeds the ${policy.maxManifestBytes}-byte limit`);
    encodedEntries.push(encoded);
  }
  return Buffer.from(`${prefix}${encodedEntries.join(',')}${suffix}`, 'utf8');
}

/** Snapshot paths describe physical basenames, not portable provider-build paths. */
export function isSnapshotEntryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  if (value === '.') return true;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function decodeSnapshotManifest(
  value: unknown,
  limitPolicy: SkillSnapshotLimitPolicy = SKILL_SNAPSHOT_LIMITS
): SnapshotManifest {
  const policy = copyLimitPolicy(limitPolicy);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw corrupt('manifest must be an object');
  const root = value as Record<string, unknown>;
  if (Object.keys(root).join(',') !== 'schemaVersion,entries' || root.schemaVersion !== 1 || !Array.isArray(root.entries)) {
    throw corrupt('manifest shape is invalid');
  }
  if (root.entries.length > policy.maxEntries) throw corrupt(`manifest entries exceed the ${policy.maxEntries}-entry limit`);
  const entries: SnapshotEntry[] = [];
  let canonicalByteCount = Buffer.byteLength('{"schemaVersion":1,"entries":[]}' + '\n', 'utf8');
  let previous: string | undefined;
  for (let index = 0; index < root.entries.length; index += 1) {
    const raw: unknown = root.entries[index];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw corrupt('entry is invalid');
    const item = raw as Record<string, unknown>;
    if (!isSnapshotEntryPath(item.path)) throw corrupt('entry path is invalid');
    assertPathLimits(item.path, policy, corrupt);
    if (previous !== undefined && compare(previous, item.path) >= 0) throw corrupt('entries are not in lexical path order');
    previous = item.path;
    let entry: SnapshotEntry;
    if (item.type === 'directory' && Object.keys(item).join(',') === 'path,type') {
      entry = { path: item.path, type: 'directory' };
    } else if (item.type === 'file' && Object.keys(item).join(',') === 'path,type,executable,sha256'
      && typeof item.executable === 'boolean' && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)) {
      entry = { path: item.path, type: 'file', executable: item.executable, sha256: item.sha256 };
    } else {
      throw corrupt('entry shape is invalid');
    }
    canonicalByteCount += Buffer.byteLength(JSON.stringify(entry), 'utf8') + (entries.length === 0 ? 0 : 1);
    if (canonicalByteCount > policy.maxManifestBytes) throw corrupt(`manifest exceeds the ${policy.maxManifestBytes}-byte limit`);
    entries.push(entry);
  }
  if (entries[0]?.path !== '.' || entries[0].type !== 'directory') throw corrupt('manifest root entry is missing');
  return { schemaVersion: 1, entries };
}

export async function resolvePhysicalRelativeDirectory(root: string, relativePath: string): Promise<string> {
  if (!isPortableRelativePath(relativePath)) throw new BazframeError('SKILL_COLLECTION_PATH_INVALID', `Invalid snapshot-relative directory: ${relativePath}`);
  const canonicalRoot = await physicalDirectory(root, 'Root');
  let current = canonicalRoot;
  if (relativePath !== '.') for (const segment of relativePath.split('/')) {
    const next = join(current, segment);
    const metadata = await lstat(next).catch((error: unknown) => { throw pathError(next, error); });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('SKILL_COLLECTION_PATH_INVALID', `Snapshot path component must be a physical directory: ${next}`);
    const canonical = await realpath(next);
    if (!within(canonicalRoot, canonical)) throw new BazframeError('SKILL_COLLECTION_PATH_INVALID', `Snapshot path escapes its root: ${relativePath}`);
    current = canonical;
  }
  return current;
}

export async function publishSkillSnapshot(
  bazframeHome: string,
  inputArtifactRoot: string,
  dependencies: SkillSnapshotDependencies = {}
): Promise<PublishedSnapshot> {
  const policy = copyLimitPolicy(dependencies.limitPolicy);
  const canonicalInput = await physicalDirectory(inputArtifactRoot, 'Artifact root');
  if (dependencies.expectedInputRootIdentity !== undefined
    && canonicalInput !== dependencies.expectedInputRootIdentity.canonicalPath) {
    throw new BazframeError('SKILL_COLLECTION_ROOT_CHANGED', `Snapshot input root does not match the caller's expected canonical path: ${canonicalInput}`);
  }
  const store = snapshotStoreRoot(bazframeHome);
  await ensureManagedDirectory(bazframeHome, store);
  const canonicalStore = await realpath(store);
  if (within(canonicalInput, canonicalStore) || within(canonicalStore, canonicalInput)) {
    throw new BazframeError('SKILL_SNAPSHOT_PATH_OVERLAP', 'Artifact root and Bazframe snapshot storage must not overlap.');
  }
  const staging = join(canonicalStore, `.staging-${process.pid}-${randomUUID()}`);
  const stagedArtifact = join(staging, 'artifact');
  let published = false;
  let renamedToFinal: string | undefined;
  const entries: SnapshotEntry[] = [{ path: '.', type: 'directory' }];
  const owned: OwnedStagingTree = new Map();
  try {
    await createOwnedStagingDirectory(staging, '.', owned);
    await createOwnedStagingDirectory(stagedArtifact, 'artifact', owned);
    const budget: TraversalBudget = { entries: 1, aggregateFileBytes: 0 };
    await dependencies.beforeInputRootIdentityCapture?.();
    await copyTree(
      canonicalInput,
      stagedArtifact,
      '.',
      entries,
      canonicalInput,
      policy,
      budget,
      dependencies,
      owned,
      dependencies.expectedInputRootIdentity
    );
    entries.sort((a, b) => compare(a.path, b.path));
    const manifest: SnapshotManifest = { schemaVersion: 1, entries };
    const manifestBytes = encodeSnapshotManifest(manifest, policy);
    const digest = createHash('sha256').update(manifestBytes).digest('hex');
    await writePhysicalFile(join(staging, 'manifest.json'), manifestBytes, dependencies, (identity) => {
      owned.set('manifest.json', ownedEntry('file', identity));
    });
    await dependencies.beforeStagedDirectoryNormalization?.(staging);
    await normalizeOwnedDirectory(stagedArtifact, requireOwnedEntry(owned, 'artifact'), dependencies);
    await normalizeOwnedDirectory(staging, requireOwnedEntry(owned, '.'), dependencies);
    const verificationIo = { afterHandleClose: dependencies.afterHandleClose };
    await verifySnapshotAt(staging, digest, verificationIo, policy);
    await dependencies.beforePublish?.(staging);
    await verifySnapshotAt(staging, digest, verificationIo, policy);
    const final = join(canonicalStore, digest);
    try {
      await verifySnapshotAt(final, digest, verificationIo, policy);
      await cleanupOwnedStagingTree(staging, policy, dependencies, owned);
    } catch (error) {
      if (!(error instanceof BazframeError) || error.code !== 'SKILL_SNAPSHOT_CORRUPT' || await pathExists(final)) throw error;
      try {
        await rename(staging, final);
        renamedToFinal = final;
        published = true;
      } catch (renameError) {
        if (errorCode(renameError) === 'EACCES' && MODES_SUPPORTED && !await pathExists(final)) {
          // Darwin refuses to rename a non-writable directory even when both parents are writable.
          // Keep the artifact and manifest immutable; the digest remains inactive until descriptor commit.
          await setOwnedDirectoryMode(staging, requireOwnedEntry(owned, '.'), 0o700, dependencies);
          await rename(staging, final);
          renamedToFinal = final;
          await setOwnedDirectoryMode(final, requireOwnedEntry(owned, '.'), DIRECTORY_MODE, dependencies);
          published = true;
        } else {
          if (!new Set(['EEXIST', 'ENOTEMPTY', 'EACCES']).has(errorCode(renameError) ?? '')) throw renameError;
          await verifySnapshotAt(final, digest, verificationIo, policy);
          await cleanupOwnedStagingTree(staging, policy, dependencies, owned);
        }
      }
    }
    return await verifySnapshotAt(final, digest, verificationIo, policy);
  } catch (error) {
    let failure: unknown = error;
    if (!published) {
      const unpublished = renamedToFinal ?? staging;
      try {
        await cleanupOwnedStagingTree(unpublished, policy, dependencies, owned);
      } catch (cleanupError) {
        failure = combineFailures(failure, cleanupError, 'Snapshot publication and cleanup both failed');
      }
    }
    if (failure instanceof BazframeError) throw failure;
    throw new BazframeError('SKILL_SNAPSHOT_PUBLISH_FAILED', `Could not publish Skill snapshot${formatCode(failure)}`, { cause: failure });
  }
}

export async function verifySkillSnapshot(
  bazframeHome: string,
  digest: string,
  dependencies: SkillSnapshotDependencies = {}
): Promise<PublishedSnapshot> {
  const policy = copyLimitPolicy(dependencies.limitPolicy);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw corrupt('snapshot digest is invalid');
  return verifySnapshotAt(snapshotPath(bazframeHome, digest), digest, dependencies, policy);
}

async function verifySnapshotAt(
  root: string,
  expectedDigest: string,
  dependencies: SkillSnapshotDependencies,
  policy: SkillSnapshotLimitPolicy
): Promise<PublishedSnapshot> {
  let openedRoot: OpenPhysicalDirectory | undefined;
  let openedArtifact: OpenPhysicalDirectory | undefined;
  let result: PublishedSnapshot | undefined;
  let operationError: unknown;
  try {
    openedRoot = await openPhysicalDirectory(root, 'snapshot root', 'snapshot-root-directory', dependencies);
    assertMode(openedRoot.identity.mode, DIRECTORY_MODE, 'snapshot root');
    const snapshotRoot = await realpath(root);
    await assertOpenDirectoryStable(openedRoot);
    const names = await enumerateNames(root, 3, dependencies);
    await assertOpenDirectoryStable(openedRoot);
    names.sort(compare);
    if (names.join(',') !== 'artifact,manifest.json') throw corrupt('snapshot root contains unexpected entries');
    const manifestFile = await readStablePhysicalFile(
      join(root, 'manifest.json'),
      'manifest',
      policy.maxManifestBytes,
      corrupt,
      dependencies
    );
    assertMode(manifestFile.mode, FILE_MODE, 'manifest');
    const manifestBytes = manifestFile.bytes;
    const digest = createHash('sha256').update(manifestBytes).digest('hex');
    if (digest !== expectedDigest) throw corrupt('manifest digest does not match snapshot identity');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
    catch (error) { throw corrupt('manifest bytes are invalid', error); }
    const manifest = decodeSnapshotManifest(parsed, policy);
    if (!encodeSnapshotManifest(manifest, policy).equals(manifestBytes)) throw corrupt('manifest bytes are not canonical');
    openedArtifact = await openPhysicalDirectory(
      join(root, 'artifact'),
      'snapshot artifact',
      'artifact-root-directory',
      dependencies
    );
    assertMode(openedArtifact.identity.mode, DIRECTORY_MODE, 'snapshot artifact');
    const artifactRoot = await realpath(openedArtifact.path);
    if (artifactRoot === snapshotRoot || !within(snapshotRoot, artifactRoot)) throw corrupt('artifact escapes snapshot root');
    await assertOpenDirectoryStable(openedRoot);
    await assertOpenDirectoryStable(openedArtifact);
    await dependencies.duringArtifactVerification?.(artifactRoot);
    await assertOpenDirectoryStable(openedArtifact);
    await assertOpenDirectoryStable(openedRoot);
    await assertArtifactTreeMatches(artifactRoot, openedArtifact, manifestBytes, policy, dependencies);
    await assertOpenDirectoryStable(openedArtifact);
    await assertOpenDirectoryStable(openedRoot);
    await assertArtifactTreeMatches(artifactRoot, openedArtifact, manifestBytes, policy, dependencies);
    await assertOpenDirectoryStable(openedArtifact);
    await assertOpenDirectoryStable(openedRoot);
    if (await realpath(root) !== snapshotRoot || await realpath(openedArtifact.path) !== artifactRoot) throw corrupt('snapshot directory canonical identity changed');
    result = { digest, snapshotRoot: root, artifactPath: artifactRoot, manifest, manifestBytes };
  } catch (error) {
    operationError = error instanceof BazframeError && error.code === 'SKILL_SNAPSHOT_CORRUPT'
      ? error
      : corrupt(`snapshot cannot be verified${formatCode(error)}`, error);
  }
  const artifactClose = await closeHeldDirectory(openedArtifact, 'artifact-root-directory', dependencies);
  const rootClose = await closeHeldDirectory(openedRoot, 'snapshot-root-directory', dependencies);
  let error = combineFailures(operationError, artifactClose, 'Snapshot verification and artifact close both failed');
  error = combineFailures(error, rootClose, 'Snapshot verification and root close both failed');
  if (error !== undefined) throw error;
  return result!;
}

async function copyTree(
  source: string,
  destination: string,
  relativePath: string,
  entries: SnapshotEntry[],
  root: string,
  policy: SkillSnapshotLimitPolicy,
  budget: TraversalBudget,
  dependencies: SkillSnapshotDependencies,
  owned: OwnedStagingTree,
  expectedRootIdentity?: { canonicalPath: string; device: bigint; inode: bigint }
): Promise<void> {
  const identity = await physicalDirectoryIdentity(source, 'snapshot input directory', invalidEntry);
  if (relativePath === '.' && expectedRootIdentity !== undefined
    && (source !== expectedRootIdentity.canonicalPath
      || identity.device !== expectedRootIdentity.device
      || identity.inode !== expectedRootIdentity.inode)) {
    throw new BazframeError('SKILL_COLLECTION_ROOT_CHANGED', `Snapshot input root does not match the caller's expected physical identity: ${source}`);
  }
  const directory = await opendir(source);
  let operationError: unknown;
  try {
    let item;
    while ((item = await directory.read()) !== null) {
      const name = item.name;
      const from = join(source, name);
      const to = join(destination, name);
      const path = relativePath === '.' ? name : `${relativePath}/${name}`;
      const metadata = await lstat(from, { bigint: true });
      const aggregateBefore = consumeEntry(path, metadata, policy, budget, invalidEntry);
      if (metadata.isSymbolicLink()) throw new BazframeError('SKILL_SNAPSHOT_INVALID_ENTRY', `Snapshot input contains a symbolic link: ${path}`);
      const canonical = await realpath(from);
      if (!within(root, canonical)) throw new BazframeError('SKILL_SNAPSHOT_INVALID_ENTRY', `Snapshot input escapes its root: ${path}`);
      if (metadata.isDirectory()) {
        await createOwnedStagingDirectory(to, `artifact/${path}`, owned);
        entries.push({ path, type: 'directory' });
        await copyTree(from, to, path, entries, root, policy, budget, dependencies, owned);
        await normalizeOwnedDirectory(to, requireOwnedEntry(owned, `artifact/${path}`), dependencies);
      } else if (metadata.isFile()) {
        const copied = await copyStablePhysicalFile(
          from,
          to,
          `snapshot input file ${path}`,
          dependencies,
          fileSystemIdentity(metadata),
          streamByteLimit(policy, aggregateBefore!),
          (identity) => { owned.set(`artifact/${path}`, ownedEntry('file', identity)); }
        );
        reconcileFileBudget(budget, aggregateBefore!, copied.byteCount, policy, path, invalidEntry);
        entries.push({ path, type: 'file', executable: executable(copied.mode), sha256: copied.sha256 });
      } else {
        throw new BazframeError('SKILL_SNAPSHOT_INVALID_ENTRY', `Snapshot input contains an unsupported entry: ${path}`);
      }
    }
  } catch (error) {
    operationError = error;
  }
  const closeError = await closeDirectoryHandle(directory, source, 'enumeration-directory', dependencies, invalidEntry);
  const directoryError = combineFailures(operationError, closeError, 'Snapshot input enumeration and close both failed');
  if (directoryError !== undefined) throw directoryError;
  await assertDirectoryIdentity(source, identity, 'snapshot input directory', invalidEntry);
}

async function assertArtifactTreeMatches(
  artifactRoot: string,
  heldRoot: OpenPhysicalDirectory,
  manifestBytes: Uint8Array,
  policy: SkillSnapshotLimitPolicy,
  dependencies: SkillSnapshotDependencies
): Promise<void> {
  const actual: SnapshotEntry[] = [{ path: '.', type: 'directory' }];
  const budget: TraversalBudget = { entries: 1, aggregateFileBytes: 0 };
  await inspectTree(artifactRoot, '.', actual, heldRoot, policy, budget, dependencies);
  actual.sort((a, b) => compare(a.path, b.path));
  const actualManifestBytes = encodeSnapshotManifest({ schemaVersion: 1, entries: actual }, policy);
  if (!actualManifestBytes.equals(manifestBytes)) throw corrupt('artifact tree does not match manifest');
}

async function inspectTree(
  root: string,
  relativePath: string,
  entries: SnapshotEntry[],
  heldRoot: OpenPhysicalDirectory,
  policy: SkillSnapshotLimitPolicy,
  budget: TraversalBudget,
  dependencies: SkillSnapshotDependencies
): Promise<void> {
  await assertOpenDirectoryStable(heldRoot);
  const directoryPath = relativePath === '.' ? root : join(root, ...relativePath.split('/'));
  const identity = await physicalDirectoryIdentity(directoryPath, `artifact directory ${relativePath}`);
  assertMode(identity.mode, DIRECTORY_MODE, `artifact directory ${relativePath}`);
  const directory = await opendir(directoryPath);
  let operationError: unknown;
  try {
    let item;
    while ((item = await directory.read()) !== null) {
      const name = item.name;
      const absolute = join(directoryPath, name);
      const path = relativePath === '.' ? name : `${relativePath}/${name}`;
      const metadata = await lstat(absolute, { bigint: true });
      const aggregateBefore = consumeEntry(path, metadata, policy, budget, corrupt);
      if (metadata.isSymbolicLink()) throw corrupt(`artifact contains a symbolic link: ${path}`);
      const canonical = await realpath(absolute);
      if (!within(root, canonical)) throw corrupt(`artifact escapes its root: ${path}`);
      if (metadata.isDirectory()) {
        entries.push({ path, type: 'directory' });
        await inspectTree(root, path, entries, heldRoot, policy, budget, dependencies);
      } else if (metadata.isFile()) {
        const physical = await hashStablePhysicalFile(
          absolute,
          `artifact file ${path}`,
          fileSystemIdentity(metadata),
          streamByteLimit(policy, aggregateBefore!),
          dependencies
        );
        reconcileFileBudget(budget, aggregateBefore!, physical.byteCount, policy, path, corrupt);
        const isExecutable = executable(physical.mode);
        assertMode(physical.mode, isExecutable ? EXECUTABLE_FILE_MODE : FILE_MODE, `artifact file ${path}`);
        entries.push({ path, type: 'file', executable: isExecutable, sha256: physical.sha256 });
      } else {
        throw corrupt(`artifact contains an unsupported entry: ${path}`);
      }
    }
  } catch (error) {
    operationError = error;
  }
  const closeError = await closeDirectoryHandle(
    directory,
    directoryPath,
    'enumeration-directory',
    dependencies,
    corrupt
  );
  const directoryError = combineFailures(operationError, closeError, 'Artifact enumeration and close both failed');
  if (directoryError !== undefined) throw directoryError;
  await assertDirectoryIdentity(directoryPath, identity, `artifact directory ${relativePath}`);
  await assertOpenDirectoryStable(heldRoot);
}

interface FileSystemIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: number;
}
interface OpenPhysicalDirectory { path: string; handle: FileHandle; identity: FileSystemIdentity }

async function openPhysicalDirectory(
  path: string,
  label: string,
  target: SkillSnapshotHandleTarget,
  dependencies: SkillSnapshotDependencies
): Promise<OpenPhysicalDirectory> {
  let handle: FileHandle | undefined;
  let result: OpenPhysicalDirectory | undefined;
  let operationError: unknown;
  try {
    const before = await physicalDirectoryIdentity(path, label);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !samePhysicalIdentity(opened, before)) throw new Error('directory identity changed');
    result = { path, handle, identity: before };
    await assertOpenDirectoryStable(result);
  } catch (error) {
    operationError = corrupt(`${label} could not be opened as a stable physical directory`, error);
  }
  if (operationError !== undefined) {
    const closeError = await closeFileHandle(handle, target, path, dependencies, corrupt);
    const error = combineFailures(operationError, closeError, `${label} open and close both failed`);
    throw error!;
  }
  return result!;
}

async function assertOpenDirectoryStable(directory: OpenPhysicalDirectory): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !samePhysicalIdentity(opened, directory.identity)
    || !samePhysicalIdentity(current, directory.identity)) {
    throw corrupt(`${directory.path} directory identity changed`);
  }
}

async function physicalDirectoryIdentity(
  path: string,
  label: string,
  failure: (detail: string, cause?: unknown) => BazframeError = corrupt
): Promise<FileSystemIdentity> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('not a physical directory');
    return fileSystemIdentity(metadata);
  } catch (error) {
    throw failure(`${label} changed during inspection`, error);
  }
}

async function assertDirectoryIdentity(
  path: string,
  expected: FileSystemIdentity,
  label: string,
  failure: (detail: string, cause?: unknown) => BazframeError = corrupt
): Promise<void> {
  try {
    const actual = await lstat(path, { bigint: true });
    if (actual.isSymbolicLink() || !actual.isDirectory() || !samePhysicalIdentity(actual, expected)) {
      throw new Error('directory identity changed');
    }
  } catch (error) {
    throw failure(`${label} changed during inspection`, error);
  }
}

interface PhysicalFile { bytes: Buffer; mode: number }
interface HashedPhysicalFile { sha256: string; mode: number; byteCount: number }
interface StreamedBytes { byteCount: number; writtenBytes: number; exceeded: boolean }

async function readStablePhysicalFile(
  path: string,
  label: string,
  byteLimit: number,
  failure: (detail: string, cause?: unknown) => BazframeError,
  dependencies: SkillSnapshotDependencies
): Promise<PhysicalFile> {
  let handle: FileHandle | undefined;
  let result: PhysicalFile | undefined;
  let operationError: unknown;
  try {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
      throw new Error('not a singly-linked physical file');
    }
    if (before.size > BigInt(byteLimit)) throw failure(`${label} exceeds the ${byteLimit}-byte limit`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !samePhysicalIdentity(opened, fileSystemIdentity(before))) {
      throw new Error('file identity changed');
    }
    const bytes = await readAtMost(handle, byteLimit + 1);
    if (bytes.byteLength > byteLimit) throw failure(`${label} exceeds the ${byteLimit}-byte limit`);
    const final = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!final.isFile() || final.nlink !== 1n
      || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n
      || !samePhysicalIdentity(final, fileSystemIdentity(opened))
      || !samePhysicalIdentity(current, fileSystemIdentity(opened))
      || BigInt(bytes.byteLength) !== final.size) throw new Error('file identity changed');
    result = { bytes, mode: Number(opened.mode) };
  } catch (error) {
    operationError = error instanceof BazframeError ? error : failure(`${label} changed during inspection`, error);
  }
  const closeError = await closeFileHandle(handle, 'manifest-file', path, dependencies, failure);
  const error = combineFailures(operationError, closeError, `${label} read and close both failed`);
  if (error !== undefined) throw error;
  return result!;
}

async function copyStablePhysicalFile(
  sourcePath: string,
  destinationPath: string,
  label: string,
  dependencies: SkillSnapshotDependencies,
  expectedSource: FileSystemIdentity,
  byteLimit: number,
  destinationCreated: (identity: FileSystemIdentity) => void
): Promise<HashedPhysicalFile> {
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;
  let result: HashedPhysicalFile | undefined;
  let operationError: unknown;
  try {
    const before = await lstat(sourcePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || !samePhysicalIdentity(before, expectedSource)) {
      throw new Error('file identity changed');
    }
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await source.stat({ bigint: true });
    if (!opened.isFile() || !samePhysicalIdentity(opened, expectedSource)) throw new Error('file identity changed');
    if (opened.size > BigInt(byteLimit)) throw new Error(`exceeds the ${byteLimit}-byte applicable file limit`);
    const destinationMode = MODES_SUPPORTED
      ? (executable(Number(opened.mode)) ? EXECUTABLE_FILE_MODE : FILE_MODE)
      : 0o600;
    destination = await open(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      destinationMode
    );
    const destinationBefore = await destination.stat({ bigint: true });
    if (!destinationBefore.isFile() || destinationBefore.nlink !== 1n) {
      throw new Error('destination is not a singly-linked regular file');
    }
    destinationCreated(fileSystemIdentity(destinationBefore));
    await dependencies.duringSourceFileCopy?.(sourcePath);
    const hash = createHash('sha256');
    const copied = await copyAndHash(source, destination, destinationPath, hash, byteLimit, dependencies);
    await destination.sync();
    const [sourceAfter, sourceCurrent, destinationAfter, destinationCurrent] = await Promise.all([
      source.stat({ bigint: true }),
      lstat(sourcePath, { bigint: true }),
      destination.stat({ bigint: true }),
      lstat(destinationPath, { bigint: true })
    ]);
    if (!sourceAfter.isFile() || sourceCurrent.isSymbolicLink() || !sourceCurrent.isFile()
      || !samePhysicalIdentity(sourceAfter, fileSystemIdentity(opened))
      || !samePhysicalIdentity(sourceCurrent, fileSystemIdentity(opened))
      || BigInt(copied.byteCount) !== opened.size) throw new Error('source file identity changed');
    if (copied.exceeded) throw new Error(`source file exceeds the ${byteLimit}-byte applicable file limit`);
    if (!destinationAfter.isFile() || destinationAfter.nlink !== 1n
      || destinationCurrent.isSymbolicLink() || !destinationCurrent.isFile() || destinationCurrent.nlink !== 1n
      || destinationBefore.dev !== destinationAfter.dev || destinationBefore.ino !== destinationAfter.ino
      || !samePhysicalIdentity(destinationCurrent, fileSystemIdentity(destinationAfter))
      || destinationAfter.size !== BigInt(copied.writtenBytes)) {
      throw new Error('destination file identity changed');
    }
    if (MODES_SUPPORTED && (Number(destinationAfter.mode) & 0o777) !== destinationMode) {
      throw new Error('destination file mode is not the requested final mode');
    }
    result = {
      sha256: hash.digest('hex'),
      mode: Number(opened.mode),
      byteCount: copied.byteCount
    };
  } catch (error) {
    operationError = invalidEntry(`${label} changed during copy`, error);
  }
  const destinationClose = await closeFileHandle(
    destination,
    'destination-file',
    destinationPath,
    dependencies,
    invalidEntry
  );
  const sourceClose = await closeFileHandle(source, 'source-file', sourcePath, dependencies, invalidEntry);
  let error = combineFailures(operationError, destinationClose, `${label} and destination close both failed`);
  error = combineFailures(error, sourceClose, `${label} and source close both failed`);
  if (error !== undefined) throw error;
  return result!;
}

async function hashStablePhysicalFile(
  path: string,
  label: string,
  expected: FileSystemIdentity,
  byteLimit: number,
  dependencies: SkillSnapshotDependencies
): Promise<HashedPhysicalFile> {
  let handle: FileHandle | undefined;
  let result: HashedPhysicalFile | undefined;
  let operationError: unknown;
  try {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n
      || !samePhysicalIdentity(before, expected)) {
      throw new Error('file identity changed');
    }
    if (before.size > BigInt(byteLimit)) throw new Error(`exceeds the ${byteLimit}-byte applicable file limit`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !samePhysicalIdentity(opened, expected)) {
      throw new Error('file identity changed');
    }
    await dependencies.duringArtifactFileHash?.(path);
    const hash = createHash('sha256');
    const streamed = await hashFile(handle, hash, byteLimit);
    const final = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!final.isFile() || final.nlink !== 1n
      || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n
      || !samePhysicalIdentity(final, fileSystemIdentity(opened))
      || !samePhysicalIdentity(current, fileSystemIdentity(opened))
      || BigInt(streamed.byteCount) !== opened.size) throw new Error('file identity changed');
    if (streamed.exceeded) throw new Error(`file exceeds the ${byteLimit}-byte applicable file limit`);
    result = {
      sha256: hash.digest('hex'),
      mode: Number(opened.mode),
      byteCount: streamed.byteCount
    };
  } catch (error) {
    operationError = corrupt(`${label} changed during inspection`, error);
  }
  const closeError = await closeFileHandle(handle, 'source-file', path, dependencies, corrupt);
  const error = combineFailures(operationError, closeError, `${label} inspection and close both failed`);
  if (error !== undefined) throw error;
  return result!;
}

async function copyAndHash(
  source: FileHandle,
  destination: FileHandle,
  destinationPath: string,
  hash: Hash,
  byteLimit: number,
  dependencies: SkillSnapshotDependencies
): Promise<StreamedBytes> {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, byteLimit + 1));
  let total = 0;
  let writtenTotal = 0;
  while (true) {
    const remaining = byteLimit - total;
    const requestBytes = Math.min(buffer.byteLength, remaining + 1);
    const { bytesRead } = await source.read(buffer, 0, requestBytes, null);
    if (bytesRead === 0) return { byteCount: total, writtenBytes: writtenTotal, exceeded: false };
    const permittedBytes = Math.min(bytesRead, remaining);
    if (permittedBytes > 0) {
      hash.update(buffer.subarray(0, permittedBytes));
      let written = 0;
      while (written < permittedBytes) {
        const requested = permittedBytes - written;
        const bytesWritten = dependencies.destinationWrite === undefined
          ? (await destination.write(buffer, written, requested, null)).bytesWritten
          : await dependencies.destinationWrite(destinationPath, requested);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > requested) {
          throw new Error('destination write made zero or invalid progress');
        }
        written += bytesWritten;
        writtenTotal += bytesWritten;
      }
    }
    total += bytesRead;
    if (total > byteLimit) return { byteCount: total, writtenBytes: writtenTotal, exceeded: true };
  }
}

async function hashFile(handle: FileHandle, hash: Hash, byteLimit: number): Promise<StreamedBytes> {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, byteLimit + 1));
  let total = 0;
  while (true) {
    const remaining = byteLimit - total;
    const requestBytes = Math.min(buffer.byteLength, remaining + 1);
    const { bytesRead } = await handle.read(buffer, 0, requestBytes, null);
    if (bytesRead === 0) return { byteCount: total, writtenBytes: 0, exceeded: false };
    const permittedBytes = Math.min(bytesRead, remaining);
    if (permittedBytes > 0) hash.update(buffer.subarray(0, permittedBytes));
    total += bytesRead;
    if (total > byteLimit) return { byteCount: total, writtenBytes: 0, exceeded: true };
  }
}

async function readAtMost(handle: FileHandle, byteLimit: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(byteLimit);
  let offset = 0;
  while (offset < result.byteLength) {
    const { bytesRead } = await handle.read(result, offset, result.byteLength - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return result.subarray(0, offset);
}

async function writePhysicalFile(
  path: string,
  bytes: Uint8Array,
  dependencies: SkillSnapshotDependencies,
  created: (identity: FileSystemIdentity) => void
): Promise<void> {
  let handle: FileHandle | undefined;
  let operationError: unknown;
  try {
    const requestedMode = MODES_SUPPORTED ? FILE_MODE : 0o600;
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, requestedMode);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('manifest is not a singly-linked regular file');
    created(fileSystemIdentity(before));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const requested = bytes.byteLength - offset;
      const bytesWritten = dependencies.destinationWrite === undefined
        ? (await handle.write(bytes, offset, requested, null)).bytesWritten
        : await dependencies.destinationWrite(path, requested);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > requested) {
        throw new Error('destination write made zero or invalid progress');
      }
      offset += bytesWritten;
    }
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n
      || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n
      || before.dev !== after.dev || before.ino !== after.ino
      || !samePhysicalIdentity(current, fileSystemIdentity(after))
      || after.size !== BigInt(bytes.byteLength)) {
      throw new Error('manifest file identity changed');
    }
    if (MODES_SUPPORTED && (Number(after.mode) & 0o777) !== requestedMode) {
      throw new Error('manifest mode is not the requested final mode');
    }
  } catch (error) {
    operationError = invalidEntry('Snapshot manifest write failed', error);
  }
  const closeError = await closeFileHandle(handle, 'manifest-file', path, dependencies, invalidEntry);
  const error = combineFailures(operationError, closeError, 'Snapshot manifest write and close both failed');
  if (error !== undefined) throw error;
}

async function closeFileHandle(
  handle: FileHandle | undefined,
  target: SkillSnapshotHandleTarget,
  path: string,
  dependencies: SkillSnapshotDependencies,
  failure: (detail: string, cause?: unknown) => BazframeError
): Promise<unknown> {
  if (handle === undefined) return undefined;
  try {
    await handle.close();
    await dependencies.afterHandleClose?.(target, path);
    return undefined;
  } catch (error) {
    return failure(`Could not close ${target}: ${path}`, error);
  }
}

async function closeDirectoryHandle(
  directory: Awaited<ReturnType<typeof opendir>>,
  path: string,
  target: SkillSnapshotHandleTarget,
  dependencies: SkillSnapshotDependencies,
  failure: (detail: string, cause?: unknown) => BazframeError
): Promise<unknown> {
  try {
    await directory.close();
    await dependencies.afterHandleClose?.(target, path);
    return undefined;
  } catch (error) {
    return failure(`Could not close ${target}: ${path}`, error);
  }
}

async function closeHeldDirectory(
  directory: OpenPhysicalDirectory | undefined,
  target: SkillSnapshotHandleTarget,
  dependencies: SkillSnapshotDependencies
): Promise<unknown> {
  return closeFileHandle(directory?.handle, target, directory?.path ?? '<unopened>', dependencies, corrupt);
}

function combineFailures(primary: unknown, secondary: unknown, message: string): unknown {
  if (primary === undefined) return secondary;
  if (secondary === undefined) return primary;
  return new AggregateError([primary, secondary], message, { cause: primary });
}

function ownedEntry(type: OwnedStagingEntry['type'], identity: FileSystemIdentity): OwnedStagingEntry {
  return { type, device: identity.device, inode: identity.inode };
}

async function createOwnedStagingDirectory(
  path: string,
  relativePath: string,
  owned: OwnedStagingTree
): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  let operationError: unknown;
  try {
    await recordOwnedEntry(owned, relativePath, path, 'directory');
    const expected = requireOwnedEntry(owned, relativePath);
    const metadata = await lstat(path, { bigint: true });
    if (!matchesOwnedEntry(metadata, expected)
      || (MODES_SUPPORTED && (Number(metadata.mode) & 0o777) !== 0o700)) {
      throw invalidEntry(`New staged directory does not have the required private mode: ${relativePath}`);
    }
    return;
  } catch (error) {
    operationError = error;
  }

  const expected = owned.get(relativePath);
  if (expected !== undefined) {
    try {
      await removeOwnedEmptyDirectory(path, expected);
      owned.delete(relativePath);
    } catch (cleanupError) {
      operationError = combineFailures(
        operationError,
        cleanupError,
        'Staged directory creation and empty-directory cleanup both failed'
      );
    }
  }
  throw operationError;
}

async function removeOwnedEmptyDirectory(path: string, expected: OwnedStagingEntry): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (expected.type !== 'directory' || !matchesOwnedEntry(current, expected)) {
    throw corrupt(`new staged directory identity changed before removal: ${path}`);
  }
  await rmdir(path);
}

async function recordOwnedEntry(
  owned: OwnedStagingTree,
  relativePath: string,
  path: string,
  type: OwnedStagingEntry['type']
): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink()
    || (type === 'directory' ? !metadata.isDirectory() : !metadata.isFile())) {
    throw corrupt(`new staging ${type} changed before its identity was recorded`);
  }
  owned.set(relativePath, ownedEntry(type, fileSystemIdentity(metadata)));
}

function requireOwnedEntry(owned: OwnedStagingTree, relativePath: string): OwnedStagingEntry {
  const entry = owned.get(relativePath);
  if (entry === undefined) throw corrupt(`staging ownership is missing for ${relativePath}`);
  return entry;
}

function matchesOwnedEntry(
  metadata: {
    dev: bigint;
    ino: bigint;
    nlink: bigint;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  },
  expected: OwnedStagingEntry
): boolean {
  return !metadata.isSymbolicLink()
    && metadata.dev === expected.device
    && metadata.ino === expected.inode
    && (expected.type === 'directory' ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1n);
}

async function normalizeOwnedDirectory(
  path: string,
  expected: OwnedStagingEntry,
  dependencies: SkillSnapshotDependencies
): Promise<void> {
  const directory = await openOwnedDirectory(path, expected, DIRECTORY_MODE, dependencies);
  const closeError = await closeHeldDirectory(directory, 'cleanup-directory', dependencies);
  if (closeError !== undefined) throw closeError;
}

async function setOwnedDirectoryMode(
  path: string,
  expected: OwnedStagingEntry,
  mode: number,
  dependencies: SkillSnapshotDependencies
): Promise<void> {
  const directory = await openOwnedDirectory(path, expected, mode, dependencies);
  const closeError = await closeHeldDirectory(directory, 'cleanup-directory', dependencies);
  if (closeError !== undefined) throw closeError;
}

async function cleanupOwnedStagingTree(
  root: string,
  policy: SkillSnapshotLimitPolicy,
  dependencies: SkillSnapshotDependencies,
  owned: OwnedStagingTree
): Promise<void> {
  await makeTreeWritable(root, policy, dependencies, owned);
  let current;
  try {
    current = await lstat(root, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const expectedRoot = requireOwnedEntry(owned, '.');
  if (expectedRoot.type !== 'directory' || !matchesOwnedEntry(current, expectedRoot)) {
    throw corrupt('snapshot cleanup root identity changed before recursive removal');
  }
  await rm(root, { recursive: true, force: true });
}

async function makeTreeWritable(
  root: string,
  policy: SkillSnapshotLimitPolicy,
  dependencies: SkillSnapshotDependencies,
  owned: OwnedStagingTree
): Promise<void> {
  let metadata;
  try { metadata = await lstat(root, { bigint: true }); }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
  const expectedRoot = requireOwnedEntry(owned, '.');
  if (!matchesOwnedEntry(metadata, expectedRoot) || expectedRoot.type !== 'directory') {
    throw corrupt('snapshot cleanup root is not the owned physical directory');
  }
  const budget: TraversalBudget = { entries: 1, aggregateFileBytes: 0 };
  const observed = new Set<string>(['.']);
  await prepareOwnedDirectoryForCleanup(root, '.', policy, budget, dependencies, owned, observed);
  if (observed.size !== owned.size) throw corrupt('snapshot cleanup is missing an owned entry');
}

async function prepareOwnedDirectoryForCleanup(
  directoryPath: string,
  relativePath: string,
  policy: SkillSnapshotLimitPolicy,
  budget: TraversalBudget,
  dependencies: SkillSnapshotDependencies,
  owned: OwnedStagingTree,
  observed: Set<string>
): Promise<void> {
  const expectedDirectory = requireOwnedEntry(owned, relativePath);
  if (expectedDirectory.type !== 'directory') throw corrupt(`snapshot cleanup expected a directory: ${relativePath}`);
  const held = await openOwnedDirectory(directoryPath, expectedDirectory, 0o700, dependencies);
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  let operationError: unknown;
  try {
    directory = await opendir(directoryPath);
    await assertOpenDirectoryStable(held);
    let item;
    let rootEntries = 0;
    while ((item = await directory.read()) !== null) {
      const path = relativePath === '.' ? item.name : `${relativePath}/${item.name}`;
      const absolute = join(directoryPath, item.name);
      const expected = owned.get(path);
      if (expected === undefined) throw corrupt(`snapshot cleanup contains an unknown entry: ${path}`);
      const child = await lstat(absolute, { bigint: true });
      if (!matchesOwnedEntry(child, expected)) throw corrupt(`snapshot cleanup entry identity changed: ${path}`);
      observed.add(path);
      if (relativePath === '.') {
        rootEntries += 1;
        if (rootEntries > 2 || (path !== 'artifact' && path !== 'manifest.json')) {
          throw corrupt('snapshot cleanup root contains unexpected entries');
        }
        if (path === 'manifest.json' && child.size > BigInt(policy.maxManifestBytes)) {
          throw corrupt(`snapshot cleanup manifest exceeds the ${policy.maxManifestBytes}-byte limit`);
        }
      } else {
        const artifactPath = path.slice('artifact/'.length);
        consumeCleanupEntry(artifactPath, child, policy, budget);
      }
      if (expected.type === 'directory') {
        await prepareOwnedDirectoryForCleanup(absolute, path, policy, budget, dependencies, owned, observed);
      }
      // Owned regular files are only unlinked by the final recursive removal. Their modes are never changed.
    }
    await assertOpenDirectoryStable(held);
  } catch (error) {
    operationError = error;
  }
  const streamClose = directory === undefined
    ? undefined
    : await closeDirectoryHandle(directory, directoryPath, 'cleanup-directory', dependencies, corrupt);
  const heldClose = await closeHeldDirectory(held, 'cleanup-directory', dependencies);
  let failure = combineFailures(operationError, streamClose, 'Snapshot cleanup traversal and close both failed');
  failure = combineFailures(failure, heldClose, 'Snapshot cleanup traversal and held close both failed');
  if (failure !== undefined) throw failure;
}

async function openOwnedDirectory(
  path: string,
  expected: OwnedStagingEntry,
  mode: number,
  dependencies: SkillSnapshotDependencies
): Promise<OpenPhysicalDirectory> {
  if (expected.type !== 'directory') throw corrupt(`snapshot cleanup ownership type is invalid: ${path}`);
  const directory = await openPhysicalDirectory(path, 'owned staging directory', 'cleanup-directory', dependencies);
  let operationError: unknown;
  try {
    if (directory.identity.device !== expected.device || directory.identity.inode !== expected.inode) {
      throw new Error('owned directory identity changed');
    }
    await directory.handle.chmod(mode);
    const [opened, current] = await Promise.all([
      directory.handle.stat({ bigint: true }),
      lstat(path, { bigint: true })
    ]);
    if (!opened.isDirectory() || !matchesOwnedEntry(current, expected)
      || opened.dev !== expected.device || opened.ino !== expected.inode
      || !samePhysicalIdentity(current, fileSystemIdentity(opened))) {
      throw new Error('owned directory identity changed while setting its mode');
    }
    if (MODES_SUPPORTED && (Number(opened.mode) & 0o777) !== mode) {
      throw new Error('owned directory mode was not set exactly');
    }
    directory.identity = fileSystemIdentity(opened);
  } catch (error) {
    operationError = corrupt('owned staging directory could not be normalized through its held handle', error);
  }
  if (operationError !== undefined) {
    const closeError = await closeHeldDirectory(directory, 'cleanup-directory', dependencies);
    const failure = combineFailures(operationError, closeError, 'Owned directory normalization and close both failed');
    throw failure!;
  }
  return directory;
}

async function enumerateNames(
  path: string,
  limit: number,
  dependencies: SkillSnapshotDependencies
): Promise<string[]> {
  const names: string[] = [];
  const directory = await opendir(path);
  let operationError: unknown;
  try {
    let item;
    while ((item = await directory.read()) !== null) {
      names.push(item.name);
      if (names.length > limit) throw corrupt(`directory contains more than ${limit} entries`);
    }
  } catch (error) {
    operationError = error;
  }
  const closeError = await closeDirectoryHandle(directory, path, 'enumeration-directory', dependencies, corrupt);
  const error = combineFailures(operationError, closeError, 'Directory enumeration and close both failed');
  if (error !== undefined) throw error;
  return names;
}

function consumeEntry(
  path: string,
  metadata: { isFile(): boolean; size: bigint },
  policy: SkillSnapshotLimitPolicy,
  budget: TraversalBudget,
  failure: (detail: string, cause?: unknown) => BazframeError
): number | undefined {
  assertPathLimits(path, policy, failure);
  budget.entries += 1;
  if (budget.entries > policy.maxEntries) throw failure(`tree entries exceed the ${policy.maxEntries}-entry limit`);
  if (!metadata.isFile()) return undefined;
  if (metadata.size > BigInt(policy.maxFileBytes)) throw failure(`file exceeds the ${policy.maxFileBytes}-byte limit: ${path}`);
  const aggregate = BigInt(budget.aggregateFileBytes) + metadata.size;
  if (aggregate > BigInt(policy.maxAggregateFileBytes)) {
    throw failure(`tree files exceed the ${policy.maxAggregateFileBytes}-byte aggregate limit`);
  }
  return budget.aggregateFileBytes;
}

function streamByteLimit(policy: SkillSnapshotLimitPolicy, aggregateBefore: number): number {
  return Math.min(policy.maxFileBytes, policy.maxAggregateFileBytes - aggregateBefore);
}

function reconcileFileBudget(
  budget: TraversalBudget,
  aggregateBefore: number,
  actualBytes: number,
  policy: SkillSnapshotLimitPolicy,
  path: string,
  failure: (detail: string, cause?: unknown) => BazframeError
): void {
  const applicableLimit = streamByteLimit(policy, aggregateBefore);
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > applicableLimit) {
    throw failure(`streamed file exceeds its ${applicableLimit}-byte applicable limit: ${path}`);
  }
  budget.aggregateFileBytes = aggregateBefore + actualBytes;
}

function consumeCleanupEntry(
  path: string,
  metadata: { isFile(): boolean; size: bigint },
  policy: SkillSnapshotLimitPolicy,
  budget: TraversalBudget
): void {
  const aggregateBefore = consumeEntry(path, metadata, policy, budget, corrupt);
  if (aggregateBefore !== undefined) {
    budget.aggregateFileBytes = aggregateBefore + Number(metadata.size);
  }
}

function assertPathLimits(
  path: string,
  policy: SkillSnapshotLimitPolicy,
  failure: (detail: string, cause?: unknown) => BazframeError
): void {
  const pathBytes = Buffer.byteLength(path, 'utf8');
  if (pathBytes > policy.maxPathBytes) throw failure(`entry path exceeds the ${policy.maxPathBytes}-byte limit`);
  const depth = path === '.' ? 0 : path.split('/').length;
  if (depth > policy.maxDepth) throw failure(`entry depth exceeds the ${policy.maxDepth}-level limit`);
}

function copyLimitPolicy(policy: SkillSnapshotLimitPolicy | undefined): SkillSnapshotLimitPolicy {
  const input = policy ?? SKILL_SNAPSHOT_LIMITS;
  const copied: SkillSnapshotLimitPolicy = {
    maxManifestBytes: input.maxManifestBytes,
    maxEntries: input.maxEntries,
    maxDepth: input.maxDepth,
    maxPathBytes: input.maxPathBytes,
    maxFileBytes: input.maxFileBytes,
    maxAggregateFileBytes: input.maxAggregateFileBytes
  };
  for (const [key, value] of Object.entries(copied) as Array<[keyof SkillSnapshotLimitPolicy, number]>) {
    const minimum = key === 'maxDepth' || key === 'maxFileBytes' || key === 'maxAggregateFileBytes' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > SKILL_SNAPSHOT_LIMITS[key]) {
      throw new BazframeError(
        'SKILL_SNAPSHOT_LIMIT_POLICY_INVALID',
        `Skill snapshot ${key} must be an integer from ${minimum} through ${SKILL_SNAPSHOT_LIMITS[key]}.`
      );
    }
  }
  return copied;
}

function fileSystemIdentity(metadata: {
  dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint
}): FileSystemIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    mode: Number(metadata.mode)
  };
}

function samePhysicalIdentity(
  metadata: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  expected: FileSystemIdentity
): boolean {
  return metadata.dev === expected.device
    && metadata.ino === expected.inode
    && metadata.size === expected.size
    && metadata.mtimeNs === expected.mtimeNs
    && metadata.ctimeNs === expected.ctimeNs;
}

function assertMode(mode: number, expected: number, label: string): void {
  if (MODES_SUPPORTED && (mode & 0o777) !== expected) throw corrupt(`${label} mode is writable or otherwise invalid`);
}
function executable(mode: number): boolean { return MODES_SUPPORTED && (mode & 0o111) !== 0; }
async function physicalDirectory(path: string, label: string): Promise<string> { const metadata = await lstat(path); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazframeError('SKILL_COLLECTION_PATH_INVALID', `${label} must be a physical directory: ${path}`); const canonical = await realpath(path); if (!isAbsolute(canonical)) throw new BazframeError('SKILL_COLLECTION_PATH_INVALID', `${label} is invalid: ${path}`); return canonical; }
function within(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function compare(a: string, b: string): number { const left = [...a]; const right = [...b]; for (let index = 0; index < Math.min(left.length, right.length); index += 1) { const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!; if (difference !== 0) return difference; } return left.length - right.length; }
function corrupt(detail: string, cause?: unknown): BazframeError { return new BazframeError('SKILL_SNAPSHOT_CORRUPT', `Skill snapshot is corrupt: ${detail}.`, cause === undefined ? undefined : { cause }); }
function invalidEntry(detail: string, cause?: unknown): BazframeError { return new BazframeError('SKILL_SNAPSHOT_INVALID_ENTRY', `Invalid snapshot input: ${detail}.`, cause === undefined ? undefined : { cause }); }
function pathError(path: string, error: unknown): BazframeError { return new BazframeError('SKILL_COLLECTION_PATH_INVALID', `Could not resolve snapshot path ${path}${formatCode(error)}`, { cause: error }); }
async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
