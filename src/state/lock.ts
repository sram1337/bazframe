import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { assertPathWithin, ensureManagedDirectory } from './atomic-file.js';

const MAX_LOCK_BYTES = 4096;

export interface LockDetails {
  command: string;
  target: string;
}

export interface LockOptions {
  managedRoot: string;
  processId?: number;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
}

interface LockRecord extends LockDetails {
  schemaVersion: 1;
  pid: number;
  createdAt: string;
  token: string;
}

export async function withStateLock<T>(
  lockPath: string,
  details: LockDetails,
  operation: () => Promise<T>,
  options: LockOptions
): Promise<T> {
  const path = normalizedLockPath(lockPath, options.managedRoot);
  await ensureManagedDirectory(options.managedRoot, dirname(path));

  const record: LockRecord = {
    schemaVersion: 1,
    pid: options.processId ?? process.pid,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    command: details.command,
    target: details.target,
    token: randomUUID()
  };
  await acquireLock(path, record, options.isProcessAlive ?? processIsAlive);

  let value: T | undefined;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  try {
    await releaseOwnedLock(path, record.token);
  } catch (error) {
    releaseError = error;
  }

  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return value as T;
}

async function acquireLock(
  path: string,
  record: LockRecord,
  isProcessAlive: (pid: number) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await createLockFile(path, record);
      return;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new BazframeError(
          'LOCK_ACQUIRE_FAILED',
          `Could not acquire Bazframe state lock ${path}${formatErrorCode(error)}`,
          { cause: error }
        );
      }
    }

    const existing = await readLock(path);
    if (isProcessAlive(existing.pid)) {
      throw new BazframeError(
        'LOCK_BUSY',
        `Bazframe state is busy: ${existing.command} (PID ${existing.pid}) holds ${path} for ${existing.target}.`
      );
    }
    await recoverStaleLock(path, existing.token, isProcessAlive);
  }

  throw new BazframeError(
    'LOCK_ACQUIRE_FAILED',
    `Could not acquire Bazframe state lock after stale-lock recovery: ${path}`
  );
}

async function recoverStaleLock(
  path: string,
  staleToken: string,
  isProcessAlive: (pid: number) => boolean
): Promise<void> {
  const recoveryPath = `${path}.recovery`;
  const recoveryRecord: LockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    command: 'stale-lock-recovery',
    target: path,
    token: randomUUID()
  };

  try {
    await createLockFile(recoveryPath, recoveryRecord);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return;
    throw error;
  }

  try {
    let current: LockRecord;
    try {
      current = await readLock(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    if (current.token !== staleToken || isProcessAlive(current.pid)) return;
    await rm(path);
  } finally {
    await releaseOwnedLock(recoveryPath, recoveryRecord.token);
  }
}

async function createLockFile(path: string, record: LockRecord): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The create failure remains primary.
      }
    }
    throw error;
  }
}

async function readLock(path: string): Promise<LockRecord> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_LOCK_BYTES) {
    throw new BazframeError('LOCK_INVALID', `Invalid Bazframe state lock: ${path}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new BazframeError('LOCK_INVALID', `Invalid Bazframe state lock: ${path}`, {
      cause: error
    });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BazframeError('LOCK_INVALID', `Invalid Bazframe state lock: ${path}`);
  }
  const candidate = value as Partial<LockRecord>;
  if (
    candidate.schemaVersion !== 1
    || !Number.isSafeInteger(candidate.pid)
    || (candidate.pid ?? 0) <= 0
    || typeof candidate.createdAt !== 'string'
    || typeof candidate.command !== 'string'
    || typeof candidate.target !== 'string'
    || typeof candidate.token !== 'string'
    || candidate.token.length === 0
  ) {
    throw new BazframeError('LOCK_INVALID', `Invalid Bazframe state lock: ${path}`);
  }
  return candidate as LockRecord;
}

async function releaseOwnedLock(path: string, token: string): Promise<void> {
  let existing: LockRecord;
  try {
    existing = await readLock(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (existing.token !== token) {
    throw new BazframeError(
      'LOCK_OWNERSHIP_CHANGED',
      `Bazframe state lock ownership changed before release: ${path}`
    );
  }
  await rm(path);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function normalizedLockPath(path: string, managedRoot: string): string {
  if (path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new BazframeError(
      'MANAGED_PATH_INVALID',
      `Lock path must be a non-empty absolute path without NUL bytes: ${path}`
    );
  }
  const normalized = resolve(path);
  assertPathWithin(resolve(managedRoot), normalized);
  if (normalized === resolve(managedRoot)) {
    throw new BazframeError('MANAGED_PATH_INVALID', `Lock path must be below ${managedRoot}.`);
  }
  return normalized;
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
