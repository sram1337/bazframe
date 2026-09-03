import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { captureCatalogResource, captureProfile } from '../../../src/profile-publishing/profile-capture.js';
import { addLibrary, addPackage } from '../../../src/skill-collections/skill-collection-lifecycle.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

async function fixture(): Promise<{ home: string; skill: string }> {
  temporary = await createTempDirectory('/tmp/bzf-capture-');
  const root = await realpath(temporary.root);
  const home = join(root, 'home');
  const profile = join(home, 'profiles', 'portable');
  const skill = join(root, 'ready', 'review');
  await mkdir(join(profile, 'skills'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(join(home, 'skills'), { recursive: true });
  await writeFile(join(profile, 'AGENTS.md'), 'portable\n');
  await writeFile(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Ready.\n---\n# Review\n');
  await writeFile(join(skill, 'reference.md'), 'exact reference\n');
  await writeFile(join(skill, '.env'), 'TOKEN=must-not-be-captured\n');
  await symlink(skill, join(home, 'skills', 'review'));
  await symlink(skill, join(profile, 'skills', 'review'));
  return { home, skill };
}

describe('hidden profile capture', () => {
  it('captures exact local ready-to-use Skill and instruction bytes with one preview', async () => {
    const { home } = await fixture();
    const result = await captureProfile({ bazframeHome: home, profileId: 'portable' });
    expect(result.complete).toBe(true);
    expect(result.profile.profile.name).toBe('portable');
    expect(result.profile.resources).toHaveLength(1);
    expect(result.profile.resources[0]).toMatchObject({ key: { kind: 'skill', name: 'review' }, payload: { kind: 'bundled', role: 'skill' } });
    expect(result.preview.map((entry) => entry.path)).toEqual([
      'profile/AGENTS.md',
      `resources/${result.profile.resources[0]!.id}/SKILL.md`,
      `resources/${result.profile.resources[0]!.id}/reference.md`
    ]);
    const capturedBytes = result.blobs.map((blob) => blob.bytesValue.toString());
    expect(capturedBytes).toContain('portable\n');
    expect(capturedBytes).toContain('exact reference\n');
    expect(result.manifestBytes.at(-1)).toBe(0x0a);
  });

  it('bundles a physical profile-local Skill with a stable distinct identity and excludes source-only files', async () => {
    const { home } = await fixture();
    const local = join(home, 'profiles', 'portable', 'skills', 'local');
    await mkdir(join(local, 'references'), { recursive: true });
    await writeFile(join(local, 'SKILL.md'), '---\nname: local\ndescription: Local.\n---\n');
    await writeFile(join(local, 'references', 'guide.md'), 'guide\n');
    await writeFile(join(local, '.env'), 'TOKEN=must-not-be-captured\n');
    await writeFile(join(local, '.env.local'), 'TOKEN=also-must-not-be-captured\n');
    await writeFile(join(local, 'CREDENTIALS.json'), 'secret\n');
    await writeFile(join(local, 'ID_RSA'), 'private-key\n');
    await writeFile(join(local, 'id_ed25519.pub'), 'public-pair\n');
    await writeFile(join(local, 'client.PEM'), 'pem-key\n');
    await writeFile(join(local, 'identity.p12'), 'container\n');

    const first = await captureProfile({ bazframeHome: home, profileId: 'portable' });
    const second = await captureProfile({ bazframeHome: home, profileId: 'portable' });
    const resource = first.profile.resources.find((candidate) => candidate.key.name === 'local');
    expect(resource).toMatchObject({ key: { kind: 'skill', name: 'local' }, payload: { kind: 'bundled', role: 'skill', sourceForm: 'profile-local' } });
    expect(resource!.id).toBe(second.profile.resources.find((candidate) => candidate.key.name === 'local')!.id);
    expect(first.profileInstanceId).toBe(second.profileInstanceId);
    expect(resource!.payload.kind === 'bundled' ? resource!.payload.files.map((file) => file.path) : []).toEqual(['SKILL.md', 'references/guide.md']);
    expect(first.blobs.map((blob) => blob.bytesValue.toString()).some((value) => value.includes('must-not-be-captured') || ['secret\n', 'private-key\n', 'public-pair\n', 'pem-key\n', 'container\n'].includes(value))).toBe(false);
  });

  it('double-captures one exact ordinary catalog resource and detects drift', async () => {
    const { home, skill } = await fixture();
    const capturedResourceId = 'a'.repeat(64);
    const snapshot = await captureCatalogResource({ bazframeHome: home, kind: 'skill', name: 'review', capturedResourceId, bundleRemote: true });
    expect(snapshot.resource).toMatchObject({ id: capturedResourceId, key: { kind: 'skill', name: 'review' }, payload: { kind: 'bundled', role: 'skill' } });
    expect(snapshot.resource.payload).not.toHaveProperty('sourceForm');
    expect(snapshot.blobs.map((entry) => entry.bytesValue.toString())).toContain('exact reference\n');
    await expect(captureCatalogResource(
      { bazframeHome: home, kind: 'skill', name: 'review', capturedResourceId, bundleRemote: true },
      { testHooks: { afterPass: async (pass) => { if (pass === 1) await writeFile(join(skill, 'reference.md'), 'changed\n'); } } }
    )).rejects.toMatchObject({ code: 'PROFILE_CAPTURE_CHANGED' });
  });

  it('captures exact ordinary library and built package catalog artifacts', async () => {
    const { home } = await fixture();
    const root = await realpath(temporary!.root);
    const library = join(root, 'shared');
    await mkdir(join(library, 'one'), { recursive: true });
    await writeFile(join(library, 'one', 'SKILL.md'), '---\nname: one\ndescription: One.\n---\n');
    await addLibrary({ bazframeHome: home }, library);
    const capturedLibrary = await captureCatalogResource({ bazframeHome: home, kind: 'library', name: 'shared', capturedResourceId: 'b'.repeat(64), bundleRemote: true });
    expect(capturedLibrary.resource).toMatchObject({ key: { kind: 'library', name: 'shared' }, payload: { kind: 'bundled', role: 'library' } });

    const packageRoot = join(root, 'builder');
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, 'bazframe-package.json'), JSON.stringify({
      schemaVersion: 1,
      build: [process.execPath, '-e', "require('fs').mkdirSync('dist/skills/pack',{recursive:true});require('fs').writeFileSync('dist/skills/pack/SKILL.md','---\\nname: pack\\ndescription: Pack.\\n---\\n')"],
      artifactRoot: 'dist',
      skillsRoot: 'skills'
    }));
    await addPackage({ bazframeHome: home, environment: process.env }, packageRoot);
    const capturedPackage = await captureCatalogResource({ bazframeHome: home, kind: 'package', name: 'builder', capturedResourceId: 'c'.repeat(64), bundleRemote: true });
    expect(capturedPackage.resource).toMatchObject({ key: { kind: 'package', name: 'builder' }, payload: { kind: 'bundled', role: 'packageArtifacts' } });
    expect(capturedPackage.blobs.some((entry) => entry.bytesValue.includes(Buffer.from('name: pack')))).toBe(true);
  });

  it('rejects ready-to-use links and special indirection', async () => {
    const { home, skill } = await fixture();
    await symlink(join(await realpath(temporary!.root), 'outside'), join(skill, 'linked'));
    await expect(captureProfile({ bazframeHome: home, profileId: 'portable' })).rejects.toMatchObject({ code: 'PROFILE_CAPTURE_INVALID' });
  });

  it('detects resource drift between complete capture passes', async () => {
    const { home, skill } = await fixture();
    await expect(captureProfile(
      { bazframeHome: home, profileId: 'portable' },
      { testHooks: { afterPass: async (pass) => { if (pass === 1) await writeFile(join(skill, 'reference.md'), 'changed\n'); } } }
    )).rejects.toMatchObject({ code: 'PROFILE_CAPTURE_CHANGED' });
  });

  it('returns defensive copies of captured buffers', async () => {
    const { home } = await fixture();
    const first = await captureProfile({ bazframeHome: home, profileId: 'portable' });
    first.manifestBytes.fill(0);
    first.blobs[0]!.bytesValue.fill(0);
    const second = await captureProfile({ bazframeHome: home, profileId: 'portable' });
    expect(second.manifestBytes[0]).not.toBe(0);
    expect(second.blobs[0]!.bytesValue[0]).not.toBe(0);
  });
});
