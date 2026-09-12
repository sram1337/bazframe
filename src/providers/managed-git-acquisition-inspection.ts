import { sameResourceIdentity, resourceIdentityText, type ResourceIdentity } from '../skill-collections/resource-identity.js';

import { createHash } from 'node:crypto';

import { constants } from 'node:fs';

import { lstat as nativeLstat, open as nativeOpen, opendir as nativeOpendir, readlink as nativeReadlink } from 'node:fs/promises';

import { basename as nativeBasename, join as nativeJoin } from 'node:path';

import { BazframeError, errorCode } from '../core/errors.js';

import type { ManagedGitAcquisitionLimitPolicy } from '../profile-portability/profile-portability-policy.js';


export interface ManagedGitAcquisitionInspection {
  checkoutEntries: number;
  checkoutBytes: number;
  gitObjectBytes: number;
  stagingEntries: number;
  stagingBytes: number;
  fingerprint: string;
}


export interface ManagedGitAcquisitionInspectionTestHooks {
  afterFirstInspection?: () => void | Promise<void>;
}


export type ManagedGitAcquisitionContainerIdentity = ResourceIdentity;


interface Counters {
  checkoutEntries: bigint;
  checkoutBytes: bigint;
  gitObjectBytes: bigint;
  stagingEntries: bigint;
  stagingBytes: bigint;
  fingerprint: Buffer;
}


interface HeldDirectory {
  path: string;
  handle: FileHandle;
  identity: ResourceIdentity;
  mtimeNs: bigint;
  ctimeNs: bigint;
}
export interface GitInspectionMetadata {
 identity?: ResourceIdentity; dev?: bigint; ino?: bigint;
 size: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint;
 isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean;
}
interface FileHandle { stat(options: { bigint: true }): Promise<GitInspectionMetadata>; close(): Promise<void> }
export interface ManagedGitInspectionEffects {
 join(...parts: string[]): string; basename(path: string): string;
 stat(path: string, options?: { bigint: true }): Promise<GitInspectionMetadata>;
 open(path: string, flags: number): Promise<FileHandle>;
 opendir(path: string, maxEntries?: number): Promise<{ read(): Promise<{ name: string } | null>; close(): Promise<void> }>;
 /** Live monitoring only; never used for final inspection. POSIX opendir already has these semantics. */
 sampleOpendir?: ManagedGitInspectionEffects['opendir'];
 readlink(path: string): Promise<string>;
}
function objectIdentity(value: { identity?: ResourceIdentity; dev?: bigint; ino?: bigint }): ResourceIdentity {
 if (value.identity !== undefined) return value.identity;
 if (value.dev === undefined || value.ino === undefined) throw new BazframeError('MANAGED_GIT_ACQUISITION_INVALID', 'Physical Git identity is unavailable.');
 return { device: value.dev, inode: value.ino };
}

/** Shared acquisition inspection, including transient sampling and two-pass final proof. */
export function createManagedGitAcquisitionInspector(effects?: ManagedGitInspectionEffects) {
const join = effects?.join ?? nativeJoin;
const basename = effects?.basename ?? nativeBasename;
const lstat: ManagedGitInspectionEffects['stat'] = effects?.stat ?? ((path) => nativeLstat(path, { bigint: true }));
const open: ManagedGitInspectionEffects['open'] = effects?.open ?? nativeOpen;
const opendir: ManagedGitInspectionEffects['opendir'] = effects?.opendir ?? ((path) => nativeOpendir(path));
const readlink = effects?.readlink ?? nativeReadlink;
const sampleOpendir = effects?.sampleOpendir ?? opendir;


async function inspectManagedGitAcquisition(
  container: string,
  checkoutRoot: string,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  testHooks: ManagedGitAcquisitionInspectionTestHooks = {}
): Promise<ManagedGitAcquisitionInspection> {
  const first = await inspect(container, checkoutRoot, policy, true);
  await testHooks.afterFirstInspection?.();
  const second = await inspect(container, checkoutRoot, policy, true);
  if (!sameInspection(first, second)) throw changed(checkoutRoot);
  return second;
}


async function inspectManagedGitPublishedCheckout(
  checkoutRoot: string,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>
): Promise<ManagedGitAcquisitionInspection> {
  const first = await inspect(undefined, checkoutRoot, policy, false);
  const second = await inspect(undefined, checkoutRoot, policy, false);
  if (!sameInspection(first, second)) throw changed(checkoutRoot);
  return second;
}


/**
 * One tolerant, no-follow sample of an acquisition that may still be mutating.
 * This can reject an observed breach but is never final cleanliness/publication proof.
 */
async function sampleManagedGitAcquisitionInProgress(
  container: string,
  checkoutRoot: string,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  expectedContainer: ManagedGitAcquisitionContainerIdentity
): Promise<void> {
  const metadata = await lstat(container, { bigint: true }).catch((error: unknown) => {
    throw changed(container, error);
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || !sameResourceIdentity(objectIdentity(metadata), expectedContainer)) {
    throw changed(container);
  }
  let rootPresent = false;
  let containerStream: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    containerStream = await sampleOpendir(container, 2);
    while (true) {
      const entry = await containerStream.read();
      if (entry === null) break;
      if (rootPresent || entry.name !== basename(checkoutRoot)) {
        throw invalid('acquisition container contains unexpected entries while monitoring');
      }
      rootPresent = true;
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw changed(container, error);
    throw error;
  } finally {
    await containerStream?.close().catch(() => undefined);
  }
  if (!rootPresent) return;
  const counters: Counters = {
    checkoutEntries: 1n,
    checkoutBytes: 0n,
    gitObjectBytes: 0n,
    stagingEntries: 1n,
    stagingBytes: 0n,
    fingerprint: Buffer.alloc(32)
  };
  if (counters.checkoutEntries > BigInt(policy.maxCheckoutEntries)) limit('checkout entries', policy.maxCheckoutEntries);
  if (counters.stagingEntries > BigInt(policy.maxStagingEntries)) limit('staging entries', policy.maxStagingEntries);
  await sampleMutableDirectory(checkoutRoot, '', 'checkout', 0, policy, counters);
  const final = await lstat(container, { bigint: true }).catch((error: unknown) => { throw changed(container, error); });
  if (final.isSymbolicLink() || !final.isDirectory()
    || !sameResourceIdentity(objectIdentity(final), expectedContainer)) {
    throw changed(container);
  }
}


async function sampleMutableDirectory(
  directory: string,
  relativeDirectory: string,
  category: 'checkout' | 'git' | 'objects',
  depth: number,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  counters: Counters
): Promise<void> {
  let directoryMetadata;
  try { directoryMetadata = await lstat(directory, { bigint: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw invalid(`acquisition directory must remain physical while monitoring: ${relativeDirectory || '.'}`);
  }
  let stream: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    stream = await sampleOpendir(directory, policy.maxStagingEntries);
    while (true) {
      const entry = await stream.read();
      if (entry === null) break;
      const childRelative = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (asciiCaseFold(entry.name) === '.git' && childRelative !== '.git') {
        throw invalid(`nested Git metadata is not supported: ${childRelative}`);
      }
      const folded = asciiCaseFold(childRelative);
      const childCategory = category === 'checkout' && folded === '.git'
        ? 'git'
        : category === 'git' && folded === '.git/objects'
          ? 'objects'
          : category;
      await sampleMutableEntry(join(directory, entry.name), childRelative, childCategory, depth + 1, policy, counters);
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  } finally {
    await stream?.close().catch(() => undefined);
  }
}


async function sampleMutableEntry(
  path: string,
  relativePath: string,
  category: 'checkout' | 'git' | 'objects',
  depth: number,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  counters: Counters
): Promise<void> {
  let metadata;
  try { metadata = await lstat(path, { bigint: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const pathBytes = Buffer.byteLength(relativePath, 'utf8');
  addStagingEntry(depth, pathBytes, policy, counters);
  if (category === 'checkout' && pathBytes > policy.maxCheckoutPathBytes) limit('checkout relative path bytes', policy.maxCheckoutPathBytes);
  if (category !== 'checkout' && isUnsupportedGitMetadataPath(relativePath)) {
    throw invalid(`Git metadata indirection or nested repository state is not supported: ${relativePath}`);
  }
  const isMetadata = category !== 'checkout';
  if (metadata.isSymbolicLink()) {
    if (isMetadata) {
      let target: string;
      try { target = await readlink(path); }
      catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
      if (!isGitSymlinkCapabilityProbe(relativePath, target)) {
        throw invalid(`Git metadata must not contain symbolic links: ${relativePath}`);
      }
      return;
    }
    addCheckoutEntry(depth, policy, counters);
    return;
  }
  if (metadata.isDirectory()) {
    if (!isMetadata) addCheckoutEntry(depth, policy, counters);
    await sampleMutableDirectory(path, relativePath, category, depth, policy, counters);
    return;
  }
  if (!metadata.isFile()) throw invalid(`acquisition contains a special file: ${relativePath}`);
  if (relativePath === '.git') throw invalid('checkout .git must be a physical directory');
  // Git may briefly hard-link metadata during lock-and-rename operations. The live
  // sample still counts the observed bytes; the authoritative stable inspection
  // rejects every remaining metadata hard link before activation.
  if (metadata.nlink !== 1n && !isMetadata) {
    throw invalid(`acquisition regular files must not have hard links: ${relativePath}`);
  }
  if (!isMetadata) {
    addCheckoutEntry(depth, policy, counters);
    if (metadata.size > BigInt(policy.maxCheckoutFileBytes)) limit('checkout file bytes', policy.maxCheckoutFileBytes);
    counters.checkoutBytes += metadata.size;
    if (counters.checkoutBytes > BigInt(policy.maxCheckoutAggregateBytes)) limit('checkout aggregate bytes', policy.maxCheckoutAggregateBytes);
  }
  if (category === 'objects') {
    counters.gitObjectBytes += metadata.size;
    if (counters.gitObjectBytes > BigInt(policy.maxGitObjectBytes)) limit('Git object bytes', policy.maxGitObjectBytes);
  }
  counters.stagingBytes += metadata.size;
  if (counters.stagingBytes > BigInt(policy.maxStagingBytes)) limit('staging bytes', policy.maxStagingBytes);
}


function isGitSymlinkCapabilityProbe(relativePath: string, target: string): boolean {
  return /^\.git\/t[0-9A-Za-z]{6}$/u.test(relativePath) && target === 'testing';
}


async function inspect(
  container: string | undefined,
  checkoutRoot: string,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  requireExclusiveContainer: boolean
): Promise<ManagedGitAcquisitionInspection> {
  let containerDirectory: HeldDirectory | undefined;
  try {
    if (container !== undefined) {
      containerDirectory = await holdDirectory(container, 'acquisition container');
      const entry = await singleContainerEntry(containerDirectory);
      if (entry !== basename(checkoutRoot)) throw invalid(`acquisition container must contain exactly ${basename(checkoutRoot)}`);
    }
    const root = await holdDirectory(checkoutRoot, 'checkout root');
    try {
      if (policy.maxCheckoutEntries < 1) limit('checkout entries', policy.maxCheckoutEntries);
      if (policy.maxStagingEntries < 1) limit('staging entries', policy.maxStagingEntries);
      const counters: Counters = {
        checkoutEntries: 1n,
        checkoutBytes: 0n,
        gitObjectBytes: 0n,
        stagingEntries: 1n,
        stagingBytes: 0n,
        fingerprint: Buffer.alloc(32)
      };
      addEvidence(counters, 'root\0');
      await walkDirectory(root, '', 'checkout', 0, policy, counters);
      await assertDirectoryStable(root, 'checkout root');
      if (containerDirectory !== undefined) await assertDirectoryStable(containerDirectory, 'acquisition container');
      const result = resultFrom(counters);
      if (!requireExclusiveContainer && result.stagingBytes > policy.maxStagingBytes) limit('staging bytes', policy.maxStagingBytes);
      return result;
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  } finally {
    await containerDirectory?.handle.close().catch(() => undefined);
  }
}


async function singleContainerEntry(directory: HeldDirectory): Promise<string> {
  let stream: Awaited<ReturnType<typeof opendir>> | undefined;
  const names: string[] = [];
  let operationError: unknown;
  try {
    stream = await opendir(directory.path, 2);
    while (true) {
      const entry = await stream.read();
      if (entry === null) break;
      if (names.length === 1) throw invalid('acquisition container contains unexpected entries');
      names.push(entry.name);
    }
  } catch (error) { operationError = error; }
  if (stream !== undefined) {
    try { await stream.close(); } catch (error) { operationError ??= error; }
  }
  if (operationError !== undefined) throw operationError;
  await assertDirectoryStable(directory, 'acquisition container');
  if (names.length !== 1) throw invalid('acquisition container is incomplete');
  return names[0]!;
}


async function walkDirectory(
  directory: HeldDirectory,
  relativeDirectory: string,
  category: 'checkout' | 'git' | 'objects',
  depth: number,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  counters: Counters
): Promise<void> {
  await assertDirectoryStable(directory, relativeDirectory || 'checkout root');
  let stream: Awaited<ReturnType<typeof opendir>> | undefined;
  let operationError: unknown;
  try {
    stream = await opendir(directory.path, policy.maxStagingEntries);
    while (true) {
      const entry = await stream.read();
      if (entry === null) break;
      const childRelative = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (asciiCaseFold(entry.name) === '.git' && childRelative !== '.git') {
        throw invalid(`nested Git metadata is not supported: ${childRelative}`);
      }
      const childPath = join(directory.path, entry.name);
      const foldedChildRelative = asciiCaseFold(childRelative);
      const childCategory = category === 'checkout' && foldedChildRelative === '.git'
        ? 'git'
        : category === 'git' && foldedChildRelative === '.git/objects'
          ? 'objects'
          : category;
      await inspectEntry(childPath, childRelative, childCategory, depth + 1, policy, counters);
    }
  } catch (error) { operationError = error; }
  if (stream !== undefined) {
    try { await stream.close(); } catch (error) { operationError ??= error; }
  }
  if (operationError !== undefined) throw operationError;
  await assertDirectoryStable(directory, relativeDirectory || 'checkout root');
}


async function inspectEntry(
  path: string,
  relativePath: string,
  category: 'checkout' | 'git' | 'objects',
  depth: number,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  counters: Counters
): Promise<void> {
  const pathBytes = Buffer.byteLength(relativePath, 'utf8');
  addStagingEntry(depth, pathBytes, policy, counters);
  if (category === 'checkout' && pathBytes > policy.maxCheckoutPathBytes) limit('checkout relative path bytes', policy.maxCheckoutPathBytes);
  if (category !== 'checkout' && isUnsupportedGitMetadataPath(relativePath)) {
    throw invalid(`Git metadata indirection or nested repository state is not supported: ${relativePath}`);
  }
  let metadata;
  try { metadata = await lstat(path, { bigint: true }); }
  catch (error) { throw changed(path, error); }
  const isMetadata = category !== 'checkout';
  if (metadata.isSymbolicLink()) {
    if (isMetadata) throw invalid(`Git metadata must not contain symbolic links: ${relativePath}`);
    addCheckoutEntry(depth, policy, counters);
    const target = await readlink(path);
    addEvidence(counters, `l\0${relativePath}\0${resourceIdentityText(objectIdentity(metadata))}:${target}\0`);
    const current = await lstat(path, { bigint: true });
    if (!current.isSymbolicLink() || !sameResourceIdentity(objectIdentity(current), objectIdentity(metadata)) || await readlink(path) !== target) throw changed(path);
    return;
  }
  if (metadata.isDirectory()) {
    if (!isMetadata) addCheckoutEntry(depth, policy, counters);
    addEvidence(counters, `d\0${relativePath}\0${resourceIdentityText(objectIdentity(metadata))}:${metadata.mtimeNs}:${metadata.ctimeNs}\0`);
    const child = await holdDirectory(path, relativePath);
    try { await walkDirectory(child, relativePath, category, depth, policy, counters); }
    finally { await child.handle.close().catch(() => undefined); }
    return;
  }
  if (!metadata.isFile()) throw invalid(`acquisition contains a special file: ${relativePath}`);
  if (relativePath === '.git') throw invalid('checkout .git must be a physical directory');
  if (metadata.nlink !== 1n) throw invalid(`acquisition regular files must not have hard links: ${relativePath}`);
  if (!isMetadata) {
    addCheckoutEntry(depth, policy, counters);
    if (metadata.size > BigInt(policy.maxCheckoutFileBytes)) limit('checkout file bytes', policy.maxCheckoutFileBytes);
    counters.checkoutBytes += metadata.size;
    if (counters.checkoutBytes > BigInt(policy.maxCheckoutAggregateBytes)) limit('checkout aggregate bytes', policy.maxCheckoutAggregateBytes);
  }
  if (category === 'objects') {
    counters.gitObjectBytes += metadata.size;
    if (counters.gitObjectBytes > BigInt(policy.maxGitObjectBytes)) limit('Git object bytes', policy.maxGitObjectBytes);
  }
  counters.stagingBytes += metadata.size;
  if (counters.stagingBytes > BigInt(policy.maxStagingBytes)) limit('staging bytes', policy.maxStagingBytes);
  await assertStableFile(path, metadata);
  addEvidence(counters, `f\0${relativePath}\0${resourceIdentityText(objectIdentity(metadata))}:${metadata.nlink}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}\0`);
}


function addStagingEntry(
  depth: number,
  pathBytes: number,
  policy: Readonly<ManagedGitAcquisitionLimitPolicy>,
  counters: Counters
): void {
  if (depth > policy.maxStagingDepth) limit('staging depth', policy.maxStagingDepth);
  if (pathBytes > policy.maxStagingPathBytes) limit('staging relative path bytes', policy.maxStagingPathBytes);
  counters.stagingEntries += 1n;
  if (counters.stagingEntries > BigInt(policy.maxStagingEntries)) limit('staging entries', policy.maxStagingEntries);
}


function isUnsupportedGitMetadataPath(relativePath: string): boolean {
  const folded = asciiCaseFold(relativePath);
  return folded === '.git/commondir'
    || folded === '.git/gitdir'
    || folded === '.git/worktrees'
    || folded === '.git/modules'
    || folded === '.git/info/grafts'
    || folded === '.git/refs/replace'
    || folded === '.git/objects/info/alternates'
    || folded === '.git/objects/info/http-alternates';
}


function asciiCaseFold(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}


function addCheckoutEntry(depth: number, policy: Readonly<ManagedGitAcquisitionLimitPolicy>, counters: Counters): void {
  if (depth > policy.maxCheckoutDepth) limit('checkout depth', policy.maxCheckoutDepth);
  counters.checkoutEntries += 1n;
  if (counters.checkoutEntries > BigInt(policy.maxCheckoutEntries)) limit('checkout entries', policy.maxCheckoutEntries);
}


async function assertStableFile(path: string, expected: {
  identity?: ResourceIdentity;
  dev?: bigint;
  ino?: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()
      || !sameResourceIdentity(objectIdentity(opened), objectIdentity(expected))
      || !sameResourceIdentity(objectIdentity(current), objectIdentity(expected))
      || opened.nlink !== 1n || current.nlink !== 1n || opened.nlink !== expected.nlink || current.nlink !== expected.nlink
      || opened.size !== expected.size || current.size !== expected.size
      || opened.mtimeNs !== expected.mtimeNs || current.mtimeNs !== expected.mtimeNs
      || opened.ctimeNs !== expected.ctimeNs || current.ctimeNs !== expected.ctimeNs) throw changed(path);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw changed(path, error);
    throw error;
  } finally { await handle?.close(); }
}


async function holdDirectory(path: string, label: string): Promise<HeldDirectory> {
  let handle: FileHandle | undefined;
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid(`${label} must be a physical directory`);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameResourceIdentity(objectIdentity(opened), objectIdentity(metadata))
      || opened.mtimeNs !== metadata.mtimeNs || opened.ctimeNs !== metadata.ctimeNs) throw changed(path);
    const result = { path, handle, identity: objectIdentity(opened), mtimeNs: opened.mtimeNs, ctimeNs: opened.ctimeNs };
    handle = undefined;
    return result;
  } finally { await handle?.close().catch(() => undefined); }
}


async function assertDirectoryStable(directory: HeldDirectory, label: string): Promise<void> {
  const [opened, current] = await Promise.all([directory.handle.stat({ bigint: true }), lstat(directory.path, { bigint: true })]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || !sameResourceIdentity(objectIdentity(opened), directory.identity)
    || !sameResourceIdentity(objectIdentity(current), directory.identity)
    || opened.mtimeNs !== directory.mtimeNs || opened.ctimeNs !== directory.ctimeNs
    || current.mtimeNs !== directory.mtimeNs || current.ctimeNs !== directory.ctimeNs) throw changed(label);
}


function resultFrom(counters: Counters): ManagedGitAcquisitionInspection {
  return {
    checkoutEntries: Number(counters.checkoutEntries),
    checkoutBytes: Number(counters.checkoutBytes),
    gitObjectBytes: Number(counters.gitObjectBytes),
    stagingEntries: Number(counters.stagingEntries),
    stagingBytes: Number(counters.stagingBytes),
    fingerprint: counters.fingerprint.toString('hex')
  };
}


function addEvidence(counters: Counters, evidence: string): void {
  const digest = createHash('sha256').update(evidence).digest();
  for (let index = 0; index < counters.fingerprint.length; index += 1) counters.fingerprint[index] ^= digest[index]!;
}


function sameInspection(left: ManagedGitAcquisitionInspection, right: ManagedGitAcquisitionInspection): boolean {
  return left.checkoutEntries === right.checkoutEntries
    && left.checkoutBytes === right.checkoutBytes
    && left.gitObjectBytes === right.gitObjectBytes
    && left.stagingEntries === right.stagingEntries
    && left.stagingBytes === right.stagingBytes
    && left.fingerprint === right.fingerprint;
}


function limit(label: string, maximum: number): never {
  throw new BazframeError('MANAGED_GIT_ACQUISITION_LIMIT', `Remote Git acquisition exceeds the ${maximum} ${label} limit.`);
}

function invalid(detail: string): BazframeError {
  return new BazframeError('MANAGED_GIT_ACQUISITION_INVALID', `Remote Git acquisition is invalid: ${detail}.`);
}

function changed(path: string, cause?: unknown): BazframeError {
  return new BazframeError('MANAGED_GIT_ACQUISITION_CHANGED', `Remote Git acquisition changed while being inspected: ${path}`, cause === undefined ? {} : { cause });
}
return { inspectManagedGitAcquisition, inspectManagedGitPublishedCheckout, sampleManagedGitAcquisitionInProgress };
}
export const { inspectManagedGitAcquisition, inspectManagedGitPublishedCheckout, sampleManagedGitAcquisitionInProgress } = createManagedGitAcquisitionInspector();
