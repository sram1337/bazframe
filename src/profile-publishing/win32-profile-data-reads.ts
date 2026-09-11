import { createWindowsManagedGitRecordEffects } from '../providers/managed-git-services.js';
import { createManagedGitProvider } from '../providers/managed-git.js';
import { createWindowsManagedGitServices, type WindowsManagedGitOptions } from '../providers/win32-managed-git-services.js';
import { isRetainedResourceFile } from '../skill-collections/resource-identity.js';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend } from '../core/win32-native.js';
import { stableWindowsMembershipLinkInspection } from '../core/win32-stable-observation.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { readWindowsPhysicalFileSnapshot } from '../profiles/win32-profile-selection.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { isValidWindowsPathComponent, admitWindowsPhysicalFile, admitWindowsPhysicalDirectory } from '../state/win32-private-directory.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting, enumerateWindowsPhysicalDirectory } from '../skills/added-skill-platform-services.js';
import { inspectDefaultSkillCatalog, readDefaultSkillRegistration } from '../skills/default-skill-catalog.js';
import { decodeLibrary, decodePackage, type SkillCollectionNamespace, type SkillCollectionKey, type CollectionRootPathPolicy } from '../skill-collections/skill-collection-store.js';
import { SKILL_SNAPSHOT_LIMITS, verifySkillSnapshot, type SkillSnapshotLimitPolicy } from '../skill-collections/skill-snapshot.js';
import { isReservedProfileSiblingName } from './publication-state.js';
import { createWindowsOrdinaryProfileReads, createWindowsProfileUseReads, createWindowsPhysicalReads } from './win32-physical-profile-reads.js';
import { createWindowsProfileStorage } from './win32-profile-storage.js';
import { assertWindowsOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from './profile-operation-lock.js';
import { assertWindowsLifecycleJournalsTerminal } from './win32-profile-lifecycle.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import type { ProfileSystemViewReadServices } from './profile-view.js';
import type { ProfileCaptureDependencies, ProfileCaptureReadServices } from './profile-capture.js';
import type { PhysicalProfileReadServices } from './physical-profile-closure.js';

const pathPolicy: CollectionRootPathPolicy = {
  isCanonicalAbsolute: (path) => /^[A-Za-z]:\\/u.test(path) && win32.normalize(path) === path && path.slice(3).split('\\').every(isValidWindowsPathComponent),
  basename: win32.basename
};
const portable = (value: string) => value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
const within = (parent: string, child: string) => { const relative = win32.relative(parent, child); return relative === '' || !relative.startsWith('..') && !win32.isAbsolute(relative); };

export function createWindowsProfileDataReads(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, operation?: { home: string; authority: OperationMutationAuthority }, providerOptions: WindowsManagedGitOptions = {}) {
  const providerRecords = createWindowsManagedGitRecordEffects(backend);
  const provider = (home: string) => createManagedGitProvider(createWindowsManagedGitServices(backend, home, providerOptions));
  const profiles = createWindowsOrdinaryProfileReads(backend);
  const storage = createWindowsProfileStorage(backend);
  const platform = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
  const enumerate = (path: string, max = PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) => enumerateWindowsPhysicalDirectory(backend, path, max);
  async function optionalChild(parent: string, name: string) {
    const names = (await enumerate(parent)).names; const matches = names.filter((entry) => portable(entry) === portable(name));
    if (matches.length === 0) return false;
    if (matches.length !== 1 || matches[0] !== name) throw unsupported();
    return true;
  }
  async function requireAbsentOrEmpty(home: string, component: string) {
    if (await optionalChild(home, component) && (await enumerate(win32.join(home, component))).names.length !== 0) throw unsupported();
  }
  async function readCollection(home: string, key: SkillCollectionKey, max: number) {
    if (!isSafeSkillId(key.id)) throw unsupported();
    const root = win32.join(home, key.kind === 'library' ? 'libraries' : 'packages');
    const reads = createWindowsPhysicalReads(backend); const path = win32.join(root, `${key.id}.json`);
    const bytes = (await reads.readFile(path, max)).bytes;
    let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw unsupported(); }
    const record = key.kind === 'library' ? decodeLibrary(value, key.id, pathPolicy) : decodePackage(value, key.id, pathPolicy);
    // Ready consumers use the immutable snapshot, not mutable preparation input.
    // Source NTFS/physical admission belongs to add/update/build, not offline use.
    const repeated = await readWindowsPhysicalFileSnapshot(backend, path, max);
    if (!repeated.bytes.equals(bytes)) throw unsupported();
    const object = repeated.inspection.object;
    return { record, identity: `${object.volumeIdentity}:${object.fileId}:${object.creationTime}:${createHash('sha256').update(bytes).digest('hex')}` };
  }
  async function scanCollections(home: string): Promise<SkillCollectionNamespace> {
    await providerRecords.assertReadyProviderState(home);
    const records: SkillCollectionNamespace['records'] = [];
    for (const kind of ['library', 'package'] as const) {
      const namespace = kind === 'library' ? 'libraries' : 'packages';
      if (!await optionalChild(home, namespace)) continue;
      const root = win32.join(home, namespace);
      for (const name of (await enumerate(root)).names) {
        if (isRetainedResourceFile(name)) { admitWindowsPhysicalFile(backend, win32.join(root, name)); continue; }
        const id = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (!isSafeSkillId(id)) throw unsupported();
        const descriptor = await readCollection(home, { kind, id }, capturedProfileLimitPolicy().maxManifestBytes);
        await verifySkillSnapshot(home, descriptor.record.digest, { reads: { joinPath: win32.join, physical: createWindowsPhysicalReads(backend), logicalExecutable: true } });
        records.push({ key: { kind, id }, path: win32.join(root, name), relativePath: name });
      }
    }
    if (await optionalChild(home, 'profile-publishing')) {
      const root = win32.join(home, 'profile-publishing');
      for (const name of (await enumerate(root)).names) {
        if (name === 'operation-locks') continue;
        if (['git-workspaces', 'github-workspaces', 'remote-materialization', 'git-isolation'].includes(name)) { admitWindowsPhysicalDirectory(backend, win32.join(root, name)); continue; }
        if (name === 'publication-state') {
          const retained = win32.join(root, name);
          for (const id of (await enumerate(retained)).names) {
            if (!/^[a-f0-9]{32}$/u.test(id)) throw unsupported();
            admitWindowsPhysicalDirectory(backend, win32.join(retained, id));
          }
          continue;
        }
        if (name === 'transactions') { await assertWindowsLifecycleJournalsTerminal(backend, home, operation); continue; }
        if (name === 'staging') { await requireAbsentOrEmpty(root, name); continue; }
        if (name !== 'trees' && name !== 'blobs') throw unsupported();
        for (const id of (await enumerate(win32.join(root, name))).names) {
          // Retained failed publications are not dependencies of unrelated profiles.
          // Admit the bounded namespace here; actual consumers validate referenced payloads.
          if (name === 'blobs' && /^\.blob-[a-f0-9]{32}$/u.test(id)) continue;
          if (!/^[a-f0-9]{64}$/u.test(id)) throw unsupported();
        }
      }
    }
    return { records, diagnostics: [] };
  }
  const viewReads: ProfileSystemViewReadServices = {
    ...createWindowsProfileUseReads(backend), joinPath: win32.join, readTree: storage.readTree,
    assertReadAuthority(home) {
      if (operation !== undefined) assertWindowsOperationMutationAuthority(operation.authority, backend, home, ['@store'], operationAuthorityTransactionId(operation.authority));
    },
    async scanProfileNames(home) {
      const names = (await enumerate(win32.join(home, 'profiles'))).names.filter((name) => {
        if (isSafeProfileId(name) && isValidWindowsPathComponent(name)) return true;
        if (!isReservedProfileSiblingName(name)) throw unsupported(); return false;
      });
      if (names.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries) throw unsupported(); return names;
    },
    async inspectCatalog(home) { const value = await inspectDefaultSkillCatalog(home, { platformServices: platform }); if (value.diagnostics.length) throw unsupported(); return value; },
    scanCollections
  };
  const captureDependencies: ProfileCaptureDependencies = {
    captureManagedGitHealth: (home, kind, id, environment, hooks) => provider(home).captureManagedGitExportHealth(home, kind, id, environment, hooks),
    createReads(home, profile, policy): ProfileCaptureReadServices {
      const profileRoot = win32.join(home, 'profiles', profile);
      const privateReads = createWindowsPhysicalReads(backend, profileRoot, policy);
      const externalReads = createWindowsPhysicalReads(backend, undefined, policy);
      const modes = new Map<string, boolean>();
      const forPath = (path: string) => within(home, path) ? privateReads : externalReads;
      const physical: PhysicalProfileReadServices = {
        openDirectory: (path, root) => forPath(path).openDirectory(path, root),
        inspectKind: (path) => forPath(path).inspectKind(path),
        membershipIdentity: privateReads.membershipIdentity,
        // Ready content is the stable physical worktree, not necessarily Git's blob representation.
        async readFile(path, max) { const file = await forPath(path).readFile(path, max); return { ...file, executable: modes.get(path) ?? file.executable }; }
      };
      return {
        async validateHome(root) { await providerRecords.assertReadyProviderState(root); await assertWindowsLifecycleJournalsTerminal(backend, root, operation); },
        joinPath: win32.join, profilePath: (root, name) => win32.join(root, 'profiles', name), physical,
        captureExpectation: profiles.captureExpectation, readManagedState: profiles.readManagedState,
        readTree: storage.readTree, readBlob: storage.readBlob, readCollection,
        async readRegistration(root, name) {
          const registration = await readDefaultSkillRegistration(root, name, { platformServices: platform });
          const link = backend.inspectMembershipLink(win32.join(root, 'skills', name));
          return { target: registration.target, identity: JSON.stringify({ registration, link: stableWindowsMembershipLinkInspection(link) }) };
        },
        collectionIdentity(snapshot) { if (snapshot.domain !== 'windows') throw unsupported(); return `${snapshot.volumeIdentity}:${snapshot.fileId}:${snapshot.creationTime}:${snapshot.contentSha256}`; },
        async verifySnapshot(root, digest, dependencies = {}) {
          const limitPolicy: SkillSnapshotLimitPolicy = {
            maxManifestBytes: policy.maxManifestBytes, maxEntries: policy.maxEntries,
            maxDepth: policy.maxDepth, maxPathBytes: policy.maxPathBytes,
            maxFileBytes: policy.maxBlobBytes, maxAggregateFileBytes: policy.maxAggregateBytes
          };
          for (const key of Object.keys(limitPolicy) as Array<keyof SkillSnapshotLimitPolicy>) {
            limitPolicy[key] = Math.min(limitPolicy[key], SKILL_SNAPSHOT_LIMITS[key], dependencies.limitPolicy?.[key] ?? SKILL_SNAPSHOT_LIMITS[key]);
          }
          const value = await verifySkillSnapshot(root, digest, { ...dependencies, limitPolicy, reads: { joinPath: win32.join, physical: privateReads, logicalExecutable: true } });
          for (const file of value.manifest.entries) if (file.type === 'file') modes.set(win32.join(value.artifactPath, ...file.path.split('/')), file.executable);
          return value;
        },
        async optionalManagedRecord(root, kind, id, environment) {
          const record = await providerRecords.optionalManagedGitRecord(root, kind, id);
          if (record !== undefined && kind === 'skill') {
            const evidence = await provider(root).captureManagedGitTree(record.record, environment ?? providerOptions.environment);
            for (const entry of evidence.entries) modes.set(win32.join(record.record.root, ...entry.path.split('/')), entry.mode === '100755');
          }
          return record;
        },
        managedRoot: (root) => win32.join(root, 'providers', 'git', 'checkouts'), isWithin: within
      };
    }
  };
  return { viewReads, captureDependencies, readCollection, scanCollections, async assertReadyProviderState(home: string) {
    try { admitWindowsPhysicalDirectory(backend, home); }
    catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return; throw error; }
    await providerRecords.assertReadyProviderState(home);
  } };
}
function unsupported(): BazframeError { return new BazframeError('WINDOWS_PROFILE_ACTIVATION_UNSUPPORTED_STATE', 'Unsupported or uncertain Windows resource/provider state was preserved.'); }
