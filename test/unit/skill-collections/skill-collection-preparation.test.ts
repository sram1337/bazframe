import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../src/core/child-process.js', () => ({ spawnBoundedPackageProcess: child.run }));
import { BazframeError } from '../../../src/core/errors.js';
import { readPackageManifest } from '../../../src/packages/package-manifest.js';
import {
  packageBuildInterruptionSignal,
  preparePackage
} from '../../../src/skill-collections/skill-collection-preparation.js';

beforeEach(() => child.run.mockReset());

async function fixture(argv = ['builder', '--literal']) {
  const temp = await mkdtemp(join(tmpdir(), 'bazframe-package-preparation-'));
  const home = join(temp, 'home'); const root = join(temp, 'package'); await mkdir(home); await mkdir(root);
  await writeFile(join(root, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: argv, artifactRoot: 'dist', skillsRoot: 'skills' }));
  return { home, root };
}

const productionProcessOptions = {
  timeoutMilliseconds: 1_800_000,
  terminationGraceMilliseconds: 5000
};

describe('package process failure contract', () => {
  it('reports nonzero exit status', async () => {
    const { home, root } = await fixture(); child.run.mockResolvedValue({ exitCode: 7, signal: null });
    await expect(preparePackage(home, root)).rejects.toThrow(/status 7/u);
  });

  it('refuses manifest drift after remote build authorization before starting the child', async () => {
    const { home, root } = await fixture();
    const authorized = await readPackageManifest(root);
    await writeFile(join(root, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: ['changed'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    await expect(preparePackage(home, root, process.env, undefined, authorized)).rejects.toMatchObject({ code: 'PACKAGE_MANIFEST_CHANGED' });
    expect(child.run).not.toHaveBeenCalled();
  });

  it('reports signal termination and preserves literal argv/cwd/environment at the bounded child seam', async () => {
    const { home, root } = await fixture(); const environment = { PROBE: 'value' };
    child.run.mockResolvedValue({ exitCode: null, signal: 'SIGTERM' });
    await expect(preparePackage(home, root, environment)).rejects.toThrow(/signal SIGTERM/u);
    expect(child.run).toHaveBeenCalledWith('builder', ['--literal'], {
      cwd: root,
      environment,
      ...productionProcessOptions
    });
  });

  it('passes lower-only build duration and grace limits to the package runner', async () => {
    const { home, root } = await fixture();
    child.run.mockResolvedValue({ exitCode: 1, signal: null });
    await expect(preparePackage(home, root, process.env, undefined, undefined, 'inherit', {
      limitPolicy: { maxBuildMilliseconds: 12, terminationGraceMilliseconds: 3 }
    })).rejects.toThrow(/status 1/u);
    expect(child.run).toHaveBeenCalledWith('builder', ['--literal'], expect.objectContaining({
      timeoutMilliseconds: 12,
      terminationGraceMilliseconds: 3
    }));
  });

  it('invokes beforePackageBuild after exact root and manifest validation adjacent to spawn', async () => {
    const { home, root } = await fixture();
    const events: string[] = [];
    child.run.mockImplementation(async () => {
      events.push('spawn');
      return { exitCode: 9, signal: null };
    });
    await expect(preparePackage(home, root, process.env, undefined, undefined, 'inherit', {
      beforePackageBuild: async (context) => {
        events.push('callback');
        expect(context.packageId).toBe(basename(root));
        expect(context.rootIdentity.root).toBe(await realpath(root));
        expect(context.rootIdentity.device).toBeTypeOf('bigint');
        expect(context.rootIdentity.inode).toBeTypeOf('bigint');
        expect(context.manifestSnapshot.manifest.build).toEqual(['builder', '--literal']);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.rootIdentity)).toBe(true);
        expect(Object.isFrozen(context.manifestSnapshot)).toBe(true);
        expect(Object.isFrozen(context.manifestSnapshot.manifest)).toBe(true);
        expect(Object.isFrozen(context.manifestSnapshot.manifest.build)).toBe(true);
      }
    })).rejects.toThrow(/status 9/u);
    expect(events).toEqual(['callback', 'spawn']);
  });

  it('prevents spawn when beforePackageBuild refuses or reports source drift', async () => {
    const refused = await fixture();
    await expect(preparePackage(refused.home, refused.root, process.env, undefined, undefined, 'inherit', {
      beforePackageBuild: () => { throw new Error('authorization declined'); }
    })).rejects.toThrow(/authorization declined/u);
    expect(child.run).not.toHaveBeenCalled();

    const drifted = await fixture();
    await expect(preparePackage(drifted.home, drifted.root, process.env, undefined, undefined, 'inherit', {
      beforePackageBuild: async () => {
        await writeFile(join(drifted.root, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: ['changed'], artifactRoot: 'dist', skillsRoot: 'skills' }));
        throw new BazframeError('PACKAGE_MANIFEST_CHANGED', 'Package source drifted during adjacent revalidation.');
      }
    })).rejects.toMatchObject({ code: 'PACKAGE_MANIFEST_CHANGED' });
    expect(child.run).not.toHaveBeenCalled();
  });

  it('binds an expected canonical package root identity before callback or spawn', async () => {
    const { home, root } = await fixture();
    const canonical = await realpath(root);
    await expect(preparePackage(home, root, process.env, undefined, undefined, 'inherit', {
      expectedRootIdentity: { root: canonical, device: 0n, inode: 0n },
      beforePackageBuild: vi.fn()
    })).rejects.toMatchObject({ code: 'SKILL_COLLECTION_ROOT_CHANGED' });
    expect(child.run).not.toHaveBeenCalled();
  });

  it.each(['SIGHUP', 'SIGINT', 'SIGTERM'] as const)('preserves parent %s interruption through wrapped error chains', async (signal) => {
    const { home, root } = await fixture();
    child.run.mockResolvedValue({ exitCode: null, signal, failure: 'parent-signal' });
    let failure: unknown;
    try { await preparePackage(home, root); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'PACKAGE_BUILD_INTERRUPTED', signal });
    expect(packageBuildInterruptionSignal(new Error('wrapper', { cause: failure }))).toBe(signal);
    expect(packageBuildInterruptionSignal(new AggregateError([new Error('other'), failure]))).toBe(signal);
  });

  it('fails timeout closed and preserves a dedicated uncertain-termination code', async () => {
    const timedOut = await fixture();
    child.run.mockResolvedValueOnce({ exitCode: null, signal: 'SIGTERM', failure: 'timeout' });
    await expect(preparePackage(timedOut.home, timedOut.root)).rejects.toMatchObject({ code: 'PACKAGE_BUILD_FAILED' });

    const uncertain = await fixture();
    child.run.mockResolvedValueOnce({ exitCode: null, signal: null, failure: 'termination-uncertain', uncertainTermination: true });
    await expect(preparePackage(uncertain.home, uncertain.root)).rejects.toMatchObject({
      code: 'PACKAGE_BUILD_TERMINATION_UNCERTAIN',
      name: 'PackageBuildTerminationUncertainError'
    });
  });
});
