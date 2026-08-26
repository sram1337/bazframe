import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { BazframeError, errorCode } from './errors.js';
import { escapeUnsafeDisplayCharacters } from './safe-text.js';

export const MAX_EFFECTIVE_INSTRUCTION_BYTES = 1024 * 1024;

export interface PhysicalInstructionSnapshot {
  path: string;
  bytes: Uint8Array;
  device: bigint;
  inode: bigint;
  byteCount: number;
  contentSha256: string;
}

export interface PhysicalInstructionSnapshotDependencies {
  afterRead?: () => Promise<void>;
  afterClose?: () => void | Promise<void>;
}

export async function readPhysicalInstructionSnapshot(
  path: string,
  label: string,
  dependencies: PhysicalInstructionSnapshotDependencies = {}
): Promise<PhysicalInstructionSnapshot> {
  const displayPath = escapeUnsafeDisplayCharacters(path);
  let handle: FileHandle | undefined;
  let snapshot: PhysicalInstructionSnapshot | undefined;
  let operationError: unknown;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new BazframeError(
        'INSTRUCTION_NOT_FILE',
        `${label} is not a physical regular file: ${displayPath}`
      );
    }
    if (before.size > BigInt(MAX_EFFECTIVE_INSTRUCTION_BYTES)) {
      throw new BazframeError(
        'INSTRUCTION_TOO_LARGE',
        `${label} exceeds the ${MAX_EFFECTIVE_INSTRUCTION_BYTES}-byte instruction limit: ${displayPath}`
      );
    }

    const readBytes = await readAtMost(handle, MAX_EFFECTIVE_INSTRUCTION_BYTES + 1);
    decodeUtf8Instructions(readBytes, label, path);
    await dependencies.afterRead?.();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!after.isFile()
      || current.isSymbolicLink()
      || !current.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || after.dev !== current.dev
      || after.ino !== current.ino
      || before.size !== after.size
      || after.size !== current.size
      || before.mtimeNs !== after.mtimeNs
      || after.mtimeNs !== current.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || after.ctimeNs !== current.ctimeNs
      || BigInt(readBytes.byteLength) !== after.size) {
      throw new BazframeError(
        'INSTRUCTION_READ_FAILED',
        `${label} changed while being read: ${displayPath}`
      );
    }

    const bytes = Uint8Array.from(readBytes);
    snapshot = {
      path,
      bytes,
      device: before.dev,
      inode: before.ino,
      byteCount: bytes.byteLength,
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    };
  } catch (error) {
    operationError = error instanceof BazframeError
      ? error
      : new BazframeError(
        'INSTRUCTION_READ_FAILED',
        `${label} is not a readable physical regular file: ${displayPath}${formatErrorCode(error)}`,
        { cause: error }
      );
  }

  if (handle !== undefined) {
    try {
      await handle.close();
      await dependencies.afterClose?.();
    } catch (error) {
      operationError ??= new BazframeError(
        'INSTRUCTION_READ_FAILED',
        `Could not close ${label.toLowerCase()}: ${displayPath}${formatErrorCode(error)}`,
        { cause: error }
      );
    }
  }
  if (operationError !== undefined) throw operationError;
  if (snapshot === undefined) {
    throw new BazframeError(
      'INSTRUCTION_READ_FAILED',
      `Could not read ${label.toLowerCase()}: ${displayPath}`
    );
  }
  return snapshot;
}

export function samePhysicalInstructionSnapshot(
  left: PhysicalInstructionSnapshot,
  right: PhysicalInstructionSnapshot
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.byteCount === right.byteCount
    && left.contentSha256 === right.contentSha256
    && Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

export async function readUtf8InstructionFile(
  path: string,
  label: string,
  maxBytes = MAX_EFFECTIVE_INSTRUCTION_BYTES
): Promise<string> {
  const displayPath = escapeUnsafeDisplayCharacters(path);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new BazframeError(
      'INSTRUCTION_READ_FAILED',
      `${label} is not a readable regular file: ${displayPath}${formatErrorCode(error)}`,
      { cause: error }
    );
  }

  let text: string | undefined;
  let operationError: unknown;
  try {
    let metadata;
    try {
      metadata = await handle.stat();
    } catch (error) {
      throw new BazframeError(
        'INSTRUCTION_READ_FAILED',
        `Could not inspect ${label.toLowerCase()}: ${displayPath}${formatErrorCode(error)}`,
        { cause: error }
      );
    }

    if (!metadata.isFile()) {
      throw new BazframeError(
        'INSTRUCTION_NOT_FILE',
        `${label} is not a regular file: ${displayPath}`
      );
    }
    if (metadata.size > maxBytes) {
      throw new BazframeError(
        'INSTRUCTION_TOO_LARGE',
        `${label} exceeds the ${maxBytes}-byte instruction limit: ${displayPath}`
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await readAtMost(handle, maxBytes + 1);
    } catch (error) {
      throw new BazframeError(
        'INSTRUCTION_READ_FAILED',
        `Could not read ${label.toLowerCase()}: ${displayPath}${formatErrorCode(error)}`,
        { cause: error }
      );
    }

    text = decodeUtf8Instructions(bytes, label, path, maxBytes);
  } catch (error) {
    operationError = error;
  }

  try {
    await handle.close();
  } catch (error) {
    operationError ??= new BazframeError(
      'INSTRUCTION_READ_FAILED',
      `Could not close ${label.toLowerCase()}: ${displayPath}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (operationError !== undefined) throw operationError;
  if (text === undefined) {
    throw new BazframeError(
      'INSTRUCTION_READ_FAILED',
      `Could not read ${label.toLowerCase()}: ${displayPath}`
    );
  }
  return text;
}

async function readAtMost(handle: FileHandle, byteLimit: number): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(byteLimit);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function decodeUtf8Instructions(
  bytes: Uint8Array,
  label: string,
  path: string,
  maxBytes = MAX_EFFECTIVE_INSTRUCTION_BYTES
): string {
  const displayPath = escapeUnsafeDisplayCharacters(path);
  if (bytes.byteLength > maxBytes) {
    throw new BazframeError(
      'INSTRUCTION_TOO_LARGE',
      `${label} exceeds the ${maxBytes}-byte instruction limit: ${displayPath}`
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BazframeError(
      'INSTRUCTION_INVALID_UTF8',
      `${label} is not valid UTF-8: ${displayPath}`,
      { cause: error }
    );
  }

  if (text.includes('\0')) {
    throw new BazframeError(
      'INSTRUCTION_CONTAINS_NUL',
      `${label} contains a NUL byte, which Bazframe does not support: ${displayPath}`
    );
  }
  return text;
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
