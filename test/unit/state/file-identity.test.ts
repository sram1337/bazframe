import { afterEach, describe, expect, it } from 'vitest';
import {
  identifyBytes,
  identifyFile,
  sameFileIdentity
} from '../../../src/state/file-identity.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('file identity', () => {
  it('uses SHA-256 and byte length for bytes and files', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const path = await directory.write('artifact.ts', 'abc');
    const expected = {
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      bytes: 3
    };

    expect(identifyBytes('abc')).toEqual(expected);
    expect(await identifyFile(path)).toEqual(expected);
    expect(sameFileIdentity(expected, identifyBytes(Uint8Array.from([97, 98, 99])))).toBe(true);
    expect(sameFileIdentity(expected, identifyBytes('abcd'))).toBe(false);
  });

  it('reports unreadable files as identity errors', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    await expect(identifyFile(directory.path('missing'))).rejects.toThrow(/file identity/u);
  });
});
