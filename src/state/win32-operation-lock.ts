import { createHash, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { win32 } from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  BazframeWin32LockBackend,
  BazframeWin32NativeBackend,
  WindowsFileLockCapability,
  WindowsObjectObservation,
  WindowsPathInspection,
  WindowsSecurityObservation
} from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  admitWindowsPrivateDirectory,
  admitWindowsPrivateFile,
  createWindowsPrivateDirectory,
  createWindowsPrivateFile,
  isValidWindowsPathComponent
} from './win32-private-directory.js';

const OWNER_RECORD_BYTES = 4096;
const ACQUISITION_ID = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOWS_IDENTITY = /^[a-f0-9]{16}:[a-f0-9]{32}$/u;
const PROCESS_CREATION_TIME = /^[a-f0-9]{16}$/u;
const LOCK_COMPONENT = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const GUARD_NAME = 'guard';
const OWNER_NAME = 'owner';
const heldDirectories = new Set<string>();
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

export interface WindowsOperationLockDetails {
  command: string;
  target: string;
}

export type WindowsOperationLockRecovery =
  | 'none'
  | 'dead-owner'
  | 'incomplete-announcement';

export interface WindowsOperationLockAuthority {
  readonly recovery: WindowsOperationLockRecovery;
  assertHeld(): void;
}

export interface WindowsOperationLockIo {
  writeExistingFile(path: string, bytes: Uint8Array): Promise<void>;
}

export interface WindowsOperationLockHooks {
  afterKernelLockAcquired?(): void | Promise<void>;
  afterOwnerRecordProven?(): void | Promise<void>;
  beforeKernelRelease?(): void | Promise<void>;
}

export interface WindowsOperationLockOptions {
  backend: BazframeWin32NativeBackend & BazframeWin32LockBackend;
  lockRootPath: string;
  lockComponent: string;
  details: WindowsOperationLockDetails;
  now?: () => Date;
  acquisitionId?: () => string;
  io?: WindowsOperationLockIo;
  hooks?: WindowsOperationLockHooks;
}

interface OwnerRecordFields {
  schemaVersion: 1;
  kind: 'windows-operation-lock';
  lockContractVersion: 1;
  status: 'held' | 'released';
  acquisitionId: string;
  lockKeySha256: string;
  lockDirectoryIdentity: string;
  guardFileIdentity: string;
  ownerFileIdentity: string;
  pid: number;
  processCreationTime: string;
  createdAt: string;
  command: string;
  target: string;
}

interface OwnerRecord extends OwnerRecordFields {
  checksumSha256: string;
}

interface LockNamespace {
  root: WindowsPathInspection;
  directory: WindowsPathInspection;
  directoryPath: string;
  guardPath: string;
  guard: WindowsPathInspection;
  ownerPath: string;
  lockKeySha256: string;
  initializedFresh: boolean;
}

/** Internal Windows composition seam. It does not bypass the public platform gate. */
export async function withWindowsOperationLock<T>(
  options: WindowsOperationLockOptions,
  operation: (authority: WindowsOperationLockAuthority) => Promise<T>
): Promise<T> {
  validateOptions(options, operation);
  const namespace = await prepareNamespace(options);
  const registryKey = identity(namespace.directory);
  if (heldDirectories.has(registryKey)) {
    throw failure(
      'WINDOWS_OPERATION_LOCK_REENTRANT',
      'The Windows operation lock is already active in this process.'
    );
  }
  heldDirectories.add(registryKey);

  let capability: WindowsFileLockCapability | undefined;
  try {
    const acquisition = options.backend.acquireFileLock(namespace.guardPath);
    requireSamePrivateFile(acquisition.guardBefore, acquisition.guardAfter);
    const currentGuard = admitWindowsPrivateFile(options.backend, namespace.guardPath);
    requireSamePrivateFile(acquisition.guardAfter, currentGuard);

    if (acquisition.state === 'busy') {
      return await throwBusy(options.backend, namespace);
    }
    const heldCapability = acquisition.capability;
    capability = heldCapability;
    heldCapability.assertHeld();
    await options.hooks?.afterKernelLockAcquired?.();

    const beforeOwner = await inspectOwnerUnderAcquiredLock(options.backend, namespace);
    let recovery: WindowsOperationLockRecovery = 'none';
    if (beforeOwner.kind === 'malformed') {
      recovery = 'incomplete-announcement';
    } else if (beforeOwner.kind === 'absent') {
      recovery = namespace.initializedFresh ? 'none' : 'incomplete-announcement';
    } else {
      assertOwnerBinding(beforeOwner.record, namespace, beforeOwner.inspection);
      if (beforeOwner.record.status === 'held') {
        let processState;
        try {
          processState = options.backend.inspectProcessInstance({
            pid: beforeOwner.record.pid,
            creationTime: beforeOwner.record.processCreationTime
          });
        } catch (error) {
          throw failure(
            'WINDOWS_OPERATION_LOCK_ANNOUNCEMENT_AMBIGUOUS',
            'The previous Windows operation-lock owner could not be proved dead.',
            error
          );
        }
        if (processState.state === 'running') {
          throw failure(
            'WINDOWS_OPERATION_LOCK_ANNOUNCEMENT_AMBIGUOUS',
            'The previous Windows operation-lock owner is still running despite an acquired guard.'
          );
        }
        recovery = 'dead-owner';
      }
    }

    const ownerInspection = await ensureOwnerFile(options.backend, namespace);
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const acquisitionId = options.acquisitionId?.() ?? randomBytes(16).toString('hex');
    const fields: OwnerRecordFields = {
      schemaVersion: 1,
      kind: 'windows-operation-lock',
      lockContractVersion: 1,
      status: 'held',
      acquisitionId,
      lockKeySha256: namespace.lockKeySha256,
      lockDirectoryIdentity: identity(namespace.directory),
      guardFileIdentity: identity(currentGuard),
      ownerFileIdentity: identity(ownerInspection),
      pid: acquisition.currentProcess.pid,
      processCreationTime: acquisition.currentProcess.creationTime,
      createdAt,
      command: options.details.command,
      target: options.details.target
    };
    validateOwnerFields(fields);
    await writeAndProveOwner(
      options.backend,
      namespace,
      ownerInspection,
      fields,
      options.io ?? defaultIo
    );
    await options.hooks?.afterOwnerRecordProven?.();

    let active = true;
    const authority: WindowsOperationLockAuthority = Object.freeze({
      recovery,
      assertHeld(): void {
        if (!active || !heldDirectories.has(registryKey)) {
          throw failure(
            'WINDOWS_OPERATION_LOCK_AUTHORITY_INVALID',
            'The Windows operation-lock authority is no longer active.'
          );
        }
        heldCapability.assertHeld();
      }
    });

    let value: T | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await operation(authority);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    active = false;

    let releaseRecordFailed = false;
    let releaseRecordError: unknown;
    try {
      heldCapability.assertHeld();
      await writeAndProveOwner(options.backend, namespace, ownerInspection, {
        ...fields,
        status: 'released'
      }, options.io ?? defaultIo);
    } catch (error) {
      releaseRecordFailed = true;
      releaseRecordError = error;
    }

    let hookFailed = false;
    let hookError: unknown;
    try {
      await options.hooks?.beforeKernelRelease?.();
    } catch (error) {
      hookFailed = true;
      hookError = error;
    }

    let nativeReleaseFailed = false;
    let nativeReleaseError: unknown;
    try {
      heldCapability.release();
      capability = undefined;
    } catch (error) {
      capability = undefined;
      nativeReleaseFailed = true;
      nativeReleaseError = error;
    }

    if (releaseRecordFailed || hookFailed || nativeReleaseFailed) {
      throw failure(
        'WINDOWS_OPERATION_LOCK_RELEASE_AMBIGUOUS',
        'The Windows operation ended but its lock release could not be proved completely.',
        nativeReleaseFailed
          ? nativeReleaseError
          : hookFailed
            ? hookError
            : releaseRecordError
      );
    }
    if (operationFailed) throw operationError;
    return value as T;
  } finally {
    if (capability !== undefined) {
      try {
        capability.release();
      } catch {
        // The primary setup/operation failure remains authoritative. Native
        // release closes the retained handle even when explicit unlock fails.
      }
    }
    heldDirectories.delete(registryKey);
  }
}

async function prepareNamespace(options: WindowsOperationLockOptions): Promise<LockNamespace> {
  const root = admitWindowsPrivateDirectory(options.backend, options.lockRootPath);
  const directoryPath = win32.join(options.lockRootPath, options.lockComponent);
  let directory: WindowsPathInspection;
  let directoryCreated = false;
  try {
    directory = createWindowsPrivateDirectory(
      options.backend,
      options.lockRootPath,
      options.lockComponent
    );
    directoryCreated = true;
  } catch (error) {
    if (errorCode(error) !== 'WINDOWS_PRIVATE_DIRECTORY_OCCUPIED') throw error;
    directory = admitWindowsPrivateDirectory(options.backend, directoryPath);
  }
  requireDirectDirectory(root, directory, options.lockComponent);

  const initial = await listNamespace(options.backend, directoryPath);
  if (initial.has(OWNER_NAME) && !initial.has(GUARD_NAME)) {
    throw invalid('owner record exists without its persistent guard');
  }
  let guardCreated = false;
  if (!initial.has(GUARD_NAME)) {
    try {
      createWindowsPrivateFile(options.backend, directoryPath, GUARD_NAME);
      guardCreated = true;
    } catch (error) {
      if (errorCode(error) !== 'WINDOWS_PRIVATE_FILE_OCCUPIED') throw error;
    }
  }
  const guardPath = win32.join(directoryPath, GUARD_NAME);
  const guard = admitWindowsPrivateFile(options.backend, guardPath);
  if (guard.object.size !== '0000000000000000') {
    throw invalid('persistent guard is not empty');
  }
  const currentDirectory = admitWindowsPrivateDirectory(options.backend, directoryPath);
  requireSameDirectory(directory, currentDirectory);
  const lockKeySha256 = createHash('sha256')
    .update('bazframe-win32-operation-lock-key-v1\0')
    .update(identity(root))
    .update('\0')
    .update(options.lockComponent.normalize('NFC').toLowerCase())
    .digest('hex');
  return {
    root,
    directory: currentDirectory,
    directoryPath,
    guardPath,
    guard,
    ownerPath: win32.join(directoryPath, OWNER_NAME),
    lockKeySha256,
    initializedFresh: directoryCreated && guardCreated
  };
}

async function listNamespace(
  backend: BazframeWin32NativeBackend,
  directoryPath: string
): Promise<Map<string, WindowsObjectObservation>> {
  let receipt;
  try {
    receipt = await backend.enumerateStableDirectory(directoryPath, 2);
  } catch (error) {
    throw invalid('lock namespace could not be enumerated within its exact bound', error);
  }
  const entries = new Map<string, WindowsObjectObservation>();
  for (const entry of receipt.entries) {
    if ((entry.name !== GUARD_NAME && entry.name !== OWNER_NAME) || entry.directory
      || entry.reparseTag !== null) {
      throw invalid('lock namespace contains an unexpected entry');
    }
    if (entries.has(entry.name)) throw invalid('lock namespace contains a duplicate entry');
    entries.set(entry.name, {
      volumeIdentity: receipt.directoryAfter.object.volumeIdentity,
      fileId: entry.fileId,
      size: entry.size,
      allocationSize: entry.allocationSize,
      numberOfLinks: '00000001',
      creationTime: entry.creationTime,
      lastAccessTime: '0000000000000000',
      lastWriteTime: entry.lastWriteTime,
      changeTime: entry.changeTime,
      attributes: entry.attributes,
      reparseTag: entry.reparseTag,
      deletePending: false,
      directory: entry.directory
    });
  }
  return entries;
}

async function ensureOwnerFile(
  backend: BazframeWin32NativeBackend,
  namespace: LockNamespace
): Promise<WindowsPathInspection> {
  const entries = await listNamespace(backend, namespace.directoryPath);
  if (!entries.has(GUARD_NAME)) throw invalid('persistent guard disappeared while held');
  if (!entries.has(OWNER_NAME)) {
    try {
      createWindowsPrivateFile(backend, namespace.directoryPath, OWNER_NAME);
    } catch (error) {
      if (errorCode(error) !== 'WINDOWS_PRIVATE_FILE_OCCUPIED') throw error;
    }
  }
  const owner = admitWindowsPrivateFile(backend, namespace.ownerPath);
  const directory = admitWindowsPrivateDirectory(backend, namespace.directoryPath);
  requireSameDirectory(namespace.directory, directory);
  return owner;
}

async function inspectOwnerUnderAcquiredLock(
  backend: BazframeWin32NativeBackend,
  namespace: LockNamespace
): Promise<
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'valid'; record: OwnerRecord; inspection: WindowsPathInspection }
> {
  const entries = await listNamespace(backend, namespace.directoryPath);
  if (!entries.has(GUARD_NAME)) throw invalid('persistent guard disappeared while held');
  const listedOwner = entries.get(OWNER_NAME);
  if (listedOwner === undefined) return { kind: 'absent' };
  if (BigInt(`0x${listedOwner.size}`) > BigInt(OWNER_RECORD_BYTES)) {
    throw invalid('owner record exceeds the lock byte bound');
  }
  const { bytes, inspection } = await readOwner(backend, namespace.ownerPath);
  try {
    return { kind: 'valid', record: decodeOwner(bytes), inspection };
  } catch {
    return { kind: 'malformed' };
  }
}

async function throwBusy(
  backend: BazframeWin32NativeBackend & BazframeWin32LockBackend,
  namespace: LockNamespace
): Promise<never> {
  let current;
  try {
    current = await inspectOwnerUnderAcquiredLock(backend, namespace);
  } catch (error) {
    throw failure(
      'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS',
      'The Windows operation lock is busy and its owner announcement is unprovable.',
      error
    );
  }
  if (current.kind !== 'valid') {
    throw failure(
      'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS',
      'The Windows operation lock is busy and has no complete owner announcement.'
    );
  }
  try {
    assertOwnerBinding(current.record, namespace, current.inspection);
    if (current.record.status !== 'held') throw new Error('owner is not announced as held');
    const processState = backend.inspectProcessInstance({
      pid: current.record.pid,
      creationTime: current.record.processCreationTime
    });
    if (processState.state !== 'running') throw new Error('announced process is not running');
  } catch (error) {
    throw failure(
      'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS',
      'The Windows operation lock is busy but its announced owner is inconsistent.',
      error
    );
  }
  throw failure(
    'WINDOWS_OPERATION_LOCK_BUSY',
    `Bazframe state is busy: ${current.record.command} (PID ${current.record.pid}) holds the Windows operation lock for ${current.record.target}.`
  );
}

async function writeAndProveOwner(
  backend: BazframeWin32NativeBackend,
  namespace: LockNamespace,
  expectedOwner: WindowsPathInspection,
  fields: OwnerRecordFields,
  io: WindowsOperationLockIo
): Promise<void> {
  validateOwnerFields(fields);
  const bytes = encodeOwner(fields);
  const before = admitWindowsPrivateFile(backend, namespace.ownerPath);
  requireSamePrivateFile(expectedOwner, before, false);
  await io.writeExistingFile(namespace.ownerPath, bytes);
  const { bytes: observed, inspection } = await readOwner(backend, namespace.ownerPath);
  if (!observed.equals(bytes)) throw invalid('owner record read-back changed');
  requireSamePrivateFile(expectedOwner, inspection, false);
  const decoded = decodeOwner(observed);
  if (JSON.stringify(decoded) !== JSON.stringify(ownerRecord(fields))) {
    throw invalid('owner record did not decode to the intended value');
  }
  await proveNamespaceClosure(backend, namespace, decoded, observed.byteLength);
}

async function proveNamespaceClosure(
  backend: BazframeWin32NativeBackend,
  namespace: LockNamespace,
  record: OwnerRecord,
  ownerBytes: number
): Promise<void> {
  const entries = await listNamespace(backend, namespace.directoryPath);
  if (entries.size !== 2 || !entries.has(GUARD_NAME) || !entries.has(OWNER_NAME)) {
    throw invalid('lock namespace proof is incomplete');
  }
  const directory = admitWindowsPrivateDirectory(backend, namespace.directoryPath);
  requireSameDirectory(namespace.directory, directory);
  const guard = admitWindowsPrivateFile(backend, namespace.guardPath);
  const owner = admitWindowsPrivateFile(backend, namespace.ownerPath);
  const listedGuard = entries.get(GUARD_NAME)!;
  const listedOwner = entries.get(OWNER_NAME)!;
  if (guard.object.size !== '0000000000000000'
    || identity(guard) !== record.guardFileIdentity
    || listedGuard.fileId !== guard.object.fileId
    || listedGuard.size !== guard.object.size
    || owner.object.size !== ownerBytes.toString(16).padStart(16, '0')
    || identity(owner) !== record.ownerFileIdentity
    || listedOwner.fileId !== owner.object.fileId
    || listedOwner.size !== owner.object.size) {
    throw invalid('lock namespace proof does not match its owner record');
  }
}

async function readOwner(
  backend: BazframeWin32NativeBackend,
  ownerPath: string
): Promise<{ bytes: Buffer; inspection: WindowsPathInspection }> {
  const before = admitWindowsPrivateFile(backend, ownerPath);
  const receipt = await backend.readStableFile(ownerPath, OWNER_RECORD_BYTES);
  if (!sameObjectIgnoringAccessTime(before.object, receipt.before)
    || !sameObjectIgnoringAccessTime(receipt.before, receipt.after)) {
    throw invalid('owner record changed while read');
  }
  const after = admitWindowsPrivateFile(backend, ownerPath);
  requireSamePrivateFile(before, after);
  return { bytes: receipt.bytes, inspection: after };
}

function encodeOwner(fields: OwnerRecordFields): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(ownerRecord(fields))}\n`, 'utf8');
  if (bytes.byteLength > OWNER_RECORD_BYTES) {
    throw invalid('owner record exceeds the lock byte bound');
  }
  return bytes;
}

function ownerRecord(fields: OwnerRecordFields): OwnerRecord {
  return {
    ...fields,
    checksumSha256: createHash('sha256')
      .update('bazframe-win32-operation-lock-owner-v1\0')
      .update(JSON.stringify(fields))
      .digest('hex')
  };
}

function decodeOwner(bytes: Buffer): OwnerRecord {
  if (bytes.byteLength === 0 || bytes.byteLength > OWNER_RECORD_BYTES
    || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw invalid('owner record framing is invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(fatalUtf8.decode(bytes.subarray(0, -1)));
  } catch (error) {
    throw invalid('owner record JSON is invalid', error);
  }
  if (!isPlainRecord(value)) throw invalid('owner record is not an object');
  const keys = [
    'schemaVersion', 'kind', 'lockContractVersion', 'status', 'acquisitionId',
    'lockKeySha256', 'lockDirectoryIdentity', 'guardFileIdentity', 'ownerFileIdentity',
    'pid', 'processCreationTime', 'createdAt', 'command', 'target', 'checksumSha256'
  ];
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw invalid('owner record keys or canonical order are invalid');
  }
  const record = value as unknown as OwnerRecord;
  const { checksumSha256, ...fields } = record;
  validateOwnerFields(fields);
  if (!SHA256.test(checksumSha256)
    || ownerRecord(fields).checksumSha256 !== checksumSha256
    || !Buffer.from(`${JSON.stringify(record)}\n`, 'utf8').equals(bytes)) {
    throw invalid('owner record checksum or canonical bytes are invalid');
  }
  return record;
}

function validateOwnerFields(fields: OwnerRecordFields): void {
  if (fields.schemaVersion !== 1 || fields.kind !== 'windows-operation-lock'
    || fields.lockContractVersion !== 1
    || (fields.status !== 'held' && fields.status !== 'released')
    || !ACQUISITION_ID.test(fields.acquisitionId)
    || !SHA256.test(fields.lockKeySha256)
    || !WINDOWS_IDENTITY.test(fields.lockDirectoryIdentity)
    || !WINDOWS_IDENTITY.test(fields.guardFileIdentity)
    || !WINDOWS_IDENTITY.test(fields.ownerFileIdentity)
    || !Number.isSafeInteger(fields.pid) || fields.pid <= 0 || fields.pid > 0xffff_ffff
    || !PROCESS_CREATION_TIME.test(fields.processCreationTime)
    || typeof fields.command !== 'string' || typeof fields.target !== 'string'
    || typeof fields.createdAt !== 'string') {
    throw invalid('owner record fields are invalid');
  }
  let date: Date;
  try {
    date = new Date(fields.createdAt);
    if (date.toISOString() !== fields.createdAt) throw new Error('noncanonical date');
  } catch (error) {
    throw invalid('owner record timestamp is invalid', error);
  }
}

function assertOwnerBinding(
  record: OwnerRecord,
  namespace: LockNamespace,
  owner: WindowsPathInspection
): void {
  if (record.lockKeySha256 !== namespace.lockKeySha256
    || record.lockDirectoryIdentity !== identity(namespace.directory)
    || record.guardFileIdentity !== identity(namespace.guard)
    || record.ownerFileIdentity !== identity(owner)) {
    throw invalid('owner record is bound to different lock objects');
  }
}

function requireDirectDirectory(
  root: WindowsPathInspection,
  directory: WindowsPathInspection,
  component: string
): void {
  const separator = root.canonicalPath.endsWith('\\') ? '' : '\\';
  if (directory.canonicalPath.toLowerCase()
      !== `${root.canonicalPath}${separator}${component}`.toLowerCase()
    || directory.volume.identity !== root.volume.identity) {
    throw invalid('lock directory is not the requested direct child');
  }
}

function requireSameDirectory(a: WindowsPathInspection, b: WindowsPathInspection): void {
  if (a.kind !== 'directory' || b.kind !== 'directory'
    || a.canonicalPath.toLowerCase() !== b.canonicalPath.toLowerCase()
    || identity(a) !== identity(b)
    || !sameSecurity(a.security, b.security)) {
    throw invalid('lock directory identity or security changed');
  }
}

function requireSamePrivateFile(
  a: WindowsPathInspection,
  b: WindowsPathInspection,
  stableMetadata = true
): void {
  if (a.kind !== 'regular-file' || b.kind !== 'regular-file'
    || a.canonicalPath.toLowerCase() !== b.canonicalPath.toLowerCase()
    || identity(a) !== identity(b)
    || !sameSecurity(a.security, b.security)
    || (stableMetadata && !sameObjectIgnoringAccessTime(a.object, b.object))) {
    throw invalid('lock file identity, metadata, or security changed');
  }
}

function sameObjectIgnoringAccessTime(
  a: WindowsObjectObservation,
  b: WindowsObjectObservation
): boolean {
  return a.volumeIdentity === b.volumeIdentity && a.fileId === b.fileId
    && a.size === b.size && a.allocationSize === b.allocationSize
    && a.numberOfLinks === b.numberOfLinks && a.creationTime === b.creationTime
    && a.lastWriteTime === b.lastWriteTime && a.changeTime === b.changeTime
    && a.attributes === b.attributes && a.reparseTag === b.reparseTag
    && a.deletePending === b.deletePending && a.directory === b.directory;
}

function sameSecurity(a: WindowsSecurityObservation, b: WindowsSecurityObservation): boolean {
  return a.descriptorControl === b.descriptorControl && a.daclPresent === b.daclPresent
    && a.daclNull === b.daclNull && a.daclDefaulted === b.daclDefaulted
    && a.daclBytes.equals(b.daclBytes) && a.ownerSid === b.ownerSid
    && a.ownerDefaulted === b.ownerDefaulted && a.groupSid === b.groupSid
    && a.groupDefaulted === b.groupDefaulted && a.currentUserSid === b.currentUserSid;
}

function identity(inspection: WindowsPathInspection): string {
  return `${inspection.object.volumeIdentity}:${inspection.object.fileId}`;
}

function validateOptions<T>(
  options: WindowsOperationLockOptions,
  operation: (authority: WindowsOperationLockAuthority) => Promise<T>
): void {
  if (options === null || typeof options !== 'object'
    || !isValidWindowsPathComponent(options.lockComponent)
    || !LOCK_COMPONENT.test(options.lockComponent)
    || typeof options.details?.command !== 'string'
    || typeof options.details?.target !== 'string'
    || !isLosslessUtf8(options.details.command)
    || !isLosslessUtf8(options.details.target)
    || typeof operation !== 'function') {
    throw invalid('lock options are invalid');
  }
  const placeholder: OwnerRecordFields = {
    schemaVersion: 1,
    kind: 'windows-operation-lock',
    lockContractVersion: 1,
    status: 'held',
    acquisitionId: '0'.repeat(32),
    lockKeySha256: '0'.repeat(64),
    lockDirectoryIdentity: `${'0'.repeat(16)}:${'0'.repeat(32)}`,
    guardFileIdentity: `${'0'.repeat(16)}:${'0'.repeat(32)}`,
    ownerFileIdentity: `${'0'.repeat(16)}:${'0'.repeat(32)}`,
    pid: 0xffff_ffff,
    processCreationTime: '0'.repeat(16),
    createdAt: '9999-12-31T23:59:59.999Z',
    command: options.details.command,
    target: options.details.target
  };
  encodeOwner(placeholder);
}

const defaultIo: WindowsOperationLockIo = {
  async writeExistingFile(path: string, bytes: Uint8Array): Promise<void> {
    const handle = await open(path, 'r+');
    try {
      await handle.truncate(0);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
};

function isLosslessUtf8(value: string): boolean {
  try {
    return fatalUtf8.decode(Buffer.from(value, 'utf8')) === value;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(detail: string, cause?: unknown): BazframeError {
  return failure(
    'WINDOWS_OPERATION_LOCK_INVALID',
    `Invalid Windows operation lock: ${detail}.`,
    cause
  );
}

function failure(code: string, message: string, cause?: unknown): BazframeError {
  return new BazframeError(code, message, cause === undefined ? undefined : { cause });
}
