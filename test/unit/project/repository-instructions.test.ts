import { symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRootRepositoryInstructions } from '../../../src/project/repository-instructions.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('root repository instructions', () => {
  it('allows a missing root AGENTS.md and ignores nested files', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    await directory.write('nested/AGENTS.md', 'nested only');
    await expect(loadRootRepositoryInstructions(directory.root)).resolves.toBeUndefined();
  });

  it('loads only root AGENTS.md', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const path = await directory.write('AGENTS.md', 'root instructions');
    await expect(loadRootRepositoryInstructions(directory.root)).resolves.toEqual({
      path,
      text: 'root instructions'
    });
  });

  it('follows a trusted AGENTS.md symlink as an explicit prototype assumption', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const repository = await directory.mkdir('repository');
    const target = await directory.write('trusted-outside.md', 'trusted linked instructions');
    const path = directory.path('repository/AGENTS.md');
    await symlink(target, path);

    await expect(loadRootRepositoryInstructions(repository)).resolves.toEqual({
      path,
      text: 'trusted linked instructions'
    });
  });
});
