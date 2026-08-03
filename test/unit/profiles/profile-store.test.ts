import { readdir, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverSkillDirectories,
  loadProfile,
  readActiveProfile,
  resolveBazframeHome,
  writeActiveProfile
} from '../../../src/profiles/profile-store.js';
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

describe('profile store', () => {
  it('loads required instructions and immediate skills in lexical order', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await directory.write('home/profiles/focused/AGENTS.md', 'profile instructions');
    await directory.write('home/profiles/focused/skills/z-last/SKILL.md', 'z');
    await directory.write('home/profiles/focused/skills/a-first/SKILL.md', 'a');
    await directory.write('home/profiles/focused/skills/no-definition/readme.md', 'ignored');
    await directory.write('home/profiles/focused/skills/nested/child/SKILL.md', 'ignored');

    const profile = await loadProfile(home, 'focused');
    expect(profile.instructions).toBe('profile instructions');
    expect(profile.skillDirectories).toEqual([
      directory.path('home/profiles/focused/skills/a-first'),
      directory.path('home/profiles/focused/skills/z-last')
    ]);
  });

  it('follows a symlinked immediate skill directory', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    await directory.write('shared/SKILL.md', 'shared');
    await directory.mkdir('skills');
    await symlink(directory.path('shared'), directory.path('skills/linked'));
    expect(await discoverSkillDirectories(directory.path('skills'))).toEqual([
      directory.path('skills/linked')
    ]);
  });

  it('rejects missing profiles, instructions, invalid UTF-8, and NUL', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await expect(loadProfile(home, 'missing')).rejects.toThrow(/does not exist/u);
    await directory.mkdir('home/profiles/focused');
    await expect(loadProfile(home, 'focused')).rejects.toThrow(/instructions/u);
    await directory.write('home/profiles/focused/AGENTS.md', Uint8Array.from([0xff]));
    await expect(loadProfile(home, 'focused')).rejects.toThrow(/valid UTF-8/u);
    await directory.write('home/profiles/focused/AGENTS.md', 'bad\0instructions');
    await expect(loadProfile(home, 'focused')).rejects.toThrow(/NUL/u);
  });

  it('writes and reads plain active-profile state atomically', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await writeActiveProfile(home, 'focused');
    expect(await directory.readText('home/active-profile')).toBe('focused\n');
    expect(await readActiveProfile(home)).toBe('focused');

    await writeActiveProfile(home, 'reviewer');
    expect(await readActiveProfile(home)).toBe('reviewer');
    expect((await readdir(home)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('rejects missing and malformed active state', async () => {
    const directory = await temporary();
    const home = directory.path('home');
    await expect(readActiveProfile(home)).rejects.toThrow(/bazframe use/u);
    await directory.write('home/active-profile', '../escape\n');
    await expect(readActiveProfile(home)).rejects.toThrow(/Invalid profile ID/u);
    await directory.write('home/active-profile', Uint8Array.from([0xff]));
    await expect(readActiveProfile(home)).rejects.toThrow(/valid UTF-8/u);
    await directory.write('home/active-profile', 'focused\0\n');
    await expect(readActiveProfile(home)).rejects.toThrow(/NUL/u);
  });
});

describe('BAZFRAME_HOME', () => {
  it('defaults under the user home and accepts an absolute override', () => {
    expect(resolveBazframeHome({}, '/users/alice')).toBe('/users/alice/.bazframe');
    expect(resolveBazframeHome({ BAZFRAME_HOME: '/tmp/baz home' }, '/ignored'))
      .toBe('/tmp/baz home');
  });

  it('rejects empty and relative overrides', () => {
    expect(() => resolveBazframeHome({ BAZFRAME_HOME: '' })).toThrow(/non-empty absolute/u);
    expect(() => resolveBazframeHome({ BAZFRAME_HOME: 'relative' })).toThrow(/absolute path/u);
  });
});
