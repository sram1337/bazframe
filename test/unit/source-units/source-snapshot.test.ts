import { afterEach, describe, expect, it } from 'vitest';
import { chmod, cp, lstat, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { decodeSnapshotManifest, encodeSnapshotManifest, isSnapshotEntryPath, publishSourceSnapshot, resolvePhysicalRelativeDirectory, verifySourceSnapshot } from '../../../src/source-units/source-snapshot.js';
const dirs: TempDirectory[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((d) => d.cleanup())));

describe('source snapshots', () => {
  it('captures files, empty directories, executable state and canonical identity', async () => {
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.mkdir('source/empty'); await d.write('source/a.txt', 'a\n'); await d.write('source/z.sh', '#!/bin/sh\n'); await d.write('source/\uE000', 'bmp'); await d.write('source/𐀀', 'astral');
    if (process.platform !== 'win32') await chmod(d.path('source/z.sh'), 0o755);
    const published = await publishSourceSnapshot(d.path('home'), source);
    expect(published.manifest.entries.map((e) => e.path)).toEqual(['.', 'a.txt', 'empty', 'z.sh', '\uE000', '𐀀']);
    expect(published.digest).toBe(createHash('sha256').update(encodeSnapshotManifest(published.manifest)).digest('hex'));
    await expect(verifySourceSnapshot(d.path('home'), published.digest)).resolves.toMatchObject({ digest: published.digest });
    expect(await readFile(`${published.artifactRoot}/a.txt`, 'utf8')).toBe('a\n');
    if (process.platform !== 'win32') {
      expect((await lstat(published.snapshotRoot)).mode & 0o777).toBe(0o500);
      expect((await lstat(`${published.snapshotRoot}/manifest.json`)).mode & 0o777).toBe(0o400);
      expect((await lstat(published.artifactRoot)).mode & 0o777).toBe(0o500);
      expect((await lstat(`${published.artifactRoot}/a.txt`)).mode & 0o777).toBe(0o400);
      expect((await lstat(`${published.artifactRoot}/z.sh`)).mode & 0o777).toBe(0o500);
    }
  });
  it('normalizes the complete staged snapshot before publication', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    let observed = false;
    await publishSourceSnapshot(d.path('home'), source, {
      beforePublish: async (staging) => {
        observed = true;
        expect((await lstat(staging)).mode & 0o777).toBe(0o500);
        expect((await lstat(`${staging}/manifest.json`)).mode & 0o777).toBe(0o400);
        expect((await lstat(`${staging}/artifact`)).mode & 0o777).toBe(0o500);
        expect((await lstat(`${staging}/artifact/a`)).mode & 0o777).toBe(0o400);
      }
    });
    expect(observed).toBe(true);
  });
  it('reuses verified content and rejects corruption', async () => {
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    const first = await publishSourceSnapshot(d.path('home'), source); const second = await publishSourceSnapshot(d.path('home'), source); expect(second.snapshotRoot).toBe(first.snapshotRoot);
    await chmod(`${first.artifactRoot}/a`, 0o600).catch(() => undefined); await writeFile(`${first.artifactRoot}/a`, 'two');
    await expect(verifySourceSnapshot(d.path('home'), first.digest)).rejects.toThrow(/corrupt/u);
    await expect(publishSourceSnapshot(d.path('home'), source)).rejects.toThrow(/corrupt/u);
  });
  it('rejects writable or mode-drifted published snapshots', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    const published = await publishSourceSnapshot(d.path('home'), source);
    await chmod(`${published.snapshotRoot}/manifest.json`, 0o600);
    await expect(verifySourceSnapshot(d.path('home'), published.digest)).rejects.toThrow(/mode/u);
    await chmod(`${published.snapshotRoot}/manifest.json`, 0o400);
    await chmod(published.artifactRoot, 0o700);
    await expect(verifySourceSnapshot(d.path('home'), published.digest)).rejects.toThrow(/mode/u);
  });
  it('rejects substituted manifest and artifact file identities without following links', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    const published = await publishSourceSnapshot(d.path('home'), source);
    await chmod(published.snapshotRoot, 0o700);
    const manifest = `${published.snapshotRoot}/manifest.json`;
    await d.write('replacement-manifest', await readFile(manifest));
    await chmod(manifest, 0o600); await symlink(d.path('replacement-manifest'), `${manifest}.link`);
    await rename(`${manifest}.link`, manifest);
    await expect(verifySourceSnapshot(d.path('home'), published.digest)).rejects.toThrow(/corrupt/u);
  });
  it('rejects artifact directory substitution while its physical handle is held', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    const published = await publishSourceSnapshot(d.path('home'), source);
    await expect(verifySourceSnapshot(d.path('home'), published.digest, {
      duringArtifactVerification: async (artifact) => {
        await chmod(published.snapshotRoot, 0o700);
        await chmod(artifact, 0o700);
        await rename(artifact, `${artifact}-replaced`);
        await cp(`${artifact}-replaced`, artifact, { recursive: true, preserveTimestamps: false });
      }
    })).rejects.toThrow(/identity changed|stable physical directory/u);
  });
  it('captures legal POSIX basenames that are not portable build-relative paths', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source');
    for (const name of ['back\\slash', 'colon:name', 'C:drive-like']) await d.write(`source/${name}`, name);
    const published = await publishSourceSnapshot(d.path('home'), source);
    expect(published.manifest.entries.map((entry) => entry.path)).toEqual(['.', 'C:drive-like', 'back\\slash', 'colon:name']);
  });
  it('uses physical snapshot entry paths rather than provider build-path grammar', () => {
    for (const path of ['.', 'back\\slash', 'colon:name', 'C:drive-like', 'nested/back\\slash']) expect(isSnapshotEntryPath(path)).toBe(true);
    for (const path of ['', 'a//b', 'a/./b', 'a/../b', 'nul\0name']) expect(isSnapshotEntryPath(path)).toBe(false);
    const hash = 'a'.repeat(64);
    expect(() => decodeSnapshotManifest({ schemaVersion: 1, entries: [
      { path: '.', type: 'directory' },
      { path: 'C:drive-like', type: 'file', executable: false, sha256: hash },
      { path: 'back\\slash', type: 'file', executable: false, sha256: hash },
      { path: 'colon:name', type: 'file', executable: false, sha256: hash }
    ] })).not.toThrow();
  });
  it('rejects artifact/storage overlap', async () => {
    const d = await createTempDirectory(); dirs.push(d); const home = await d.mkdir('home'); await d.write('home/SKILL.md', 'x');
    await expect(publishSourceSnapshot(home, home)).rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_PATH_OVERLAP' });
  });
  it('rejects links and resolves contained physical directories', async () => {
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.mkdir('source/nested'); await d.write('outside', 'x'); await symlink(d.path('outside'), d.path('source/link'));
    await expect(publishSourceSnapshot(d.path('home'), source)).rejects.toThrow(/symbolic link/u);
    await expect(resolvePhysicalRelativeDirectory(source, 'nested')).resolves.toBe(await realpath(d.path('source/nested')));
    await expect(resolvePhysicalRelativeDirectory(source, '../x')).rejects.toThrow(/Invalid/u);
  });
});
