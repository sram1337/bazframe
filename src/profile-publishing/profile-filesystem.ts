import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, rename, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { readAtMostOneBeyond } from '../state/bounded-file-read.js';

export interface PhysicalIdentity { device: bigint; inode: bigint }
export interface StableDirectory {
  path: string;
  trustedRoot: string;
  handle: FileHandle;
  identity: PhysicalIdentity;
  mtimeNs: bigint;
  ctimeNs: bigint;
  handlePath?: string;
}
export interface StableFile { bytes: Buffer; identity: PhysicalIdentity; executable: boolean }

export async function openStablePhysicalDirectory(path: string, trustedRoot = path): Promise<StableDirectory> {
  const absolute = resolve(path);
  const root = resolve(trustedRoot);
  await assertPhysicalAncestry(root, absolute);
  let metadata;
  try { metadata = await lstat(absolute, { bigint: true }); }
  catch (error) { throw filesystemError('PROFILE_PUBLISHING_DIRECTORY_INVALID', 'Could not inspect physical directory', absolute, error); }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw filesystemError('PROFILE_PUBLISHING_DIRECTORY_INVALID', 'Expected a physical directory', absolute);
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(identity(opened), identity(metadata))) throw new Error('identity changed');
    const handlePath = await usableHandlePath(handle.fd);
    const directory: StableDirectory = {
      path: absolute,
      trustedRoot: root,
      handle,
      identity: identity(opened),
      mtimeNs: opened.mtimeNs,
      ctimeNs: opened.ctimeNs,
      ...(handlePath === undefined ? {} : { handlePath })
    };
    await assertStablePhysicalDirectory(directory);
    return directory;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw filesystemError('PROFILE_PUBLISHING_DIRECTORY_CHANGED', 'Physical directory changed while opening', absolute, error);
  }
}

/** Handle-relative path. Fails closed where the supported OS exposes no directory-fd namespace. */
export function stableChildPath(directory: StableDirectory, name: string): string {
  const parts = safeChildParts(name, directory.path);
  if (directory.handlePath === undefined) {
    throw new BazframeError('PROFILE_PUBLISHING_HANDLE_PATH_UNAVAILABLE', 'Safe handle-relative filesystem access is unavailable for this directory.');
  }
  return join(directory.handlePath, ...parts);
}

/**
 * Mutation child path. Uses a directory-fd path where available; macOS falls
 * back to the validated physical pathname and therefore requires callers to
 * use random private staging plus pre/post directory-identity proofs.
 */
export function stableMutationChildPath(directory: StableDirectory, name: string): string {
  const parts = safeChildParts(name, directory.path);
  return join(directory.handlePath ?? directory.path, ...parts);
}

/** Read-only pathname fallback. Callers must re-prove the directory before and after the read. */
export function stableReadChildPath(directory: StableDirectory, name: string): string {
  return join(directory.path, ...safeChildParts(name, directory.path));
}

export async function assertStablePhysicalDirectory(directory: StableDirectory): Promise<void> {
  await assertPhysicalAncestry(directory.trustedRoot, directory.path);
  const [opened, current] = await Promise.all([directory.handle.stat({ bigint: true }), lstat(directory.path, { bigint: true })]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !sameIdentity(identity(opened), directory.identity) || !sameIdentity(identity(current), directory.identity)
    || opened.mtimeNs !== directory.mtimeNs || opened.ctimeNs !== directory.ctimeNs
    || current.mtimeNs !== directory.mtimeNs || current.ctimeNs !== directory.ctimeNs) {
    throw filesystemError('PROFILE_PUBLISHING_DIRECTORY_CHANGED', 'Physical directory changed while in use', directory.path);
  }
}

/** Use only after an intentional mutation of an owned unpublished directory. */
export async function assertPhysicalDirectoryIdentity(directory: StableDirectory): Promise<void> {
  await assertPhysicalAncestry(directory.trustedRoot, directory.path);
  const [opened, current] = await Promise.all([directory.handle.stat({ bigint: true }), lstat(directory.path, { bigint: true })]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !sameIdentity(identity(opened), directory.identity) || !sameIdentity(identity(current), directory.identity)) {
    throw filesystemError('PROFILE_PUBLISHING_DIRECTORY_CHANGED', 'Physical directory identity changed while in use', directory.path);
  }
}

export async function syncStableDirectory(directory: StableDirectory): Promise<void> {
  await directory.handle.sync();
  await assertPhysicalDirectoryIdentity(directory);
}

/** Writes only inside a Bazframe-created random, private, unpublished staging directory. */
export async function writeOwnedStagingFileAtomic(directory: StableDirectory, name: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
  await assertStablePhysicalDirectory(directory);
  const destination = stableReadChildPath(directory, name);
  const temporary = stableReadChildPath(directory, `.tmp-${randomBytes(16).toString('hex')}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, destination);
    await syncStableDirectory(directory);
  } catch (error) {
    throw filesystemError('PROFILE_PUBLISHING_FILE_WRITE_FAILED', 'Could not write owned staging file', directory.path, error);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function enumerateStableDirectory(directory: StableDirectory, maximum: number): Promise<string[]> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError('maximum must be a nonnegative safe integer');
  await assertStablePhysicalDirectory(directory);
  const base = directory.handlePath ?? directory.path;
  const first = (await readdir(base)).sort(compare);
  if (first.length > maximum) throw filesystemError('PROFILE_PUBLISHING_ENTRY_LIMIT', `Directory exceeds the ${maximum}-entry limit`, directory.path);
  const second = (await readdir(base)).sort(compare);
  if (first.length !== second.length || first.some((name, index) => name !== second[index])) throw filesystemError('PROFILE_PUBLISHING_DIRECTORY_CHANGED', 'Directory entries changed while enumerating', directory.path);
  await assertStablePhysicalDirectory(directory);
  return first;
}

export async function readStablePhysicalFile(path: string, maximum: number): Promise<StableFile> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) throw new Error('not a bounded regular file');
    const bytes = await readAtMostOneBeyond(handle, maximum);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (bytes.byteLength > maximum || current.isSymbolicLink() || !current.isFile() || !after.isFile()
      || !sameIdentity(identity(before), identity(after)) || !sameIdentity(identity(after), identity(current))
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs
      || BigInt(bytes.byteLength) !== after.size) throw new Error('file identity changed');
    return { bytes, identity: identity(before), executable: (Number(before.mode) & 0o111) !== 0 };
  } catch (error) { throw filesystemError('PROFILE_PUBLISHING_FILE_INVALID', 'Expected a stable bounded physical regular file', path, error); }
  finally { await handle?.close().catch(() => undefined); }
}

export async function readStablePhysicalLink(path: string): Promise<{ target: string; identity: PhysicalIdentity }> {
  try {
    const before = await lstat(path, { bigint: true }); if (!before.isSymbolicLink()) throw new Error('not a symbolic link');
    const target = await readlink(path); const after = await lstat(path, { bigint: true });
    if (!after.isSymbolicLink() || !sameIdentity(identity(before), identity(after)) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('link identity changed');
    return { target, identity: identity(before) };
  } catch (error) { throw filesystemError('PROFILE_PUBLISHING_LINK_INVALID', 'Expected a stable symbolic membership link', path, error); }
}

export async function assertPhysicalAncestry(trustedRoot: string, target: string): Promise<void> {
  const root = resolve(trustedRoot); const absolute = resolve(target); const suffix = relative(root, absolute);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw filesystemError('PROFILE_PUBLISHING_PATH_INVALID', 'Path escapes trusted root', absolute);
  const segments = suffix === '' ? [] : suffix.split(sep); let current = root;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = join(current, segments[index]!);
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw filesystemError('PROFILE_PUBLISHING_DIRECTORY_INVALID', 'Physical ancestry contains a link or non-directory', current);
  }
}

export function identityText(value: PhysicalIdentity): string { return `${value.device}:${value.inode}`; }
export function sameIdentity(left: PhysicalIdentity, right: PhysicalIdentity): boolean { return left.device === right.device && left.inode === right.inode; }
export function identity(metadata: { dev: bigint; ino: bigint }): PhysicalIdentity { return { device: metadata.dev, inode: metadata.ino }; }
export function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
export function isAbsent(error: unknown): boolean { return errorCode(error) === 'ENOENT'; }

function safeChildParts(name: string, path: string): string[] {
  if (name.length === 0 || isAbsolute(name) || name.includes('\0')) throw filesystemError('PROFILE_PUBLISHING_PATH_INVALID', 'Unsafe child path', path);
  const parts = name.split('/'); if (parts.some((part) => part === '' || part === '.' || part === '..')) throw filesystemError('PROFILE_PUBLISHING_PATH_INVALID', 'Unsafe child path', path);
  return parts;
}
async function usableHandlePath(fd: number): Promise<string | undefined> {
  const candidates = process.platform === 'linux' ? [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`] : [`/dev/fd/${fd}`];
  for (const candidate of candidates) { try { await readdir(candidate); return candidate; } catch { /* unavailable */ } }
  if (process.platform === 'darwin') return undefined;
  throw new BazframeError('PROFILE_PUBLISHING_HANDLE_PATH_UNAVAILABLE', 'This supported runtime does not expose a safe directory-handle path.');
}
function filesystemError(code: string, detail: string, path: string, cause?: unknown): BazframeError { return new BazframeError(code, `${detail}: ${path}.`, cause === undefined ? {} : { cause }); }
