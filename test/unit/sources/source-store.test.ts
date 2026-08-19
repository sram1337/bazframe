import { execFile } from 'node:child_process';
import { symlink, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeGlobalSource, encodeGlobalSource, readGlobalSourceSnapshot, scanGlobalSourceNamespace } from '../../../src/sources/source-store.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

describe('global source store codec', () => {
  const record = {
    schemaVersion: 1 as const,
    source: 'source',
    root: '/provider/source',
    digest: 'a'.repeat(64),
    sourceUnitRoot: 'source-unit'
  };
  it('encodes the exact source-only schema-v1 bytes', () => {
    expect(encodeGlobalSource(record)).toBe(`{\n  "schemaVersion": 1,\n  "source": "source",\n  "root": "/provider/source",\n  "digest": "${'a'.repeat(64)}",\n  "sourceUnitRoot": "source-unit"\n}\n`);
    expect(decodeGlobalSource(JSON.parse(encodeGlobalSource(record)), 'source')).toEqual(record);
  });
  it('rejects provider fields, path identity mismatch, and root-basename mismatch', () => {
    expect(() => decodeGlobalSource({ ...record, provider: 'legacy' })).toThrow(/exactly/u);
    expect(() => decodeGlobalSource(record, 'other')).toThrow(/does not match/u);
    expect(() => decodeGlobalSource({ ...record, root: '/provider/other' })).toThrow(/basename/u);
  });

  it('reports old nested provider directories as invalid namespace entries', async () => {
    const directory = await createTempDirectory('bazframe-source-namespace-'); directories.push(directory);
    await directory.write('home/sources/provider/source.json', encodeGlobalSource(record));

    await expect(scanGlobalSourceNamespace(directory.path('home'))).resolves.toEqual({
      sources: [],
      diagnostics: [{ source: '<unknown-source>', path: 'provider' }]
    });
  });

  it('rejects unsafe identities before path construction', async () => {
    const directory = await createTempDirectory('bazframe-source-unsafe-id-'); directories.push(directory);
    await directory.write('home/outside/source.json', encodeGlobalSource(record));

    await expect(readGlobalSourceSnapshot(directory.path('home'), '../outside'))
      .rejects.toMatchObject({ code: 'SOURCE_RECORD_INVALID' });
    await expect(directory.readText('home/outside/source.json')).resolves.toBe(encodeGlobalSource(record));
  });

  it('rejects a symlinked Bazframe home and preserves the outside record', async () => {
    const directory = await createTempDirectory('bazframe-source-home-link-'); directories.push(directory);
    await directory.write('outside-home/sources/source.json', encodeGlobalSource(record));
    await symlink(directory.path('outside-home'), directory.path('linked-home'));

    await expect(readGlobalSourceSnapshot(directory.path('linked-home'), 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_RECORD_INVALID' });
    await expect(directory.readText('outside-home/sources/source.json'))
      .resolves.toBe(encodeGlobalSource(record));
  });

  it('rejects symlinked namespace ancestors and final links', async () => {
    const directory = await createTempDirectory('bazframe-source-physical-'); directories.push(directory);
    await directory.write('outside/source.json', encodeGlobalSource(record));
    await directory.mkdir('home');
    await symlink(directory.path('outside'), directory.path('home/sources'));
    await expect(readGlobalSourceSnapshot(directory.path('home'), 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_RECORD_INVALID' });

    await unlink(directory.path('home/sources'));
    await directory.mkdir('home/sources');
    await symlink(directory.path('outside/source.json'), directory.path('home/sources/source.json'));
    await expect(readGlobalSourceSnapshot(directory.path('home'), 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_RECORD_INVALID' });
  });

  it('rejects malformed bytes and non-regular files without blocking', async () => {
    const directory = await createTempDirectory('bazframe-source-record-invalid-'); directories.push(directory);
    const path = await directory.write('home/sources/source.json', new Uint8Array([0xff]));
    await expect(readGlobalSourceSnapshot(directory.path('home'), 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_RECORD_INVALID' });
    await directory.write('home/sources/source.json', '{');
    await expect(readGlobalSourceSnapshot(directory.path('home'), 'source'))
      .rejects.toMatchObject({ code: 'SOURCE_RECORD_INVALID' });

    if (process.platform !== 'win32') {
      await unlink(path);
      await execFileAsync('mkfifo', [path]);
      await expect(readGlobalSourceSnapshot(directory.path('home'), 'source'))
        .rejects.toMatchObject({ code: 'SOURCE_RECORD_INVALID' });
    }
  });
});
