import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { BazframeError, errorCode } from './errors.js';

export const MAX_EFFECTIVE_INSTRUCTION_BYTES = 1024 * 1024;

export async function readUtf8InstructionFile(
  path: string,
  label: string,
  maxBytes = MAX_EFFECTIVE_INSTRUCTION_BYTES
): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new BazframeError(
      'INSTRUCTION_READ_FAILED',
      `${label} is not a readable regular file: ${path}${formatErrorCode(error)}`,
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
        `Could not inspect ${label.toLowerCase()}: ${path}${formatErrorCode(error)}`,
        { cause: error }
      );
    }

    if (!metadata.isFile()) {
      throw new BazframeError(
        'INSTRUCTION_NOT_FILE',
        `${label} is not a regular file: ${path}`
      );
    }
    if (metadata.size > maxBytes) {
      throw new BazframeError(
        'INSTRUCTION_TOO_LARGE',
        `${label} exceeds the prototype ${maxBytes}-byte instruction limit: ${path}`
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await readAtMost(handle, maxBytes + 1);
    } catch (error) {
      throw new BazframeError(
        'INSTRUCTION_READ_FAILED',
        `Could not read ${label.toLowerCase()}: ${path}${formatErrorCode(error)}`,
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
      `Could not close ${label.toLowerCase()}: ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (operationError !== undefined) throw operationError;
  if (text === undefined) {
    throw new BazframeError(
      'INSTRUCTION_READ_FAILED',
      `Could not read ${label.toLowerCase()}: ${path}`
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
  if (bytes.byteLength > maxBytes) {
    throw new BazframeError(
      'INSTRUCTION_TOO_LARGE',
      `${label} exceeds the prototype ${maxBytes}-byte instruction limit: ${path}`
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BazframeError(
      'INSTRUCTION_INVALID_UTF8',
      `${label} is not valid UTF-8: ${path}`,
      { cause: error }
    );
  }

  if (text.includes('\0')) {
    throw new BazframeError(
      'INSTRUCTION_CONTAINS_NUL',
      `${label} contains a NUL byte, which this prototype does not support: ${path}`
    );
  }
  return text;
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
