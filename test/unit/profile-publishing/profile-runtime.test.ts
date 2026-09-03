import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { withProductionProfileLifecycleRuntime } from '../../../src/profile-publishing/profile-runtime.js';
import type { ProductionProfileGithubTransportAdapter } from '../../../src/profile-publishing/profile-github-transport.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

const transport = {} as ProductionProfileGithubTransportAdapter;

describe('hidden production profile lifecycle runtime', () => {
  it('keeps dry-run Bazframe state byte-identical, retains only OS-temporary workspace state, and never recovers or starts login', async () => {
    temporary = await createTempDirectory('/tmp/bzf-profile-runtime-');
    const home = await temporary.mkdir('home');
    const osTemporary = await temporary.mkdir('os-temp');
    await writeFile(join(home, 'sentinel'), 'unchanged\n');
    const before = await snapshot(home);
    let recoveryCalls = 0;

    const result = await withProductionProfileLifecycleRuntime({
      home,
      cwd: temporary.root,
      mode: 'dry-run',
      temporaryRoot: osTemporary,
      transport,
      authenticate: async (_options, mode) => {
        expect(mode).toBe('dry-run');
        return { loginStarted: false };
      },
      recover: async () => { recoveryCalls += 1; return []; }
    }, async (session) => {
      expect(session.recovery).toEqual([]);
      expect(session.workspaceParent.startsWith(`${osTemporary}/`)).toBe(true);
      expect(session.workspaceParent.startsWith(home)).toBe(false);
      return 'inspected';
    });

    expect(result).toMatchObject({ value: 'inspected', effects: { loginStarted: false, localStateWritten: false, lockAcquired: false } });
    expect(recoveryCalls).toBe(0);
    expect(await snapshot(home)).toEqual(before);
    expect(await readdir(osTemporary)).toHaveLength(1);
  });

  it('constructs public-read Git access without invoking gh authentication or login', async () => {
    temporary = await createTempDirectory('/tmp/bzf-profile-runtime-');
    const home = await temporary.mkdir('home');
    const osTemporary = await temporary.mkdir('os-temp');
    let authenticationCalls = 0;
    const result = await withProductionProfileLifecycleRuntime({
      home,
      cwd: temporary.root,
      mode: 'dry-run',
      access: 'public-read',
      temporaryRoot: osTemporary,
      authenticate: async () => { authenticationCalls += 1; return { loginStarted: true }; }
    }, async (session) => {
      expect(session.publication).toBeUndefined();
      expect(session.lifecycle.git).toMatchObject({ inspect: expect.any(Function), list: expect.any(Function) });
      return 'public';
    });
    expect(authenticationCalls).toBe(0);
    expect(result.effects.loginStarted).toBe(false);
  });

  it('authenticates, completes startup recovery, then permits the mutating callback and reports login truthfully', async () => {
    temporary = await createTempDirectory('/tmp/bzf-profile-runtime-');
    const home = await temporary.mkdir('home');
    const events: string[] = [];

    const result = await withProductionProfileLifecycleRuntime({
      home,
      cwd: temporary.root,
      mode: 'human',
      transport,
      authenticate: async () => { events.push('authenticate'); return { loginStarted: true }; },
      recover: async (_home, adapter) => {
        events.push('recover');
        expect(adapter).toBe(transport);
        return [{ transactionId: 'a'.repeat(32), kind: 'candidate-swap', action: 'terminal' }];
      }
    }, async (session) => {
      events.push('mutate');
      expect(session.recovery).toHaveLength(1);
      await writeFile(join(home, 'mutation'), 'after recovery\n');
      return 42;
    });

    expect(events).toEqual(['authenticate', 'recover', 'mutate']);
    expect(result.effects.loginStarted).toBe(true);
    expect(await readFile(join(home, 'mutation'), 'utf8')).toBe('after recovery\n');
    expect((await readdir(join(home, 'profile-publishing', 'github-workspaces'))).some((name) => name.startsWith('bazframe-profile-github-'))).toBe(true);
  });
});

async function snapshot(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (path: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      result.push(`${entry.isDirectory() ? 'd' : 'f'}:${relative}`);
      if (entry.isDirectory()) await visit(join(path, entry.name), relative);
    }
  };
  await visit(root);
  return result.sort();
}
