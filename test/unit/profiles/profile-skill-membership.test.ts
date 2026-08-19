import { lstat, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addActiveProfileSkill,
  addProfileSkill,
  readSkillDeclaredName,
  removeActiveProfileSkill,
  removeProfileSkill,
  type ProfileSkillMembershipOptions
} from '../../../src/profiles/profile-skill-membership.js';
import {
  loadProfile,
  readActiveProfile,
  writeActiveProfile
} from '../../../src/profiles/profile-store.js';
import { snapshotFilesystem } from '../../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

interface Fixture {
  directory: TempDirectory;
  home: string;
  provider: string;
  source: string;
  membership: string;
  options: ProfileSkillMembershipOptions;
}

async function temporary(): Promise<TempDirectory> {
  const directory = await createTempDirectory();
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('profile skill membership', () => {
  it('adds, discovers, and removes a parallel absolute membership without changing provider content', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    const beforeProvider = await snapshotFilesystem(fixture.provider);

    await expect(addActiveProfileSkill(fixture.options, 'demo-skill')).resolves
      .toMatchObject({ action: 'added', profileId: 'focused', skillId: 'demo-skill' });
    expect((await lstat(fixture.membership)).isSymbolicLink()).toBe(true);
    expect(await readlink(fixture.membership)).toBe(fixture.source);
    expect((await loadProfile(fixture.home, 'focused')).skillDirectories)
      .toEqual([fixture.membership]);

    await expect(addActiveProfileSkill(fixture.options, 'demo-skill')).resolves
      .toMatchObject({ action: 'current' });
    expect(await snapshotFilesystem(fixture.provider)).toEqual(beforeProvider);

    await expect(removeActiveProfileSkill(fixture.options, 'demo-skill')).resolves
      .toMatchObject({ action: 'removed' });
    await expect(lstat(fixture.membership)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeActiveProfileSkill(fixture.options, 'demo-skill')).resolves
      .toMatchObject({ action: 'absent' });
    expect(await snapshotFilesystem(fixture.provider)).toEqual(beforeProvider);
  });

  it('accepts identity scalars with comments without validating unrelated schema', async () => {
    const directory = await temporary();
    for (const [name, value] of [
      ['bare', 'demo-skill'],
      ['single', "'demo-skill'"],
      ['double', '"demo-skill"'],
      ['bare-comment', 'demo-skill # provider note'],
      ['single-comment', "'demo-skill' # provider note"],
      ['double-comment', '"demo-skill" # provider note']
    ] as const) {
      await directory.write(`${name}/SKILL.md`, skillDefinition(value));
      await expect(readSkillDeclaredName(directory.path(name))).resolves.toBe('demo-skill');
    }

    await directory.write('identity-only/SKILL.md', '---\nname: demo-skill\n---\n');
    await expect(readSkillDeclaredName(directory.path('identity-only')))
      .resolves.toBe('demo-skill');
  });

  it('rejects malformed, duplicate, unsafe, mismatched, invalid, and oversized definitions before add', async () => {
    if (process.platform === 'win32') return;
    const malformed = [
      'name: demo-skill\n',
      '---\nname: demo-skill\n',
      '---\ndescription: missing\n---\n',
      '---\nname: demo-skill\nname: demo-skill\n---\n',
      '---\nname: Demo_Skill\n---\n',
      '---\nname: other-skill\n---\n'
    ];
    for (const [index, definition] of malformed.entries()) {
      const fixture = await createFixture(definition);
      await expect(addActiveProfileSkill(fixture.options, 'demo-skill')).rejects.toThrow();
      await expect(lstat(fixture.membership)).rejects.toMatchObject({ code: 'ENOENT' });
      if (index === malformed.length - 1) {
        await expect(addActiveProfileSkill(fixture.options, 'demo-skill'))
          .rejects.toThrow(/declares name/u);
      }
    }

    const invalidUtf8 = await createFixture(Uint8Array.from([0xff]));
    await expect(addActiveProfileSkill(invalidUtf8.options, 'demo-skill'))
      .rejects.toThrow(/valid UTF-8/u);
    const nul = await createFixture(skillDefinition('demo-skill') + '\0');
    await expect(addActiveProfileSkill(nul.options, 'demo-skill')).rejects.toThrow(/NUL/u);
    const oversized = await createFixture(
      skillDefinition('demo-skill') + 'x'.repeat(1024 * 1024)
    );
    await expect(addActiveProfileSkill(oversized.options, 'demo-skill'))
      .rejects.toThrow(/exceeds/u);
  });

  it('refuses and preserves physical, relative, and foreign profile entries', async () => {
    if (process.platform === 'win32') return;

    const physical = await createFixture();
    await physical.directory.write(
      'home/profiles/focused/skills/demo-skill/keep.txt',
      'physical\n'
    );
    await expect(addActiveProfileSkill(physical.options, 'demo-skill'))
      .rejects.toThrow(/physical entry/u);
    await expect(removeActiveProfileSkill(physical.options, 'demo-skill'))
      .rejects.toThrow(/physical entry/u);
    expect(await physical.directory.readText(
      'home/profiles/focused/skills/demo-skill/keep.txt'
    )).toBe('physical\n');

    const relative = await createFixture();
    await symlink('../elsewhere', relative.membership);
    await expect(addActiveProfileSkill(relative.options, 'demo-skill'))
      .rejects.toThrow(/relative target/u);
    await expect(removeActiveProfileSkill(relative.options, 'demo-skill'))
      .rejects.toThrow(/relative target/u);
    expect(await readlink(relative.membership)).toBe('../elsewhere');

    const foreign = await createFixture();
    const foreignTarget = foreign.directory.path('foreign/skill');
    await foreign.directory.mkdir('foreign/skill');
    await symlink(foreignTarget, foreign.membership);
    await expect(addActiveProfileSkill(foreign.options, 'demo-skill'))
      .rejects.toThrow(/targets/u);
    await expect(removeActiveProfileSkill(foreign.options, 'demo-skill'))
      .rejects.toThrow(/targets/u);
    expect(await readlink(foreign.membership)).toBe(foreignTarget);
  });

  it('requires existing physical profile parents and a valid default registration target', async () => {
    if (process.platform === 'win32') return;
    const missingSkills = await createFixture();
    await rm(missingSkills.directory.path('home/profiles/focused/skills'), { recursive: true });
    await expect(addActiveProfileSkill(missingSkills.options, 'demo-skill'))
      .rejects.toThrow(/Profile skills directory must be an existing physical directory/u);

    const linkedProfile = await createFixture();
    await rm(linkedProfile.directory.path('home/profiles/focused'), { recursive: true });
    await linkedProfile.directory.write('redirected-profile/AGENTS.md', 'profile\n');
    await linkedProfile.directory.mkdir('redirected-profile/skills');
    await symlink(
      linkedProfile.directory.path('redirected-profile'),
      linkedProfile.directory.path('home/profiles/focused')
    );
    await expect(addActiveProfileSkill(linkedProfile.options, 'demo-skill'))
      .rejects.toThrow(/physical directory/u);

    const linkedSkills = await createFixture();
    await rm(linkedSkills.directory.path('home/profiles/focused/skills'), { recursive: true });
    await linkedSkills.directory.mkdir('redirected-skills');
    await symlink(
      linkedSkills.directory.path('redirected-skills'),
      linkedSkills.directory.path('home/profiles/focused/skills')
    );
    await expect(addActiveProfileSkill(linkedSkills.options, 'demo-skill'))
      .rejects.toThrow(/physical directory/u);

    const linkedSource = await createFixture();
    await rm(linkedSource.source, { recursive: true });
    await linkedSource.directory.write('provider-source/SKILL.md', skillDefinition('demo-skill'));
    await symlink(linkedSource.directory.path('provider-source'), linkedSource.source);
    await expect(addActiveProfileSkill(linkedSource.options, 'demo-skill'))
      .rejects.toThrow();
  });

  it('rejects substituted profile skill parents without mutating foreign namespaces', async () => {
    if (process.platform === 'win32') return;
    const addFixture = await createFixture();
    const addForeign = await addFixture.directory.mkdir('foreign-skills');
    addFixture.options.testHooks = {
      beforeCommit: async () => {
        await rename(
          addFixture.directory.path('home/profiles/focused/skills'),
          addFixture.directory.path('home/profiles/focused/skills-original')
        );
        await symlink(addForeign, addFixture.directory.path('home/profiles/focused/skills'));
      }
    };
    await expect(addActiveProfileSkill(addFixture.options, 'demo-skill'))
      .rejects.toThrow(/namespace changed/u);
    await expect(lstat(addFixture.directory.path('foreign-skills/demo-skill')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const removeFixture = await createFixture();
    await symlink(removeFixture.source, removeFixture.membership, 'dir');
    const removeForeign = await removeFixture.directory.mkdir('foreign-skills');
    await symlink(removeFixture.source, removeFixture.directory.path('foreign-skills/demo-skill'), 'dir');
    removeFixture.options.testHooks = {
      beforeCommit: async () => {
        await rename(
          removeFixture.directory.path('home/profiles/focused/skills'),
          removeFixture.directory.path('home/profiles/focused/skills-original')
        );
        await symlink(removeForeign, removeFixture.directory.path('home/profiles/focused/skills'));
      }
    };
    await expect(removeActiveProfileSkill(removeFixture.options, 'demo-skill'))
      .rejects.toThrow(/namespace changed/u);
    expect(await readlink(removeFixture.directory.path('foreign-skills/demo-skill')))
      .toBe(removeFixture.source);
  });

  it('removes an exact expected broken membership without requiring provider content', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await symlink(fixture.source, fixture.membership, 'dir');
    await rm(fixture.source, { recursive: true });

    await expect(removeActiveProfileSkill(fixture.options, 'demo-skill')).resolves
      .toMatchObject({ action: 'removed' });
    await expect(lstat(fixture.membership)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('targets an explicit inactive profile without changing or requiring active selection', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture();
    await fixture.directory.write('home/profiles/reviewer/AGENTS.md', 'reviewer\n');
    await fixture.directory.mkdir('home/profiles/reviewer/skills');

    await expect(addProfileSkill(fixture.options, 'reviewer', 'demo-skill')).resolves
      .toMatchObject({ action: 'added', profileId: 'reviewer', skillId: 'demo-skill' });
    expect(await readActiveProfile(fixture.home)).toBe('focused');
    await expect(lstat(fixture.membership)).rejects.toMatchObject({ code: 'ENOENT' });
    const reviewerMembership = fixture.directory.path(
      'home/profiles/reviewer/skills/demo-skill'
    );
    expect(await readlink(reviewerMembership)).toBe(fixture.source);

    await rm(fixture.directory.path('home/active-profile'));
    await expect(removeProfileSkill(fixture.options, 'reviewer', 'demo-skill')).resolves
      .toMatchObject({ action: 'removed', profileId: 'reviewer' });
    await expect(lstat(reviewerMembership)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires an active profile and mutates only the selected profile', async () => {
    if (process.platform === 'win32') return;
    const noSelection = await createFixture();
    await rm(noSelection.directory.path('home/active-profile'));
    await expect(addActiveProfileSkill(noSelection.options, 'demo-skill'))
      .rejects.toThrow(/bazframe use/u);

    const fixture = await createFixture();
    await fixture.directory.write('home/profiles/reviewer/AGENTS.md', 'reviewer\n');
    await fixture.directory.mkdir('home/profiles/reviewer/skills');
    await addActiveProfileSkill(fixture.options, 'demo-skill');
    await expect(lstat(fixture.directory.path('home/profiles/reviewer/skills/demo-skill')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createFixture(
  definition: string | Uint8Array = skillDefinition('demo-skill')
): Promise<Fixture> {
  const directory = await temporary();
  const home = directory.path('home');
  const provider = directory.path('provider');
  let source = directory.path('provider/demo-skill');
  const membership = directory.path('home/profiles/focused/skills/demo-skill');
  await directory.write('home/profiles/focused/AGENTS.md', 'profile\n');
  await directory.mkdir('home/profiles/focused/skills');
  await directory.write('provider/demo-skill/SKILL.md', definition);
  await directory.write('provider/demo-skill/support.txt', 'support\n');
  source = await realpath(source);
  await directory.mkdir('home/skills');
  await symlink(source, directory.path('home/skills/demo-skill'), 'dir');
  await writeActiveProfile(home, 'focused');
  return {
    directory,
    home,
    provider,
    source,
    membership,
    options: { bazframeHome: home }
  };
}

function skillDefinition(name: string): string {
  return `---\nname: ${name}\ndescription: Test skill.\n---\n\n# Skill\n`;
}
