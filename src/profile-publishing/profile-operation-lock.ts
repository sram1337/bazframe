import { createHash, randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { link, lstat, open, opendir, rename, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { profilePublishingOperationLockRoot } from '../state/paths.js';

const TRANSACTION = /^[a-f0-9]{32}$/u;
const KEY = /^(?:@store|[A-Za-z0-9][A-Za-z0-9-]{0,63})$/u;
const LOCK_ENTRY = /^(?:[A-Za-z0-9_-]{22}|\.[ors]-[A-Za-z0-9_-]{19}|\.c[A-Za-z0-9_-]{9}\.[A-Za-z0-9_-]{10})$/u;
interface HeldOperationLock { path: string; ownerPath: string; server: Server; device: bigint; inode: bigint }
const records = new WeakMap<object, { home: string; keys: Set<string>; transactionId: string; active: boolean; held: HeldOperationLock[] }>();

export interface OperationMutationAuthority { readonly __operationMutationAuthority: unique symbol }

export async function tryWithProfileOperationLocks<T>(home: string, keys: readonly string[], operation: (authority: OperationMutationAuthority) => Promise<T>, transactionId = randomBytes(16).toString('hex')): Promise<{ kind: 'acquired'; value: T } | { kind: 'busy' }> {
  try { return { kind: 'acquired', value: await withProfileOperationLocks(home, keys, operation, transactionId) }; }
  catch (error) { if (error instanceof BazframeError && error.code === 'PROFILE_OPERATION_LOCK_BUSY') return { kind: 'busy' }; throw error; }
}

export async function withProfileOperationLocks<T>(home: string, keys: readonly string[], operation: (authority: OperationMutationAuthority) => Promise<T>, transactionId = randomBytes(16).toString('hex')): Promise<T> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new BazframeError('PROFILE_OPERATION_LOCK_PLATFORM_UNSUPPORTED', 'Profile operation locks require macOS or Linux.');
  const canonicalHome = resolve(home);
  const ordered = orderedProfileOperationKeys(keys, transactionId);
  const held: HeldOperationLock[] = [];
  const authority = {} as OperationMutationAuthority;
  let value: T | undefined;
  let operationError: unknown;
  try {
    for (const key of ordered) held.push(await acquire(canonicalHome, key));
    records.set(authority as object, { home: canonicalHome, keys: new Set(ordered), transactionId, active: true, held });
    value = await operation(authority);
  } catch (error) { operationError = error; }
  const record = records.get(authority as object); if (record !== undefined) record.active = false;
  let releaseError: unknown;
  for (const lock of held.reverse()) {
    try { await release(lock); } catch (error) { releaseError ??= error; }
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return value as T;
}

export function assertOperationMutationAuthority(authority: OperationMutationAuthority, home: string, requiredKeys: readonly string[], transactionId?: string): void {
  const record = records.get(authority as object);
  if (record === undefined || !record.active || record.home !== resolve(home) || requiredKeys.some((key) => !record.keys.has(key)) || (transactionId !== undefined && record.transactionId !== transactionId) || !heldLocksStillOwned(record.held)) throw new BazframeError('PROFILE_OPERATION_AUTHORITY_INVALID', 'Profile operation mutation authority is invalid or expired.');
}

export function operationAuthorityTransactionId(authority: OperationMutationAuthority): string {
  const record = records.get(authority as object); if (record === undefined || !record.active || !heldLocksStillOwned(record.held)) throw new BazframeError('PROFILE_OPERATION_AUTHORITY_INVALID', 'Profile operation mutation authority is invalid or expired.'); return record.transactionId;
}

export function profileOperationSocketPath(home: string, key: string): string {
  if (!isOperationKey(key)) throw invalid('lock key is invalid');
  // Base64url encodes 128 digest bits in the same basename width as private
  // owner sockets, so acquisition cannot bypass macOS' pathname ceiling only
  // to fail later while probing the canonical hard link.
  return join(profilePublishingOperationLockRoot(resolve(home)), createHash('sha256').update(key).digest('base64url').slice(0, 22));
}

async function acquire(home: string, key: string): Promise<HeldOperationLock> {
  const root = profilePublishingOperationLockRoot(home);
  const path = profileOperationSocketPath(home, key);
  // Owner and canonical basenames have the same byte width. Check both before
  // creating state or binding either endpoint so platform truncation cannot
  // surface as ENOENT.
  const ownerPath = join(root, `.o-${randomBytes(14).toString('base64url')}`);
  assertUnixSocketPathsSupported([path, ownerPath]);
  await ensureManagedDirectory(home, root);
  await cleanupStaleLockNamespace(root);
  const server = createServer();
  let ownerIdentity: { device: bigint; inode: bigint } | undefined;
  let claimPath: string | undefined;
  try {
    await listen(server, ownerPath);
    const owner = await lstat(ownerPath, { bigint: true });
    if (!owner.isSocket()) throw invalid('private lock endpoint is not a socket');
    ownerIdentity = { device: owner.dev, inode: owner.ino };
    try { await link(ownerPath, path); }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw mapListenError(error);
      // A live private claim guards the canonical-name gap while stale state is
      // quarantined. New acquirers inspect claims before receiving authority.
      claimPath = join(root, `${claimPrefix(path)}${randomBytes(7).toString('base64url')}`);
      await link(ownerPath, claimPath);
      await syncDirectory(root);
      const before = await lstat(path, { bigint: true });
      if (before.isSymbolicLink() || !before.isSocket()) throw invalid('occupied lock path is not a physical socket');
      if (await probe(path) === 'live') throw busy(key);
      const quarantine = join(root, `.s-${randomBytes(14).toString('base64url')}`);
      try { await rename(path, quarantine); }
      catch (renameError) { if (errorCode(renameError) === 'ENOENT') throw busy(key); throw renameError; }
      const moved = await lstat(quarantine, { bigint: true });
      // Another contender may have installed a live lock between our identity
      // read and rename. Restore the moved inode atomically when possible; in
      // every case, do not acquire from an observation about another inode.
      if (!moved.isSocket() || moved.dev !== before.dev || moved.ino !== before.ino || await probe(quarantine) === 'live') {
        await restoreCanonicalLink(quarantine, path);
        await unlink(quarantine).catch(() => undefined);
        throw busy(key);
      }
      await removeStaleSocketLinks(root, moved.dev, moved.ino);
      try { await link(ownerPath, path); }
      catch (retryError) { if (errorCode(retryError) === 'EEXIST') throw busy(key); throw mapListenError(retryError); }
    }
    await rejectCompetingClaims(root, path, claimPath);
    if (claimPath !== undefined) { await unlink(claimPath); claimPath = undefined; }
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isSocket() || metadata.dev !== owner.dev || metadata.ino !== owner.ino) throw busy(key);
    await syncDirectory(root);
    return { path, ownerPath, server, device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if (ownerIdentity !== undefined) await detachOwnedCanonical(root, path, ownerIdentity).catch(() => undefined);
    if (claimPath !== undefined) await unlink(claimPath).catch(() => undefined);
    await closeServer(server);
    const code=errorCode(error);
    throw code==='EINVAL'||code==='ENAMETOOLONG'?mapListenError(error):error;
  }
}

async function release(lock: HeldOperationLock): Promise<void> {
  const root = resolve(lock.path, '..');
  let cleanupError: unknown;
  try { await detachOwnedCanonical(root, lock.path, { device: lock.device, inode: lock.inode }); }
  catch (error) { if (errorCode(error) !== 'ENOENT') cleanupError = error; }
  finally { await closeServer(lock.server); }
  try { await syncDirectory(root); } catch (error) { cleanupError ??= error; }
  if (cleanupError !== undefined) throw cleanupError;
}

async function cleanupStaleLockNamespace(root: string): Promise<void> {
  const directory = await opendir(root);
  let count = 0;
  let changed = false;
  try {
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      count += 1;
      if (count > PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) throw invalid('operation lock namespace exceeds its bounded entry limit');
      if (!LOCK_ENTRY.test(entry.name)) throw invalid('operation lock namespace contains an unknown entry');
      const path = join(root, entry.name);
      const before = await lstat(path, { bigint: true });
      if (before.isSymbolicLink() || !before.isSocket()) throw invalid('operation lock namespace entry is not a physical socket');
      if (await probe(path) === 'live') continue;
      const after = await lstat(path, { bigint: true });
      if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) throw invalid('stale operation lock identity changed during cleanup');
      await unlink(path);
      changed = true;
    }
  } finally { await directory.close().catch(() => undefined); }
  if (changed) await syncDirectory(root);
}
async function detachOwnedCanonical(root: string, path: string, owner: { device: bigint; inode: bigint }): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (!current.isSocket() || current.dev !== owner.device || current.ino !== owner.inode) return;
  const releasePath = join(root, `.r-${randomBytes(14).toString('base64url')}`);
  await rename(path, releasePath);
  const moved = await lstat(releasePath, { bigint: true });
  if (moved.isSocket() && moved.dev === owner.device && moved.ino === owner.inode) await unlink(releasePath);
  else await restoreCanonicalLink(releasePath, path);
}
async function rejectCompetingClaims(root: string, path: string, ownClaim: string | undefined): Promise<void> {
  const prefix = claimPrefix(path);
  const directory = await opendir(root);
  let count = 0;
  try {
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      count += 1;
      if (count > PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) throw invalid('operation lock namespace exceeds its bounded entry limit');
      const claim = join(root, entry.name);
      if (!entry.name.startsWith(prefix) || claim === ownClaim) continue;
      const metadata = await lstat(claim, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isSocket()) throw invalid('operation lock claim is not a physical socket');
      if (await probe(claim) === 'live') throw busy(basename(path));
      const quarantine = join(root, `.s-${randomBytes(14).toString('base64url')}`);
      try {
        await rename(claim, quarantine);
        const moved = await lstat(quarantine, { bigint: true });
        if (!moved.isSocket() || moved.dev !== metadata.dev || moved.ino !== metadata.ino) throw invalid('stale lock claim identity changed during quarantine');
        await removeStaleSocketLinks(root, moved.dev, moved.ino);
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
  } finally { await directory.close().catch(() => undefined); }
}
function claimPrefix(path: string): string { return `.c${basename(path).slice(0, 9)}.`; }
async function removeStaleSocketLinks(root: string, device: bigint, inode: bigint): Promise<void> {
  const directory = await opendir(root);
  let count = 0;
  try {
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      count += 1;
      if (count > PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) throw invalid('operation lock namespace exceeds its bounded entry limit');
      const candidate = join(root, entry.name);
      let metadata;
      try { metadata = await lstat(candidate, { bigint: true }); }
      catch (error) { if (errorCode(error) === 'ENOENT') continue; throw error; }
      if (metadata.isSocket() && metadata.dev === device && metadata.ino === inode) await unlink(candidate).catch((error: unknown) => { if (errorCode(error) !== 'ENOENT') throw error; });
    }
  } finally { await directory.close().catch(() => undefined); }
}
async function restoreCanonicalLink(movedPath: string, canonicalPath: string): Promise<void> {
  try { await link(movedPath, canonicalPath); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
}
function listen(server: Server, path: string): Promise<void> { return new Promise((resolveListen, reject) => { const onError = (error: Error) => { server.off('listening', onListen); reject(error); }; const onListen = () => { server.off('error', onError); resolveListen(); }; server.once('error', onError); server.once('listening', onListen); server.listen(path); }); }
function probe(path: string): Promise<'live' | 'stale'> { return new Promise((resolveProbe, reject) => { const socket = createConnection(path); socket.once('connect', () => { socket.destroy(); resolveProbe('live'); }); socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolveProbe('stale'); else reject(error); }); }); }
function closeServer(server: Server): Promise<void> { return new Promise((resolveClose) => { if (!server.listening) { resolveClose(); return; } server.close(() => resolveClose()); }); }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
function assertUnixSocketPathsSupported(paths: readonly string[]): void {
  // sockaddr_un.sun_path is 108 bytes on Linux and 104 bytes on Darwin; one
  // byte is reserved for the trailing NUL terminator.
  const maximumBytes = process.platform === 'darwin' ? 103 : 107;
  if (paths.some((path) => Buffer.byteLength(path, 'utf8') > maximumBytes)) {
    throw new BazframeError('PROFILE_OPERATION_LOCK_PATH_UNSUPPORTED', 'Could not acquire profile operation lock.');
  }
}
function mapListenError(error: unknown): BazframeError { const code = errorCode(error); return new BazframeError(code === 'ENAMETOOLONG' || code === 'EINVAL' ? 'PROFILE_OPERATION_LOCK_PATH_UNSUPPORTED' : 'PROFILE_OPERATION_LOCK_FAILED', 'Could not acquire profile operation lock.', { cause: error }); }
function heldLocksStillOwned(held: readonly HeldOperationLock[]): boolean {
  try {
    return held.every((lock) => {
      const metadata = lstatSync(lock.path, { bigint: true });
      return metadata.isSocket() && metadata.dev === lock.device && metadata.ino === lock.inode && lock.server.listening;
    });
  } catch { return false; }
}
function isOperationKey(key: string): boolean { return key === '@store' || (KEY.test(key) && isSafeProfileId(key)); }
function busy(key: string): BazframeError { return new BazframeError('PROFILE_OPERATION_LOCK_BUSY', `Profile operation lock is busy for ${JSON.stringify(key)}.`); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_OPERATION_LOCK_INVALID', `Invalid profile operation lock: ${detail}.`); }

/** Shared logical key/transaction validation; physical lock representations remain platform-specific. */
export function orderedProfileOperationKeys(keys: readonly string[], transactionId: string): string[] {
  if (!TRANSACTION.test(transactionId)) throw invalid('transaction ID is invalid');
  const ordered = [...new Set(keys)];
  if (ordered.length === 0 || ordered.length !== keys.length || ordered.some((key) => !isOperationKey(key))) throw invalid('lock keys must be nonempty, unique, and canonical');
  return ordered.sort();
}
