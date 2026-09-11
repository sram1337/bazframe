import { execFileSync } from 'node:child_process';
import { createWindowsProfileActivationServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-activation.js';
import { useManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { readlink } from 'node:fs/promises';
import { mkdirSync, readFileSync, renameSync, unlinkSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addProfile } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { addProfileSkill, removeProfileSkill } from '../../../src/profiles/profile-skill-membership.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../../../src/skills/added-skill-platform-services.js';
import { createWindowsProfileDataReads } from '../../../src/profile-publishing/win32-profile-data-reads.js';
import { captureCatalogResource, captureProfile } from '../../../src/profile-publishing/profile-capture.js';
import { readProfileSystemView } from '../../../src/profile-publishing/profile-view.js';
import { createWindowsReadyResourceServices } from '../../../src/skill-collections/win32-ready-resource-services.js';
import { addProfileLibraryReference, removeProfileLibraryReference, addProfilePackageReference, removeProfilePackageReference } from '../../../src/profiles/profile-skill-collection-reference-lifecycle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsGitHostFixture } from '../../helpers/windows-git-host-fixture.js';
import { createWindowsManagedGitServices, withWindowsManagedGitProvider } from '../../../src/providers/win32-managed-git-services.js';
import { createManagedGitProvider } from '../../../src/providers/managed-git.js';
vi.mock('node:fs/promises', async (original) => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, readlink: vi.fn(actual.readlink) }; });
const fixtures: ReturnType<typeof windowsGitHostFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
describe('actual shared provider with Windows effects and real host Git', () => {



  it.each(['skill', 'library'] as const)('preserves built-in EOL worktree bytes and Git executable modes through actual %s acquisition, health and bundled capture', async (kind) => {
    const f = windowsGitHostFixture(); fixtures.push(f);
    vi.mocked(readlink).mockImplementation(async (path) => f.windowsPath(readlinkSync(f.hostPath(String(path)))));
    const home = 'C:\\boundary\\home', path = kind === 'skill' ? 'SKILL.md' : 'hello/SKILL.md';
    const lf = `---\nname: ${kind === 'skill' ? 'skill' : 'hello'}\ndescription: EOL fixture\n---\nReady bytes\n`;
    const crlf = Buffer.from(lf.replaceAll('\n', '\r\n'));
    const source = f.source(kind, { '.gitattributes': '*.md text eol=crlf\n', [path]: lf }, [path]);
    const added = await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => kind === 'skill'
      ? provider.addManagedGitSkill({ bazframeHome: home }, source.url)
      : provider.addManagedGitLibrary({ bazframeHome: home }, source.url));
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', f.hostPath(added.root), ...args]);
    expect(git('show', `HEAD:${path}`)).toEqual(Buffer.from(lf));
    expect(readFileSync(join(f.hostPath(added.root), path))).toEqual(crlf);
    expect(git('status', '--porcelain').toString()).toBe('');
    expect(git('ls-files', '--stage', path).toString()).toMatch(/^100755 /);
    await createManagedGitProvider(createWindowsManagedGitServices(f.backend, home, f.options)).captureManagedGitExportHealth(home, kind, kind);
    const dependencies = createWindowsProfileDataReads(f.backend, undefined, f.options).captureDependencies;
    const catalog = await captureCatalogResource({ bazframeHome: home, kind, name: kind, capturedResourceId: 'a'.repeat(64), bundleRemote: true }, dependencies);
    await addProfile(home, 'work', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
    if (kind === 'skill') await addProfileSkill({ bazframeHome: home, platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend, { lockIo: f.io, membershipIo: f.options.membershipIo }) }, 'work', kind);
    else await addProfileLibraryReference({ bazframeHome: home, services: createWindowsReadyResourceServices(f.backend, f.options) }, 'work', kind);
    const profile = await captureProfile({ bazframeHome: home, profileId: 'work', bundleRemote: true }, dependencies);
    for (const captured of [{ resource: catalog.resource, blobs: catalog.blobs }, { resource: profile.profile.resources[0]!, blobs: profile.blobs }]) {
      const payload = captured.resource.payload;
      if (payload.kind !== 'bundled') throw new Error('not bundled');
      const file = payload.files.find((file) => file.path === path)!;
      expect(file.executable).toBe(true);
      expect(captured.blobs.find((blob) => blob.sha256 === file.sha256)?.bytesValue).toEqual(crlf);
    }
    expect(git('status', '--porcelain').toString()).toBe('');
  }, 90000);

  it.each(['catalog', 'profile'])('uses the copied request-only helper environment through both %s Skill-mode capture passes', async (kind) => {
    const f = windowsGitHostFixture(); fixtures.push(f); vi.mocked(readlink).mockImplementation(async (path) => f.windowsPath(readlinkSync(f.hostPath(String(path))))); const home = 'C:\\boundary\\home';
    const source = f.source('skill', { 'SKILL.md': '---\nname: skill\ndescription: Fixture\n---\n', helper: Buffer.from([255,0,13,10]) }, ['helper']);
    await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitSkill({ bazframeHome: home }, source.url));
    if (kind === 'profile') { await addProfile(home, 'work', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) }); await addProfileSkill({ bazframeHome: home, platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend, { lockIo: f.io, membershipIo: f.options.membershipIo }) }, 'work', 'skill'); }
    const environment = { BAZFRAME_GIT_COMMAND: 'selected-git.exe' }, selections: string[] = []; let passes = 0;
    f.options.resolveExecutable = async (command) => { selections.push(command); await Promise.resolve(); environment.BAZFRAME_GIT_COMMAND = 'wrong-helper.exe'; if (!['selected-git.exe', '/usr/bin/git'].includes(command)) throw new Error('WRONG HELPER ' + command); return '/usr/bin/git'; };
    const dependencies = { ...createWindowsProfileDataReads(f.backend, undefined, f.options).captureDependencies, testHooks: { afterPass() { passes++; } } };
    if (kind === 'catalog') await captureCatalogResource({ bazframeHome: home, kind: 'skill', name: 'skill', capturedResourceId: 'a'.repeat(64), bundleRemote: true, environment }, dependencies);
    else await captureProfile({ bazframeHome: home, profileId: 'work', bundleRemote: true, environment }, dependencies);
    expect(passes).toBe(2); expect(selections.filter((command) => command === 'selected-git.exe').length).toBeGreaterThanOrEqual(2); expect(f.options.environment).toBeUndefined();
  }, 90000);
  it('does not let a returned provider or stateLockHeld boolean outlive real operation/state authority', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const provider = await withWindowsManagedGitProvider(f.backend, home, f.options, async (provider) => provider);
    const before = [...f.nodes.keys()], options = { bazframeHome: home, stateLockHeld: true };
    await expect(provider.addManagedGitLibrary(options, 'https://example.test/owner/library.git')).rejects.toThrow(/authority|active/i);
    expect([...f.nodes.keys()]).toEqual(before); expect(f.requests).toEqual([]);
  });
  it('classifies an absent home without bootstrapping, processes, authentication, or recovery', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\absent', before = [...f.nodes.keys()];
    const provider = createManagedGitProvider(createWindowsManagedGitServices(f.backend, home, f.options));
    expect(await provider.classifyManagedGitProviderOccupancy(home, 'library', 'library')).toBe('absent');
    expect(await provider.classifyManagedGitImportResource(home, 'library', 'library', { remote: 'example.test/owner/library', fetchUrl: 'https://example.test/owner/library.git', branch: 'main', revision: 'a'.repeat(40) })).toMatchObject({ action: 'create' });
    expect([...f.nodes.keys()]).toEqual(before); expect(f.requests).toEqual([]);
  });
  it.each(['decline', 'manifest', 'root'])('does not execute a managed package build after %s at adjacent authorization', async (change) => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const source = f.source('package', { 'bazframe-package.json': JSON.stringify({ schemaVersion: 1, build: ['node', 'build.js'], artifactRoot: 'dist', skillsRoot: '.' }), 'build.js': '', 'dist/built/SKILL.md': '---\nname: built\ndescription: Fixture\n---\n' });
    let spawns = 0; const runner = f.options.packageProcessRunner!; f.options.packageProcessRunner = (...args) => { spawns++; return runner(...args); };
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitPackage({ bazframeHome: home, confirmPackageBuild: () => change !== 'decline', beforePackageBuild: async (context) => { const root = f.hostPath(context.rootIdentity.root); if (change === 'manifest') writeFileSync(join(root, 'bazframe-package.json'), '{}'); if (change === 'root') { renameSync(root, root + '.replaced'); mkdirSync(root); } await f.refresh(); } }, source.url))).rejects.toThrow();
    expect(spawns).toBe(0); expect(f.nodes.has(home + '\\packages\\package.json')).toBe(false);
  }, 90000);
  it.each(['dirty', 'hidden-index', 'origin', 'branch', 'registration'])('real offline export health refuses %s using shared diagnostics', async (change) => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const source = f.source('library', { 'hello/SKILL.md': '---\nname: hello\ndescription: Fixture\n---\n' });
    const added = await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: home }, source.url));
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', f.hostPath(added.root), ...args], { encoding: 'utf8' });
    if (change === 'dirty') writeFileSync(join(f.hostPath(added.root), 'hello', 'SKILL.md'), 'changed');
    if (change === 'hidden-index') git('update-index', '--assume-unchanged', 'hello/SKILL.md');
    if (change === 'origin') git('remote', 'set-url', 'origin', 'https://example.test/other/repository.git');
    if (change === 'branch') git('update-ref', '-d', 'refs/remotes/origin/main');
    if (change === 'registration') unlinkSync(f.hostPath(home + '\\libraries\\library.json'));
    await f.refresh(); const count = f.requests.length;
    await expect(createManagedGitProvider(createWindowsManagedGitServices(f.backend, home, f.options)).captureManagedGitExportHealth(home, 'library', 'library')).rejects.toThrow();
    expect(f.requests.slice(count).some((request) => request.args.some((arg) => ['clone', 'fetch', 'login', 'reset', 'clean'].includes(arg)))).toBe(false);
  }, 90000);
  it.each(['120000', '160000'])('refuses real Git mode %s before Windows checkout can disguise it', async (mode) => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const source = f.source('library', { 'hello/SKILL.md': '---\nname: hello\ndescription: Fixture\n---\n' });
    const object = mode === '120000' ? source.git('rev-parse', 'HEAD:hello/SKILL.md').trim() : source.revision;
    source.git('update-index', '--add', '--cacheinfo', mode, object, 'unsupported'); source.git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-m', 'unsupported');
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: home }, source.url))).rejects.toMatchObject({ code: 'MANAGED_GIT_TREE_INVALID' });
    expect(f.requests.some((request) => request.args.includes('checkout'))).toBe(false); expect(f.nodes.has(home + '\\libraries\\library.json')).toBe(false);
  }, 90000);
  it('rejects real index-mode drift and stale planned reuse without implicit acquisition', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const source = f.source('library', { 'hello/SKILL.md': '---\nname: hello\ndescription: Fixture\n---\n', 'hello/helper': Buffer.from([255,0,1]) }, ['hello/helper']);
    const added = await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: home }, source.url));
    const health = await createManagedGitProvider(createWindowsManagedGitServices(f.backend, home, f.options)).captureManagedGitExportHealth(home, 'library', 'library');
    const run = f.options.process!; let drifted = false;
    f.options.process = async (...args) => { const value = await run(...args); if (!drifted && args[1].includes('ls-tree')) { drifted = true; execFileSync('/usr/bin/git', ['-C', f.hostPath(added.root), 'update-index', '--chmod=-x', 'hello/helper']); await f.refresh(); } return value; };
    await expect(createManagedGitProvider(createWindowsManagedGitServices(f.backend, home, f.options)).captureManagedGitExportHealth(home, 'library', 'library')).rejects.toThrow();
    f.options.process = run; const count = f.requests.length;
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibraryAtRevision({ bazframeHome: home }, 'library', { remote: 'example.test/owner/library', fetchUrl: source.url, branch: 'main', revision: source.revision }, { mode: 'must-reuse', expectedHealth: health }))).rejects.toThrow();
    expect(f.requests.slice(count).some((request) => request.args.includes('clone') || request.args.includes('fetch'))).toBe(false);
  }, 90000);

  it('does not run metadata with contaminated reusable private isolation', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const source = f.source('library', { 'hello/SKILL.md': '---\nname: hello\ndescription: Fixture\n---\n' });
    await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: home }, source.url));
    writeFileSync(f.hostPath(home + '\\providers\\git\\isolation\\hooks\\post-checkout'), 'untrusted'); await f.refresh(); const count = f.requests.length;
    await expect(createManagedGitProvider(createWindowsManagedGitServices(f.backend, home, f.options)).verifyManagedGitResource(home, 'library', 'library')).rejects.toThrow();
    expect(f.requests).toHaveLength(count);
  }, 90000);
  it('uses the healthy immutable library snapshot when its mutable Git source is missing', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const source = f.source('library', { 'hello/SKILL.md': '---\nname: hello\ndescription: Fixture\n---\n' });
    const added = await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: home }, source.url));
    await addProfile(home, 'work', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
    await addProfileLibraryReference({ bazframeHome: home, services: createWindowsReadyResourceServices(f.backend, f.options) }, 'work', 'library');
    renameSync(f.hostPath(added.root), f.hostPath(added.root) + '.unavailable'); await f.refresh(); const count = f.requests.length;
    await readProfileSystemView(home, createWindowsProfileDataReads(f.backend).viewReads);
    expect(await useManagedProfile(home, 'work', createWindowsProfileActivationServicesForInternalTesting(f.backend, { selectionIo: f.io, lockIo: f.io, journal: { io: f.io } }))).toMatchObject({ profile: { name: 'work' } });
    expect(f.requests).toHaveLength(count);
  }, 90000);
  it.each(['git', '.\\tools\\git.exe'])('canonicalizes the lower-case Windows override %s without manufacturing conflicts on repeated resolution', async (entered) => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const source = f.source('library', { 'child/SKILL.md': '---\nname: child\ndescription: Fixture\n---\n' });
    const selections: string[] = [];
    f.options.resolveExecutable = async (command) => { selections.push(command); return '/usr/bin/git'; };
    const environment = { bazframe_git_command: entered };
    await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: home, environment }, source.url));
    await createManagedGitProvider(createWindowsManagedGitServices(f.backend, home, f.options)).verifyManagedGitResource(home, 'library', 'library', environment);
    expect(selections.filter((command) => command === entered)).toHaveLength(2);
    expect(selections.filter((command) => command !== entered).every((command) => command === '/usr/bin/git')).toBe(true);
    expect(environment).toEqual({ bazframe_git_command: entered });
  }, 90000);

  it('adds a managed Skill, captures its exact modes, updates its stable membership target and logically removes it', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); vi.mocked(readlink).mockImplementation(async (path) => f.windowsPath(readlinkSync(f.hostPath(String(path))))); const home = 'C:\\boundary\\home';
    const source = f.source('skill', { 'SKILL.md': '---\nname: skill\ndescription: Fixture\n---\n', helper: Buffer.from([255, 0, 13, 10]) }, ['helper']);
    const added = await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitSkill({ bazframeHome: home }, source.url));
    await addProfile(home, 'work', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
    const membership = { bazframeHome: home, platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend, { lockIo: f.io, membershipIo: f.options.membershipIo }) };
    await addProfileSkill(membership, 'work', 'skill');
    const link = f.backend.inspectMembershipLink(home + '\\profiles\\work\\skills\\skill').object.fileId;
    const captured = await captureProfile({ bazframeHome: home, profileId: 'work', bundleRemote: true }, createWindowsProfileDataReads(f.backend, undefined, f.options).captureDependencies);
    const payload = captured.profile.resources[0]!.payload;
    expect(payload.kind === 'bundled' && payload.files.find((file) => file.path === 'helper')?.executable).toBe(true);
    writeFileSync(join(source.path, 'other'), 'next'); source.git('add', 'other'); source.git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-m', 'next');
    expect(await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.updateManagedGitSkill({ bazframeHome: home }, 'skill'))).toMatchObject({ action: 'updated', root: added.root });
    expect(f.backend.inspectMembershipLink(home + '\\profiles\\work\\skills\\skill').object.fileId).toBe(link);
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.removeManagedGitSkill({ bazframeHome: home }, 'skill'))).rejects.toThrow();
    await removeProfileSkill(membership, 'work', 'skill');
    expect(await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.removeManagedGitSkill({ bazframeHome: home }, 'skill'))).toMatchObject({ action: 'removed' });
    expect(f.nodes.has(added.root)).toBe(false);
    expect([...f.nodes].some(([path, node]) => path.includes('retained-') && path.endsWith('\\helper') && node.bytes?.equals(Buffer.from([255, 0, 13, 10])))).toBe(true);
  }, 90000);
  it('executes a repository-owned package fixture after adjacent consent and keeps immutable artifacts through failed and uncertain rebuilds', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); vi.mocked(readlink).mockImplementation(async (path) => f.windowsPath(readlinkSync(f.hostPath(String(path))))); const home = 'C:\\boundary\\home';
    const manifest = { schemaVersion: 1, build: ['node', 'build.js', '%PATH% & literal'], artifactRoot: 'dist', skillsRoot: '.' };
    const source = f.source('package', {
      'bazframe-package.json': JSON.stringify(manifest),
      'build.js': `const fs=require('node:fs'); if(process.argv[2]!=='%PATH% & literal')process.exit(8); fs.writeFileSync('dist/built/generated.bin', Buffer.from([255,0,10])); if(process.env.BAZFRAME_FIXTURE_FAIL)process.exit(7);`,
      'dist/built/SKILL.md': '---\nname: built\ndescription: Fixture\n---\n', 'dist/built/helper': 'tracked\r\n'
    }, ['dist/built/helper']);
    const events: string[] = [], runner = f.options.packageProcessRunner!;
    f.options.packageProcessRunner = async (...args) => { events.push('spawn'); return runner(...args); };
    await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitPackage({ bazframeHome: home, reportPackageBuild() { events.push('report'); }, confirmPackageBuild() { events.push('consent'); return true; }, beforePackageBuild() { events.push('adjacent'); } }, source.url));
    expect(events).toEqual(['report', 'consent', 'adjacent', 'spawn']);
    await addProfile(home, 'work', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
    await addProfilePackageReference({ bazframeHome: home, services: createWindowsReadyResourceServices(f.backend, f.options) }, 'work', 'package');
    const captured = await captureProfile({ bazframeHome: home, profileId: 'work', bundleRemote: true }, createWindowsProfileDataReads(f.backend, undefined, f.options).captureDependencies);
    const payload = captured.profile.resources[0]!.payload; if (payload.kind !== 'bundled') throw new Error('not bundled');
    expect(payload.files.find((file) => file.path === 'built/helper')?.executable).toBe(true);
    expect(payload.files.find((file) => file.path === 'built/generated.bin')?.executable).toBe(false);
    const path = home + '\\packages\\package.json', before = Buffer.from(f.nodes.get(path)!.bytes!);
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.buildManagedGitPackage({ bazframeHome: home, yes: true, environment: { ...process.env, BAZFRAME_FIXTURE_FAIL: '1' } }, 'package'))).rejects.toThrow();
    expect(f.nodes.get(path)!.bytes).toEqual(before);
    await readProfileSystemView(home, createWindowsProfileDataReads(f.backend).viewReads);

    expect(await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.buildManagedGitPackage({ bazframeHome: home, yes: true }, 'package'))).toMatchObject({ action: 'built' });
    writeFileSync(join(source.path, 'other'), 'next'); source.git('add', '.'); source.git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-m', 'next');
    expect(await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.updateManagedGitPackage({ bazframeHome: home, yes: true }, 'package'))).toMatchObject({ action: 'updated' });
    const active = Buffer.from(f.nodes.get(path)!.bytes!);
    let requestCount = 0;
    f.options.packageProcessRunner = async () => { requestCount = f.requests.length; return { exitCode: 0, signal: null, uncertainTermination: true }; };
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.buildManagedGitPackage({ bazframeHome: home, yes: true }, 'package'))).rejects.toThrow(/uncertain/);
    expect(f.nodes.get(path)!.bytes).toEqual(active);
    expect(f.requests.slice(requestCount).some((request) => request.args.includes('reset') || request.args.includes('clean'))).toBe(false);
    await readProfileSystemView(home, createWindowsProfileDataReads(f.backend).viewReads);
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.removeManagedGitPackage({ bazframeHome: home }, 'package'))).rejects.toMatchObject({ code: 'MANAGED_GIT_RECOVERY_REQUIRED' });

  }, 90000);


  it('logically removes a built managed package only after its profile reference is removed', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f); const home = 'C:\\boundary\\home';
    const source = f.source('package', { 'bazframe-package.json': JSON.stringify({ schemaVersion: 1, build: ['node', 'build.js'], artifactRoot: 'dist', skillsRoot: '.' }), 'build.js': '', 'dist/built/SKILL.md': '---\nname: built\ndescription: Fixture\n---\n' });
    const added = await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitPackage({ bazframeHome: home, yes: true }, source.url));
    await addProfile(home, 'work', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
    const refs = { bazframeHome: home, services: createWindowsReadyResourceServices(f.backend, f.options) };
    await addProfilePackageReference(refs, 'work', 'package');
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.removeManagedGitPackage({ bazframeHome: home }, 'package'))).rejects.toThrow();
    await removeProfilePackageReference(refs, 'work', 'package');
    expect(await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.removeManagedGitPackage({ bazframeHome: home }, 'package'))).toMatchObject({ action: 'removed' });
    expect(f.nodes.has(added.root)).toBe(false);
    expect([...f.nodes.keys()].some((path) => path.includes('retained-') && path.endsWith('\\dist\\built\\SKILL.md'))).toBe(true);
  }, 90000);
  it('acquires and exactly reuses a library through real ready-resource publication', async () => {
    const f = windowsGitHostFixture(); fixtures.push(f);
    const source = f.source('library', { 'hello/SKILL.md': '---\nname: hello\ndescription: fixture\n---\nHello\r\n', 'hello/helper': Buffer.from([0, 255, 1, 2]) }, ['hello/helper']);
    const home = 'C:\\boundary\\home';
    const added = await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibrary({ bazframeHome: home }, source.url));
    expect(added.action).toBe('added'); expect(added.revision).toBe(source.revision);
    // Existing source, provenance, roots and state need no owner/ACL template.
    for (const [path, node] of f.nodes) node.security = { ...f.security(path), ownerSid: 'S-1-5-21-999', descriptorControl: 4 };
    const reader = createManagedGitProvider(createWindowsManagedGitServices(f.backend, home, f.options));
    const health = await reader.captureManagedGitExportHealth(home, 'library', 'library');
    expect(health.root.domain).toBe('windows');
    const count = f.requests.filter((request) => request.args.includes('clone')).length;
    const reused = await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.addManagedGitLibraryAtRevision({ bazframeHome: home }, 'library', { remote: 'example.test/owner/library', fetchUrl: source.url, branch: 'main', revision: source.revision }, { mode: 'must-reuse', expectedHealth: health }));
    expect(reused.action).toBe('current'); expect(f.requests.filter((request) => request.args.includes('clone'))).toHaveLength(count);
    await addProfile(home, 'work', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
    const refs = { bazframeHome: home, services: createWindowsReadyResourceServices(f.backend, f.options) };
    await addProfileLibraryReference(refs, 'work', 'library');
    writeFileSync(join(source.path, 'hello', 'next'), 'next'); source.git('add', '.'); source.git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-m', 'next');
    expect(await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.updateManagedGitLibrary({ bazframeHome: home }, 'library'))).toMatchObject({ action: 'updated' });
    const record = Buffer.from(f.nodes.get(home + '\\libraries\\library.json')!.bytes!);
    const own = home + '\\profiles\\work\\skills\\occupied'; mkdirSync(f.hostPath(own)); writeFileSync(join(f.hostPath(own), 'SKILL.md'), '---\nname: occupied\ndescription: own\n---\n'); await f.refresh();
    writeFileSync(join(source.path, 'hello', 'SKILL.md'), '---\nname: occupied\ndescription: conflict\n---\n'); source.git('add', '.'); source.git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-m', 'conflict');
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.updateManagedGitLibrary({ bazframeHome: home }, 'library'))).rejects.toThrow();
    expect(f.nodes.get(home + '\\libraries\\library.json')!.bytes).toEqual(record);
    await readProfileSystemView(home, createWindowsProfileDataReads(f.backend).viewReads);
    await expect(withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.removeManagedGitLibrary({ bazframeHome: home }, 'library'))).rejects.toThrow();
    await removeProfileLibraryReference(refs, 'work', 'library');
    expect(await withWindowsManagedGitProvider(f.backend, home, f.options, (provider) => provider.removeManagedGitLibrary({ bazframeHome: home }, 'library'))).toMatchObject({ action: 'removed' });

  }, 90000);
});
