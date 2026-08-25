import { execFile } from 'node:child_process';
import { rename, symlink, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProfileCollectionReferenceBulkIndex, decodeProfileCollectionReference,
  encodeProfileCollectionReference, findReferencingProfiles, readProfileCollectionReferenceSnapshot,
  sameProfileCollectionReferenceSnapshot, scanProfileCollectionReferences
} from '../../../src/profiles/profile-skill-collection-reference.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));
const library = { schemaVersion: 1 as const, library: 'toolkit' };
const pkg = { schemaVersion: 1 as const, package: 'toolkit' };

describe('profile library/package reference codec', () => {
  it('encodes exact typed schema-v1 bytes and rejects old, extra, and mismatched identities', () => {
    expect(encodeProfileCollectionReference(library)).toBe('{\n  "schemaVersion": 1,\n  "library": "toolkit"\n}\n');
    expect(encodeProfileCollectionReference(pkg)).toBe('{\n  "schemaVersion": 1,\n  "package": "toolkit"\n}\n');
    expect(decodeProfileCollectionReference(JSON.parse(encodeProfileCollectionReference(library)), 'library', 'toolkit')).toEqual(library);
    expect(decodeProfileCollectionReference(JSON.parse(encodeProfileCollectionReference(pkg)), 'package', 'toolkit')).toEqual(pkg);
    expect(() => decodeProfileCollectionReference({ schemaVersion: 1, source: 'toolkit' }, 'library')).toThrow(/exactly/);
    expect(() => decodeProfileCollectionReference({ ...library, extra: true }, 'library')).toThrow(/exactly/);
    expect(() => decodeProfileCollectionReference(library, 'library', 'other')).toThrow(/does not match/);
  });

  it('fails the complete reference index closed on unsafe and non-directory profile entries', async () => {
    const directory = await createTempDirectory('bazframe-reference-index-'); directories.push(directory);
    await directory.write('home/profiles/valid', 'not a profile directory'); await directory.mkdir('home/profiles/Unsafe');
    const result = await findReferencingProfiles(directory.path('home'), { kind: 'library', id: 'toolkit' });
    expect(result.profileIds).toEqual([]);
    expect(result.diagnostics.map((item) => item.profileId)).toEqual(['<unknown-profile>', 'valid']);
  });

  it('captures same-ID library/package counts independently in one stable bulk snapshot and ignores old state', async () => {
    const directory = await createTempDirectory('bazframe-reference-bulk-'); directories.push(directory);
    await directory.write('home/profiles/first/libraries/toolkit.json', encodeProfileCollectionReference(library));
    await directory.write('home/profiles/second/libraries/toolkit.json', encodeProfileCollectionReference(library));
    await directory.write('home/profiles/second/packages/toolkit.json', encodeProfileCollectionReference(pkg));
    await directory.write('home/profiles/second/sources/broken.json', '{');
    const first = await captureProfileCollectionReferenceBulkIndex(directory.path('home'));
    const second = await captureProfileCollectionReferenceBulkIndex(directory.path('home'));
    expect(first.profileIdsByCollection.get('library:toolkit')).toEqual(['first', 'second']);
    expect(first.profileIdsByCollection.get('package:toolkit')).toEqual(['second']);
    expect(first.diagnostics).toEqual([]); expect(second.identity).toBe(first.identity);
  });

  it('includes absent and stable typed namespace identities for every valid profile', async () => {
    const directory = await createTempDirectory('bazframe-reference-namespace-identity-'); directories.push(directory);
    await directory.mkdir('home/profiles/focused');
    const absent = await captureProfileCollectionReferenceBulkIndex(directory.path('home'));
    const libraries = await directory.mkdir('home/profiles/focused/libraries');
    const created = await captureProfileCollectionReferenceBulkIndex(directory.path('home'));
    expect(created.identity).not.toBe(absent.identity);
    expect((await captureProfileCollectionReferenceBulkIndex(directory.path('home'))).identity).toBe(created.identity);
    await directory.mkdir('home/profiles/focused/packages');
    const bothPresent = await captureProfileCollectionReferenceBulkIndex(directory.path('home'));
    expect(bothPresent.identity).not.toBe(created.identity);
    await rename(libraries, `${libraries}-old`); await directory.mkdir('home/profiles/focused/libraries');
    const replaced = await captureProfileCollectionReferenceBulkIndex(directory.path('home'));
    expect(replaced.identity).not.toBe(bothPresent.identity);
    expect(replaced.diagnostics).toEqual([]);
  });

  it('reports nested and special current typed reference entries', async () => {
    const directory = await createTempDirectory('bazframe-reference-namespace-'); directories.push(directory);
    await directory.write('home/profiles/focused/libraries/provider/toolkit.json', encodeProfileCollectionReference(library));
    await directory.write('home/profiles/focused/packages/not-json', 'x');
    const result = await scanProfileCollectionReferences(directory.path('home'), 'focused');
    expect(result.references).toEqual([]);
    expect(result.diagnostics.map((item) => `${item.key.kind}:${item.path}`)).toEqual(['library:provider', 'package:not-json']);
  });

  it.each(['library', 'package'] as const)('rejects symlinked profiles, namespace ancestors, and final %s reference links', async (kind) => {
    const directory = await createTempDirectory(`bazframe-reference-${kind}-`); directories.push(directory);
    const namespace = kind === 'library' ? 'libraries' : 'packages'; const bytes = encodeProfileCollectionReference(kind === 'library' ? library : pkg);
    await directory.write(`outside/profiles/focused/${namespace}/toolkit.json`, bytes); await directory.mkdir('home');
    await symlink(directory.path('outside/profiles'), directory.path('home/profiles'));
    await expect(readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', { kind, id: 'toolkit' })).rejects.toBeDefined();
    await unlink(directory.path('home/profiles')); await directory.mkdir('home/profiles');
    await symlink(directory.path('outside/profiles/focused'), directory.path('home/profiles/focused'));
    await expect(readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', { kind, id: 'toolkit' })).rejects.toBeDefined();
    await unlink(directory.path('home/profiles/focused')); await directory.mkdir('home/profiles/focused');
    await symlink(directory.path(`outside/profiles/focused/${namespace}`), directory.path(`home/profiles/focused/${namespace}`));
    await expect(readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', { kind, id: 'toolkit' })).rejects.toBeDefined();
    await unlink(directory.path(`home/profiles/focused/${namespace}`)); await directory.mkdir(`home/profiles/focused/${namespace}`);
    await symlink(directory.path(`outside/profiles/focused/${namespace}/toolkit.json`), directory.path(`home/profiles/focused/${namespace}/toolkit.json`));
    await expect(readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', { kind, id: 'toolkit' })).rejects.toBeDefined();
  });

  it('captures reference identity/content so replacement is distinguishable at commit', async () => {
    const directory = await createTempDirectory('bazframe-reference-stable-'); directories.push(directory);
    const path = await directory.write('home/profiles/focused/libraries/toolkit.json', encodeProfileCollectionReference(library));
    const first = await readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', { kind: 'library', id: 'toolkit' });
    await rename(path, `${path}.replaced`); await directory.write('home/profiles/focused/libraries/toolkit.json', encodeProfileCollectionReference(library));
    const replaced = await readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', { kind: 'library', id: 'toolkit' });
    expect(sameProfileCollectionReferenceSnapshot(first, replaced)).toBe(false);
  });

  it.each(['library', 'package'] as const)('rejects fatal UTF-8, malformed JSON, FIFO, and non-regular %s references without blocking', async (kind) => {
    const directory = await createTempDirectory('bazframe-reference-invalid-'); directories.push(directory);
    const namespace = kind === 'library' ? 'libraries' : 'packages'; const key = { kind, id: 'toolkit' } as const;
    const path = await directory.write(`home/profiles/focused/${namespace}/toolkit.json`, new Uint8Array([0xff]));
    await expect(readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', key)).rejects.toMatchObject({ code: 'SKILL_COLLECTION_REFERENCE_INVALID' });
    await directory.write(`home/profiles/focused/${namespace}/toolkit.json`, '{');
    await expect(readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', key)).rejects.toMatchObject({ code: 'SKILL_COLLECTION_REFERENCE_INVALID' });
    if (process.platform !== 'win32') {
      await unlink(path); await execFileAsync('mkfifo', [path]);
      await expect(readProfileCollectionReferenceSnapshot(directory.path('home'), 'focused', key)).rejects.toMatchObject({ code: 'SKILL_COLLECTION_REFERENCE_INVALID' });
    }
  });
});
