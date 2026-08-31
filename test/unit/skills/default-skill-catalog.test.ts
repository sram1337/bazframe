import { lstat, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addDefaultSkill,
  defaultSkillCatalogRoot,
  inspectDefaultSkillCatalog,
  readDefaultSkillRegistration,
  readDefaultSkillRegistrationLink,
  readDefaultSkillRegistrationSnapshot,
  removeDefaultSkill,
  sameDefaultSkillRegistrationSnapshot
} from '../../../src/skills/default-skill-catalog.js';
import { snapshotFilesystem } from '../../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => item.cleanup())));

async function fixture(name = 'demo-skill') {
  const directory = await createTempDirectory('default-skill-catalog-');
  directories.push(directory);
  const home = await directory.mkdir('home');
  await directory.mkdir('home/profiles');
  await directory.mkdir(`provider/${name}`);
  await directory.write(`provider/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Test.\n---\n\n# Test\n`);
  await directory.write(`provider/${name}/support.sh`, '#!/bin/sh\n');
  const target = await realpath(directory.path(`provider/${name}`));
  return { directory, home, target };
}

describe('default skill catalog', () => {
  it('registers a canonical external target as an absolute link and is same-target idempotent', async () => {
    if (process.platform === 'win32') return;
    const value = await fixture();
    const before = await snapshotFilesystem(value.directory.path('provider'));
    await expect(addDefaultSkill(value.home, value.target)).resolves.toMatchObject({ action: 'added', id: 'demo-skill', target: value.target });
    const registration = value.directory.path('home/skills/demo-skill');
    expect((await lstat(registration)).isSymbolicLink()).toBe(true);
    expect(await readlink(registration)).toBe(value.target);
    await expect(addDefaultSkill(value.home, value.target)).resolves.toMatchObject({ action: 'current' });
    expect(await snapshotFilesystem(value.directory.path('provider'))).toEqual(before);
    await expect(inspectDefaultSkillCatalog(value.home)).resolves.toMatchObject({
      root: defaultSkillCatalogRoot(value.home),
      registrations: [{ id: 'demo-skill', target: value.target }],
      diagnostics: []
    });
  });

  it('rejects identity mismatch, targets inside home, and occupied foreign entries', async () => {
    if (process.platform === 'win32') return;
    const mismatch = await fixture('folder-name');
    await mismatch.directory.write('provider/folder-name/SKILL.md', '---\nname: other\ndescription: Test.\n---\n');
    await expect(addDefaultSkill(mismatch.home, mismatch.target)).rejects.toThrow(/declares name/u);

    const inside = await fixture();
    await inside.directory.write('home/inside/SKILL.md', '---\nname: inside\ndescription: Test.\n---\n');
    await expect(addDefaultSkill(inside.home, inside.directory.path('home/inside'))).rejects.toThrow(/must not overlap/u);

    const containsHome = await createTempDirectory('default-skill-overlap-');
    directories.push(containsHome);
    await containsHome.write('provider/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: Test.\n---\n');
    const containingTarget = await realpath(containsHome.path('provider/demo-skill'));
    await expect(addDefaultSkill(
      containsHome.path('provider/demo-skill/home'),
      containingTarget
    )).rejects.toThrow(/must not overlap/u);
    await expect(lstat(containsHome.path('provider/demo-skill/home')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const occupied = await fixture();
    await occupied.directory.mkdir('home/skills/demo-skill');
    await expect(addDefaultSkill(occupied.home, occupied.target)).rejects.toThrow(/occupied/u);
  });

  it('surfaces snapshot catalog close failures while preserving primary validation failures', async () => {
    if (process.platform === 'win32') return;
    const value = await fixture();
    await addDefaultSkill(value.home, value.target);
    const closeFailure = { testHooks: { afterClose: () => { throw new Error('close failed'); } } };
    await expect(readDefaultSkillRegistrationSnapshot(value.home, 'demo-skill', closeFailure))
      .rejects.toMatchObject({ code: 'DEFAULT_SKILL_CATALOG_READ_FAILED' });
    await value.directory.write('provider/demo-skill/SKILL.md', '---\nname: changed\ndescription: Changed.\n---\n');
    await expect(readDefaultSkillRegistrationSnapshot(value.home, 'demo-skill', closeFailure))
      .rejects.toMatchObject({ code: 'DEFAULT_SKILL_NAME_MISMATCH' });
  });

  it('captures neutral registration identities, declared names, and re-read drift', async () => {
    if (process.platform === 'win32') return;
    const value = await fixture();
    await addDefaultSkill(value.home, value.target);
    const first = await readDefaultSkillRegistrationSnapshot(value.home, 'demo-skill');
    expect(sameDefaultSkillRegistrationSnapshot(first, await readDefaultSkillRegistrationSnapshot(value.home, 'demo-skill'))).toBe(true);

    await rename(value.target, `${value.target}-old`);
    await value.directory.write('provider/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: Replacement.\n---\n');
    const replacement = await readDefaultSkillRegistrationSnapshot(value.home, 'demo-skill');
    expect(replacement.target).toBe(value.target);
    expect(sameDefaultSkillRegistrationSnapshot(first, replacement)).toBe(false);

    await value.directory.write('provider/demo-skill/SKILL.md', '---\nname: changed\ndescription: Changed.\n---\n');
    await expect(readDefaultSkillRegistrationSnapshot(value.home, 'demo-skill'))
      .rejects.toMatchObject({ code: 'DEFAULT_SKILL_NAME_MISMATCH' });
  });

  it('refuses referenced removal, then removes only the registration', async () => {
    if (process.platform === 'win32') return;
    const value = await fixture();
    await addDefaultSkill(value.home, value.target);
    await value.directory.write('home/profiles/focused/AGENTS.md', 'profile\n');
    await value.directory.mkdir('home/profiles/focused/skills');
    await symlink(value.target, value.directory.path('home/profiles/focused/skills/demo-skill'), 'dir');
    await expect(removeDefaultSkill(value.home, 'demo-skill')).rejects.toThrow(/referenced by profiles: focused/u);
    await rm(value.directory.path('home/profiles/focused/skills/demo-skill'));
    await expect(removeDefaultSkill(value.home, 'demo-skill')).resolves.toMatchObject({ action: 'removed', target: value.target });
    expect((await lstat(value.target)).isDirectory()).toBe(true);
    await expect(removeDefaultSkill(value.home, 'demo-skill')).resolves.toMatchObject({ action: 'absent' });
  });

  it('rejects symlinked and substituted catalog namespaces without touching foreign entries', async () => {
    if (process.platform === 'win32') return;
    const linked = await fixture();
    const foreignRoot = await linked.directory.mkdir('foreign-catalog');
    await linked.directory.mkdir('home');
    await symlink(foreignRoot, linked.directory.path('home/skills'));
    await expect(addDefaultSkill(linked.home, linked.target)).rejects.toThrow(/physical directory/u);
    await expect(lstat(linked.directory.path('foreign-catalog/demo-skill')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(inspectDefaultSkillCatalog(linked.home)).rejects.toThrow(/physical directory/u);
    await expect(readDefaultSkillRegistration(linked.home, 'demo-skill'))
      .rejects.toThrow(/physical directory/u);
    await expect(readDefaultSkillRegistrationLink(linked.home, 'demo-skill'))
      .rejects.toThrow(/physical directory/u);
    await expect(removeDefaultSkill(linked.home, 'demo-skill'))
      .rejects.toThrow(/physical directory/u);

    const addSwap = await fixture();
    const addForeign = await addSwap.directory.mkdir('foreign-catalog');
    await expect(addDefaultSkill(addSwap.home, addSwap.target, {
      beforeCommit: async () => {
        await rename(addSwap.directory.path('home/skills'), addSwap.directory.path('home/skills-original'));
        await symlink(addForeign, addSwap.directory.path('home/skills'));
      }
    })).rejects.toThrow(/changed while in use/u);
    await expect(lstat(addSwap.directory.path('foreign-catalog/demo-skill')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const addPublishSwap = await fixture();
    const addPublishForeign = await addPublishSwap.directory.mkdir('foreign-catalog');
    await expect(addDefaultSkill(addPublishSwap.home, addPublishSwap.target, {
      beforePublish: async () => {
        await rename(
          addPublishSwap.directory.path('home/skills'),
          addPublishSwap.directory.path('home/skills-original')
        );
        await symlink(addPublishForeign, addPublishSwap.directory.path('home/skills'));
      }
    })).rejects.toThrow(/changed while in use/u);
    await expect(lstat(addPublishSwap.directory.path('foreign-catalog/demo-skill')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const removeSwap = await fixture();
    await addDefaultSkill(removeSwap.home, removeSwap.target);
    const removeForeign = await removeSwap.directory.mkdir('foreign-catalog');
    await symlink(removeSwap.target, removeSwap.directory.path('foreign-catalog/demo-skill'));
    await expect(removeDefaultSkill(removeSwap.home, 'demo-skill', {
      beforeCommit: async () => {
        await rename(removeSwap.directory.path('home/skills'), removeSwap.directory.path('home/skills-original'));
        await symlink(removeForeign, removeSwap.directory.path('home/skills'));
      }
    })).rejects.toThrow(/changed while in use/u);
    expect(await readlink(removeSwap.directory.path('foreign-catalog/demo-skill'))).toBe(removeSwap.target);
  });

  it('uses literal link targets to guard and remove a broken registration', async () => {
    if (process.platform === 'win32') return;
    const value = await fixture();
    await addDefaultSkill(value.home, value.target);
    await value.directory.write('home/profiles/focused/AGENTS.md', 'profile\n');
    await value.directory.mkdir('home/profiles/focused/skills');
    await symlink(value.target, value.directory.path('home/profiles/focused/skills/demo-skill'), 'dir');
    await rm(value.target, { recursive: true });
    const listed = await inspectDefaultSkillCatalog(value.home);
    expect(listed.registrations).toEqual([]);
    expect(listed.diagnostics.join('\n')).toContain('broken');
    await expect(removeDefaultSkill(value.home, 'demo-skill')).rejects.toThrow(/referenced/u);
    await rm(value.directory.path('home/profiles/focused/skills/demo-skill'));
    await expect(removeDefaultSkill(value.home, 'demo-skill')).resolves.toMatchObject({ action: 'removed' });
  });
});
