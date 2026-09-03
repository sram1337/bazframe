import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import {
  exportManagedProfile,
  importManagedProfile,
  inspectProfileImport,
  listManagedProfileVersions,
  updateManagedProfile,
  useManagedProfileVersion,
  type GitProfileSnapshot,
  type ProfileLifecycleGitAdapter,
  type ProfileLifecycleRemoteAdapter
} from '../../../src/profile-publishing/profile-lifecycle.js';
import { parseProfileGithubSource } from '../../../src/profile-publishing/profile-github.js';
import { capturedProfileContentBaselineSha256, encodeCapturedProfile, importedResourceIdentity, profileLocalResourceIdentity, profileLocalResourceInstanceId, resourceIdentityDigest, type CapturedProfileV1, type CapturedResource } from '../../../src/profile-publishing/captured-profile.js';
import { readOptionalManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';
import { encodeManagedProfileState } from '../../../src/profile-publishing/publication-state.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { publishStoredBlob } from '../../../src/profile-publishing/blob-store.js';
import { publishArtifactTree } from '../../../src/profile-publishing/artifact-tree.js';
import { captureCatalogResource, captureProfile } from '../../../src/profile-publishing/profile-capture.js';
import { buildPublishedProfileState } from '../../../src/profile-publishing/profile-publication.js';
import { readProfileSystemView } from '../../../src/profile-publishing/profile-view.js';
import { BazframeError } from '../../../src/core/errors.js';
import type { PackageBuildAuthorizationReport } from '../../../src/profile-portability/profile-import-package-build.js';
import { withProfileOperationLocks } from '../../../src/profile-publishing/profile-operation-lock.js';
import { renameManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

async function setup(): Promise<string> {
  temporary = await createTempDirectory('/tmp/bzf-lifecycle-');
  const home = join(temporary.root, 'home');
  await mkdir(join(home, 'profiles'), { recursive: true });
  return home;
}

function blob(value: string) {
  const bytesValue = Buffer.from(value);
  return { sha256: createHash('sha256').update(bytesValue).digest('hex'), bytes: bytesValue.byteLength, bytesValue };
}

function zipSnapshot(name = 'portable', instructions = 'portable\n', resources: CapturedResource[] = []) {
  const instruction = blob(instructions);
  const profile: CapturedProfileV1 = {
    schemaVersion: 1,
    kind: 'bazframe-captured-profile',
    profile: { name, instructions: { path: 'AGENTS.md', sha256: instruction.sha256, bytes: instruction.bytes, executable: false } },
    resources,
    blobs: [{ sha256: instruction.sha256, bytes: instruction.bytes }]
  };
  return { profile, manifestBytes: Buffer.from(encodeCapturedProfile(profile, {
    maxManifestBytes: 1024 * 1024, maxProfileEntries: 1024, maxResources: 256, maxEntries: 32768,
    maxDepth: 64, maxPathBytes: 8192, maxBlobBytes: 64 * 1024 * 1024, maxAggregateBytes: 1536 * 1024 * 1024
  })), blobs: [instruction], archiveBytes: 1 };
}

function gitSnapshot(name = 'portable', instructions = 'portable\n', commit = 'a'.repeat(40), resources: CapturedResource[] = []): GitProfileSnapshot {
  return {
    ...zipSnapshot(name, instructions, resources),
    source: parseProfileGithubSource('git:owner/portable'),
    commit,
    latestCommit: commit,
    visibility: 'private'
  };
}

function gitAdapter(latest: GitProfileSnapshot, versions: Record<string, GitProfileSnapshot> = {}): ProfileLifecycleGitAdapter {
  return {
    inspect: async (_source, revision) => revision === undefined ? latest : versions[revision] ?? (() => { throw new Error(`unknown revision ${revision}`); })(),
    list: async () => [{ commit: latest.latestCommit }, ...Object.values(versions).map((snapshot) => ({ commit: snapshot.commit }))]
  };
}

async function writePlainProfile(home: string, name: string, instructions = 'old\n'): Promise<void> {
  const root = join(home, 'profiles', name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), instructions);
}

async function treeRemote(): Promise<ProfileLifecycleRemoteAdapter> {
  const skill = blob('---\nname: review\ndescription: Review.\n---\n');
  return {
    materialize: async (_resource, context) => {
      await publishStoredBlob(context.home, context.authority, skill.bytesValue, skill.sha256);
      const tree = await publishArtifactTree(context.home, context.authority, {
        schemaVersion: 1,
        kind: 'bazframe-artifact-tree',
        role: 'skill',
        files: [{ path: 'SKILL.md', sha256: skill.sha256, bytes: skill.bytes, executable: false }]
      });
      if (_resource.payload.kind !== 'remoteGit') throw new Error('expected remote resource');
      return { kind: 'ready', treeId: tree.treeId, identity: _resource.payload.identity, cacheWritten: true, buildExecuted: false };
    }
  };
}

async function filesystemSnapshot(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(path: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      result.push(`${entry.isDirectory() ? 'd' : 'f'}:${relative}`);
      if (entry.isDirectory()) await walk(join(path, entry.name), relative);
    }
  }
  await walk(root);
  return result.sort();
}

describe('hidden profile lifecycle foundation', () => {
  it('exports the active profile with default path, overwrite/bundle flags, and no build boundary', async () => {
    const home = await setup();
    await writePlainProfile(home, 'portable');
    await writeFile(join(home, 'active-profile'), 'portable\n');
    let captureOptions: unknown;
    let writeOptions: unknown;
    const snapshot = zipSnapshot();
    const result = await exportManagedProfile({ home, cwd: temporary!.root, overwrite: true, bundleRemote: true }, {
      capture: async (options) => {
        captureOptions = options;
        return { ...snapshot, profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', preview: [], complete: true, missingResourceIds: [] };
      },
      writeZip: async (path, _profile, _blobs, options) => {
        writeOptions = options;
        return { path, bytes: 12, overwritten: true };
      }
    });
    expect(captureOptions).toMatchObject({ profileId: 'portable', bundleRemote: true });
    expect(writeOptions).toEqual({ overwrite: true });
    expect(result).toMatchObject({ outputPath: join(temporary!.root, 'portable.bazframe-profile.zip'), bytes: 12, overwritten: true });
  });

  it('inspects ZIP/Git imports without local mutation and reports canonical origin/collision', async () => {
    const home = await setup();
    await writePlainProfile(home, 'portable');
    const before = await filesystemSnapshot(home);
    const git = gitSnapshot();
    let inspections = 0;
    const report = await inspectProfileImport(home, { kind: 'git', value: 'git:OWNER/Portable' }, {
      git: { inspect: async () => { inspections += 1; return git; }, list: async () => [] }
    });
    expect(report).toMatchObject({ canonicalOrigin: 'github.com/owner/portable', collision: true, safeSuffix: 'portable-1', mutationPerformed: false });
    expect(inspections).toBe(1);
    expect(await filesystemSnapshot(home)).toEqual(before);
    const zip = await inspectProfileImport(home, { kind: 'zip', path: 'unused.zip' }, { readZip: async () => zipSnapshot() });
    expect(zip).toMatchObject({ sourceKind: 'zip', canonicalOrigin: null, mutationPerformed: false });
    expect(await filesystemSnapshot(home)).toEqual(before);
  });

  it('uses first-free safe suffix for --yes, keeps ZIP independent/inactive, and never treats yes as overwrite', async () => {
    const home = await setup();
    await writePlainProfile(home, 'portable', 'preserve\n');
    await writePlainProfile(home, 'portable-1');
    await writeFile(join(home, 'active-profile'), 'portable\n');
    const result = await importManagedProfile({ home, source: { kind: 'zip', path: 'unused' }, yes: true }, { readZip: async () => zipSnapshot() });
    expect(result).toMatchObject({ action: 'imported', profileName: 'portable-2', active: false, publication: null, incomplete: false });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('preserve\n');
    expect(await readFile(join(home, 'active-profile'), 'utf8')).toBe('portable\n');
    expect((await readOptionalManagedProfileState(home, 'portable-2'))!.state.publication).toBeNull();
  });

  it('refuses fresh import into a dangling active-profile destination', async () => {
    const home = await setup();
    await writeFile(join(home, 'active-profile'), 'portable\n');
    await expect(importManagedProfile({ home, source: { kind: 'zip', path: 'unused' } }, { readZip: async () => zipSnapshot() }))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_DANGLING_ACTIVE' });
    await expect(readFile(join(home, 'profiles', 'portable', 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(home, 'active-profile'), 'utf8')).toBe('portable\n');
  });

  it('supports explicit overwrite or cancel while preserving active selection atomically', async () => {
    const home = await setup();
    await writePlainProfile(home, 'portable', 'old\n');
    await writeFile(join(home, 'active-profile'), 'portable\n');
    await expect(importManagedProfile({ home, source: { kind: 'zip', path: 'unused' }, chooseCollision: async () => 'cancel' as const }, { readZip: async () => zipSnapshot('portable', 'new\n') }))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_CANCELLED' });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('old\n');
    const result = await importManagedProfile({ home, source: { kind: 'zip', path: 'unused' }, overwrite: true, yes: true }, { readZip: async () => zipSnapshot('portable', 'new\n') });
    expect(result).toMatchObject({ action: 'overwritten', active: true });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('new\n');
    expect(await readFile(join(home, 'active-profile'), 'utf8')).toBe('portable\n');
  });

  it('applies an interactive overwrite choice to the explicit destination rather than the captured name', async () => {
    const home = await setup();
    await writePlainProfile(home, 'portable', 'captured-name-target\n');
    await writePlainProfile(home, 'custom', 'explicit-target\n');
    const result = await importManagedProfile({ home, source: { kind: 'zip', path: 'unused' }, profileName: 'custom', chooseCollision: async () => 'overwrite' as const }, { readZip: async () => zipSnapshot('portable', 'new\n') });
    expect(result).toMatchObject({ action: 'overwritten', profileName: 'custom' });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('captured-name-target\n');
    expect(await readFile(join(home, 'profiles', 'custom', 'AGENTS.md'), 'utf8')).toBe('new\n');
  });

  it('allocates fresh physical profile-local identities when ZIP overwrite replaces a marked direct Skill', async () => {
    const home = await setup();
    const skill = blob('---\nname: review\ndescription: Review.\n---\n');
    const resource: CapturedResource = { id: '9'.repeat(64), key: { kind: 'skill', name: 'review' }, payload: { kind: 'bundled', role: 'skill', sourceForm: 'profile-local', files: [{ path: 'SKILL.md', sha256: skill.sha256, bytes: skill.bytes, executable: false }] } };
    const snapshot = zipSnapshot('portable', new TextDecoder().decode(skill.bytesValue), [resource]);
    const first = await importManagedProfile({ home, source: { kind: 'zip', path: 'unused' } }, { readZip: async () => snapshot });
    expect(first.effects).toEqual({ localStateWritten: true, profilePublished: true, cacheWritten: false, lockAcquired: true, buildExecuted: false, loginStarted: false, repositoryCreated: false, refUpdated: false, commitCreated: false, visibilityChanged: false });
    const firstBinding = (await readOptionalManagedProfileState(home, first.profileName))!.state.capturedResourceIds.find((item)=>item.identityKind==='profileLocal')!;
    expect(await readFile(join(home,'profiles',first.profileName,'skills','review','SKILL.md'),'utf8')).toContain('name: review');
    const second = await importManagedProfile({ home, source: { kind: 'zip', path: 'unused' }, overwrite: true }, { readZip: async () => snapshot });
    expect(second.effects).toMatchObject({ localStateWritten: true, profilePublished: true, cacheWritten: false, lockAcquired: true, buildExecuted: false });
    const secondBinding = (await readOptionalManagedProfileState(home, 'portable'))!.state.capturedResourceIds.find((item)=>item.identityKind==='profileLocal')!;
    expect(firstBinding.capturedResourceId).toBe(resource.id);
    expect(secondBinding.capturedResourceId).toBe(resource.id);
    expect(secondBinding.instanceId).not.toBe(firstBinding.instanceId);
  });

  it('links Git imports and makes reimport idempotent by canonical origin after local rename', async () => {
    const home = await setup();
    const snapshot = gitSnapshot();
    const dependencies = { git: gitAdapter(snapshot) };
    const first = await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, dependencies);
    expect(first).toMatchObject({ action: 'imported', publication: { origin: 'github.com/owner/portable', installedCommit: 'a'.repeat(40) } });
    await rename(join(home, 'profiles', 'portable'), join(home, 'profiles', 'renamed'));
    const second = await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, dependencies);
    expect(second).toMatchObject({ action: 'already-linked', profileName: 'renamed', effects: { localStateWritten: false, profilePublished: false, cacheWritten: false, lockAcquired: false, buildExecuted: false, loginStarted: false, repositoryCreated: false, refUpdated: false, commitCreated: false, visibilityChanged: false } });
    expect((await readdir(join(home, 'profiles'))).filter((name) => !name.startsWith('.bazframe-')).sort()).toEqual(['renamed']);
  });

  it('refuses idempotent Git import when canonical origin uniqueness is violated', async () => {
    const home = await setup();
    const snapshot = gitSnapshot();
    const dependencies = { git: gitAdapter(snapshot) };
    await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, dependencies);
    const linked = (await readOptionalManagedProfileState(home, 'portable'))!.state;
    await writePlainProfile(home, 'duplicate', 'duplicate\n');
    await writeFile(join(home, 'profiles', 'duplicate', '.bazframe-profile-state.json'), encodeManagedProfileState({ ...linked, profileInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, capturedProfileLimitPolicy()));
    await expect(importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, dependencies))
      .rejects.toMatchObject({ code: 'PROFILE_LIFECYCLE_INVALID' });
  });

  it('preserves a published ordinary catalog Skill through update without duplicate imported projection', async () => {
    const home = await setup();
    const enteredTarget = join(temporary!.root, 'catalog', 'review');
    await mkdir(enteredTarget, { recursive: true });
    const target = await realpath(enteredTarget);
    await writeFile(join(target, 'SKILL.md'), '---\nname: review\ndescription: Review.\n---\n');
    await mkdir(join(home, 'skills'), { recursive: true });
    await symlink(target, join(home, 'skills', 'review'));
    await writePlainProfile(home, 'portable', 'portable\n');
    await mkdir(join(home, 'profiles', 'portable', 'skills'));
    await symlink(target, join(home, 'profiles', 'portable', 'skills', 'review'));
    const captured = await captureProfile({ bazframeHome: home, profileId: 'portable', bundleRemote: true });
    const oldCommit = 'a'.repeat(40); const newCommit = 'b'.repeat(40);
    const baseline = capturedProfileContentBaselineSha256(captured.profile, capturedProfileLimitPolicy());
    const publication = { transport: 'git' as const, origin: 'github.com/owner/portable', installedCommit: oldCommit, latestSeenCommit: oldCommit, baselineCaptureSha256: baseline, visibility: 'private' as const };
    const state = buildPublishedProfileState(undefined, captured.profile.resources, publication);
    await writeFile(join(home, 'profiles', 'portable', '.bazframe-profile-state.json'), encodeManagedProfileState(state, capturedProfileLimitPolicy()));
    const snapshot: GitProfileSnapshot = { ...captured, archiveBytes: 1, source: parseProfileGithubSource('git:owner/portable'), commit: newCommit, latestCommit: newCommit, visibility: 'private' };
    const result = await updateManagedProfile({ home, profileName: 'portable' }, { git: gitAdapter(snapshot) });
    expect(result).toMatchObject({ action: 'updated', commit: newCommit });
    expect(await readlink(join(home, 'profiles', 'portable', 'skills', 'review'))).toBe(target);
    const updatedState = (await readOptionalManagedProfileState(home, 'portable'))!.state;
    expect(updatedState.importedResources).toEqual([]);
    expect(updatedState.capturedResourceIds).toEqual(state.capturedResourceIds);
    const view = await readProfileSystemView(home);
    expect(view.resources).toHaveLength(1);
    expect(view.resources[0]).toMatchObject({ stableIdentity: 'catalog:skill:review', ownerProfiles: ['portable'], materialization: { kind: 'ordinary' } });

    const later: GitProfileSnapshot = { ...snapshot, commit: 'c'.repeat(40), latestCommit: 'c'.repeat(40) };
    let catalogCaptures = 0;
    await expect(updateManagedProfile({ home, profileName: 'portable', overwrite: true }, {
      git: gitAdapter(later),
      captureCatalog: async (options, dependencies) => {
        catalogCaptures += 1;
        if (catalogCaptures === 2) await writeFile(join(target, 'SKILL.md'), '---\nname: review\ndescription: Changed.\n---\n');
        return captureCatalogResource(options, dependencies);
      }
    })).rejects.toMatchObject({ code: 'PROFILE_MATERIALIZATION_CHANGED' });
    expect((await readOptionalManagedProfileState(home, 'portable'))!.state.publication?.installedCommit).toBe(newCommit);
  });

  it('keeps publisher-keyed profile-local Skills physical across Git update and preserves excluded local files unless overwrite discards them', async () => {
    const home = await setup();
    await writePlainProfile(home, 'portable', 'portable\n');
    const local = join(home, 'profiles', 'portable', 'skills', 'local');
    await mkdir(local, { recursive: true });
    await writeFile(join(local, 'SKILL.md'), '---\nname: local\ndescription: Old.\n---\n');
    await writeFile(join(local, '.env'), 'TOKEN=local-only\n');
    const captured = await captureProfile({ bazframeHome: home, profileId: 'portable' });
    const transportedResourceId = '9'.repeat(64);
    expect(transportedResourceId).not.toBe(captured.profile.resources[0]!.id);
    const installedResource = { ...captured.profile.resources[0]!, id: transportedResourceId };
    const installedProfile = { ...captured.profile, resources: [installedResource] };
    const oldCommit = 'a'.repeat(40); const newCommit = 'b'.repeat(40);
    const baseline = capturedProfileContentBaselineSha256(installedProfile, capturedProfileLimitPolicy());
    const publication = { transport: 'git' as const, origin: 'github.com/owner/portable', installedCommit: oldCommit, latestSeenCommit: oldCommit, baselineCaptureSha256: baseline, visibility: 'private' as const };
    const localInstanceId = profileLocalResourceInstanceId(captured.profileInstanceId, 'local');
    const state = {
      schemaVersion: 1 as const,
      profileInstanceId: captured.profileInstanceId,
      publication,
      capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(profileLocalResourceIdentity(localInstanceId)), capturedResourceId: transportedResourceId, identityKind: 'profileLocal' as const, instanceId: localInstanceId }],
      importedResources: []
    };
    await writeFile(join(home, 'profiles', 'portable', '.bazframe-profile-state.json'), encodeManagedProfileState(state, capturedProfileLimitPolicy()));

    const updatedDefinition = blob('---\nname: local\ndescription: New.\n---\n');
    const updatedResource: CapturedResource = {
      ...installedResource,
      payload: { kind: 'bundled', role: 'skill', sourceForm: 'profile-local', files: [{ path: 'SKILL.md', sha256: updatedDefinition.sha256, bytes: updatedDefinition.bytes, executable: false }] }
    };
    const instruction = captured.blobs.find((item) => item.sha256 === captured.profile.profile.instructions.sha256)!;
    const updatedProfile: CapturedProfileV1 = {
      ...captured.profile,
      resources: [updatedResource],
      blobs: [{ sha256: instruction.sha256, bytes: instruction.bytes }, { sha256: updatedDefinition.sha256, bytes: updatedDefinition.bytes }].sort((left, right) => left.sha256.localeCompare(right.sha256))
    };
    const updatedSnapshot: GitProfileSnapshot = {
      profile: updatedProfile,
      manifestBytes: Buffer.from(encodeCapturedProfile(updatedProfile, capturedProfileLimitPolicy())),
      blobs: [instruction, updatedDefinition],
      archiveBytes: 1,
      source: parseProfileGithubSource('git:owner/portable'),
      commit: newCommit,
      latestCommit: newCommit,
      visibility: 'private'
    };

    await updateManagedProfile({ home, profileName: 'portable' }, { git: gitAdapter(updatedSnapshot) });
    expect(await readFile(join(local, 'SKILL.md'), 'utf8')).toContain('description: New.');
    expect(await readFile(join(local, '.env'), 'utf8')).toBe('TOKEN=local-only\n');
    const updatedState = (await readOptionalManagedProfileState(home, 'portable'))!.state;
    expect(updatedState.capturedResourceIds).toEqual(state.capturedResourceIds);
    expect(updatedState.importedResources).toEqual([]);

    const removedProfile: CapturedProfileV1 = { ...updatedProfile, resources: [], blobs: [{ sha256: instruction.sha256, bytes: instruction.bytes }] };
    const removedSnapshot: GitProfileSnapshot = {
      ...updatedSnapshot,
      profile: removedProfile,
      manifestBytes: Buffer.from(encodeCapturedProfile(removedProfile, capturedProfileLimitPolicy())),
      blobs: [instruction],
      commit: 'c'.repeat(40),
      latestCommit: 'c'.repeat(40)
    };
    await expect(updateManagedProfile({ home, profileName: 'portable' }, { git: gitAdapter(removedSnapshot) })).rejects.toMatchObject({ code: 'PROFILE_LOCAL_DIVERGENCE' });
    await updateManagedProfile({ home, profileName: 'portable', overwrite: true }, { git: gitAdapter(removedSnapshot) });
    await expect(lstat(local)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readOptionalManagedProfileState(home, 'portable'))!.state.capturedResourceIds).toEqual([]);

    const reintroducedSnapshot = { ...updatedSnapshot, commit: 'd'.repeat(40), latestCommit: 'd'.repeat(40) };
    await updateManagedProfile({ home, profileName: 'portable' }, { git: gitAdapter(reintroducedSnapshot) });
    expect(await readFile(join(local, 'SKILL.md'), 'utf8')).toContain('description: New.');
    expect((await readOptionalManagedProfileState(home, 'portable'))!.state.capturedResourceIds).toEqual(state.capturedResourceIds);
    expect((await readOptionalManagedProfileState(home, 'portable'))!.state.importedResources).toEqual([]);
  });

  it('updates a published profile after local rename without treating the display name as content divergence', async () => {
    const home = await setup();
    await writePlainProfile(home, 'portable', 'portable\n');
    const captured = await captureProfile({ bazframeHome: home, profileId: 'portable' });
    const oldCommit = 'a'.repeat(40); const newCommit = 'b'.repeat(40);
    const state = buildPublishedProfileState(undefined, captured.profile.resources, {
      transport: 'git', origin: 'github.com/owner/portable', installedCommit: oldCommit, latestSeenCommit: oldCommit,
      baselineCaptureSha256: capturedProfileContentBaselineSha256(captured.profile, capturedProfileLimitPolicy()), visibility: 'private'
    }, captured.profileInstanceId);
    await writeFile(join(home, 'profiles', 'portable', '.bazframe-profile-state.json'), encodeManagedProfileState(state, capturedProfileLimitPolicy()));
    await renameManagedProfile(home, 'portable', 'renamed');
    const snapshot: GitProfileSnapshot = { ...captured, archiveBytes: 1, source: parseProfileGithubSource('git:owner/portable'), commit: newCommit, latestCommit: newCommit, visibility: 'private' };

    const result = await updateManagedProfile({ home, profileName: 'renamed' }, { git: gitAdapter(snapshot) });

    expect(result).toMatchObject({ action: 'updated', profileName: 'renamed', commit: newCommit });
    expect((await readOptionalManagedProfileState(home, 'renamed'))!.state.profileInstanceId).toBe(captured.profileInstanceId);
  });

  it('allows only initial incomplete creation and retries missing resources on same-commit update', async () => {
    const home = await setup();
    const remoteResource: CapturedResource = {
      id: 'c'.repeat(64), key: { kind: 'skill', name: 'review' },
      payload: { kind: 'remoteGit', identity: { remote: 'github.com/owner/review', fetchUrl: 'https://github.com/owner/review.git', branch: 'main', revision: 'd'.repeat(40) } }
    };
    const snapshot = gitSnapshot('portable', 'portable\n', 'a'.repeat(40), [remoteResource]);
    snapshot.latestCommit = snapshot.commit;
    const unavailable: ProfileLifecycleRemoteAdapter = { materialize: async () => ({ kind: 'acquisitionUnavailable', diagnosticCode: 'OFFLINE', cacheWritten: false, buildExecuted: false }) };
    await writePlainProfile(home, 'portable', 'existing\n');
    await expect(importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' }, overwrite: true }, { git: gitAdapter(snapshot), remote: unavailable }))
      .rejects.toMatchObject({ code: 'PROFILE_REMOTE_RESOURCE_UNAVAILABLE' });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('existing\n');
    await rm(join(home, 'profiles', 'portable'), { recursive: true });
    const imported = await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, { git: gitAdapter(snapshot), remote: unavailable });
    expect(imported).toMatchObject({ incomplete: true, missingResourceIds: ['c'.repeat(64)] });
    await expect(updateManagedProfile({ home, profileName: 'portable' }, { git: gitAdapter(snapshot), remote: unavailable }))
      .rejects.toMatchObject({ code: 'PROFILE_REMOTE_RESOURCE_UNAVAILABLE' });
    expect((await readOptionalManagedProfileState(home, 'portable'))!.state.importedResources[0]!.source.kind).toBe('missingRemoteGit');
    const updated = await updateManagedProfile({ home, profileName: 'portable' }, { git: gitAdapter(snapshot), remote: await treeRemote() });
    expect(updated.action).toBe('updated');
    expect((await readOptionalManagedProfileState(home, 'portable'))!.state.importedResources[0]!.source.kind).toBe('remoteGit');
  });

  it('binds package build authorization mode and never converts authorization failures into incompleteness', async () => {
    const home = await setup();
    const identity = { remote: 'github.com/owner/builder', fetchUrl: 'https://github.com/owner/builder.git', branch: 'main', revision: 'd'.repeat(40) };
    const resource: CapturedResource = { id: '8'.repeat(64), key: { kind: 'package', name: 'builder' }, payload: { kind: 'remoteGit', identity } };
    const report: PackageBuildAuthorizationReport = {
      packageId: 'builder', source: { type: 'remoteGit', ...identity }, candidateRoot: '/private/candidate', cwd: '/private/candidate', argv: ['node', 'build.js'],
      manifest: { path: 'bazframe-package.json', sha256: '7'.repeat(64) }, artifactRoot: 'dist', skillsRoot: 'skills', shell: false,
      environment: { inherited: true, namesAndValuesExposed: false }, authority: { sandboxed: false, user: 'current-process-user', access: ['credentials', 'network', 'user-files'] },
      warning: 'Package build side effects are not rollbackable.'
    };
    const makeReady = (expectedMode: 'interactive' | 'preauthorized' | 'decline', requiresBuild = true): ProfileLifecycleRemoteAdapter => ({
      materialize: async (captured, context) => {
        expect(context.packageBuildAuthorization.mode).toBe(expectedMode);
        if (!requiresBuild) {
          // Exact ready/cache reuse is authorization-free.
        } else if (context.packageBuildAuthorization.mode === 'interactive') {
          if (!await context.packageBuildAuthorization.authorize(report)) throw new BazframeError('PROFILE_PACKAGE_BUILD_CONFIRMATION_REQUIRED', 'Package build declined.');
        } else if (context.packageBuildAuthorization.mode === 'decline') {
          throw new BazframeError('PROFILE_PACKAGE_BUILD_CONFIRMATION_REQUIRED', 'Package build declined.');
        }
        const bytes = blob('package artifact\n');
        const published = await publishStoredBlob(context.home, context.authority, bytes.bytesValue, bytes.sha256);
        const tree = await publishArtifactTree(context.home, context.authority, { schemaVersion: 1, kind: 'bazframe-artifact-tree', role: 'packageArtifacts', files: [{ path: 'artifact.txt', sha256: bytes.sha256, bytes: bytes.bytes, executable: false }] });
        if (captured.payload.kind !== 'remoteGit') throw new Error('expected remote resource');
        return { kind: 'ready', treeId: tree.treeId, identity: captured.payload.identity, cacheWritten: !published.reused || !tree.reused, buildExecuted: requiresBuild };
      }
    });
    let prompts = 0;
    const interactive = gitSnapshot('interactive', 'interactive\n', 'a'.repeat(40), [resource]);
    interactive.source = parseProfileGithubSource('git:owner/interactive');
    const interactiveResult = await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/interactive' }, authorizePackageBuild: async () => { prompts += 1; return true; } }, { git: gitAdapter(interactive), remote: makeReady('interactive') });
    expect(interactiveResult.effects).toMatchObject({ cacheWritten: true, buildExecuted: true, localStateWritten: true, profilePublished: true, lockAcquired: true });
    expect(prompts).toBe(1);

    const automatic = gitSnapshot('automatic', 'automatic\n', 'b'.repeat(40), [resource]);
    automatic.source = parseProfileGithubSource('git:owner/automatic');
    const automaticResult = await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/automatic' }, yes: true, authorizePackageBuild: async () => { prompts += 1; return false; } }, { git: gitAdapter(automatic), remote: makeReady('preauthorized') });
    expect(automaticResult.effects).toMatchObject({ cacheWritten: false, buildExecuted: false });
    expect(prompts).toBe(1);

    const cached = gitSnapshot('cached', 'cached\n', 'c'.repeat(40), [resource]);
    cached.source = parseProfileGithubSource('git:owner/cached');
    let cachedAdapterCalls = 0;
    await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/cached' } }, {
      git: gitAdapter(cached),
      remote: { materialize: async () => { cachedAdapterCalls += 1; throw new Error('cache reuse attempted acquisition'); } }
    });
    expect(cachedAdapterCalls).toBe(0);
    expect(prompts).toBe(1);

    const declinedResource: CapturedResource = {
      ...resource,
      payload: { kind: 'remoteGit', identity: { ...identity, revision: 'e'.repeat(40) } }
    };
    const declined = gitSnapshot('declined', 'declined\n', 'd'.repeat(40), [declinedResource]);
    declined.source = parseProfileGithubSource('git:owner/declined');
    await expect(importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/declined' } }, { git: gitAdapter(declined), remote: makeReady('decline') }))
      .rejects.toMatchObject({ code: 'PROFILE_PACKAGE_BUILD_CONFIRMATION_REQUIRED' });
    await expect(readFile(join(home, 'profiles', 'declined', 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when one exact remote identity has conflicting cached artifact trees', async () => {
    const home = await setup();
    const identity = { remote: 'github.com/owner/review', fetchUrl: 'https://github.com/owner/review.git', branch: 'main', revision: 'a'.repeat(40) };
    const resource: CapturedResource = { id: '9'.repeat(64), key: { kind: 'skill', name: 'review' }, payload: { kind: 'remoteGit', identity } };
    const first = gitSnapshot('first-cache', 'first\n', '1'.repeat(40), [resource]);
    first.source = parseProfileGithubSource('git:owner/first-cache');
    await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/first-cache' } }, { git: gitAdapter(first), remote: await treeRemote() });

    const conflictingBlob = blob('conflicting artifact\n');
    const tx = '9123456789abcdef0123456789abcdef';
    const conflictingTree = await withProfileOperationLocks(home, ['conflict-owner', '@store'], async (authority) => {
      await publishStoredBlob(home, authority, conflictingBlob.bytesValue, conflictingBlob.sha256);
      return publishArtifactTree(home, authority, { schemaVersion: 1, kind: 'bazframe-artifact-tree', role: 'skill', files: [{ path: 'SKILL.md', sha256: conflictingBlob.sha256, bytes: conflictingBlob.bytes, executable: false }] });
    }, tx);
    await writePlainProfile(home, 'conflict-owner', 'conflict\n');
    const instanceId = '99999999-9999-4999-8999-999999999999';
    await writeFile(join(home, 'profiles', 'conflict-owner', '.bazframe-profile-state.json'), encodeManagedProfileState({
      schemaVersion: 1,
      profileInstanceId: '88888888-8888-4888-8888-888888888888',
      publication: null,
      capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity(instanceId)), capturedResourceId: resource.id, identityKind: 'imported', instanceId }],
      importedResources: [{ instanceId, capturedResourceId: resource.id, key: { ...resource.key }, source: { kind: 'remoteGit', identity, treeId: conflictingTree.treeId } }]
    }, capturedProfileLimitPolicy()));

    const second = gitSnapshot('second-cache', 'second\n', '2'.repeat(40), [resource]);
    second.source = parseProfileGithubSource('git:owner/second-cache');
    let remoteCalls = 0;
    await expect(importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/second-cache' } }, {
      git: gitAdapter(second), remote: { materialize: async () => { remoteCalls += 1; throw new Error('should not acquire'); } }
    })).rejects.toMatchObject({ code: 'PROFILE_MATERIALIZATION_INVALID' });
    expect(remoteCalls).toBe(0);
  });

  it('requires overwrite for dirty local updates; yes never discards divergence', async () => {
    const home = await setup();
    const initial = gitSnapshot('portable', 'initial\n', 'a'.repeat(40));
    await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, { git: gitAdapter(initial) });
    await writeFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'dirty\n');
    const latest = gitSnapshot('portable', 'latest\n', 'b'.repeat(40));
    await expect(updateManagedProfile({ home, profileName: 'portable', yes: true }, { git: gitAdapter(latest) }))
      .rejects.toMatchObject({ code: 'PROFILE_LOCAL_DIVERGENCE' });
    await updateManagedProfile({ home, profileName: 'portable', overwrite: true }, { git: gitAdapter(latest) });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('latest\n');
  });

  it('CAS-binds dirty-local authorization across remote inspection', async () => {
    const home = await setup();
    const initial = gitSnapshot('portable', 'initial\n', 'a'.repeat(40));
    await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, { git: gitAdapter(initial) });
    const latest = gitSnapshot('portable', 'latest\n', 'b'.repeat(40));
    let changed = false;
    await expect(updateManagedProfile({ home, profileName: 'portable' }, {
      git: gitAdapter(latest),
      capture: async (options, dependencies) => {
        const captured = await captureProfile(options, dependencies);
        if (!changed) { changed = true; await writeFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'raced\n'); }
        return captured;
      }
    })).rejects.toMatchObject({ code: 'PROFILE_PHYSICAL_CLOSURE_CHANGED' });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('raced\n');
  });

  it('fast-paths an already installed version without materialization or local writes', async () => {
    const home = await setup();
    const current = gitSnapshot('portable', 'current\n', 'a'.repeat(40));
    await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, { git: gitAdapter(current) });
    await writeFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'dirty but preserved\n');
    const before = await filesystemSnapshot(home);
    let remoteCalls = 0;
    const result = await useManagedProfileVersion({ home, profileName: 'portable', revision: current.commit }, {
      git: gitAdapter(current, { [current.commit]: current }), remote: { materialize: async () => { remoteCalls += 1; throw new Error('must not materialize'); } }
    });
    expect(result.action).toBe('current');
    expect(remoteCalls).toBe(0);
    expect(await filesystemSnapshot(home)).toEqual(before);
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('dirty but preserved\n');
  });

  it('lists full versions and uses older/newer commits direction-neutrally', async () => {
    const home = await setup();
    const oldCommit = 'a'.repeat(40);
    const latestCommit = 'b'.repeat(40);
    const initial = gitSnapshot('portable', 'latest\n', latestCommit);
    initial.latestCommit = latestCommit;
    const old = gitSnapshot('portable', 'old\n', oldCommit);
    old.latestCommit = latestCommit;
    const adapter: ProfileLifecycleGitAdapter = {
      inspect: async (_source, revision) => revision !== undefined && oldCommit.startsWith(revision) ? old : initial,
      list: async () => [{ commit: latestCommit }, { commit: oldCommit }]
    };
    await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, { git: adapter });
    expect(await listManagedProfileVersions(home, 'portable', { git: adapter })).toEqual([
      { commit: latestCommit, current: true, latest: true },
      { commit: oldCommit, current: false, latest: false }
    ]);
    await useManagedProfileVersion({ home, profileName: 'portable', revision: oldCommit.slice(0, 8) }, { git: adapter });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('old\n');
    await expect(useManagedProfileVersion({ home, profileName: 'portable', revision: 'HEAD^' }, { git: adapter }))
      .rejects.toMatchObject({ code: 'PROFILE_LIFECYCLE_INVALID' });
    await useManagedProfileVersion({ home, profileName: 'portable', revision: latestCommit }, { git: adapter });
    expect(await readFile(join(home, 'profiles', 'portable', 'AGENTS.md'), 'utf8')).toBe('latest\n');
  });
});
