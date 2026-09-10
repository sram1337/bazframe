import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readProfileFavorites, toggleProfileFavorite } from '../../../src/profiles/profile-favorites.js';
import { readlink } from 'node:fs/promises';
import { mkdirSync, renameSync, readlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { addProfileSkill } from '../../../src/profiles/profile-skill-membership.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../../../src/skills/added-skill-platform-services.js';
import { createProductionProfileGithubTransportAdapter } from '../../../src/profile-publishing/profile-github-transport.js';
import { publishManagedProfile } from '../../../src/profile-publishing/profile-publication.js';
import { recoverProfilePublishingTransactions } from '../../../src/profile-publishing/profile-recovery.js';
import { createWindowsProfileZipLifecycleDependencies, createWindowsProfileLifecycleServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-lifecycle.js';
import { exportManagedProfile, importManagedProfile, updateManagedProfile, listManagedProfileVersions, useManagedProfileVersion } from '../../../src/profile-publishing/profile-lifecycle.js';
import { useManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { createWindowsProfileActivationServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-activation.js';
import { withProductionProfileLifecycleRuntime } from '../../../src/profile-publishing/profile-runtime.js';
import { parseProfileGithubSource } from '../../../src/profile-publishing/profile-github.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsGitHostFixture } from '../../helpers/windows-git-host-fixture.js';
import { withWindowsManagedGitProvider } from '../../../src/providers/win32-managed-git-services.js';
import { createWindowsReadyResourceServices } from '../../../src/skill-collections/win32-ready-resource-services.js';
import { addProfilePackageReference, addProfileLibraryReference } from '../../../src/profiles/profile-skill-collection-reference-lifecycle.js';
import { addProfile } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { createWindowsProfileDataReads } from '../../../src/profile-publishing/win32-profile-data-reads.js';
import { captureProfile } from '../../../src/profile-publishing/profile-capture.js';
import { createWindowsProfileGithubEffects } from '../../../src/profile-publishing/win32-profile-github-effects.js';
import { publishCanonicalProfileGit, readCanonicalProfileGitVersion } from '../../../src/profile-publishing/profile-github-git.js';
vi.mock('node:fs/promises', async (original) => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, readlink: vi.fn(actual.readlink) }; });
const fixtures: ReturnType<typeof windowsGitHostFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
const HOME = 'C:\\boundary\\home';
describe('Windows shared provider/capture and canonical Git engine with actual local Git', () => {

  it('lets the actual canonical fetch monitor tolerate a disappearing temporary pack leaf', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const windows = createWindowsProfileGithubEffects(f.backend, f.options);
    const parent = await windows.createWorkspaceParent(HOME, 'C:\\boundary', true), isolation = await windows.createIsolation(parent);
    const remote = f.bare('canonical-race'), bytesValue = Buffer.from('canonical\n'), sha256 = createHash('sha256').update(bytesValue).digest('hex');
    const blob = { sha256, bytes: bytesValue.length, bytesValue }, profile = { schemaVersion: 1 as const, kind: 'bazframe-captured-profile' as const, profile: { name: 'canonical', instructions: { path: 'AGENTS.md' as const, sha256, bytes: bytesValue.length, executable: false } }, resources: [], blobs: [{ sha256, bytes: bytesValue.length }] };
    const git = { process: f.profileProcess, isolation, cwd: 'C:\\boundary', quarantineParent: parent, effects: windows.effects, allowFileProtocol: true };
    try {
      await publishCanonicalProfileGit({ ...git, remoteUrl: remote, profile, blobs: [blob], expectedOld: null, repositoryCreated: true });
      const open = windows.effects.inspection.opendir; let leaf = '', disappeared = false, armed = false;
      windows.effects.inspection.opendir = async (...args) => { const stream = await open(...args); if (armed && args[0] === leaf.slice(0, leaf.lastIndexOf('\\'))) { unlinkSync(f.hostPath(leaf)); f.nodes.delete(leaf); armed = false; disappeared = true; } return stream; };
      const process: typeof f.profileProcess = (request) => f.profileProcess({ ...request, monitor: request.monitor === undefined ? undefined : async () => {
        if (request.args.includes('fetch') && !disappeared) { leaf = request.cwd + '\\.git\\objects\\pack\\tmp_pack_test'; writeFileSync(f.hostPath(leaf), 'temporary'); await f.refresh(); armed = true; }
        await request.monitor!();
      } });
      const captured = await readCanonicalProfileGitVersion(remote, undefined, { ...git, process });
      expect(disappeared).toBe(true); expect(captured.blobs).toEqual([blob]);
    } finally { await isolation.dispose(); await windows.runtimeFilesystem.disposeWorkspaceParent(parent); }
  }, 60000);
  it('cancels an absent-home runtime without bootstrap or processes and expires its independent temporary workspace', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\absent';
    const windows = createWindowsProfileGithubEffects(f.backend, f.options);
    const services = createWindowsProfileZipLifecycleDependencies(f.backend, f.options).services!;
    let parent = '';
    await expect(withProductionProfileLifecycleRuntime({ home, environment: { AppData: 'C:\\boundary\\appdata' }, cwd: 'C:\\boundary', mode: 'human', access: 'import', temporaryRoot: 'C:\\boundary', process: f.profileProcess, filesystem: windows.runtimeFilesystem, recoveryServices: services }, async (session) => { parent = session.workspaceParent; expect(session.recovery).toEqual([]); throw new Error('cancelled'); })).rejects.toThrow('cancelled');
    expect(f.nodes.has(home)).toBe(false); expect(f.requests).toEqual([]);
    await expect(windows.effects.writeFile(parent + '\\late', Buffer.alloc(0))).rejects.toThrow(/expired/);
  });
  it('refuses replacement of an owned canonical workspace and does not inherit its broader parent authority after disposal', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const windows = createWindowsProfileGithubEffects(f.backend, f.options);
    const parent = await windows.createOwnedDirectory('C:\\boundary', 'parent-');
    const child = await windows.createOwnedDirectory(parent.path, 'child-'); await child.dispose();
    await expect(windows.effects.writeFile(child.path + '\\late', Buffer.alloc(0))).rejects.toThrow(/expired/);
    const replaced = await windows.createOwnedDirectory(parent.path, 'child-');
    renameSync(f.hostPath(replaced.path), f.hostPath(replaced.path) + '.old'); mkdirSync(f.hostPath(replaced.path)); await f.refresh();
    await expect(windows.effects.writeFile(replaced.path + '\\late', Buffer.alloc(0))).rejects.toThrow(/changed/);
    await expect(replaced.dispose()).rejects.toThrow(/changed/); await parent.dispose();
  });

  it('connects real provider -> references -> canonical publication -> exact remote import/repair/update/version/use -> sidecar recovery', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f);
    vi.mocked(readlink).mockImplementation(async (path) => f.windowsPath(readlinkSync(f.hostPath(String(path)))));
    const source = f.source('library', { 'hello/SKILL.md': '---\nname: hello\ndescription: Fixture\n---\n', 'hello/helper': Buffer.from([255, 0, 13, 10]) }, ['hello/helper']);
    await withWindowsManagedGitProvider(f.backend, HOME, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: HOME }, source.url));
    const skill = f.source('skill', { 'SKILL.md': '---\nname: skill\ndescription: Fixture\n---\n', helper: Buffer.from([255, 0, 1]) }, ['helper']);
    const pkg = f.source('package', { 'bazframe-package.json': JSON.stringify({ schemaVersion: 1, build: ['node', 'build.js'], artifactRoot: 'dist', skillsRoot: '.' }), 'build.js': "require('node:fs').writeFileSync('dist/built/generated', Buffer.from([255,0,13,10]))", 'dist/built/SKILL.md': '---\nname: built\ndescription: Fixture\n---\n', 'dist/built/helper': 'tracked\r\n' }, ['dist/built/helper']);
    await withWindowsManagedGitProvider(f.backend, HOME, f.options, (provider) => provider.addManagedGitSkill({ bazframeHome: HOME }, skill.url));
    await withWindowsManagedGitProvider(f.backend, HOME, f.options, (provider) => provider.addManagedGitPackage({ bazframeHome: HOME, yes: true }, pkg.url));

    await addProfile(HOME, 'portable', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
    await addProfileLibraryReference({ bazframeHome: HOME, services: createWindowsReadyResourceServices(f.backend, f.options) }, 'portable', 'library');
    await addProfilePackageReference({ bazframeHome: HOME, services: createWindowsReadyResourceServices(f.backend, f.options) }, 'portable', 'package');
    await addProfileSkill({ bazframeHome: HOME, platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend, { lockIo: f.io, membershipIo: f.options.membershipIo }) }, 'portable', 'skill');

    const options = { ...f.options, journal: { io: f.io }, managedGit: f.options };
    const windows = createWindowsProfileGithubEffects(f.backend, options), parent = await windows.createWorkspaceParent(HOME, undefined, false);
    const isolation = await windows.createIsolation(parent, {}, 'C:\\boundary\\gh');
    const github = f.github('owner/portable');
    const adapter = createProductionProfileGithubTransportAdapter({ process: github.process, isolation, cwd: HOME, quarantineParent: parent, authenticated: true, effects: windows.effects });
    try {
      const sourceServices = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, options);
      const first = await publishManagedProfile({ home: HOME, profileName: 'portable', yes: true }, adapter, sourceServices);
      expect(first.effects.profilePublished).toBe(true);
      const destination = 'C:\\boundary\\installed';
      const healthyProcess = f.options.process!;
      f.options.process = async (...args) => args[1].includes('clone') ? { status: null, stdout: '', stderr: '', failure: 'timeout', uncertainTermination: true } : healthyProcess(...args);
      const uncertainHome = 'C:\\boundary\\uncertain-install';
      await expect(importManagedProfile({ home: uncertainHome, source: { kind: 'git', value: 'git:owner/portable' }, yes: true }, { ...createWindowsProfileZipLifecycleDependencies(f.backend, options), git: adapter })).rejects.toThrow();
      expect(f.nodes.has(uncertainHome + '\\profiles\\portable')).toBe(false);

      f.options.process = async (...args) => args[1].includes('clone') ? { status: 1, stdout: '', stderr: 'fatal: Could not resolve host: example.test\n' } : healthyProcess(...args);
      const dependencies = { ...createWindowsProfileZipLifecycleDependencies(f.backend, options), git: adapter };
      await importManagedProfile({ home: destination, source: { kind: 'git', value: 'git:owner/portable' }, yes: true }, dependencies);
      const missing = await dependencies.services!.readManagedState(destination, 'portable');
      expect(missing!.state.importedResources).toHaveLength(3);
      expect(missing!.state.importedResources.every((resource) => resource.source.kind === 'missingRemoteGit')).toBe(true);
      f.options.process = healthyProcess;
      expect(await updateManagedProfile({ home: destination, profileName: 'portable', yes: true }, dependencies)).toMatchObject({ action: 'updated' });
      const installed = await dependencies.services!.readManagedState(destination, 'portable');
      expect(installed!.state.importedResources.every((resource) => resource.source.kind === 'remoteGit')).toBe(true);
      const favorites = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, options);
      await toggleProfileFavorite(destination, 'portable', { services: favorites });
      const exported = await captureProfile({ bazframeHome: destination, profileId: 'portable', bundleRemote: true }, createWindowsProfileDataReads(f.backend, undefined, f.options).captureDependencies);
      for (const [kind, path, executable] of [['skill', 'helper', true], ['library', 'hello/helper', true], ['package', 'built/helper', true], ['package', 'built/generated', false]] as const) {
        const payload = exported.profile.resources.find((resource) => resource.key.kind === kind)!.payload;
        expect(payload.kind === 'bundled' && payload.files.find((file) => file.path === path)?.executable).toBe(executable);
      }
      const payload = exported.profile.resources.find((resource) => resource.key.kind === 'library')!.payload;
      expect(payload.kind === 'bundled' && payload.files.find((file) => file.path === 'hello/helper')?.executable).toBe(true);
      await useManagedProfile(destination, 'portable', createWindowsProfileActivationServicesForInternalTesting(f.backend, { selectionIo: f.io, lockIo: f.io, journal: { io: f.io } }));
      await f.io.writeExistingFile(HOME + '\\profiles\\portable\\AGENTS.md', Buffer.from('second version\r\n'));
      writeFileSync(join(source.path, 'hello', 'next'), 'next revision'); source.git('add', '.'); source.git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-m', 'second resource revision');
      await withWindowsManagedGitProvider(f.backend, HOME, f.options, (provider) => provider.updateManagedGitLibrary({ bazframeHome: HOME }, 'library'));

      await publishManagedProfile({ home: HOME, profileName: 'portable', yes: true }, adapter, sourceServices);
      const before = (await dependencies.services!.readManagedState(destination, 'portable'))!.state;
      const oldRoot = f.backend.inspectPath(destination + '\\profiles\\portable').object.fileId;
      f.options.process = async (...args) => args[1].includes('clone') ? { status: 1, stdout: '', stderr: 'fatal: Could not resolve host: example.test\n' } : healthyProcess(...args);
      await expect(updateManagedProfile({ home: destination, yes: true }, dependencies)).rejects.toThrow();
      expect((await dependencies.services!.readManagedState(destination, 'portable'))!.state).toEqual(before);
      expect(f.backend.inspectPath(destination + '\\profiles\\portable').object.fileId).toBe(oldRoot);
      f.options.process = healthyProcess;
      await recoverProfilePublishingTransactions(destination, adapter, dependencies.services);

      await updateManagedProfile({ home: destination, yes: true }, dependencies);
      const versions = await listManagedProfileVersions(destination, undefined, dependencies);
      expect(versions).toHaveLength(2);
      await useManagedProfileVersion({ home: destination, revision: versions[1]!.commit, yes: true }, dependencies);
      const after = (await dependencies.services!.readManagedState(destination, 'portable'))!.state;
      expect(after.profileInstanceId).toBe(before.profileInstanceId);
      expect(after.importedResources.map((resource) => resource.instanceId)).toEqual(before.importedResources.map((resource) => resource.instanceId));
      expect((await dependencies.services!.readSelection(destination))?.profileId).toBe('portable');
      await updateManagedProfile({ home: destination, yes: true }, dependencies);
      const root = destination + '\\profiles\\portable', identity = f.backend.inspectPath(root).object.fileId;
      const service = dependencies.services!, write = service.writeJournal;
      let interrupted = false;
      service.writeJournal = async (home, authority, journal) => { if (journal.kind === 'publication' && journal.phase === 'LOCAL_STATE_PROVEN' && !interrupted) { interrupted = true; throw new Error('after sidecar CAS'); } return write(home, authority, journal); };
      await expect(publishManagedProfile({ home: destination, profileName: 'portable', yes: true }, adapter, service)).rejects.toThrow('after sidecar CAS');
      expect((await recoverProfilePublishingTransactions(destination, adapter, service)).some((result) => result.action === 'committed')).toBe(true);
      expect(f.backend.inspectPath(root).object.fileId).toBe(identity);
      expect((await service.readSelection(destination))?.profileId).toBe('portable');
      expect((await readProfileFavorites(destination, favorites)).favorites).toEqual(['portable']);
      const absent = 'C:\\boundary\\never-created';
      await withProductionProfileLifecycleRuntime({ home: absent, environment: { AppData: 'C:\\boundary\\appdata' }, cwd: 'C:\\boundary', mode: 'human', readOnly: true, access: 'public-read', temporaryRoot: 'C:\\boundary', process: f.profileProcess, filesystem: windows.runtimeFilesystem }, async (session) => {
        expect(await session.lifecycle.git.list(parseProfileGithubSource('git:owner/portable'))).toHaveLength(3);
        expect(session.recovery).toEqual([]);
      });
      expect(f.nodes.has(absent)).toBe(false);
      expect(f.requests.some((request) => request.executable === 'gh' && request.args.includes('login'))).toBe(false);
    } finally { await isolation.dispose(); }
  }, 240000);

  it('transports exact binary and executable resource bytes without injecting provider, capture or Git success', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f);
    const source = f.source('library', { 'hello/SKILL.md': '---\nname: hello\ndescription: Fixture\n---\nCRLF\r\n', 'hello/helper': Buffer.from([0, 255, 0, 10]) }, ['hello/helper']);
    await withWindowsManagedGitProvider(f.backend, HOME, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: HOME }, source.url));
    await addProfile(HOME, 'portable', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
    await addProfileLibraryReference({ bazframeHome: HOME, services: createWindowsReadyResourceServices(f.backend, f.options) }, 'portable', 'library');
    const captured = await captureProfile({ bazframeHome: HOME, profileId: 'portable', bundleRemote: true }, createWindowsProfileDataReads(f.backend, undefined, f.options).captureDependencies);
    const payload = captured.profile.resources[0]!.payload;
    expect(payload.kind).toBe('bundled');
    if (payload.kind !== 'bundled') throw new Error('not bundled');
    expect(payload.files.find((file) => file.path === 'hello/helper')?.executable).toBe(true);
    const helper = payload.files.find((file) => file.path === 'hello/helper')!;
    expect(captured.blobs.find((blob) => blob.sha256 === helper.sha256)?.bytesValue).toEqual(Buffer.from([0, 255, 0, 10]));
    const windows = createWindowsProfileGithubEffects(f.backend, f.options);
    const parent = await windows.createWorkspaceParent(HOME, undefined, false);
    const isolation = await windows.createIsolation(parent);
    const remote = f.bare('portable');
    const git = { process: f.profileProcess, isolation, cwd: HOME, quarantineParent: parent, effects: windows.effects, allowFileProtocol: true };
    try {
      const published = await publishCanonicalProfileGit({ ...git, remoteUrl: remote, profile: captured.profile, blobs: captured.blobs, expectedOld: null, repositoryCreated: true });
      const read = await readCanonicalProfileGitVersion(remote, undefined, git);
      expect(read.commit).toBe(published.commit); expect(read.manifestBytes).toEqual(captured.manifestBytes);
      expect(read.blobs).toEqual(captured.blobs);
      expect(read.profile.resources).toEqual(captured.profile.resources);
      const zip = createWindowsProfileZipLifecycleDependencies(f.backend, { ...f.options, managedGit: f.options, journal: { io: f.io }, zip: { io: f.zipIo, temporaryRoot: 'C:\\boundary' } });
      const archive = 'C:\\boundary\\managed.zip', installed = 'C:\\boundary\\zip-installed';
      await exportManagedProfile({ home: HOME, profileName: 'portable', outputPath: archive, bundleRemote: true }, zip);
      await importManagedProfile({ home: installed, source: { kind: 'zip', path: archive } }, zip);
      const roundTrip = await captureProfile({ bazframeHome: installed, profileId: 'portable', bundleRemote: true }, createWindowsProfileDataReads(f.backend, undefined, f.options).captureDependencies);
      const roundTripPayload = roundTrip.profile.resources[0]!.payload;
      expect(roundTripPayload.kind === 'bundled' && roundTripPayload.files).toEqual(payload.files);
      expect(roundTrip.blobs).toEqual(captured.blobs);

    } finally { await isolation.dispose(); }
  }, 60000);
});
