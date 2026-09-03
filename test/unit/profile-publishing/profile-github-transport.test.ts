import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { encodeCapturedProfile, type CapturedProfileV1 } from '../../../src/profile-publishing/captured-profile.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import { createProductionProfileGithubTransportAdapter, createPublicProfileGithubTransportAdapter } from '../../../src/profile-publishing/profile-github-transport.js';
import { createProfileGithubIsolation, defaultProfileGithubProcess, type ProfileGithubProcess } from '../../../src/profile-publishing/profile-github-process.js';
import { capturePhysicalProfileExpectation } from '../../../src/profile-publishing/physical-profile-closure.js';
import { withProfileOperationLocks } from '../../../src/profile-publishing/profile-operation-lock.js';
import { recoverProfilePublishingTransactions } from '../../../src/profile-publishing/profile-recovery.js';
import { readOptionalManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';
import { readTransactionJournal, writeTransactionJournal, type PublicationJournalV1 } from '../../../src/profile-publishing/transaction-journal.js';

const exec = promisify(execFile);
let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await exec('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: temporary!.root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: temporary!.path('empty-gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C'
    }
  });
  return result.stdout.trim();
}

function capture(): { profile: CapturedProfileV1; blobs: Array<{ sha256: string; bytes: number; bytesValue: Buffer }>; manifestBytes: Buffer } {
  const bytesValue = Buffer.from('portable profile\n');
  const sha256 = createHash('sha256').update(bytesValue).digest('hex');
  const profile: CapturedProfileV1 = {
    schemaVersion: 1,
    kind: 'bazframe-captured-profile',
    profile: { name: 'work', instructions: { path: 'AGENTS.md', sha256, bytes: bytesValue.byteLength, executable: false } },
    resources: [],
    blobs: [{ sha256, bytes: bytesValue.byteLength }]
  };
  const manifestBytes = Buffer.from(encodeCapturedProfile(profile, capturedProfileLimitPolicy()));
  return { profile, blobs: [{ sha256, bytes: bytesValue.byteLength, bytesValue }], manifestBytes };
}

async function setup() {
  temporary = await createTempDirectory('/tmp/bzf-profile-transport-');
  const remote = temporary.path('remote.git');
  const quarantine = await temporary.mkdir('quarantine');
  const isolationParent = await temporary.mkdir('isolation');
  const ghConfig = await temporary.mkdir('gh-config');
  const home = await temporary.mkdir('home');
  await mkdir(`${home}/profiles`);
  await git(['init', '--bare', '--quiet', remote]);
  const isolation = await createProfileGithubIsolation(isolationParent, process.env, ghConfig);
  let visibility: 'private' | 'public' = 'private';
  let exists = false;
  let repositoryId = 41;
  let visibilityEdits = 0;
  let ghCalls = 0;
  const processRunner: ProfileGithubProcess = async (request) => {
    if (request.executable === 'gh') {
      ghCalls += 1;
      if (request.args[0] === 'api' && request.args[1] === 'user') return { status: 0, stdout: 'Owner\n', stderr: '' };
      if (request.args[0] === 'repo' && request.args[1] === 'create') { exists = true; return { status: 0, stdout: '', stderr: '' }; }
      if (request.args[0] === 'repo' && request.args[1] === 'edit') {
        visibility = request.args[request.args.indexOf('--visibility') + 1] as 'private' | 'public';
        visibilityEdits += 1;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (request.args[0] === 'api' && request.args[1] === 'repos/owner/work') {
        if (!exists) return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found (https://api.github.com/)\n' };
        return {
          status: 0,
          stdout: JSON.stringify({ id: repositoryId, full_name: 'owner/work', private: visibility === 'private', default_branch: 'main' }),
          stderr: ''
        };
      }
      throw new Error(`unexpected gh request: ${request.args.join(' ')}`);
    }
    const mapped = request.args.map((argument) => argument === 'https://github.com/owner/work.git' ? remote : argument);
    return defaultProfileGithubProcess({ ...request, args: ['-c', 'protocol.file.allow=always', ...mapped] });
  };
  const adapter = createProductionProfileGithubTransportAdapter({
    process: processRunner,
    isolation,
    cwd: temporary.root,
    quarantineParent: quarantine,
    authenticated: true
  });
  return {
    adapter,
    home,
    isolation,
    remote,
    visibility: () => visibility,
    visibilityEdits: () => visibilityEdits,
    changeRepositoryId: (value: number) => { repositoryId = value; },
    processRunner,
    quarantine,
    ghCalls: () => ghCalls
  };
}

describe('production profile GitHub transport adapter', () => {
  it('composes exact main publication, lifecycle inspection/listing, and PUSH_INTENT recovery with visibility convergence', async () => {
    const { adapter, home, isolation, visibility, visibilityEdits } = await setup();
    const source = await adapter.resolveSource('work', null);
    expect(source).toMatchObject({ origin: 'github.com/owner/work', fetchUrl: 'https://github.com/owner/work.git' });
    expect(await adapter.readTip(source)).toBeNull();
    const created = await adapter.createPrivate(source);
    expect(created).toMatchObject({ metadata: { repositoryId: 41, visibility: 'private' }, proof: { kind: 'profile-github-repository-creation-proof' } });
    expect(await adapter.readTip(source)).toBeNull();

    const fixture = capture();
    let intentSeen = false;
    const pushed = await adapter.push({
      source,
      profile: fixture.profile,
      blobs: fixture.blobs,
      expectedOld: null,
      repositoryCreated: true,
      creationProof: created.proof,
      beforeRefUpdate: async (intent) => { intentSeen = true; expect(intent.expectedOld).toBeNull(); }
    });
    expect(intentSeen).toBe(true);
    expect(await adapter.readTip(source)).toBe(pushed.commit);
    const inspected = await adapter.inspect(source);
    expect(inspected).toMatchObject({ source: { origin: source.origin }, commit: pushed.commit, latestCommit: pushed.commit, visibility: 'private' });
    expect(inspected.archiveBytes).toBe(fixture.manifestBytes.byteLength + fixture.blobs[0]!.bytes);
    expect(await adapter.list(source)).toEqual([{ commit: pushed.commit }]);

    const profilePath = `${home}/profiles/work`;
    await mkdir(profilePath);
    await writeFile(`${profilePath}/AGENTS.md`, fixture.blobs[0]!.bytesValue);
    const expected = await capturePhysicalProfileExpectation(home, 'work');
    const transactionId = '0123456789abcdef0123456789abcdef';
    const initial: PublicationJournalV1 = {
      schemaVersion: 1,
      kind: 'publication',
      transactionId,
      profileName: 'work',
      expectedProfile: { identity: expected.identity, sidecarSha256: null, profileClosureSha256: expected.profileClosureSha256 },
      origin: source.origin,
      expectedBaseCommit: null,
      capturedManifestSha256: pushed.capturedManifestSha256,
      originalVisibility: 'absent',
      desiredVisibility: 'public',
      repositoryCreated: true,
      repositoryId: 41,
      observedCommit: null,
      phase: 'INTENT'
    };
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let journal = await writeTransactionJournal(home, authority, initial);
      for (const phase of ['REPOSITORY_CREATED', 'PRIVATE_BEFORE_PUSH_INTENT', 'PRIVATE_BEFORE_PUSH_PROVEN', 'PUSH_INTENT'] as const) {
        journal = await writeTransactionJournal(home, authority, { ...journal, phase });
      }
    }, transactionId);

    await expect(recoverProfilePublishingTransactions(home, adapter)).resolves.toEqual([
      { transactionId, kind: 'publication', action: 'committed' }
    ]);
    expect(visibility()).toBe('public');
    expect(visibilityEdits()).toBe(1);
    expect((await readTransactionJournal(home, transactionId)).phase).toBe('COMMITTED');
    expect((await readOptionalManagedProfileState(home, 'work'))!.state.publication).toMatchObject({
      origin: source.origin,
      installedCommit: pushed.commit,
      latestSeenCommit: pushed.commit,
      visibility: 'public'
    });
    expect(await readFile(`${profilePath}/AGENTS.md`, 'utf8')).toBe('portable profile\n');

    const second = await adapter.push({
      source, profile: fixture.profile, blobs: fixture.blobs, expectedOld: pushed.commit,
      repositoryCreated: false, beforeRefUpdate: async (intent) => { expect(intent.expectedOld).toBe(pushed.commit); }
    });
    expect(second.commit).not.toBe(pushed.commit);
    expect(await adapter.list(source)).toEqual([{ commit: second.commit }, { commit: pushed.commit }]);
    const secondProof = await adapter.prove({
      ...initial,
      expectedBaseCommit: pushed.commit,
      capturedManifestSha256: second.capturedManifestSha256,
      repositoryCreated: false,
      observedCommit: null,
      phase: 'PUSH_INTENT'
    });
    expect(secondProof).toMatchObject({ tip: second.commit, tipParent: pushed.commit, tree: second.tree });
    await expect(adapter.push({
      source, profile: fixture.profile, blobs: fixture.blobs, expectedOld: pushed.commit,
      repositoryCreated: false, beforeRefUpdate: async () => undefined
    })).rejects.toMatchObject({ code: 'PROFILE_GITHUB_LEASE_STALE' });
    await isolation.dispose();
  }, 60_000);

  it('inspects and lists a public repository through strict Git without invoking gh', async () => {
    const { adapter, isolation, processRunner, quarantine, ghCalls } = await setup();
    const source = await adapter.resolveSource('work', null);
    const created = await adapter.createPrivate(source);
    const fixture = capture();
    await adapter.push({
      source, profile: fixture.profile, blobs: fixture.blobs, expectedOld: null,
      repositoryCreated: true, creationProof: created.proof, beforeRefUpdate: async () => undefined
    });
    const before = ghCalls();
    const publicRead = createPublicProfileGithubTransportAdapter({
      process: processRunner, isolation, cwd: temporary!.root, quarantineParent: quarantine
    });

    const snapshot = await publicRead.inspect(source);
    const versions = await publicRead.list(source);

    expect(snapshot).toMatchObject({ source: { origin: 'github.com/owner/work' }, visibility: 'public' });
    expect(versions).toEqual([{ commit: snapshot.commit }]);
    expect(ghCalls()).toBe(before);
    await isolation.dispose();
  });

  it('uses repository-only proof to converge pre-push visibility while main is still absent', async () => {
    const { adapter, home, isolation, visibility, visibilityEdits } = await setup();
    const source = await adapter.resolveSource('work', null);
    const created = await adapter.createPrivate(source);
    await adapter.setVisibility(source, 'public');
    expect(await adapter.readTip(source)).toBeNull();
    const transactionId = '2123456789abcdef0123456789abcdef';
    const initial: PublicationJournalV1 = {
      schemaVersion: 1, kind: 'publication', transactionId, profileName: 'work',
      expectedProfile: { identity: '1:2', sidecarSha256: null, profileClosureSha256: 'a'.repeat(64) },
      origin: source.origin, expectedBaseCommit: null, capturedManifestSha256: 'b'.repeat(64),
      originalVisibility: 'public', desiredVisibility: 'private', repositoryCreated: false,
      repositoryId: created.metadata.repositoryId, observedCommit: null, phase: 'INTENT'
    };
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      let journal = await writeTransactionJournal(home, authority, initial);
      journal = await writeTransactionJournal(home, authority, { ...journal, phase: 'REPOSITORY_CREATED' });
      await writeTransactionJournal(home, authority, { ...journal, phase: 'PRIVATE_BEFORE_PUSH_INTENT' });
    }, transactionId);
    await expect(recoverProfilePublishingTransactions(home, adapter)).resolves.toEqual([
      { transactionId, kind: 'publication', action: 'ambiguous' }
    ]);
    expect(visibility()).toBe('private');
    expect(visibilityEdits()).toBe(2);
    expect((await readTransactionJournal(home, transactionId)).phase).toBe('AMBIGUOUS');
    await isolation.dispose();
  }, 60_000);

  it('binds recovery proof to the immutable repository ID', async () => {
    const { adapter, isolation, changeRepositoryId } = await setup();
    const source = await adapter.resolveSource('work', null);
    const created = await adapter.createPrivate(source);
    const fixture = capture();
    const pushed = await adapter.push({
      source, profile: fixture.profile, blobs: fixture.blobs, expectedOld: null,
      repositoryCreated: true, creationProof: created.proof, beforeRefUpdate: async () => undefined
    });
    changeRepositoryId(42);
    const proof = await adapter.prove({
      schemaVersion: 1, kind: 'publication', transactionId: '1123456789abcdef0123456789abcdef', profileName: 'work',
      expectedProfile: { identity: '1:2', sidecarSha256: null, profileClosureSha256: 'a'.repeat(64) },
      origin: source.origin, expectedBaseCommit: null, capturedManifestSha256: pushed.capturedManifestSha256,
      originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: true,
      repositoryId: 41, observedCommit: null, phase: 'PUSH_INTENT'
    });
    expect(proof).toMatchObject({ repositoryIdentityProven: true, repositoryId: 42, tip: pushed.commit, tipParent: null, canonicalTreeProven: true });
    await isolation.dispose();
  }, 60_000);
});
