import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BazframeError, errorCode } from '../core/errors.js';

export interface FileIdentity {
  sha256: string;
  bytes: number;
}

export function identifyBytes(contents: string | Uint8Array): FileIdentity {
  const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength
  };
}

export async function identifyFile(path: string): Promise<FileIdentity> {
  try {
    return identifyBytes(await readFile(path));
  } catch (error) {
    throw new BazframeError(
      'FILE_IDENTITY_READ_FAILED',
      `Could not read file identity for ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity
): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
