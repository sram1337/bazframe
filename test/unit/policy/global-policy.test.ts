import { readFile, rm, stat, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeDisabledGlobalPolicy,
  disableGlobally,
  enableGlobally,
  globalPolicyPath,
  readGlobalPolicy
} from '../../../src/policy/global-policy.js';
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

describe('global policy', () => {
  it('uses file-free enabled defaults and toggles disabled state idempotently', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    const path = globalPolicyPath(home);

    await expect(readGlobalPolicy(home)).resolves.toBe('enabled');
    await expect(disableGlobally(home)).resolves.toBe('disabled');
    await expect(disableGlobally(home)).resolves.toBe('current');
    await expect(readGlobalPolicy(home)).resolves.toBe('disabled');
    expect(decodeDisabledGlobalPolicy(await readFile(path, 'utf8')))
      .toEqual({ schemaVersion: 1, disabled: true });

    await expect(enableGlobally(home)).resolves.toBe('enabled');
    await expect(enableGlobally(home)).resolves.toBe('current');
    await expect(readGlobalPolicy(home)).resolves.toBe('enabled');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects non-exact state', () => {
    for (const value of [
      {},
      { schemaVersion: 2, disabled: true },
      { schemaVersion: 1, disabled: false },
      { schemaVersion: 1, disabled: true, extra: true }
    ]) {
      expect(() => decodeDisabledGlobalPolicy(JSON.stringify(value)))
        .toThrow(/exact schema-v1/u);
    }
    expect(() => decodeDisabledGlobalPolicy('{')).toThrow(/Invalid JSON/u);
  });

  it('preserves malformed and symlinked state', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    const path = globalPolicyPath(home);
    await directory.write('home/global.json', '{bad json\n');

    await expect(readGlobalPolicy(home)).rejects.toThrow(/Invalid JSON/u);
    await expect(enableGlobally(home)).rejects.toThrow(/Invalid JSON/u);
    await expect(disableGlobally(home)).rejects.toThrow(/Invalid JSON/u);
    expect(await readFile(path, 'utf8')).toBe('{bad json\n');

    await directory.write('other.json', '{}\n');
    await rm(path);
    await symlink(directory.path('other.json'), path);
    await expect(readGlobalPolicy(home)).rejects.toThrow(/physical file/u);
    await expect(enableGlobally(home)).rejects.toThrow(/physical file/u);
    await expect(disableGlobally(home)).rejects.toThrow(/physical file/u);
  });
});
