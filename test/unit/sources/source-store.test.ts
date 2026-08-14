import { afterEach, describe, expect, it } from 'vitest';
import { decodeGlobalSource, encodeGlobalSource, scanGlobalSourceNamespace } from '../../../src/sources/source-store.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

describe('global source store codec', () => {
  const record = {
    schemaVersion: 1 as const,
    provider: 'provider',
    source: 'source',
    root: '/provider/root',
    digest: 'a'.repeat(64),
    sourceUnitRoot: 'source-unit'
  };
  it('encodes the exact schema-v1 bytes', () => {
    expect(encodeGlobalSource(record)).toBe(`{\n  "schemaVersion": 1,\n  "provider": "provider",\n  "source": "source",\n  "root": "/provider/root",\n  "digest": "${'a'.repeat(64)}",\n  "sourceUnitRoot": "source-unit"\n}\n`);
    expect(decodeGlobalSource(JSON.parse(encodeGlobalSource(record)), 'provider', 'source')).toEqual(record);
  });
  it('rejects extra fields and path identity mismatch', () => {
    expect(() => decodeGlobalSource({ ...record, extra: true })).toThrow(/exactly/u);
    expect(() => decodeGlobalSource(record, 'other', 'source')).toThrow(/does not match/u);
  });

  it('reports invalid physical entries in the global source namespace', async () => {
    const directory = await createTempDirectory('bazframe-source-namespace-'); directories.push(directory);
    await directory.write('home/sources/provider', 'not a directory');

    await expect(scanGlobalSourceNamespace(directory.path('home'))).resolves.toEqual({
      sources: [],
      diagnostics: [{ provider: 'provider', source: '<unknown-source>', path: 'provider' }]
    });
  });
});
