import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { publishStoredBlob } from '../../../src/profile-publishing/blob-store.js';
import { publishArtifactTree, type ArtifactTreeManifestV1 } from '../../../src/profile-publishing/artifact-tree.js';
import { withProfileOperationLocks } from '../../../src/profile-publishing/profile-operation-lock.js';
import { encodeManagedProfileState, type ImportedResourceState, type ManagedProfileStateV1, type PublicationState } from '../../../src/profile-publishing/publication-state.js';
import { importedResourceIdentity, resourceIdentityDigest } from '../../../src/profile-publishing/captured-profile.js';
import { readProfileSystemView, resolveProfileResourceSelector } from '../../../src/profile-publishing/profile-view.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

const alphaId = '11111111-1111-4111-8111-111111111111';
const betaId = '22222222-2222-4222-8222-222222222222';
const captureA = 'a'.repeat(64);
const captureB = 'b'.repeat(64);
const alphaStable = importedResourceIdentity(alphaId);
const betaStable = importedResourceIdentity(betaId);

async function setup(): Promise<{ home: string; treeId: string }> {
  temporary = await createTempDirectory('/tmp/bzf-view-');
  const home = join(temporary.root, 'home');
  await mkdir(join(home, 'profiles'), { recursive: true });
  const bytes = Buffer.from('---\nname: review\ndescription: Review.\n---\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest: ArtifactTreeManifestV1 = { schemaVersion: 1, kind: 'bazframe-artifact-tree', role: 'skill', files: [{ path: 'SKILL.md', sha256, bytes: bytes.byteLength, executable: false }] };
  const treeId = await withProfileOperationLocks(home, ['@store'], async (authority) => {
    await publishStoredBlob(home, authority, bytes, sha256);
    return (await publishArtifactTree(home, authority, manifest)).treeId;
  });
  return { home, treeId };
}

function publication(): PublicationState {
  return { transport: 'git', origin: 'github.com/owner/profile', installedCommit: 'c'.repeat(40), latestSeenCommit: 'd'.repeat(40), baselineCaptureSha256: 'e'.repeat(64), visibility: 'private' };
}

function state(resources: ImportedResourceState[], linked = false, profileInstanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): ManagedProfileStateV1 {
  const capturedResourceIds = resources.map((resource) => ({
    resourceIdentityDigest: resourceIdentityDigest(importedResourceIdentity(resource.instanceId)),
    capturedResourceId: resource.capturedResourceId,
    identityKind: 'imported' as const,
    instanceId: resource.instanceId
  })).sort((left, right) => left.resourceIdentityDigest.localeCompare(right.resourceIdentityDigest) || left.capturedResourceId.localeCompare(right.capturedResourceId));
  return { schemaVersion: 1, profileInstanceId, publication: linked ? publication() : null, capturedResourceIds, importedResources: [...resources].sort((left, right) => left.instanceId.localeCompare(right.instanceId)) };
}

async function writeProfile(home: string, name: string, profileState?: ManagedProfileStateV1): Promise<void> {
  const root = join(home, 'profiles', name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), `${name}\n`);
  if (profileState !== undefined) await writeFile(join(root, '.bazframe-profile-state.json'), encodeManagedProfileState(profileState, {
    maxManifestBytes: 1024 * 1024, maxProfileEntries: 1024, maxResources: 256, maxEntries: 32768,
    maxDepth: 64, maxPathBytes: 8192, maxBlobBytes: 64 * 1024 * 1024, maxAggregateBytes: 1536 * 1024 * 1024
  }));
}

function artifact(instanceId: string, capturedResourceId: string, treeId: string): ImportedResourceState {
  return { instanceId, capturedResourceId, key: { kind: 'skill', name: 'review' }, source: { kind: 'artifact', treeId } };
}

async function addOrdinarySkill(home: string, profile: string, name: string): Promise<void> {
  const enteredTarget = join(home, '..', 'ordinary', name);
  await mkdir(enteredTarget, { recursive: true });
  await writeFile(join(enteredTarget, 'SKILL.md'), `---\nname: ${name}\ndescription: Ordinary.\n---\n`);
  const target = await realpath(enteredTarget);
  await mkdir(join(home, 'skills'), { recursive: true });
  await mkdir(join(home, 'profiles', profile, 'skills'), { recursive: true });
  try { await symlink(target, join(home, 'skills', name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await symlink(target, join(home, 'profiles', profile, 'skills', name));
}

describe('hidden profile namespace and domain view', () => {
  it('keeps equal-byte imported instances distinct and computes dynamic qualified/unqualified selectors', async () => {
    const { home, treeId } = await setup();
    await writeProfile(home, 'alpha', state([artifact(alphaId, captureA, treeId)], true));
    await writeProfile(home, 'beta', state([artifact(betaId, captureB, treeId)], false, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

    const collided = await readProfileSystemView(home);
    expect(collided.resources.map((resource) => resource.stableIdentity)).toEqual([alphaStable, betaStable]);
    expect(collided.namespace.map((entry) => ({ id: entry.stableIdentity, display: entry.displayName, selectors: entry.selectors }))).toEqual([
      { id: alphaStable, display: 'alpha/review', selectors: ['alpha/review'] },
      { id: betaStable, display: 'beta/review', selectors: ['beta/review'] }
    ]);
    expect(collided.skills.map((skill)=>({identity:skill.stableIdentity,display:skill.displayName,selectors:skill.selectors}))).toEqual([
      {identity:alphaStable,display:'alpha/review',selectors:['alpha/review']},
      {identity:betaStable,display:'beta/review',selectors:['beta/review']}
    ]);
    expect(resolveProfileResourceSelector(collided, 'skill', 'alpha/review')).toBe(alphaStable);
    expect(() => resolveProfileResourceSelector(collided, 'skill', 'review')).toThrow(expect.objectContaining({ code: 'PROFILE_RESOURCE_SELECTOR_INVALID' }));
    expect(collided.profiles[0]).toMatchObject({ name: 'alpha', incomplete: false, publicationVersionState: 'older-installed' });

    await rm(join(home, 'profiles', 'beta'), { recursive: true });
    const unique = await readProfileSystemView(home);
    expect(unique.namespace[0]).toMatchObject({ displayName: 'review', selectors: ['review', 'alpha/review'] });
    expect(unique.skills[0]).toMatchObject({displayName:'review',selectors:['review','alpha/review'],directlyAttachable:true});
    expect(resolveProfileResourceSelector(unique, 'skill', 'review')).toBe(alphaStable);
    expect(() => resolveProfileResourceSelector(unique, 'skill', 'beta/review')).toThrow(expect.objectContaining({ code: 'PROFILE_RESOURCE_SELECTOR_INVALID' }));
  });

  it('merges the same stable imported instance across renamed/duplicated owners without retargeting identity', async () => {
    const { home, treeId } = await setup();
    await writeProfile(home, 'alpha', state([artifact(alphaId, captureA, treeId)]));
    await writeProfile(home, 'gamma', state([artifact(alphaId, captureA, treeId)], false, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    const view = await readProfileSystemView(home);
    expect(view.resources).toHaveLength(1);
    expect(view.resources[0]).toMatchObject({ stableIdentity: alphaStable, ownerProfiles: ['alpha', 'gamma'] });
    expect(view.namespace[0]).toMatchObject({ displayName: 'review', selectors: ['review', 'alpha/review', 'gamma/review'] });
    expect(resolveProfileResourceSelector(view, 'skill', 'gamma/review')).toBe(alphaStable);
  });

  it('combines ordinary shared memberships and imported resources by stable identity, never bytes', async () => {
    const { home, treeId } = await setup();
    await writeProfile(home, 'alpha');
    await writeProfile(home, 'beta');
    await addOrdinarySkill(home, 'alpha', 'review');
    await addOrdinarySkill(home, 'beta', 'review');
    await writeFile(join(home, 'profiles', 'beta', '.bazframe-profile-state.json'), encodeManagedProfileState(state([artifact(betaId, captureB, treeId)]), {
      maxManifestBytes: 1024 * 1024, maxProfileEntries: 1024, maxResources: 256, maxEntries: 32768,
      maxDepth: 64, maxPathBytes: 8192, maxBlobBytes: 64 * 1024 * 1024, maxAggregateBytes: 1536 * 1024 * 1024
    }));
    await expect(readProfileSystemView(home)).rejects.toMatchObject({ code: 'PROFILE_VIEW_INVALID' });

    await rm(join(home, 'profiles', 'beta', 'skills', 'review'));
    const distinct = await readProfileSystemView(home);
    expect(distinct.resources.map((resource) => resource.stableIdentity)).toEqual(['catalog:skill:review', betaStable]);
    expect(distinct.namespace.map((entry) => entry.displayName)).toEqual(['review', 'beta/review']);

    await rm(join(home, 'profiles', 'beta', '.bazframe-profile-state.json'));
    await addOrdinarySkill(home, 'beta', 'review');
    const view = await readProfileSystemView(home);
    expect(view.resources).toHaveLength(1);
    expect(view.resources[0]).toMatchObject({ stableIdentity: 'catalog:skill:review', ownerProfiles: ['alpha', 'beta'], projected: true });
  });

  it('keeps an unreferenced ordinary registration unqualified while qualifying a colliding import', async () => {
    const { home, treeId } = await setup();
    await writeProfile(home, 'alpha', state([artifact(alphaId, captureA, treeId)]));
    await addOrdinarySkill(home, 'alpha', 'review');
    await rm(join(home, 'profiles', 'alpha', 'skills', 'review'));

    const view = await readProfileSystemView(home);

    expect(view.namespace.map((entry) => ({ identity: entry.stableIdentity, display: entry.displayName, owners: entry.ownerProfiles, selectors: entry.selectors }))).toEqual([
      { identity: 'catalog:skill:review', display: 'review', owners: [], selectors: ['review'] },
      { identity: alphaStable, display: 'alpha/review', owners: ['alpha'], selectors: ['alpha/review'] }
    ]);
    expect(resolveProfileResourceSelector(view, 'skill', 'review')).toBe('catalog:skill:review');
    expect(resolveProfileResourceSelector(view, 'skill', 'alpha/review')).toBe(alphaStable);
  });

  it('represents missing resources and incompleteness without projecting a tree', async () => {
    const { home } = await setup();
    const missing: ImportedResourceState = {
      instanceId: alphaId, capturedResourceId: captureA, key: { kind: 'skill', name: 'review' },
      source: { kind: 'missingRemoteGit', identity: { remote: 'github.com/owner/review', fetchUrl: 'https://github.com/owner/review.git', branch: 'main', revision: 'f'.repeat(40) }, diagnosticCode: 'REMOTE_UNAVAILABLE' }
    };
    await writeProfile(home, 'alpha', state([missing]));
    const view = await readProfileSystemView(home);
    expect(view.profiles[0]).toMatchObject({ incomplete: true, missingResources: [{ stableIdentity: alphaStable, diagnosticCode: 'REMOTE_UNAVAILABLE' }] });
    expect(view.resources[0]).toMatchObject({ projected: false, materialization: { kind: 'missingRemoteGit' } });
    expect(view.namespace[0]).toMatchObject({ projected: false });
  });

  it('sorts resource kinds as skill, library, package in domain and missing projections', async () => {
    const { home } = await setup();
    const resources: ImportedResourceState[] = [
      { instanceId: '11111111-1111-4111-8111-111111111111', capturedResourceId: '1'.repeat(64), key: { kind: 'package', name: 'package-one' }, source: { kind: 'missingRemoteGit', identity: { remote: 'github.com/owner/package-one', fetchUrl: 'https://github.com/owner/package-one.git', branch: 'main', revision: 'a'.repeat(40) }, diagnosticCode: 'OFFLINE' } },
      { instanceId: '22222222-2222-4222-8222-222222222222', capturedResourceId: '2'.repeat(64), key: { kind: 'library', name: 'library-one' }, source: { kind: 'missingRemoteGit', identity: { remote: 'github.com/owner/library-one', fetchUrl: 'https://github.com/owner/library-one.git', branch: 'main', revision: 'b'.repeat(40) }, diagnosticCode: 'OFFLINE' } },
      { instanceId: '33333333-3333-4333-8333-333333333333', capturedResourceId: '3'.repeat(64), key: { kind: 'skill', name: 'skill-one' }, source: { kind: 'missingRemoteGit', identity: { remote: 'github.com/owner/skill-one', fetchUrl: 'https://github.com/owner/skill-one.git', branch: 'main', revision: 'c'.repeat(40) }, diagnosticCode: 'OFFLINE' } }
    ];
    await writeProfile(home, 'ordered', state(resources));
    const view = await readProfileSystemView(home);
    expect(view.resources.map((resource) => resource.key.kind)).toEqual(['skill', 'library', 'package']);
    expect(view.profiles[0]!.missingResources.map((resource) => resource.key.kind)).toEqual(['skill', 'library', 'package']);
  });

  it('fails closed on malformed sidecars and artifact role mismatch', async () => {
    const { home, treeId } = await setup();
    await writeProfile(home, 'alpha');
    await writeFile(join(home, 'profiles', 'alpha', '.bazframe-profile-state.json'), '{}\n');
    await expect(readProfileSystemView(home)).rejects.toMatchObject({ code: 'PROFILE_PUBLICATION_STATE_INVALID' });
    await rm(join(home, 'profiles', 'alpha'), { recursive: true });

    const libraryResource: ImportedResourceState = { ...artifact(alphaId, captureA, treeId), key: { kind: 'library', name: 'review' } };
    await writeProfile(home, 'alpha', state([libraryResource]));
    await expect(readProfileSystemView(home)).rejects.toMatchObject({ code: 'PROFILE_VIEW_INVALID' });
  });
});
