import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  childExitStatus,
  spawnBoundedPackageProcess,
  spawnInheritedChild
} from '../../../src/core/child-process.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function absentProcessGroup(_pid: number, signal: NodeJS.Signals | 0): void {
  if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
}

class FakeChild extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
}

describe('inherited child process', () => {
  it('spawns shell-free with exact argv, cwd, environment, and inherited stdio', async () => {
    const child = new FakeChild();
    const environment = { SENTINEL: 'value' };
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = spawnInheritedChild('/path/editor with spaces', ['/path/AGENTS.md'], {
      cwd: '/path/profile',
      environment,
      spawnProcess
    });
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toEqual({ exitCode: 0, signal: null });
    expect(spawnProcess).toHaveBeenCalledWith(
      '/path/editor with spaces',
      ['/path/AGENTS.md'],
      {
        cwd: '/path/profile',
        env: environment,
        stdio: 'inherit',
        shell: false
      }
    );
  });

  it('can preserve stdin while routing both provider output streams to parent stderr', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = spawnInheritedChild('builder', [], {
      cwd: '/tmp', environment: {}, spawnProcess,
      outputPolicy: 'stdout-and-stderr-to-parent-stderr'
    });
    child.emit('close', 0, null);
    await resultPromise;
    expect(spawnProcess).toHaveBeenCalledWith('builder', [], expect.objectContaining({
      stdio: ['inherit', process.stderr, process.stderr], shell: false
    }));
  });

  it('settles once and removes ignored-signal handlers when an error is followed by close', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const baseline = process.listenerCount('SIGINT');
    const resultPromise = spawnInheritedChild('missing', [], {
      cwd: '/tmp',
      environment: {},
      ignoreParentSignals: ['SIGINT'],
      spawnProcess
    });
    expect(process.listenerCount('SIGINT')).toBe(baseline + 1);
    const failure = Object.assign(new Error('missing'), { code: 'ENOENT' });
    child.emit('error', failure);
    child.emit('close', 0, null);
    await expect(resultPromise).rejects.toBe(failure);
    expect(process.listenerCount('SIGINT')).toBe(baseline);
  });

  it('keeps signal forwarding opt-in', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const baseline = process.listenerCount('SIGINT');
    const resultPromise = spawnInheritedChild('editor', [], {
      cwd: '/tmp', environment: {}, spawnProcess
    });
    expect(process.listenerCount('SIGINT')).toBe(baseline);
    child.emit('close', null, 'SIGINT');
    await expect(resultPromise).resolves.toEqual({ exitCode: null, signal: 'SIGINT' });
  });

  it('temporarily keeps the parent alive without forwarding an ignored signal', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const existing = new Set(process.listeners('SIGINT'));
    const baseline = process.listenerCount('SIGINT');
    const resultPromise = spawnInheritedChild('editor', [], {
      cwd: '/tmp',
      environment: {},
      ignoreParentSignals: ['SIGINT'],
      spawnProcess
    });
    const handler = process.listeners('SIGINT').find((listener) => !existing.has(listener));
    expect(handler).toBeDefined();
    handler?.('SIGINT');
    expect(child.kill).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(baseline + 1);

    child.emit('close', 0, null);
    await expect(resultPromise).resolves.toEqual({ exitCode: 0, signal: null });
    expect(process.listenerCount('SIGINT')).toBe(baseline);
  });

  it('keeps the bounded package runner separate and shell-free with exact inherited-output policies', async () => {
    const child = new FakeChild();
    child.pid = 321;
    const environment = { SENTINEL: 'package' };
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = spawnBoundedPackageProcess('builder with spaces', ['literal;arg'], {
      cwd: '/package root',
      environment,
      outputPolicy: 'stdout-and-stderr-to-parent-stderr',
      timeoutMilliseconds: 1000,
      terminationGraceMilliseconds: 10,
      spawnProcess,
      signalProcess: absentProcessGroup,
      posixProcessGroups: true
    });
    child.emit('close', 0, null);
    await expect(resultPromise).resolves.toEqual({ exitCode: 0, signal: null });
    expect(spawnProcess).toHaveBeenCalledWith('builder with spaces', ['literal;arg'], {
      cwd: '/package root',
      env: environment,
      stdio: ['inherit', process.stderr, process.stderr],
      shell: false,
      detached: true
    });
  });

  it('uses normal inherited streams for bounded package builds by default', async () => {
    const child = new FakeChild(); child.pid = 322;
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = spawnBoundedPackageProcess('builder', [], {
      cwd: '/tmp', environment: {}, timeoutMilliseconds: 1000, terminationGraceMilliseconds: 10,
      spawnProcess, signalProcess: absentProcessGroup, posixProcessGroups: true
    });
    child.emit('close', 0, null);
    await resultPromise;
    expect(spawnProcess).toHaveBeenCalledWith('builder', [], expect.objectContaining({ stdio: 'inherit' }));
  });

  it('terminates descendants and fails when a successful leader exits with its POSIX group alive', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(); child.pid = 40;
      let exists = true;
      const signals: Array<NodeJS.Signals | 0> = [];
      const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
        signals.push(signal);
        if (signal === 'SIGTERM') exists = false;
        if (signal === 0 && !exists) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      const resultPromise = spawnBoundedPackageProcess('builder', [], {
        cwd: '/tmp', environment: {}, timeoutMilliseconds: 1000, terminationGraceMilliseconds: 10,
        spawnProcess: vi.fn(() => child) as unknown as typeof spawn, signalProcess, posixProcessGroups: true
      });
      child.emit('close', 0, null);
      expect(signals).toContain('SIGTERM');
      await vi.advanceTimersByTimeAsync(10);
      await expect(resultPromise).resolves.toEqual({ exitCode: 0, signal: null, failure: 'process-tree-survived' });
    } finally { vi.useRealTimers(); }
  });

  it('returns termination uncertainty when the group state after leader exit is unknowable', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(); child.pid = 41;
      const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) throw Object.assign(new Error('unknown'), { code: 'EIO' });
      });
      const resultPromise = spawnBoundedPackageProcess('builder', [], {
        cwd: '/tmp', environment: {}, timeoutMilliseconds: 1000, terminationGraceMilliseconds: 10,
        spawnProcess: vi.fn(() => child) as unknown as typeof spawn, signalProcess, posixProcessGroups: true
      });
      child.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(20);
      await expect(resultPromise).resolves.toMatchObject({
        exitCode: 0, failure: 'termination-uncertain', uncertainTermination: true
      });
    } finally { vi.useRealTimers(); }
  });

  it.each(['SIGHUP', 'SIGINT', 'SIGTERM'] as const)('handles parent %s with bounded tree shutdown, preserves the signal, and removes every handler', async (parentSignal) => {
    const child = new FakeChild(); child.pid = 45;
    let exists = true;
    const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGTERM') exists = false;
      if (signal === 0 && !exists) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const baselines = new Map((['SIGHUP', 'SIGINT', 'SIGTERM'] as const).map((signal) => [signal, new Set(process.listeners(signal))]));
    const resultPromise = spawnBoundedPackageProcess('builder', [], {
      cwd: '/tmp', environment: {}, timeoutMilliseconds: 1000, terminationGraceMilliseconds: 10,
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn, signalProcess, posixProcessGroups: true
    });
    const handler = process.listeners(parentSignal).find((listener) => !baselines.get(parentSignal)!.has(listener));
    expect(handler).toBeDefined();
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
      expect(process.listeners(signal).filter((listener) => !baselines.get(signal)!.has(listener))).toHaveLength(1);
    }
    handler?.(parentSignal);
    expect(signalProcess).toHaveBeenCalledWith(-45, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await expect(resultPromise).resolves.toMatchObject({ failure: 'parent-signal', signal: parentSignal });
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
      expect(process.listeners(signal).filter((listener) => !baselines.get(signal)!.has(listener))).toHaveLength(0);
    }
  });

  it('kills real descendants left by a successful leader before they can act', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'bazframe-package-process-tree-')); roots.push(root);
    const marker = join(root, 'descendant-marker');
    const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'),250);setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.exit(0)`;
    const result = await spawnBoundedPackageProcess(process.execPath, ['-e', parent], {
      cwd: root,
      environment: process.env,
      timeoutMilliseconds: 1000,
      terminationGraceMilliseconds: 30
    });
    expect(result.failure).toBe('process-tree-survived');
    expect(result.uncertainTermination).not.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('times out a POSIX process tree with TERM and accepts proven graceful termination', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(); child.pid = 42;
      let exists = true;
      const signals: Array<NodeJS.Signals | 0> = [];
      const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
        signals.push(signal);
        if (signal === 0 && !exists) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      const resultPromise = spawnBoundedPackageProcess('builder', [], {
        cwd: '/tmp', environment: {}, timeoutMilliseconds: 20, terminationGraceMilliseconds: 10,
        spawnProcess: vi.fn(() => child) as unknown as typeof spawn, signalProcess, posixProcessGroups: true
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(signals).toContain('SIGTERM');
      exists = false;
      child.emit('close', null, 'SIGTERM');
      await expect(resultPromise).resolves.toEqual({ exitCode: null, signal: 'SIGTERM', failure: 'timeout' });
      expect(signals).not.toContain('SIGKILL');
    } finally { vi.useRealTimers(); }
  });

  it('force-kills a surviving POSIX process tree after the grace period', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(); child.pid = 43;
      let killed = false;
      const signals: Array<NodeJS.Signals | 0> = [];
      const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
        signals.push(signal);
        if (signal === 'SIGKILL') killed = true;
        if (signal === 0 && killed) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      const resultPromise = spawnBoundedPackageProcess('builder', [], {
        cwd: '/tmp', environment: {}, timeoutMilliseconds: 20, terminationGraceMilliseconds: 10,
        spawnProcess: vi.fn(() => child) as unknown as typeof spawn, signalProcess, posixProcessGroups: true
      });
      await vi.advanceTimersByTimeAsync(30);
      expect(signals).toContain('SIGTERM');
      expect(signals).toContain('SIGKILL');
      child.emit('close', null, 'SIGKILL');
      await expect(resultPromise).resolves.toMatchObject({ failure: 'timeout' });
    } finally { vi.useRealTimers(); }
  });

  it('fails closed when POSIX process-tree termination cannot be proven', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(); child.pid = 44;
      const signalProcess = vi.fn();
      const resultPromise = spawnBoundedPackageProcess('builder', [], {
        cwd: '/tmp', environment: {}, timeoutMilliseconds: 20, terminationGraceMilliseconds: 10,
        spawnProcess: vi.fn(() => child) as unknown as typeof spawn, signalProcess, posixProcessGroups: true
      });
      await vi.advanceTimersByTimeAsync(40);
      await expect(resultPromise).resolves.toMatchObject({ failure: 'timeout', uncertainTermination: true });
      expect(signalProcess).toHaveBeenCalledWith(-44, 'SIGTERM');
      expect(signalProcess).toHaveBeenCalledWith(-44, 'SIGKILL');
    } finally { vi.useRealTimers(); }
  });

  it('marks portable timeout fallback uncertain rather than claiming tree termination', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const resultPromise = spawnBoundedPackageProcess('builder', [], {
        cwd: '/tmp', environment: {}, timeoutMilliseconds: 20, terminationGraceMilliseconds: 10,
        spawnProcess: vi.fn(() => child) as unknown as typeof spawn, posixProcessGroups: false
      });
      await vi.advanceTimersByTimeAsync(20);
      child.emit('close', null, 'SIGTERM');
      await expect(resultPromise).resolves.toMatchObject({ failure: 'timeout', uncertainTermination: true });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally { vi.useRealTimers(); }
  });

  it('treats synchronous and asynchronous spawn uncertainty as failure', async () => {
    const failure = new Error('spawn failed');
    await expect(spawnBoundedPackageProcess('missing', [], {
      cwd: '/tmp', environment: {}, timeoutMilliseconds: 20, terminationGraceMilliseconds: 10,
      spawnProcess: vi.fn(() => { throw failure; }) as unknown as typeof spawn
    })).resolves.toMatchObject({ failure: 'spawn-error', error: failure });

    const child = new FakeChild();
    const resultPromise = spawnBoundedPackageProcess('missing', [], {
      cwd: '/tmp', environment: {}, timeoutMilliseconds: 20, terminationGraceMilliseconds: 10,
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn
    });
    child.emit('error', failure);
    await expect(resultPromise).resolves.toMatchObject({ failure: 'spawn-error', error: failure });
  });

  it('maps child signals from the platform signal constants', () => {
    expect(childExitStatus({ exitCode: 7, signal: null })).toBe(7);
    expect(childExitStatus({ exitCode: null, signal: 'SIGINT' })).toBe(130);
    expect(childExitStatus({ exitCode: null, signal: 'SIGTERM' })).toBe(143);
    expect(childExitStatus({ exitCode: null, signal: 'SIGHUP' })).toBe(129);
    expect(childExitStatus({ exitCode: null, signal: 'SIGSEGV' }))
      .toBe(128 + constants.signals.SIGSEGV);
  });
});
