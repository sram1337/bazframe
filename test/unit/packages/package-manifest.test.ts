import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { decodePackageManifest, readPackageManifest, samePackageManifestSnapshot } from '../../../src/packages/package-manifest.js';
const execFileAsync = promisify(execFile);

const manifest = (build: string[] = ['x'], artifactRoot = '.', skillsRoot = '.') => ({
  schemaVersion: 1,
  build,
  artifactRoot,
  skillsRoot
});

describe('package manifest', () => {
  it('accepts the exact schema', () => {
    expect(decodePackageManifest(manifest(['npm', 'run', 'build'], 'dist', 'skills'))).toEqual(manifest(['npm', 'run', 'build'], 'dist', 'skills'));
  });

  it('rejects old and extra fields', () => {
    expect(() => decodePackageManifest({ schemaVersion: 1, build: ['x'], artifactRoot: '.', sourceUnitRoot: '.' })).toThrow(/exactly/u);
    expect(() => decodePackageManifest({ ...manifest(), extra: true })).toThrow(/exactly/u);
  });

  it('rejects escaping roots, nonliteral paths, and invalid argv', () => {
    expect(() => decodePackageManifest(manifest([]))).toThrow(/nonempty/u);
    expect(() => decodePackageManifest(manifest(['x'], '../dist'))).toThrow(/artifactRoot/u);
    expect(() => decodePackageManifest(manifest(['x'], 'dist\\out'))).toThrow(/artifactRoot/u);
    expect(() => decodePackageManifest(manifest(['']))).toThrow(/nonempty/u);
    expect(() => decodePackageManifest(manifest(['x'], '.', '/skills'))).toThrow(/skillsRoot/u);
  });

  it('enforces below, at, and above the argv count bound', () => {
    const limits = { maxArgvEntries: 2 };
    expect(decodePackageManifest(manifest(['a']), limits).build).toHaveLength(1);
    expect(decodePackageManifest(manifest(['a', 'b']), limits).build).toHaveLength(2);
    expect(() => decodePackageManifest(manifest(['a', 'b', 'c']), limits)).toThrow(/entry limit/u);
  });

  it('enforces multibyte below, at, and above the per-argument UTF-8 byte bound', () => {
    const limits = { maxArgumentBytes: 4 };
    expect(decodePackageManifest(manifest(['é']), limits).build[0]).toBe('é');
    expect(decodePackageManifest(manifest(['éé']), limits).build[0]).toBe('éé');
    expect(() => decodePackageManifest(manifest(['ééa']), limits)).toThrow(/argument exceeds/u);
  });

  it('enforces multibyte below, at, and above the aggregate argv UTF-8 byte bound', () => {
    const limits = { maxArgvAggregateBytes: 6 };
    expect(decodePackageManifest(manifest(['é', 'é']), limits).build).toEqual(['é', 'é']);
    expect(decodePackageManifest(manifest(['é', 'éé']), limits).build).toEqual(['é', 'éé']);
    expect(() => decodePackageManifest(manifest(['éé', 'éé']), limits)).toThrow(/aggregate argv/u);
  });

  it('enforces multibyte below, at, and above the UTF-8 package path bound for both paths', () => {
    const limits = { maxPathBytes: 4 };
    expect(decodePackageManifest(manifest(['x'], 'é', 'é'), limits)).toMatchObject({ artifactRoot: 'é', skillsRoot: 'é' });
    expect(decodePackageManifest(manifest(['x'], 'éé', 'éé'), limits)).toMatchObject({ artifactRoot: 'éé', skillsRoot: 'éé' });
    expect(() => decodePackageManifest(manifest(['x'], 'ééa', '.'), limits)).toThrow(/artifactRoot exceeds/u);
    expect(() => decodePackageManifest(manifest(['x'], '.', 'ééa'), limits)).toThrow(/skillsRoot exceeds/u);
  });

  it('enforces below, at, and above the raw manifest byte bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-package-bound-'));
    const path = join(root, 'bazframe-package.json');
    const bytes = JSON.stringify(manifest());
    await writeFile(path, bytes);
    await expect(readPackageManifest(root, { maxManifestBytes: Buffer.byteLength(bytes) + 1 })).resolves.toBeDefined();
    await expect(readPackageManifest(root, { maxManifestBytes: Buffer.byteLength(bytes) })).resolves.toBeDefined();
    await expect(readPackageManifest(root, { maxManifestBytes: Buffer.byteLength(bytes) - 1 })).rejects.toThrow(/byte limit/u);
  });

  it('requires a physical bazframe-package.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-package-'));
    await expect(readPackageManifest(root)).rejects.toThrow(/bazframe-package\.json/u);
    await writeFile(join(root, 'target.json'), JSON.stringify(manifest()));
    await symlink(join(root, 'target.json'), join(root, 'bazframe-package.json'));
    await expect(readPackageManifest(root)).rejects.toThrow(/physical/u);
  });

  it('rejects fatal UTF-8, directories, FIFO and other non-regular manifests without blocking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-package-special-'));
    const path = join(root, 'bazframe-package.json');
    await writeFile(path, new Uint8Array([0xff]));
    await expect(readPackageManifest(root)).rejects.toThrow(/UTF-8/u);
    await unlink(path);
    await mkdir(path);
    await expect(readPackageManifest(root)).rejects.toThrow(/regular file/u);
    if (process.platform !== 'win32') {
      await rm(path, { recursive: true });
      await execFileAsync('mkfifo', [path]);
      await expect(readPackageManifest(root)).rejects.toThrow(/regular file/u);
    }
  });

  it('captures stable manifest identity and content SHA-256 for commit-boundary comparison', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-package-stable-'));
    const path = join(root, 'bazframe-package.json');
    const firstBytes = JSON.stringify(manifest());
    await writeFile(path, firstBytes);
    const first = await readPackageManifest(root);
    const same = await readPackageManifest(root);
    expect(first.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(samePackageManifestSnapshot(first, same)).toBe(true);
    await unlink(path);
    await writeFile(path, JSON.stringify(manifest(['x'], 'dist')));
    const replaced = await readPackageManifest(root);
    expect(samePackageManifestSnapshot(first, replaced)).toBe(false);
  });
});
