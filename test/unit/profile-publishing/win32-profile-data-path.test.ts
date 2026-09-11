import { createWindowsReadyResourceServices } from '../../../src/skill-collections/win32-ready-resource-services.js';
import { addLibrary, updateLibrary } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import { addProfileLibraryReference } from '../../../src/profiles/profile-skill-collection-reference-lifecycle.js';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async (original) => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, readlink: vi.fn(actual.readlink) }; });
afterEach(() => vi.restoreAllMocks());
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { ensureWindowsPrivateDirectoryPath, createWindowsPrivateDirectory } from '../../../src/state/win32-private-directory.js';
import { withWindowsProfileOperationLocksForInternalTesting, type OperationMutationAuthority } from '../../../src/profile-publishing/profile-operation-lock.js';
import { materializeCapturedProfile, type CapturedBlobSource, type ProfileMaterializationOptions } from '../../../src/profile-publishing/profile-materialization.js';
import { createWindowsProfileStorage, writeWindowsProfileFile } from '../../../src/profile-publishing/win32-profile-storage.js';
import { createWindowsProfileDataReads } from '../../../src/profile-publishing/win32-profile-data-reads.js';
import { createWindowsOrdinaryProfileReads } from '../../../src/profile-publishing/win32-physical-profile-reads.js';
import { captureCatalogResource, captureProfile } from '../../../src/profile-publishing/profile-capture.js';
import { createCanonicalProfileZip } from '../../../src/profile-publishing/profile-zip.js';
import { readProfileSystemView } from '../../../src/profile-publishing/profile-view.js';
import { createWindowsProfileActivationServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-activation.js';
import { useManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { artifactTreeId } from '../../../src/profile-publishing/artifact-tree.js';
import { encodeWindowsExecutableMetadata, decodeWindowsExecutableMetadata, WINDOWS_EXECUTABLE_METADATA } from '../../../src/profile-publishing/win32-profile-executable.js';
import { encodeSnapshotManifest, SKILL_SNAPSHOT_LIMITS, type SkillSnapshotLimitPolicy } from '../../../src/skill-collections/skill-snapshot.js';
import { encodeLibrary, encodePackage } from '../../../src/skill-collections/skill-collection-store.js';
import { encodeManagedProfileState, publicationSidecarName } from '../../../src/profile-publishing/publication-state.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { ordinaryResourceIdentity, resourceIdentityDigest, type CapturedProfileV1, type CapturedResource } from '../../../src/profile-publishing/captured-profile.js';
const HOME = 'C:\\boundary\\home';
const TX = '0123456789abcdef0123456789abcdef';
const TX2 = '1123456789abcdef0123456789abcdef';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const definition = (name: string) => `---\nname: ${name}\ndescription: Ready.\n---\n`;
function fixture() {
  const f = windowsProvisioningFixture();
  for (const path of [HOME, `${HOME}\\profiles`, `${HOME}\\skills`, `${HOME}\\locks`]) ensureWindowsPrivateDirectoryPath(f.backend, path);
  const storage = createWindowsProfileStorage(f.backend, f.io);
  const data = createWindowsProfileDataReads(f.backend);
  const reads = createWindowsOrdinaryProfileReads(f.backend);
  const candidate = (tx = TX) => { const path = `${HOME}\\profiles\\.bazframe-candidate-${tx}`; createWindowsPrivateDirectory(f.backend, `${HOME}\\profiles`, win32.basename(path)); return path; };
  const locked = <T>(tx: string, operation: (authority: OperationMutationAuthority) => Promise<T>) => withWindowsProfileOperationLocksForInternalTesting(f.backend, HOME, ['@store', 'work'], tx, operation, { lockIo: f.io });
  return { ...f, storage, data, reads, candidate, locked };
}
// Candidate-state publication remains the caller's effect, as on POSIX; Task 4 owns transaction composition.
async function materializeCandidate(f: ReturnType<typeof fixture>, options: ProfileMaterializationOptions) {
  const result = await materializeCapturedProfile(options);
  await f.storage.writeCandidateState(options.home, options.candidateDirectory, options.authority, result.state);
  return result;
}
function bundle() {
  const blobs = new Map<string, CapturedBlobSource>();
  function file(path: string, contents: string | Buffer, executable = false) {
    const bytesValue = Buffer.from(contents); const sha256 = hash(bytesValue);
    blobs.set(sha256, { sha256, bytes: bytesValue.length, bytesValue });
    return { path, sha256, bytes: bytesValue.length, executable };
  }
  const resources: CapturedResource[] = [
    { id: '1'.repeat(64), key: { kind: 'skill', name: 'direct' }, payload: { kind: 'bundled', role: 'skill', files: [file('SKILL.md', definition('direct')), file('nested/data.bin', Buffer.from([0, 255, 42])), file('nested/run.sh', '#!/bin/sh\necho direct\n', true)] } },
    { id: '2'.repeat(64), key: { kind: 'skill', name: 'local' }, payload: { kind: 'bundled', role: 'skill', sourceForm: 'profile-local', files: [file('SKILL.md', definition('local')), file('deep/guide.md', 'local guide\n', true)] } },
    { id: '3'.repeat(64), key: { kind: 'library', name: 'library' }, payload: { kind: 'bundled', role: 'library', files: [file('nested/library-child/SKILL.md', definition('library-child')), file('nested/library-child/data.bin', Buffer.from([7, 0, 128]), true)] } },
    { id: '4'.repeat(64), key: { kind: 'package', name: 'package' }, payload: { kind: 'bundled', role: 'packageArtifacts', files: [file('out/package-child/SKILL.md', definition('package-child')), file('out/package-child/tool.txt', 'already built\n', true)] } }
  ];
  const instructions = file('AGENTS.md', '# Work\n', true);
  const profile: CapturedProfileV1 = { schemaVersion: 1, kind: 'bazframe-captured-profile', profile: { name: 'work', instructions }, resources, blobs: [...blobs.values()].map(({ sha256, bytes }) => ({ sha256, bytes })).sort((a, b) => a.sha256.localeCompare(b.sha256)) };
  return { profile, blobs: [...blobs.values()] };
}
async function materializedFixture() {
  const f = fixture(), source = bundle(), candidate = f.candidate();
  const result = await f.locked(TX, (authority) => materializeCandidate(f, { home: HOME, authority, candidateDirectory: candidate, captured: source.profile, blobs: source.blobs, allowIncomplete: false,
    effects: f.storage.materializationEffects(HOME, authority, (home) => readProfileSystemView(home, f.data.viewReads)),
    materializeRemote: async () => { throw new Error('bundled resources must not acquire or build'); }
  }));
  return { ...f, source, path: candidate, result };
}
async function liveFixture() {
  const f = await materializedFixture();
  await f.backend.renameDirectoryNoReplace(`${HOME}\\profiles`, win32.basename(f.path), 'work');
  return f;
}

describe('requested-profile imported flat inputs for ready resources', () => {
  it.each(['direct', 'library-child', 'package-child'])('checks imported %s collisions only for the referencing profile', async (name) => {
    const f = await liveFixture();
    const root = win32.join('C:/boundary/incoming');
    ensureWindowsPrivateDirectoryPath(f.backend, win32.join(root, 'child'));
    f.file(win32.join(root, 'child', 'SKILL.md'), definition(name));
    ensureWindowsPrivateDirectoryPath(f.backend, win32.join(HOME, 'profiles', 'other', 'skills'));
    f.file(win32.join(HOME, 'profiles', 'other', 'AGENTS.md'), 'Other');
    const services = createWindowsReadyResourceServices(f.backend, { storageIo: f.io, stateIo: f.io, lockIo: f.io, journal: { io: f.io } });
    const options = { bazframeHome: HOME, services };
    await addLibrary(options, root, { services });
    expect(await addProfileLibraryReference(options, 'other', 'incoming')).toMatchObject({ action: 'added' });
    expect(await updateLibrary(options, 'incoming', { services })).toMatchObject({ action: 'updated' });
    await expect(addProfileLibraryReference(options, 'work', 'incoming')).rejects.toMatchObject({ code: 'SKILL_COLLECTION_CANDIDATE_DUPLICATE' });
  });
  it.each(['reference-add', 'dependent-update'])('rejects an imported flat definition missing description during %s', async (operation) => {
    const f = await liveFixture();
    const root = win32.join('C:/boundary/incoming');
    ensureWindowsPrivateDirectoryPath(f.backend, win32.join(root, 'child'));
    f.file(win32.join(root, 'child', 'SKILL.md'), definition('incoming-child'));
    const services = createWindowsReadyResourceServices(f.backend, { storageIo: f.io, stateIo: f.io, lockIo: f.io, journal: { io: f.io } });
    const options = { bazframeHome: HOME, services };
    await addLibrary(options, root, { services });
    if (operation === 'dependent-update') await addProfileLibraryReference(options, 'work', 'incoming');
    const bytes = Buffer.from('---\nname: direct\n---\n'), sha256 = hash(bytes);
    const tree = await f.locked(TX2, async (authority) => {
      await f.storage.publishBlob(HOME, authority, bytes, sha256);
      return f.storage.publishTree(HOME, authority, { schemaVersion: 1, kind: 'bazframe-artifact-tree', role: 'skill', files: [{ path: 'SKILL.md', sha256, bytes: bytes.length, executable: false }] });
    });
    const imported = f.result.state.importedResources.find((resource) => resource.key.name === 'direct')!;
    if (imported.source.kind !== 'artifact') throw new Error('fixture');
    imported.source.treeId = tree.treeId;
    f.nodes.get(win32.join(HOME, 'profiles', 'work', publicationSidecarName()))!.bytes = Buffer.from(encodeManagedProfileState(f.result.state, capturedProfileLimitPolicy()));
    const before = Buffer.from(f.nodes.get(win32.join(HOME, 'libraries', 'incoming.json'))!.bytes!);
    if (operation === 'reference-add') await expect(addProfileLibraryReference(options, 'work', 'incoming')).rejects.toMatchObject({ code: 'INVALID_SKILL_DEFINITION' });
    else await expect(updateLibrary(options, 'incoming', { services })).rejects.toMatchObject({ code: 'SKILL_COLLECTION_DEPENDENT_INVALID' });
    expect(f.nodes.get(win32.join(HOME, 'libraries', 'incoming.json'))!.bytes).toEqual(before);
  });
});

function ordinarySnapshotFixture() {
  const f = fixture();
  const contents = Buffer.from(definition('child')), excluded = Buffer.alloc(1024, 's');
  const manifest = { schemaVersion: 1 as const, entries: [
    { path: '.', type: 'directory' as const },
    { path: '.env', type: 'file' as const, executable: false, sha256: hash(excluded) },
    { path: 'child', type: 'directory' as const },
    { path: 'child/SKILL.md', type: 'file' as const, executable: true, sha256: hash(contents) }
  ] };
  const bytes = encodeSnapshotManifest(manifest), digest = hash(bytes);
  const root = `${HOME}\\skill-snapshots\\sha256\\${digest}`;
  ensureWindowsPrivateDirectoryPath(f.backend, `${root}\\artifact\\child`);
  f.file(`${root}\\manifest.json`, bytes.toString()); f.file(`${root}\\artifact\\.env`, excluded.toString());
  f.file(`${root}\\artifact\\child\\SKILL.md`, contents.toString());
  const external = 'C:\\boundary\\ordinary-lib'; f.directory(external);
  ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\libraries`);
  f.file(`${HOME}\\libraries\\ordinary-lib.json`, encodeLibrary({ schemaVersion: 1, library: 'ordinary-lib', root: external, digest }));
  return { ...f, root, digest, manifestBytes: bytes.length };
}

describe('actual Windows shared resource data path (virtual native receipts, not native qualification)', () => {
  it('captures nested local/imported resources, creates deterministic canonical ZIP bytes, rematerializes closure and views, then activates', async () => {
    const f = await liveFixture();
    const local = `${HOME}\\profiles\\work\\skills\\local`;
    f.file(`${local}\\.env`, 'secret\n'); f.file(`${local}\\deep\\guide.md`, 'edited content keeps its logical mode\n');
    const external = 'C:\\boundary\\ordinary';
    vi.mocked(fs.readlink).mockImplementation(async () => external);
    f.directory(external); f.directory(`${external}\\nested`); f.file(`${external}\\SKILL.md`, definition('ordinary')); f.file(`${external}\\nested\\data.bin`, 'ordinary bytes\n'); f.file(`${external}\\.env`, 'external secret\n');
    f.junction(`${HOME}\\skills\\ordinary`, external); f.junction(`${HOME}\\profiles\\work\\skills\\ordinary`, external);
    const captured = await captureProfile({ bazframeHome: HOME, profileId: 'work' }, f.data.captureDependencies);
    expect(captured.profile.resources).toHaveLength(5);
    expect(captured.profile.profile.instructions.executable).toBe(true);
    expect(captured.profile.resources.find((r) => r.key.name === 'local')?.payload).toMatchObject({ sourceForm: 'profile-local', files: [expect.anything(), expect.objectContaining({ path: 'deep/guide.md', executable: true })] });
    expect(captured.preview.some((entry) => entry.path.includes('.env') || entry.path.includes(WINDOWS_EXECUTABLE_METADATA))).toBe(false);
    expect(captured.manifestBytes.toString()).not.toContain(HOME);
    expect(captured.manifestBytes.toString()).not.toContain(f.result.state.profileInstanceId);
    const zip = await createCanonicalProfileZip(captured.profile, captured.blobs);
    const repeatedCapture = await captureProfile({ bazframeHome: HOME, profileId: 'work' }, f.data.captureDependencies);
    expect(await createCanonicalProfileZip(repeatedCapture.profile, repeatedCapture.blobs)).toEqual(zip);
    const path = f.candidate(TX2);
    const materialized = await f.locked(TX2, (authority) => materializeCandidate(f, { home: HOME, candidateDirectory: path, authority, captured: captured.profile, blobs: captured.blobs, allowIncomplete: false,
      effects: f.storage.materializationEffects(HOME, authority, (home) => readProfileSystemView(home, f.data.viewReads)),
      materializeRemote: async () => { throw new Error('no build'); }
    }));
    expect(materialized.state.profileInstanceId).not.toBe(f.result.state.profileInstanceId);
    expect(materialized.treeIds).toHaveLength(4);
    const closure = await f.reads.captureSibling(HOME, 'copy', win32.basename(path));
    expect(closure?.closure.entries).toContainEqual(expect.objectContaining({ path: 'skills/local/deep/guide.md', executable: true }));
    expect(closure?.closure.entries).toContainEqual(expect.objectContaining({ path: WINDOWS_EXECUTABLE_METADATA }));
    expect(closure?.sidecarSha256).toMatch(/^[a-f0-9]{64}$/u);
    await f.backend.renameDirectoryNoReplace(`${HOME}\\profiles`, win32.basename(path), 'copy');
    const view = await readProfileSystemView(HOME, f.data.viewReads);
    expect(view.skills.map((entry) => entry.name)).toEqual(expect.arrayContaining(['direct', 'local', 'library-child', 'package-child', 'ordinary']));
    expect(view.skills.find((entry) => entry.name === 'library-child')?.directory).toContain('\\root\\nested\\library-child');
    expect(view.resources.some((entry) => entry.stableIdentity === 'catalog:skill:ordinary')).toBe(true);
    const services = createWindowsProfileActivationServicesForInternalTesting(f.backend, { lockIo: f.io, selectionIo: f.io });
    expect((await useManagedProfile(HOME, 'copy', services)).active).toBe(true);
    expect(f.nodes.get(`${HOME}\\active-profile`)?.bytes?.toString()).toBe('copy\n');
  });

  it('uses ordinary collection descriptors and their separate verified ready snapshot store, preserving logical modes', async () => {
    const f = fixture();
    f.directory(`${HOME}\\profiles\\work`); f.file(`${HOME}\\profiles\\work\\AGENTS.md`, 'ordinary\n');
    for (const kind of ['library', 'package'] as const) {
      const name = kind === 'library' ? 'ordinary-lib' : 'ordinary-pkg';
      const childName = `${name}-child`;
      const contents = Buffer.from(definition(childName));
      const manifest = { schemaVersion: 1 as const, entries: [{ path: '.', type: 'directory' as const }, { path: childName, type: 'directory' as const }, { path: `${childName}/SKILL.md`, type: 'file' as const, executable: true, sha256: hash(contents) }] };
      const bytes = encodeSnapshotManifest(manifest), digest = hash(bytes);
      const root = `${HOME}\\skill-snapshots\\sha256\\${digest}`;
      ensureWindowsPrivateDirectoryPath(f.backend, `${root}\\artifact\\${childName}`); f.file(`${root}\\manifest.json`, bytes.toString()); f.file(`${root}\\artifact\\${childName}\\SKILL.md`, contents.toString());
      const external = `C:\\boundary\\${name}`; f.directory(external);
      const namespace = kind === 'library' ? 'libraries' : 'packages';
      ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\${namespace}`); ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\work\\${namespace}`);
      f.file(`${HOME}\\${namespace}\\${name}.json`, kind === 'library' ? encodeLibrary({ schemaVersion: 1, library: name, root: external, digest }) : encodePackage({ schemaVersion: 1, package: name, root: external, digest, artifactRoot: 'out', skillsRoot: '.' }));
      f.file(`${HOME}\\profiles\\work\\${namespace}\\${name}.json`, JSON.stringify({ schemaVersion: 1, [kind]: name }));
    }
    const captured = await captureProfile({ bazframeHome: HOME, profileId: 'work' }, f.data.captureDependencies);
    expect(captured.profile.resources).toHaveLength(2);
    for (const resource of captured.profile.resources) expect(resource.payload).toMatchObject({ kind: 'bundled', files: [expect.objectContaining({ executable: true })] });
    const bindings = captured.profile.resources.map((resource) => ({ resourceIdentityDigest: resourceIdentityDigest(ordinaryResourceIdentity(resource.key.kind, resource.key.name)), capturedResourceId: resource.id, identityKind: 'catalog' as const, instanceId: null })).sort((a, b) => a.resourceIdentityDigest.localeCompare(b.resourceIdentityDigest));
    const path = f.candidate();
    const result = await f.locked(TX, (authority) => materializeCandidate(f, { home: HOME, candidateDirectory: path, authority, captured: captured.profile, blobs: captured.blobs, allowIncomplete: false,
      previousState: { schemaVersion: 1, profileInstanceId: captured.profileInstanceId, publication: null, importedResources: [], capturedResourceIds: bindings },
      effects: f.storage.materializationEffects(HOME, authority, (home) => readProfileSystemView(home, f.data.viewReads)),
      captureOrdinary: (resource) => captureCatalogResource({ bazframeHome: HOME, kind: resource.key.kind, name: resource.key.name, capturedResourceId: resource.id }, f.data.captureDependencies),
      materializeRemote: async () => { throw new Error('no acquisition'); }
    }));
    await result.revalidateOrdinary();
    expect(result.treeIds).toEqual([]);
    expect((await f.reads.captureSibling(HOME, 'work', win32.basename(path)))?.closure.entries.filter((entry) => entry.kind === 'membership-link')).toHaveLength(2);
    const snapshotFile = [...f.nodes.keys()].find((path) => path.includes('skill-snapshots') && path.endsWith('SKILL.md'))!;
    f.nodes.get(snapshotFile)!.bytes = Buffer.from('corrupted');
    await expect(captureProfile({ bazframeHome: HOME, profileId: 'work' }, f.data.captureDependencies)).rejects.toThrow();
  });

  it.each(['file', 'aggregate', 'manifest', 'entries', 'depth', 'path'] as const)('bounds ordinary snapshot %s verification before transport exclusions', async (limit) => {
    const f = ordinarySnapshotFixture();
    const options = { bazframeHome: HOME, kind: 'library' as const, name: 'ordinary-lib', capturedResourceId: '8'.repeat(64) };
    const healthy = await captureCatalogResource(options, f.data.captureDependencies);
    expect(healthy.resource.payload).toMatchObject({ kind: 'bundled', files: [expect.objectContaining({ path: 'child/SKILL.md', executable: true })] });
    expect(healthy.blobs).toHaveLength(1);
    const limits = {
      file: { maxBlobBytes: 100, maxAggregateBytes: 100 }, aggregate: { maxAggregateBytes: 100 },
      manifest: { maxManifestBytes: f.manifestBytes - 1 }, entries: { maxEntries: 3 },
      depth: { maxDepth: 0 }, path: { maxPathBytes: 8 }
    };
    const read = vi.spyOn(f.backend, 'readStableFile'); const before = f.snapshot();
    await expect(captureCatalogResource(options, { ...f.data.captureDependencies, limitPolicy: limits[limit] })).rejects.toThrow();
    if (limit === 'file') {
      const excludedReads = read.mock.calls.filter(([path]) => path.endsWith('\\.env'));
      expect(excludedReads.length).toBeGreaterThan(0);
      expect(excludedReads.every(([, max]) => max === 100)).toBe(true);
      await expect(read.mock.results[read.mock.calls.findIndex(([path]) => path.endsWith('\\.env'))]?.value).rejects.toMatchObject({ code: 'WINDOWS_NATIVE_READ_LIMIT_EXCEEDED' });
    }
    expect(f.snapshot()).toBe(before);
  });

  it.each(['maxManifestBytes', 'maxEntries', 'maxDepth', 'maxPathBytes', 'maxFileBytes', 'maxAggregateFileBytes'] as const)('also preserves the ordinary snapshot dependency %s ceiling', async (key) => {
    const f = ordinarySnapshotFixture();
    const lowered: SkillSnapshotLimitPolicy = { ...SKILL_SNAPSHOT_LIMITS, [key]: key === 'maxManifestBytes' ? f.manifestBytes - 1 : key === 'maxEntries' ? 3 : key === 'maxDepth' ? 0 : key === 'maxPathBytes' ? 8 : 100 };
    const reads = f.data.captureDependencies.createReads!(HOME, 'work', capturedProfileLimitPolicy());
    await expect(reads.verifySnapshot(HOME, f.digest, { limitPolicy: lowered })).rejects.toThrow();
  });

  it('reuses exact committed bundled trees and refuses expired authority or invalid occupied digest files', async () => {
    const f = await liveFixture(), source = f.source;
    const next = f.candidate(TX2); let expired!: OperationMutationAuthority;
    const result = await f.locked(TX2, async (authority) => {
      expired = authority;
      return materializeCandidate(f, { home: HOME, candidateDirectory: next, authority, captured: source.profile, blobs: source.blobs, allowIncomplete: false,
        effects: f.storage.materializationEffects(HOME, authority, (home) => readProfileSystemView(home, f.data.viewReads)), materializeRemote: async () => { throw new Error('no build'); } });
    });
    expect(result.effects).toEqual({ cacheWritten: false, buildExecuted: false });
    const blob = source.blobs[0]!;
    const before = f.snapshot();
    await expect(f.storage.publishBlob(HOME, expired, blob.bytesValue, blob.sha256)).rejects.toMatchObject({ code: 'PROFILE_OPERATION_AUTHORITY_INVALID' });
    expect(f.snapshot()).toBe(before);
    f.nodes.get(`${HOME}\\profile-publishing\\blobs\\${blob.sha256}`)!.bytes = Buffer.from('invalid');
    await f.locked(TX, async (authority) => { await expect(f.storage.publishBlob(HOME, authority, blob.bytesValue, blob.sha256)).rejects.toMatchObject({ code: 'PROFILE_BLOB_INVALID' }); });
    expect(f.nodes.get(`${HOME}\\profile-publishing\\blobs\\${blob.sha256}`)?.bytes?.toString()).toBe('invalid');
  });

  it('uses the actual rich system view for exact offline remote cache reuse, without acquisition or builds', async () => {
    const f = await liveFixture();
    const identity = { remote: 'github.com/owner/direct', fetchUrl: 'https://github.com/owner/direct.git', branch: 'main', revision: 'a'.repeat(40) };
    const imported = f.result.state.importedResources.find((resource) => resource.key.name === 'direct')!;
    if (imported.source.kind !== 'artifact') throw new Error('fixture');
    imported.source.origin = identity;
    f.nodes.get(`${HOME}\\profiles\\work\\${publicationSidecarName()}`)!.bytes = Buffer.from(encodeManagedProfileState(f.result.state, capturedProfileLimitPolicy()));
    const instructions = f.source.profile.profile.instructions;
    const blob = f.source.blobs.find((value) => value.sha256 === instructions.sha256)!;
    const captured: CapturedProfileV1 = { ...f.source.profile, resources: [{ id: '9'.repeat(64), key: { kind: 'skill', name: 'direct' }, payload: { kind: 'remoteGit', identity } }], blobs: [{ sha256: blob.sha256, bytes: blob.bytes }] };
    const path = f.candidate(TX2);
    const result = await f.locked(TX2, (authority) => materializeCandidate(f, { home: HOME, candidateDirectory: path, authority, captured, blobs: [blob], allowIncomplete: false,
      effects: f.storage.materializationEffects(HOME, authority, (home) => readProfileSystemView(home, f.data.viewReads)),
      materializeRemote: async () => { throw new Error('exact offline cache must be used'); }
    }));
    expect(result.effects).toEqual({ cacheWritten: false, buildExecuted: false });
    expect(result.state.importedResources[0]?.source).toEqual({ kind: 'remoteGit', identity, treeId: imported.source.treeId });
  });

  it('rematerializes an exactly captured ordinary direct Skill through the real membership effects', async () => {
    const f = fixture(); const external = 'C:\\boundary\\ordinary';
    vi.mocked(fs.readlink).mockImplementation(async () => external);
    f.directory(external); f.directory(`${external}\\nested`); f.file(`${external}\\SKILL.md`, definition('ordinary')); f.file(`${external}\\nested\\guide.md`, 'ordinary guide');
    f.junction(`${HOME}\\skills\\ordinary`, external);
    const catalog = await captureCatalogResource({ bazframeHome: HOME, kind: 'skill', name: 'ordinary', capturedResourceId: '8'.repeat(64) }, f.data.captureDependencies);
    const instructionsBytes = Buffer.from('ordinary instructions'); const instructions = { path: 'AGENTS.md', sha256: hash(instructionsBytes), bytes: instructionsBytes.length, executable: false };
    const blobs = [...catalog.blobs, { sha256: instructions.sha256, bytes: instructions.bytes, bytesValue: instructionsBytes }].sort((a, b) => a.sha256.localeCompare(b.sha256));
    const captured: CapturedProfileV1 = { schemaVersion: 1, kind: 'bazframe-captured-profile', profile: { name: 'work', instructions }, resources: [catalog.resource], blobs: blobs.map(({ sha256, bytes }) => ({ sha256, bytes })) };
    const path = f.candidate();
    const result = await f.locked(TX, (authority) => materializeCandidate(f, { home: HOME, candidateDirectory: path, authority, captured, blobs, allowIncomplete: false,
      previousState: { schemaVersion: 1, profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publication: null, importedResources: [], capturedResourceIds: [{ capturedResourceId: catalog.resource.id, resourceIdentityDigest: resourceIdentityDigest(ordinaryResourceIdentity('skill', 'ordinary')), identityKind: 'catalog', instanceId: null }] },
      captureOrdinary: (resource) => captureCatalogResource({ bazframeHome: HOME, kind: 'skill', name: resource.key.name, capturedResourceId: resource.id }, f.data.captureDependencies),
      effects: f.storage.materializationEffects(HOME, authority, (home) => readProfileSystemView(home, f.data.viewReads)), materializeRemote: async () => { throw new Error('no acquisition'); }
    }));
    await result.revalidateOrdinary(); expect(result.treeIds).toEqual([]);
    expect((await f.reads.captureSibling(HOME, 'work', win32.basename(path)))?.closure.entries).toContainEqual({ path: 'skills/ordinary', kind: 'membership-link', targetIdentity: 'catalog:skill:ordinary' });
    f.nodes.get(`${external}\\nested\\guide.md`)!.bytes = Buffer.from('changed after capture');
    await expect(result.revalidateOrdinary()).rejects.toThrow();
  });

  it('retains a real failed publication without disabling healthy view/use, but refuses a reference to it', async () => {
    const f = await liveFixture(), source = bundle();
    const resource = source.profile.resources[0]!;
    if (resource.payload.kind !== 'bundled') throw new Error('fixture');
    const manifest = { schemaVersion: 1 as const, kind: 'bazframe-artifact-tree' as const, role: resource.payload.role, files: resource.payload.files.map((file) => ({ ...file, executable: !file.executable })) };
    const id = artifactTreeId(manifest);
    const storage = createWindowsProfileStorage(f.backend, { async writeExistingFile(path, bytes) {
      await f.io.writeExistingFile(path, bytes);
      if (path.endsWith('data.bin')) throw new Error('flush/close failed after drain');
    } });
    await f.locked(TX, async (authority) => {
      for (const blob of source.blobs) await f.storage.publishBlob(HOME, authority, blob.bytesValue, blob.sha256);
      await expect(storage.publishTree(HOME, authority, manifest)).rejects.toThrow('flush/close failed after drain');
    });
    const tree = `${HOME}\\profile-publishing\\trees\\${id}`;
    expect(f.nodes.has(`${tree}\\root\\nested\\data.bin`)).toBe(true);
    expect(f.nodes.has(`${tree}\\COMMITTED`)).toBe(false);
    await expect(f.storage.readTree(HOME, id)).rejects.toMatchObject({ code: 'PROFILE_ARTIFACT_TREE_INVALID' });
    const malformedBlob = `${HOME}\\profile-publishing\\blobs\\${'f'.repeat(64)}`;
    const temporaryBlob = `${HOME}\\profile-publishing\\blobs\\.blob-${'f'.repeat(32)}`;
    f.file(malformedBlob, 'not its digest'); f.file(temporaryBlob, 'unfinished private write');
    const retained = () => JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(tree) || path === malformedBlob || path === temporaryBlob));
    const before = retained();
    const reads = vi.spyOn(f.backend, 'readStableFile');
    expect((await readProfileSystemView(HOME, f.data.viewReads)).profiles.map((profile) => profile.name)).toEqual(['work']);
    const services = createWindowsProfileActivationServicesForInternalTesting(f.backend, { lockIo: f.io, selectionIo: f.io });
    expect((await useManagedProfile(HOME, 'work', services)).active).toBe(true);
    expect(f.nodes.get(`${HOME}\\active-profile`)?.bytes?.toString()).toBe('work\n');
    expect(reads.mock.calls.some(([path]) => path.startsWith(tree) || path === malformedBlob || path === temporaryBlob)).toBe(false);
    expect(retained()).toBe(before);
    const imported = f.result.state.importedResources.find((entry) => entry.key.name === 'direct')!;
    if (imported.source.kind !== 'artifact') throw new Error('fixture');
    imported.source.treeId = id;
    f.nodes.get(`${HOME}\\profiles\\work\\${publicationSidecarName()}`)!.bytes = Buffer.from(encodeManagedProfileState(f.result.state, capturedProfileLimitPolicy()));
    await expect(readProfileSystemView(HOME, f.data.viewReads)).rejects.toMatchObject({ code: 'PROFILE_ARTIFACT_TREE_INVALID' });
    await expect(useManagedProfile(HOME, 'work', services)).rejects.toThrow();
    expect(retained()).toBe(before);
  });

  it.each(['destination', 'content-directory', 'parent', 'dependency', 'file', 'manifest', 'marker', 'fresh-validation', 'reused-validation'] as const)('refuses authority expiry during %s, drains started writes and retains private state', async (window) => {
    const f = fixture(); const bytes = Buffer.from(definition('skill')), sha = hash(bytes);
    const manifest = { schemaVersion: 1 as const, kind: 'bazframe-artifact-tree' as const, role: 'skill' as const, files: [{ path: 'nested/SKILL.md', sha256: sha, bytes: bytes.length, executable: false }] };
    const id = artifactTreeId(manifest), tree = `${HOME}\\profile-publishing\\trees\\${id}`;
    await f.locked(TX, async (authority) => {
      await f.storage.publishBlob(HOME, authority, bytes, sha);
      if (window === 'reused-validation') await f.storage.publishTree(HOME, authority, manifest);
    });
    let expired = false; let retainedKeys: string[] = []; let expiredSnapshot = '';
    const expire = () => { expired = true; retainedKeys = [...f.nodes.keys()]; expiredSnapshot = f.snapshot(); };
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (path) => {
      const result = acquire(path);
      if (result.state !== 'acquired') return result;
      return { ...result, capability: { ...result.capability, assertHeld() {
        result.capability.assertHeld(); if (expired) throw new Error('TEST_AUTHORITY_EXPIRED');
      } } };
    };
    const newEffects: string[] = [];
    const createDirectory = f.backend.createPrivateDirectory, createFile = f.backend.createPrivateFile;
    f.backend.createPrivateDirectory = (parent, name) => {
      const path = win32.join(parent, name); if (expired) newEffects.push(path);
      const result = createDirectory(parent, name);
      if (window === 'destination' && path === tree || window === 'content-directory' && path === `${tree}\\root` || window === 'parent' && path === `${tree}\\root\\nested`) expire();
      return result;
    };
    f.backend.createPrivateFile = (parent, name) => {
      if (expired) newEffects.push(win32.join(parent, name)); return createFile(parent, name);
    };
    const read = f.backend.readStableFile; let markerReads = 0;
    f.backend.readStableFile = async (path, max) => {
      const result = await read(path, max);
      if (window === 'dependency' && path === `${HOME}\\profile-publishing\\blobs\\${sha}` && !expired) expire();
      if (path === `${tree}\\COMMITTED`) {
        markerReads++;
        // Fresh marker readback is the first read; subsequent reads validate the tree.
        if (window === 'fresh-validation' && markerReads === 2 || window === 'reused-validation' && markerReads === 1) expire();
      }
      return result;
    };
    const writeTarget = window === 'file' ? `${tree}\\root\\nested\\SKILL.md` : window === 'manifest' ? `${tree}\\manifest.json` : window === 'marker' ? `${tree}\\COMMITTED` : undefined;
    let signalStarted!: () => void, resume!: () => void; let drained = false;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const storage = createWindowsProfileStorage(f.backend, { async writeExistingFile(path, value) {
      if (expired) newEffects.push(path);
      if (path === writeTarget) { expire(); signalStarted(); await resumed; }
      await f.io.writeExistingFile(path, value);
      if (path === writeTarget) drained = true;
    } });
    let outcome: unknown; let pendingBeforeDrain = false; let emptyBeforeDrain: Buffer | undefined;
    await expect(f.locked(TX2, async (authority) => {
      let settled = false;
      const publication = storage.publishTree(HOME, authority, manifest);
      void publication.then(() => { settled = true; }, () => { settled = true; });
      if (writeTarget !== undefined) {
        await started;
        pendingBeforeDrain = !settled && !drained;
        emptyBeforeDrain = Buffer.from(f.nodes.get(writeTarget)!.bytes!);
        resume();
      }
      try { outcome = await publication; } catch (error) { outcome = error; }
    })).rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_RELEASE_AMBIGUOUS' });
    // Check the inner store result separately: outer release ambiguity must not mask success/assertion failures.
    expect(outcome).toEqual(new Error('TEST_AUTHORITY_EXPIRED'));
    expect(expired).toBe(true); expect(newEffects).toEqual([]);
    if (writeTarget !== undefined) {
      expect(pendingBeforeDrain).toBe(true); expect(emptyBeforeDrain).toEqual(Buffer.alloc(0));
      expect(drained).toBe(true); expect(f.nodes.get(writeTarget)?.bytes?.length).toBeGreaterThan(0);
    } else expect(f.snapshot()).toBe(expiredSnapshot);
    expect([...f.nodes.keys()]).toEqual(retainedKeys);
    expect(f.nodes.has(`${tree}\\COMMITTED`)).toBe(['marker', 'fresh-validation', 'reused-validation'].includes(window));
  });

  it('keeps inactive mode mappings valid across deletion and detects metadata-only drift between full capture passes', async () => {
    const f = await liveFixture();
    const metadataPath = `${HOME}\\profiles\\work\\${WINDOWS_EXECUTABLE_METADATA}`;
    const metadata = decodeWindowsExecutableMetadata(f.nodes.get(metadataPath)!.bytes!);
    metadata.files.push({ path: 'skills/local/missing.txt', executable: true });
    f.nodes.get(metadataPath)!.bytes = encodeWindowsExecutableMetadata(metadata);
    await expect(captureProfile({ bazframeHome: HOME, profileId: 'work' }, f.data.captureDependencies)).resolves.toBeDefined();
    f.nodes.delete(`${HOME}\\profiles\\work\\skills\\local\\deep\\guide.md`);
    await expect(f.reads.captureExpectation(HOME, 'work')).resolves.toBeDefined();
    await expect(captureProfile({ bazframeHome: HOME, profileId: 'work' }, { ...f.data.captureDependencies, testHooks: { afterPass(pass) {
      if (pass === 1) { metadata.files.at(-1)!.executable = false; f.nodes.get(metadataPath)!.bytes = encodeWindowsExecutableMetadata(metadata); }
    } } })).rejects.toMatchObject({ code: 'PROFILE_CAPTURE_CHANGED' });
  });

  it('retains link-count isolation on a newly created owned file during writing', async () => {
    const f = fixture();
    const path = `${HOME}\\fresh-owned`;
    await expect(writeWindowsProfileFile(f.backend, path, Buffer.from('new bytes'), { async writeExistingFile(name, bytes) {
      await f.io.writeExistingFile(name, bytes);
      f.nodes.get(name)!.numberOfLinks = 2;
    } })).rejects.toThrow('fresh file changed during writing');
    expect(f.nodes.get(path)!.bytes).toEqual(Buffer.from('new bytes'));
  });

  it.each(['hard-link', 'reparse', 'alias', 'metadata', 'metadata-directory', 'metadata-alias', 'sidecar', 'tree', 'observation', 'provider', 'limit', 'bytes', 'path', 'depth'] as const)('applies bounded physical capture policy to %s with no mutation', async (kind) => {
    const f = await liveFixture(); const root = `${HOME}\\profiles\\work`;
    if (kind === 'hard-link') f.nodes.get(`${root}\\skills\\local\\deep\\guide.md`)!.numberOfLinks = 2;
    if (kind === 'reparse') f.reparse(`${root}\\skills\\local\\deep\\link`);
    if (kind === 'alias') f.file(`${root}\\skills\\local\\deep\\GUIDE.md`, 'alias');
    if (kind === 'metadata') f.nodes.get(`${root}\\${WINDOWS_EXECUTABLE_METADATA}`)!.bytes = Buffer.from('{"schemaVersion":1,"files":[]}');
    if (kind === 'metadata-directory' || kind === 'metadata-alias') { const metadata = decodeWindowsExecutableMetadata(f.nodes.get(`${root}\\${WINDOWS_EXECUTABLE_METADATA}`)!.bytes!); metadata.files = metadata.files.filter((file) => !file.path.startsWith('skills/local/deep/')); metadata.files.push({ path: kind === 'metadata-directory' ? 'skills/local/deep' : 'skills/local/DEEP/missing.txt', executable: true }); metadata.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); f.nodes.get(`${root}\\${WINDOWS_EXECUTABLE_METADATA}`)!.bytes = encodeWindowsExecutableMetadata(metadata); }
    if (kind === 'sidecar') f.nodes.get(`${root}\\${publicationSidecarName()}`)!.bytes = Buffer.from('{}');
    if (kind === 'tree') { const path = [...f.nodes.keys()].find((name) => name.includes('\\trees\\') && name.endsWith('data.bin'))!; f.nodes.get(path)!.bytes = Buffer.from('corrupt immutable bytes'); }
    if (kind === 'observation') { const read = f.backend.readStableFile; f.backend.readStableFile = async (path, max) => { const receipt = await read(path, max); return path.endsWith('guide.md') ? { ...receipt, after: { ...receipt.after, fileId: 'f'.repeat(32) } } : receipt; }; }
    if (kind === 'provider') { ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\providers`); f.file(`${HOME}\\providers\\unknown`, 'occupied'); }
    const before = f.snapshot();
    const dependencies = { ...f.data.captureDependencies, ...(['limit', 'bytes', 'path', 'depth'].includes(kind) ? { limitPolicy: kind === 'limit' ? { maxEntries: 3 } : kind === 'bytes' ? { maxAggregateBytes: 1 } : kind === 'path' ? { maxPathBytes: 8 } : { maxDepth: 0 } } : {}) };
    if (kind === 'hard-link') await expect(captureProfile({ bazframeHome: HOME, profileId: 'work' }, dependencies)).resolves.toHaveProperty('profile');
    else await expect(captureProfile({ bazframeHome: HOME, profileId: 'work' }, dependencies)).rejects.toThrow();
    expect(f.snapshot()).toBe(before);
  });

  it('does not weaken the unchanged managed-state V1 codec or logical metadata path admission', () => {
    const state = { schemaVersion: 1 as const, profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publication: null, capturedResourceIds: [], importedResources: [] };
    expect(encodeManagedProfileState(state, capturedProfileLimitPolicy())).not.toContain('executable');
    expect(publicationSidecarName()).not.toBe(WINDOWS_EXECUTABLE_METADATA);
    for (const path of ['../AGENTS.md', 'skills/local/CON', 'skills/local/file:ads', 'libraries/x', 'skills/unsafe_name/a']) {
      expect(() => encodeWindowsExecutableMetadata({ schemaVersion: 1, files: [{ path, executable: false }] })).toThrow();
    }
    expect(() => encodeWindowsExecutableMetadata({ schemaVersion: 1, files: [{ path: 'skills/local/Foo/a', executable: false }, { path: 'skills/local/foo/b', executable: false }] })).toThrow();
  });
});
