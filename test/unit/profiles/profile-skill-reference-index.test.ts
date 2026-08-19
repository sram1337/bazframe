import { realpath, rename, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProfileSkillReferenceIndex,
  sameProfileSkillReferenceIndex
} from '../../../src/profiles/profile-skill-reference-index.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => item.cleanup())));

describe('profile skill reference index', () => {
  it('captures parallel absolute references by literal target even after the provider breaks', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTempDirectory('profile-skill-index-'); directories.push(directory);
    await directory.write('home/profiles/one/AGENTS.md', 'one\n');
    await directory.mkdir('home/profiles/one/skills');
    await directory.write('provider/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: Test.\n---\n');
    const target = await realpath(directory.path('provider/demo-skill'));
    await symlink(target, directory.path('home/profiles/one/skills/demo-skill'));
    const first = await captureProfileSkillReferenceIndex(directory.path('home'), 'demo-skill', target);
    expect(first).toMatchObject({ profileIds: ['one'], diagnostics: [] });
    await rm(target, { recursive: true });
    const broken = await captureProfileSkillReferenceIndex(directory.path('home'), 'demo-skill', target);
    expect(broken.profileIds).toEqual(['one']);
  });

  it('fails closed when profile or skills namespaces are substituted during traversal', async () => {
    if (process.platform === 'win32') return;
    const profileSwap = await createTempDirectory('profile-skill-index-race-'); directories.push(profileSwap);
    await profileSwap.write('home/profiles/one/AGENTS.md', 'one\n');
    await profileSwap.mkdir('home/profiles/one/skills');
    const target = await profileSwap.mkdir('provider/demo-skill');
    const profileResult = await captureProfileSkillReferenceIndex(
      profileSwap.path('home'),
      'demo-skill',
      target,
      {
        afterProfileOpened: async (profileId) => {
          if (profileId !== 'one') return;
          await rename(profileSwap.path('home/profiles/one'), profileSwap.path('home/profiles/one-original'));
          await profileSwap.write('home/profiles/one/AGENTS.md', 'foreign\n');
          await profileSwap.mkdir('home/profiles/one/skills');
        }
      }
    );
    expect(profileResult.profileIds).toEqual([]);
    expect(profileResult.diagnostics).not.toEqual([]);

    const skillsSwap = await createTempDirectory('profile-skill-index-race-'); directories.push(skillsSwap);
    await skillsSwap.write('home/profiles/one/AGENTS.md', 'one\n');
    await skillsSwap.mkdir('home/profiles/one/skills');
    const secondTarget = await skillsSwap.mkdir('provider/demo-skill');
    await symlink(secondTarget, skillsSwap.path('home/profiles/one/skills/demo-skill'));
    const skillsResult = await captureProfileSkillReferenceIndex(
      skillsSwap.path('home'),
      'demo-skill',
      secondTarget,
      {
        afterSkillsOpened: async (profileId) => {
          if (profileId !== 'one') return;
          await rename(
            skillsSwap.path('home/profiles/one/skills'),
            skillsSwap.path('home/profiles/one/skills-original')
          );
          await skillsSwap.mkdir('home/profiles/one/skills');
        }
      }
    );
    expect(skillsResult.profileIds).toEqual([]);
    expect(skillsResult.diagnostics).not.toEqual([]);
  });

  it('changes identity when a membership or namespace is substituted and diagnoses unsafe profiles', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTempDirectory('profile-skill-index-'); directories.push(directory);
    await directory.write('home/profiles/one/AGENTS.md', 'one\n');
    await directory.mkdir('home/profiles/one/skills');
    const target = await directory.mkdir('provider/demo-skill');
    const first = await captureProfileSkillReferenceIndex(directory.path('home'), 'demo-skill', target);
    await symlink(target, directory.path('home/profiles/one/skills/demo-skill'));
    const changed = await captureProfileSkillReferenceIndex(directory.path('home'), 'demo-skill', target);
    expect(sameProfileSkillReferenceIndex(first, changed)).toBe(false);
    await directory.mkdir('home/profiles/Bad');
    const unsafe = await captureProfileSkillReferenceIndex(directory.path('home'), 'demo-skill', target);
    expect(unsafe.diagnostics).not.toEqual([]);
  });
});
