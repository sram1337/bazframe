import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import type { CapturedProfileV1 } from '../../../src/profile-publishing/captured-profile.js';
import {
  listCanonicalProfileGitVersions,
  publishCanonicalProfileGit,
  readCanonicalProfileGitTip,
  readCanonicalProfileGitVersion,
  type ProfileGithubGitBlob,
  type ProfileGithubRefUpdateIntent
} from '../../../src/profile-publishing/profile-github-git.js';
import {
  createProfileGithubIsolation,
  defaultProfileGithubProcess,
  type ProfileGithubProcessResult
} from '../../../src/profile-publishing/profile-github-process.js';
import {
  createPrivateProfileGithubRepository,
  parseProfileGithubSource
} from '../../../src/profile-publishing/profile-github.js';

const exec = promisify(execFile);
let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

function fixture(bytesValue = Buffer.from('portable\n')): { profile: CapturedProfileV1; blobs: ProfileGithubGitBlob[] } {
  const sha256 = createHash('sha256').update(bytesValue).digest('hex');
  return {
    profile: {
      schemaVersion: 1,
      kind: 'bazframe-captured-profile',
      profile: { name: 'portable', instructions: { path: 'AGENTS.md', sha256, bytes: bytesValue.byteLength, executable: false } },
      resources: [],
      blobs: [{ sha256, bytes: bytesValue.byteLength }]
    },
    blobs: [{ sha256, bytes: bytesValue.byteLength, bytesValue }]
  };
}

async function expectRetainedGitWorkspaces(quarantine: string): Promise<void> {
  const entries = await readdir(quarantine);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every((entry) => /^bazframe-profile-(?:publish|read|tip|list)-/u.test(entry))).toBe(true);
}

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

async function setup() {
  temporary = await createTempDirectory('/tmp/bzf-profile-github-git-');
  const remote = temporary.path('remote.git');
  const quarantine = temporary.path('quarantine');
  const isolationParent = temporary.path('isolation');
  const ghConfig = temporary.path('gh-config');
  await Promise.all([mkdir(quarantine), mkdir(isolationParent), mkdir(ghConfig)]);
  await git(['init', '--bare', '--quiet', remote]);
  const isolated = await createProfileGithubIsolation(isolationParent, process.env, ghConfig);
  const common = {
    process: defaultProfileGithubProcess,
    isolation: isolated,
    cwd: temporary.root,
    allowFileProtocol: true as const,
    quarantineParent: quarantine
  };
  return { remote, quarantine, isolated, common };
}

describe('captured-profile Git transport', () => {
  it('publishes only the canonical tree with exact expected-old leases and typed intent/effects', async () => {
    const { remote, quarantine, isolated, common } = await setup();
    const capture = fixture();
    const intents: ProfileGithubRefUpdateIntent[] = [];
    const first = await publishCanonicalProfileGit({
      ...common, remoteUrl: remote, quarantineParent: quarantine,
      ...capture, expectedOld: null, repositoryCreated: true,
      beforeRefUpdate: (intent) => { intents.push(intent); }
    });
    expect(first).toMatchObject({
      kind: 'profile-github-publication-effects', repositoryCreated: true,
      refUpdated: true, commitCreated: true, visibilityChanged: false,
      ref: 'refs/heads/main', expectedOld: null
    });
    expect(intents).toEqual([{
      kind: 'profile-github-ref-update', ref: 'refs/heads/main', expectedOld: null,
      newCommit: first.commit, capturedManifestSha256: first.capturedManifestSha256
    }]);
    await expectRetainedGitWorkspaces(quarantine);

    const snapshot = await readCanonicalProfileGitVersion(remote, first.commit, common);
    expect(snapshot).toMatchObject({ tip: first.commit, commit: first.commit, parent: null, tree: first.tree, profile: capture.profile });
    expect(await readCanonicalProfileGitTip(remote, common)).toBe(first.commit);
    expect(snapshot.blobs[0]!.bytesValue).toEqual(Buffer.from('portable\n'));

    const second = await publishCanonicalProfileGit({
      ...common, remoteUrl: remote, quarantineParent: quarantine,
      ...capture, expectedOld: first.commit, repositoryCreated: false
    });
    expect(second.commit).not.toBe(first.commit);
    expect(second.tree).toBe(first.tree);
    expect(await listCanonicalProfileGitVersions(remote, common)).toEqual({ branch: 'main', tip: second.commit, commits: [second.commit, first.commit] });
    expect((await readCanonicalProfileGitVersion(remote, second.commit, common)).parent).toBe(first.commit);
    expect((await git(['--git-dir', remote, 'rev-list', '--parents', '-n', '1', second.commit])).split(' ')).toEqual([second.commit, first.commit]);

    await expect(publishCanonicalProfileGit({
      ...common, remoteUrl: remote, quarantineParent: quarantine,
      ...capture, expectedOld: first.commit, repositoryCreated: false
    })).rejects.toMatchObject({ code: 'PROFILE_GITHUB_LEASE_STALE' });
    await expectRetainedGitWorkspaces(quarantine);
    await isolated.dispose();
  }, 30_000);

  it('reads a blob larger than gitStreamBytes from the proved checkout without widening process output', async () => {
    const { remote, isolated, common } = await setup();
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const capture = fixture(bytes);
    const limitPolicy = { maxBlobBytes: bytes.byteLength, maxAggregateBytes: bytes.byteLength + 1024 * 1024 };
    const published = await publishCanonicalProfileGit({ ...common, limitPolicy, remoteUrl: remote, ...capture, expectedOld: null, repositoryCreated: true });

    const snapshot = await readCanonicalProfileGitVersion(remote, published.commit, { ...common, limitPolicy });

    expect(snapshot.blobs[0]!.bytesValue).toEqual(bytes);
    await isolated.dispose();
  });

  it('resolves full IDs/unique prefixes only on the default branch and refuses ambiguity or unreachable commits', async () => {
    const { remote, quarantine, isolated, common } = await setup();
    const capture = fixture();
    const first = await publishCanonicalProfileGit({ ...common, remoteUrl: remote, quarantineParent: quarantine, ...capture, expectedOld: null, repositoryCreated: true });
    const clone = temporary!.path('work');
    await git(['clone', '--quiet', '--branch', 'main', remote, clone]);
    await git(['config', 'user.name', 'Test'], clone);
    await git(['config', 'user.email', 'test@invalid.example'], clone);
    const commits = [first.commit];
    for (let index = 0; index < 17; index += 1) {
      await git(['commit', '--quiet', '--allow-empty', '-m', `version ${index}`], clone);
      commits.push(await git(['rev-parse', 'HEAD'], clone));
    }
    await git(['push', '--quiet', 'origin', 'HEAD:main'], clone);
    const byFirst = new Map<string, string[]>();
    for (const commit of commits) byFirst.set(commit[0]!, [...(byFirst.get(commit[0]!) ?? []), commit]);
    const ambiguousPrefix = [...byFirst].find(([, values]) => values.length > 1)![0];
    await expect(readCanonicalProfileGitVersion(remote, ambiguousPrefix, common)).rejects.toMatchObject({ code: 'PROFILE_GITHUB_COMMIT_AMBIGUOUS' });

    const tip = commits.at(-1)!;
    const uniqueLength = Array.from({ length: tip.length }, (_, index) => index + 1)
      .find((length) => commits.filter((commit) => commit.startsWith(tip.slice(0, length))).length === 1)!;
    const selected = await readCanonicalProfileGitVersion(remote, tip.slice(0, uniqueLength), common);
    expect(selected.commit).toBe(tip);
    expect(selected.tip).toBe(tip);

    const tree = await git(['rev-parse', 'HEAD^{tree}'], clone);
    const dangling = await git(['commit-tree', tree, '-m', 'side'], clone);
    await git(['push', '--quiet', 'origin', `${dangling}:refs/heads/side`], clone);
    await expect(readCanonicalProfileGitVersion(remote, dangling, common)).rejects.toMatchObject({ code: 'PROFILE_GITHUB_COMMIT_UNREACHABLE' });
    await expect(readCanonicalProfileGitVersion(remote, `${tip}^`, common)).rejects.toMatchObject({ code: 'PROFILE_GITHUB_GIT_INVALID' });
    await isolated.dispose();
  }, 30_000);

  it('streams exact blobs larger than the Git control-output limit', async () => {
    const { remote, isolated, common } = await setup();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0xa5);
    const capture = fixture(bytes);
    const published = await publishCanonicalProfileGit({ ...common, remoteUrl: remote, ...capture, expectedOld: null, repositoryCreated: true });
    const snapshot = await readCanonicalProfileGitVersion(remote, published.commit, common);
    expect(snapshot.blobs[0]!.bytesValue).toEqual(bytes);
    await isolated.dispose();
  }, 30_000);

  it('refuses non-main selection, absent main, and missing first-creation proof', async () => {
    const { remote, isolated, common } = await setup();
    await expect(readCanonicalProfileGitVersion(remote, undefined, { ...common, branch: 'master' } as typeof common))
      .rejects.toMatchObject({ code: 'PROFILE_GITHUB_GIT_INVALID' });
    await expect(readCanonicalProfileGitVersion(remote, undefined, common))
      .rejects.toMatchObject({ code: 'PROFILE_GITHUB_MAIN_UNAVAILABLE' });
    await expect(publishCanonicalProfileGit({ ...common, remoteUrl: remote, ...fixture(), expectedOld: null, repositoryCreated: false }))
      .rejects.toMatchObject({ code: 'PROFILE_GITHUB_CREATION_PROOF_REQUIRED' });
    await isolated.dispose();
  });

  it('bounds fetched object storage during active monitoring and retains the owned quarantine without traversal', async () => {
    const { remote, quarantine, isolated, common } = await setup();
    const capture = fixture(Buffer.alloc(4096, 0x61));
    const published = await publishCanonicalProfileGit({ ...common, remoteUrl: remote, ...capture, expectedOld: null, repositoryCreated: true });
    await expect(readCanonicalProfileGitVersion(remote, published.commit, {
      ...common,
      acquisitionLimits: { maxGitObjectBytes: 1 }
    })).rejects.toMatchObject({ code: 'PROFILE_GITHUB_GIT_OBJECT_LIMIT' });
    await expectRetainedGitWorkspaces(quarantine);
    await isolated.dispose();
  });

  it('rejects contradictory injected byte/text output on the byte-consuming path', async () => {
    const { remote, isolated, common } = await setup();
    const capture = fixture();
    const published = await publishCanonicalProfileGit({ ...common, remoteUrl: remote, ...capture, expectedOld: null, repositoryCreated: true });
    const process = async (request: Parameters<typeof defaultProfileGithubProcess>[0]) => {
      const result = await defaultProfileGithubProcess(request);
      return request.args.includes('checkout-index') ? { ...result, stdout: 'contradiction' } : result;
    };
    await expect(readCanonicalProfileGitVersion(remote, published.commit, { ...common, process }))
      .rejects.toMatchObject({ code: 'PROFILE_GITHUB_OUTPUT_INVALID' });
    await isolated.dispose();
  });

  it('re-proves immutable repository ID immediately before first push', async () => {
    const { remote, isolated, common } = await setup();
    const source = parseProfileGithubSource('git:owner/profile_name');
    const creationResults: ProfileGithubProcessResult[] = [
      { status: 0, stdout: 'owner\n', stderr: '' },
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: JSON.stringify({ id: 41, full_name: 'owner/profile_name', private: true, default_branch: 'main' }), stderr: '' }
    ];
    const created = await createPrivateProfileGithubRepository({
      process: async () => creationResults.shift()!, isolation: isolated, cwd: temporary!.root
    }, source);
    let metadataLookups = 0;
    const process = async (request: Parameters<typeof defaultProfileGithubProcess>[0]): Promise<ProfileGithubProcessResult> => {
      if (request.executable === 'gh') {
        metadataLookups += 1;
        return { status: 0, stdout: JSON.stringify({ id: 42, full_name: 'owner/profile_name', private: true, default_branch: 'main' }), stderr: '' };
      }
      const args = request.args.map((argument) => argument === source.fetchUrl ? remote : argument);
      return defaultProfileGithubProcess({ ...request, args: ['-c', 'protocol.file.allow=always', ...args] });
    };
    await expect(publishCanonicalProfileGit({
      ...common,
      allowFileProtocol: false,
      authenticated: true,
      process,
      remoteUrl: source.fetchUrl,
      ...fixture(),
      expectedOld: null,
      repositoryCreated: true,
      repositoryCreationProof: created.proof
    })).rejects.toMatchObject({ code: 'PROFILE_GITHUB_CREATION_PROOF_STALE' });
    expect(metadataLookups).toBe(1);
    await expect(git(['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/main'])).rejects.toBeDefined();
    await isolated.dispose();
  }, 30_000);

  it('requires authenticated helper authority for production HTTPS publication before any network request', async () => {
    const { isolated, common } = await setup();
    let calls = 0;
    await expect(publishCanonicalProfileGit({
      ...common, allowFileProtocol: true, authenticated: true,
      process: async () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; },
      remoteUrl: 'https://github.com/owner/profile_name.git', ...fixture(), expectedOld: null, repositoryCreated: true
    })).rejects.toMatchObject({ code: 'PROFILE_GITHUB_GIT_INVALID' });
    expect(calls).toBe(0);
    await expect(publishCanonicalProfileGit({
      ...common, allowFileProtocol: false, authenticated: false,
      process: async () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; },
      remoteUrl: 'https://github.com/owner/profile_name.git', ...fixture(), expectedOld: null, repositoryCreated: true
    })).rejects.toMatchObject({ code: 'PROFILE_GITHUB_AUTH_REQUIRED' });
    expect(calls).toBe(0);
    await expect(publishCanonicalProfileGit({
      ...common, allowFileProtocol: false, authenticated: true,
      process: async () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; },
      remoteUrl: 'https://github.com/owner/profile_name.git', ...fixture(), expectedOld: null, repositoryCreated: true
    })).rejects.toMatchObject({ code: 'PROFILE_GITHUB_CREATION_PROOF_REQUIRED' });
    expect(calls).toBe(0);
    await isolated.dispose();
  });

  it('rejects local config or alternates introduced during a sensitive Git phase and retains owned state', async () => {
    const { remote, quarantine, isolated, common } = await setup();
    const process = async (request: Parameters<typeof defaultProfileGithubProcess>[0]) => {
      const result = await defaultProfileGithubProcess(request);
      if (request.args.includes('ls-remote')) {
        const marker = request.args.indexOf('-C');
        const workspace = request.args[marker + 1]!;
        await writeFile(`${workspace}/.git/objects/info/alternates`, '/hostile\n');
      }
      return result;
    };
    await expect(publishCanonicalProfileGit({ ...common, process, remoteUrl: remote, ...fixture(), expectedOld: null, repositoryCreated: true }))
      .rejects.toMatchObject({ code: 'PROFILE_GITHUB_GIT_INVALID' });
    await expectRetainedGitWorkspaces(quarantine);
    await isolated.dispose();
  });

  it('refuses local remotes without explicit test-only file protocol authority', async () => {
    const { remote, quarantine, isolated, common } = await setup();
    await expect(publishCanonicalProfileGit({
      ...common,
      allowFileProtocol: false,
      remoteUrl: remote,
      quarantineParent: quarantine,
      ...fixture(),
      expectedOld: null, repositoryCreated: true
    })).rejects.toMatchObject({ code: 'PROFILE_GITHUB_GIT_INVALID' });
    await isolated.dispose();
  });
});
