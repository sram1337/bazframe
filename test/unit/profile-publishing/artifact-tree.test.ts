import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { readStoredBlob } from '../../../src/profile-publishing/blob-store.js';
import { artifactTreeId, decodeArtifactTreeManifest, encodeArtifactTreeManifest, readArtifactTree, type ArtifactTreeManifestV1 } from '../../../src/profile-publishing/artifact-tree.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const make = (bytes: Buffer): ArtifactTreeManifestV1 => ({ schemaVersion: 1, kind: 'bazframe-artifact-tree', role: 'skill', files: [{ path: 'SKILL.md', sha256: hash(bytes), bytes: bytes.length, executable: false }] });

async function stageCommittedTree(root: string, manifest: ArtifactTreeManifestV1, includeMarker = true): Promise<string> {
  const id = artifactTreeId(manifest); const tree = `${root}/profile-publishing/trees/${id}`;
  await mkdir(`${tree}/root`, { recursive: true }); await writeFile(`${tree}/root/SKILL.md`, Buffer.alloc(manifest.files[0]!.bytes, 'x'));
  await writeFile(`${tree}/manifest.json`, encodeArtifactTreeManifest(manifest));
  if (includeMarker) await writeFile(`${tree}/COMMITTED`, `${id}\n`);
  return id;
}

describe('read-only immutable blob and artifact tree stores', () => {
  it('reads a canonical tree only after its final commitment marker', async () => {
    temporary = await createTempDirectory(); const bytes = Buffer.from('x'); const manifest = make(bytes); const id = await stageCommittedTree(temporary.root, manifest);
    expect((await readArtifactTree(temporary.root, id)).manifest).toEqual(manifest);
  });

  it('never exposes partially published final content', async () => {
    temporary = await createTempDirectory(); const manifest = make(Buffer.from('x')); const id = await stageCommittedTree(temporary.root, manifest, false);
    await expect(readArtifactTree(temporary.root, id)).rejects.toThrow(/not atomically committed/u);
    await writeFile(temporary.path('profile-publishing/trees', id, 'COMMITTED'), `${id}\n`);
    expect((await readArtifactTree(temporary.root, id)).treeId).toBe(id);
  });

  it('enforces canonical manifests and exact physical closure', async () => {
    temporary = await createTempDirectory(); const manifest = make(Buffer.from('x')); const encoded = encodeArtifactTreeManifest(manifest);
    expect(decodeArtifactTreeManifest(Buffer.from(encoded))).toEqual(manifest); expect(() => decodeArtifactTreeManifest(Buffer.from(JSON.stringify(manifest)))).toThrow(/canonical/u);
    const id = await stageCommittedTree(temporary.root, manifest); await writeFile(temporary.path('profile-publishing/trees', id, 'root/SKILL.md'), 'y');
    await expect(readArtifactTree(temporary.root, id)).rejects.toMatchObject({ code: 'PROFILE_ARTIFACT_TREE_INVALID' });
  });

  it('rejects symlink substitution and executable mismatch', async () => {
    temporary = await createTempDirectory(); const manifest = make(Buffer.from('x')); const id = await stageCommittedTree(temporary.root, manifest);
    await chmod(temporary.path('profile-publishing/trees', id, 'root/SKILL.md'), 0o700); await expect(readArtifactTree(temporary.root, id)).rejects.toMatchObject({ code: 'PROFILE_ARTIFACT_TREE_INVALID' });
    await chmod(temporary.path('profile-publishing/trees', id, 'root/SKILL.md'), 0o600); await mkdir(temporary.path('bad')); await symlink(temporary.path('bad'), temporary.path('profile-publishing/trees', id, 'root/link'));
    await expect(readArtifactTree(temporary.root, id)).rejects.toMatchObject({ code: 'PROFILE_ARTIFACT_TREE_INVALID' });
  });

  it('reads only exact stored blobs and has no premature cleanup/publication API', async () => {
    temporary = await createTempDirectory(); const bytes = Buffer.from('blob'); const digest = hash(bytes); await mkdir(temporary.path('profile-publishing/blobs'), { recursive: true }); await writeFile(temporary.path('profile-publishing/blobs', digest), bytes);
    expect(await readStoredBlob(temporary.root, digest)).toEqual(bytes); await writeFile(temporary.path('profile-publishing/blobs', digest), 'wrong'); await expect(readStoredBlob(temporary.root, digest)).rejects.toThrow(/digest/u);
  });

  it('rejects drive-prefixed artifact paths', () => {
    expect(() => encodeArtifactTreeManifest({ schemaVersion: 1, kind: 'bazframe-artifact-tree', role: 'skill', files: [{ path: 'C:/payload', sha256: 'a'.repeat(64), bytes: 0, executable: false }] })).toThrow(/file record/u);
  });
});
