import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, chmod, cp, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import {
  decodeSnapshotManifest,
  encodeSnapshotManifest,
  isSnapshotEntryPath,
  publishSkillSnapshot,
  resolvePhysicalRelativeDirectory,
  SKILL_SNAPSHOT_LIMITS,
  snapshotStoreRoot,
  verifySkillSnapshot,
  type SkillSnapshotLimitPolicy,
  type SnapshotManifest
} from '../../../src/skill-collections/skill-snapshot.js';
const dirs: TempDirectory[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((d) => d.cleanup())));

function limits(overrides: Partial<SkillSnapshotLimitPolicy> = {}): SkillSnapshotLimitPolicy {
  return {
    maxManifestBytes: 4096,
    maxEntries: 16,
    maxDepth: 8,
    maxPathBytes: 128,
    maxFileBytes: 1024,
    maxAggregateFileBytes: 4096,
    ...overrides
  };
}

function manifestWith(paths: string[]): SnapshotManifest {
  return {
    schemaVersion: 1,
    entries: [
      { path: '.', type: 'directory' },
      ...paths.map((path) => ({ path, type: 'file' as const, executable: false, sha256: 'a'.repeat(64) }))
    ]
  };
}

function failureMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === null || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const candidate = error as { message?: unknown; cause?: unknown; errors?: unknown[] };
  return [
    ...(typeof candidate.message === 'string' ? [candidate.message] : []),
    ...failureMessages(candidate.cause, seen),
    ...(Array.isArray(candidate.errors) ? candidate.errors.flatMap((item) => failureMessages(item, seen)) : [])
  ];
}

async function makeManualSnapshot(
  directory: TempDirectory,
  manifest: SnapshotManifest,
  physicalFiles: readonly string[]
): Promise<{ home: string; digest: string; root: string }> {
  const home = await directory.mkdir('manual-home');
  const manifestBytes = encodeSnapshotManifest(manifest);
  const digest = createHash('sha256').update(manifestBytes).digest('hex');
  const root = await directory.mkdir(`manual-home/skill-snapshots/sha256/${digest}`);
  const artifact = await directory.mkdir(`manual-home/skill-snapshots/sha256/${digest}/artifact`);
  await directory.write(`manual-home/skill-snapshots/sha256/${digest}/manifest.json`, manifestBytes);
  for (const path of physicalFiles) await directory.write(`manual-home/skill-snapshots/sha256/${digest}/artifact/${path}`, path);
  if (process.platform !== 'win32') {
    for (const path of physicalFiles) await chmod(`${artifact}/${path}`, 0o400);
    await chmod(`${root}/manifest.json`, 0o400);
    await chmod(artifact, 0o500);
    await chmod(root, 0o500);
  }
  return { home, digest, root };
}

describe('Skill snapshots', () => {
  it('captures files, empty directories, executable state and canonical identity', async () => {
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.mkdir('source/empty'); await d.write('source/a.txt', 'a\n'); await d.write('source/z.sh', '#!/bin/sh\n'); await d.write('source/\uE000', 'bmp'); await d.write('source/𐀀', 'astral');
    if (process.platform !== 'win32') await chmod(d.path('source/z.sh'), 0o755);
    const published = await publishSkillSnapshot(d.path('home'), source);
    expect(published.manifest.entries.map((e) => e.path)).toEqual(['.', 'a.txt', 'empty', 'z.sh', '\uE000', '𐀀']);
    expect(published.digest).toBe(createHash('sha256').update(encodeSnapshotManifest(published.manifest)).digest('hex'));
    await expect(verifySkillSnapshot(d.path('home'), published.digest)).resolves.toMatchObject({ digest: published.digest });
    expect(await readFile(`${published.artifactPath}/a.txt`, 'utf8')).toBe('a\n');
    if (process.platform !== 'win32') {
      expect((await lstat(published.snapshotRoot)).mode & 0o777).toBe(0o500);
      expect((await lstat(`${published.snapshotRoot}/manifest.json`)).mode & 0o777).toBe(0o400);
      expect((await lstat(published.artifactPath)).mode & 0o777).toBe(0o500);
      expect((await lstat(`${published.artifactPath}/a.txt`)).mode & 0o777).toBe(0o400);
      expect((await lstat(`${published.artifactPath}/z.sh`)).mode & 0o777).toBe(0o500);
    }
  });
  it('normalizes the complete staged snapshot before publication', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    let observed = false;
    await publishSkillSnapshot(d.path('home'), source, {
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
  it('does not chmod or publish staged files replaced by external hardlinks or symlinks', async () => {
    if (process.platform === 'win32') return;
    for (const replacement of ['hardlink', 'symlink'] as const) {
      const d = await createTempDirectory(); dirs.push(d);
      const source = await d.mkdir(`${replacement}-normalization-source`);
      await d.write(`${replacement}-normalization-source/a`, 'same');
      await d.write(`${replacement}-external`, 'same');
      const external = d.path(`${replacement}-external`);
      await chmod(external, 0o600);
      const home = d.path(`${replacement}-normalization-home`);
      await expect(publishSkillSnapshot(home, source, {
        beforeStagedDirectoryNormalization: async (staging) => {
          const stagedFile = `${staging}/artifact/a`;
          await rm(stagedFile);
          if (replacement === 'hardlink') await link(external, stagedFile);
          else await symlink(external, stagedFile);
        }
      })).rejects.toThrow(/corrupt|publish/u);
      expect((await lstat(external)).mode & 0o777).toBe(0o600);
      const stored = await readdir(snapshotStoreRoot(home));
      expect(stored.filter((name) => !name.startsWith('.staging-'))).toEqual([]);
      expect(stored.filter((name) => name.startsWith('.staging-'))).toHaveLength(1);
    }
  });
  it('reuses verified content and rejects corruption', async () => {
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    const first = await publishSkillSnapshot(d.path('home'), source); const second = await publishSkillSnapshot(d.path('home'), source); expect(second.snapshotRoot).toBe(first.snapshotRoot);
    await chmod(`${first.artifactPath}/a`, 0o600).catch(() => undefined); await writeFile(`${first.artifactPath}/a`, 'two');
    await expect(verifySkillSnapshot(d.path('home'), first.digest)).rejects.toThrow(/corrupt/u);
    await expect(publishSkillSnapshot(d.path('home'), source)).rejects.toThrow(/corrupt/u);
  });
  it('rejects writable or mode-drifted published snapshots', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    const published = await publishSkillSnapshot(d.path('home'), source);
    await chmod(`${published.snapshotRoot}/manifest.json`, 0o600);
    await expect(verifySkillSnapshot(d.path('home'), published.digest)).rejects.toThrow(/mode/u);
    await chmod(`${published.snapshotRoot}/manifest.json`, 0o400);
    await chmod(published.artifactPath, 0o700);
    await expect(verifySkillSnapshot(d.path('home'), published.digest)).rejects.toThrow(/mode/u);
  });
  it('rejects substituted manifest and artifact file identities without following links', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    const published = await publishSkillSnapshot(d.path('home'), source);
    await chmod(published.snapshotRoot, 0o700);
    const manifest = `${published.snapshotRoot}/manifest.json`;
    await d.write('replacement-manifest', await readFile(manifest));
    await chmod(manifest, 0o600); await symlink(d.path('replacement-manifest'), `${manifest}.link`);
    await rename(`${manifest}.link`, manifest);
    await expect(verifySkillSnapshot(d.path('home'), published.digest)).rejects.toThrow(/corrupt/u);
  });
  it('rejects artifact directory substitution while its physical handle is held', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    const published = await publishSkillSnapshot(d.path('home'), source);
    await expect(verifySkillSnapshot(d.path('home'), published.digest, {
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
    const published = await publishSkillSnapshot(d.path('home'), source);
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
  it('cleans private staging when publication is interrupted', async () => {
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.write('source/a', 'one');
    await expect(publishSkillSnapshot(d.path('home'), source, { beforePublish: async () => { throw new Error('stop'); } })).rejects.toThrow(/publish/i);
    expect((await readdir(snapshotStoreRoot(d.path('home')))).filter((name) => name.startsWith('.staging-'))).toEqual([]);
  });

  it('removes an empty staged root whose private mode was masked by the process umask', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('restrictive-umask-source');
    await d.write('restrictive-umask-source/a', 'one');
    const home = d.path('restrictive-umask-home');
    const previousUmask = process.umask(0o777);
    let failure: unknown;
    try {
      await publishSkillSnapshot(home, source);
    } catch (error) {
      failure = error;
    } finally {
      process.umask(previousUmask);
    }
    expect(failureMessages(failure).join('\n')).toMatch(/private mode|publish/u);
    expect((await readdir(snapshotStoreRoot(home))).filter((name) => name.startsWith('.staging-'))).toEqual([]);
  });
  it('rejects artifact/storage overlap', async () => {
    const d = await createTempDirectory(); dirs.push(d); const home = await d.mkdir('home'); await d.write('home/SKILL.md', 'x');
    await expect(publishSkillSnapshot(home, home)).rejects.toMatchObject({ code: 'SKILL_SNAPSHOT_PATH_OVERLAP' });
  });
  it('rejects links and resolves contained physical directories', async () => {
    const d = await createTempDirectory(); dirs.push(d); const source = await d.mkdir('source'); await d.mkdir('source/nested'); await d.write('outside', 'x'); await symlink(d.path('outside'), d.path('source/link'));
    await expect(publishSkillSnapshot(d.path('home'), source)).rejects.toThrow(/symbolic link/u);
    await expect(resolvePhysicalRelativeDirectory(source, 'nested')).resolves.toBe(await realpath(d.path('source/nested')));
    await expect(resolvePhysicalRelativeDirectory(source, '../x')).rejects.toThrow(/Invalid/u);
  });

  it('exports the exact production snapshot ceilings and refuses raised policies', () => {
    expect(SKILL_SNAPSHOT_LIMITS).toEqual({
      maxManifestBytes: 4 * 1024 * 1024,
      maxEntries: 8192,
      maxDepth: 32,
      maxPathBytes: 4096,
      maxFileBytes: 64 * 1024 * 1024,
      maxAggregateFileBytes: 512 * 1024 * 1024
    });
    expect(Object.isFrozen(SKILL_SNAPSHOT_LIMITS)).toBe(true);
    for (const key of Object.keys(SKILL_SNAPSHOT_LIMITS) as Array<keyof SkillSnapshotLimitPolicy>) {
      expect(() => decodeSnapshotManifest(
        manifestWith([]),
        { ...SKILL_SNAPSHOT_LIMITS, [key]: SKILL_SNAPSHOT_LIMITS[key] + 1 }
      )).toThrow(/limit policy|must be an integer/u);
    }
  });

  it('enforces manifest byte limits below, at, and above the canonical size', () => {
    const manifest = manifestWith([]);
    const byteCount = encodeSnapshotManifest(manifest).byteLength;
    expect(encodeSnapshotManifest(manifest, limits({ maxManifestBytes: byteCount + 1 }))).toHaveLength(byteCount);
    expect(encodeSnapshotManifest(manifest, limits({ maxManifestBytes: byteCount }))).toHaveLength(byteCount);
    expect(() => encodeSnapshotManifest(manifest, limits({ maxManifestBytes: byteCount - 1 }))).toThrow(/manifest exceeds/u);
  });

  it('enforces declared entry limits below, at, and above', () => {
    expect(() => decodeSnapshotManifest(manifestWith([]), limits({ maxEntries: 2 }))).not.toThrow();
    expect(() => decodeSnapshotManifest(manifestWith(['a']), limits({ maxEntries: 2 }))).not.toThrow();
    expect(() => decodeSnapshotManifest(manifestWith(['a', 'b']), limits({ maxEntries: 2 }))).toThrow(/2-entry/u);
  });

  it('enforces declared depth limits below, at, and above', () => {
    expect(() => decodeSnapshotManifest(manifestWith(['a']), limits({ maxDepth: 2 }))).not.toThrow();
    expect(() => decodeSnapshotManifest(manifestWith(['a/b']), limits({ maxDepth: 2 }))).not.toThrow();
    expect(() => decodeSnapshotManifest(manifestWith(['a/b/c']), limits({ maxDepth: 2 }))).toThrow(/2-level/u);
  });

  it('enforces UTF-8 path-byte limits below, at, and above', () => {
    expect(Buffer.byteLength('é', 'utf8')).toBe(2);
    expect(() => decodeSnapshotManifest(manifestWith(['a']), limits({ maxPathBytes: 2 }))).not.toThrow();
    expect(() => decodeSnapshotManifest(manifestWith(['é']), limits({ maxPathBytes: 2 }))).not.toThrow();
    expect(() => decodeSnapshotManifest(manifestWith(['é']), limits({ maxPathBytes: 1 }))).toThrow(/1-byte/u);
  });

  it('enforces individual file limits below, at, and above', async () => {
    for (const [name, contents, shouldPass] of [
      ['below', 'aa', true],
      ['at', 'aaa', true],
      ['above', 'aaaa', false]
    ] as const) {
      const d = await createTempDirectory(); dirs.push(d);
      const source = await d.mkdir(`${name}-source`);
      await d.write(`${name}-source/file`, contents);
      const publication = publishSkillSnapshot(d.path(`${name}-home`), source, {
        limitPolicy: limits({ maxFileBytes: 3, maxAggregateFileBytes: 10 })
      });
      if (shouldPass) await expect(publication).resolves.toMatchObject({ manifest: { schemaVersion: 1 } });
      else await expect(publication).rejects.toThrow(/3-byte limit/u);
    }
  });

  it('enforces aggregate logical file sizes below, at, and above', async () => {
    for (const [name, sizes, shouldPass] of [
      ['below', [1, 1], true],
      ['at', [1, 2], true],
      ['above', [2, 2], false]
    ] as const) {
      const d = await createTempDirectory(); dirs.push(d);
      const source = await d.mkdir(`${name}-aggregate-source`);
      for (const [index, size] of sizes.entries()) await d.write(`${name}-aggregate-source/${index}`, 'x'.repeat(size));
      const publication = publishSkillSnapshot(d.path(`${name}-aggregate-home`), source, {
        limitPolicy: limits({ maxFileBytes: 4, maxAggregateFileBytes: 3 })
      });
      if (shouldPass) await expect(publication).resolves.toMatchObject({ manifest: { schemaVersion: 1 } });
      else await expect(publication).rejects.toThrow(/3-byte aggregate limit/u);
    }
  });

  it('reuses and cleans staging at exact lowered tree and byte ceilings', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('exact-cleanup-source');
    await d.write('exact-cleanup-source/a', 'abc');
    const policy = limits({ maxEntries: 2, maxFileBytes: 3, maxAggregateFileBytes: 3 });
    const first = await publishSkillSnapshot(d.path('exact-cleanup-home'), source, { limitPolicy: policy });
    const second = await publishSkillSnapshot(d.path('exact-cleanup-home'), source, { limitPolicy: policy });
    expect(second.digest).toBe(first.digest);
    expect((await readdir(snapshotStoreRoot(d.path('exact-cleanup-home')))).filter((name) => name.startsWith('.staging-'))).toEqual([]);
  });

  it('copies an injected policy before asynchronous filesystem work', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('copied-policy-source');
    await d.write('copied-policy-source/a', 'a');
    const policy = limits();
    const publication = publishSkillSnapshot(d.path('copied-policy-home'), source, { limitPolicy: policy });
    policy.maxEntries = 1;
    await expect(publication).resolves.toMatchObject({ manifest: { entries: [{ path: '.', type: 'directory' }, { path: 'a', type: 'file' }] } });
  });

  it('rejects a physical tree over the entry limit even when its manifest is small', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const snapshot = await makeManualSnapshot(d, manifestWith([]), ['a', 'b']);
    await expect(verifySkillSnapshot(snapshot.home, snapshot.digest, {
      limitPolicy: limits({ maxEntries: 2 })
    })).rejects.toThrow(/2-entry limit/u);
  });

  it('enforces raw manifest reads below, at, and above the byte limit before JSON parsing', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const snapshot = await makeManualSnapshot(d, manifestWith([]), []);
    const manifestLength = (await readFile(`${snapshot.root}/manifest.json`)).byteLength;
    await expect(verifySkillSnapshot(snapshot.home, snapshot.digest, {
      limitPolicy: limits({ maxManifestBytes: manifestLength + 1 })
    })).resolves.toMatchObject({ digest: snapshot.digest });
    await expect(verifySkillSnapshot(snapshot.home, snapshot.digest, {
      limitPolicy: limits({ maxManifestBytes: manifestLength })
    })).resolves.toMatchObject({ digest: snapshot.digest });
    if (process.platform !== 'win32') await chmod(snapshot.root, 0o700);
    await chmod(`${snapshot.root}/manifest.json`, 0o600).catch(() => undefined);
    const oversized = Buffer.alloc(65, 0x20);
    await writeFile(`${snapshot.root}/manifest.json`, oversized);
    if (process.platform !== 'win32') {
      await chmod(`${snapshot.root}/manifest.json`, 0o400);
      await chmod(snapshot.root, 0o500);
    }
    await expect(verifySkillSnapshot(snapshot.home, snapshot.digest, {
      limitPolicy: limits({ maxManifestBytes: 64 })
    })).rejects.toThrow(/64-byte limit|changed during inspection/u);
  });

  it('enforces physical depth below, at, and above on publication and verification', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('depth-source');
    await d.write('depth-source/a/b/file', 'x');
    const below = await publishSkillSnapshot(d.path('depth-below-home'), source, {
      limitPolicy: limits({ maxDepth: 4 })
    });
    await expect(publishSkillSnapshot(d.path('depth-at-home'), source, {
      limitPolicy: limits({ maxDepth: 3 })
    })).resolves.toMatchObject({ manifest: { schemaVersion: 1 } });
    await expect(publishSkillSnapshot(d.path('depth-above-home'), source, {
      limitPolicy: limits({ maxDepth: 2 })
    })).rejects.toThrow(/2-level/u);
    await expect(verifySkillSnapshot(d.path('depth-below-home'), below.digest, {
      limitPolicy: limits({ maxDepth: 4 })
    })).resolves.toMatchObject({ digest: below.digest });
    await expect(verifySkillSnapshot(d.path('depth-below-home'), below.digest, {
      limitPolicy: limits({ maxDepth: 3 })
    })).resolves.toMatchObject({ digest: below.digest });
    await expect(verifySkillSnapshot(d.path('depth-below-home'), below.digest, {
      limitPolicy: limits({ maxDepth: 2 })
    })).rejects.toThrow(/2-level/u);
  });

  it('enforces physical UTF-8 path bytes below, at, and above on publication and verification', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('path-source');
    await d.write('path-source/éé', 'x');
    expect(Buffer.byteLength('éé', 'utf8')).toBe(4);
    const below = await publishSkillSnapshot(d.path('path-below-home'), source, {
      limitPolicy: limits({ maxPathBytes: 5 })
    });
    await expect(publishSkillSnapshot(d.path('path-at-home'), source, {
      limitPolicy: limits({ maxPathBytes: 4 })
    })).resolves.toMatchObject({ manifest: { schemaVersion: 1 } });
    await expect(publishSkillSnapshot(d.path('path-above-home'), source, {
      limitPolicy: limits({ maxPathBytes: 3 })
    })).rejects.toThrow(/3-byte/u);
    await expect(verifySkillSnapshot(d.path('path-below-home'), below.digest, {
      limitPolicy: limits({ maxPathBytes: 5 })
    })).resolves.toMatchObject({ digest: below.digest });
    await expect(verifySkillSnapshot(d.path('path-below-home'), below.digest, {
      limitPolicy: limits({ maxPathBytes: 4 })
    })).resolves.toMatchObject({ digest: below.digest });
    await expect(verifySkillSnapshot(d.path('path-below-home'), below.digest, {
      limitPolicy: limits({ maxPathBytes: 3 })
    })).rejects.toThrow(/3-byte/u);
  });

  it('enforces physical file bytes below, at, and above during verification', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('verify-file-source');
    await d.write('verify-file-source/a', 'abc');
    const published = await publishSkillSnapshot(d.path('verify-file-home'), source, {
      limitPolicy: limits({ maxFileBytes: 4 })
    });
    await expect(verifySkillSnapshot(d.path('verify-file-home'), published.digest, {
      limitPolicy: limits({ maxFileBytes: 4 })
    })).resolves.toMatchObject({ digest: published.digest });
    await expect(verifySkillSnapshot(d.path('verify-file-home'), published.digest, {
      limitPolicy: limits({ maxFileBytes: 3 })
    })).resolves.toMatchObject({ digest: published.digest });
    await expect(verifySkillSnapshot(d.path('verify-file-home'), published.digest, {
      limitPolicy: limits({ maxFileBytes: 2 })
    })).rejects.toThrow(/2-byte/u);
  });

  it('enforces physical aggregate bytes below, at, and above during verification', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('verify-aggregate-source');
    await d.write('verify-aggregate-source/a', 'a');
    await d.write('verify-aggregate-source/b', 'bc');
    const published = await publishSkillSnapshot(d.path('verify-aggregate-home'), source, {
      limitPolicy: limits({ maxAggregateFileBytes: 4 })
    });
    await expect(verifySkillSnapshot(d.path('verify-aggregate-home'), published.digest, {
      limitPolicy: limits({ maxAggregateFileBytes: 4 })
    })).resolves.toMatchObject({ digest: published.digest });
    await expect(verifySkillSnapshot(d.path('verify-aggregate-home'), published.digest, {
      limitPolicy: limits({ maxAggregateFileBytes: 3 })
    })).resolves.toMatchObject({ digest: published.digest });
    await expect(verifySkillSnapshot(d.path('verify-aggregate-home'), published.digest, {
      limitPolicy: limits({ maxAggregateFileBytes: 2 })
    })).rejects.toThrow(/2-byte aggregate/u);
  });

  it('stops concurrent growth one byte beyond the aggregate allowance on publish and verify', async () => {
    const publishDirectory = await createTempDirectory(); dirs.push(publishDirectory);
    const publishSource = await publishDirectory.mkdir('aggregate-growth-source');
    await publishDirectory.write('aggregate-growth-source/a', 'ab');
    let publishFailure: unknown;
    try {
      await publishSkillSnapshot(publishDirectory.path('aggregate-growth-home'), publishSource, {
        limitPolicy: limits({ maxFileBytes: 10, maxAggregateFileBytes: 3 }),
        duringSourceFileCopy: async (path) => { await appendFile(path, 'cd'); }
      });
    } catch (error) {
      publishFailure = error;
    }
    expect(failureMessages(publishFailure).join('\n')).toMatch(/changed during copy/u);

    const verifyDirectory = await createTempDirectory(); dirs.push(verifyDirectory);
    const verifySource = await verifyDirectory.mkdir('aggregate-growth-source');
    await verifyDirectory.write('aggregate-growth-source/a', 'ab');
    const published = await publishSkillSnapshot(verifyDirectory.path('aggregate-growth-home'), verifySource, {
      limitPolicy: limits({ maxFileBytes: 10, maxAggregateFileBytes: 4 })
    });
    let verifyFailure: unknown;
    try {
      await verifySkillSnapshot(verifyDirectory.path('aggregate-growth-home'), published.digest, {
        limitPolicy: limits({ maxFileBytes: 10, maxAggregateFileBytes: 3 }),
        duringArtifactFileHash: async (path) => {
          if (process.platform !== 'win32') await chmod(path, 0o600);
          await appendFile(path, 'cd');
        }
      });
    } catch (error) {
      verifyFailure = error;
    }
    expect(failureMessages(verifyFailure).join('\n')).toMatch(/identity|applicable file limit/u);
  });

  it('rejects zero-progress destination writes without looping', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('zero-progress-source');
    await d.write('zero-progress-source/a', 'abc');
    let writes = 0;
    let failure: unknown;
    try {
      await publishSkillSnapshot(d.path('zero-progress-home'), source, {
        destinationWrite: () => { writes += 1; return 0; }
      });
    } catch (error) {
      failure = error;
    }
    expect(failureMessages(failure).join('\n')).toMatch(/zero or invalid progress/u);
    expect(writes).toBe(1);
    expect((await readdir(snapshotStoreRoot(d.path('zero-progress-home')))
      .then((names) => names.filter((name) => name.startsWith('.staging-'))))).toEqual([]);
  });

  it('cleans an owned manifest after a zero-progress manifest write', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('manifest-zero-progress-source');
    const home = d.path('manifest-zero-progress-home');
    await expect(publishSkillSnapshot(home, source, {
      destinationWrite: () => 0
    })).rejects.toThrow(/manifest|progress|publish/u);
    expect((await readdir(snapshotStoreRoot(home))).filter((name) => name.startsWith('.staging-'))).toEqual([]);
  });

  it('turns file, manifest, and directory close failures into publication failures', async () => {
    for (const target of ['source-file', 'destination-file', 'manifest-file', 'enumeration-directory'] as const) {
      const d = await createTempDirectory(); dirs.push(d);
      const source = await d.mkdir(`${target}-close-source`);
      await d.write(`${target}-close-source/a`, 'abc');
      let failed = false;
      await expect(publishSkillSnapshot(d.path(`${target}-close-home`), source, {
        afterHandleClose: (closedTarget) => {
          if (!failed && closedTarget === target) {
            failed = true;
            throw new Error(`injected ${target} close failure`);
          }
        }
      })).rejects.toThrow(/close|publish/u);
      expect(failed).toBe(true);
      if (target === 'source-file' || target === 'destination-file' || target === 'manifest-file') {
        expect((await readdir(snapshotStoreRoot(d.path(`${target}-close-home`))))
          .filter((name) => name.startsWith('.staging-'))).toEqual([]);
      }
    }
  });

  it('turns manifest, file, enumeration, and held-directory close failures into verification failures', async () => {
    for (const target of [
      'manifest-file',
      'source-file',
      'enumeration-directory',
      'artifact-root-directory',
      'snapshot-root-directory'
    ] as const) {
      const d = await createTempDirectory(); dirs.push(d);
      const source = await d.mkdir(`${target}-verify-source`);
      await d.write(`${target}-verify-source/a`, 'abc');
      const published = await publishSkillSnapshot(d.path(`${target}-verify-home`), source);
      let failed = false;
      await expect(verifySkillSnapshot(d.path(`${target}-verify-home`), published.digest, {
        afterHandleClose: (closedTarget) => {
          if (!failed && closedTarget === target) {
            failed = true;
            throw new Error(`injected ${target} close failure`);
          }
        }
      })).rejects.toThrow(/close|corrupt/u);
      expect(failed).toBe(true);
    }
  });

  it('preserves the copy failure when source close also fails', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('combined-failure-source');
    await d.write('combined-failure-source/a', 'a');
    let failure: unknown;
    try {
      await publishSkillSnapshot(d.path('combined-failure-home'), source, {
        duringSourceFileCopy: async (path) => { await appendFile(path, 'bc'); },
        afterHandleClose: (target) => { if (target === 'source-file') throw new Error('injected source close failure'); }
      });
    } catch (error) {
      failure = error;
    }
    const messages = failureMessages(failure).join('\n');
    expect(messages).toMatch(/changed during copy/u);
    expect(messages).toMatch(/Could not close source-file/u);
  });

  it('refuses cleanup when an owned artifact file gains an external hardlink', async () => {
    if (process.platform === 'win32') return;
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('owned-hardlink-source');
    await d.write('owned-hardlink-source/a', 'owned bytes');
    const external = d.path('owned-hardlink-external');
    let staging = '';
    let failure: unknown;
    try {
      await publishSkillSnapshot(d.path('owned-hardlink-home'), source, {
        beforePublish: async (path) => {
          staging = path;
          await link(`${path}/artifact/a`, external);
          throw new Error('stop after linking owned file');
        }
      });
    } catch (error) {
      failure = error;
    }
    expect(failureMessages(failure).join('\n')).toMatch(/cleanup|linked|identity|publish/u);
    expect((await lstat(staging)).isDirectory()).toBe(true);
    expect(await readFile(external, 'utf8')).toBe('owned bytes');
    expect((await lstat(external)).mode & 0o777).toBe(0o400);
    expect((await lstat(external)).nlink).toBe(2);
  });

  it('retains a foreign cleanup-root substitution introduced before the final identity recheck', async () => {
    const d = await createTempDirectory(); dirs.push(d);
    const source = await d.mkdir('cleanup-substitution-source');
    await d.write('cleanup-substitution-source/a', 'owned');
    let staging = '';
    let cleanupArmed = false;
    let substituted = false;
    let failure: unknown;
    try {
      await publishSkillSnapshot(d.path('cleanup-substitution-home'), source, {
        beforePublish: async (path) => {
          staging = path;
          cleanupArmed = true;
          throw new Error('start cleanup substitution');
        },
        afterHandleClose: async (target, path) => {
          if (cleanupArmed && !substituted && target === 'cleanup-directory' && path === staging) {
            substituted = true;
            cleanupArmed = false;
            await rename(staging, `${staging}.owned`);
            await mkdir(staging, { mode: 0o700 });
            await writeFile(`${staging}/foreign`, 'foreign bytes');
          }
        }
      });
    } catch (error) {
      failure = error;
    }
    expect(substituted).toBe(true);
    expect(failureMessages(failure).join('\n')).toMatch(/cleanup.*identity|cleanup both failed|recursive removal/u);
    expect(await readFile(`${staging}/foreign`, 'utf8')).toBe('foreign bytes');
    expect((await lstat(`${staging}.owned`)).isDirectory()).toBe(true);
  });

  it('does not chmod symlink targets or hardlinked regular files during cleanup preparation', async () => {
    if (process.platform === 'win32') return;
    for (const entryKind of ['symlink', 'hardlink'] as const) {
      const d = await createTempDirectory(); dirs.push(d);
      const source = await d.mkdir(`${entryKind}-cleanup-source`);
      await d.write(`${entryKind}-cleanup-source/a`, 'abc');
      await d.write(`${entryKind}-external`, 'external');
      const external = d.path(`${entryKind}-external`);
      await chmod(external, 0o400);
      let staging = '';
      await expect(publishSkillSnapshot(d.path(`${entryKind}-cleanup-home`), source, {
        beforePublish: async (path) => {
          staging = path;
          const artifact = `${path}/artifact`;
          await chmod(artifact, 0o700);
          if (entryKind === 'symlink') await symlink(external, `${artifact}/foreign`);
          else await link(external, `${artifact}/foreign`);
          throw new Error('stop after foreign entry');
        }
      })).rejects.toThrow(/publish|cleanup/u);
      expect((await lstat(external)).mode & 0o777).toBe(0o400);
      expect((await lstat(staging)).isDirectory()).toBe(true);
    }
  });

  it('rejects source growth and pathname replacement during streamed copy', async () => {
    for (const mutation of ['growth', 'replacement'] as const) {
      const d = await createTempDirectory(); dirs.push(d);
      const source = await d.mkdir(`${mutation}-source`);
      const path = d.path(`${mutation}-source/a`);
      await d.write(`${mutation}-source/a`, 'a');
      let failure: unknown;
      try {
        await publishSkillSnapshot(d.path(`${mutation}-home`), source, {
          limitPolicy: limits(),
          duringSourceFileCopy: async (openedPath) => {
            expect(openedPath).toBe(path);
            if (mutation === 'growth') await appendFile(path, 'bc');
            else {
              await rename(path, `${path}.old`);
              await writeFile(path, 'a');
            }
          }
        });
      } catch (error) {
        failure = error;
      }
      expect(failureMessages(failure).join('\n')).toMatch(/changed during copy|directory.*changed/u);
      expect((await readdir(snapshotStoreRoot(d.path(`${mutation}-home`))))
        .filter((name) => name.startsWith('.staging-'))).toEqual([]);
    }
  });
});
