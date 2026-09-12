import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, WindowsPathInspection } from '../core/win32-native.js';
import { enumerateWindowsPhysicalDirectory } from '../skills/added-skill-platform-services.js';
import { admitWindowsPhysicalDirectory, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { sameResourceIdentity, type ResourceIdentity } from '../skill-collections/resource-identity.js';

/** A single physical effect, not a provider transaction or reclamation engine. */
export async function moveWindowsManagedGitDirectory(options: {
  backend: BazframeWin32NativeBackend;
  source: string;
  destination: string;
  expected: ResourceIdentity;
  authority: { assertHeld(): void };
}): Promise<void> {
  const { backend, source, destination, expected, authority } = options;
  authority.assertHeld();
  const sourceParent = win32.dirname(source), destinationParent = win32.dirname(destination);
  const sourceName = win32.basename(source), destinationName = win32.basename(destination);
  if (!isValidWindowsPathComponent(sourceName) || !isValidWindowsPathComponent(destinationName)
    || source.toLowerCase() === destination.toLowerCase()) throw refused('invalid move paths');
  const parents = [admitWindowsPhysicalDirectory(backend, sourceParent), admitWindowsPhysicalDirectory(backend, destinationParent)];
  if (parents[0]!.volume.identity !== parents[1]!.volume.identity) throw refused('cross-volume directory move');
  const before = await observe(sourceParent, sourceName);
  if (before === undefined || !sameResourceIdentity(identity(before), expected)) throw refused('source identity changed');
  if (await observe(destinationParent, destinationName) !== undefined) throw refused('destination occupied');
  authority.assertHeld();
  let operationError: unknown;
  try { await backend.moveDirectoryNoReplace(sourceParent, sourceName, destinationParent, destinationName); }
  catch (error) { operationError = error; }
  // A syscall return is never the outcome proof, including move-then-error.
  authority.assertHeld();
  const currentParents = [admitWindowsPhysicalDirectory(backend, sourceParent), admitWindowsPhysicalDirectory(backend, destinationParent)];
  if (!parents.every((parent, index) => sameDirectory(parent, currentParents[index]!))) throw refused('move parent changed; retain ambiguity', operationError);
  const remaining = await observe(sourceParent, sourceName), moved = await observe(destinationParent, destinationName);
  authority.assertHeld();
  if (remaining === undefined && moved !== undefined && sameDirectory(before, moved)) return;
  if (remaining !== undefined && sameDirectory(before, remaining) && moved === undefined) {
    throw new BazframeError('WINDOWS_MANAGED_GIT_MOVE_NO_EFFECT', 'Managed Git directory move had no effect.', { cause: operationError });
  }
  throw refused('move outcome ambiguous; retain both namespaces', operationError);

  async function observe(parent: string, name: string): Promise<WindowsPathInspection | undefined> {
    const namespace = await enumerateWindowsPhysicalDirectory(backend, parent, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries);
    authority.assertHeld();
    const key = (value: string) => value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
    const matches = namespace.names.filter((entry) => key(entry) === key(name));
    if (matches.length === 0) return undefined;
    if (matches.length !== 1 || matches[0] !== name) throw refused('aliased move namespace');
    return admitWindowsPhysicalDirectory(backend, win32.join(parent, name));
  }
}
function identity(value: WindowsPathInspection): ResourceIdentity { return { domain: 'windows', volumeIdentity: value.object.volumeIdentity, fileId: value.object.fileId, creationTime: value.object.creationTime }; }
function sameDirectory(left: WindowsPathInspection, right: WindowsPathInspection): boolean {
  return sameResourceIdentity(identity(left), identity(right)) && left.object.attributes === right.object.attributes;
}
function refused(detail: string, cause?: unknown): BazframeError { return new BazframeError('WINDOWS_MANAGED_GIT_MOVE_UNPROVEN', `Managed Git directory move refused: ${detail}.`, { cause }); }

import { randomBytes } from 'node:crypto';
import { resolveControlledExecutable, executableEnvironmentValue, type resolvePackageExecutable, type ExecutableResolutionOptions } from '../core/executable-resolution.js';
import { stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import type { BazframeWin32LockBackend } from '../core/win32-native.js';
import { createWindowsPrivateDirectory, ensureWindowsPrivateDirectoryPath } from '../state/win32-private-directory.js';
import { requireDirectChild } from '../state/win32-directory-closure.js';
import { createWindowsManagedGitRecordEffects, windowsManagedGitPaths, windowsManagedGitPathPolicy, windowsResourceIdentity } from './managed-git-services.js';
import { createManagedGitProvider, type ManagedGitServices, type ImportOccupancy } from './managed-git.js';
import { createManagedGitAcquisitionInspector, type ManagedGitInspectionEffects } from './managed-git-acquisition-inspection.js';
import { decodeManagedGitRecord, encodeManagedGitRecord } from './managed-git-record.js';
import { createWindowsReadyResourceServices } from '../skill-collections/win32-ready-resource-services.js';
import { createWindowsPhysicalReads } from '../profile-publishing/win32-physical-profile-reads.js';
import { createWindowsProfileLifecycleServicesForInternalTesting, type WindowsProfileLifecycleOptions } from '../profile-publishing/win32-profile-lifecycle.js';
import { assertWindowsOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from '../profile-publishing/profile-operation-lock.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../skills/added-skill-platform-services.js';
import { readDefaultSkillRegistration } from '../skills/default-skill-catalog.js';
import { verifySkillSnapshot } from '../skill-collections/skill-snapshot.js';
import { parseSkillDeclaredName } from '../skills/skill-metadata.js';
import { MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../core/content.js';
import type { ManagedGitTreeEvidence } from './managed-git-tree.js';
import { runManagedGitProcess } from './managed-git-process.js';
import { spawnBoundedPackageProcess } from '../core/child-process.js';
import { writeWindowsProfileFile } from '../profile-publishing/win32-profile-storage.js';

export interface WindowsManagedGitOptions extends WindowsProfileLifecycleOptions {
  resolvePackageExecutable?: typeof resolvePackageExecutable;
  membershipIo?: import('../state/win32-skill-membership.js').WindowsSkillMembershipIo;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  process?: typeof runManagedGitProcess;
  resolveExecutable?: (command: string, options: ExecutableResolutionOptions) => Promise<string>;
  packageProcessRunner?: ManagedGitServices['collectionDependencies']['packageProcessRunner'];
}
interface ProviderScope { home: string; authority: OperationMutationAuthority; stateAuthority: { assertHeld(): void } }

/** Native metadata effects beneath the same bounded acquisition inspector used on POSIX. */
export function createWindowsGitInspectionEffects(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend): ManagedGitInspectionEffects {
  // Only the shared live monitors decide whether an observed absence is transient.
  // Required roots and final stable proofs still reject this ordinary absence.
  function inspectionError(error: unknown): unknown { return errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND' ? new BazframeError('ENOENT', 'Windows Git inspection observed an absent path.', { cause: error }) : error; }
  function inspect(path: string): WindowsPathInspection {
    try { return inspectPresent(path); } catch (error) { throw inspectionError(error); }
  }
  function inspectPresent(path: string): WindowsPathInspection {
    const value = backend.inspectPath(path);
    if (value.kind === 'directory') return admitWindowsPhysicalDirectory(backend, path);
    const parent = admitWindowsPhysicalDirectory(backend, win32.dirname(path));
    requireDirectChild(parent, value, win32.basename(path));
    if (!value.ancestryReparseFree || value.object.reparseTag !== null || value.object.deletePending || value.kind !== 'regular-file') throw refused('nonphysical Git storage');
    return value;
  }
  const stat: ManagedGitInspectionEffects['stat'] = async (path) => {
    const value = inspect(path), object = value.object;
    return { identity: windowsResourceIdentity(value), size: BigInt(`0x${object.size}`), nlink: BigInt(`0x${object.numberOfLinks}`), mtimeNs: BigInt(`0x${object.lastWriteTime}`), ctimeNs: BigInt(`0x${object.changeTime}`), isDirectory: () => value.kind === 'directory', isFile: () => value.kind === 'regular-file', isSymbolicLink: () => false };
  };
  return { join: win32.join, basename: win32.basename, stat,
    async open(path) {
      const before = inspect(path); let closed = false;
      return { async stat() { if (closed) throw refused('expired inspection handle'); const current = inspect(path); if (!sameResourceIdentity(windowsResourceIdentity(before), windowsResourceIdentity(current))) throw refused('Git inspection identity changed'); return stat(path); }, async close() { closed = true; } };
    },
    async opendir(path, maxEntries = PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) {
      const namespace = await enumerateWindowsPhysicalDirectory(backend, path, maxEntries).catch((error: unknown) => { throw inspectionError(error); });
      let index = 0, closed = false;
      return { async read() { if (closed) throw refused('expired enumeration'); const name = namespace.names[index++]; return name === undefined ? null : { name }; }, async close() { closed = true; } };
    },
    async sampleOpendir(path, maxEntries = PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) {
      // This single native physical sample is not a namespace closure or publication proof.
      const sample = await backend.sampleDirectory(path, maxEntries).catch((error: unknown) => { throw inspectionError(error); });
      let index = 0, closed = false;
      return { async read() { if (closed) throw refused('expired enumeration'); const name = sample.names[index++]; return name === undefined ? null : { name }; }, async close() { closed = true; } };
    },
    async readlink() { throw refused('Git reparse entries are unsupported'); }
  };
}

/** Read-only services never create home, recover journals, resolve login, fetch, or build. */
export function createWindowsManagedGitServices(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, home: string, options: WindowsManagedGitOptions = {}, scope?: ProviderScope): ManagedGitServices {
  function assertAuthority() {
    if (scope === undefined || scope.home !== home) throw refused('live provider scope required');
    scope.stateAuthority.assertHeld();
    assertWindowsOperationMutationAuthority(scope.authority, backend, home, ['@store'], operationAuthorityTransactionId(scope.authority));
  }
  const records = createWindowsManagedGitRecordEffects(backend, options, scope === undefined ? undefined : { assertHeld: assertAuthority });
  const physical = () => createWindowsPhysicalReads(backend);
  const inspection = createWindowsGitInspectionEffects(backend);
  const inspector = createManagedGitAcquisitionInspector(inspection);
  const baseCatalog = createWindowsAddedSkillPlatformServicesForInternalTesting(backend, { membershipIo: options.membershipIo, lockIo: options.lockIo });
  const catalog = { ...baseCatalog,
    async assertManagedSkillLocation(root: string, canonicalTarget: string) {
      const id = win32.basename(canonicalTarget), record = await records.readManagedGitRecord(root, 'skill', id);
      const proof = baseCatalog.inspectPhysicalDirectory(record.record.root);
      if (proof.canonicalPath !== canonicalTarget) throw refused('managed Skill provenance does not prove target');
    },
    async withLock<T>(_path: string, _details: unknown, operation: (authority: { assertHeld(): void }) => Promise<T>): Promise<T> { assertAuthority(); const result = await operation({ assertHeld: assertAuthority }); assertAuthority(); return result; }
  };
  const sourceEvidence = new Map<string, ManagedGitTreeEvidence>();
  const sourceEnvironments = new Map<string, NodeJS.ProcessEnv>();
  const evidenceIdentity = new Map<string, ResourceIdentity>();
  const sourcePhysical = createWindowsPhysicalReads(backend);
  const sourceReads = { ...sourcePhysical,
    async openDirectory(path: string, trustedRoot: string) {
      const directory = await sourcePhysical.openDirectory(path, trustedRoot);
      return { ...directory, async assertStable() {
        await directory.assertStable();
        if (path === trustedRoot) {
          const source = [...sourceEvidence].find(([root]) => within(root, path));
          if (source !== undefined) {
            const relative = win32.relative(win32.join(home, 'providers', 'git', 'checkouts'), source[0]).split('\\');
            const record = await records.readManagedGitRecord(home, relative[0] as 'skill' | 'library' | 'package', relative[1]!);
            const current = await createManagedGitProvider(services).captureManagedGitTreeEvidence(source[0], record.record.revision, sourceEnvironments.get(source[0]) ?? options.environment);
            if (current.sha256 !== source[1].sha256) throw refused('Git source mode/index evidence changed during snapshot');
          }
        }
      } };
    },
    async readFile(path: string, maximum: number) {
      const file = await sourcePhysical.readFile(path, maximum);
      const source = [...sourceEvidence].find(([root]) => within(root, path));
      const entry = source?.[1].entries.find((entry) => entry.path === win32.relative(source[0], path).split('\\').join('/'));
      // Transport stable worktree bytes (including built-in EOL conversion), with Git's logical mode.
      return { ...file, executable: entry?.mode === '100755' };
    }
  };
  const ready = createWindowsReadyResourceServices(backend, { ...options, sourceReads, ...(scope === undefined ? {} : { scope }) });
  const requiredCollection: ManagedGitServices['readCollectionSnapshot'] = async (root, collection) => {
    const snapshot = await ready.optionalSnapshot(root, collection);
    if (snapshot === undefined) throw refused('missing collection registration'); return snapshot;
  };
  const isolation = win32.join(home, 'providers', 'git', 'isolation');
  function isolatedPath(name: string) {
    const path = win32.join(isolation, name);
    admitWindowsPhysicalDirectory(backend, path);
    return path;
  }
  const services: ManagedGitServices = {
    ...windowsManagedGitPaths, ...inspector,
    platform: 'win32', recordTreeEvidence(root, evidence) { const current = windowsResourceIdentity(admitWindowsPhysicalDirectory(backend, root)); const prior = sourceEvidence.get(root); if (prior !== undefined && sameResourceIdentity(evidenceIdentity.get(root)!, current) && prior.sha256 !== evidence.sha256) throw refused('Git modes changed in the provider operation'); sourceEvidence.set(root, evidence); evidenceIdentity.set(root, current); }, assertAuthority, catalogServices: catalog, collectionDependencies: { services: ready, packageProcessRunner: options.packageProcessRunner ?? spawnBoundedPackageProcess },
    runProcess(executable, args, cwd, environment, limits, hooks) { sourceEnvironments.set(cwd, { ...environment, BAZFRAME_GIT_COMMAND: executable }); return (options.process ?? runManagedGitProcess)(executable, args, cwd, environment, limits, hooks); },
    async writeProviderFile(path, text, expected) {
      assertAuthority(); if (!within(home, path)) throw refused('provider file outside scope');
      await records.ensureDirectory(win32.dirname(path));
      const current = await records.state(path);
      if (expected === null) { if ('inspection' in current) throw refused('provider destination occupied'); }
      else if (!('inspection' in current) || !sameResourceIdentity(windowsResourceIdentity(current.inspection), expected) || current.sha256 !== expected.sha256) throw refused('provider expected-old changed');
      await records.publish(path, Buffer.from(text), current); assertAuthority();
    },
    readPackageManifest: ready.preparation.readManifest,
    readDefaultSkillRegistration: (root, id) => readDefaultSkillRegistration(root, id, { platformServices: catalog }),
    async captureSkillRegistrationIdentity(root, id) {
      const registration = await readDefaultSkillRegistration(root, id, { platformServices: catalog });
      const link = backend.inspectMembershipLink(win32.join(root, 'skills', id));
      return JSON.stringify({ registration, link });
    },
    readCollectionSnapshot: requiredCollection,
    readLibrarySnapshot: (root, id) => requiredCollection(root, { kind: 'library', id }) as ReturnType<ManagedGitServices['readLibrarySnapshot']>,
    readPackageSnapshot: (root, id) => requiredCollection(root, { kind: 'package', id }) as ReturnType<ManagedGitServices['readPackageSnapshot']>,
    readLibrary: async (root, id) => (await services.readLibrarySnapshot(root, id)).record,
    readPackage: async (root, id) => (await services.readPackageSnapshot(root, id)).record,
    verifySkillSnapshot: (root, digest, dependencies = {}) => verifySkillSnapshot(root, digest, { ...dependencies, reads: { joinPath: win32.join, physical: physical(), logicalExecutable: true } }),
    async ensureManagedDirectory(root, path) { assertAuthority(); if (root !== home || !within(home, path)) throw refused('provider destination outside home'); await records.ensureDirectory(path); },
    async writeFileAtomic(path, text) { assertAuthority(); if (!within(home, path) || typeof text !== 'string') throw refused('invalid provider write'); await records.ensureDirectory(win32.dirname(path)); await records.publish(path, Buffer.from(text), await records.state(path)); },
    async withStateLock(_path, _details, operation) { assertAuthority(); const result = await operation(); assertAuthority(); return result; },
    async holdReadOnlyPathAnchor(path) {
      let ancestor = path;
      while (await records.absent(ancestor)) { const parent = win32.dirname(ancestor); if (parent === ancestor) throw refused('absent volume'); ancestor = parent; }
      const before = admitWindowsPhysicalDirectory(backend, ancestor);
      const initialAbsent = ancestor !== path; let closed = false;
      const assertStable = async () => { if (closed || JSON.stringify(stableWindowsPathInspection(before)) !== JSON.stringify(stableWindowsPathInspection(admitWindowsPhysicalDirectory(backend, ancestor))) || initialAbsent !== await records.absent(path)) throw refused('read-only anchor changed'); };
      return { path, assertStable, async close() { await assertStable(); closed = true; } };
    },
    async canonicalManagedGitRoot(record) { await services.physicalDirectory(record.root); return record.root; },
    decodeManagedGitRecord: (value, expected) => decodeManagedGitRecord(value, expected, windowsManagedGitPathPolicy),
    optionalManagedGitRecord: records.optionalManagedGitRecord, optionalManagedGitRecordInExistingNamespace: records.optionalManagedGitRecordInExistingNamespace,
    readManagedGitRecord: records.readManagedGitRecord, readManagedGitJournal: records.readManagedGitJournal,
    basename: win32.basename, dirname: win32.dirname, join: win32.join, relative: win32.relative, resolve: win32.resolve, sep: win32.sep,
    async realpath(path) { await services.physicalDirectory(path); return path; },
    async mkdtemp(prefix) { assertAuthority(); const path = `${prefix}${randomBytes(16).toString('hex')}`; createWindowsPrivateDirectory(backend, win32.dirname(path), win32.basename(path)); assertAuthority(); return path; },
    async captureImportOccupancy(root, paths) {
      const result = new Map<string, ImportOccupancy>();
      for (const leaf of Object.values(paths)) {
        if (!within(root, leaf)) throw refused('occupancy path outside home');
        const components = [root]; let path = root;
        for (const part of win32.relative(root, leaf).split('\\')) { path = win32.join(path, part); components.push(path); }
        for (const current of components) {
          if (await records.absent(current)) { result.set(current, 'absent'); result.set(leaf, 'absent'); break; }
          const value = backend.inspectPath(current);
          if (current !== leaf) admitWindowsPhysicalDirectory(backend, current);
          result.set(current, { ...windowsResourceIdentity(value), type: value.kind, mtimeNs: value.object.lastWriteTime, ctimeNs: value.object.changeTime });
        }
      }
      return result;
    },
    repositoryArgs(_root, args) { return ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${isolatedPath('hooks')}`, '-c', 'core.autocrlf=false', ...args]; },
    async assertManagedGitResourceRecoveryAbsent(root, kind, id) { if (!await records.absent(windowsManagedGitPaths.managedGitJournalPath(root, kind, id))) throw refused('resource recovery requires inspection'); },
    resolveManagedGitCommand: async (environment, excludedRoot) => {
      if ((await records.snapshot(win32.join(isolation, 'empty'))).bytes.length !== 0) throw refused('private Git isolation config changed');
      for (const name of ['hooks', 'home', 'xdg']) if ((await enumerateWindowsPhysicalDirectory(backend, win32.join(isolation, name), 0)).names.length !== 0) throw refused('private Git isolation acquired content');
      return (options.resolveExecutable ?? resolveControlledExecutable)(executableEnvironmentValue(environment, 'BAZFRAME_GIT_COMMAND', true) || 'git', { platform: 'win32', cwd: options.cwd ?? process.cwd(), environment, excludedRoots: [excludedRoot] });
    },
    async resolveManagedGithubCommand(environment, excludedRoot) { try { return await (options.resolveExecutable ?? resolveControlledExecutable)(executableEnvironmentValue(environment, 'BAZFRAME_GH_COMMAND', true) || 'gh', { platform: 'win32', cwd: options.cwd ?? process.cwd(), environment, excludedRoots: [excludedRoot] }); } catch (error) { if (error instanceof BazframeError && error.code === 'EXECUTABLE_NOT_FOUND') return undefined; throw error; } },
    gitEnvironment(environment, isolated) {
      const strict = environment.BAZFRAME_STRICT_GIT_ENVIRONMENT === '1';
      const result: NodeJS.ProcessEnv = strict ? {} : { ...environment };
      if (strict) for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'GH_CONFIG_DIR', 'BAZFRAME_GIT_COMMAND', 'BAZFRAME_GH_COMMAND']) { const value = executableEnvironmentValue(environment, key, true); if (value !== undefined) result[key] = value; }
      for (const name of Object.keys(result)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|CONFIG_PARAMETERS|CEILING_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|SSH|SSH_COMMAND|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR|EXTERNAL_DIFF|DIFF_OPTS|PAGER|EDITOR|GRAFT_FILE)$/iu.test(name)) delete result[name];
      result.GIT_OPTIONAL_LOCKS = '0'; result.GIT_ATTR_NOSYSTEM = '1'; result.GIT_NO_REPLACE_OBJECTS = '1';
      result.GIT_GRAFT_FILE = win32.join(isolation, 'empty');
      if (isolated || environment.BAZFRAME_STRICT_GIT_ENVIRONMENT === '1') {
        result.GIT_CONFIG_NOSYSTEM = '1'; result.GIT_CONFIG_GLOBAL = win32.join(isolation, 'empty'); result.GIT_CONFIG_SYSTEM = win32.join(isolation, 'empty');
        result.HOME = isolatedPath('home'); result.XDG_CONFIG_HOME = isolatedPath('xdg');
      }
      if (environment.BAZFRAME_STRICT_GIT_ENVIRONMENT === '1') {
        result.GIT_TERMINAL_PROMPT = '0'; result.GIT_CONFIG_COUNT = '3';
        result.GIT_CONFIG_KEY_0 = 'credential.helper'; result.GIT_CONFIG_VALUE_0 = '';
        result.GIT_CONFIG_KEY_1 = 'protocol.allow'; result.GIT_CONFIG_VALUE_1 = 'never';
        result.GIT_CONFIG_KEY_2 = 'protocol.https.allow'; result.GIT_CONFIG_VALUE_2 = 'always';
      }
      return result;
    },
    async physicalDirectory(path) { admitWindowsPhysicalDirectory(backend, path); },
    async directoryIdentity(path) { return windowsResourceIdentity(admitWindowsPhysicalDirectory(backend, path)); },
    async holdDirectoryIdentity(path) { const value = await services.directoryIdentity(path); return { identity: value, handle: { async close() { if (!sameResourceIdentity(value, await services.directoryIdentity(path))) throw refused('retained directory identity changed'); } } }; },
    moveDirectory: (source, destination, expected) => moveWindowsManagedGitDirectory({ backend, source, destination, expected, authority: { assertHeld: assertAuthority } }),
    async removeOwnedTree(path, expected) {
      assertAuthority(); if (!sameResourceIdentity(expected, await services.directoryIdentity(path))) throw refused('checkout changed before detachment');
      const recovery = windowsManagedGitPaths.managedGitRecoveryRoot(home); await records.ensureDirectory(recovery);
      if (within(recovery, path)) return; // Already private and inactive: retention, not recursive deletion.
      await services.moveDirectory(path, win32.join(recovery, `retained-${randomBytes(16).toString('hex')}`), expected);
    },
    async removeOwnedContainer(path, expected) { assertAuthority(); if (!sameResourceIdentity(expected, await services.directoryIdentity(path))) throw refused('retained staging identity changed'); },
    async clearPartialClone(container, expected, root) { assertAuthority(); if (!sameResourceIdentity(expected, await services.directoryIdentity(container))) throw refused('staging changed before fallback'); if (!await records.absent(root)) await services.removeOwnedTree(root, await services.directoryIdentity(root)); },
    pathExists: async (path) => !await records.absent(path),
    async createExclusiveFile(root, path, text) { if (root !== home || !within(home, path)) throw refused('invalid provider file destination'); await records.ensureDirectory(win32.dirname(path)); const value = await records.createFile(path, text); return { ...windowsResourceIdentity(value.inspection), sha256: value.sha256 }; },
    async physicalFileIdentity(path) { const value = await records.snapshot(path); return { ...windowsResourceIdentity(value.inspection), sha256: value.sha256 }; },
    removeOwnedFile: records.detach,
    removeOwnedRecord: (_root, expected) => records.detach(expected.path, { ...expected, sha256: expected.contentSha256 }),
    async restoreOwnedRecord(_root, expected, replacement) { const current = await records.snapshot(expected.path); if (!sameResourceIdentity(current, expected) || current.sha256 !== expected.contentSha256) throw refused('record changed before rollback'); await records.publish(expected.path, Buffer.from(encodeManagedGitRecord(replacement)), current); },
    restoreOwnedDirectory: (source, expected, destination) => services.moveDirectory(source, destination, expected),
    async readStableSkillName(path) { return parseSkillDeclaredName(new TextDecoder('utf-8', { fatal: true }).decode((await physical().readFile(path, MAX_EFFECTIVE_INSTRUCTION_BYTES)).bytes), path); }
  };
  return services;
}

/** Lock composition only: acquisition, update, consent, activation and rollback remain shared. */
export async function withWindowsManagedGitProvider<T>(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, home: string, options: WindowsManagedGitOptions, operation: (provider: ReturnType<typeof createManagedGitProvider>) => Promise<T>): Promise<T> {
  const lifecycle = createWindowsProfileLifecycleServicesForInternalTesting(backend, options);
  ensureWindowsPrivateDirectoryPath(backend, home);
  for (const name of ['profiles', 'skills', 'locks']) ensureWindowsPrivateDirectoryPath(backend, win32.join(home, name));
  return lifecycle.withOperationLocks(home, ['@store'], (authority) => lifecycle.withStateLock(home, 'managed-git', async (stateAuthority) => {
    const scope = { home, authority, stateAuthority };
    const services = createWindowsManagedGitServices(backend, home, options, scope);
    services.assertAuthority();
    const isolation = win32.join(home, 'providers', 'git', 'isolation');
    await services.ensureManagedDirectory(home, isolation);
    for (const name of ['hooks', 'home', 'xdg']) await services.ensureManagedDirectory(home, win32.join(isolation, name));
    if (!await services.pathExists(win32.join(isolation, 'empty'))) await writeWindowsProfileFile(backend, win32.join(isolation, 'empty'), Buffer.alloc(0), options.storageIo);
    services.assertAuthority(); const result = await operation(createManagedGitProvider(services)); services.assertAuthority(); return result;
  }));
}
function within(parent: string, child: string): boolean { const relative = win32.relative(parent, child); return relative !== '..' && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative); }
