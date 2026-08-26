import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rename, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_EFFECTIVE_INSTRUCTION_BYTES,
  readPhysicalInstructionSnapshot,
  readUtf8InstructionFile,
  samePhysicalInstructionSnapshot
} from '../../../src/core/content.js';
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

describe('physical instruction snapshots', () => {
  it('retains exact multibyte bytes, physical identity, byte count, and SHA-256', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const exactBytes = Buffer.from('one\r\nmultibyte: é\n', 'utf8');
    const path = await directory.write('AGENTS.md', exactBytes);

    const snapshot = await readPhysicalInstructionSnapshot(path, 'Profile instructions');

    expect(snapshot.path).toBe(path);
    expect(snapshot.bytes).toEqual(Uint8Array.from(exactBytes));
    expect(snapshot.byteCount).toBe(exactBytes.byteLength);
    expect(snapshot.device).toBeTypeOf('bigint');
    expect(snapshot.inode).toBeTypeOf('bigint');
    expect(snapshot.contentSha256).toBe(createHash('sha256').update(exactBytes).digest('hex'));
  });

  it('accepts the exact authoritative limit and rejects one byte beyond it', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const exact = await directory.write('exact.md', Buffer.alloc(MAX_EFFECTIVE_INSTRUCTION_BYTES, 0x61));
    const oversized = await directory.write('oversized.md', Buffer.alloc(MAX_EFFECTIVE_INSTRUCTION_BYTES + 1, 0x61));

    await expect(readPhysicalInstructionSnapshot(exact, 'Profile instructions'))
      .resolves.toMatchObject({ byteCount: MAX_EFFECTIVE_INSTRUCTION_BYTES });
    await expect(readPhysicalInstructionSnapshot(oversized, 'Profile instructions'))
      .rejects.toThrow(new RegExp(`${MAX_EFFECTIVE_INSTRUCTION_BYTES}-byte instruction limit`, 'u'));
  });

  it.skipIf(process.platform === 'win32')('refuses symlinks and non-regular entries without waiting', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const target = await directory.write('target.md', 'instructions');
    const linked = directory.path('linked.md');
    await symlink(target, linked);
    const childDirectory = await directory.mkdir('instruction-directory');
    const fifo = directory.path('instructions.fifo');
    await execFileAsync('mkfifo', [fifo]);

    await expect(readPhysicalInstructionSnapshot(linked, 'Profile instructions'))
      .rejects.toThrow(/physical regular file/u);
    await expect(readPhysicalInstructionSnapshot(childDirectory, 'Profile instructions'))
      .rejects.toThrow(/physical regular file/u);
    await expect(readPhysicalInstructionSnapshot(fifo, 'Profile instructions'))
      .rejects.toThrow(/physical regular file/u);
  }, 2_000);

  it('refuses invalid UTF-8 and NUL bytes', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const invalid = await directory.write('invalid.md', Uint8Array.from([0xff]));
    const nul = await directory.write('nul.md', 'before\0after');

    await expect(readPhysicalInstructionSnapshot(invalid, 'Profile instructions'))
      .rejects.toThrow(/valid UTF-8/u);
    await expect(readPhysicalInstructionSnapshot(nul, 'Profile instructions'))
      .rejects.toThrow(/NUL/u);
  });

  it('escapes control characters in physical instruction paths', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const path = await directory.write('unsafe-\u001b[31m.md', Uint8Array.from([0xff]));

    let failure: unknown;
    try {
      await readPhysicalInstructionSnapshot(path, 'Profile instructions');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('unsafe-\\u001b[31m.md');
    expect((failure as Error).message).not.toContain('\u001b');
  });

  it('refuses in-place mutation even when size and mtime are restored', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const path = await directory.write('AGENTS.md', 'first');
    const before = await stat(path);

    await expect(readPhysicalInstructionSnapshot(path, 'Profile instructions', {
      afterRead: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(path, 'other');
        await utimes(path, before.atime, before.mtime);
      }
    })).rejects.toThrow(/changed while being read/u);
  });

  it('refuses pathname replacement after reading the opened file', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const path = await directory.write('AGENTS.md', 'first');
    const moved = directory.path('moved.md');

    await expect(readPhysicalInstructionSnapshot(path, 'Profile instructions', {
      afterRead: async () => {
        await rename(path, moved);
        await writeFile(path, 'first');
      }
    })).rejects.toThrow(/changed while being read/u);
  });

  it('surfaces close failure after a successful snapshot and preserves a primary read error', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const valid = await directory.write('valid.md', 'instructions');
    const invalid = await directory.write('invalid.md', Uint8Array.from([0xff]));

    const failClose = () => {
      throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
    };
    await expect(readPhysicalInstructionSnapshot(valid, 'Profile instructions', {
      afterClose: failClose
    })).rejects.toThrow(/Could not close profile instructions.*\(EIO\)/u);

    await expect(readPhysicalInstructionSnapshot(invalid, 'Profile instructions', {
      afterClose: failClose
    })).rejects.toThrow(/not valid UTF-8/u);
  });

  it('compares physical identity and exact captured content', async () => {
    const directory = await createTempDirectory();
    temporaryDirectories.push(directory);
    const path = await directory.write('AGENTS.md', 'first');
    const initial = await readPhysicalInstructionSnapshot(path, 'Profile instructions');
    const same = await readPhysicalInstructionSnapshot(path, 'Profile instructions');
    expect(samePhysicalInstructionSnapshot(initial, same)).toBe(true);

    await directory.write('AGENTS.md', 'other');
    const changed = await readPhysicalInstructionSnapshot(path, 'Profile instructions');
    expect(samePhysicalInstructionSnapshot(initial, changed)).toBe(false);
    expect(samePhysicalInstructionSnapshot(initial, { ...initial, bytes: Uint8Array.from(Buffer.from('xxxxx')) })).toBe(false);
  });
});
