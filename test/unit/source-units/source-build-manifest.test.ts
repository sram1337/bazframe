import { afterEach, describe, expect, it } from 'vitest';
import { symlink } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { decodeSourceBuildManifest, isPortableSourceRelativePath, readOptionalSourceBuildManifest } from '../../../src/source-units/source-build-manifest.js';

const dirs: TempDirectory[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((d) => d.cleanup())));

describe('source build manifest', () => {
  it('accepts exact literal argv and portable roots', () => {
    expect(decodeSourceBuildManifest({ schemaVersion: 1, build: ['npm', 'run', 'build'], artifactRoot: 'dist', sourceUnitRoot: 'source-unit' })).toEqual({ schemaVersion: 1, build: ['npm', 'run', 'build'], artifactRoot: 'dist', sourceUnitRoot: 'source-unit' });
    expect(['.', 'a', 'a/b'].every((value) => isPortableSourceRelativePath(value))).toBe(true);
    for (const value of ['', '/', '/a', 'a/', 'a//b', 'a/./b', 'a/../b', '..', 'C:/x', 'C:\\x', '\\\\server\\x']) expect(isPortableSourceRelativePath(value)).toBe(false);
  });
  it('rejects extras, empty argv and malformed roots', () => {
    expect(() => decodeSourceBuildManifest({ schemaVersion: 1, build: [], artifactRoot: '.', sourceUnitRoot: '.' })).toThrow(/build/u);
    expect(() => decodeSourceBuildManifest({ schemaVersion: 1, build: ['x'], artifactRoot: '.', sourceUnitRoot: '.', extra: true })).toThrow(/exactly/u);
  });
  it('distinguishes absence from invalid present entries', async () => {
    const d = await createTempDirectory(); dirs.push(d); const root = await d.mkdir('provider');
    await expect(readOptionalSourceBuildManifest(root)).resolves.toBeUndefined();
    await d.write('provider/bazframe-source.json', JSON.stringify({ schemaVersion: 1, build: ['node', 'build.mjs'], artifactRoot: 'dist', sourceUnitRoot: '.' }));
    await expect(readOptionalSourceBuildManifest(root)).resolves.toMatchObject({ artifactRoot: 'dist' });
  });
  it('rejects a symlink manifest', async () => {
    const d = await createTempDirectory(); dirs.push(d); const root = await d.mkdir('provider'); await d.write('manifest.json', '{}'); await symlink(d.path('manifest.json'), d.path('provider/bazframe-source.json'));
    await expect(readOptionalSourceBuildManifest(root)).rejects.toThrow(/physical regular/u);
  });
});
