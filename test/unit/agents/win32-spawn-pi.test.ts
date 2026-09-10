import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { spawnPi, childExitStatus } from '../../../src/agents/spawn-pi.js';

describe('Windows Pi launcher through the actual inherited-child engine', () => {
  it('resolves once and retains original cwd/environment/argv, no shell, forwarding and signal cleanup', async () => {
    const signals: string[] = [], calls: unknown[][] = [];
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: (signal: string) => { signals.push(signal); return true; } });
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const environment = { PATH: 'C:\\tools', KEEP: 'inherited' };
    let started!: () => void; const spawned = new Promise<void>((resolve) => { started = resolve; });
    const promise = spawnPi(['--no-context', 'literal & argument'], 'C:\\repo\\subdirectory', environment, 'pi', {
      platform: 'win32', executableEffects: { executable: async (path) => path === 'C:\\tools\\pi.exe', canonical: async (path) => path, readShim: async () => { throw new Error('no shim'); } },
      spawnProcess: ((...args: unknown[]) => { calls.push(args); started(); return child; }) as typeof spawn
    });
    await spawned; process.emit('SIGINT'); process.emit('SIGTERM');
    expect(signals).toEqual(['SIGINT', 'SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    expect(childExitStatus(await promise)).toBe(143);
    expect(calls).toEqual([['C:\\tools\\pi.exe', ['--no-context', 'literal & argument'], { cwd: 'C:\\repo\\subdirectory', env: environment, stdio: 'inherit', shell: false }]]);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
  it.each(['shim', 'relative-path', 'missing'])('refuses %s before spawn', async (kind) => {
    let spawned = false;
    await expect(spawnPi([], 'C:\\repo', { PATH: kind === 'relative-path' ? '.' : 'C:\\tools' }, kind === 'shim' ? 'C:\\tools\\pi.cmd' : 'pi', {
      platform: 'win32', executableEffects: { executable: async (path) => kind === 'shim' && path === 'C:\\tools\\pi.cmd', canonical: async (path) => path, readShim: async () => 'foreign shim' },
      spawnProcess: (() => { spawned = true; throw new Error('must not spawn'); }) as typeof spawn
    })).rejects.toThrow(/Could not launch|Could not find/);
    expect(spawned).toBe(false);
  });
  it.each(['pi', 'C:\\tools\\pi.cmd'])('translates only the selected official npm Pi shim for %s', async (command) => {
    const cli = 'C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js';
    const shim = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*';
    const requests: unknown[][] = [];
    const result = await spawnPi(['literal spaces', '"quotes"', '%VALUE%', '&'], 'C:\\repo', { PATH: 'C:\\tools;C:\\other' }, command, {
      platform: 'win32', executableEffects: { executable: async (path) => ['C:\\tools\\pi.cmd', 'C:\\tools\\node.exe', cli, 'C:\\other\\pi.exe'].includes(path), canonical: async (path) => path, readShim: async () => shim.replaceAll('\n', '\r\n') },
      spawnProcess: ((...args: unknown[]) => { requests.push(args); const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} }); queueMicrotask(() => child.emit('close', 7, null)); return child; }) as typeof spawn
    });
    expect(result.exitCode).toBe(7);
    expect(requests[0]?.slice(0, 2)).toEqual(['C:\\tools\\node.exe', [cli, 'literal spaces', '"quotes"', '%VALUE%', '&']]);
  });

});
