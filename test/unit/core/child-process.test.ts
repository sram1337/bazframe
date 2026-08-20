import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  childExitStatus,
  spawnInheritedChild
} from '../../../src/core/child-process.js';

class FakeChild extends EventEmitter {
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

  it('maps child signals from the platform signal constants', () => {
    expect(childExitStatus({ exitCode: 7, signal: null })).toBe(7);
    expect(childExitStatus({ exitCode: null, signal: 'SIGINT' })).toBe(130);
    expect(childExitStatus({ exitCode: null, signal: 'SIGTERM' })).toBe(143);
    expect(childExitStatus({ exitCode: null, signal: 'SIGHUP' })).toBe(129);
    expect(childExitStatus({ exitCode: null, signal: 'SIGSEGV' }))
      .toBe(128 + constants.signals.SIGSEGV);
  });
});
