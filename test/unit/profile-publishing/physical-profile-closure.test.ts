import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, rename, symlink, writeFile } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { captureOrdinaryProfileExpectation, assertOrdinaryProfileExpectation, capturePhysicalProfileExpectation, samePhysicalProfileExpectation, serializeWindowsPhysicalProfileProof, serializePosixPhysicalProfileProof, serializePosixBackupProof, samePhysicalProfileProof } from '../../../src/profile-publishing/physical-profile-closure.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

async function setup() {
  temporary = await createTempDirectory(); await temporary.mkdir('profiles/work/skills'); await temporary.write('profiles/work/AGENTS.md', 'hello\n'); return temporary;
}

describe('ordinary read/use closure boundaries', () => {
  async function direct() {
    const temp = await setup();
    await temp.write('external/review/SKILL.md', '---\nname: review\n---\n');
    await symlink(temp.path('external/review'), temp.path('profiles/work/skills/review'), 'dir');
    return temp;
  }
  it('admits a direct unregistered reference without tree traversal or catalog authority', async () => {
    const temp = await direct();
    await symlink(temp.path('missing'), temp.path('external/review/unreadable-resource'));
    const proof = await captureOrdinaryProfileExpectation(temp.root, 'work');
    expect(proof.closure.entries).toContainEqual(expect.objectContaining({ path: 'skills/review', kind: 'direct-skill-reference', bytes: Buffer.byteLength('---\nname: review\n---\n') }));
    await assertOrdinaryProfileExpectation(temp.root, 'work', proof);
    await expect(capturePhysicalProfileExpectation(temp.root, 'work')).rejects.toMatchObject({ code: 'DEFAULT_SKILL_NOT_FOUND' });
  });
  it.each([Buffer.from('---\nname: review\n---\n\0'), Buffer.from([0xff])])('rejects invalid definition bytes in direct references', async (bytes) => {
    const temp = await direct(); await writeFile(temp.path('external/review/SKILL.md'), bytes);
    await expect(captureOrdinaryProfileExpectation(temp.root, 'work')).rejects.toThrow();
  });
  it('retains matching catalog projection but not same-name foreign ownership', async () => {
    const temp = await direct(); await temp.mkdir('skills');
    await temp.write('other/review/SKILL.md', '---\nname: review\n---\n');
    await symlink(temp.path('other/review'), temp.path('skills/review'), 'dir');
    expect((await captureOrdinaryProfileExpectation(temp.root, 'work')).closure.entries).toContainEqual(expect.objectContaining({ kind: 'direct-skill-reference' }));
    await expect(capturePhysicalProfileExpectation(temp.root, 'work')).rejects.toMatchObject({ code: 'PROFILE_PHYSICAL_CLOSURE_INVALID' });
    await rm(temp.path('skills/review')); await symlink(temp.path('external/review'), temp.path('skills/review'), 'dir');
    expect((await captureOrdinaryProfileExpectation(temp.root, 'work')).closure.entries).toContainEqual(expect.objectContaining({ kind: 'membership-link', targetIdentity: 'catalog:skill:review' }));
  });
  it.each(['definition', 'retarget', 'replace-target'] as const)('refuses %s drift across capture passes', async (variant) => {
    const temp = await direct();
    await temp.write('other/review/SKILL.md', '---\nname: review\n---\n');
    await expect(captureOrdinaryProfileExpectation(temp.root, 'work', {}, { async beforeSecondPass() {
      if (variant === 'definition') await temp.write('external/review/SKILL.md', '---\nname: review\n---\nchanged');
      if (variant === 'retarget') { await rm(temp.path('profiles/work/skills/review')); await symlink(temp.path('other/review'), temp.path('profiles/work/skills/review'), 'dir'); }
      if (variant === 'replace-target') { await rename(temp.path('external/review'), temp.path('external/old')); await rename(temp.path('other/review'), temp.path('external/review')); }
    } })).rejects.toThrow();
  });
  it('binds only the exact physical inert root, never its contents, and keeps strict captures strict', async () => {
    const temp = await setup(); await temp.mkdir('profiles/work/source-units');
    await symlink(temp.path('missing'), temp.path('profiles/work/source-units/unreadable'));
    const proof = await captureOrdinaryProfileExpectation(temp.root, 'work');
    await temp.write('profiles/work/source-units/opaque', 'changed');
    await assertOrdinaryProfileExpectation(temp.root, 'work', proof);
    await expect(capturePhysicalProfileExpectation(temp.root, 'work')).rejects.toThrow('source-units');
    await rename(temp.path('profiles/work/source-units'), temp.path('retained')); await temp.mkdir('profiles/work/source-units');
    await expect(assertOrdinaryProfileExpectation(temp.root, 'work', proof)).rejects.toThrow();
  });
  it('rejects unknown root names, inert root reparses and invalid direct definitions', async () => {
    const temp = await direct(); await temp.write('profiles/work/unknown-root', 'x');
    await expect(captureOrdinaryProfileExpectation(temp.root, 'work')).rejects.toThrow('unknown-root');
    await rm(temp.path('profiles/work/unknown-root')); await symlink(temp.path('external'), temp.path('profiles/work/source-units'), 'dir');
    await expect(captureOrdinaryProfileExpectation(temp.root, 'work')).rejects.toThrow();
    await rm(temp.path('profiles/work/source-units')); await temp.write('external/review/SKILL.md', '---\nname: wrong\n---\n');
    await expect(captureOrdinaryProfileExpectation(temp.root, 'work')).rejects.toThrow('another name');
  });
});

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


describe('physical proof domain boundary', () => {
  const posix = { identity: '0001:999999999999999999999999', sidecarSha256: null, profileClosureSha256: 'a'.repeat(64) };
  const windows = { ...posix, identity: `win32-ntfs:${'f'.repeat(16)}:${'0'.repeat(31)}1` };
  it('compares core Windows identity and hashes, refusing changed or malformed proofs and domains', () => {
    expect(serializeWindowsPhysicalProfileProof(windows)).toEqual(windows);
    expect(samePhysicalProfileProof(windows, { ...windows })).toBe(true);
    for (const changed of [{ ...windows, profileClosureSha256: 'c'.repeat(64) }, { ...windows, sidecarSha256: 'b'.repeat(64) }, { ...windows, identity: posix.identity }, { ...windows, identity: windows.identity.slice(0, -1) + '2' }, { ...windows, profileClosureSha256: 'B'.repeat(64) }]) {
      expect(samePhysicalProfileProof(windows, changed)).toBe(false);
      expect(samePhysicalProfileProof(changed, windows)).toBe(false);
    }
    expect(() => serializeWindowsPhysicalProfileProof(posix)).toThrow();
  });
  it('projects POSIX evidence, including the reduced historical backup', () => {
    expect(serializePosixPhysicalProfileProof(posix)).toEqual(posix);
    expect(serializePosixBackupProof(posix)).toEqual({ identity: posix.identity, profileClosureSha256: posix.profileClosureSha256 });
    expect(samePhysicalProfileProof(posix, { ...posix })).toBe(true);
    expect(() => serializePosixPhysicalProfileProof(windows)).toThrow();
    expect(() => serializePosixBackupProof(windows)).toThrow();
  });
  it('keeps logical closure bytes/hash independent of physical identity formatting', async () => {
    const temp = await setup();
    const captured = await capturePhysicalProfileExpectation(temp.root, 'work');
    const nativeProof = serializeWindowsPhysicalProfileProof({ ...captured, identity: windows.identity });
    expect(nativeProof.profileClosureSha256).toBe(captured.profileClosureSha256);
    expect(Object.keys(nativeProof)).toEqual(['identity', 'sidecarSha256', 'profileClosureSha256']);
    expect(JSON.stringify({ ...captured, ...nativeProof }.closure)).toBe(JSON.stringify(captured.closure));
  });
});
