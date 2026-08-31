import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runManagedGitProcess } from '../../../src/providers/managed-git-process.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const quick = {
  timeoutMilliseconds: 1_000,
  terminationGraceMilliseconds: 20,
  maxStreamBytes: 4
};

describe('managed Git process runner', () => {
  it('uses literal argv and independently accepts streams exactly at their byte bounds', async () => {
    const exact = await runManagedGitProcess(
      process.execPath,
      ['-e', 'process.stdout.write("abcd"); process.stderr.write("wxyz")'],
      tmpdir(),
      process.env,
      quick
    );
    expect(exact).toMatchObject({ status: 0, stdout: 'abcd', stderr: 'wxyz' });
    expect(exact.failure).toBeUndefined();

    const literal = await runManagedGitProcess(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', 'a b;$(false)'],
      tmpdir(),
      process.env,
      { ...quick, maxStreamBytes: Buffer.byteLength('a b;$(false)') }
    );
    expect(literal).toMatchObject({ status: 0, stdout: 'a b;$(false)' });
  });

  it.each([
    ['stdout-overflow', 'process.stdout.write("12345")'],
    ['stderr-overflow', 'process.stderr.write("12345")']
  ] as const)('terminates a fake command on %s without accepting overflowing output', async (failure, script) => {
    const result = await runManagedGitProcess(
      process.execPath,
      ['-e', script],
      tmpdir(),
      process.env,
      quick
    );
    expect(result.failure).toBe(failure);
    expect(result.stdout).not.toContain('12345');
    expect(result.stderr).not.toContain('12345');
  });

  it('enforces the timeout and graceful-to-force termination boundary without a production wait', async () => {
    const started = Date.now();
    const result = await runManagedGitProcess(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      tmpdir(),
      process.env,
      { timeoutMilliseconds: 20, terminationGraceMilliseconds: 20, maxStreamBytes: 4 }
    );
    expect(result.failure).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each(['timeout', 'stdout-overflow', 'parent-exit'] as const)('terminates provider descendants for %s or reports termination uncertainty', async (variant) => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-process-tree-'));
    roots.push(root);
    const marker = join(root, 'descendant-marker');
    const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'),200);setInterval(()=>{},1000)`;
    const parentAction = variant === 'parent-exit'
      ? ''
      : variant === 'stdout-overflow'
        ? `process.stdout.write('x'.repeat(65));setInterval(()=>{},1000)`
        : 'setInterval(()=>{},1000)';
    const parent = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});child.unref();${parentAction}`;
    const result = await runManagedGitProcess(
      process.execPath,
      ['-e', parent],
      root,
      process.env,
      { timeoutMilliseconds: variant === 'timeout' ? 20 : 1_000, terminationGraceMilliseconds: 30, maxStreamBytes: 64 }
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    if (result.uncertainTermination === true) {
      expect(result.failure).toBe(variant === 'timeout'
        ? 'timeout'
        : variant === 'stdout-overflow' ? 'stdout-overflow' : 'termination-uncertain');
    } else {
      expect(process.platform).not.toBe('win32');
      expect(result.failure).toBe(variant === 'timeout'
        ? 'timeout'
        : variant === 'stdout-overflow' ? 'stdout-overflow' : 'termination-uncertain');
      await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('runs monitor samples serially and awaits an in-flight final sample before settling', async () => {
    let active = 0;
    let maximumActive = 0;
    let samples = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    let settled = false;
    const pending = runManagedGitProcess(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 20)'],
      tmpdir(),
      process.env,
      quick,
      {
        monitor: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          samples += 1;
          if (first) {
            first = false;
            await firstGate;
          }
          await Promise.resolve();
          active -= 1;
        }
      }
    ).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    releaseFirst();
    const result = await pending;
    expect(result.status).toBe(0);
    expect(maximumActive).toBe(1);
    expect(samples).toBeGreaterThanOrEqual(2);
  });

  it('keeps timeout primary when an in-flight monitor later fails', async () => {
    const result = await runManagedGitProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      tmpdir(),
      process.env,
      { timeoutMilliseconds: 20, terminationGraceMilliseconds: 30, maxStreamBytes: 64 },
      {
        monitor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          throw new Error('late monitor failure');
        }
      }
    );
    expect(result.failure).toBe('timeout');
    expect(result.monitorError?.message).toBe('late monitor failure');
  });

  it('preserves monitor failure as primary and terminates the process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-managed-git-monitor-failure-'));
    roots.push(root);
    const marker = join(root, 'marker');
    const result = await runManagedGitProcess(
      process.execPath,
      ['-e', `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'),200);setInterval(()=>{},1000)`],
      root,
      process.env,
      { timeoutMilliseconds: 1_000, terminationGraceMilliseconds: 30, maxStreamBytes: 64 },
      { monitor: () => { throw new Error('storage limit observed'); } }
    );
    expect(result.failure).toBe('monitor-failure');
    expect(result.monitorError?.message).toBe('storage limit observed');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (result.uncertainTermination !== true) {
      await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
