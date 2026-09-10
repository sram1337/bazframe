import { tmpdir } from 'node:os';
import { withWindowsManagedGitProvider } from '../providers/win32-managed-git-services.js';
import { createWindowsProfileDataReads } from './win32-profile-data-reads.js';
import { createWindowsProfileStorage } from './win32-profile-storage.js';
import type { ProfileRemoteMaterializationServices } from './profile-remote-materializer.js';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { BazframeError } from '../core/errors.js';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend } from '../core/win32-native.js';
import { executableEnvironmentValue } from '../core/executable-resolution.js';
import { sameResourceIdentity } from '../skill-collections/resource-identity.js';
import { admitWindowsNamespaceDirectory, admitWindowsPrivateDirectory, createWindowsPrivateDirectory, ensureWindowsPrivateDirectoryPath, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { createWindowsManagedGitRecordEffects, windowsResourceIdentity } from '../providers/managed-git-services.js';
import { createWindowsGitInspectionEffects } from '../providers/win32-managed-git-services.js';
import { createWindowsPhysicalReads } from './win32-physical-profile-reads.js';
import { writeWindowsProfileFile } from './win32-profile-storage.js';
import type { WindowsProfileLifecycleOptions } from './win32-profile-lifecycle.js';
import type { ProfileGithubGitEffects } from './profile-github-git.js';
import type { OwnedProfileGithubDirectory, ProfileGithubDirectoryProof, ProfileGithubIsolation, ProfileGithubDisposalResult } from './profile-github-process.js';

/** Private I/O beneath the existing canonical Git engine; no remote/commit/lease policy here. */
export function createWindowsProfileGithubEffects(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsProfileLifecycleOptions = {}) {
  const owned = new Map<string, { assertHeld(): void }>();
  const temporaryParents = new Map<string, OwnedProfileGithubDirectory>();
  function proof(path: string, namespace = false): Exclude<ProfileGithubDirectoryProof, { handle: unknown }> {
    const admit = namespace ? admitWindowsNamespaceDirectory : admitWindowsPrivateDirectory;
    const before = admit(backend, path); let closed = false;
    return { path, async assertIdentity() {
      if (closed) throw refused('expired owned directory');
      const current = admit(backend, path);
      if (!sameResourceIdentity(windowsResourceIdentity(before), windowsResourceIdentity(current)) || JSON.stringify(before.security) !== JSON.stringify(current.security) || before.object.attributes !== current.object.attributes) throw refused('retained directory identity changed');
    }, async close() { closed = true; } };
  }
  async function createOwnedDirectory(parentPath: string, prefix: string): Promise<OwnedProfileGithubDirectory> {
    if (!/^[a-z0-9-]+$/u.test(prefix)) throw refused('invalid workspace prefix');
    const parent = proof(parentPath, true);
    const name = `${prefix}${randomBytes(16).toString('hex')}`;
    if (!isValidWindowsPathComponent(name)) throw refused('invalid owned directory component');
    await parent.assertIdentity(); createWindowsPrivateDirectory(backend, parentPath, name);
    const path = win32.join(parentPath, name), directory = proof(path);
    let live = true, disposal: Promise<ProfileGithubDisposalResult> | undefined;
    const original = admitWindowsPrivateDirectory(backend, path), originalParent = admitWindowsNamespaceDirectory(backend, parentPath);
    owned.set(path, { assertHeld() {
      if (!live) throw refused('expired workspace authority');
      for (const [before, after] of [[original, admitWindowsPrivateDirectory(backend, path)], [originalParent, admitWindowsNamespaceDirectory(backend, parentPath)]] as const) if (!sameResourceIdentity(windowsResourceIdentity(before), windowsResourceIdentity(after)) || JSON.stringify(before.security) !== JSON.stringify(after.security) || before.object.attributes !== after.object.attributes) throw refused('owned workspace root or parent changed');
    } });
    await parent.assertIdentity(); await directory.assertIdentity();
    return { path, directory, parent, dispose() {
      disposal ??= (async () => { try { await parent.assertIdentity(); await directory.assertIdentity(); return { disposition: 'retained' as const, identityProved: true as const }; } finally { live = false; await directory.close(); await parent.close(); } })();
      return disposal;
    } };
  }
  function authority(path: string) {
    const entry = [...owned].filter(([root]) => within(root, path)).sort(([a], [b]) => b.length - a.length)[0];
    if (entry === undefined) throw refused('path outside owned workspace'); entry[1].assertHeld(); return entry[1];
  }
  const records = createWindowsManagedGitRecordEffects(backend, options);
  const effects: ProfileGithubGitEffects = {
    join: win32.join, createOwnedDirectory, inspection: createWindowsGitInspectionEffects(backend), physical: createWindowsPhysicalReads(backend),
    async openDirectory(path, root) { if (!within(root, path)) throw refused('directory outside trusted workspace'); authority(path).assertHeld(); return proof(path); },
    async createDirectory(path) { const held = authority(path); held.assertHeld(); createWindowsPrivateDirectory(backend, win32.dirname(path), win32.basename(path)); held.assertHeld(); },
    async writeFile(path, bytes) { const held = authority(path); held.assertHeld(); await writeWindowsProfileFile(backend, path, bytes, options.storageIo); held.assertHeld(); },
    async detachConfig(workspace) {
      const path = win32.join(workspace.path, '.git', 'config'), held = authority(path);
      const scoped = createWindowsManagedGitRecordEffects(backend, options, held);
      if (!await records.absent(path)) { const before = await records.snapshot(path); await scoped.detach(path, { ...windowsResourceIdentity(before.inspection), sha256: before.sha256 }); }
      held.assertHeld(); if (!await records.absent(path)) throw refused('local Git config remains occupied');
    },
    async assertAbsent(path, label) { if (!await records.absent(path)) throw refused(`${label} is forbidden`); }
  };
  async function createIsolation(parent: string, inherited: NodeJS.ProcessEnv = process.env, ghConfigDirectory?: string): Promise<ProfileGithubIsolation> {
    const workspace = await createOwnedDirectory(parent, 'bazframe-profile-github-');
    const root = workspace.path;
    const home = win32.join(root, 'home'), xdgConfigHome = win32.join(root, 'xdg'), hooksDirectory = win32.join(root, 'hooks'), globalConfigFile = win32.join(root, 'gitconfig');
    try {
      for (const path of [home, xdgConfigHome, hooksDirectory]) await effects.createDirectory(path);
      await effects.writeFile(globalConfigFile, Buffer.alloc(0));
      const environment: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) { const value = executableEnvironmentValue(inherited, key, true); if (value !== undefined) environment[key] = value; }
      Object.assign(environment, { LANG: 'C', LC_ALL: 'C', HOME: home, XDG_CONFIG_HOME: xdgConfigHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfigFile, GIT_CONFIG_SYSTEM: globalConfigFile, GIT_GRAFT_FILE: globalConfigFile, GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' });
      if (ghConfigDirectory !== undefined) environment.GH_CONFIG_DIR = ghConfigDirectory;
      return { root, home, xdgConfigHome, hooksDirectory, globalConfigFile, environment: Object.freeze(environment), directory: workspace.directory, dispose: workspace.dispose };
    } catch (error) { try { await workspace.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Windows Git isolation and retained ownership proof both failed.', { cause: cleanup }); } throw error; }
  }
  async function createWorkspaceParent(home: string, temporaryRoot: string | undefined, temporary: boolean): Promise<string> {
    if (temporary || await records.absent(home)) {
      const parent = await createOwnedDirectory(temporaryRoot ?? tmpdir(), 'bazframe-profile-dry-run-');
      temporaryParents.set(parent.path, parent); return parent.path;
    }
    const root = win32.join(home, 'profile-publishing', 'github-workspaces');
    ensureWindowsPrivateDirectoryPath(backend, root); return root;
  }
  const storage = createWindowsProfileStorage(backend, options.storageIo);
  const remoteServices: ProfileRemoteMaterializationServices = {
    joinPath: win32.join,
    async ensureDirectory(home, path) { if (!within(home, path)) throw refused('remote materialization path outside home'); ensureWindowsPrivateDirectoryPath(backend, path); },
    writeFile: (path, text) => effects.writeFile(path, Buffer.from(text)),
    createOwnedDirectory,
    async directoryIdentity(path) { return windowsResourceIdentity(admitWindowsPrivateDirectory(backend, path)); },
    captureDependencies: createWindowsProfileDataReads(backend, undefined, options.managedGit).captureDependencies,
    publishBlob: storage.publishBlob, publishTree: storage.publishTree,
    withProvider: (home, operation) => withWindowsManagedGitProvider(backend, home, { ...options, ...options.managedGit }, operation)
  };
  return { effects, createIsolation, createWorkspaceParent, createOwnedDirectory, remoteServices, runtimeFilesystem: { platform: 'win32' as const, homeExists: async (home: string) => !await records.absent(home), joinPath: win32.join, createWorkspaceParent, async disposeWorkspaceParent(path: string) { const parent = temporaryParents.get(path); if (parent !== undefined) { await parent.dispose(); temporaryParents.delete(path); } }, createIsolation, gitEffects: effects } };
}
function within(root: string, child: string): boolean { const relative = win32.relative(root, child); return relative !== '..' && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative); }
function refused(detail: string): BazframeError { return new BazframeError('WINDOWS_PROFILE_GIT_REFUSED', `Windows private Git effects refused: ${detail}.`); }
