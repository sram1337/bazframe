import { chmod, lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import {
  assertProfileGithubRepositoryCreationProof,
  createPrivateProfileGithubRepository,
  lookupProfileGithubRepository,
  parseProfileGithubSource,
  requireProfileGithubAuthentication,
  setProfileGithubRepositoryVisibility
} from '../../../src/profile-publishing/profile-github.js';
import {
  createProfileGithubIsolation,
  defaultProfileGithubProcess,
  profileGithubGitArguments,
  type ProfileGithubProcess,
  type ProfileGithubProcessRequest,
  type ProfileGithubProcessResult
} from '../../../src/profile-publishing/profile-github-process.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

async function isolation(inherited: NodeJS.ProcessEnv = process.env) {
  temporary ??= await createTempDirectory('/tmp/bzf-profile-github-');
  await mkdir(temporary.path('tmp'), { mode: 0o700 });
  return createProfileGithubIsolation(temporary.path('tmp'), inherited, temporary.path('gh-config'));
}

function fake(results: ProfileGithubProcessResult[], calls: ProfileGithubProcessRequest[]): ProfileGithubProcess {
  return async (request) => {
    calls.push(request);
    const result = results.shift();
    if (result === undefined) throw new Error('unexpected process call');
    return result;
  };
}

const ok = (stdout = ''): ProfileGithubProcessResult => ({ status: 0, stdout, stderr: '' });
const failed = (stderr = ''): ProfileGithubProcessResult => ({ status: 1, stdout: '', stderr });

describe('profile GitHub source and process foundation', () => {
  it('canonicalizes only git:<owner>/<repository>', () => {
    expect(parseProfileGithubSource('git:Owner/My_Profile')).toEqual({
      entered: 'git:Owner/My_Profile',
      owner: 'owner',
      repository: 'my_profile',
      repositoryWithOwner: 'owner/my_profile',
      origin: 'github.com/owner/my_profile',
      fetchUrl: 'https://github.com/owner/my_profile.git'
    });
    for (const value of ['https://github.com/a/b', 'git:a', 'git:-a/b', 'git:a-/b', 'git:a/b.git', 'git:a/b/c', 'git:a/..']) {
      expect(() => parseProfileGithubSource(value)).toThrowError(expect.objectContaining({ code: 'PROFILE_GITHUB_SOURCE_INVALID' }));
    }
  });

  it('constructs an isolated allowlisted environment and fixed Git configuration', async () => {
    const isolated = await isolation({
      PATH: '/bin',
      TMPDIR: '/tmp',
      HOME: '/secret',
      GH_TOKEN: 'secret',
      HTTPS_PROXY: 'http://secret',
      GIT_DIR: '/hostile',
      GIT_CONFIG_COUNT: '2',
      GIT_ASKPASS: '/hostile',
      SSH_ASKPASS: '/hostile'
    });
    expect(isolated.environment).toMatchObject({
      PATH: '/bin', LANG: 'C', LC_ALL: 'C', HOME: isolated.home,
      XDG_CONFIG_HOME: isolated.xdgConfigHome,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: isolated.globalConfigFile,
      GIT_TERMINAL_PROMPT: '0'
    });
    for (const forbidden of ['GH_TOKEN', 'HTTPS_PROXY', 'GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_ASKPASS', 'SSH_ASKPASS']) {
      expect(isolated.environment[forbidden]).toBeUndefined();
    }
    expect(profileGithubGitArguments(isolated, ['status'])).toEqual([
      '-c', 'credential.helper=', '-c', `core.hooksPath=${isolated.hooksDirectory}`,
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'status'
    ]);
    expect(profileGithubGitArguments(isolated, [], { authenticated: true }).slice(-2)).toEqual([
      '-c', 'credential.helper=!gh auth git-credential'
    ]);
    await isolated.dispose();
  });

  it('terminates surviving pipe-holder process groups with TERM/KILL grace and bounded settlement', async () => {
    temporary = await createTempDirectory('/tmp/bzf-profile-github-');
    const survivor = temporary.path('survivor.sh');
    await writeFile(survivor, "#!/bin/sh\n(trap '' TERM; while :; do :; done) &\nexit 0\n");
    await chmod(survivor, 0o700);
    const started = Date.now();
    const result = await defaultProfileGithubProcess({
      executable: 'git', args: ['-c', `alias.hold=!${survivor}`, 'hold'], cwd: temporary.root,
      environment: { PATH: process.env.PATH, HOME: temporary.root, LANG: 'C', LC_ALL: 'C' }, stdin: 'ignore',
      timeoutMilliseconds: 30, terminationGraceMilliseconds: 25, maxStdoutBytes: 1024, maxStderrBytes: 1024
    });
    expect(result.failure).toBe('timeout');
    expect(result.uncertainTermination).not.toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('uses TERM then KILL for timed-out noncooperating process trees', async () => {
    temporary = await createTempDirectory('/tmp/bzf-profile-github-');
    const blocker = temporary.path('blocker.sh');
    await writeFile(blocker, "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n");
    await chmod(blocker, 0o700);
    const started = Date.now();
    const result = await defaultProfileGithubProcess({
      executable: 'git', args: ['-c', `alias.block=!${blocker}`, 'block'], cwd: temporary.root,
      environment: { PATH: process.env.PATH, HOME: temporary.root, LANG: 'C', LC_ALL: 'C' }, stdin: 'ignore',
      timeoutMilliseconds: 20, terminationGraceMilliseconds: 25, maxStdoutBytes: 1024, maxStderrBytes: 1024
    });
    expect(result.failure).toBe('timeout');
    expect(result.uncertainTermination).not.toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('retains identity-ambiguous isolation roots instead of recursively deleting a substitute', async () => {
    const isolated = await isolation();
    const moved = `${isolated.root}-moved`;
    await rename(isolated.root, moved);
    await mkdir(isolated.root);
    await expect(isolated.dispose()).rejects.toMatchObject({
      code: 'PROFILE_GITHUB_CLEANUP_UNPROVEN',
      message: expect.not.stringContaining(isolated.root)
    });
    await expect(lstat(isolated.root)).resolves.toMatchObject({});
    await expect(lstat(moved)).resolves.toMatchObject({});
  });

  it('never starts login in JSON/dry-run and permits exact interactive login only in human mode', async () => {
    const isolated = await isolation();
    const jsonCalls: ProfileGithubProcessRequest[] = [];
    await expect(requireProfileGithubAuthentication({ process: fake([ok(), failed()], jsonCalls), isolation: isolated, cwd: temporary!.root }, 'json'))
      .rejects.toMatchObject({ code: 'PROFILE_GITHUB_AUTH_REQUIRED' });
    expect(jsonCalls.map((call) => call.args)).toEqual([
      ['--version'], ['auth', 'status', '--hostname', 'github.com']
    ]);
    expect(jsonCalls.every((call) => call.stdin === 'ignore')).toBe(true);

    const humanCalls: ProfileGithubProcessRequest[] = [];
    await requireProfileGithubAuthentication({ process: fake([ok(), failed(), ok(), ok()], humanCalls), isolation: isolated, cwd: temporary!.root }, 'human');
    expect(humanCalls[2]).toMatchObject({
      args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
      stdin: 'inherit'
    });
    expect(humanCalls[3]!.args).toEqual(['auth', 'status', '--hostname', 'github.com']);
    await isolated.dispose();
  });

  it('reports missing gh with installation guidance and never relays child secrets', async () => {
    const isolated = await isolation();
    const missing = Object.assign(new Error('spawn gh ENOENT token=secret'), { code: 'ENOENT' });
    await expect(requireProfileGithubAuthentication({
      process: fake([{ status: null, stdout: '', stderr: 'token=secret', failure: 'spawn', error: missing }], []),
      isolation: isolated,
      cwd: temporary!.root
    }, 'dry-run')).rejects.toMatchObject({ code: 'PROFILE_GITHUB_CLI_MISSING', message: expect.not.stringContaining('secret') });
    await isolated.dispose();
  });

  it('uses injected gh contracts for lookup, private creation, and proved visibility changes', async () => {
    const isolated = await isolation();
    const source = parseProfileGithubSource('git:owner/repo');
    const calls: ProfileGithubProcessRequest[] = [];
    const privateMetadata = JSON.stringify({ id: 41, full_name: 'owner/repo', private: true, default_branch: 'main', token: 'ignored' });
    const publicMetadata = JSON.stringify({ id: 41, full_name: 'owner/repo', private: false, default_branch: 'main' });
    const process = fake([
      ok(privateMetadata),
      ok('Owner\n'), ok(), ok(privateMetadata),
      ok(), ok(publicMetadata)
    ], calls);
    const options = { process, isolation: isolated, cwd: temporary!.root };
    expect(await lookupProfileGithubRepository(options, source)).toMatchObject({ visibility: 'private', origin: source.origin });
    const created = await createPrivateProfileGithubRepository(options, source);
    expect(created).toMatchObject({
      metadata: { repositoryId: 41, visibility: 'private' },
      proof: { kind: 'profile-github-repository-creation-proof' }
    });
    expect(assertProfileGithubRepositoryCreationProof(created.proof, source.fetchUrl)).toBe(41);
    expect(() => assertProfileGithubRepositoryCreationProof(created.proof, 'https://github.com/owner/other.git'))
      .toThrowError(expect.objectContaining({ code: 'PROFILE_GITHUB_CREATION_PROOF_REQUIRED' }));
    expect(await setProfileGithubRepositoryVisibility(options, source, 'public')).toMatchObject({ visibility: 'public' });
    expect(calls.map((call) => call.args)).toEqual([
      ['api', 'repos/owner/repo'],
      ['api', 'user', '--jq', '.login'],
      ['repo', 'create', 'owner/repo', '--private'],
      ['api', 'repos/owner/repo'],
      ['repo', 'edit', 'owner/repo', '--visibility', 'public', '--accept-visibility-change-consequences'],
      ['api', 'repos/owner/repo']
    ]);
    expect(calls.every((call) => call.maxStdoutBytes > 0 && call.maxStderrBytes > 0
      && call.timeoutMilliseconds > 0 && call.terminationGraceMilliseconds > 0)).toBe(true);
    await isolated.dispose();
  });

  it('bounds injected fake output and rejects unproved or mismatched metadata', async () => {
    const isolated = await isolation();
    const source = parseProfileGithubSource('git:owner/repo');
    await expect(lookupProfileGithubRepository({
      process: fake([ok('x'.repeat(1024 * 1024 + 1))], []), isolation: isolated, cwd: temporary!.root
    }, source)).rejects.toMatchObject({ code: 'PROFILE_GITHUB_OUTPUT_LIMIT' });
    await expect(lookupProfileGithubRepository({
      process: fake([ok(JSON.stringify({ id: 41, full_name: 'other/repo', private: true, default_branch: 'main' }))], []), isolation: isolated, cwd: temporary!.root
    }, source)).rejects.toMatchObject({ code: 'PROFILE_GITHUB_METADATA_INVALID' });
    for (const branch of ['main//other', 'main/.', 'main.lock', 'main.', '/main']) {
      await expect(lookupProfileGithubRepository({
        process: fake([ok(JSON.stringify({ id: 41, full_name: 'owner/repo', private: true, default_branch: branch }))], []), isolation: isolated, cwd: temporary!.root
      }, source)).rejects.toMatchObject({ code: 'PROFILE_GITHUB_METADATA_INVALID' });
    }
    await expect(lookupProfileGithubRepository({
      process: fake([ok(JSON.stringify({ id: 0, full_name: 'owner/repo', private: true, default_branch: 'main' }))], []), isolation: isolated, cwd: temporary!.root
    }, source)).rejects.toMatchObject({ code: 'PROFILE_GITHUB_METADATA_INVALID' });
    await expect(lookupProfileGithubRepository({
      process: fake([{ status: 0, stdout: JSON.stringify({ id: 41, full_name: 'owner/repo', private: true, default_branch: 'main' }), stdoutBytes: Buffer.from('contradiction'), stderr: '' }], []), isolation: isolated, cwd: temporary!.root
    }, source)).rejects.toMatchObject({ code: 'PROFILE_GITHUB_OUTPUT_INVALID' });
    await isolated.dispose();
  });

  it('does not settle an asynchronous spawn failure until an active monitor completes', async () => {
    temporary = await createTempDirectory('/tmp/bzf-profile-github-');
    let releaseMonitor!: () => void;
    let reportMonitorStarted!: () => void;
    const monitorStarted = new Promise<void>((resolve) => { reportMonitorStarted = resolve; });
    const monitorRelease = new Promise<void>((resolve) => { releaseMonitor = resolve; });
    let samples = 0;
    let settled = false;
    const resultPromise = defaultProfileGithubProcess({
      executable: 'gh', args: ['version'], cwd: temporary.root,
      environment: { PATH: temporary.root, HOME: temporary.root, LANG: 'C', LC_ALL: 'C' }, stdin: 'ignore',
      timeoutMilliseconds: 5000, terminationGraceMilliseconds: 25, maxStdoutBytes: 1024, maxStderrBytes: 1024,
      monitor: async () => { samples += 1; reportMonitorStarted(); await monitorRelease; }
    });
    void resultPromise.finally(() => { settled = true; });
    await monitorStarted;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(settled).toBe(false);
    releaseMonitor();
    await expect(resultPromise).resolves.toMatchObject({ failure: 'spawn' });
    expect(samples).toBeGreaterThanOrEqual(2);
  });

  it('terminates fail-closed when serial active monitoring fails', async () => {
    temporary = await createTempDirectory('/tmp/bzf-profile-github-');
    const blocker = temporary.path('monitor-blocker.sh');
    await writeFile(blocker, '#!/bin/sh\nwhile :; do :; done\n');
    await chmod(blocker, 0o700);
    let samples = 0;
    const result = await defaultProfileGithubProcess({
      executable: 'git', args: ['-c', `alias.block=!${blocker}`, 'block'], cwd: temporary.root,
      environment: { PATH: process.env.PATH, HOME: temporary.root, LANG: 'C', LC_ALL: 'C' }, stdin: 'ignore',
      timeoutMilliseconds: 5000, terminationGraceMilliseconds: 25, maxStdoutBytes: 1024, maxStderrBytes: 1024,
      monitor: async () => { samples += 1; throw new Error('object bound'); }
    });
    expect(samples).toBe(1);
    expect(result).toMatchObject({ failure: 'monitor-failure', monitorError: { message: 'object bound' } });
  });
});
