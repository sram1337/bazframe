import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';
import { publishManagedProfile, type ProfilePublicationAdapter } from '../../src/profile-publishing/profile-publication.js';
import { parseProfileGithubSource, type ProfileGithubRepositoryMetadata } from '../../src/profile-publishing/profile-github.js';
import { duplicateManagedProfile, removeManagedProfile, renameManagedProfile, useManagedProfile } from '../../src/profile-publishing/profile-managed-lifecycle.js';
import { readOptionalManagedProfileState } from '../../src/profile-publishing/managed-profile-state.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

function publicationAdapter(): ProfilePublicationAdapter {
  const source = parseProfileGithubSource('git:owner/source');
  const metadata: ProfileGithubRepositoryMetadata = { repositoryId: 42, origin: source.origin, owner: source.owner, repository: source.repository, defaultBranch: 'main', visibility: 'private' };
  let created = false;
  return {
    resolveSource: async () => source,
    lookup: async () => created ? metadata : undefined,
    readTip: async () => null,
    createPrivate: async () => { created = true; return { metadata, proof: Object.freeze({ created: true }) }; },
    setVisibility: async () => metadata,
    push: async (request) => {
      const manifest = Buffer.from(`${JSON.stringify(request.profile, null, 2)}\n`);
      const manifestSha = createHash('sha256').update(manifest).digest('hex');
      const commit = 'a'.repeat(40);
      await request.beforeRefUpdate({ kind: 'profile-github-ref-update', ref: 'refs/heads/main', expectedOld: null, newCommit: commit, capturedManifestSha256: manifestSha });
      return { kind: 'profile-github-publication-effects', repositoryCreated: true, refUpdated: true, commitCreated: true, visibilityChanged: false, ref: 'refs/heads/main', expectedOld: null, commit, tree: 'b'.repeat(40), capturedManifestSha256: manifestSha };
    }
  };
}

describe('hidden profile lifecycle migration integration', () => {
  it('lazily adopts a sidecar-free profile and preserves identity rules through duplicate, rename, use, and local-only removal', async () => {
    temporary = await createTempDirectory('/tmp/bzf-hidden-migration-');
    const home = temporary.path('home');
    const source = join(home, 'profiles', 'source');
    await mkdir(join(source, 'skills', 'local'), { recursive: true });
    await writeFile(join(source, 'AGENTS.md'), 'source\n');
    await writeFile(join(source, 'skills', 'local', 'SKILL.md'), '---\nname: local\ndescription: Local.\n---\n');
    await writeFile(join(source, 'skills', 'local', '.env'), 'TOKEN=local\n');
    await writeFile(join(home, 'active-profile'), 'source\n');
    expect(await readOptionalManagedProfileState(home, 'source')).toBeUndefined();

    await publishManagedProfile({ home, yes: true }, publicationAdapter());
    const adopted = (await readOptionalManagedProfileState(home, 'source'))!.state;
    expect(adopted.publication?.origin).toBe('github.com/owner/source');
    expect(adopted.capturedResourceIds).toHaveLength(1);
    expect(adopted.capturedResourceIds[0]!.identityKind).toBe('profileLocal');

    await duplicateManagedProfile(home, 'source', 'copy');
    const duplicate = (await readOptionalManagedProfileState(home, 'copy'))!.state;
    expect(duplicate.publication).toBeNull();
    expect(duplicate.profileInstanceId).not.toBe(adopted.profileInstanceId);
    expect(duplicate.capturedResourceIds[0]!.instanceId).not.toBe(adopted.capturedResourceIds[0]!.instanceId);
    expect(await readFile(join(home, 'profiles', 'copy', 'skills', 'local', '.env'), 'utf8')).toBe('TOKEN=local\n');

    await renameManagedProfile(home, 'copy', 'renamed');
    expect((await readOptionalManagedProfileState(home, 'renamed'))!.state).toEqual(duplicate);
    const selected = await useManagedProfile(home, 'renamed');
    expect(selected).toMatchObject({ profile: { name: 'renamed' }, incomplete: false, warning: null });
    expect(await readFile(join(home, 'active-profile'), 'utf8')).toBe('renamed\n');

    await removeManagedProfile(home, 'source');
    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(home, 'profiles', 'renamed', 'skills', 'local', 'SKILL.md'), 'utf8')).toContain('name: local');
  });
});
