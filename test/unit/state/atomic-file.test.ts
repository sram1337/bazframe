import { lstat, readdir, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../../src/state/atomic-file.js';
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

describe('atomic managed writes', () => {
  it('creates and replaces mode-restricted files under a physical managed root', async () => {
    const directory = await temporary();
    const root = directory.path('home');
    const destination = directory.path('home/projects/registration.json');

    await writeFileAtomic(destination, 'first\n', { managedRoot: root });
    await writeFileAtomic(destination, 'second\n', { managedRoot: root });

    expect(await directory.readText('home/projects/registration.json')).toBe('second\n');
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    expect((await lstat(directory.path('home/projects'))).mode & 0o777).toBe(0o700);
    expect(await readdir(directory.path('home/projects'))).toEqual(['registration.json']);
  });

  it('treats rename as committed when an opted-in directory sync fails', async () => {
    const directory = await temporary();
    const root = directory.path('home');
    const destination = directory.path('home/state.json');
    await writeFileAtomic(destination, 'old\n', { managedRoot: root });

    await expect(writeFileAtomic(destination, 'new\n', {
      managedRoot: root,
      commitOnRename: true,
      directorySync: async () => { throw Object.assign(new Error('sync failed'), { code: 'EIO' }); }
    })).resolves.toBeUndefined();
    expect(await directory.readText('home/state.json')).toBe('new\n');
  });

  it('preserves strict post-rename sync reporting by default', async () => {
    const directory = await temporary();
    const root = directory.path('home');
    const destination = directory.path('home/state.json');
    await expect(writeFileAtomic(destination, 'new\n', {
      managedRoot: root,
      directorySync: async () => { throw Object.assign(new Error('sync failed'), { code: 'EIO' }); }
    })).rejects.toMatchObject({ code: 'ATOMIC_WRITE_FAILED' });
    expect(await directory.readText('home/state.json')).toBe('new\n');
  });

  it('rejects destinations outside the managed root', async () => {
    const directory = await temporary();
    await expect(writeFileAtomic(
      directory.path('outside.txt'),
      'content',
      { managedRoot: directory.path('home') }
    )).rejects.toThrow(/escapes its root/u);
  });

  it('rejects symlinked managed directories and destinations', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const root = await directory.mkdir('home');
    const shared = await directory.mkdir('shared');
    await symlink(shared, directory.path('home/projects'));

    await expect(writeFileAtomic(
      directory.path('home/projects/state.json'),
      'content',
      { managedRoot: root }
    )).rejects.toThrow(/physical directory/u);

    await directory.write('target.txt', 'target');
    await symlink(directory.path('target.txt'), directory.path('home/state.json'));
    await expect(writeFileAtomic(
      directory.path('home/state.json'),
      'content',
      { managedRoot: root }
    )).rejects.toThrow(/physical regular file/u);
  });
});
