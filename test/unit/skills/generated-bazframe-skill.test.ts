import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFlatSkillIdentities } from '../../../src/skill-collections/skill-collection-resolver.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillRoot = resolve(projectRoot, 'skills/bazframe');

describe('generated Bazframe Skill source', () => {
  it('is Agent Skills-compatible and teaches only current commands', async () => {
    expect(loadFlatSkillIdentities([skillRoot])).toEqual([{ name: 'bazframe', definitionPath: resolve(skillRoot, 'SKILL.md') }]);
    const text = await readFile(resolve(skillRoot, 'SKILL.md'), 'utf8');
    for (const command of [
      'bazframe skill add /absolute/path/to/skill',
      'bazframe skill remove <skill>',
      'bazframe profile skill add [--profile <profile>] <skill>',
      'bazframe profile edit <profile>',
      'bazframe skill edit <skill>',
      'bazframe library add /absolute/path/to/library',
      'bazframe profile library add [--profile <profile>] <library>',
      'bazframe package add /absolute/path/to/package',
      'bazframe profile package add [--profile <profile>] <package>',
      'bazframe adapter install pi',
      'bazframe status',
      'bazframe tui'
    ]) expect(text).toContain(command);
    expect(text).not.toContain(`Bazframe ${'2'}`);
    expect(text).not.toContain(`Skill${'book'}`);
    expect(text).not.toContain(`SKILL${'BOOK'}_`);
    expect(text).not.toMatch(/bazframe add <skill>|bazframe pi/u);
  });
});
