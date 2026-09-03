import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { capturePhysicalProfileExpectation, samePhysicalProfileExpectation } from '../../../src/profile-publishing/physical-profile-closure.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

async function setup() {
  temporary = await createTempDirectory(); await temporary.mkdir('profiles/work/skills'); await temporary.write('profiles/work/AGENTS.md', 'hello\n'); return temporary;
}

describe('physical profile closure', () => {
  it('captures sidecar-free instructions and changes when bytes change', async () => {
    const temp = await setup(); const before = await capturePhysicalProfileExpectation(temp.root, 'work');
    expect(before.sidecarSha256).toBeNull(); expect(before.closure.entries).toEqual([expect.objectContaining({ path: 'AGENTS.md', kind: 'file' })]);
    await writeFile(temp.path('profiles/work/AGENTS.md'), 'changed\n'); const after = await capturePhysicalProfileExpectation(temp.root, 'work');
    expect(samePhysicalProfileExpectation(before, after)).toBe(false);
  });

  it('rejects file mutation between its two closure proofs', async () => {
    const temp = await setup();
    await expect(capturePhysicalProfileExpectation(temp.root, 'work', {}, {
      beforeSecondPass: async () => { await writeFile(temp.path('profiles/work/AGENTS.md'), 'raced\n'); }
    })).rejects.toMatchObject({ code: 'PROFILE_PHYSICAL_CLOSURE_CHANGED' });
  });

  it('represents ordinary skill membership by semantic identity', async () => {
    const temp = await setup(); const target = await temp.mkdir('external/review'); await temp.mkdir('skills');
    await symlink(target, temp.path('skills/review'), 'dir'); await symlink(target, temp.path('profiles/work/skills/review'), 'dir');
    const expectation = await capturePhysicalProfileExpectation(temp.root, 'work');
    expect(expectation.closure.entries).toContainEqual({ path: 'skills/review', kind: 'membership-link', targetIdentity: 'catalog:skill:review' });
  });

  it('captures recursive physical profile-local Skill files and rejects unsafe trees', async () => {
    const temp = await setup();
    await temp.write('profiles/work/skills/local/SKILL.md', '---\nname: local\ndescription: Local.\n---\n');
    await temp.write('profiles/work/skills/local/references/guide.md', 'guide\n');
    const expectation = await capturePhysicalProfileExpectation(temp.root, 'work');
    expect(expectation.closure.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'skills/local/SKILL.md', kind: 'file' }),
      expect.objectContaining({ path: 'skills/local/references/guide.md', kind: 'file' })
    ]));

    await symlink(temp.path('outside'), temp.path('profiles/work/skills/local/references/link'));
    await expect(capturePhysicalProfileExpectation(temp.root, 'work')).rejects.toMatchObject({ code: 'PROFILE_PHYSICAL_CLOSURE_INVALID' });
  });

  it('rejects a physical profile-local Skill whose declared name differs from its directory', async () => {
    const temp = await setup();
    await temp.write('profiles/work/skills/local/SKILL.md', '---\nname: other\ndescription: Local.\n---\n');
    await expect(capturePhysicalProfileExpectation(temp.root, 'work')).rejects.toMatchObject({ code: 'PROFILE_PHYSICAL_CLOSURE_INVALID' });
  });

  it('captures canonical library and package references semantically', async () => {
    const temp = await setup(); await temp.write('profiles/work/libraries/lib.json', '{\n  "schemaVersion": 1,\n  "library": "lib"\n}\n'); await temp.write('profiles/work/packages/pkg.json', '{\n  "schemaVersion": 1,\n  "package": "pkg"\n}\n');
    const expectation = await capturePhysicalProfileExpectation(temp.root, 'work');
    expect(expectation.closure.entries).toEqual(expect.arrayContaining([
      { path: 'libraries/lib.json', kind: 'membership-link', targetIdentity: 'catalog:library:lib' },
      { path: 'packages/pkg.json', kind: 'membership-link', targetIdentity: 'catalog:package:pkg' }
    ]));
  });

  it('rejects unknown, special, and mismatched membership entries', async () => {
    const temp = await setup(); await temp.write('profiles/work/unknown', 'x');
    await expect(capturePhysicalProfileExpectation(temp.root, 'work')).rejects.toMatchObject({ code: 'PROFILE_PHYSICAL_CLOSURE_INVALID' });
    await mkdir(temp.path('profiles/work/unknown-dir'));
  });
});
