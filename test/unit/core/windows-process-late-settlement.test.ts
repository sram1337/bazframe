import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runManagedGitProcess } from '../../../src/providers/managed-git-process.js';
import { runBoundedProfileGithubProcess } from '../../../src/profile-publishing/profile-github-process.js';
import { spawnBoundedPackageProcess } from '../../../src/core/child-process.js';
const args = ['-e', 'setTimeout(()=>{},350)'];
const limits = { timeoutMilliseconds: 10, terminationGraceMilliseconds: 10, maxStreamBytes: 100 };
describe('bounded Windows immediate-child uncertainty releases owned host handles', () => {
  it.each(['managed', 'profile', 'package'] as const)('%s settles without referenced child or captured pipe handles', async (kind) => {
    let child: ChildProcess | undefined;
    const spawnProcess = ((...argv: Parameters<typeof spawn>) => { child = spawn(...argv); child.kill = () => false; return child; }) as typeof spawn;
    const effects = { spawnProcess, posixProcessGroups: false };
    let result;
    if (kind === 'managed') result = await runManagedGitProcess(process.execPath, args, tmpdir(), process.env, limits, effects);
    else if (kind === 'profile') result = await runBoundedProfileGithubProcess({ executable: 'git', resolvedExecutable: process.execPath, args, cwd: tmpdir(), environment: process.env, stdin: 'ignore', ...limits, maxStdoutBytes: 100, maxStderrBytes: 100 }, effects);
    else result = await spawnBoundedPackageProcess(process.execPath, args, { cwd: tmpdir(), environment: process.env, ...limits, ...effects });
    const close = once(child!, 'close');
    try {
      expect(result.uncertainTermination).toBe(true);
      const handle = (child as unknown as { _handle?: { hasRef(): boolean } })._handle;
      expect(handle?.hasRef() ?? false).toBe(false);
      for (const stream of [child?.stdout, child?.stderr]) if (stream !== null && stream !== undefined) { expect(stream.listenerCount('data')).toBe(0); expect(stream.destroyed).toBe(true); }
    } finally { await close; }
  });
  it('rejects parent cancellation during the final managed monitor drain after close zero', async () => {
    const before = new Set(process.listeners('SIGTERM')); let release!: () => void, child!: ChildProcess;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = runManagedGitProcess(process.execPath, ['-e', ''], tmpdir(), process.env, { ...limits, timeoutMilliseconds: 1000 }, { posixProcessGroups: false, spawnProcess: ((...argv: Parameters<typeof spawn>) => { child = spawn(...argv); return child; }) as typeof spawn, monitor: () => gate });
    await once(child, 'close');
    for (const handler of process.listeners('SIGTERM')) if (!before.has(handler)) handler('SIGTERM');
    release();
    expect(await running).toMatchObject({ status: 0, signal: 'SIGTERM', failure: 'parent-signal' });
  });
});
