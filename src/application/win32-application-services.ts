import { admitWindowsPrivateFile } from '../state/win32-private-directory.js';
import { enumerateWindowsPrivateDirectory } from '../skills/added-skill-platform-services.js';
import { createPiRuntimeServices } from '../adapters/pi/runtime-services.js';
import { createWindowsOwnedFileServices } from '../policy/win32-policy-services.js';
import { decodeUtf8Instructions, MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../core/content.js';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { BazframeError, errorCode } from '../core/errors.js';
import { loadBazframeWin32Native, type BazframeWin32NativeBackend, type BazframeWin32LockBackend, type BazframeWin32EditorBackend } from '../core/win32-native.js';
import { proveWindowsEditorTarget } from '../core/win32-editor-target.js';
import { resolveControlledExecutable, type ExecutableResolutionEffects } from '../core/executable-resolution.js';
import { createWindowsPolicyServices } from '../policy/win32-policy-services.js';
import { createWindowsGitRootServices } from '../project/win32-git-root.js';
import { createWindowsProfileLifecycleServicesForInternalTesting, createWindowsProfileZipLifecycleDependencies, createWindowsImportedResourceMembershipDependencies } from '../profile-publishing/win32-profile-lifecycle.js';
import { createWindowsProfileActivationServicesForInternalTesting } from '../profile-publishing/win32-profile-activation.js';
import { createWindowsProfileDataReads } from '../profile-publishing/win32-profile-data-reads.js';
import { createWindowsProfileStorage, writeWindowsProfileFile } from '../profile-publishing/win32-profile-storage.js';
import { createWindowsProfileGithubEffects } from '../profile-publishing/win32-profile-github-effects.js';
import { createWindowsPhysicalReads } from '../profile-publishing/win32-physical-profile-reads.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../profiles/win32-profile-provisioning.js';
import { createWindowsProfileSelectionReadServicesForInternalTesting } from '../profiles/win32-profile-selection.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../skills/added-skill-platform-services.js';
import { createWindowsReadyResourceServices } from '../skill-collections/win32-ready-resource-services.js';
import { createPhysicalSkillDefinitionLoader } from '../skill-collections/skill-collection-resolver.js';
import { createManagedGitProvider } from '../providers/managed-git.js';
import { createWindowsManagedGitServices, withWindowsManagedGitProvider, type WindowsManagedGitOptions } from '../providers/win32-managed-git-services.js';
import { createWindowsManagedGitRecordEffects } from '../providers/managed-git-services.js';
import { createWindowsPiAdapterServices } from '../adapters/pi/win32-adapter-services.js';
import type { ApplicationServices } from './application-services.js';

export interface WindowsApplicationOptions extends WindowsManagedGitOptions {
  profileProcess?: import('../profile-publishing/profile-github-process.js').ProfileGithubProcess;
  zip?: NonNullable<Parameters<typeof createWindowsProfileZipLifecycleDependencies>[1]>['zip'];
  backend?: () => BazframeWin32NativeBackend & BazframeWin32LockBackend & BazframeWin32EditorBackend;
  parse?: typeof parseFrontmatter;
  executableEffects?: ExecutableResolutionEffects;
  readLinkPath?: (path: string) => Promise<string>;
  packageRoot?: string;
}
/** Construction is lazy. One native backend identity is shared; acquired mutation authority is never cached. */
export function createWindowsApplicationServices(options: WindowsApplicationOptions = {}): ApplicationServices {
  let loaded: ReturnType<typeof loadBazframeWin32Native> | undefined;
  const backend = () => loaded ??= (options.backend ?? loadBazframeWin32Native)();
  const lifecycleOptions = { ...options, managedGit: options };
  const platform = () => createWindowsAddedSkillPlatformServicesForInternalTesting(backend(), options);
  const lifecycle = () => createWindowsProfileLifecycleServicesForInternalTesting(backend(), lifecycleOptions);
  const resolveExecutable = (command: string, target: { cwd: string }, environment: NodeJS.ProcessEnv) => resolveControlledExecutable(command, { cwd: target.cwd, environment, platform: 'win32', effects: options.executableEffects });
  return {
    paths: win32,
    async temporaryInstructions(contents, repositoryRoot, temporaryRoot) {
      const native = backend(), filesystem = createWindowsProfileGithubEffects(native, lifecycleOptions).runtimeFilesystem;
      const reads = createWindowsReadyResourceServices(native, lifecycleOptions).resolver;
      const repository = await reads.canonical(repositoryRoot);
      const root = await reads.canonical(temporaryRoot!);
      const relative = win32.relative(repository, root);
      if (relative === '' || relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative)) throw new BazframeError('TEMPORARY_ROOT_INSIDE_REPOSITORY', 'Temporary instructions must be outside the repository.');
      const directory = await filesystem.createWorkspaceParent(repositoryRoot, root, true), path = win32.join(directory, '.baz.agents.md');
      try { await writeWindowsProfileFile(native, path, Buffer.from(contents), options.storageIo); }
      catch (error) { await filesystem.disposeWorkspaceParent(directory); throw error; }
      return { path, cleanup: () => filesystem.disposeWorkspaceParent(directory) };
    },
    launcher: { platform: 'win32', executableEffects: options.executableEffects },
    get reads() {
      const native = backend(), resolver = createWindowsReadyResourceServices(native, options).resolver;
      return { stat: resolver.stat, async canonical(path: string) { await resolver.stat(path); return resolver.canonical(path); },
        async entries(path: string, external = false) { const directory = await createWindowsPhysicalReads(native, undefined, {}, external).openDirectory(path, path); try { const names = await directory.enumerate(4096); await directory.assertStable(); return names.map((name) => ({ name })); } finally { await directory.close(); } },
        async instructions(path: string, label: string) { return decodeUtf8Instructions((await createWindowsPhysicalReads(native, undefined, {}, true).readFile(path, MAX_EFFECTIVE_INSTRUCTION_BYTES)).bytes, label, path); }
      };
    },
    parseFrontmatter: options.parse ?? parseFrontmatter,
    get policy() { return createWindowsPolicyServices(backend(), options); },
    get gitRoot() { return createWindowsGitRootServices(backend(), options); },
    get profiles() { return { platformServices: platform() }; },
    get provisioning() { return createWindowsProfileProvisioningServicesForInternalTesting(backend(), { publicationIo: options.stateIo, lockIo: options.lockIo }); },
    get selection() { return createWindowsProfileSelectionReadServicesForInternalTesting(backend()); },
    get lifecycle() { return lifecycle(); },
    get activation() { return createWindowsProfileActivationServicesForInternalTesting(backend(), { selectionIo: options.stateIo, lockIo: options.lockIo, journal: options.journal }); },
    get profileLifecycle() { return createWindowsProfileZipLifecycleDependencies(backend(), lifecycleOptions); },
    copyProfileEffects: (home, authority) => createWindowsProfileStorage(backend(), options.storageIo).copyEffects(home, authority),
    get importedMembership() { return createWindowsImportedResourceMembershipDependencies(backend(), lifecycleOptions); },
    packageProcessRunner: options.packageProcessRunner,
    get collections() { return createWindowsReadyResourceServices(backend(), options); },
    get view() { return createWindowsProfileDataReads(backend(), undefined, options).viewReads; },
    get projection() {
      const native = backend(), resolver = createWindowsReadyResourceServices(native, options).resolver;
      resolver.definitionLoader = createPhysicalSkillDefinitionLoader(async (path, max) => (await createWindowsPhysicalReads(native, undefined, {}, true).readFile(path, max)).bytes, win32.basename, options.parse ?? parseFrontmatter);
      return { view: createWindowsProfileDataReads(native, undefined, options).viewReads, readTree: createWindowsProfileStorage(native, options.storageIo).readTree, resolver };
    },
    get providerRecords() {
      const native = backend(), records = createWindowsManagedGitRecordEffects(native);
      return { join: win32.join, recordsRoot: (home: string) => win32.join(home, 'providers', 'git', 'records'), recoveryRoot: records.managedGitRecoveryRoot, entries: async (path: string) => [...(await enumerateWindowsPrivateDirectory(native, path, 4096)).names], readRecord: records.readManagedGitRecord, readJournal: records.readManagedGitJournal };
    },
    async countAliasCache(home) {
      const native = backend(), root = win32.join(home, 'adapter-cache', 'pi', 'skill-aliases'); let count = 0, entries = 0;
      const observations = new Map<string, string>();
      const names = async (path: string) => { const result = await enumerateWindowsPrivateDirectory(native, path, 4096); observations.set(path, result.identity); entries += result.names.length; if (entries > 10000) throw new BazframeError('PI_ALIAS_CACHE_INVALID', 'Alias cache exceeds its read bound.'); return result.names.filter((name) => !name.endsWith('.retained')); };
      try {
        for (const profile of await names(root)) for (const alias of await names(win32.join(root, profile))) {
          const directory = win32.join(root, profile, alias);
          for (const name of await names(directory)) if (name === 'SKILL.md') { admitWindowsPrivateFile(native, win32.join(directory, name)); count += 1; }
        }
        for (const [path, identity] of observations) if ((await enumerateWindowsPrivateDirectory(native, path, 4096)).identity !== identity) throw new BazframeError('PI_ALIAS_CACHE_INVALID', 'Alias cache changed while counted.');
        return count;
      } catch (error) { if (observations.size === 0 && errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return 0; throw error; }
    },
    provider(home): ReturnType<typeof createManagedGitProvider> {
      const native = backend();
      const mutate = <T>(operation: (provider: ReturnType<typeof createManagedGitProvider>) => Promise<T>) => withWindowsManagedGitProvider(native, home, lifecycleOptions, operation);
      return {
        ...createManagedGitProvider(createWindowsManagedGitServices(native, home, options)),
        addManagedGitSkill: (...args) => mutate((provider) => provider.addManagedGitSkill(...args)),
        addManagedGitLibrary: (...args) => mutate((provider) => provider.addManagedGitLibrary(...args)),
        addManagedGitPackage: (...args) => mutate((provider) => provider.addManagedGitPackage(...args)),
        addManagedGitSkillAtRevision: (...args) => mutate((provider) => provider.addManagedGitSkillAtRevision(...args)),
        addManagedGitLibraryAtRevision: (...args) => mutate((provider) => provider.addManagedGitLibraryAtRevision(...args)),
        addManagedGitPackageAtRevision: (...args) => mutate((provider) => provider.addManagedGitPackageAtRevision(...args)),
        updateManagedGitSkill: (...args) => mutate((provider) => provider.updateManagedGitSkill(...args)),
        updateManagedGitLibrary: (...args) => mutate((provider) => provider.updateManagedGitLibrary(...args)),
        updateManagedGitPackage: (...args) => mutate((provider) => provider.updateManagedGitPackage(...args)),
        removeManagedGitSkill: (...args) => mutate((provider) => provider.removeManagedGitSkill(...args)),
        removeManagedGitLibrary: (...args) => mutate((provider) => provider.removeManagedGitLibrary(...args)),
        removeManagedGitPackage: (...args) => mutate((provider) => provider.removeManagedGitPackage(...args)),
        buildManagedGitPackage: (...args) => mutate((provider) => provider.buildManagedGitPackage(...args))
      };
    },
    adapter: (context) => createWindowsPiAdapterServices(backend(), context.environment, context.userHome ?? homedir(), options),
    get runtimeOptions() { return { process: options.profileProcess, filesystem: createWindowsProfileGithubEffects(backend(), lifecycleOptions).runtimeFilesystem, recoveryServices: lifecycle() }; },
    profileEditor: { platform: 'win32', resolveExecutable, async targetProof(home, id) { return proveWindowsEditorTarget(backend(), win32.join(home, 'profiles', id), 'AGENTS.md', true); } },
    skillEditor: { platform: 'win32', resolveExecutable, async targetProof(home, id) {
      const native = backend(), skills = platform(), records = createWindowsManagedGitRecordEffects(native), root = win32.join(home, 'skills');
      const assertLocal = async () => { if (await records.optionalManagedGitRecord(home, 'skill', id) !== undefined) throw new BazframeError('MANAGED_GIT_SKILL_EDIT_REFUSED', `Skill ${id} is a remote Git source; edit upstream then run bazframe skill update ${id}.`); };
      await assertLocal();
      const before = await skills.readSkillLink(root, id);
      if (before.kind !== 'current' || win32.basename(before.targetPath) !== id) throw new BazframeError('SKILL_EDITOR_TARGET_CHANGED', 'Added Skill registration is unavailable.');
      const relative = win32.relative(home, before.targetPath);
      if (relative === '' || relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative)) throw new BazframeError('SKILL_EDITOR_SOURCE_READ_ONLY', 'Managed Skill artifacts cannot be edited.');
      const proof = proveWindowsEditorTarget(native, before.targetPath, 'SKILL.md', false);
      return { ...proof, async revalidate() { await assertLocal(); const after = await skills.readSkillLink(root, id); if (JSON.stringify(after) !== JSON.stringify(before)) throw new BazframeError('SKILL_EDITOR_TARGET_CHANGED', 'Added Skill registration changed before launch.'); await proof.revalidate(); } };
    } }
  };
}

/** Used only after the installed extension validates its immutable code-owned binding. */
export function createBoundPiRuntimeServices(options: WindowsApplicationOptions & { environment: NodeJS.ProcessEnv; userHome: string }) {
  const native = (options.backend ?? loadBazframeWin32Native)();
  const application = createWindowsApplicationServices({ ...options, backend: () => native });
  const files = createWindowsOwnedFileServices(native, { ...options, lockComponent: 'state.lock', retainedPrefix: 'pi', authorizeDestination(home, file) {
    return /^adapter-cache\\pi\\skill-aliases\\[a-z0-9]+(?:-[a-z0-9]+)*\\[a-z0-9]+(?:-[a-z0-9]+)*\\SKILL\.md$/u.test(win32.relative(home, file));
  } });
  return createPiRuntimeServices(application, options.environment, {
    async readContext(path) {
      try { return decodeUtf8Instructions((await createWindowsPhysicalReads(native, undefined, {}, true).readFile(path, MAX_EFFECTIVE_INSTRUCTION_BYTES)).bytes, 'Global Pi context', path); }
      catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return undefined; throw error; }
    },
    async writeAlias(path, contents, home) {
      await files.withLock(home, 'Pi collision alias', async (writer) => {
        const expected = await files.snapshot(path, MAX_EFFECTIVE_INSTRUCTION_BYTES);
        await writer.publish(path, Buffer.from(contents), expected, MAX_EFFECTIVE_INSTRUCTION_BYTES);
      });
    }
  }, options.userHome);
}
