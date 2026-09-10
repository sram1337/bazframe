import { BazframeError } from '../../../src/core/errors.js';
import { createManagedGitAcquisitionInspector } from '../../../src/providers/managed-git-acquisition-inspection.js';
import { managedGitAcquisitionLimitPolicy } from '../../../src/profile-portability/profile-portability-policy.js';
import { windowsResourceIdentity } from '../../../src/providers/managed-git-services.js';
import { describe, expect, it } from 'vitest';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { createWindowsGitInspectionEffects, moveWindowsManagedGitDirectory } from '../../../src/providers/win32-managed-git-services.js';

function fixture() {
  const f = windowsProvisioningFixture();
  const sourceParent = 'C:\\state\\staging', destinationParent = 'C:\\state\\checkouts';
  const source = sourceParent + '\\repo', destination = destinationParent + '\\repo';
  for (const path of ['C:\\state', sourceParent, destinationParent, source]) f.directory(path);
  f.file(source + '\\payload', 'retained');
  const object = f.backend.inspectPath(source).object;
  let held = true;
  const options = { backend: f.backend, source, destination, expected: { domain: 'windows' as const, volumeIdentity: object.volumeIdentity, fileId: object.fileId, creationTime: object.creationTime }, authority: { assertHeld() { if (!held) throw new Error('expired authority'); } } };
  return { ...f, options, expire() { held = false; } };
}
describe('Windows managed Git directory movement', () => {
  it('refuses cross-volume parents before invoking native movement', async () => {
    const f = fixture(), inspect = f.backend.inspectPath; let moved = false;
    f.backend.inspectPath = (path) => {
      const value = inspect(path);
      return path === 'C:\\state\\checkouts' ? { ...value, volume: { ...value.volume, identity: '0020000000000002' }, object: { ...value.object, volumeIdentity: '0020000000000002' } } : value;
    };
    f.backend.moveDirectoryNoReplace = async () => { moved = true; };
    await expect(moveWindowsManagedGitDirectory(f.options)).rejects.toThrow();
    expect(moved).toBe(false); expect(f.nodes.has(f.options.source)).toBe(true);
  });
  it('moves across two admitted parents without changing source identity', async () => {
    const f = fixture();
    await moveWindowsManagedGitDirectory(f.options);
    expect(f.nodes.has(f.options.source)).toBe(false);
    expect(f.backend.inspectPath(f.options.destination).object.fileId).toBe(f.options.expected.fileId);
    expect(f.nodes.get(f.options.destination + '\\payload')?.bytes?.toString()).toBe('retained');
  });
  it('reconciles move-then-error as success, but a no-effect syscall as failure', async () => {
    const f = fixture(), native = f.backend.moveDirectoryNoReplace;
    f.backend.moveDirectoryNoReplace = async (...args) => { await native(...args); throw new Error('after move'); };
    await expect(moveWindowsManagedGitDirectory(f.options)).resolves.toBeUndefined();
    const g = fixture(); g.backend.moveDirectoryNoReplace = async () => {};
    await expect(moveWindowsManagedGitDirectory(g.options)).rejects.toMatchObject({ code: 'WINDOWS_MANAGED_GIT_MOVE_NO_EFFECT' });
    expect(g.nodes.has(g.options.source)).toBe(true);
  });
  it.each(['repo', 'REPO'])('refuses occupied or aliased destinations %s without replacing them', async (name) => {
    const f = fixture(); f.directory('C:\\state\\checkouts\\' + name);
    const before = f.snapshot();
    await expect(moveWindowsManagedGitDirectory(f.options)).rejects.toMatchObject({ code: 'WINDOWS_MANAGED_GIT_MOVE_UNPROVEN' });
    expect(f.snapshot()).toBe(before);
  });
  it('retains moved content and replacement source when source changes in the result window', async () => {
    const f = fixture(), native = f.backend.moveDirectoryNoReplace;
    f.backend.moveDirectoryNoReplace = async (...args) => { await native(...args); f.directory(f.options.source); };
    await expect(moveWindowsManagedGitDirectory(f.options)).rejects.toMatchObject({ code: 'WINDOWS_MANAGED_GIT_MOVE_UNPROVEN' });
    expect(f.nodes.has(f.options.source)).toBe(true); expect(f.nodes.has(f.options.destination)).toBe(true);
  });
  it('cannot report success after authority expiry', async () => {
    const f = fixture(), native = f.backend.moveDirectoryNoReplace;
    f.backend.moveDirectoryNoReplace = async (...args) => { await native(...args); f.expire(); };
    await expect(moveWindowsManagedGitDirectory(f.options)).rejects.toThrow('expired authority');
    expect(f.nodes.has(f.options.destination)).toBe(true);
  });
  it('refuses a destination race without attempting rollback replacement', async () => {
    const f = fixture(), native = f.backend.moveDirectoryNoReplace;
    f.backend.moveDirectoryNoReplace = async (...args) => { f.directory(f.options.destination); await native(...args); };
    await expect(moveWindowsManagedGitDirectory(f.options)).rejects.toMatchObject({ code: 'WINDOWS_MANAGED_GIT_MOVE_UNPROVEN' });
    expect(f.nodes.has(f.options.source)).toBe(true); expect(f.nodes.has(f.options.destination)).toBe(true);
  });
});

describe('Windows inspection under the shared mutable acquisition sampler', () => {
  it('tolerates exact transient leaf absence, but not final absence, required-root loss or access errors', async () => {
    const f = windowsProvisioningFixture(), container = 'C:\\state\\acquire', root = container + '\\repo', pack = root + '\\.git\\objects\\pack', leaf = pack + '\\tmp_pack';
    for (const path of ['C:\\state', container, root, root + '\\.git', root + '\\.git\\objects', pack]) f.directory(path);
    f.file(leaf, 'temporary');
    const effects = createWindowsGitInspectionEffects(f.backend), open = effects.opendir;
    effects.opendir = async (...args) => { const stream = await open(...args); if (args[0] === pack) f.nodes.delete(leaf); return stream; };
    const inspector = createManagedGitAcquisitionInspector(effects), limits = managedGitAcquisitionLimitPolicy(), identity = windowsResourceIdentity(f.backend.inspectPath(container));
    await inspector.sampleManagedGitAcquisitionInProgress(container, root, limits, identity);
    f.file(leaf, 'temporary'); await expect(inspector.inspectManagedGitAcquisition(container, root, limits)).rejects.toThrow();
    effects.opendir = open; f.file(leaf, 'temporary'); const inspect = f.backend.inspectPath;
    f.backend.inspectPath = (path) => { if (path === leaf) throw new BazframeError('WINDOWS_ACCESS_DENIED', 'access'); return inspect(path); };
    await expect(inspector.sampleManagedGitAcquisitionInProgress(container, root, limits, identity)).rejects.toMatchObject({ code: 'WINDOWS_ACCESS_DENIED' });
    f.backend.inspectPath = inspect; f.nodes.delete(container);
    await expect(inspector.sampleManagedGitAcquisitionInProgress(container, root, limits, identity)).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_CHANGED' });
  });
});
