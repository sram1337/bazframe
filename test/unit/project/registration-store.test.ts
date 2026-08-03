import { readFile, rm, stat, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readRepositoryRegistration,
  registerRepository,
  unregisterRepository
} from '../../../src/project/registration-store.js';
import { repositoryRegistrationPath } from '../../../src/project/registration.js';
import { snapshotFilesystem } from '../../helpers/filesystem-snapshot.js';
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

describe('repository registration store', () => {
  it('registers idempotently and unregisters externally with a stable worktree', async () => {
    const directory = await temporary();
    const repository = await directory.initGit('repository');
    await directory.write('repository/file.txt', 'repository content\n');
    const home = directory.path('bazframe-home');
    const before = await snapshotFilesystem(repository);

    await expect(registerRepository(home, repository)).resolves.toBe('registered');
    await expect(registerRepository(home, repository)).resolves.toBe('current');
    expect(await readRepositoryRegistration(home, repository)).toMatchObject({
      schemaVersion: 1,
      repository,
      mode: 'adaptive-context',
      profile: 'active'
    });
    expect(await snapshotFilesystem(repository)).toEqual(before);

    await expect(unregisterRepository(home, repository)).resolves.toBe('unregistered');
    await expect(unregisterRepository(home, repository)).resolves.toBe('absent');
    await expect(stat(repositoryRegistrationPath(home, repository)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotFilesystem(repository)).toEqual(before);
  });

  it('preserves malformed and symlinked registrations', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const repository = await directory.initGit('repository');
    const home = directory.path('bazframe-home');
    const registrationPath = repositoryRegistrationPath(home, repository);
    await directory.write(relativeToRoot(directory, registrationPath), '{bad json\n');

    await expect(unregisterRepository(home, repository)).rejects.toThrow(/Invalid JSON/u);
    expect(await readFile(registrationPath, 'utf8')).toBe('{bad json\n');

    await directory.write('other-registration.json', '{}\n');
    await rm(registrationPath);
    await symlink(directory.path('other-registration.json'), registrationPath);
    await expect(readRepositoryRegistration(home, repository))
      .rejects.toThrow(/physical file/u);
  });
});

function relativeToRoot(directory: TempDirectory, path: string): string {
  const prefix = `${directory.root}/`;
  if (!path.startsWith(prefix)) throw new Error(`Path is outside fixture: ${path}`);
  return path.slice(prefix.length);
}
