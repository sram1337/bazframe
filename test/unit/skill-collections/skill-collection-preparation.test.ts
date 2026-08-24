import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../src/core/child-process.js', () => ({ spawnInheritedChild: child.run }));
import { readPackageManifest } from '../../../src/packages/package-manifest.js';
import { preparePackage } from '../../../src/skill-collections/skill-collection-preparation.js';

beforeEach(() => child.run.mockReset());

async function fixture(argv = ['builder', '--literal']) {
  const temp = await mkdtemp(join(tmpdir(), 'bazframe-package-preparation-'));
  const home = join(temp, 'home'); const root = join(temp, 'package'); await mkdir(home); await mkdir(root);
  await writeFile(join(root, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: argv, artifactRoot: 'dist', skillsRoot: 'skills' }));
  return { home, root };
}

describe('package process failure contract', () => {
  it('reports nonzero exit status', async () => {
    const { home, root } = await fixture(); child.run.mockResolvedValue({ exitCode: 7, signal: null });
    await expect(preparePackage(home, root)).rejects.toThrow(/status 7/);
  });

  it('refuses manifest drift after remote build authorization before starting the child', async () => {
    const { home, root } = await fixture();
    const authorized = await readPackageManifest(root);
    await writeFile(join(root, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: ['changed'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    await expect(preparePackage(home, root, process.env, undefined, authorized)).rejects.toMatchObject({ code: 'PACKAGE_MANIFEST_CHANGED' });
    expect(child.run).not.toHaveBeenCalled();
  });

  it('reports signal termination and preserves literal argv/cwd/environment at the child seam', async () => {
    const { home, root } = await fixture(); const environment = { PROBE: 'value' };
    child.run.mockResolvedValue({ exitCode: null, signal: 'SIGTERM' });
    await expect(preparePackage(home, root, environment)).rejects.toThrow(/signal SIGTERM/);
    expect(child.run).toHaveBeenCalledWith('builder', ['--literal'], { cwd: root, environment });
  });
});
