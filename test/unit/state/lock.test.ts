import { readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { withStateLock } from '../../../src/state/lock.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

async function temporary(): Promise<TempDirectory> {
  const directory = await createTempDirectory();
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('state locks', () => {
  it('holds a lock for an operation and releases it after success', async () => {
    const directory = await temporary();
    const root = directory.path('home');
    const lock = directory.path('home/locks/state.lock');

    await expect(withStateLock(
      lock,
      { command: 'test', target: 'state' },
      async () => 'done',
      { managedRoot: root }
    )).resolves.toBe('done');
    expect(await readdir(directory.path('home/locks'))).toEqual([]);
  });

  it('releases its lock when the operation fails', async () => {
    const directory = await temporary();
    const root = directory.path('home');
    const lock = directory.path('home/locks/state.lock');

    await expect(withStateLock(
      lock,
      { command: 'test', target: 'state' },
      async () => { throw new Error('operation failed'); },
      { managedRoot: root }
    )).rejects.toThrow(/operation failed/u);
    expect(await readdir(directory.path('home/locks'))).toEqual([]);
  });

  it('reports a live lock with its owner and target', async () => {
    const directory = await temporary();
    const root = directory.path('home');
    const lock = await directory.write('home/locks/state.lock', `${JSON.stringify({
      schemaVersion: 1,
      pid: 42,
      createdAt: '2026-01-01T00:00:00.000Z',
      command: 'bazframe init',
      target: '/repo',
      token: 'live-token'
    })}\n`);

    await expect(withStateLock(
      lock,
      { command: 'bazframe use', target: 'active-profile' },
      async () => undefined,
      { managedRoot: root, isProcessAlive: (pid) => pid === 42 }
    )).rejects.toThrow(/bazframe init.*PID 42.*\/repo/u);
  });

  it('preserves and reports malformed lock state', async () => {
    const directory = await temporary();
    const root = directory.path('home');
    const lock = await directory.write('home/locks/state.lock', '{bad json\n');

    await expect(withStateLock(
      lock,
      { command: 'new command', target: 'new target' },
      async () => undefined,
      { managedRoot: root }
    )).rejects.toThrow(/Invalid Bazframe state lock/u);
    expect(await directory.readText('home/locks/state.lock')).toBe('{bad json\n');
  });

  it('recovers a stale lock before running the operation', async () => {
    const directory = await temporary();
    const root = directory.path('home');
    const lock = await directory.write('home/locks/state.lock', `${JSON.stringify({
      schemaVersion: 1,
      pid: 42,
      createdAt: '2026-01-01T00:00:00.000Z',
      command: 'old command',
      target: 'old target',
      token: 'stale-token'
    })}\n`);

    let ran = false;
    await withStateLock(
      lock,
      { command: 'new command', target: 'new target' },
      async () => { ran = true; },
      { managedRoot: root, processId: 43, isProcessAlive: () => false }
    );

    expect(ran).toBe(true);
    expect(await readdir(directory.path('home/locks'))).toEqual([]);
  });
});
