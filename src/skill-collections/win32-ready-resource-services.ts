import { resolvePackageExecutable } from '../core/executable-resolution.js';
import { createHash, randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../core/content.js';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend, WindowsPathInspection } from '../core/win32-native.js';
import { stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { createWindowsPhysicalReads, createWindowsOrdinaryProfileReads } from '../profile-publishing/win32-physical-profile-reads.js';
import { createWindowsProfileStorage } from '../profile-publishing/win32-profile-storage.js';
import { createWindowsProfileDataReads } from '../profile-publishing/win32-profile-data-reads.js';
import { createWindowsProfileLifecycleServicesForInternalTesting, type WindowsProfileLifecycleOptions } from '../profile-publishing/win32-profile-lifecycle.js';
import { assertWindowsOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from '../profile-publishing/profile-operation-lock.js';
import { loadProfile } from '../profiles/profile-store.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { writeWindowsProfileFile } from '../profile-publishing/win32-profile-storage.js';
import { readWindowsPrivateFileSnapshot, readWindowsSelectionSnapshot } from '../profiles/win32-profile-selection.js';
import type { ProfileCollectionReferenceEffects } from '../profiles/profile-skill-collection-reference.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting, enumerateWindowsPrivateDirectory } from '../skills/added-skill-platform-services.js';
import { assertSafeSkillId } from '../skills/skill-id.js';
import { admitWindowsPrivateDirectory, admitWindowsPrivateFile, createWindowsPrivateDirectory, ensureWindowsPrivateDirectoryPath, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { publishWindowsPrivateStateFile } from '../state/win32-atomic-file.js';
import { PACKAGE_MANIFEST, decodePackageManifest } from '../packages/package-manifest.js';
import { boundedStateJsonBytes, packageLimitPolicy, PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { isPortableRelativePath } from './portable-relative-path.js';
import { sameResourceIdentity, isRetainedResourceFile, type ResourceIdentity, type ResourceRootIdentity } from './resource-identity.js';
import { decodeLibrary, decodePackage, scanGlobalSkillCollections, type SkillCollectionRecordSnapshot, type SkillCollectionKey, type CollectionRootPathPolicy } from './skill-collection-store.js';
import { verifySkillSnapshot, type SkillSnapshotPublicationEffects } from './skill-snapshot.js';
import { createPhysicalSkillDefinitionLoader, loadFlatSkillIdentitiesWithEffects, type SkillCollectionResolverEffects } from './skill-collection-resolver.js';
import type { SkillCollectionLifecycleServices } from './skill-collection-lifecycle.js';
import type { SkillCollectionPreparationEffects } from './skill-collection-preparation.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const key = (name: string) => name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
const within = (parent: string, child: string) => { const relative = win32.relative(parent, child); return relative !== '..' && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative); };
const pathPolicy: CollectionRootPathPolicy = { basename: win32.basename, isCanonicalAbsolute: (path) => /^[A-Za-z]:\\/u.test(path) && win32.normalize(path) === path && path.slice(3).split('\\').every(isValidWindowsPathComponent) };
const identity = (value: WindowsPathInspection): ResourceIdentity => ({ domain: 'windows', volumeIdentity: value.object.volumeIdentity, fileId: value.object.fileId, creationTime: value.object.creationTime });

/** Concrete private/read/lock effects. Add/replace/remove/build/refusal policy stays in the shared engines. */
export function createWindowsReadyResourceServices(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsProfileLifecycleOptions & { resolvePackageExecutable?: typeof resolvePackageExecutable; scope?: { home: string; authority: OperationMutationAuthority; stateAuthority: { assertHeld(): void } }; sourceReads?: import('../profile-publishing/physical-profile-closure.js').PhysicalProfileReadServices } = {}): SkillCollectionLifecycleServices {
  const lifecycle = createWindowsProfileLifecycleServicesForInternalTesting(backend, options);
  const maximum = PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries;
  const platform = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
  const profileReads = createWindowsOrdinaryProfileReads(backend);
  const storage = createWindowsProfileStorage(backend);
  async function admitProfile(home: string, profileId: string): Promise<ResourceRootIdentity> {
    assertSafeProfileId(profileId);
    const root = win32.join(home, 'profiles', profileId);
    const before = identity(admitWindowsPrivateDirectory(backend, root));
    await platform.readStableUtf8File(win32.join(root, 'AGENTS.md'), `Profile ${JSON.stringify(profileId)} instructions`, MAX_EFFECTIVE_INSTRUCTION_BYTES);
    try { admitWindowsPrivateDirectory(backend, win32.join(root, 'skills')); }
    catch (error) { if (errorCode(error) !== 'WINDOWS_NATIVE_PATH_NOT_FOUND' || (await enumerateWindowsPrivateDirectory(backend, root, maximum)).names.some((name) => key(name) === key('skills'))) throw error; }
    const after = identity(admitWindowsPrivateDirectory(backend, root));
    if (!sameResourceIdentity(before, after)) throw refused('profile root changed');
    return { ...after, root };
  }
  const physical = (external = false) => createWindowsPhysicalReads(backend, undefined, {}, external);
  async function absent(path: string, external = false): Promise<boolean> {
    if (!pathPolicy.isCanonicalAbsolute(path)) throw refused('noncanonical resource path');
    const parent = win32.dirname(path), name = win32.basename(path);
    if (parent === path) return false;
    let namespace;
    try { namespace = await enumerateWindowsPrivateDirectory(backend, parent, maximum, external ? (_backend, p) => backend.inspectPath(p) : admitWindowsPrivateDirectory); }
    catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND' && await absent(parent, external)) return true; throw error; }
    const matches = namespace.names.filter((entry) => key(entry) === key(name));
    if (matches.length === 0) return true;
    if (matches.length !== 1 || matches[0] !== name) throw refused('aliased resource path');
    return false;
  }
  async function canonical(path: string): Promise<string> {
    if (!pathPolicy.isCanonicalAbsolute(path)) throw refused('source is not a canonical local path');
    const directory = await physical(true).openDirectory(path, path);
    try { await directory.enumerate(maximum); await directory.assertStable(); return path; } finally { await directory.close(); }
  }
  async function rootIdentity(root: string): Promise<ResourceRootIdentity> {
    await canonical(root); return { ...identity(backend.inspectPath(root)), root };
  }
  async function readFile(path: string, max: number, external = false) {
    const before = backend.inspectPath(path);
    const bytes = (await physical(external).readFile(path, max)).bytes;
    const after = backend.inspectPath(path);
    if (JSON.stringify(stableWindowsPathInspection(before)) !== JSON.stringify(stableWindowsPathInspection(after))) throw refused('resource file changed');
    return { ...identity(after), bytes };
  }
  async function optionalSnapshot(home: string, collection: SkillCollectionKey): Promise<SkillCollectionRecordSnapshot | undefined> {
    assertSafeSkillId(collection.id);
    const path = win32.join(home, collection.kind === 'library' ? 'libraries' : 'packages', `${collection.id}.json`);
    if (await absent(path)) return undefined;
    const { bytes, ...proof } = await readFile(path, boundedStateJsonBytes());
    const value = json(bytes);
    return { ...proof, path, record: collection.kind === 'library' ? decodeLibrary(value, collection.id, pathPolicy) : decodePackage(value, collection.id, pathPolicy), contentSha256: hash(bytes) };
  }
  async function resolveDirectory(root: string, relative: string): Promise<string> {
    if (!isPortableRelativePath(relative)) throw refused('invalid relative directory');
    await canonical(root);
    let path = root;
    if (relative !== '.') for (const component of relative.split('/')) { path = win32.join(path, component); await canonical(path); }
    if (!within(root, path)) throw refused('directory escapes root'); return path;
  }
  async function retainedFile(path: string, name: string): Promise<boolean> { if (!isRetainedResourceFile(name)) return false; admitWindowsPrivateFile(backend, path); return true; }
  function references(): ProfileCollectionReferenceEffects { return { joinPath: win32.join, physical: physical(), readFile, absent, retainedFile }; }
  function resolver(): SkillCollectionResolverEffects {
    return {
      joinPath: win32.join, dirname: win32.dirname, basename: win32.basename, within,
      async canonical(path) { if (await absent(path, true)) throw refused('missing physical resource'); const value = backend.inspectPath(path); if (!value.ancestryReparseFree || value.object.reparseTag !== null || value.canonicalPath !== value.volume.canonicalVolumeGuidPath + path.slice(3)) throw refused('aliased physical resource'); return path; },
      async stat(path) { if (await absent(path, true)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); const value = backend.inspectPath(path); return { isDirectory: () => value.kind === 'directory', isFile: () => value.kind === 'regular-file', isSymbolicLink: () => value.object.reparseTag !== null }; },
      async enumerate(path, max) { const directory = await physical().openDirectory(path, path); try { const names = await directory.enumerate(max); await directory.assertStable(); return names; } finally { await directory.close(); } },
      verifySnapshot: (home, digest, dependencies = {}) => verifySkillSnapshot(home, digest, { ...dependencies, reads: { joinPath: win32.join, physical: physical(), logicalExecutable: true } }),
      resolveDirectory,
      async readCollection(home, collection) { const snapshot = await optionalSnapshot(home, collection); if (snapshot === undefined) throw refused('missing collection'); return snapshot.record; },
      async scanCollections(home) {
        await createWindowsProfileDataReads(backend).assertReadyProviderState(home);
        return scanGlobalSkillCollections(home, { joinPath: win32.join, physical: physical(), absent, retainedFile });
      },
      references: references(),
      definitionLoader: createPhysicalSkillDefinitionLoader(async (path, max) => (await readFile(path, max)).bytes, win32.basename)
    };
  }
  async function stateSnapshot(path: string): Promise<{ digest: string; bytes?: Buffer; inspection?: WindowsPathInspection }> {
    if (await absent(path)) return { digest: hash(Buffer.from('absent')) };
    const snapshot = await readWindowsPrivateFileSnapshot(backend, path, boundedStateJsonBytes());
    return { ...snapshot, digest: hash(Buffer.from(JSON.stringify(stableWindowsPathInspection(snapshot.inspection)) + hash(snapshot.bytes))) };
  }
  function scoped(home?: string, authority?: OperationMutationAuthority, stateAuthority?: { assertHeld(): void }): SkillCollectionLifecycleServices {
    function assertAuthority() { if (home === undefined || authority === undefined || stateAuthority === undefined) throw refused('live resource operation authority required'); stateAuthority.assertHeld(); assertWindowsOperationMutationAuthority(authority, backend, home, ['@store'], operationAuthorityTransactionId(authority)); }
    function assertHome(root: string) { assertAuthority(); if (root !== home) throw refused('resource authority home mismatch'); }
    function assertDestination(path: string) { assertAuthority(); if (!within(home!, path) || !path.endsWith('.json')) throw refused('invalid resource destination'); }
    function snapshotDependencies() {
      const publication: SkillSnapshotPublicationEffects = {
        reads: { joinPath: win32.join, physical: physical(), logicalExecutable: true },
        sourceReads: { joinPath: win32.join, physical: options.sourceReads ?? physical(true), logicalExecutable: false },
        canonicalDirectory: canonical, rootIdentity, within, assertAuthority,
        async ensureDirectory(root, path) { assertHome(root); if (!within(win32.join(root, 'skill-snapshots'), path)) throw refused('invalid snapshot store'); ensureWindowsPrivateDirectoryPath(backend, path); assertAuthority(); },
        async createDirectory(path) { assertAuthority(); if (!within(win32.join(home!, 'skill-snapshots'), path)) throw refused('invalid snapshot destination'); createWindowsPrivateDirectory(backend, win32.dirname(path), win32.basename(path)); assertAuthority(); },
        async writeFile(path, bytes) { assertAuthority(); if (!within(win32.join(home!, 'skill-snapshots'), path)) throw refused('invalid snapshot destination'); await writeWindowsProfileFile(backend, path, bytes, options.storageIo); assertAuthority(); },
        absent
      };
      return { publication };
    }
    const preparation: SkillCollectionPreparationEffects = {
      basename: win32.basename, rootIdentity, resolveDirectory, assertAuthority, snapshotDependencies,
      resolveBuild: (argv, cwd, environment) => (options.resolvePackageExecutable ?? resolvePackageExecutable)(argv, { cwd, environment, platform: 'win32' }),
      manifestAbsent: (root) => absent(win32.join(root, PACKAGE_MANIFEST), true),
      async readManifest(root, lower = {}) { const policy = packageLimitPolicy(lower), path = win32.join(root, PACKAGE_MANIFEST); const { bytes, ...proof } = await readFile(path, policy.maxManifestBytes, true); return { ...proof, path, manifest: decodePackageManifest(json(bytes), policy), contentSha256: hash(bytes) }; }
    };
    async function publish(path: string, contents: string, expected: Awaited<ReturnType<typeof stateSnapshot>>) {
      assertDestination(path);
      await publishWindowsPrivateStateFile({ backend, home: win32.dirname(path), component: win32.basename(path) as `${string}.json`, temporaryPrefix: 'resource', noReplaceOnAbsent: true, expected, bytes: Buffer.from(contents), maxBytes: boundedStateJsonBytes(), authority: { assertHeld: assertAuthority }, io: options.stateIo, readSnapshot: () => stateSnapshot(path) });
      assertAuthority();
    }
    return {
      selectionReadServices: { readSelectedProfileId: async (root) => (await readWindowsSelectionSnapshot(backend, root)).profileId },
      joinPath: win32.join, basename: win32.basename, canonicalRoot: canonical, rootIdentity, assertAuthority, optionalSnapshot,
      async withLock(root, command, target, operation) {
        if (authority !== undefined) { assertHome(root); return operation(scoped(root, authority, stateAuthority)); }
        ensureWindowsPrivateDirectoryPath(backend, root);
        for (const name of ['profiles', 'skills', 'locks']) ensureWindowsPrivateDirectoryPath(backend, win32.join(root, name));
        await lifecycle.beforeMutation?.(root);
        return lifecycle.withOperationLocks(root, ['@store'], (held) => lifecycle.withStateLock(root, target, async (stateHeld) => {
          const current = scoped(root, held, stateHeld);
          await createWindowsProfileDataReads(backend).assertReadyProviderState(root);
          current.assertAuthority(); const value = await operation(current);
          await createWindowsProfileDataReads(backend).assertReadyProviderState(root);
          current.assertAuthority(); return value;
        }));
      },
      async ensureDirectory(root, path) { assertHome(root); if (!within(root, path)) throw refused('directory outside home'); ensureWindowsPrivateDirectoryPath(backend, path); assertAuthority(); },
      async createExclusive(path, contents, root) { assertHome(root); const expected = await stateSnapshot(path); if (expected.inspection !== undefined) return false; await publish(path, contents, expected); return true; },
      async replace(path, contents, root, expected) { assertHome(root); const current = await stateSnapshot(path); if (current.inspection === undefined || current.bytes === undefined || !sameResourceIdentity(identity(current.inspection), expected) || hash(current.bytes) !== expected.contentSha256) throw refused('descriptor changed before replacement'); await publish(path, contents, current); },
      async detach(path, root, expected) {
        assertHome(root); assertDestination(path);
        const initial = await stateSnapshot(path);
        if (initial.inspection === undefined || initial.bytes === undefined || !sameResourceIdentity(identity(initial.inspection), expected) || hash(initial.bytes) !== expected.contentSha256) throw refused('descriptor changed before detach');
        const parentPath = win32.dirname(path), parent = admitWindowsPrivateDirectory(backend, parentPath);
        const retained = `.bazframe-resource-${randomBytes(16).toString('hex')}.json`, retainedPath = win32.join(parentPath, retained);
        assertAuthority(); let rejected = false;
        try { await backend.renameFileNoReplace(parentPath, win32.basename(path), retained); } catch { rejected = true; }
        assertAuthority();
        const afterParent = admitWindowsPrivateDirectory(backend, parentPath);
        if (!sameResourceIdentity(identity(parent), identity(afterParent)) || JSON.stringify(parent.security) !== JSON.stringify(afterParent.security)) throw refused('detach parent changed; retained ambiguity');
        const current = await stateSnapshot(path), moved = await stateSnapshot(retainedPath);
        if (current.inspection === undefined && moved.inspection !== undefined && moved.bytes?.equals(initial.bytes) && sameResourceIdentity(identity(moved.inspection), identity(initial.inspection)) && moved.inspection.object.attributes === initial.inspection.object.attributes && JSON.stringify(moved.inspection.security) === JSON.stringify(initial.inspection.security)) { assertAuthority(); return; }
        if (rejected && moved.inspection === undefined && current.digest === initial.digest) throw new BazframeError('WINDOWS_RESOURCE_NO_EFFECT', 'Resource detach had no effect; retry from current state.');
        throw refused('resource detach ambiguous; preserve both leaves');
      },
      preparation,
      get resolver() { return resolver(); },
      get references() { return references(); },
      admitProfile,
      async flatSkills(root, profileId) {
        // Global reference-index completeness is a separate lifecycle precondition.
        // Flat inputs depend only on this profile, never unrelated collections or closures.
        const before = await admitProfile(root, profileId);
        const profile = await loadProfile(root, profileId, { platformServices: platform });
        const directories = [...profile.skillDirectories];
        const state = await profileReads.readManagedState(root, profileId);
        for (const resource of state?.state.importedResources ?? []) {
          if (resource.source.kind === 'missingRemoteGit') continue;
          const tree = await storage.readTree(root, resource.source.treeId);
          if (tree.manifest.role !== (resource.key.kind === 'package' ? 'packageArtifacts' : resource.key.kind)) throw refused('imported artifact role mismatch');
          const definitions = tree.manifest.files.filter((file) => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'));
          if (resource.key.kind === 'skill' && (definitions.length !== 1 || definitions[0]!.path !== 'SKILL.md')) throw refused('imported direct Skill artifact mismatch');
          for (const file of definitions) {
            directories.push(win32.join(tree.path, 'root', ...file.path.split('/').slice(0, -1)));
            if (directories.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries) throw refused('flat Skill input limit exceeded');
          }
        }
        const skills = await loadFlatSkillIdentitiesWithEffects(directories, {
          joinPath: win32.join,
          definitionLoader: createPhysicalSkillDefinitionLoader(async (path, max) => (await readFile(path, max, !within(root, path))).bytes, win32.basename)
        });
        if ((await profileReads.readManagedState(root, profileId))?.sha256 !== state?.sha256
          || !sameResourceIdentity(before, await admitProfile(root, profileId))) throw refused('dependent profile changed');
        return skills;
      }
    };
  }
  return options.scope === undefined ? scoped() : scoped(options.scope.home, options.scope.authority, options.scope.stateAuthority);
}
function json(bytes: Buffer): unknown { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw refused('invalid UTF-8 JSON'); } }
function refused(detail: string): BazframeError { return new BazframeError('WINDOWS_RESOURCE_REFUSED', `Windows ready resource effects refused: ${detail}. Private state retained.`); }
