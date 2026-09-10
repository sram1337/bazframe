import { encodeWindowsExecutableMetadata } from '../../../src/profile-publishing/win32-profile-executable.js';
import { encodeProfileFavorites } from '../../../src/profiles/profile-favorites.js';
import { describe, expect, it } from 'vitest';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { addProfile } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { createWindowsProfileZipLifecycleDependencies } from '../../../src/profile-publishing/win32-profile-lifecycle.js';
import { createWindowsProfileActivationServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-activation.js';
import { useManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { importManagedProfile, updateManagedProfile, listManagedProfileVersions, useManagedProfileVersion, type GitProfileSnapshot } from '../../../src/profile-publishing/profile-lifecycle.js';
import { captureProfile } from '../../../src/profile-publishing/profile-capture.js';
import { createWindowsProfileDataReads } from '../../../src/profile-publishing/win32-profile-data-reads.js';
import { parseProfileGithubSource } from '../../../src/profile-publishing/profile-github.js';
import { ensureWindowsPrivateDirectoryPath } from '../../../src/state/win32-private-directory.js';

const HOME = 'C:\\boundary\\home', SOURCE = 'C:\\boundary\\source';
async function fixture() {
  const f = windowsProvisioningFixture();
  const provisioningServices = createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io });
  await addProfile(HOME, 'existing', { provisioningServices });
  await addProfile(SOURCE, 'portable', { provisioningServices });
  ensureWindowsPrivateDirectoryPath(f.backend, SOURCE + '\\profiles\\portable\\skills\\local');
  f.file(SOURCE + '\\profiles\\portable\\skills\\local\\SKILL.md', '---\nname: local\ndescription: Local fixture.\n---\n');
  f.file(SOURCE + '\\profiles\\portable\\skills\\local\\data.bin', 'binary\0\r\n');
  const reads = createWindowsProfileDataReads(f.backend);
  const source = parseProfileGithubSource('git:owner/portable');
  async function snapshot(commit: string): Promise<GitProfileSnapshot> {
    const captured = await captureProfile({ bazframeHome: SOURCE, profileId: 'portable', bundleRemote: false }, reads.captureDependencies);
    return { ...captured, source, commit, latestCommit: commit, visibility: 'private', archiveBytes: captured.manifestBytes.length + captured.blobs.reduce((sum, blob) => sum + blob.bytes, 0) };
  }
  const first = await snapshot('a'.repeat(40));
  f.file(SOURCE + '\\profiles\\portable\\AGENTS.md', 'second version\r\n');
  const second = await snapshot('b'.repeat(40));
  let latest = first;
  const options = { stateIo: f.io, storageIo: f.io, lockIo: f.io, journal: { io: f.io } };
  const dependencies = { ...createWindowsProfileZipLifecycleDependencies(f.backend, options), git: {
    async inspect(_source: unknown, revision?: string) { return { ...(revision === first.commit ? first : latest), latestCommit: latest.commit }; },
    async list() { return (latest === first ? [first] : [second, first]).map(({ commit }) => ({ commit })); }
  } };
  return { ...f, dependencies, options, first, second, advance() { latest = second; } };
}
describe('Windows linked lifecycle callers with real capture/materialization/swap effects', () => {
  it('imports, selects, updates, lists and uses versions while preserving logical instance and favorite/selection state', async () => {
    const f = await fixture();
    await importManagedProfile({ home: HOME, source: { kind: 'git', value: 'git:owner/portable' }, yes: true }, f.dependencies);
    await useManagedProfile(HOME, 'portable', createWindowsProfileActivationServicesForInternalTesting(f.backend, { selectionIo: f.io, lockIo: f.io, journal: { io: f.io } }));
    f.file(HOME + '\\profile-favorites.json', encodeProfileFavorites(['portable']));
    const favorites = Buffer.from(f.nodes.get(HOME + '\\profile-favorites.json')!.bytes!);
    const original = await f.dependencies.services!.readManagedState(HOME, 'portable');
    f.advance();
    expect(await updateManagedProfile({ home: HOME }, f.dependencies)).toMatchObject({ action: 'updated', commit: f.second.commit });
    expect(await listManagedProfileVersions(HOME, undefined, f.dependencies)).toEqual([{ commit: f.second.commit, current: true, latest: true }, { commit: f.first.commit, current: false, latest: false }]);
    expect(await useManagedProfileVersion({ home: HOME, revision: f.first.commit }, f.dependencies)).toMatchObject({ action: 'updated', commit: f.first.commit, latestCommit: f.second.commit });
    expect((await f.dependencies.services!.readManagedState(HOME, 'portable'))?.state.profileInstanceId).toBe(original?.state.profileInstanceId);
    expect((await f.dependencies.services!.readSelection(HOME))?.profileId).toBe('portable');
    expect(f.nodes.get(HOME + '\\profile-favorites.json')!.bytes).toEqual(favorites);
    expect(f.nodes.get(HOME + '\\profiles\\portable\\skills\\local\\data.bin')!.bytes!.toString()).toBe('binary\0\r\n');
    expect(await importManagedProfile({ home: HOME, source: { kind: 'git', value: 'git:owner/portable' } }, f.dependencies)).toMatchObject({ action: 'already-linked', active: true });
  });
  it('refuses divergent local bytes with yes alone and retains excluded source files through authorized version replacement', async () => {
    const f = await fixture();
    await importManagedProfile({ home: HOME, source: { kind: 'git', value: 'git:owner/portable' }, yes: true }, f.dependencies);
    f.advance(); f.file(HOME + '\\profiles\\portable\\AGENTS.md', 'local divergence');
    await expect(updateManagedProfile({ home: HOME, profileName: 'portable', yes: true }, f.dependencies)).rejects.toMatchObject({ code: 'PROFILE_LOCAL_DIVERGENCE' });
    await updateManagedProfile({ home: HOME, profileName: 'portable', overwrite: true }, f.dependencies);
    ensureWindowsPrivateDirectoryPath(f.backend, HOME + '\\profiles\\portable\\skills\\local\\tests');
    f.file(HOME + '\\profiles\\portable\\skills\\local\\tests\\retained.txt', 'excluded source bytes');
    const modePath = HOME + '\\profiles\\portable\\.bazframe-win32-executable.json';
    const modes = JSON.parse(f.nodes.get(modePath)!.bytes!.toString()) as { files: Array<{ path: string; executable: boolean }> };
    f.file(modePath, encodeWindowsExecutableMetadata({ schemaVersion: 1, files: [...modes.files, { path: 'skills/local/tests/retained.txt', executable: true }].sort((a, b) => a.path < b.path ? -1 : 1) }).toString());
    await useManagedProfileVersion({ home: HOME, profileName: 'portable', revision: f.first.commit }, f.dependencies);
    expect(f.nodes.get(HOME + '\\profiles\\portable\\skills\\local\\tests\\retained.txt')!.bytes!.toString()).toBe('excluded source bytes');
    expect((await f.dependencies.services!.capture(HOME, 'portable'))!.closure.entries.find((entry) => entry.path === 'skills/local/tests/retained.txt')).toMatchObject({ executable: true });
  });
});
