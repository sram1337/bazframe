import { BazframeError } from '../../../src/core/errors.js';
import type { PublicationPhase } from '../../../src/profile-publishing/transaction-journal.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { addProfile } from '../../../src/profiles/profile-management.js';
import { createWindowsProfileProvisioningServicesForInternalTesting } from '../../../src/profiles/win32-profile-provisioning.js';
import { createWindowsProfileLifecycleServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-lifecycle.js';
import { publishManagedProfile, type ProfilePublicationAdapter } from '../../../src/profile-publishing/profile-publication.js';
import { recoverProfilePublishingTransactions, type ProfilePublicationRecoveryAdapter, type PublicationRecoveryProof } from '../../../src/profile-publishing/profile-recovery.js';
import { parseProfileGithubSource } from '../../../src/profile-publishing/profile-github.js';
import { encodeCapturedProfile } from '../../../src/profile-publishing/captured-profile.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { readWindowsTransactionJournal, scanWindowsTransactionJournals } from '../../../src/profile-publishing/win32-transaction-journal.js';
import { createWindowsProfileDataReads } from '../../../src/profile-publishing/win32-profile-data-reads.js';
import { readProfileSystemView } from '../../../src/profile-publishing/profile-view.js';

const HOME = 'C:\\boundary\\home';
async function fixture() {
  const f = windowsProvisioningFixture();
  await addProfile(HOME, 'work', { provisioningServices: createWindowsProfileProvisioningServicesForInternalTesting(f.backend, { publicationIo: f.io, lockIo: f.io }) });
  let sidecarInterrupted = false, interrupt = false, beforeReplacement = false, phaseInterruption: PublicationPhase | undefined;
  const io = { ...f.io, async rename(source: string, target: string) { if (beforeReplacement && target.endsWith('\\.bazframe-profile-state.json')) throw new Error('before replacement'); await f.io.rename(source, target); if (interrupt && target.endsWith('\\.bazframe-profile-state.json')) { sidecarInterrupted = true; throw new Error('after replacement'); } } };
  const renameFile = f.backend.renameFileNoReplace;
  f.backend.renameFileNoReplace = async (...args) => { if (beforeReplacement && args[2] === '.bazframe-profile-state.json') throw new Error('before replacement'); await renameFile(...args); if (interrupt && args[2] === '.bazframe-profile-state.json') { sidecarInterrupted = true; throw new Error('after initial publication'); } };
  const services = createWindowsProfileLifecycleServicesForInternalTesting(f.backend, { stateIo: io, storageIo: f.io, lockIo: f.io, journal: { io: f.io } });
  const originalWrite = services.writeJournal;
  services.writeJournal = async (home, authority, journal) => { if (sidecarInterrupted) throw new Error('interrupted after CAS'); const written = await originalWrite(home, authority, journal); if (journal.phase === phaseInterruption) throw new Error('phase interruption'); return written; };
  const source = parseProfileGithubSource('git:owner/work');
  let exists = false, tip: string | null = null, visibility: 'private' | 'public' = 'private', proof: PublicationRecoveryProof | undefined;
  const metadata = () => ({ repositoryId: 42, origin: source.origin, owner: 'owner', repository: 'work', defaultBranch: 'main', visibility });
  let afterPush = () => {};
  const adapter: ProfilePublicationAdapter & ProfilePublicationRecoveryAdapter = {
    async resolveSource() { return source; }, async lookup() { return exists ? metadata() : undefined; }, async readTip() { return tip; },
    async createPrivate() { exists = true; return { metadata: metadata(), proof: {} }; },
    async setVisibility(_source: unknown, next: 'private' | 'public') { visibility = next; return { ...metadata(), ...proof! }; },
    async push(request) {
      const manifestBytes = Buffer.from(encodeCapturedProfile(request.profile, capturedProfileLimitPolicy()));
      const capturedManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
      const commit = tip === null ? 'a'.repeat(40) : 'b'.repeat(40), tree = 'c'.repeat(40);
      await request.beforeRefUpdate({ kind: 'profile-github-ref-update', ref: 'refs/heads/main', expectedOld: tip, newCommit: commit, capturedManifestSha256 });
      const expectedOld = tip; tip = commit;
      proof = { repositoryIdentityProven: true, repositoryId: 42, origin: source.origin, visibility, tip, tipParent: expectedOld, tree, canonicalTreeProven: true, capturedManifestSha256, profile: request.profile, manifestBytes, blobs: request.blobs };
      afterPush();
      return { kind: 'profile-github-publication-effects', repositoryCreated: request.repositoryCreated, refUpdated: true, commitCreated: true, visibilityChanged: false, ref: 'refs/heads/main', expectedOld, commit, tree, capturedManifestSha256 };
    },
    async proveRepository() { return { ...metadata(), repositoryIdentityProven: true }; },
    async prove() { if (proof === undefined) throw new BazframeError('PROFILE_RECOVERY_REMOTE_REF_ABSENT', 'No proved remote commit'); return proof; }
  };
  return { ...f, services, adapter, interrupt() { interrupt = true; }, interruptBefore() { beforeReplacement = true; }, interruptPhase(phase: PublicationPhase) { phaseInterruption = phase; }, resume() { interrupt = false; sidecarInterrupted = false; beforeReplacement = false; phaseInterruption = undefined; }, afterPush(fn: () => void) { afterPush = fn; }, async latestJournal() { const ids = await scanWindowsTransactionJournals(f.backend, HOME); return Promise.all(ids.map((id) => readWindowsTransactionJournal(f.backend, HOME, id.slice(0, -5)))); } };
}
describe('Windows shared publication and V2 recovery sidecar effects', () => {
  it('refuses root substitution during the final awaited sidecar proof', async () => {
    const f = await fixture(), root = HOME + '\\profiles\\work';
    const read = f.backend.readStableFile; let reads = 0;
    f.backend.readStableFile = async (path, max) => { const value = await read(path, max); if (path === root + '\\.bazframe-profile-state.json' && ++reads === 2) f.directory(root); return value; };
    await expect(publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services)).rejects.toThrow();
    expect((await f.latestJournal()).some((journal) => journal?.phase === 'COMMITTED')).toBe(false);
  });
  it('refuses recovery root replacement after the final managed-state read', async () => {
    const f = await fixture(), root = HOME + '\\profiles\\work';
    f.interruptPhase('LOCAL_STATE_INTENT');
    await expect(publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services)).rejects.toThrow();
    f.resume(); let published = false;
    const publication = f.services.publication!, publish = publication.publishSidecar, read = f.services.readManagedState;
    publication.publishSidecar = async (...args) => { await publish(...args); published = true; };
    Object.defineProperty(f.services, 'publication', { value: publication });
    f.services.readManagedState = async (...args) => { const value = await read(...args); if (published) f.directory(root); return value; };
    const result = await recoverProfilePublishingTransactions(HOME, f.adapter, f.services);
    expect(result.some((entry) => entry.action === 'committed')).toBe(false);
    expect((await f.latestJournal()).some((journal) => journal?.phase === 'COMMITTED')).toBe(false);
  });
  it('cannot return a scoped publication capture after its real lock authority expires', async () => {
    const f = await fixture(), read = f.backend.readStableFile;
    let reads = 0, release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), blocked = new Promise<void>((resolve) => { reached = resolve; });
    f.backend.readStableFile = async (path, max) => { const result = await read(path, max); if (path.endsWith('\\AGENTS.md') && ++reads === 10) { reached(); await gate; } return result; };
    let outcome!: Promise<unknown>;
    await f.services.withOperationLocks(HOME, ['@store', 'work'], async (authority) => { outcome = f.services.publication!.capture({ bazframeHome: HOME, profileId: 'work' }, authority); outcome.catch(() => undefined); await blocked; });
    release(); await expect(outcome).rejects.toThrow();
  });

  it.each(['INTENT', 'REPOSITORY_CREATED', 'PRIVATE_BEFORE_PUSH_INTENT', 'PRIVATE_BEFORE_PUSH_PROVEN', 'PUSH_INTENT', 'COMMIT_PUSH_PROVEN', 'PUBLIC_AFTER_PUSH_INTENT', 'PUBLIC_AFTER_PUSH_PROVEN', 'LOCAL_STATE_INTENT', 'LOCAL_STATE_PROVEN', 'COMMITTED'] as const)('recovers or retains predicate ambiguity at durable phase %s', async (phase) => {
    const f = await fixture(), root = HOME + '\\profiles\\work';
    const before = f.backend.inspectPath(root).object.fileId;
    f.interruptPhase(phase);
    await expect(publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services)).rejects.toThrow('phase interruption');
    f.resume();
    const result = await recoverProfilePublishingTransactions(HOME, f.adapter, f.services);
    const prePush = ['INTENT', 'REPOSITORY_CREATED', 'PRIVATE_BEFORE_PUSH_INTENT', 'PRIVATE_BEFORE_PUSH_PROVEN', 'PUSH_INTENT'].includes(phase);
    expect(result[0]?.action).toBe(prePush ? 'ambiguous' : phase === 'COMMITTED' ? 'terminal' : 'committed');
    expect(f.backend.inspectPath(root).object.fileId).toBe(before);
  });
  it.each([false, true])('converges after a proved no-effect sidecar move with repeated=%s and retained candidate', async (repeated) => {
    const f = await fixture();
    if (repeated) await publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services);
    f.interruptBefore();
    await expect(publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services)).rejects.toMatchObject({ code: 'WINDOWS_SELECTION_NO_EFFECT' });
    f.resume();
    expect((await recoverProfilePublishingTransactions(HOME, f.adapter, f.services)).some((result) => result.action === 'committed')).toBe(true);
    expect([...f.nodes.keys()].some((path) => /profiles\\work\\resource-[a-f0-9]{32}\.tmp$/u.test(path))).toBe(true);
    await readProfileSystemView(HOME, createWindowsProfileDataReads(f.backend).viewReads);
  });
  it('publishes twice without replacing profile root or authored bytes and retains exact prior sidecar', async () => {
    const f = await fixture(), root = HOME + '\\profiles\\work';
    f.file(root + '\\AGENTS.md', 'authored\r\n');
    const before = f.backend.inspectPath(root).object.fileId, instructions = f.nodes.get(root + '\\AGENTS.md')!;
    await publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services);
    const first = await f.services.readManagedState(HOME, 'work');
    await publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services);
    expect(f.backend.inspectPath(root).object.fileId).toBe(before);
    expect(f.nodes.get(root + '\\AGENTS.md')).toBe(instructions);
    expect((await f.services.readManagedState(HOME, 'work'))?.state.profileInstanceId).toBe(first?.state.profileInstanceId);
    expect((await f.latestJournal()).every((journal) => journal?.schemaVersion === 2 && journal.phase === 'COMMITTED')).toBe(true);
    expect([...f.nodes.keys()].filter((path) => path.includes('publication-state') && path.endsWith('previous.json'))).toHaveLength(1);
    await readProfileSystemView(HOME, createWindowsProfileDataReads(f.backend).viewReads);
  });
  it.each([false, true])('recovers crash after sidecar CAS with repeated=%s and retains post-push authored edits', async (repeated) => {
    const f = await fixture(), root = HOME + '\\profiles\\work';
    if (repeated) await publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services);
    const before = f.backend.inspectPath(root).object.fileId;
    f.interrupt(); f.afterPush(() => f.file(root + '\\AGENTS.md', 'edited after push\r\n'));
    await expect(publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services)).rejects.toThrow('interrupted after CAS');
    const state = await f.services.readManagedState(HOME, 'work');
    f.resume();
    const recovered = await recoverProfilePublishingTransactions(HOME, f.adapter, f.services);
    expect(recovered.some((item) => item.action === 'committed')).toBe(true);
    expect((await f.services.readManagedState(HOME, 'work'))?.sha256).toBe(state?.sha256);
    expect(f.backend.inspectPath(root).object.fileId).toBe(before);
    expect(f.nodes.get(root + '\\AGENTS.md')!.bytes!.toString()).toBe('edited after push\r\n');
  });
  it('never treats desired sidecar bytes on a different root as successful recovery', async () => {
    const f = await fixture(), root = HOME + '\\profiles\\work';
    f.interrupt();
    await expect(publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services)).rejects.toThrow();
    f.resume(); f.directory(root);
    const result = await recoverProfilePublishingTransactions(HOME, f.adapter, f.services);
    expect(result[0]?.action).toBe('ambiguous');
  });
  it.each(['missing', 'damaged', 'malformed-live'])('retains ambiguity when repeated-publication prior sidecar retention is %s', async (kind) => {
    const f = await fixture();
    await publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services);
    f.interrupt(); await expect(publishManagedProfile({ home: HOME, profileName: 'work', yes: true }, f.adapter, f.services)).rejects.toThrow(); f.resume();
    const path = [...f.nodes.keys()].find((name) => name.includes('publication-state') && name.endsWith('previous.json'))!;
    if (kind === 'missing') f.nodes.delete(path); else if (kind === 'malformed-live') f.file(HOME + '\\profiles\\work\\.bazframe-profile-state.json', '{}'); else f.file(path, '{}');
    const result = await recoverProfilePublishingTransactions(HOME, f.adapter, f.services);
    expect(result.some((item) => item.action === 'ambiguous')).toBe(true);
  });
});
