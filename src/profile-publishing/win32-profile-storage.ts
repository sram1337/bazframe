import { isExcludedCapturedResourcePath } from './profile-capture.js';
import { createHash } from 'node:crypto';
import type { ProfileClosureCopyEffects } from './profile-publication.js';
import { createWindowsOrdinaryProfileReads } from './win32-physical-profile-reads.js';
import { open } from 'node:fs/promises';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend } from '../core/win32-native.js';
import { readWindowsPhysicalFileSnapshot } from '../profiles/win32-profile-selection.js';
import { encodeProfileCollectionReference } from '../profiles/profile-skill-collection-reference.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../skills/added-skill-platform-services.js';
import { readDefaultSkillRegistration } from '../skills/default-skill-catalog.js';
import { createWindowsPrivateDirectory, createWindowsPrivateFile, ensureWindowsPrivateDirectoryPath } from '../state/win32-private-directory.js';
import { publishArtifactTree, readArtifactTree, type ArtifactTreeEffects } from './artifact-tree.js';
import { publishStoredBlob, readStoredBlob, type BlobStoreEffects } from './blob-store.js';
import { assertOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from './profile-operation-lock.js';
import type { ProfileMaterializationEffects } from './profile-materialization.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { encodeManagedProfileState, publicationSidecarName, type ManagedProfileStateV1 } from './publication-state.js';
import type { readProfileSystemView } from './profile-view.js';
import { createWindowsPhysicalReads } from './win32-physical-profile-reads.js';
import { encodeWindowsExecutableMetadata, WINDOWS_EXECUTABLE_METADATA } from './win32-profile-executable.js';

export interface WindowsProfileStorageIo { writeExistingFile(path: string, bytes: Uint8Array): Promise<void> }
const defaultIo: WindowsProfileStorageIo = {
  async writeExistingFile(path, bytes) {
    const handle = await open(path, 'r+');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
};
/** Protected fresh files only. Failed writes are drained by the I/O contract and retained, never repaired. */
export async function writeWindowsProfileFile(backend: BazframeWin32NativeBackend, path: string, bytes: Uint8Array, io: WindowsProfileStorageIo = defaultIo): Promise<void> {
  if (bytes.byteLength > capturedProfileLimitPolicy().maxBlobBytes) throw invalid('file exceeds the supplied product file ceiling');
  const value = Buffer.from(bytes);
  const created = createWindowsPrivateFile(backend, win32.dirname(path), win32.basename(path));
  await io.writeExistingFile(path, value);
  const readback = await readWindowsPhysicalFileSnapshot(backend, path, value.length);
  if (created.object.fileId !== readback.inspection.object.fileId || created.object.volumeIdentity !== readback.inspection.object.volumeIdentity || created.object.numberOfLinks !== readback.inspection.object.numberOfLinks || !readback.bytes.equals(value)) throw invalid('fresh file changed during writing');
}
export function createWindowsProfileStorage(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, io: WindowsProfileStorageIo = defaultIo) {
  const excludedModes = new WeakMap<OperationMutationAuthority, Map<string, Array<{ path: string; executable: boolean }>>>();
  const ensure = async (_home: string, path: string) => { ensureWindowsPrivateDirectoryPath(backend, path); };
  const write = (path: string, bytes: Uint8Array) => writeWindowsProfileFile(backend, path, bytes, io);
  const occupied = (error: unknown) => ['EEXIST', 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED', 'WINDOWS_PRIVATE_DIRECTORY_OCCUPIED', 'WINDOWS_NATIVE_DESTINATION_OCCUPIED'].includes(errorCode(error) ?? '');
  const blobEffects: BlobStoreEffects = {
    join: win32.join, ensureDirectory: ensure, writeTemporary: write, siblingTemporary: true, occupied,
    async read(path, max) { const reads = createWindowsPhysicalReads(backend); return (await reads.readFile(path, max)).bytes; },
    async publish(source, destination) {
      if (win32.dirname(source) !== win32.dirname(destination)) throw invalid('blob publication must be sibling-relative');
      await backend.renameFileNoReplace(win32.dirname(source), win32.basename(source), win32.basename(destination));
    }
  };
  const readBlob: typeof readStoredBlob = (home, sha, limits) => readStoredBlob(home, sha, limits, blobEffects);
  const publishBlob: typeof publishStoredBlob = (home, authority, bytes, sha, limits) => publishStoredBlob(home, authority, bytes, sha, limits, blobEffects);
  const treeEffects: ArtifactTreeEffects = {
    join: win32.join, ensureDirectory: ensure, occupied, logicalExecutable: true,
    async createDirectory(path) { createWindowsPrivateDirectory(backend, win32.dirname(path), win32.basename(path)); },
    // Each dependent file is fully flushed and closed before the commit marker is created.
    writeFile: write, readBlob, reads: () => createWindowsPhysicalReads(backend)
  };
  const readTree: typeof readArtifactTree = (home, id, limits) => readArtifactTree(home, id, limits, treeEffects);
  const publishTree: typeof publishArtifactTree = (home, authority, manifest, limits) => publishArtifactTree(home, authority, manifest, limits, treeEffects);
  function assertCandidate(home: string, path: string, authority: OperationMutationAuthority) {
    const transaction = operationAuthorityTransactionId(authority);
    assertOperationMutationAuthority(authority, home, ['@store'], transaction);
    if (win32.dirname(path) !== win32.join(home, 'profiles') || win32.basename(path) !== `.bazframe-candidate-${transaction}`) throw invalid('candidate authority mismatch');
  }
  async function writeCandidateState(home: string, path: string, authority: OperationMutationAuthority, state: ManagedProfileStateV1) {
    assertCandidate(home, path, authority);
    await write(win32.join(path, publicationSidecarName()), Buffer.from(encodeManagedProfileState(state, capturedProfileLimitPolicy())));
    assertCandidate(home, path, authority);
  }
  function materializationEffects(home: string, authority: OperationMutationAuthority, readSystemView: typeof readProfileSystemView): ProfileMaterializationEffects {
    const platform = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
    return { basename: win32.basename, publishBlob, publishTree, readTree, readSystemView,
      async writeInstructions(candidate, requestedHome, bytes) {
        if (requestedHome !== home) throw invalid('home authority mismatch');
        assertCandidate(home, candidate, authority); await write(win32.join(candidate, 'AGENTS.md'), bytes); assertCandidate(home, candidate, authority);
      },
      async writeProfileLocalSkill(candidate, resource, blobs) {
        assertCandidate(home, candidate, authority);
        if (resource.key.kind !== 'skill' || resource.payload.kind !== 'bundled') throw invalid('invalid local resource');
        for (const file of resource.payload.files) {
          assertCandidate(home, candidate, authority);
          const parts = file.path.split('/'); const name = parts.pop()!;
          const parent = win32.join(candidate, 'skills', resource.key.name, ...parts);
          await ensure(home, parent);
          const blob = blobs.get(file.sha256); if (blob === undefined) throw invalid('missing local blob');
          await write(win32.join(parent, name), blob.bytesValue);
        }
        assertCandidate(home, candidate, authority);
      },
      async writeOrdinaryMembership(requestedHome, candidate, resource) {
        if (requestedHome !== home) throw invalid('home authority mismatch');
        assertCandidate(home, candidate, authority);
        const namespace = resource.key.kind === 'skill' ? 'skills' : resource.key.kind === 'library' ? 'libraries' : 'packages';
        const parent = win32.join(candidate, namespace); await ensure(home, parent);
        if (resource.key.kind === 'skill') {
          const registration = await readDefaultSkillRegistration(home, resource.key.name, { platformServices: platform });
          assertCandidate(home, candidate, authority);
          await platform.createSkillLink({ assertHeld: () => assertCandidate(home, candidate, authority) }, parent, resource.key.name, registration.target);
        } else {
          const reference = resource.key.kind === 'library' ? { schemaVersion: 1 as const, library: resource.key.name } : { schemaVersion: 1 as const, package: resource.key.name };
          await write(win32.join(parent, `${resource.key.name}.json`), Buffer.from(encodeProfileCollectionReference(reference)));
        }
        assertCandidate(home, candidate, authority);
      },
      async finishCandidate(options, state) {
        assertCandidate(home, options.candidateDirectory, authority);
        const files = [...(excludedModes.get(authority)?.get(options.candidateDirectory) ?? []), { path: 'AGENTS.md', executable: options.captured.profile.instructions.executable }];
        for (const resource of options.captured.resources) {
          if (resource.payload.kind !== 'bundled' || resource.payload.sourceForm !== 'profile-local' || !state.capturedResourceIds.some((binding) => binding.capturedResourceId === resource.id && binding.identityKind === 'profileLocal')) continue;
          for (const file of resource.payload.files) files.push({ path: `skills/${resource.key.name}/${file.path}`, executable: file.executable });
        }
        files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        await write(win32.join(options.candidateDirectory, WINDOWS_EXECUTABLE_METADATA), encodeWindowsExecutableMetadata({ schemaVersion: 1, files }));
        assertCandidate(home, options.candidateDirectory, authority);
      }
    };
  }
  function copyEffects(home: string, authority: OperationMutationAuthority): ProfileClosureCopyEffects {
    const reads = createWindowsOrdinaryProfileReads(backend);
    const platform = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
    return {
      assertSource: reads.assertExpectation,
      async copyEntry(root, name, candidate, entry) {
        if (root !== home) throw invalid('copy home changed');
        if (entry.kind === 'direct-skill-reference' || entry.kind === 'inert-directory') throw invalid('read-only profile evidence cannot authorize copying');
        assertCandidate(home, candidate, authority);
        if (entry.kind === 'managed-sidecar' || entry.path === WINDOWS_EXECUTABLE_METADATA) return;
        const destination = win32.join(candidate, ...entry.path.split('/'));
        await ensure(home, win32.dirname(destination));
        assertCandidate(home, candidate, authority);
        if (entry.kind === 'file') {
          const source = await createWindowsPhysicalReads(backend, win32.join(home, 'profiles', name)).readFile(win32.join(home, 'profiles', name, ...entry.path.split('/')), entry.bytes);
          if (source.bytes.length !== entry.bytes || source.executable !== entry.executable || createHash('sha256').update(source.bytes).digest('hex') !== entry.sha256) throw invalid('copy source changed');
          assertCandidate(home, candidate, authority); await write(destination, source.bytes);
        } else {
          const [catalog, kind, id] = entry.targetIdentity.split(':');
          if (catalog !== 'catalog' || id === undefined) throw invalid('copy membership identity invalid');
          if (kind === 'skill') {
            const registration = await readDefaultSkillRegistration(home, id, { platformServices: platform });
            await platform.createSkillLink({ assertHeld: () => assertCandidate(home, candidate, authority) }, win32.dirname(destination), id, registration.target);
          } else if (kind === 'library' || kind === 'package') {
            await write(destination, Buffer.from(encodeProfileCollectionReference(kind === 'library' ? { schemaVersion: 1, library: id } : { schemaVersion: 1, package: id })));
          } else throw invalid('copy membership kind invalid');
        }
        assertCandidate(home, candidate, authority);
      },
      async finish(candidate, expected) {
        assertCandidate(home, candidate, authority);
        const files = expected.closure.entries.filter((entry) => entry.kind === 'file' && entry.path !== WINDOWS_EXECUTABLE_METADATA).map((entry) => ({ path: entry.path, executable: entry.kind === 'file' && entry.executable }));
        await write(win32.join(candidate, WINDOWS_EXECUTABLE_METADATA), encodeWindowsExecutableMetadata({ schemaVersion: 1, files }));
        assertCandidate(home, candidate, authority);
      }
    };
  }
  async function copyExcluded(home: string, name: string, expected: import('./physical-profile-closure.js').PhysicalProfileExpectation, candidate: string, retainedNames: ReadonlySet<string>, authority: OperationMutationAuthority): Promise<void> {
    const effects = copyEffects(home, authority);
    await effects.assertSource(home, name, expected);
    const files: Array<{ path: string; executable: boolean }> = [];
    for (const entry of expected.closure.entries) {
      if (entry.kind !== 'file') continue;
      const match = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/u.exec(entry.path);
      if (match === null || !retainedNames.has(match[1]!) || !isExcludedCapturedResourcePath(match[2]!)) continue;
      await effects.copyEntry(home, name, candidate, entry);
      files.push({ path: entry.path, executable: entry.executable });
    }
    await effects.assertSource(home, name, expected);
    assertCandidate(home, candidate, authority);
    let candidates = excludedModes.get(authority);
    if (candidates === undefined) { candidates = new Map(); excludedModes.set(authority, candidates); }
    candidates.set(candidate, files);
  }
  return { readBlob, publishBlob, readTree, publishTree, writeCandidateState, materializationEffects, copyEffects, copyExcluded };
}
function invalid(detail: string): BazframeError { return new BazframeError('WINDOWS_PROFILE_STORAGE_INVALID', `Invalid Windows profile storage: ${detail}.`); }
