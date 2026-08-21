import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_PROFILE_FAVORITES_BYTES,
  decodeProfileFavorites,
  encodeProfileFavorites,
  profileFavoritesPath,
  readProfileFavorites,
  toggleProfileFavorite
} from '../../../src/profiles/profile-favorites.js';
import {
  addProfile,
  duplicateProfile,
  removeProfile,
  renameProfile
} from '../../../src/profiles/profile-management.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('profile favorites state', () => {
  it('decodes an exact schema-v1 record and canonically encodes unique lexical IDs', () => {
    expect(decodeProfileFavorites('{"favorites":["alpha","zeta"],"schemaVersion":1}'))
      .toEqual({ schemaVersion: 1, favorites: ['alpha', 'zeta'] });
    expect(encodeProfileFavorites(['zeta', 'alpha', 'zeta'])).toBe(
      '{\n  "schemaVersion": 1,\n  "favorites": [\n    "alpha",\n    "zeta"\n  ]\n}\n'
    );
  });

  it.each([
    ['extra field', '{"schemaVersion":1,"favorites":[],"extra":true}'],
    ['unsupported schema', '{"schemaVersion":2,"favorites":[]}'],
    ['unsafe ID', '{"schemaVersion":1,"favorites":["../escape"]}'],
    ['duplicate ID', '{"schemaVersion":1,"favorites":["alpha","alpha"]}'],
    ['unsorted IDs', '{"schemaVersion":1,"favorites":["zeta","alpha"]}'],
    ['wrong collection', '{"schemaVersion":1,"favorites":"alpha"}']
  ])('rejects malformed state with an exact-schema diagnostic: %s', (_label, text) => {
    expect(() => decodeProfileFavorites(text)).toThrow(/invalid/u);
  });

  it('treats missing state as empty and persists toggles across calls', async () => {
    const fixture = await createFixture();
    expect(await readProfileFavorites(fixture.home)).toEqual({ schemaVersion: 1, favorites: [] });

    await toggleProfileFavorite(fixture.home, 'reviewer');
    expect(await readProfileFavorites(fixture.home)).toEqual({
      schemaVersion: 1,
      favorites: ['reviewer']
    });
    expect((await toggleProfileFavorite(fixture.home, 'reviewer')).action).toBe('unfavorited');
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual([]);
  });

  it('rejects non-UTF-8, oversized, and symlink state files', async () => {
    const fixture = await createFixture();
    const path = profileFavoritesPath(fixture.home);

    await writeFile(path, Uint8Array.from([0xff]));
    await expect(readProfileFavorites(fixture.home)).rejects.toMatchObject({
      code: 'PROFILE_FAVORITES_INVALID'
    });

    await writeFile(path, 'x'.repeat(MAX_PROFILE_FAVORITES_BYTES + 1));
    await expect(readProfileFavorites(fixture.home)).rejects.toMatchObject({
      code: 'PROFILE_FAVORITES_INVALID'
    });

    if (process.platform === 'win32') return;
    const external = await fixture.directory.write('external-favorites.json', encodeProfileFavorites([]));
    await writeFile(path, 'replace before symlink');
    await (await import('node:fs/promises')).unlink(path);
    await symlink(external, path);
    await expect(readProfileFavorites(fixture.home)).rejects.toMatchObject({
      code: 'PROFILE_FAVORITES_INVALID'
    });
  });

  it('fails mutation without overwriting malformed state', async () => {
    const fixture = await createFixture();
    const path = profileFavoritesPath(fixture.home);
    const malformed = '{"schemaVersion":1,"favorites":["reviewer"],"extra":true}\n';
    await writeFile(path, malformed);

    await expect(toggleProfileFavorite(fixture.home, 'reviewer')).rejects.toMatchObject({
      code: 'PROFILE_FAVORITES_INVALID'
    });
    expect(await readFile(path, 'utf8')).toBe(malformed);
  });

  it('requires a current physical profile before toggling', async () => {
    const fixture = await createFixture();
    await expect(toggleProfileFavorite(fixture.home, 'missing')).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND'
    });

    if (process.platform === 'win32') return;
    await renameProfile(fixture.home, 'reviewer', 'renamed');
    await symlink(
      fixture.directory.path('home/profiles/renamed'),
      fixture.directory.path('home/profiles/reviewer')
    );
    await expect(toggleProfileFavorite(fixture.home, 'reviewer')).rejects.toMatchObject({
      code: 'PROFILE_NOT_PHYSICAL'
    });
  });

  it('rejects a profile identity replacement during toggle revalidation', async () => {
    const fixture = await createFixture();
    const profile = fixture.directory.path('home/profiles/reviewer');
    const moved = fixture.directory.path('home/profiles/reviewer-old');

    await expect(toggleProfileFavorite(fixture.home, 'reviewer', {
      beforeTargetRevalidation: async () => {
        await rename(profile, moved);
        await mkdir(profile);
        await mkdir(`${profile}/skills`);
        await writeFile(`${profile}/AGENTS.md`, '');
      }
    })).rejects.toMatchObject({ code: 'PROFILE_FAVORITE_TARGET_STALE' });
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual([]);
  });

  it('treats atomic rename as the favorite-state commit point', async () => {
    const fixture = await createFixture();
    const result = await toggleProfileFavorite(fixture.home, 'reviewer', {
      directorySync: async () => {
        throw Object.assign(new Error('sync failed'), { code: 'EIO' });
      }
    });

    expect(result.action).toBe('favorited');
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual(['reviewer']);
  });

  it('carries a valid favorite across rename, does not copy it on duplicate, and clears removal', async () => {
    const fixture = await createFixture();
    await toggleProfileFavorite(fixture.home, 'reviewer');

    await duplicateProfile(fixture.home, 'reviewer', 'copy');
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual(['reviewer']);

    await renameProfile(fixture.home, 'reviewer', 'renamed');
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual(['renamed']);

    await removeProfile(fixture.home, 'renamed', false);
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual([]);
  });

  it('retains independent stale destination-ID favorites for duplicate and rename', async () => {
    const fixture = await createFixture();
    await writeFile(
      profileFavoritesPath(fixture.home),
      encodeProfileFavorites(['copy', 'renamed', 'reviewer'])
    );

    await duplicateProfile(fixture.home, 'reviewer', 'copy');
    await renameProfile(fixture.home, 'reviewer', 'renamed');
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual(['copy', 'renamed']);
  });

  it('clears valid stale favorites on absent removal', async () => {
    const fixture = await createFixture();
    await writeFile(profileFavoritesPath(fixture.home), encodeProfileFavorites(['ghost']));

    expect((await removeProfile(fixture.home, 'ghost', false)).action).toBe('absent');
    expect((await readProfileFavorites(fixture.home)).favorites).toEqual([]);
  });

  it('preserves malformed optional state without blocking rename or removal', async () => {
    const fixture = await createFixture();
    const path = profileFavoritesPath(fixture.home);
    const malformed = 'not-json\n';
    await writeFile(path, malformed);

    await renameProfile(fixture.home, 'reviewer', 'renamed');
    await removeProfile(fixture.home, 'renamed', false);
    expect(await readFile(path, 'utf8')).toBe(malformed);
    await expect(lstat(fixture.directory.path('home/profiles/renamed')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createFixture(): Promise<{ directory: TempDirectory; home: string }> {
  const directory = await createTempDirectory();
  temporaryDirectories.push(directory);
  const home = directory.path('home');
  await addProfile(home, 'reviewer');
  return { directory, home };
}
