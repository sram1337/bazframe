import { chmod, realpath } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findGitRoot } from '../../../src/project/git-root.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('Git worktree root detection', () => {
  it('finds the same root from the root and a nested directory with spaces', async () => {
    const directory = await createTempDirectory('bazframe git root ');
    temporaryDirectories.push(directory);
    const root = await directory.initGit('repository with spaces');
    const nested = await directory.mkdir('repository with spaces/packages/api');

    const physicalRoot = await realpath(root);
    await expect(findGitRoot(root)).resolves.toBe(physicalRoot);
    await expect(findGitRoot(nested)).resolves.toBe(physicalRoot);
  });

  it('rejects a directory outside a Git worktree', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    await expect(findGitRoot(directory.root)).rejects.toThrow(/not inside a Git worktree/u);
  });

  it('clears GIT_DIR and GIT_WORK_TREE instead of selecting another repository', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const expectedRoot = await directory.initGit('expected');
    const overrideRoot = await directory.initGit('override');

    await expect(findGitRoot(expectedRoot, {
      ...process.env,
      GIT_DIR: directory.path('override/.git'),
      GIT_WORK_TREE: overrideRoot
    })).resolves.toBe(await realpath(expectedRoot));
  });

  it('rejects a Git result that does not contain the canonical cwd', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const cwd = await directory.mkdir('caller');
    const unrelatedRoot = await directory.mkdir('unrelated');
    const bin = await directory.mkdir('bin');
    const fakeGit = await directory.write(
      'bin/git',
      '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_GIT_ROOT"\n'
    );
    await chmod(fakeGit, 0o755);

    await expect(findGitRoot(cwd, {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_GIT_ROOT: unrelatedRoot
    })).rejects.toThrow(/does not contain the current directory/u);
  });
});
