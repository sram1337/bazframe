import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { buildPublishedProfileState, publishManagedProfile, type ProfilePublicationAdapter } from '../../../src/profile-publishing/profile-publication.js';
import { parseProfileGithubSource, type ProfileGithubRepositoryMetadata } from '../../../src/profile-publishing/profile-github.js';
import { readOptionalManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';
import { encodeManagedProfileState } from '../../../src/profile-publishing/publication-state.js';
import { capturedProfileContentBaselineSha256, capturedResourceId, importedResourceIdentity, profileLocalResourceIdentity, profileLocalResourceInstanceId, resourceIdentityDigest, type CapturedResource } from '../../../src/profile-publishing/captured-profile.js';
import { publishStoredBlob } from '../../../src/profile-publishing/blob-store.js';
import { publishArtifactTree } from '../../../src/profile-publishing/artifact-tree.js';
import { withProfileOperationLocks } from '../../../src/profile-publishing/profile-operation-lock.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { addPackage } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import { encodeProfileCollectionReference } from '../../../src/profiles/profile-skill-collection-reference.js';
import { readTransactionJournal } from '../../../src/profile-publishing/transaction-journal.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

async function setup(active = 'work'): Promise<{ home: string; profile: string }> {
  temporary = await createTempDirectory('/tmp/bp-');
  const home = join(temporary.root, 'home');
  const profile = join(home, 'profiles', 'work');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'AGENTS.md'), 'publish me\n');
  await writeFile(join(home, 'active-profile'), `${active}\n`);
  return { home, profile };
}

function metadata(visibility: 'private' | 'public'): ProfileGithubRepositoryMetadata {
  return { repositoryId: 42, origin: 'github.com/owner/work', owner: 'owner', repository: 'work', defaultBranch: 'main', visibility };
}

function adapter(events: string[], options: { existing?: 'private' | 'public'; mutateAfterIntent?: () => Promise<void>; failAt?: 'create' | 'push-before-intent' | 'push-after-intent' | 'public-visibility' } = {}): ProfilePublicationAdapter {
  const source = parseProfileGithubSource('git:owner/work');
  let visibility = options.existing;
  return {
    resolveSource: async (name, origin) => { events.push(`resolve:${name}:${origin ?? 'none'}`); return source; },
    lookup: async () => { events.push('lookup'); return visibility === undefined ? undefined : metadata(visibility); },
    readTip: async () => { events.push('tip'); return options.existing === undefined ? null : 'a'.repeat(40); },
    createPrivate: async () => { events.push('create-private'); if (options.failAt === 'create') throw new Error('create fault'); visibility = 'private'; return { metadata: metadata('private'), proof: Object.freeze({ proof: true }) }; },
    setVisibility: async (_source, value) => { events.push(`visibility:${value}`); if (value === 'public' && options.failAt === 'public-visibility') throw new Error('visibility fault'); visibility = value; return metadata(value); },
    push: async (request) => {
      events.push(`push-prepare:${request.expectedOld ?? 'absent'}`);
      const manifest = Buffer.from(`${JSON.stringify(request.profile, null, 2)}\n`);
      const digest = createHash('sha256').update(manifest).digest('hex');
      const commit = request.expectedOld === null ? 'a'.repeat(40) : 'b'.repeat(40);
      if (options.failAt === 'push-before-intent') throw new Error('push preparation fault');
      await request.beforeRefUpdate({ kind: 'profile-github-ref-update', ref: 'refs/heads/main', expectedOld: request.expectedOld, newCommit: commit, capturedManifestSha256: digest });
      events.push('push');
      if (options.failAt === 'push-after-intent') throw new Error('push fault');
      await options.mutateAfterIntent?.();
      return {
        kind: 'profile-github-publication-effects', repositoryCreated: request.repositoryCreated, refUpdated: true, commitCreated: true,
        visibilityChanged: false, ref: 'refs/heads/main', expectedOld: request.expectedOld,
        commit, tree: 'c'.repeat(40), capturedManifestSha256: digest
      };
    }
  };
}

async function journalFor(home: string, transactionId: string) {
  return readTransactionJournal(home, transactionId);
}

describe('hidden profile publication orchestration', () => {
  it('publishes the active profile through private creation, push, then public visibility and atomic sidecar', async () => {
    const { home, profile } = await setup();
    const events: string[] = [];
    const result = await publishManagedProfile({ home, visibility: 'public', yes: true }, adapter(events));
    expect(events).toEqual(['resolve:work:none', 'lookup', 'tip', 'create-private', 'tip', 'push-prepare:absent', 'push', 'lookup', 'visibility:public']);
    expect(result).toMatchObject({ profileName: 'work', repository: 'github.com/owner/work', commit: 'a'.repeat(40), visibility: 'public', effects: { localStateWritten: true, profilePublished: true, cacheWritten: false, lockAcquired: true, buildExecuted: false, loginStarted: false, repositoryCreated: true, refUpdated: true, commitCreated: true, visibilityChanged: true } });
    expect(result.preview.map((entry) => entry.path)).toEqual(['profile/AGENTS.md']);
    expect(await readFile(join(profile, 'AGENTS.md'), 'utf8')).toBe('publish me\n');
    const state = (await readOptionalManagedProfileState(home, 'work'))!.state;
    expect(state).toMatchObject({ publication: { origin: 'github.com/owner/work', installedCommit: 'a'.repeat(40), latestSeenCommit: 'a'.repeat(40), visibility: 'public' }, importedResources: [] });
    expect((await journalFor(home, result.transactionId)).phase).toBe('COMMITTED');
    expect((await readdir(join(home, 'profiles'))).some((name) => name === `.bazframe-backup-${result.transactionId}`)).toBe(false);
  });

  it('preserves physical profile-local Skill bytes while publishing only ready content with profile-local identity', async () => {
    const { home, profile } = await setup();
    const local = join(profile, 'skills', 'local');
    await mkdir(join(local, 'references'), { recursive: true });
    await writeFile(join(local, 'SKILL.md'), '---\nname: local\ndescription: Local.\n---\n');
    await writeFile(join(local, 'references', 'guide.md'), 'guide\n');
    await writeFile(join(local, '.env'), 'TOKEN=retained-locally\n');

    const result = await publishManagedProfile({ home, yes: true }, adapter([]));

    expect(result.preview.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^resources\/[a-f0-9]{64}\/SKILL\.md$/u),
      expect.stringMatching(/^resources\/[a-f0-9]{64}\/references\/guide\.md$/u)
    ]));
    expect(result.preview.some((entry) => entry.path.endsWith('/.env'))).toBe(false);
    expect(await readFile(join(local, '.env'), 'utf8')).toBe('TOKEN=retained-locally\n');
    expect(await readFile(join(local, 'references', 'guide.md'), 'utf8')).toBe('guide\n');
    const state = (await readOptionalManagedProfileState(home, 'work'))!.state;
    expect(state.capturedResourceIds).toEqual([expect.objectContaining({ identityKind: 'profileLocal', instanceId: expect.any(String) })]);
    expect(state.importedResources).toEqual([]);
  });

  it('publishes an explicitly selected inactive profile without changing active selection', async () => {
    const { home } = await setup('other');
    const events: string[] = [];
    const result = await publishManagedProfile({ home, profileName: 'work', yes: true }, adapter(events));
    expect(result.profileName).toBe('work');
    expect(await readFile(join(home, 'active-profile'), 'utf8')).toBe('other\n');
  });

  it('shows exact preview before remote mutation and requires explicit routine authorization', async () => {
    const { home } = await setup();
    const events: string[] = [];
    let confirmations: readonly string[] = [];
    let preview: readonly { path: string }[] = [];
    await expect(publishManagedProfile({ home, visibility: 'public', authorize: (requested, files) => {
      confirmations = requested;
      preview = files;
      return false;
    } }, adapter(events))).rejects.toMatchObject({ code: 'PROFILE_PUBLISH_CONFIRMATION_REQUIRED' });
    expect(confirmations).toEqual(['publish-preview', 'public-visibility']);
    expect(preview.map((entry) => entry.path)).toEqual(['profile/AGENTS.md']);
    expect(events).toEqual(['resolve:work:none', 'lookup', 'tip']);
    expect(await readOptionalManagedProfileState(home, 'work')).toBeUndefined();
  });

  it('refuses an existing unlinked repository but republishes local edits from the latest base', async () => {
    const { home, profile } = await setup();
    const firstEvents: string[] = [];
    await expect(publishManagedProfile({ home, yes: true }, adapter(firstEvents, { existing: 'private' })))
      .rejects.toMatchObject({ code: 'PROFILE_REPOSITORY_UNLINKED_EXISTS' });
    expect(firstEvents).toEqual(['resolve:work:none', 'lookup']);

    const initialEvents: string[] = [];
    await publishManagedProfile({ home, yes: true }, adapter(initialEvents));
    await writeFile(join(profile, 'AGENTS.md'), 'local divergence\n');
    const retryEvents: string[] = [];
    const republished = await publishManagedProfile({ home, yes: true }, adapter(retryEvents, { existing: 'private' }));
    expect(republished.commit).toBe('b'.repeat(40));
    expect(await readFile(join(profile, 'AGENTS.md'), 'utf8')).toBe('local divergence\n');
    expect(retryEvents).toContain('push');
  });

  it('requires the latest installed linked version before any remote publication work', async () => {
    const { home, profile } = await setup();
    await publishManagedProfile({ home, yes: true }, adapter([]));
    const state = (await readOptionalManagedProfileState(home, 'work'))!.state;
    state.publication!.latestSeenCommit = 'e'.repeat(40);
    await writeFile(join(profile, '.bazframe-profile-state.json'), encodeManagedProfileState(state, capturedProfileLimitPolicy()));
    const events: string[] = [];
    await expect(publishManagedProfile({ home, yes: true }, adapter(events, { existing: 'private' })))
      .rejects.toMatchObject({ code: 'PROFILE_VERSION_NOT_LATEST' });
    expect(events).toEqual([]);
  });

  it('makes an existing public repository private before exact-lease push and preserves visibility by default later', async () => {
    const { home } = await setup();
    const firstEvents: string[] = [];
    const first = await publishManagedProfile({ home, visibility: 'public', yes: true }, adapter(firstEvents));
    expect(first.visibility).toBe('public');
    const privateEvents: string[] = [];
    const second = await publishManagedProfile({ home, visibility: 'private', yes: true }, adapter(privateEvents, { existing: 'public' }));
    expect(privateEvents).toEqual(['resolve:work:github.com/owner/work', 'lookup', 'tip', 'visibility:private', 'tip', `push-prepare:${'a'.repeat(40)}`, 'push', 'lookup']);
    expect(second).toMatchObject({ visibility: 'private', commit: 'b'.repeat(40), effects: { visibilityChanged: true } });
  });

  it.each([
    ['create', 'INTENT'],
    ['push-before-intent', 'PRIVATE_BEFORE_PUSH_PROVEN'],
    ['push-after-intent', 'PUSH_INTENT'],
    ['public-visibility', 'PUBLIC_AFTER_PUSH_INTENT']
  ] as const)('retains the last recoverable durable journal after a %s phase fault', async (failAt, phase) => {
    await temporary?.cleanup(); temporary = undefined;
    const { home, profile } = await setup();
    await expect(publishManagedProfile({ home, visibility: 'public', yes: true }, adapter([], { failAt }))).rejects.toBeDefined();
    expect(await readFile(join(profile, 'AGENTS.md'), 'utf8')).toBe('publish me\n');
    expect(await readOptionalManagedProfileState(home, 'work')).toBeUndefined();
    const names = (await readdir(join(home, 'profile-publishing', 'transactions'))).filter((name) => name.endsWith('.json'));
    expect(await readTransactionJournal(home, names[0]!.slice(0, -5))).toMatchObject({ kind: 'publication', phase });
  });

  it('captures an already-built package artifact without executing its build command', async () => {
    const { home, profile } = await setup();
    const source = join(temporary!.root, 'packages', 'toolkit');
    const marker = join(source, 'build-ran');
    await mkdir(join(source, 'dist', 'skills', 'tool'), { recursive: true });
    await writeFile(join(source, 'dist', 'skills', 'tool', 'SKILL.md'), '---\nname: tool\ndescription: Tool.\n---\n');
    await writeFile(join(source, 'build.mjs'), `import{writeFile}from'node:fs/promises';await writeFile(${JSON.stringify(marker)},'ran');\n`);
    await writeFile(join(source, 'bazframe-package.json'), `${JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }, null, 2)}\n`);
    await addPackage({ bazframeHome: home }, await realpath(source));
    await rm(marker);
    await mkdir(join(profile, 'packages'));
    await writeFile(join(profile, 'packages', 'toolkit.json'), encodeProfileCollectionReference({ schemaVersion: 1, package: 'toolkit' }));
    await publishManagedProfile({ home, yes: true }, adapter([]));
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a retained null binding whose digest does not match the ordinary resource key', () => {
    const resource: CapturedResource = { id: 'f'.repeat(64), key: { kind: 'skill', name: 'review' }, payload: { kind: 'bundled', role: 'skill', files: [] } };
    const previous = { schemaVersion: 1 as const, profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publication: null, capturedResourceIds: [{ resourceIdentityDigest: '0'.repeat(64), capturedResourceId: resource.id, identityKind: 'catalog' as const, instanceId: null }], importedResources: [] };
    expect(() => buildPublishedProfileState(previous, [resource], { transport: 'git', origin: 'github.com/owner/work', installedCommit: 'a'.repeat(40), latestSeenCommit: 'a'.repeat(40), baselineCaptureSha256: 'b'.repeat(64), visibility: 'private' })).toThrow(expect.objectContaining({ code: 'PROFILE_PUBLICATION_INVALID' }));
  });

  it('drops a removed profile-local binding instead of publishing stale managed state', () => {
    const profileInstanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const instanceId = profileLocalResourceInstanceId(profileInstanceId, 'local');
    const identity = profileLocalResourceIdentity(instanceId);
    const resource: CapturedResource = { id: capturedResourceId('skill', identity), key: { kind: 'skill', name: 'local' }, payload: { kind: 'bundled', role: 'skill', files: [] } };
    const publication = { transport: 'git' as const, origin: 'github.com/owner/work', installedCommit: 'a'.repeat(40), latestSeenCommit: 'a'.repeat(40), baselineCaptureSha256: 'b'.repeat(64), visibility: 'private' as const };
    const previous = buildPublishedProfileState(undefined, [resource], publication, profileInstanceId);

    const updated = buildPublishedProfileState(previous, [], publication, profileInstanceId);

    expect(updated.capturedResourceIds).toEqual([]);
  });

  it('copies ordinary memberships exactly and preserves imported stable identities in the sidecar swap', async () => {
    const { home, profile } = await setup();
    const ordinary = join(temporary!.root, 'ordinary', 'review');
    await mkdir(ordinary, { recursive: true });
    await writeFile(join(ordinary, 'SKILL.md'), '---\nname: review\ndescription: Review.\n---\n');
    const ordinaryTarget = await realpath(ordinary);
    await mkdir(join(home, 'skills'), { recursive: true });
    await mkdir(join(profile, 'skills'));
    await symlink(ordinaryTarget, join(home, 'skills', 'review'));
    await symlink(ordinaryTarget, join(profile, 'skills', 'review'));

    const importedBytes = Buffer.from('---\nname: inspect\ndescription: Inspect.\n---\n');
    const importedSha = createHash('sha256').update(importedBytes).digest('hex');
    const treeId = await withProfileOperationLocks(home, ['@store'], async (authority) => {
      await publishStoredBlob(home, authority, importedBytes, importedSha);
      return (await publishArtifactTree(home, authority, { schemaVersion: 1, kind: 'bazframe-artifact-tree', role: 'skill', files: [{ path: 'SKILL.md', sha256: importedSha, bytes: importedBytes.byteLength, executable: false }] })).treeId;
    });
    const instanceId = '123e4567-e89b-42d3-a456-426614174000';
    const capturedResourceId = 'd'.repeat(64);
    await writeFile(join(profile, '.bazframe-profile-state.json'), encodeManagedProfileState({
      schemaVersion: 1,
      profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      publication: null,
      capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity(instanceId)), capturedResourceId, identityKind: 'imported', instanceId }],
      importedResources: [{ instanceId, capturedResourceId, key: { kind: 'skill', name: 'inspect' }, source: { kind: 'artifact', treeId } }]
    }, capturedProfileLimitPolicy()));

    await publishManagedProfile({ home, yes: true }, adapter([]));
    expect(await readlink(join(profile, 'skills', 'review'))).toBe(ordinaryTarget);
    const state = (await readOptionalManagedProfileState(home, 'work'))!.state;
    expect(state.importedResources).toMatchObject([{ instanceId, capturedResourceId, source: { kind: 'artifact', treeId } }]);
    expect(state.capturedResourceIds).toHaveLength(2);
  });

  it('links the pushed capture while preserving local edits made after push intent as dirty', async () => {
    const { home, profile } = await setup();
    const events: string[] = [];
    const result = await publishManagedProfile({ home, yes: true }, adapter(events, {
      mutateAfterIntent: async () => writeFile(join(profile, 'AGENTS.md'), 'changed during push\n')
    }));
    expect(events).toContain('push');
    expect(await readFile(join(profile, 'AGENTS.md'), 'utf8')).toBe('changed during push\n');
    expect((await readOptionalManagedProfileState(home, 'work'))!.state.publication?.baselineCaptureSha256).toBe(capturedProfileContentBaselineSha256(result.capturedProfile, capturedProfileLimitPolicy()));
    const journal = await readTransactionJournal(home, result.transactionId);
    expect(journal).toMatchObject({ kind: 'publication', phase: 'COMMITTED', observedCommit: result.commit });
  });
});
