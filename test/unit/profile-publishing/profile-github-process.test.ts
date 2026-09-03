import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { createOwnedProfileGithubDirectory, createProfileGithubIsolation } from '../../../src/profile-publishing/profile-github-process.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

describe('profile GitHub owned-directory disposal', () => {
  it('retains nested workspace state without traversing files or following links', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('workspaces');
    const outside = await temporary.mkdir('outside');
    await writeFile(join(outside, 'keep.txt'), 'keep\n');
    const owned = await createOwnedProfileGithubDirectory(parent, 'workspace-');
    await mkdir(join(owned.path, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(owned.path, 'nested', 'deeper', 'data.bin'), Buffer.alloc(64 * 1024, 1));
    await symlink(outside, join(owned.path, 'outside-link'));

    await expect(owned.dispose()).resolves.toEqual({ disposition: 'retained', identityProved: true });

    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(await readdir(parent)).toEqual([basename(owned.path)]);
    expect(await readFile(join(owned.path, 'nested', 'deeper', 'data.bin'))).toHaveLength(64 * 1024);
    await expect(owned.dispose()).resolves.toEqual({ disposition: 'retained', identityProved: true });
  });

  it('retains a successful process isolation under its private random path', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('isolations');
    const isolation = await createProfileGithubIsolation(parent, { PATH: process.env.PATH });
    await writeFile(join(isolation.home, 'temporary.txt'), 'temporary\n');

    await expect(isolation.dispose()).resolves.toEqual({ disposition: 'retained', identityProved: true });

    expect(await readdir(parent)).toEqual([basename(isolation.root)]);
    expect(await readFile(join(isolation.home, 'temporary.txt'), 'utf8')).toBe('temporary\n');
  });

  it('retains the exact workspace and fails closed when disposal proof is injected to fail', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('workspaces');
    let proofHooks = 0;
    const owned = await createOwnedProfileGithubDirectory(parent, 'workspace-', { injectCleanupFailure: true, afterCleanupReady: () => { proofHooks += 1; } });
    await writeFile(join(owned.path, 'keep.txt'), 'retained\n');
    const first = owned.dispose();
    const second = owned.dispose();
    expect(second).toBe(first);

    await expect(first).rejects.toMatchObject({
      code: 'PROFILE_GITHUB_CLEANUP_UNPROVEN',
      message: expect.not.stringContaining(owned.path)
    });
    await expect(second).rejects.toMatchObject({ code: 'PROFILE_GITHUB_CLEANUP_UNPROVEN' });
    expect(proofHooks).toBe(1);

    expect(await readdir(parent)).toEqual([basename(owned.path)]);
    expect(await readFile(join(owned.path, 'keep.txt'), 'utf8')).toBe('retained\n');
  });

  it('disposes a deep over-limit tree in bounded time by retaining it without traversal', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('workspaces');
    const owned = await createOwnedProfileGithubDirectory(parent, 'workspace-');
    let nested = owned.path;
    for (let index = 0; index < 65; index += 1) {
      nested = join(nested, `d${index}`);
      await mkdir(nested);
    }
    await writeFile(join(nested, 'keep.txt'), 'too deep\n');
    const started = Date.now();

    await expect(owned.dispose()).resolves.toEqual({ disposition: 'retained', identityProved: true });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(await readFile(join(nested, 'keep.txt'), 'utf8')).toBe('too deep\n');
  });

  it('never deletes either directory when the retained pathname is substituted', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('workspaces');
    const saved = join(parent, 'saved-original');
    const owned = await createOwnedProfileGithubDirectory(parent, 'workspace-', {
      afterCleanupQuarantined: async (retainedPath) => {
        await rename(retainedPath, saved);
        await mkdir(retainedPath);
        await writeFile(join(retainedPath, 'attacker.txt'), 'must survive\n');
      }
    });
    await writeFile(join(owned.path, 'owned.txt'), 'owned\n');

    await expect(owned.dispose()).rejects.toMatchObject({ code: 'PROFILE_GITHUB_CLEANUP_UNPROVEN' });

    expect(await readFile(join(owned.path, 'attacker.txt'), 'utf8')).toBe('must survive\n');
    expect(await readFile(join(saved, 'owned.txt'), 'utf8')).toBe('owned\n');
  });
});
