import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProfileSourceReferenceBulkIndex,
  decodeProfileSourceReference,
  encodeProfileSourceReference,
  findReferencingProfiles,
  profileSourceReferenceKey,
  scanProfileSourceReferences
} from '../../../src/profiles/profile-source-reference.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
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
});
