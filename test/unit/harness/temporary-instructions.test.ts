import { readdir, readFile, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTemporaryInstructionFile } from '../../../src/harness/temporary-instructions.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('temporary effective instructions', () => {
  it('creates an external file with exact content and mode 0600, then cleans it up', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const repository = await directory.mkdir('repository');
    const temporaryRoot = await directory.mkdir('external-temporary-root');
    const contents = 'sensitive effective instructions\nΩ\n';

    const temporary = await createTemporaryInstructionFile(
      contents,
      repository,
      temporaryRoot
    );

    expect(await readFile(temporary.path, 'utf8')).toBe(contents);
    if (process.platform !== 'win32') {
      expect((await stat(temporary.path)).mode & 0o777).toBe(0o600);
    }

    await temporary.cleanup();
    await expect(stat(temporary.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['temporary-root', '..tmp'])(
    'rejects an inside-repository temporary root named %s without creating a file',
    async (childName) => {
      const directory = await createTempDirectory();
      temporaryDirectories.push(directory);
      const repository = await directory.mkdir('repository');
      const insideRoot = await directory.mkdir(`repository/${childName}`);

      await expect(createTemporaryInstructionFile('secret', repository, insideRoot))
        .rejects.toThrow(/temporary directory is inside the repository/u);
      expect(await readdir(insideRoot)).toEqual([]);
    }
  );
});
