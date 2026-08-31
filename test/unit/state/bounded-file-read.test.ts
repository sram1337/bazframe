import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readAtMostOneBeyond } from '../../../src/state/bounded-file-read.js';

describe('bounded file read', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects unsafe allocation bound %s before touching the handle',
    async (maximum) => {
      await expect(readAtMostOneBeyond({} as FileHandle, maximum)).rejects.toBeInstanceOf(RangeError);
    }
  );
});
