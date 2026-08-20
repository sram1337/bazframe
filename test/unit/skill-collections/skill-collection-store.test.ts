import { execFile } from 'node:child_process';
import { symlink, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeLibrary, decodePackage, encodeLibrary, encodePackage,
  readLibrarySnapshot, readPackageSnapshot, sameCollectionSnapshot, scanGlobalSkillCollections
} from '../../../src/skill-collections/skill-collection-store.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));
const digest = 'a'.repeat(64);
const library = { schemaVersion: 1 as const, library: 'toolkit', root: '/provider/toolkit', digest };
const pkg = { schemaVersion: 1 as const, package: 'toolkit', root: '/project/toolkit', digest, artifactRoot: 'dist', skillsRoot: 'skills' };

describe('Skill collection store', () => {
  it('encodes exact canonical typed schema-v1 bytes', () => {
    expect(encodeLibrary(library)).toBe(`{\n  "schemaVersion": 1,\n  "library": "toolkit",\n  "root": "/provider/toolkit",\n  "digest": "${digest}"\n}\n`);
    expect(encodePackage(pkg)).toBe(`{\n  "schemaVersion": 1,\n  "package": "toolkit",\n  "root": "/project/toolkit",\n  "digest": "${digest}",\n  "artifactRoot": "dist",\n  "skillsRoot": "skills"\n}\n`);
    expect(decodeLibrary(JSON.parse(encodeLibrary(library)), 'toolkit')).toEqual(library);
    expect(decodePackage(JSON.parse(encodePackage(pkg)), 'toolkit')).toEqual(pkg);
  });

  it('rejects old, extra, mismatched, noncanonical, unsafe-root, and malformed digest fields', () => {
    expect(() => decodeLibrary({ ...library, source: 'toolkit' })).toThrow(/exactly/);
    expect(() => decodeLibrary(library, 'other')).toThrow(/does not match/);
    expect(() => decodeLibrary({ ...library, root: '/provider/other' })).toThrow(/basename/);
    expect(() => decodeLibrary({ ...library, root: 'relative/toolkit' })).toThrow(/canonical absolute/);
    expect(() => decodeLibrary({ ...library, digest: 'A'.repeat(64) })).toThrow(/lowercase/);
    expect(() => decodePackage({ ...pkg, skillsRoot: '../skills' })).toThrow(/skillsRoot/);
    expect(() => decodePackage({ ...pkg, artifactRoot: '/dist' })).toThrow(/artifactRoot/);
  });

  it('scans both namespaces lexically, keeps same IDs separate, and ignores old state', async () => {
    const directory = await createTempDirectory('bazframe-collection-scan-'); directories.push(directory);
    await directory.write('home/libraries/toolkit.json', encodeLibrary(library));
    await directory.write('home/packages/toolkit.json', encodePackage(pkg));
    await directory.write('home/libraries/alpha.json', encodeLibrary({ ...library, library: 'alpha', root: '/provider/alpha' }));
    await directory.write('home/sources/broken.json', '{');
    const result = await scanGlobalSkillCollections(directory.path('home'));
    expect(result.records.map((item) => `${item.key.kind}:${item.key.id}`)).toEqual(['library:alpha', 'library:toolkit', 'package:toolkit']);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports nested and special namespace entries without reading them', async () => {
    const directory = await createTempDirectory('bazframe-collection-namespace-'); directories.push(directory);
    await directory.write('home/libraries/provider/toolkit.json', encodeLibrary(library));
    await directory.write('home/packages/not-json', 'x');
    const result = await scanGlobalSkillCollections(directory.path('home'));
    expect(result.records).toEqual([]);
    expect(result.diagnostics.map((item) => `${item.key.kind}:${item.path}`)).toEqual(['library:provider', 'package:not-json']);
  });

  it('rejects unsafe identities before path construction', async () => {
    const directory = await createTempDirectory('bazframe-collection-id-'); directories.push(directory);
    await directory.write('home/outside/toolkit.json', encodeLibrary(library));
    await expect(readLibrarySnapshot(directory.path('home'), '../outside')).rejects.toMatchObject({ code: 'SKILL_COLLECTION_RECORD_INVALID' });
    await expect(directory.readText('home/outside/toolkit.json')).resolves.toBe(encodeLibrary(library));
  });

  it.each([
    ['library', 'libraries', encodeLibrary(library)],
    ['package', 'packages', encodePackage(pkg)]
  ] as const)('rejects symlinked homes, namespace ancestors, and final %s record links', async (kind, namespace, bytes) => {
    const directory = await createTempDirectory(`bazframe-${kind}-physical-`); directories.push(directory);
    await directory.write(`outside/${namespace}/toolkit.json`, bytes);
    await symlink(directory.path('outside'), directory.path('linked-home'));
    const read = kind === 'library' ? readLibrarySnapshot : readPackageSnapshot;
    await expect(read(directory.path('linked-home'), 'toolkit')).rejects.toBeDefined();
    await directory.mkdir('home');
    await symlink(directory.path(`outside/${namespace}`), directory.path(`home/${namespace}`));
    await expect(read(directory.path('home'), 'toolkit')).rejects.toBeDefined();
    await unlink(directory.path(`home/${namespace}`)); await directory.mkdir(`home/${namespace}`);
    await symlink(directory.path(`outside/${namespace}/toolkit.json`), directory.path(`home/${namespace}/toolkit.json`));
    await expect(read(directory.path('home'), 'toolkit')).rejects.toBeDefined();
  });

  it('captures record identity/content so replacement is distinguishable at commit', async () => {
    const directory = await createTempDirectory('bazframe-collection-stable-'); directories.push(directory);
    const path = await directory.write('home/libraries/toolkit.json', encodeLibrary(library));
    const first = await readLibrarySnapshot(directory.path('home'), 'toolkit');
    await unlink(path); await directory.write('home/libraries/toolkit.json', encodeLibrary({ ...library, digest: 'b'.repeat(64) }));
    const replaced = await readLibrarySnapshot(directory.path('home'), 'toolkit');
    expect(sameCollectionSnapshot(first, replaced)).toBe(false);
  });

  it.each([
    ['library', 'libraries', readLibrarySnapshot],
    ['package', 'packages', readPackageSnapshot]
  ] as const)('rejects fatal UTF-8, malformed JSON, FIFO and non-regular %s records without blocking', async (_kind, namespace, read) => {
    const directory = await createTempDirectory('bazframe-collection-invalid-'); directories.push(directory);
    const path = await directory.write(`home/${namespace}/toolkit.json`, new Uint8Array([0xff]));
    await expect(read(directory.path('home'), 'toolkit')).rejects.toMatchObject({ code: 'SKILL_COLLECTION_RECORD_INVALID' });
    await directory.write(`home/${namespace}/toolkit.json`, '{');
    await expect(read(directory.path('home'), 'toolkit')).rejects.toMatchObject({ code: 'SKILL_COLLECTION_RECORD_INVALID' });
    if (process.platform !== 'win32') {
      await unlink(path); await execFileAsync('mkfifo', [path]);
      await expect(read(directory.path('home'), 'toolkit')).rejects.toMatchObject({ code: 'SKILL_COLLECTION_RECORD_INVALID' });
    }
  });
});
