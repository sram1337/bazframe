import { readFile, rm, stat, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { disableGlobally, enableGlobally } from '../../../src/policy/global-policy.js';
import {
  disableRepository,
  enableRepository,
  listRepositoryProjectStates,
  readRepositoryProjectState
} from '../../../src/project/registration-store.js';
import {
  createEnabledRepositoryOverride,
  createRepositoryRegistration,
  encodeRepositoryRegistration,
  repositoryRegistrationPath
} from '../../../src/project/registration.js';
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

describe('repository project-state store', () => {
  it('stores state only when project policy differs from global policy', async () => {
    const directory = await temporary();
    const repository = await directory.initGit('repository');
    await directory.write('repository/file.txt', 'repository content\n');
    const home = directory.path('bazframe-home');
    const statePath = repositoryRegistrationPath(home, repository);
    const before = await snapshotFilesystem(repository);

    await expect(enableRepository(home, repository))
      .resolves.toEqual({ action: 'inherited', globalPolicy: 'enabled' });
    await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(disableRepository(home, repository))
      .resolves.toEqual({ action: 'override-added', globalPolicy: 'enabled' });
    await expect(disableRepository(home, repository))
      .resolves.toEqual({ action: 'current', globalPolicy: 'enabled' });
    expect(await readRepositoryProjectState(home, repository)).toEqual({
      schemaVersion: 2,
      repository,
      disabled: true
    });
    await expect(enableRepository(home, repository))
      .resolves.toEqual({ action: 'override-removed', globalPolicy: 'enabled' });

    await disableGlobally(home);
    await expect(enableRepository(home, repository))
      .resolves.toEqual({ action: 'override-added', globalPolicy: 'disabled' });
    await expect(enableRepository(home, repository))
      .resolves.toEqual({ action: 'current', globalPolicy: 'disabled' });
    expect(await readRepositoryProjectState(home, repository))
      .toEqual(createEnabledRepositoryOverride(repository));
    await expect(disableRepository(home, repository))
      .resolves.toEqual({ action: 'override-removed', globalPolicy: 'disabled' });
    await expect(disableRepository(home, repository))
      .resolves.toEqual({ action: 'inherited', globalPolicy: 'disabled' });
    await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotFilesystem(repository)).toEqual(before);
  });

  it('accepts and explicitly removes an exact redundant legacy registration', async () => {
    const directory = await temporary();
    const repository = await directory.initGit('repository');
    const home = directory.path('bazframe-home');
    const path = repositoryRegistrationPath(home, repository);
    const legacy = createRepositoryRegistration(repository);
    await directory.write(relativeToRoot(directory, path), encodeRepositoryRegistration(legacy));

    await expect(readRepositoryProjectState(home, repository)).resolves.toEqual(legacy);
    await expect(enableRepository(home, repository))
      .resolves.toEqual({ action: 'override-removed', globalPolicy: 'enabled' });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists enabled, disabled, and legacy state and reports invalid neighbors', async () => {
    const directory = await temporary();
    const enabled = await directory.initGit('enabled');
    const disabled = await directory.initGit('disabled');
    const legacyRepository = await directory.initGit('legacy');
    const home = directory.path('bazframe-home');
    await disableGlobally(home);
    await enableRepository(home, enabled);
    await enableGlobally(home);
    await disableRepository(home, disabled);
    const legacyPath = repositoryRegistrationPath(home, legacyRepository);
    await directory.write(
      relativeToRoot(directory, legacyPath),
      encodeRepositoryRegistration(createRepositoryRegistration(legacyRepository))
    );
    await directory.write('bazframe-home/projects/not-project-state.json', '{bad json\n');

    const result = await listRepositoryProjectStates(home);
    expect(result.projectStates).toHaveLength(3);
    expect(result.projectStates.map((state) => state.schemaVersion).sort()).toEqual([1, 2, 3]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('preserves malformed and symlinked current state for both lifecycle commands', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const repository = await directory.initGit('repository');
    const home = directory.path('bazframe-home');
    const statePath = repositoryRegistrationPath(home, repository);
    await directory.write(relativeToRoot(directory, statePath), '{bad json\n');

    await expect(enableRepository(home, repository)).rejects.toThrow(/Invalid JSON/u);
    await expect(disableRepository(home, repository)).rejects.toThrow(/Invalid JSON/u);
    expect(await readFile(statePath, 'utf8')).toBe('{bad json\n');

    await directory.write('other-project-state.json', '{}\n');
    await rm(statePath);
    await symlink(directory.path('other-project-state.json'), statePath);
    await expect(readRepositoryProjectState(home, repository))
      .rejects.toThrow(/physical file/u);
    await expect(enableRepository(home, repository)).rejects.toThrow(/physical file/u);
    await expect(disableRepository(home, repository)).rejects.toThrow(/physical file/u);
  });
});

function relativeToRoot(directory: TempDirectory, path: string): string {
  const prefix = `${directory.root}/`;
  if (!path.startsWith(prefix)) throw new Error(`Path is outside fixture: ${path}`);
  return path.slice(prefix.length);
}
