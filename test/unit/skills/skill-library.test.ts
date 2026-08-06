import { symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listAvailableSkills,
  suggestSkillIds
} from '../../../src/skills/skill-library.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('Skillbook library discovery', () => {
  it('lists valid physical skills in lexical order and reports invalid entries', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTempDirectory('bazframe skill library ');
    temporaryDirectories.push(directory);
    const library = directory.path('library');
    await directory.write('library/skills/zeta/SKILL.md', skill('zeta'));
    await directory.write('library/skills/alpha/SKILL.md', skill('alpha'));
    await directory.write('library/skills/mismatch/SKILL.md', skill('other'));
    await directory.write('library/skills/missing/README.md', 'missing definition\n');
    await directory.write('library/skills/Bad/SKILL.md', skill('bad'));
    await directory.write('outside/SKILL.md', skill('linked'));
    await symlink(directory.path('outside'), directory.path('library/skills/linked'));

    const result = await listAvailableSkills({
      environment: { SKILLBOOK_LIBRARY: library }
    });

    expect(result.skillsRoot).toBe(directory.path('library/skills'));
    expect(result.skillIds).toEqual(['alpha', 'zeta']);
    expect(result.diagnostics).toHaveLength(4);
  });

  it('treats a missing skills directory as an empty library', async () => {
    const directory = await createTempDirectory('bazframe empty skill library ');
    temporaryDirectories.push(directory);
    const library = directory.path('library');

    await expect(listAvailableSkills({
      environment: { SKILLBOOK_LIBRARY: library }
    })).resolves.toMatchObject({ skillIds: [], diagnostics: [] });
  });
});

describe('skill suggestions', () => {
  it('ranks close spelling and transposition matches while excluding distant IDs', () => {
    const demo = suggestSkillIds('demo-skil', ['other', 'demo-skill', 'demo-shell']);
    expect(demo[0]).toBe('demo-skill');
    expect(demo).not.toContain('other');

    const testing = suggestSkillIds('tseting', ['testing', 'nesting', 'review']);
    expect(testing[0]).toBe('testing');
    expect(testing).not.toContain('review');
    expect(suggestSkillIds('unrelated', ['demo-skill'])).toEqual([]);
  });
});

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Test.\n---\n`;
}
