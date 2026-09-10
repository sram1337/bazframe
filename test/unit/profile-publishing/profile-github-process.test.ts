import { EventEmitter } from 'node:events';
import { type ChildProcess, type spawn } from 'node:child_process';
import { runBoundedProfileGithubProcess, createResolvedProfileGithubProcess, type ProfileGithubProcessRequest } from '../../../src/profile-publishing/profile-github-process.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { createOwnedProfileGithubDirectory, createProfileGithubIsolation } from '../../../src/profile-publishing/profile-github-process.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

describe('profile GitHub owned-directory disposal', () => {
  it('retains nested workspace state without traversing files or following links', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('workspaces');
    const outside = await temporary.mkdir('outside');
    await writeFile(join(outside, 'keep.txt'), 'keep\n');
    const owned = await createOwnedProfileGithubDirectory(parent, 'workspace-');
    await mkdir(join(owned.path, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(owned.path, 'nested', 'deeper', 'data.bin'), Buffer.alloc(64 * 1024, 1));
    await symlink(outside, join(owned.path, 'outside-link'));

    await expect(owned.dispose()).resolves.toEqual({ disposition: 'retained', identityProved: true });

    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(await readdir(parent)).toEqual([basename(owned.path)]);
    expect(await readFile(join(owned.path, 'nested', 'deeper', 'data.bin'))).toHaveLength(64 * 1024);
    await expect(owned.dispose()).resolves.toEqual({ disposition: 'retained', identityProved: true });
  });

  it('retains a successful process isolation under its private random path', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('isolations');
    const isolation = await createProfileGithubIsolation(parent, { PATH: process.env.PATH });
    await writeFile(join(isolation.home, 'temporary.txt'), 'temporary\n');

    await expect(isolation.dispose()).resolves.toEqual({ disposition: 'retained', identityProved: true });

    expect(await readdir(parent)).toEqual([basename(isolation.root)]);
    expect(await readFile(join(isolation.home, 'temporary.txt'), 'utf8')).toBe('temporary\n');
  });

  it('retains the exact workspace and fails closed when disposal proof is injected to fail', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('workspaces');
    let proofHooks = 0;
    const owned = await createOwnedProfileGithubDirectory(parent, 'workspace-', { injectCleanupFailure: true, afterCleanupReady: () => { proofHooks += 1; } });
    await writeFile(join(owned.path, 'keep.txt'), 'retained\n');
    const first = owned.dispose();
    const second = owned.dispose();
    expect(second).toBe(first);

    await expect(first).rejects.toMatchObject({
      code: 'PROFILE_GITHUB_CLEANUP_UNPROVEN',
      message: expect.not.stringContaining(owned.path)
    });
    await expect(second).rejects.toMatchObject({ code: 'PROFILE_GITHUB_CLEANUP_UNPROVEN' });
    expect(proofHooks).toBe(1);

    expect(await readdir(parent)).toEqual([basename(owned.path)]);
    expect(await readFile(join(owned.path, 'keep.txt'), 'utf8')).toBe('retained\n');
  });

  it('disposes a deep over-limit tree in bounded time by retaining it without traversal', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('workspaces');
    const owned = await createOwnedProfileGithubDirectory(parent, 'workspace-');
    let nested = owned.path;
    for (let index = 0; index < 65; index += 1) {
      nested = join(nested, `d${index}`);
      await mkdir(nested);
    }
    await writeFile(join(nested, 'keep.txt'), 'too deep\n');
    const started = Date.now();

    await expect(owned.dispose()).resolves.toEqual({ disposition: 'retained', identityProved: true });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(await readFile(join(nested, 'keep.txt'), 'utf8')).toBe('too deep\n');
  });

  it('never deletes either directory when the retained pathname is substituted', async () => {
    temporary = await createTempDirectory('/tmp/bzf-github-cleanup-');
    const parent = await temporary.mkdir('workspaces');
    const saved = join(parent, 'saved-original');
    const owned = await createOwnedProfileGithubDirectory(parent, 'workspace-', {
      afterCleanupQuarantined: async (retainedPath) => {
        await rename(retainedPath, saved);
        await mkdir(retainedPath);
        await writeFile(join(retainedPath, 'attacker.txt'), 'must survive\n');
      }
    });
    await writeFile(join(owned.path, 'owned.txt'), 'owned\n');

    await expect(owned.dispose()).rejects.toMatchObject({ code: 'PROFILE_GITHUB_CLEANUP_UNPROVEN' });

    expect(await readFile(join(owned.path, 'attacker.txt'), 'utf8')).toBe('must survive\n');
    expect(await readFile(join(saved, 'owned.txt'), 'utf8')).toBe('owned\n');
  });
});

describe('POSIX bounded GitHub process settlement', () => {
  const request: ProfileGithubProcessRequest = { executable: 'git', args: [], cwd: '/fetched', environment: {}, stdin: 'ignore', timeoutMilliseconds: 100, terminationGraceMilliseconds: 10, maxStdoutBytes: 4, maxStderrBytes: 4 };
  function start(probe: () => void, options: Partial<ProfileGithubProcessRequest> = {}, signal: (signal: NodeJS.Signals) => void = () => {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const signals: Array<NodeJS.Signals | 0> = [];
    const before = new Set(process.listeners('SIGINT'));
    const pending = runBoundedProfileGithubProcess({ ...request, ...options }, {
      posixProcessGroups: true,
      spawnProcess: (() => child) as typeof spawn,
      signalProcess: (pid, value) => { expect(pid).toBe(-123); signals.push(value); if (value === 0) probe(); else signal(value); }
    });
    const interrupt = () => process.listeners('SIGINT').find((listener) => !before.has(listener))!('SIGINT');
    return { child, pending, signals, interrupt };
  }
  function absent(): never { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
  function monitored() {
    const samples: Array<{ resolve(): void; reject(error: Error): void }> = [];
    const monitor = () => new Promise<void>((resolve, reject) => { samples.push({ resolve, reject }); });
    return { samples, monitor };
  }
  afterEach(() => { vi.useRealTimers(); });

  it.each([[0, false], [128, false], [0, true], [128, true]] as const)('accepts normal status %s only after transient group existence settles naturally; EPERM=%s', async (status, denied) => {
    let probes = 0;
    const run = start(() => {
      if (++probes > 1) absent();
      if (denied) throw Object.assign(new Error('probe denied'), { code: 'EPERM' });
    });
    run.child.emit('close', status);
    await vi.advanceTimersByTimeAsync(10);
    const result = await run.pending;
    expect(result).toMatchObject({ status });
    expect(result.failure).toBeUndefined();
    expect(result.uncertainTermination).toBeUndefined();
    expect(run.signals).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains the serial active sample and exactly one final sample after proved absence', async () => {
    let probes = 0, settled = false;
    const monitoring = monitored();
    const run = start(() => { if (++probes > 1) absent(); }, monitoring);
    void run.pending.then(() => { settled = true; });
    run.child.emit('close', 128);
    await vi.advanceTimersByTimeAsync(9);
    expect(run.signals).toEqual([0]);
    expect(monitoring.samples).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.signals).toEqual([0, 0]);
    expect(settled).toBe(false);
    monitoring.samples[0]!.resolve();
    await Promise.resolve();
    expect(monitoring.samples).toHaveLength(2);
    expect(settled).toBe(false);
    monitoring.samples[1]!.resolve();
    expect(await run.pending).toMatchObject({ status: 128 });
    expect((await run.pending).failure).toBeUndefined();
    expect(monitoring.samples).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses an active monitor rejection after natural absence without starting a final sample', async () => {
    let probes = 0;
    const monitoring = monitored();
    const run = start(() => { if (++probes > 1) absent(); }, monitoring);
    run.child.emit('close', 128);
    await vi.advanceTimersByTimeAsync(10);
    monitoring.samples[0]!.reject(new Error('late active refusal'));
    expect(await run.pending).toMatchObject({ status: 128, failure: 'monitor-failure', monitorError: { message: 'late active refusal' } });
    expect(monitoring.samples).toHaveLength(1);
    expect(run.signals).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['exists', 'EPERM', 'unknown'] as const)('fails closed for persistent %s group probes', async (kind) => {
    const run = start(() => { if (kind !== 'exists') throw Object.assign(new Error('probe failed'), { code: kind === 'EPERM' ? 'EPERM' : 'EIO' }); }, {}, () => {
      if (kind === 'EPERM') throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
    });
    run.child.emit('close', 128);
    await vi.advanceTimersByTimeAsync(30);
    expect(await run.pending).toMatchObject({ status: 128, failure: kind === 'unknown' ? 'termination-uncertain' : 'process-tree-survived', uncertainTermination: true });
    expect(run.signals).toEqual(kind === 'unknown' ? [0, 'SIGTERM', 0, 'SIGKILL', 0] : [0, 0, 'SIGTERM', 0, 'SIGKILL', 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('never turns successful %s intervention into ordinary status', async (intervention) => {
    let gone = false;
    const run = start(() => { if (gone) absent(); }, {}, (signal) => { if (signal === intervention) gone = true; });
    run.child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(30);
    expect(await run.pending).toMatchObject({ status: 0, failure: 'process-tree-survived' });
    expect((await run.pending).uncertainTermination).toBeUndefined();
    expect(run.signals).toEqual(intervention === 'SIGTERM' ? [0, 0, 'SIGTERM', 0] : [0, 0, 'SIGTERM', 0, 'SIGKILL', 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['initial-unknown', 'recheck-unknown', 'signal-denied'] as const)('retains %s uncertainty even after later absence', async (kind) => {
    let probes = 0;
    const run = start(() => {
      probes += 1;
      if ((kind === 'initial-unknown' && probes === 1) || (kind === 'recheck-unknown' && probes === 2)) throw new Error('unknown probe');
      if (probes > (kind === 'initial-unknown' ? 1 : 2)) absent();
    }, {}, () => { if (kind === 'signal-denied') throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    run.child.emit('close', 128);
    await vi.advanceTimersByTimeAsync(20);
    expect(await run.pending).toMatchObject({ status: 128, failure: kind === 'signal-denied' ? 'process-tree-survived' : 'termination-uncertain', uncertainTermination: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['before-close', 'natural-settlement', 'final-drain'] as const)('preserves failure events during %s despite subsequent absence', async (phase) => {
    // Each failure source is exercised at each lifecycle boundary without real signals.
    for (const reason of ['timeout', 'stdout-overflow', 'stderr-overflow', 'parent-signal', 'spawn', 'monitor-failure'] as const) {
      let probes = 0, gone = false;
      const monitoring = monitored();
      const run = start(() => { if (gone || ++probes > 1) absent(); }, { ...monitoring, timeoutMilliseconds: reason === 'timeout' && phase !== 'final-drain' ? 5 : 100 });
      const trigger = async () => {
        if (reason === 'timeout') await vi.advanceTimersByTimeAsync(phase === 'final-drain' ? 90 : 5);
        else if (reason === 'stdout-overflow' || reason === 'stderr-overflow') run.child[reason === 'stdout-overflow' ? 'stdout' : 'stderr']!.emit('data', Buffer.from('12345'));
        else if (reason === 'parent-signal') run.interrupt();
        else if (reason === 'spawn') run.child.emit('error', new Error('spawn failed'));
        else { monitoring.samples[phase === 'final-drain' ? 1 : 0]!.reject(new Error('monitor rejected')); await Promise.resolve(); }
      };
      if (phase === 'before-close') { await trigger(); gone = true; run.child.emit('close', 128); }
      else {
        run.child.emit('close', 128);
        if (phase === 'final-drain') {
          await vi.advanceTimersByTimeAsync(10);
          monitoring.samples[0]!.resolve();
          await Promise.resolve();
        }
        await trigger();
        gone = true;
        if (phase === 'natural-settlement') await vi.advanceTimersByTimeAsync(10);
      }
      if (reason !== 'monitor-failure') {
        if (phase !== 'final-drain') { monitoring.samples[0]!.resolve(); await Promise.resolve(); }
        monitoring.samples[1]!.resolve();
      }
      const result = await run.pending;
      expect(result, `${phase}/${reason}`).toMatchObject({ status: 128, failure: reason });
      if (reason === 'monitor-failure') expect(result.monitorError?.message).toBe('monitor rejected');
      if (reason === 'spawn') expect(result.error?.message).toBe('spawn failed');
      if (reason === 'parent-signal') expect(result.signal).toBe('SIGINT');
      expect(run.signals.filter((signal) => signal !== 0)).toEqual(phase === 'final-drain' ? [] : ['SIGTERM']);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('cancels pending termination timers before a slow final drain and removes parent listeners', async () => {
    let gone = false;
    const monitoring = monitored();
    const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
    const before = signals.map((signal) => process.listeners(signal));
    const run = start(() => { if (gone) absent(); }, monitoring);
    run.child.emit('close', 128);
    await vi.advanceTimersByTimeAsync(10);
    gone = true;
    await vi.advanceTimersByTimeAsync(10);
    monitoring.samples[0]!.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.signals).toEqual([0, 0, 'SIGTERM', 0]);
    monitoring.samples[1]!.resolve();
    expect(await run.pending).toMatchObject({ failure: 'process-tree-survived' });
    expect(vi.getTimerCount()).toBe(0);
    signals.forEach((signal, index) => expect(process.listeners(signal)).toEqual(before[index]));
  });
});

describe('Windows bounded GitHub process receipts', () => {
  const request: ProfileGithubProcessRequest = { executable: 'git', args: [], cwd: 'C:\\fetched', environment: {}, stdin: 'ignore', timeoutMilliseconds: 2, terminationGraceMilliseconds: 2, maxStdoutBytes: 4, maxStderrBytes: 4 };
  function child(closeOnKill: boolean) {
    const value = new EventEmitter() as ChildProcess;
    Object.assign(value, { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => { if (closeOnKill) queueMicrotask(() => value.emit('close', 0)); return true; } });
    return value;
  }
  it('reports the forwarded parent signal and removes every installed listener after settlement', async () => {
    const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
    const before = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
    const value = child(true);
    const pending = runBoundedProfileGithubProcess({ ...request, timeoutMilliseconds: 1000 }, { posixProcessGroups: false, spawnProcess: (() => value) as typeof spawn });
    const handler = process.listeners('SIGINT').find((listener) => !before.get('SIGINT')!.has(listener));
    expect(handler).toBeDefined(); handler!('SIGINT');
    expect(await pending).toMatchObject({ failure: 'parent-signal', signal: 'SIGINT', uncertainTermination: true });
    for (const signal of signals) expect(process.listeners(signal).filter((listener) => !before.get(signal)!.has(listener))).toEqual([]);
  });
  it.each([true, false])('retains uncertainty after timeout; closeOnKill=%s', async (closeOnKill) => {
    const value = child(closeOnKill);
    const result = await runBoundedProfileGithubProcess(request, { posixProcessGroups: false, spawnProcess: (() => value) as typeof spawn });
    expect(result).toMatchObject({ failure: 'timeout', uncertainTermination: true });
  });
  it.each(['stdout', 'stderr'])('bounds %s and cannot call immediate-child kill tree settlement', async (stream) => {
    const value = child(true);
    const pending = runBoundedProfileGithubProcess({ ...request, timeoutMilliseconds: 1000 }, { posixProcessGroups: false, spawnProcess: (() => value) as typeof spawn });
    value[stream as 'stdout' | 'stderr']!.emit('data', Buffer.from('12345'));
    expect(await pending).toMatchObject({ failure: `${stream}-overflow`, uncertainTermination: true, stdout: '', stderr: '' });
  });
  it('awaits final monitoring and rejects its failure', async () => {
    const value = child(true); let reject!: (error: Error) => void;
    const pending = runBoundedProfileGithubProcess({ ...request, monitor: () => new Promise<void>((_resolve, no) => { reject = no; }) }, { posixProcessGroups: false, spawnProcess: (() => value) as typeof spawn });
    value.emit('close', 0);
    reject(new Error('monitor rejected'));
    expect(await pending).toMatchObject({ failure: 'monitor-failure', monitorError: { message: 'monitor rejected' } });
  });

  it.each(['git', 'gh'] as const)('honors case-insensitive Windows %s override and rejects conflicting spellings', async (name) => {
    const launches: string[] = [];
    const launch = { posixProcessGroups: false, spawnProcess: ((executable: string) => { launches.push(executable); const value = child(false); queueMicrotask(() => value.emit('close', 0)); return value; }) as typeof spawn };
    const effects = { async executable() { return true; }, async canonical(path: string) { return path; }, async readShim() { throw new Error('unexpected'); } };
    const key = `BAZFRAME_${name.toUpperCase()}_COMMAND`, selected = 'C:\\chosen\\custom.exe';
    const options = { cwd: 'C:\\caller', platform: 'win32' as const, effects, environment: { Path: 'C:\\tools', [key.toLowerCase()]: selected } };
    expect(await createResolvedProfileGithubProcess(options, launch)({ ...request, executable: name, timeoutMilliseconds: 1000 })).toMatchObject({ status: 0 });
    expect(launches).toEqual([selected]);
    const conflict = createResolvedProfileGithubProcess({ ...options, environment: { ...options.environment, [key]: 'C:\\other.exe' } }, launch);
    expect(await conflict({ ...request, executable: name })).toMatchObject({ failure: 'spawn', error: { code: 'EXECUTABLE_RESOLUTION_FAILED' } });
    expect(launches).toEqual([selected]);
  });
  it('retains legal POSIX backslashes in the explicitly trusted gh helper path', async () => {
    let args: readonly string[] = [];
    const runner = createResolvedProfileGithubProcess({ cwd: '/caller', platform: 'linux', environment: { PATH: '/tools', BAZFRAME_GH_COMMAND: '/tools/back\\slash/gh' }, effects: { async executable() { return true; }, async canonical(path) { return path; }, async readShim() { throw new Error('unexpected'); } } }, { posixProcessGroups: false, spawnProcess: ((_executable: string, input: readonly string[]) => { args = input; const value = child(false); queueMicrotask(() => value.emit('close', 0)); return value; }) as typeof spawn });
    expect(await runner({ ...request, args: ['-c', 'credential.helper=!gh auth git-credential'], timeoutMilliseconds: 1000 })).toMatchObject({ status: 0 });
    expect(args).toEqual(['-c', "credential.helper=!'/tools/back\\slash/gh' auth git-credential"]);
  });
  it('freezes controlled tools and quotes the trusted gh helper, never selecting fetched executables', async () => {
    const launches: Array<{ executable: string; args: readonly string[] }> = [];
    const runner = createResolvedProfileGithubProcess({ cwd: 'C:\\caller', environment: { Path: '.;C:\\fetched;C:\\Tools Dir' }, platform: 'win32', excludedRoots: ['C:\\fetched'], effects: { async executable() { return true; }, async canonical(path) { return path; }, async readShim() { throw new Error('unexpected'); } } }, { posixProcessGroups: false, spawnProcess: ((executable: string, args: readonly string[]) => { launches.push({ executable, args }); const value = child(false); queueMicrotask(() => value.emit('close', 0)); return value; }) as typeof spawn });
    const result = await runner({ ...request, args: ['-c', 'credential.helper=!gh auth git-credential'], timeoutMilliseconds: 1000 });
    expect(result).toMatchObject({ status: 0 }); expect(result.failure).toBeUndefined();
    expect(launches).toEqual([{ executable: 'C:\\Tools Dir\\git.exe', args: ['-c', "credential.helper=!'C:/Tools Dir/gh.exe' auth git-credential"] }]);
  });
});
