import { constants as bufferConstants } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';

/** Reads through an already no-follow-opened handle and observes at most maximum + 1 bytes. */
export async function readAtMostOneBeyond(
  handle: FileHandle,
  maximum: number
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum >= bufferConstants.MAX_LENGTH) {
    throw new RangeError('maximum must permit a finite nonnegative maximum + 1 byte allocation');
  }
  const bytes = Buffer.alloc(maximum + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset);
}
