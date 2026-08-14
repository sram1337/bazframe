import { execFile } from 'node:child_process';
import { symlink, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProfileSourceReferenceBulkIndex,
  decodeProfileSourceReference,
  encodeProfileSourceReference,
  findReferencingProfiles,
  profileSourceReferenceKey,
  readProfileSourceReferenceSnapshot,
  scanProfileSourceReferences
} from '../../../src/profiles/profile-source-reference.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

describe('profile source reference codec', () => {
  const reference = { schemaVersion: 1 as const, provider: 'provider', source: 'source' };
  it('encodes exact schema-v1 bytes', () => {
    expect(encodeProfileSourceReference(reference)).toBe('{\n  "schemaVersion": 1,\n  "provider": "provider",\n  "source": "source"\n}\n');
    expect(decodeProfileSourceReference(JSON.parse(encodeProfileSourceReference(reference)), 'provider', 'source')).toEqual(reference);
  });
  it('rejects additional fields and mismatched path identity', () => {
    expect(() => decodeProfileSourceReference({ ...reference, root: '/wrong' })).toThrow(/exactly/u);
    expect(() => decodeProfileSourceReference(reference, 'provider', 'other')).toThrow(/does not match/u);
  });

  it('fails the complete reference index closed on unsafe and non-directory profile entries', async () => {
    const directory = await createTempDirectory('bazframe-reference-index-'); directories.push(directory);
    await directory.write('home/profiles/valid', 'not a profile directory');
    await directory.mkdir('home/profiles/Unsafe');

    const result = await findReferencingProfiles(directory.path('home'), 'provider', 'source');

    expect(result.profileIds).toEqual([]);
    expect(result.diagnostics.map((item) => item.profileId)).toEqual(['<unknown-profile>', 'valid']);
  });

  it('captures all source counts and diagnostics in one bulk reference-index snapshot', async () => {
    const directory = await createTempDirectory('bazframe-reference-bulk-index-'); directories.push(directory);
    const alpha = encodeProfileSourceReference({ schemaVersion: 1, provider: 'provider', source: 'alpha' });
    const beta = encodeProfileSourceReference({ schemaVersion: 1, provider: 'provider', source: 'beta' });
    await directory.write('home/profiles/first/sources/provider/alpha.json', alpha);
    await directory.write('home/profiles/second/sources/provider/alpha.json', alpha);
    await directory.write('home/profiles/second/sources/provider/beta.json', beta);

    const result = await captureProfileSourceReferenceBulkIndex(directory.path('home'));

    expect(result.diagnostics).toEqual([]);
    expect(result.profileIdsBySource.get(profileSourceReferenceKey('provider', 'alpha'))).toEqual([
      'first',
      'second'
    ]);
    expect(result.profileIdsBySource.get(profileSourceReferenceKey('provider', 'beta'))).toEqual([
      'second'
    ]);
  });

  it('reports invalid physical entries in a profile reference namespace', async () => {
    const directory = await createTempDirectory('bazframe-reference-namespace-'); directories.push(directory);
    await directory.write('home/profiles/focused/sources/provider', 'not a directory');

    await expect(scanProfileSourceReferences(directory.path('home'), 'focused')).resolves.toEqual({
      references: [],
      diagnostics: [{ provider: 'provider', source: '<unknown-source>', path: 'provider' }]
    });
  });

  it('rejects symlinked profiles and profile ancestors before exact reads', async () => {
    const directory = await createTempDirectory('bazframe-reference-full-chain-'); directories.push(directory);
    await directory.write('outside/profiles/focused/sources/provider/source.json', encodeProfileSourceReference(reference));
    await directory.mkdir('home');
    await symlink(directory.path('outside/profiles'), directory.path('home/profiles'));
    await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'focused', 'provider', 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });

    await unlink(directory.path('home/profiles'));
    await directory.mkdir('home/profiles');
    await symlink(directory.path('outside/profiles/focused'), directory.path('home/profiles/focused'));
    await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'focused', 'provider', 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });
    await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'Unsafe', 'provider', 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });
  });

  it('rejects symlinked namespace ancestors and final links', async () => {
    const directory = await createTempDirectory('bazframe-reference-physical-'); directories.push(directory);
    const outside = await directory.mkdir('outside/provider');
    await directory.write('outside/provider/source.json', encodeProfileSourceReference(reference));
    await directory.mkdir('home/profiles/focused');
    await symlink(directory.path('outside'), directory.path('home/profiles/focused/sources'));
    await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'focused', 'provider', 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });

    await unlink(directory.path('home/profiles/focused/sources'));
    await directory.mkdir('home/profiles/focused/sources');
    await symlink(outside, directory.path('home/profiles/focused/sources/provider'));
    await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'focused', 'provider', 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });

    await unlink(directory.path('home/profiles/focused/sources/provider'));
    await directory.mkdir('home/profiles/focused/sources/provider');
    await symlink(directory.path('outside/provider/source.json'), directory.path('home/profiles/focused/sources/provider/source.json'));
    await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'focused', 'provider', 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });
  });

  it('rejects malformed bytes and non-regular files without blocking', async () => {
    const directory = await createTempDirectory('bazframe-reference-invalid-'); directories.push(directory);
    const path = await directory.write('home/profiles/focused/sources/provider/source.json', new Uint8Array([0xff]));
    await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'focused', 'provider', 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });
    await directory.write('home/profiles/focused/sources/provider/source.json', '{');
    await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'focused', 'provider', 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });

    if (process.platform !== 'win32') {
      await unlink(path);
      await execFileAsync('mkfifo', [path]);
      await expect(readProfileSourceReferenceSnapshot(directory.path('home'), 'focused', 'provider', 'source'))
        .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_INVALID' });
    }
  });
});
