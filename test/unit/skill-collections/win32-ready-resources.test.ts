import { captureProfileCollectionReferenceIndex } from '../../../src/profiles/profile-skill-collection-reference.js';
import { win32 } from 'node:path';
import { loadProfile } from '../../../src/profiles/profile-store.js';
import { listProfiles, currentProfile } from '../../../src/profiles/profile-management.js';
import * as fs from 'node:fs/promises';
import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../../../src/skills/added-skill-platform-services.js';
import { addDefaultSkill, removeDefaultSkill } from '../../../src/skills/default-skill-catalog.js';
import { addActiveProfileSkill, removeActiveProfileSkill } from '../../../src/profiles/profile-skill-membership.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { readProfileFavorites, toggleProfileFavorite } from '../../../src/profiles/profile-favorites.js';
import { prepareLibrary } from '../../../src/skill-collections/skill-collection-preparation.js';
import { SKILL_SNAPSHOT_LIMITS } from '../../../src/skill-collections/skill-snapshot.js';
import { describe, expect, it, vi } from 'vitest';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { createWindowsReadyResourceServices } from '../../../src/skill-collections/win32-ready-resource-services.js';
import { addLibrary, updateLibrary, removeLibrary, addPackage, buildPackage, removePackage } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import { inspectGlobalSkillCollections, resolveProfileSkillCollections } from '../../../src/skill-collections/skill-collection-resolver.js';
import { addProfileLibraryReference, removeProfileLibraryReference, addProfilePackageReference, removeProfilePackageReference, addActiveProfileLibraryReference, removeActiveProfileLibraryReference } from '../../../src/profiles/profile-skill-collection-reference-lifecycle.js';
import { createWindowsProfileDataReads } from '../../../src/profile-publishing/win32-profile-data-reads.js';
import { createWindowsProfileZipLifecycleDependencies, createWindowsProfileLifecycleServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-lifecycle.js';
import { createWindowsProfileActivationServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-activation.js';
import { captureProfile } from '../../../src/profile-publishing/profile-capture.js';
import { readProfileSystemView } from '../../../src/profile-publishing/profile-view.js';
import { useManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { exportManagedProfile } from '../../../src/profile-publishing/profile-lifecycle.js';
import { ensureWindowsPrivateDirectoryPath } from '../../../src/state/win32-private-directory.js';
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), readlink: vi.fn() }));
const HOME = 'C:\\boundary\\home';
const LIBRARY = 'C:\\boundary\\library';
const PACKAGE = 'C:\\boundary\\package';
const definition = (name: string) => `---\nname: ${name}\ndescription: Ready.\n---\n`;
function fixture() {
  const f = windowsProvisioningFixture();
  for (const path of [HOME, `${HOME}\\profiles\\work\\skills`, `${HOME}\\skills`, `${HOME}\\locks`, LIBRARY, `${LIBRARY}\\child`, PACKAGE, `${PACKAGE}\\dist\\built`]) ensureWindowsPrivateDirectoryPath(f.backend, path);
  f.file(`${HOME}\\profiles\\work\\AGENTS.md`, 'Work\n');
  f.file(`${LIBRARY}\\child\\SKILL.md`, definition('child'));
  f.file(`${LIBRARY}\\child\\data.bin`, 'source');
  f.file(`${PACKAGE}\\dist\\built\\SKILL.md`, definition('built'));
  f.file(`${PACKAGE}\\bazframe-package.json`, JSON.stringify({ schemaVersion: 1, build: ['node', 'literal script.js', '& no shell'], artifactRoot: 'dist', skillsRoot: '.' }));
  const options = { resolvePackageExecutable: async (argv: readonly string[]) => ({ executable: argv[0]!, args: argv.slice(1) }), storageIo: f.io, stateIo: f.io, lockIo: f.io, journal: { io: f.io } };
  const services = createWindowsReadyResourceServices(f.backend, options);
  return { ...f, options, services, deps: { services }, lifecycleOptions: { bazframeHome: HOME }, references: { bazframeHome: HOME, services } };
}
describe('Windows ready resources through shared collection engines (host receipts)', () => {
  it.each(['none', 'manifest', 'root'])('defers package helper execution until consent and revalidates before it: %s', async (change) => {
    const f = fixture(), events: string[] = [];
    const services = createWindowsReadyResourceServices(f.backend, { ...f.options, resolvePackageExecutable: async (argv) => ({ executable: argv[0]!, args: argv.slice(1), afterAuthorization: async () => { events.push('helper'); return { executable: argv[0]!, args: argv.slice(1) }; } }) });
    const result = addPackage(f.lifecycleOptions, PACKAGE, { services, beforePackageBuild: async () => { events.push('consent'); if (change === 'root') f.directory(PACKAGE); if (change === 'manifest') f.nodes.get(`${PACKAGE}\\bazframe-package.json`)!.bytes = Buffer.from('{}'); }, packageProcessRunner: async () => { events.push('spawn'); return { exitCode: 0, signal: null }; } });
    if (change === 'none') { await result; expect(events).toEqual(['consent', 'helper', 'spawn']); }
    else { await expect(result).rejects.toThrow(); expect(events).toEqual(['consent']); }
  });
  it('checks scoped catalog authority after the complete final capture read', async () => {
    const f = fixture(); await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    const dependencies = createWindowsProfileZipLifecycleDependencies(f.backend, f.options);
    const input = { bazframeHome: HOME, kind: 'library' as const, name: 'library', capturedResourceId: 'a'.repeat(64), bundleRemote: true };
    const read = f.backend.readStableFile; let count = 0;
    f.backend.readStableFile = async (...args) => { count++; return read(...args); };
    await dependencies.captureCatalog!(input); const maximum = count; count = 0;
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), blocked = new Promise<void>((resolve) => { reached = resolve; });
    f.backend.readStableFile = async (...args) => { const value = await read(...args); if (++count === maximum) { reached(); await gate; } return value; };
    let outcome!: Promise<unknown>;
    await dependencies.services!.withOperationLocks(HOME, ['@store'], async (authority) => { outcome = dependencies.captureCatalogWithAuthority!(input, authority); outcome.catch(() => undefined); await blocked; });
    release(); await expect(outcome).rejects.toThrow();
  });

  it.each(['root', 'manifest'])('revalidates %s after asynchronous executable resolution before package process launch', async (change) => {
    const f = fixture();
    const runner = vi.fn(async () => ({ exitCode: 0, signal: null }));
    f.options.resolvePackageExecutable = async (argv) => {
      await Promise.resolve();
      if (change === 'root') f.directory(PACKAGE);
      else f.file(`${PACKAGE}\\bazframe-package.json`, JSON.stringify({ schemaVersion: 1, build: ['node', 'changed.js'], artifactRoot: 'dist', skillsRoot: '.' }));
      return { executable: argv[0]!, args: argv.slice(1) };
    };
    await expect(addPackage(f.lifecycleOptions, PACKAGE, { ...f.deps, packageProcessRunner: runner })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
    expect(f.nodes.has(`${HOME}\\packages\\package.json`)).toBe(false);
  });
  it('never activates a package when the process reports only uncertainty or error despite zero status', async () => {
    for (const result of [{ exitCode: 0, signal: null, uncertainTermination: true }, { exitCode: 0, signal: null, error: new Error('process error') }]) {
      const f = fixture();
      await expect(addPackage(f.lifecycleOptions, PACKAGE, { ...f.deps, packageProcessRunner: async () => result })).rejects.toThrow();
      expect(f.nodes.has(`${HOME}\\packages\\package.json`)).toBe(false);
    }
  });
  it.each(['descriptor', 'profile', 'other-kind-reference', 'invalid-flat'])('removes only the exact reference despite unrelated %s payload failure', async (adverse) => {
    const f = fixture(); await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    await addProfileLibraryReference(f.references, 'work', 'library');
    if (adverse === 'descriptor') f.file(`${HOME}\\libraries\\broken.json`, '{bad');
    if (adverse === 'profile') {
      ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\broken\\skills`);
      f.file(`${HOME}\\profiles\\broken\\AGENTS.md`, 'bad');
      f.nodes.get(`${HOME}\\profiles\\broken\\AGENTS.md`)!.bytes = Buffer.from([255]);
    }
    if (adverse === 'other-kind-reference') {
      ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\work\\packages`);
      f.file(`${HOME}\\profiles\\work\\packages\\broken.json`, '{bad');
    }
    if (adverse === 'invalid-flat') {
      ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\work\\skills\\local`);
      f.file(`${HOME}\\profiles\\work\\skills\\local\\SKILL.md`, 'not a Skill');
    }
    expect(await removeProfileLibraryReference(f.references, 'work', 'library')).toMatchObject({ action: 'removed' });
    expect(f.nodes.has(`${HOME}\\profiles\\work\\libraries\\library.json`)).toBe(false);
  });
  it.each(['descriptor', 'profile', 'old-snapshot'])('adds a reference and updates using only dependent flat inputs despite unhealthy %s', async (adverse) => {
    const f = fixture(); const added = await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    if (adverse === 'descriptor') f.file(`${HOME}\\libraries\\unrelated.json`, '{bad');
    if (adverse === 'profile') {
      ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\unrelated\\skills\\broken`);
      f.file(`${HOME}\\profiles\\unrelated\\AGENTS.md`, 'Other');
      f.file(`${HOME}\\profiles\\unrelated\\skills\\broken\\SKILL.md`, 'not a Skill');
    }
    await addProfileLibraryReference(f.references, 'work', 'library');
    if (adverse === 'old-snapshot') f.nodes.get(`${HOME}\\skill-snapshots\\sha256\\${added.digest}\\artifact\\child\\data.bin`)!.bytes = Buffer.from('corrupt');
    f.nodes.get(`${LIBRARY}\\child\\data.bin`)!.bytes = Buffer.from('repaired source');
    const updated = await updateLibrary(f.lifecycleOptions, 'library', f.deps);
    expect(updated.action).toBe('updated'); expect(updated.digest).not.toBe(added.digest);
    expect((await f.services.resolver.verifySnapshot(HOME, updated.digest)).digest).toBe(updated.digest);
  });
  it('retains global all-reference completeness refusal for malformed other-kind references', async () => {
    const f = fixture(); await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    await addProfileLibraryReference(f.references, 'work', 'library');
    ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\work\\packages`);
    f.file(`${HOME}\\profiles\\work\\packages\\broken.json`, '{bad');
    const before = Buffer.from(f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes!);
    await expect(updateLibrary(f.lifecycleOptions, 'library', f.deps)).rejects.toThrow();
    await expect(removeLibrary(f.lifecycleOptions, 'library', f.deps)).rejects.toThrow();
    expect(f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes).toEqual(before);
  });
  it.each(['reference-add', 'dependent-update'])('rejects a flat Skill missing description during %s', async (operation) => {
    const f = fixture(); await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    if (operation === 'dependent-update') await addProfileLibraryReference(f.references, 'work', 'library');
    ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\work\\skills\\local`);
    f.file(`${HOME}\\profiles\\work\\skills\\local\\SKILL.md`, '---\nname: local\n---\n');
    const before = Buffer.from(f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes!);
    if (operation === 'reference-add') {
      await expect(addProfileLibraryReference(f.references, 'work', 'library')).rejects.toMatchObject({ code: 'INVALID_SKILL_DEFINITION' });
      expect(f.nodes.has(`${HOME}\\profiles\\work\\libraries\\library.json`)).toBe(false);
    } else await expect(updateLibrary(f.lifecycleOptions, 'library', f.deps)).rejects.toMatchObject({ code: 'SKILL_COLLECTION_DEPENDENT_INVALID' });
    expect(f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes).toEqual(before);
  });
  it('admits ..dist package artifacts but rejects actual parent/volume escape', async () => {
    const f = fixture(); ensureWindowsPrivateDirectoryPath(f.backend, `${PACKAGE}\\..dist\\built`);
    f.file(`${PACKAGE}\\..dist\\built\\SKILL.md`, definition('built'));
    f.nodes.get(`${PACKAGE}\\bazframe-package.json`)!.bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, build: ['node', 'build.js'], artifactRoot: '..dist', skillsRoot: '.' }));
    const runner = vi.fn(async () => ({ exitCode: 0, signal: null }));
    expect(await addPackage(f.lifecycleOptions, PACKAGE, { ...f.deps, packageProcessRunner: runner })).toMatchObject({ action: 'added', artifactRoot: '..dist' });
    expect(runner).toHaveBeenCalledOnce();
    expect(f.services.resolver.within(PACKAGE, `${PACKAGE}\\..dist`)).toBe(true);
    for (const path of ['C:\\boundary', 'C:\\boundary\\other', 'D:\\other']) expect(f.services.resolver.within(PACKAGE, path)).toBe(false);
  });
  it('refuses source/store overlap under a legal ..inputs component', async () => {
    const f = fixture(); const root = `${HOME}\\skill-snapshots\\sha256\\..inputs\\library`;
    ensureWindowsPrivateDirectoryPath(f.backend, `${root}\\child`); f.file(`${root}\\child\\SKILL.md`, definition('child'));
    await expect(addLibrary(f.lifecycleOptions, root, f.deps)).rejects.toMatchObject({ code: 'SKILL_SNAPSHOT_PATH_OVERLAP' });
    expect(f.nodes.has(`${HOME}\\libraries\\library.json`)).toBe(false);
  });
  it.each(['support-read-denial', 'other-kind-reference'])('favorites use normal profile loading without irrelevant %s payload reads', async (adverse) => {
    const f = fixture(); const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, f.options);
    ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\work\\skills\\local`);
    f.file(`${HOME}\\profiles\\work\\skills\\local\\SKILL.md`, definition('local'));
    const support = `${HOME}\\profiles\\work\\skills\\local\\support.bin`; f.file(support, 'payload');
    if (adverse === 'other-kind-reference') {
      ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\work\\packages`);
      f.file(`${HOME}\\profiles\\work\\packages\\broken.json`, '{bad');
    }
    const original = f.backend.readStableFile.bind(f.backend); const denied: string[] = [];
    vi.spyOn(f.backend, 'readStableFile').mockImplementation(async (path, max) => {
      if (path === support) { denied.push(path); throw new Error('supporting payload read-data sharing denied'); }
      return original(path, max);
    });
    expect((await loadProfile(HOME, 'work', { platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend) })).id).toBe('work');
    expect(await toggleProfileFavorite(HOME, 'work', { services })).toMatchObject({ action: 'favorited' });
    expect(denied).toEqual([]);
  });
  it.each(['file-id', 'creation-time'])('favorite root revalidation preserves preference bytes when lossless %s changes', async (adverse) => {
    const f = fixture(); const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, f.options);
    let changed = false;
    const inspect = f.backend.inspectPath.bind(f.backend);
    vi.spyOn(f.backend, 'inspectPath').mockImplementation((path) => {
      const value = inspect(path);
      if (changed && path === win32.join(HOME, 'profiles', 'work')) {
        value.object = { ...value.object, ...(adverse === 'file-id' ? { fileId: 'f'.repeat(32) } : { creationTime: 'f'.repeat(16) }) };
      }
      return value;
    });
    await toggleProfileFavorite(HOME, 'work', { services });
    const before = Buffer.from(f.nodes.get(`${HOME}\\profile-favorites.json`)!.bytes!);
    await expect(toggleProfileFavorite(HOME, 'work', { services, beforeTargetRevalidation: async () => { changed = true; } })).rejects.toMatchObject({ code: 'PROFILE_FAVORITE_TARGET_STALE' });
    expect(f.nodes.get(`${HOME}\\profile-favorites.json`)!.bytes).toEqual(before);
  });
  it.each(['instructions', 'skills-namespace', 'requested-reference'])('exact reference removal still refuses invalid target %s', async (adverse) => {
    const f = fixture(); await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    await addProfileLibraryReference(f.references, 'work', 'library');
    const reference = win32.join(HOME, 'profiles', 'work', 'libraries', 'library.json');
    if (adverse === 'instructions') f.nodes.get(win32.join(HOME, 'profiles', 'work', 'AGENTS.md'))!.bytes = Buffer.from([255]);
    if (adverse === 'skills-namespace') f.reparse(win32.join(HOME, 'profiles', 'work', 'skills'));
    if (adverse === 'requested-reference') f.nodes.get(reference)!.bytes = Buffer.from('{bad');
    const before = Buffer.from(f.nodes.get(reference)!.bytes!);
    await expect(removeProfileLibraryReference(f.references, 'work', 'library')).rejects.toThrow();
    expect(f.nodes.get(reference)!.bytes).toEqual(before);
  });
  it.each(['reparse', 'non-private'])('favorite publication preserves CAS and applies physical admission to a %s root', async (adverse) => {
    const f = fixture(); const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, f.options);
    await toggleProfileFavorite(HOME, 'work', { services });
    const path = win32.join(HOME, 'profile-favorites.json');
    const changed = Buffer.from('{bad');
    await expect(toggleProfileFavorite(HOME, 'work', { services, beforeTargetRevalidation: async () => { f.nodes.get(path)!.bytes = changed; } })).rejects.toThrow();
    expect(f.nodes.get(path)!.bytes).toEqual(changed);
    const root = win32.join(HOME, 'profiles', 'work');
    if (adverse === 'reparse') f.reparse(root);
    else f.nodes.get(root)!.security = { ...f.security(root), ownerSid: 'S-1-5-21-999' };
    if (adverse === 'non-private') {
      f.file(path, '{"schemaVersion":1,"favorites":[]}\n');
      await expect(toggleProfileFavorite(HOME, 'work', { services })).resolves.toMatchObject({ action: 'favorited' });
    } else {
      await expect(toggleProfileFavorite(HOME, 'work', { services })).rejects.toThrow();
      expect(f.nodes.get(path)!.bytes).toEqual(changed);
    }
  });
  it('publishes a real local library snapshot, references, uses/views/captures/exports it, updates and removes reference-safely', async () => {
    const f = fixture();
    const added = await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    expect(added.action).toBe('added');
    expect(f.nodes.has(`${HOME}\\skill-snapshots\\sha256\\${added.digest}\\artifact\\child\\data.bin`)).toBe(true);
    expect(await addProfileLibraryReference(f.references, 'work', 'library')).toMatchObject({ action: 'added' });
    const data = createWindowsProfileDataReads(f.backend);
    expect((await readProfileSystemView(HOME, data.viewReads)).resources.map((resource) => resource.key.name)).toContain('library');
    const activation = createWindowsProfileActivationServicesForInternalTesting(f.backend, { lockIo: f.io, selectionIo: f.io, journal: { io: f.io } });
    await useManagedProfile(HOME, 'work', activation);
    expect((await resolveProfileSkillCollections(`${HOME}\\profiles\\work`, [], undefined, f.services.resolver)).derivedSkills.map((skill) => skill.name)).toEqual(['child']);
    expect((await captureProfile({ bazframeHome: HOME, profileId: 'work' }, createWindowsProfileDataReads(f.backend).captureDependencies)).profile.resources).toHaveLength(1);
    const zipIo = { async *readInput(path: string) { yield f.nodes.get(path)!.bytes!; }, async writeExistingFile(path: string, chunks: AsyncIterable<Uint8Array>) { const parts: Buffer[] = []; for await (const chunk of chunks) parts.push(Buffer.from(chunk)); await f.io.writeExistingFile(path, Buffer.concat(parts)); }, rename: f.io.rename };
    const zip = createWindowsProfileZipLifecycleDependencies(f.backend, { ...f.options, zip: { io: zipIo, temporaryRoot: 'C:\\boundary' } });
    expect(await exportManagedProfile({ home: HOME, profileName: 'work', outputPath: 'C:\\boundary\\out.zip' }, zip)).toMatchObject({ profileName: 'work' });
    f.nodes.get(`${LIBRARY}\\child\\data.bin`)!.bytes = Buffer.from('updated');
    const updated = await updateLibrary(f.lifecycleOptions, 'library', f.deps); expect(updated.digest).not.toBe(added.digest);
    const listed = await inspectGlobalSkillCollections(HOME, undefined, f.services.resolver); expect(listed.collections[0]!.skills.map((skill) => skill.name)).toEqual(['child']);
    await expect(removeLibrary(f.lifecycleOptions, 'library', f.deps)).rejects.toMatchObject({ code: 'SKILL_COLLECTION_REFERENCED' });
    expect(await removeProfileLibraryReference(f.references, 'work', 'library')).toMatchObject({ action: 'removed' });
    expect((await readProfileSystemView(HOME, createWindowsProfileDataReads(f.backend).viewReads)).profiles.find((profile) => profile.name === 'work')!.resourceIdentities).toEqual([]);
    expect((await captureProfile({ bazframeHome: HOME, profileId: 'work' }, createWindowsProfileDataReads(f.backend).captureDependencies)).profile.resources).toEqual([]);
    expect(await removeLibrary(f.lifecycleOptions, 'library', f.deps)).toMatchObject({ action: 'removed' });
    expect((await inspectGlobalSkillCollections(HOME, undefined, f.services.resolver)).collections).toEqual([]);
    expect(f.nodes.get(`${LIBRARY}\\child\\data.bin`)!.bytes!.toString()).toBe('updated');
  });
  it('uses exact package argv and adjacent manifest consent, preserving the active descriptor on failed builds', async () => {
    const f = fixture(); const events: string[] = [];
    const runner = vi.fn(async () => { events.push('spawn'); return { exitCode: 0, signal: null }; });
    const deps = { ...f.deps, beforePackageBuild: async (context: import('../../../src/skill-collections/skill-collection-preparation.js').BeforePackageBuildContext) => { expect(context.rootIdentity.domain).toBe('windows'); expect(context.rootIdentity.device).toBeUndefined(); events.push('consent'); }, packageProcessRunner: runner };
    const added = await addPackage(f.lifecycleOptions, PACKAGE, deps);
    expect(events).toEqual(['consent', 'spawn']); expect(runner).toHaveBeenCalledWith('node', ['literal script.js', '& no shell'], expect.objectContaining({ cwd: PACKAGE }));
    await addProfilePackageReference(f.references, 'work', 'package');
    const before = f.nodes.get(`${HOME}\\packages\\package.json`)!.bytes;
    await expect(buildPackage(f.lifecycleOptions, 'package', { ...deps, packageProcessRunner: async () => { f.file(`${PACKAGE}\\dist\\failed-build.txt`, 'partial output'); return { exitCode: 7, signal: null }; } })).rejects.toMatchObject({ code: 'PACKAGE_BUILD_FAILED' });
    expect(f.nodes.get(`${HOME}\\packages\\package.json`)!.bytes).toEqual(before);
    expect(f.nodes.has(`${HOME}\\skill-snapshots\\sha256\\${added.digest}\\artifact\\failed-build.txt`)).toBe(false);
    expect((await f.services.optionalSnapshot(HOME, { kind: 'package', id: 'package' }))!.record.digest).toBe(added.digest);
    f.file(`${PACKAGE}\\dist\\built\\new.txt`, 'new output');
    const built = await buildPackage(f.lifecycleOptions, 'package', deps); expect(built.action).toBe('built'); expect(built.digest).not.toBe(added.digest);
    await expect(removePackage(f.lifecycleOptions, 'package', f.deps)).rejects.toMatchObject({ code: 'SKILL_COLLECTION_REFERENCED' });
    await removeProfilePackageReference(f.references, 'work', 'package');
    expect(await removePackage(f.lifecycleOptions, 'package', f.deps)).toMatchObject({ action: 'removed' });
  });
  it('validates every dependent and rejects conflicting updates without changing any active digest', async () => {
    const f = fixture(); const added = await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    await addProfileLibraryReference(f.references, 'work', 'library');
    ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\other\\skills\\occupied`);
    f.file(`${HOME}\\profiles\\other\\AGENTS.md`, 'Other'); f.file(`${HOME}\\profiles\\other\\skills\\occupied\\SKILL.md`, definition('occupied'));
    await addProfileLibraryReference(f.references, 'other', 'library');
    f.nodes.get(`${LIBRARY}\\child\\SKILL.md`)!.bytes = Buffer.from(definition('occupied'));
    await expect(updateLibrary(f.lifecycleOptions, 'library', f.deps)).rejects.toMatchObject({ code: 'SKILL_COLLECTION_DEPENDENT_INVALID' });
    expect((await f.services.optionalSnapshot(HOME, { kind: 'library', id: 'library' }))!.record.digest).toBe(added.digest);
  });
  it.each(['unknown-profile', 'changed-reference', 'root-replaced', 'source-alias', 'source-link', 'file-hardlink', 'lower-bound', 'source-drift'])('applies shared snapshot input admission to %s', async (adverse) => {
    const f = fixture(); const added = await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    await addProfileLibraryReference(f.references, 'work', 'library');
    const before = Buffer.from(f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes!);
    const dependencies: import('../../../src/skill-collections/skill-collection-lifecycle.js').SkillCollectionLifecycleDependencies = { ...f.deps };
    if (adverse === 'unknown-profile') f.file(`${HOME}\\profiles\\unknown`, 'not a profile');
    if (adverse === 'changed-reference') dependencies.beforeReferenceIndexRevalidation = async () => { f.nodes.get(`${HOME}\\profiles\\work\\libraries\\library.json`)!.bytes = Buffer.from('{"schemaVersion":1,"library":"wrong"}'); };
    if (adverse === 'root-replaced') dependencies.beforeLibrarySnapshotInputCapture = async () => { f.nodes.get(LIBRARY)!.id += 1000; };
    if (adverse === 'source-alias') { f.nodes.set('C:\\boundary\\LIBRARY', f.nodes.get(LIBRARY)!); f.nodes.delete(LIBRARY); }
    if (adverse === 'source-link') f.reparse(`${LIBRARY}\\link`);
    if (adverse === 'file-hardlink') f.nodes.get(`${LIBRARY}\\child\\data.bin`)!.numberOfLinks = 2;
    if (adverse === 'lower-bound' || adverse === 'source-drift') {
      const base = f.services.withLock;
      dependencies.services = { ...f.services, withLock: (home, command, target, operation) => base(home, command, target, async (current) => {
        const snapshotDependencies = current.preparation.snapshotDependencies;
        return operation({ ...current, preparation: { ...current.preparation, snapshotDependencies: () => ({ ...snapshotDependencies(), ...(adverse === 'lower-bound' ? { limitPolicy: { ...SKILL_SNAPSHOT_LIMITS, maxAggregateFileBytes: 8 } } : { duringSourceFileCopy: async () => { f.nodes.get(`${LIBRARY}\\child\\data.bin`)!.bytes = Buffer.from('drift'); } }) }) } });
      }) };
    }
    if (adverse === 'file-hardlink') await expect(updateLibrary(f.lifecycleOptions, 'library', dependencies)).resolves.toHaveProperty('digest');
    else await expect(updateLibrary(f.lifecycleOptions, 'library', dependencies)).rejects.toThrow();
    expect(f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes).toEqual(before);
    expect(f.nodes.has(`${HOME}\\skill-snapshots\\sha256\\${added.digest}\\manifest.json`)).toBe(true);
  });
  it.each(['no-effect', 'after-effect', 'ambiguous'])('reconciles initial descriptor publication %s without overwrite', async (effect) => {
    const f = fixture(); const original = f.backend.renameFileNoReplace.bind(f.backend);
    vi.spyOn(f.backend, 'renameFileNoReplace').mockImplementation(async (parent, source, target) => {
      if (target !== 'library.json') return original(parent, source, target);
      if (effect === 'no-effect') throw new Error('sharing');
      await original(parent, source, target);
      if (effect === 'ambiguous') f.nodes.get(`${parent}\\${target}`)!.id += 1000;
      throw new Error('after effect');
    });
    if (effect === 'after-effect') expect(await addLibrary(f.lifecycleOptions, LIBRARY, f.deps)).toMatchObject({ action: 'added' });
    else await expect(addLibrary(f.lifecycleOptions, LIBRARY, f.deps)).rejects.toMatchObject({ code: effect === 'no-effect' ? 'WINDOWS_SELECTION_NO_EFFECT' : 'WINDOWS_SELECTION_AMBIGUOUS' });
    if (effect === 'no-effect') expect(f.nodes.has(`${HOME}\\libraries\\library.json`)).toBe(false);
  });
  it.each(['no-effect', 'after-effect', 'ambiguous'])('reconciles guarded descriptor leaf detach %s and retains source/snapshot data', async (effect) => {
    const f = fixture(); const added = await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    const original = f.backend.renameFileNoReplace.bind(f.backend);
    vi.spyOn(f.backend, 'renameFileNoReplace').mockImplementation(async (parent, source, target) => {
      if (!target.startsWith('.bazframe-resource-')) return original(parent, source, target);
      if (effect === 'no-effect') throw new Error('sharing');
      await original(parent, source, target);
      if (effect === 'ambiguous') f.nodes.get(`${parent}\\${target}`)!.id += 1000;
      throw new Error('after effect');
    });
    if (effect === 'after-effect') expect(await removeLibrary(f.lifecycleOptions, 'library', f.deps)).toMatchObject({ action: 'removed' });
    else await expect(removeLibrary(f.lifecycleOptions, 'library', f.deps)).rejects.toThrow();
    expect(f.nodes.has(`${LIBRARY}\\child\\data.bin`)).toBe(true);
    expect(f.nodes.has(`${HOME}\\skill-snapshots\\sha256\\${added.digest}\\manifest.json`)).toBe(true);
  });
  it('checks package manifest after adjacent consent and preserves active state on uncertain termination', async () => {
    const f = fixture(); const runner = vi.fn(async () => ({ exitCode: 0, signal: null }));
    const before = f.nodes.get(`${PACKAGE}\\bazframe-package.json`)!.bytes!;
    await expect(addPackage(f.lifecycleOptions, PACKAGE, { ...f.deps, beforePackageBuild: async () => { f.nodes.get(`${PACKAGE}\\bazframe-package.json`)!.bytes = Buffer.from(before.toString().replace('literal script', 'different script')); }, packageProcessRunner: runner })).rejects.toMatchObject({ code: 'PACKAGE_MANIFEST_CHANGED' });
    expect(runner).not.toHaveBeenCalled(); expect(f.nodes.has(`${HOME}\\packages\\package.json`)).toBe(false);
    f.nodes.get(`${PACKAGE}\\bazframe-package.json`)!.bytes = before;
    await addPackage(f.lifecycleOptions, PACKAGE, { ...f.deps, packageProcessRunner: runner });
    const descriptor = f.nodes.get(`${HOME}\\packages\\package.json`)!.bytes;
    await expect(buildPackage(f.lifecycleOptions, 'package', { ...f.deps, packageProcessRunner: async () => ({ exitCode: null, signal: null, failure: 'termination-uncertain', uncertainTermination: true }) })).rejects.toMatchObject({ code: 'PACKAGE_BUILD_TERMINATION_UNCERTAIN' });
    expect(f.nodes.get(`${HOME}\\packages\\package.json`)!.bytes).toEqual(descriptor);
  });
  it('rejects an escaped real lock scope while draining a pending snapshot write before any descriptor activation', async () => {
    const f = fixture();
    let started!: () => void, resume!: () => void;
    const paused = new Promise<void>((resolve) => { started = resolve; }), release = new Promise<void>((resolve) => { resume = resolve; });
    const original = f.io.writeExistingFile;
    vi.spyOn(f.io, 'writeExistingFile').mockImplementation(async (path, bytes) => {
      if (path.includes('\\artifact\\')) { started(); await release; }
      await original(path, bytes);
    });
    let pending!: Promise<unknown>;
    await f.services.withLock(HOME, 'test', 'library', async (current) => {
      pending = prepareLibrary(HOME, LIBRARY, {}, current.preparation).catch((error: unknown) => error);
      await paused;
    });
    expect(f.nodes.has(`${HOME}\\libraries\\library.json`)).toBe(false);
    resume(); expect(await pending).toBeInstanceOf(Error);
    expect([...f.nodes.keys()].some((path) => path.includes('\\skill-snapshots\\') && path.endsWith('manifest.json'))).toBe(false);
  });
  it('shares favorites read/toggle policy and diagnoses malformed state without replacement', async () => {
    const f = fixture(), services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, f.options);
    const absentBefore = f.snapshot();
    expect(await readProfileFavorites('C:\\boundary\\absent-home', services)).toMatchObject({ favorites: [] });
    expect(f.snapshot()).toBe(absentBefore);
    expect(await readProfileFavorites(HOME, services)).toMatchObject({ favorites: [] });
    expect(await toggleProfileFavorite(HOME, 'work', { services })).toMatchObject({ action: 'favorited', favorites: ['work'] });
    expect(await toggleProfileFavorite(HOME, 'work', { services })).toMatchObject({ action: 'unfavorited' });
    f.nodes.get(`${HOME}\\profile-favorites.json`)!.bytes = Buffer.from('{bad');
    const preference = JSON.stringify(f.nodes.get(`${HOME}\\profile-favorites.json`));
    await expect(readProfileFavorites(HOME, services)).rejects.toMatchObject({ code: 'PROFILE_FAVORITES_INVALID' });
    await expect(toggleProfileFavorite(HOME, 'work', { services })).rejects.toMatchObject({ code: 'PROFILE_FAVORITES_INVALID' });
    expect((await services.readFavorites(HOME)).valid).toBe(false);
    expect(f.nodes.get(`${HOME}\\profile-favorites.json`)!.bytes!.toString()).toBe('{bad');
    expect(JSON.stringify(f.nodes.get(`${HOME}\\profile-favorites.json`))).toBe(preference);
  });
  it('resolves active-profile collection shorthand under shared locks without explicit targeting', async () => {
    const f = fixture(); await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    f.file(`${HOME}\\active-profile`, 'work\n');
    expect(await addActiveProfileLibraryReference(f.references, 'library')).toMatchObject({ action: 'added', profileId: 'work' });
    expect(await removeActiveProfileLibraryReference(f.references, 'library')).toMatchObject({ action: 'removed', profileId: 'work' });
    expect(f.nodes.get(`${HOME}\\active-profile`)!.bytes!.toString()).toBe('work\n');
  });
  it('runs real Added Skill catalog and active shorthand effects, rejecting changed selection and preserving external ownership', async () => {
    const f = fixture(), target = 'C:\\boundary\\added';
    ensureWindowsPrivateDirectoryPath(f.backend, target); ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\locks\\profiles`);
    f.file(`${target}\\SKILL.md`, definition('added'));
    vi.mocked(fs.readlink).mockResolvedValue(target);
    const platformServices = createWindowsAddedSkillPlatformServicesForInternalTesting(f.backend, { lockIo: f.io, readLinkPath: async () => target, membershipIo: { unlink: async (path) => { f.nodes.delete(path); } } });
    const options = { bazframeHome: HOME, platformServices };
    expect(await addDefaultSkill(HOME, target, { platformServices })).toMatchObject({ action: 'added', id: 'added' });
    f.file(`${HOME}\\active-profile`, 'work\n');
    expect(await addActiveProfileSkill(options, 'added')).toMatchObject({ action: 'added', profileId: 'work' });
    await expect(removeDefaultSkill(HOME, 'added', { platformServices })).rejects.toMatchObject({ code: 'DEFAULT_SKILL_REFERENCED' });
    expect(await removeActiveProfileSkill(options, 'added')).toMatchObject({ action: 'removed' });
    await expect(addActiveProfileSkill({ ...options, testHooks: { beforeCommit: async () => { f.nodes.get(`${HOME}\\active-profile`)!.bytes = Buffer.from('different\n'); } } }, 'added')).rejects.toMatchObject({ code: 'PROFILE_SELECTION_CHANGED' });
    expect(f.nodes.has(`${HOME}\\profiles\\work\\skills\\added`)).toBe(false);
    expect(await removeDefaultSkill(HOME, 'added', { platformServices })).toMatchObject({ action: 'removed' });
    expect(f.nodes.get(`${target}\\SKILL.md`)!.bytes!.toString()).toBe(definition('added'));
  });
  it('retains only a private stale profile alias-cache object during real provisioning and refuses unknown unsafe cache state', async () => {
    const f = fixture(), cache = `${HOME}\\adapter-cache\\pi\\skill-aliases\\new`;
    ensureWindowsPrivateDirectoryPath(f.backend, `${cache}\\alias`); f.file(`${cache}\\alias\\SKILL.md`, 'cached bytes');
    const oldId = f.nodes.get(cache)!.id;
    const services = createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io });
    expect(await services.addProfile(HOME, 'new')).toMatchObject({ action: 'added' });
    expect(f.nodes.has(cache)).toBe(false);
    const retained = [...f.nodes.keys()].find((path) => path.includes('\\.bazframe-cache-') && f.nodes.get(path)!.id === oldId)!;
    expect(f.nodes.get(`${retained}\\alias\\SKILL.md`)!.bytes!.toString()).toBe('cached bytes');
    ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\adapter-cache\\pi\\skill-aliases\\bad`);
    f.reparse(`${HOME}\\adapter-cache\\pi\\skill-aliases\\bad\\unknown`);
    await expect(services.addProfile(HOME, 'bad')).rejects.toThrow();
    expect(f.nodes.has(`${HOME}\\profiles\\bad`)).toBe(false);
    expect(f.nodes.has(`${HOME}\\adapter-cache\\pi\\skill-aliases\\bad\\unknown`)).toBe(true);
  });
  it('lists and uses healthy immutable snapshots without mutable source availability, while reporting malformed records', async () => {
    const f = fixture();
    const absentBefore = f.snapshot();
    expect(await inspectGlobalSkillCollections('C:\\boundary\\absent-home', undefined, f.services.resolver)).toEqual({ collections: [], diagnostics: [] });
    expect(f.snapshot()).toBe(absentBefore);
    await addLibrary(f.lifecycleOptions, LIBRARY, f.deps); await addProfileLibraryReference(f.references, 'work', 'library');
    for (const path of [...f.nodes.keys()]) if (path === LIBRARY || path.startsWith(`${LIBRARY}\\`)) f.nodes.delete(path);
    const listed = await inspectGlobalSkillCollections(HOME, undefined, f.services.resolver);
    expect(listed.collections[0]).toMatchObject({ rebuildAvailability: 'unavailable', diagnostics: [] });
    expect(listed.collections[0]!.skills.map((skill) => skill.name)).toEqual(['child']);
    const activation = createWindowsProfileActivationServicesForInternalTesting(f.backend, { lockIo: f.io, selectionIo: f.io, journal: { io: f.io } });
    await useManagedProfile(HOME, 'work', activation);
    expect((await captureProfile({ bazframeHome: HOME, profileId: 'work' }, createWindowsProfileDataReads(f.backend).captureDependencies)).profile.resources).toHaveLength(1);
    f.file(`${HOME}\\libraries\\broken.json`, '{bad');
    const damaged = await inspectGlobalSkillCollections(HOME, undefined, f.services.resolver);
    expect(damaged.collections).toHaveLength(1); expect(damaged.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'invalid-collection', collectionId: 'broken' })]));
  });
  it('keeps unrecognized provider state an explicit refusal and admits externally owned local preparation roots', async () => {
    const f = fixture();
    f.nodes.get(LIBRARY)!.security = { ...f.security(LIBRARY), ownerSid: 'S-1-5-21-999' };
    expect(await addLibrary(f.lifecycleOptions, LIBRARY, f.deps)).toMatchObject({ action: 'added' });
    ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\providers`); f.file(`${HOME}\\providers\\unknown`, 'provider state');
    const descriptor = f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes;
    await expect(updateLibrary(f.lifecycleOptions, 'library', { ...f.deps, stateLockHeld: true })).rejects.toMatchObject({ code: 'WINDOWS_MANAGED_GIT_REFUSED' });
    await expect(inspectGlobalSkillCollections(HOME, undefined, f.services.resolver)).rejects.toMatchObject({ code: 'WINDOWS_MANAGED_GIT_REFUSED' });
    expect(f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes).toEqual(descriptor);
  });
  it.each(['no-effect', 'after-effect', 'ambiguous'])('reconciles descriptor replacement %s and never guesses success', async (effect) => {
    const f = fixture(); await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    const before = f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes;
    f.nodes.get(`${LIBRARY}\\child\\data.bin`)!.bytes = Buffer.from('candidate');
    const original = f.io.rename;
    vi.spyOn(f.io, 'rename').mockImplementation(async (source, destination) => {
      if (!destination.endsWith('\\libraries\\library.json')) return original(source, destination);
      if (effect === 'no-effect') throw new Error('sharing');
      await original(source, destination);
      if (effect === 'ambiguous') f.nodes.get(destination)!.id += 1000;
      throw new Error('after effect');
    });
    if (effect === 'after-effect') expect(await updateLibrary(f.lifecycleOptions, 'library', f.deps)).toMatchObject({ action: 'updated' });
    else await expect(updateLibrary(f.lifecycleOptions, 'library', f.deps)).rejects.toMatchObject({ code: effect === 'no-effect' ? 'WINDOWS_SELECTION_NO_EFFECT' : 'WINDOWS_SELECTION_AMBIGUOUS' });
    if (effect === 'no-effect') expect(f.nodes.get(`${HOME}\\libraries\\library.json`)!.bytes).toEqual(before);
  });
  it('lists rich physical/local profiles and resolves current selection without effects', async () => {
    const f = fixture();
    ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\profiles\\work\\skills\\local`); f.file(`${HOME}\\profiles\\work\\skills\\local\\SKILL.md`, definition('local'));
    const provisioningServices = createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io });
    f.file(`${HOME}\\active-profile`, 'work\n'); const before = f.snapshot();
    expect(await listProfiles(HOME, { provisioningServices })).toEqual({ profileIds: ['work'], diagnostics: [] });
    expect(await currentProfile(HOME, f.services.selectionReadServices)).toBe('work');
    expect(f.snapshot()).toBe(before);
  });
  it('keeps actual detached reference/descriptor payloads irrelevant when read-data sharing is denied, while retaining physical-leaf admission', async () => {
    const f = fixture(); await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    await addProfileLibraryReference(f.references, 'work', 'library');
    await removeProfileLibraryReference(f.references, 'work', 'library');
    await removeLibrary(f.lifecycleOptions, 'library', f.deps);
    const retained = [...f.nodes.keys()].filter((path) => path.includes('\\.bazframe-resource-'));
    expect(retained).toHaveLength(2);
    const original = f.backend.readStableFile.bind(f.backend), denied: string[] = [];
    vi.spyOn(f.backend, 'readStableFile').mockImplementation(async (path, max) => {
      if (retained.includes(path)) { denied.push(path); throw new Error('read-data sharing denied for irrelevant retained payload'); }
      return original(path, max);
    });
    expect((await readProfileSystemView(HOME, createWindowsProfileDataReads(f.backend).viewReads)).profiles).toHaveLength(1);
    expect((await captureProfileCollectionReferenceIndex(HOME, { kind: 'library', id: 'library' }, f.services.references)).diagnostics).toEqual([]);
    expect((await inspectGlobalSkillCollections(HOME, undefined, f.services.resolver)).collections).toEqual([]);
    await addLibrary(f.lifecycleOptions, LIBRARY, f.deps);
    expect(await addProfileLibraryReference(f.references, 'work', 'library')).toMatchObject({ action: 'added' });
    expect((await captureProfile({ bazframeHome: HOME, profileId: 'work' }, createWindowsProfileDataReads(f.backend).captureDependencies)).profile.resources).toHaveLength(1);
    expect(denied).toEqual([]);
    f.nodes.get(retained.find((path) => path.includes('\\profiles\\'))!)!.numberOfLinks = 2;
    await expect(readProfileSystemView(HOME, createWindowsProfileDataReads(f.backend).viewReads)).resolves.toHaveProperty('profiles');
    expect((await captureProfileCollectionReferenceIndex(HOME, { kind: 'library', id: 'library' }, f.services.references)).diagnostics).toEqual([]);
    f.nodes.get(retained.find((path) => path.includes('\\profiles\\'))!)!.reparseTag = 0xa0000003;
    await expect(readProfileSystemView(HOME, createWindowsProfileDataReads(f.backend).viewReads)).rejects.toThrow();
  });
});
