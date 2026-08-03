import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { readUtf8InstructionFile } from '../../../src/core/content.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('bounded instruction file reads', () => {
  it('accepts the exact byte limit and rejects one byte beyond it', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const exact = await directory.write('exact.md', 'éab');
    const oversized = await directory.write('oversized.md', 'éabc');

    await expect(readUtf8InstructionFile(exact, 'Test instructions', 4))
      .resolves.toBe('éab');
    await expect(readUtf8InstructionFile(oversized, 'Test instructions', 4))
      .rejects.toThrow(/4-byte instruction limit/u);
  });

  it('inspects the opened handle and rejects non-regular files', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const path = await directory.mkdir('instructions-directory');

    await expect(readUtf8InstructionFile(path, 'Test instructions'))
      .rejects.toThrow(/not a regular file/u);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a POSIX FIFO without waiting for a writer',
    async () => {
      const directory = await createTempDirectory();
      temporaryDirectories.push(directory);
      const fifo = directory.path('instructions.fifo');
      await execFileAsync('mkfifo', [fifo]);

      await expect(readUtf8InstructionFile(fifo, 'Test instructions'))
        .rejects.toThrow(/not a regular file/u);
    },
    2_000
  );

  it('validates UTF-8 and NUL after a bounded read', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const invalid = await directory.write('invalid.md', Uint8Array.from([0xff]));
    const nul = await directory.write('nul.md', 'before\0after');

    await expect(readUtf8InstructionFile(invalid, 'Test instructions'))
      .rejects.toThrow(/valid UTF-8/u);
    await expect(readUtf8InstructionFile(nul, 'Test instructions'))
      .rejects.toThrow(/NUL/u);
  });
});
