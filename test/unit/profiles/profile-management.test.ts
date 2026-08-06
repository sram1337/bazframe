import { lstat, mkdir, readlink, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addProfile,
  currentProfile,
  duplicateProfile,
  listProfiles,
  removeProfile,
  renameProfile
} from '../../../src/profiles/profile-management.js';
import { captureProfileRemovalIdentity } from '../../../src/profiles/profile-removal-identity.js';
import { writeActiveProfile } from '../../../src/profiles/profile-store.js';
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

describe('profile management', () => {
  it('creates a physical generated-empty profile without selecting it and is idempotent', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await expect(addProfile(home, 'focused')).resolves.toMatchObject({ action: 'added' });
    expect((await lstat(directory.path('home/profiles/focused'))).isDirectory()).toBe(true);
    expect((await stat(directory.path('home/profiles/focused/AGENTS.md'))).size).toBe(0);
    expect((await stat(directory.path('home/profiles/focused/AGENTS.md'))).mode & 0o777).toBe(0o600);
    expect((await stat(directory.path('home/profiles/focused/skills'))).mode & 0o777).toBe(0o700);
    await expect(currentProfile(home)).rejects.toThrow(/No active profile/u);
    await expect(addProfile(home, 'focused')).resolves.toMatchObject({ action: 'current' });
  });

  it('refuses malformed and symlinked occupied profile destinations', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    await directory.mkdir('home/profiles/partial');
    await expect(addProfile(home, 'partial')).rejects.toThrow();
    await directory.write('elsewhere/AGENTS.md', 'x');
    await directory.mkdir('elsewhere/skills');
    await symlink(directory.path('elsewhere'), directory.path('home/profiles/linked'));
    await expect(addProfile(home, 'linked')).rejects.toThrow(/physical/u);
  });

  it('accepts runtime-valid symlinked profile content for add-current and list', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    await directory.mkdir('home/profiles/focused');
    await directory.write('shared/AGENTS.md', 'shared instructions');
    await directory.mkdir('shared/skills');
    await symlink(
      directory.path('shared/AGENTS.md'),
      directory.path('home/profiles/focused/AGENTS.md')
    );
    await symlink(
      directory.path('shared/skills'),
      directory.path('home/profiles/focused/skills')
    );

    await expect(addProfile(home, 'focused')).resolves.toMatchObject({ action: 'current' });
    await expect(listProfiles(home)).resolves.toMatchObject({ profileIds: ['focused'] });
  });

  it('duplicates regular profile content without changing selection', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'focused');
    await directory.write('home/profiles/focused/AGENTS.md', 'instructions');
    await directory.write('home/profiles/focused/notes/detail.txt', 'detail');
    await writeActiveProfile(home, 'focused');
    const sourceBefore = await snapshotFilesystem(directory.path('home/profiles/focused'));

    await expect(duplicateProfile(home, 'focused', 'reviewer')).resolves.toMatchObject({
      action: 'duplicated',
      sourceProfileId: 'focused',
      profileId: 'reviewer'
    });

    expect(await currentProfile(home)).toBe('focused');
    expect(await snapshotFilesystem(directory.path('home/profiles/focused'))).toEqual(sourceBefore);
    expect(await snapshotFilesystem(directory.path('home/profiles/reviewer'))).toEqual(sourceBefore);
  });

  it('duplicates symlinks verbatim without touching targets or source alias cache', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'focused');
    await directory.write('provider/demo/SKILL.md', 'provider');
    await symlink(
      directory.path('provider/demo'),
      directory.path('home/profiles/focused/skills/demo'),
      'dir'
    );
    await symlink(
      '../missing-target',
      directory.path('home/profiles/focused/broken-relative-link')
    );
    await directory.write('home/adapter-cache/pi/skill-aliases/focused/alias/SKILL.md', 'live');
    await directory.write('home/adapter-cache/pi/skill-aliases/reviewer/alias/SKILL.md', 'stale');
    const sourceBefore = await snapshotFilesystem(directory.path('home/profiles/focused'));
    const providerBefore = await snapshotFilesystem(directory.path('provider'));

    await duplicateProfile(home, 'focused', 'reviewer');

    expect(await snapshotFilesystem(directory.path('home/profiles/focused'))).toEqual(sourceBefore);
    expect(await snapshotFilesystem(directory.path('home/profiles/reviewer'))).toEqual(sourceBefore);
    expect(await snapshotFilesystem(directory.path('provider'))).toEqual(providerBefore);
    expect(await readlink(directory.path('home/profiles/reviewer/broken-relative-link')))
      .toBe('../missing-target');
    expect((await lstat(directory.path('home/adapter-cache/pi/skill-aliases/focused'))).isDirectory())
      .toBe(true);
    await expect(lstat(directory.path('home/adapter-cache/pi/skill-aliases/reviewer')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses invalid duplicate endpoints and cleans failed or nonphysical staging', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'source');
    await addProfile(home, 'occupied');
    await directory.write('home/profiles/occupied/keep.txt', 'keep');

    await expect(duplicateProfile(home, 'missing', 'copy')).rejects.toThrow(/does not exist/u);
    await expect(duplicateProfile(home, 'source', 'occupied')).rejects.toThrow(/occupied/u);
    await expect(duplicateProfile(home, 'source', 'source')).rejects.toThrow(/occupied/u);
    expect(await directory.readText('home/profiles/occupied/keep.txt')).toBe('keep');

    if (process.platform !== 'win32') {
      await directory.mkdir('outside');
      await symlink(directory.path('outside'), directory.path('home/profiles/linked'));
      await expect(duplicateProfile(home, 'linked', 'copy')).rejects.toThrow(/physical/u);
      await expect(duplicateProfile(home, 'source', 'race-copy', {
        copyProfileTree: async (_source, destination) => {
          await symlink(directory.path('outside'), destination, 'dir');
        }
      })).rejects.toThrow(/physical/u);
    }

    await expect(duplicateProfile(home, 'source', 'copy', {
      copyProfileTree: async (_source, destination) => {
        await mkdir(destination);
        await writeFile(`${destination}/partial`, 'partial');
        throw new Error('injected copy failure');
      }
    })).rejects.toThrow(/Could not duplicate/u);
    const entries = (await readdir(directory.path('home/profiles'))).sort();
    expect(entries.some((entry) => entry.startsWith('.'))).toBe(false);
    expect(entries).not.toContain('copy');
    expect(entries).not.toContain('race-copy');
  });

  it('removes only generated-empty profiles without force and is idempotent', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'empty');
    await expect(removeProfile(home, 'empty', false)).resolves.toMatchObject({ action: 'removed' });
    await expect(removeProfile(home, 'empty', false)).resolves.toMatchObject({ action: 'absent' });

    await addProfile(home, 'instructions');
    await writeFile(directory.path('home/profiles/instructions/AGENTS.md'), 'keep');
    await expect(removeProfile(home, 'instructions', false)).rejects.toThrow(/--force/u);
    expect(await directory.readText('home/profiles/instructions/AGENTS.md')).toBe('keep');

    await addProfile(home, 'extra');
    await directory.write('home/profiles/extra/other.txt', 'keep');
    await expect(removeProfile(home, 'extra', false)).rejects.toThrow(/--force/u);
  });

  it('always refuses the active profile, including when its directory is missing', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'focused');
    await writeActiveProfile(home, 'focused');
    await expect(removeProfile(home, 'focused', false)).rejects.toThrow(/active profile/u);
    await expect(removeProfile(home, 'focused', true)).rejects.toThrow(/active profile/u);

    const missing = await temporary();
    await writeActiveProfile(missing.path('home'), 'missing');
    await expect(removeProfile(missing.path('home'), 'missing', false))
      .rejects.toThrow(/active profile/u);
    await expect(removeProfile(missing.path('home'), 'missing', true))
      .rejects.toThrow(/active profile/u);
  });

  it('force-removes physical content and membership links without touching targets', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'focused');
    await directory.write('provider/demo/SKILL.md', 'provider');
    const provider = directory.path('provider');
    const before = await snapshotFilesystem(provider);
    await symlink(
      directory.path('provider/demo'),
      directory.path('home/profiles/focused/skills/demo'),
      'dir'
    );
    await directory.write('home/profiles/focused/notes.txt', 'delete');
    await expect(removeProfile(home, 'focused', true)).resolves.toMatchObject({ action: 'removed' });
    await expect(lstat(directory.path('home/profiles/focused'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotFilesystem(provider)).toEqual(before);
  });

  it('validates snapshot-bound recursive authorization inside removal and preserves changes', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'reviewer');
    await directory.write('home/profiles/reviewer/AGENTS.md', 'reviewed\n');
    const expectedIdentity = await captureProfileRemovalIdentity(
      directory.path('home/profiles/reviewer')
    );
    await directory.write('home/profiles/reviewer/AGENTS.md', 'replacement\n');

    await expect(removeProfile(home, 'reviewer', true, { expectedIdentity }))
      .rejects.toMatchObject({ code: 'PROFILE_REMOVE_AUTHORIZATION_STALE' });
    expect(await directory.readText('home/profiles/reviewer/AGENTS.md')).toBe('replacement\n');

    await expect(removeProfile(home, 'reviewer', true)).resolves.toMatchObject({
      action: 'removed'
    });
  });

  it('refuses stale recursive authorization after nested physical content changes', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'reviewer');
    await directory.write(
      'home/profiles/reviewer/notes/archive/review.txt',
      'reviewed content\n'
    );
    const expectedIdentity = await captureProfileRemovalIdentity(
      directory.path('home/profiles/reviewer')
    );

    await directory.write(
      'home/profiles/reviewer/notes/archive/review.txt',
      'preserve change!\n'
    );

    await expect(removeProfile(home, 'reviewer', true, { expectedIdentity }))
      .rejects.toMatchObject({ code: 'PROFILE_REMOVE_AUTHORIZATION_STALE' });
    expect(await directory.readText('home/profiles/reviewer/notes/archive/review.txt'))
      .toBe('preserve change!\n');
  });

  it('treats a nested symlink as a leaf when its target content changes', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'reviewer');
    await directory.write('provider/demo/SKILL.md', 'reviewed provider\n');
    await directory.mkdir('home/profiles/reviewer/notes/links');
    await symlink(
      directory.path('provider/demo'),
      directory.path('home/profiles/reviewer/notes/links/provider'),
      'dir'
    );
    const expectedIdentity = await captureProfileRemovalIdentity(
      directory.path('home/profiles/reviewer')
    );

    await directory.write('provider/demo/SKILL.md', 'changed provider\n');

    await expect(captureProfileRemovalIdentity(directory.path('home/profiles/reviewer')))
      .resolves.toEqual(expectedIdentity);
    await expect(removeProfile(home, 'reviewer', true, { expectedIdentity }))
      .resolves.toMatchObject({ action: 'removed' });
    expect(await directory.readText('provider/demo/SKILL.md')).toBe('changed provider\n');
  });

  it('renames profiles, preserves contents, and updates only a matching active selection', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'focused');
    await directory.write('home/profiles/focused/AGENTS.md', 'instructions');
    await writeActiveProfile(home, 'focused');
    await expect(renameProfile(home, 'focused', 'reviewer')).resolves.toMatchObject({
      action: 'renamed', activeSelectionUpdated: true
    });
    expect(await currentProfile(home)).toBe('reviewer');
    expect(await directory.readText('home/profiles/reviewer/AGENTS.md')).toBe('instructions');
    await expect(renameProfile(home, 'reviewer', 'reviewer')).resolves.toMatchObject({
      action: 'current', activeSelectionUpdated: false
    });

    await addProfile(home, 'spare');
    await expect(renameProfile(home, 'spare', 'other')).resolves.toMatchObject({
      action: 'renamed', activeSelectionUpdated: false
    });
    expect(await currentProfile(home)).toBe('reviewer');
  });

  it('renames a physical profile without resolving a broken provider membership', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'focused');
    const missingTarget = directory.path('missing-provider/demo');
    await symlink(
      missingTarget,
      directory.path('home/profiles/focused/skills/demo'),
      'dir'
    );

    await expect(renameProfile(home, 'focused', 'reviewer')).resolves.toMatchObject({
      action: 'renamed'
    });
    expect(await readlink(directory.path('home/profiles/reviewer/skills/demo')))
      .toBe(missingTarget);
  });

  it('rolls an active directory rename back when selection replacement fails', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'focused');
    await writeActiveProfile(home, 'focused');

    await expect(renameProfile(home, 'focused', 'reviewer', {
      writeActiveProfileState: async () => { throw new Error('injected write failure'); }
    })).rejects.toThrow(/rolled back/u);
    expect(await currentProfile(home)).toBe('focused');
    expect((await lstat(directory.path('home/profiles/focused'))).isDirectory()).toBe(true);
    await expect(lstat(directory.path('home/profiles/reviewer')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses rename replacement and nonphysical old profiles', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'one');
    await addProfile(home, 'two');
    await expect(renameProfile(home, 'one', 'two')).rejects.toThrow(/occupied/u);
    await directory.write('source/AGENTS.md', 'x');
    await directory.mkdir('source/skills');
    await symlink(directory.path('source'), directory.path('home/profiles/link'));
    await expect(renameProfile(home, 'link', 'new')).rejects.toThrow(/physical/u);

    const redirected = await temporary();
    await redirected.write('profiles/old/AGENTS.md', 'x');
    await redirected.mkdir('profiles/old/skills');
    await redirected.mkdir('redirected-home');
    await symlink(redirected.path('profiles'), redirected.path('redirected-home/profiles'));
    await expect(renameProfile(redirected.path('redirected-home'), 'old', 'new'))
      .rejects.toThrow(/Profiles directory must be a physical directory/u);
  });

  it('cleans stale alias caches only for actual create, remove, and changed identity', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    const cache = (profile: string) =>
      directory.path(`home/adapter-cache/pi/skill-aliases/${profile}`);
    await directory.write('home/adapter-cache/pi/skill-aliases/focused/alias/SKILL.md', 'old');
    await addProfile(home, 'focused');
    await expect(lstat(cache('focused'))).rejects.toMatchObject({ code: 'ENOENT' });

    await directory.write('home/adapter-cache/pi/skill-aliases/focused/alias/SKILL.md', 'live');
    await expect(addProfile(home, 'focused')).resolves.toMatchObject({ action: 'current' });
    expect((await lstat(cache('focused'))).isDirectory()).toBe(true);
    await expect(renameProfile(home, 'focused', 'focused')).resolves.toMatchObject({
      action: 'current'
    });
    expect((await lstat(cache('focused'))).isDirectory()).toBe(true);

    await directory.write('home/adapter-cache/pi/skill-aliases/reviewer/alias/SKILL.md', 'stale');
    await renameProfile(home, 'focused', 'reviewer');
    await expect(lstat(cache('focused'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(cache('reviewer'))).rejects.toMatchObject({ code: 'ENOENT' });

    await directory.write('home/adapter-cache/pi/skill-aliases/reviewer/alias/SKILL.md', 'old');
    await removeProfile(home, 'reviewer', false);
    await expect(lstat(cache('reviewer'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists only valid physical profiles in lexical order and reports invalid neighbors', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const home = directory.path('home');
    await addProfile(home, 'zeta');
    await addProfile(home, 'alpha');
    await directory.mkdir('home/profiles/broken');
    await directory.mkdir('outside');
    await symlink(directory.path('outside'), directory.path('home/profiles/linked'));
    await mkdir(directory.path('home/profiles/Bad'));
    const result = await listProfiles(home);
    expect(result.profileIds).toEqual(['alpha', 'zeta']);
    expect(result.diagnostics).toHaveLength(3);
  });

  it('prints stale current selection without validating profile health', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await writeActiveProfile(home, 'missing');
    await expect(currentProfile(home)).resolves.toBe('missing');
  });
});
