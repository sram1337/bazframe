import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFlatSkillIdentities } from '../../../src/source-units/source-unit-resolver.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillRoot = resolve(projectRoot, 'skills/bazframe');

describe('packaged Bazframe skill source', () => {
  it('is Agent Skills-compatible and teaches only current commands', async () => {
    expect(loadFlatSkillIdentities([skillRoot])).toEqual([{ name: 'bazframe', definitionPath: resolve(skillRoot, 'SKILL.md') }]);
    const text = await readFile(resolve(skillRoot, 'SKILL.md'), 'utf8');
    for (const command of [
      'bazframe add skill /absolute/path/to/skill',
      'bazframe remove skill <skill>',
      'bazframe profile skills add <skill>',
      'bazframe sources add /absolute/path/to/source',
      'bazframe profile sources add <source>',
      'bazframe adapter install pi',
      'bazframe status',
      'bazframe tui'
    ]) expect(text).toContain(command);
    expect(text).not.toContain(`Skill${'book'}`);
    expect(text).not.toContain(`SKILL${'BOOK'}_`);
    expect(text).not.toMatch(/bazframe add <skill>|bazframe pi/u);
  });
});
