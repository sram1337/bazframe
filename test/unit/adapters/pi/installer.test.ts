import { chmod, lstat, readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installPiAdapter,
  inspectPiAdapter,
  uninstallPiAdapter,
  type PiAdapterLifecycleOptions
} from '../../../../src/adapters/pi/installer.js';
import { createTempDirectory, type TempDirectory } from '../../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

async function temporary(): Promise<TempDirectory> {
  const directory = await createTempDirectory();
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('Pi adapter installer', () => {
  it('installs, verifies, and idempotently recognizes the packaged artifact', async () => {
    const directory = await temporary();
    const options = await lifecycleOptions(directory, 'export default function one() {}\n');

    const installed = await installPiAdapter(options);
    expect(installed.action).toBe('installed');
    expect(await readFile(installed.targetPath, 'utf8'))
      .toBe('export default function one() {}\n');
    expect((await lstat(installed.targetPath)).mode & 0o777).toBe(0o600);
    expect((await inspectPiAdapter(options)).state).toBe('current');

    const repeated = await installPiAdapter(options);
    expect(repeated.action).toBe('current');
  });

  it('preserves permissions on existing Pi-owned directories', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporary();
    const extensions = await directory.mkdir('pi-agent/extensions');
    await chmod(directory.path('pi-agent'), 0o755);
    await chmod(extensions, 0o755);
    const options = await lifecycleOptions(directory, 'artifact\n');

    await installPiAdapter(options);

    expect((await lstat(directory.path('pi-agent'))).mode & 0o777).toBe(0o755);
    expect((await lstat(extensions)).mode & 0o777).toBe(0o755);
  });

  it('updates an older managed artifact', async () => {
    const directory = await temporary();
    const first = await lifecycleOptions(directory, 'first artifact\n', 'artifact-one.ts');
    const second = await lifecycleOptions(directory, 'second artifact\n', 'artifact-two.ts');
    await installPiAdapter(first);

    const updated = await installPiAdapter(second);
    expect(updated.action).toBe('updated');
    expect(await readFile(updated.targetPath, 'utf8')).toBe('second artifact\n');
    expect((await inspectPiAdapter(second)).state).toBe('current');
  });

  it('preserves drift until manifest-gated force repair is explicit', async () => {
    const directory = await temporary();
    const options = await lifecycleOptions(directory, 'expected artifact\n');
    const installed = await installPiAdapter(options);
    await directory.write(relativeToRoot(directory, installed.targetPath), 'user change\n');

    await expect(installPiAdapter(options)).rejects.toThrow(/--force/u);
    expect(await readFile(installed.targetPath, 'utf8')).toBe('user change\n');

    const repaired = await installPiAdapter(options, true);
    expect(repaired.action).toBe('repaired');
    expect(await readFile(installed.targetPath, 'utf8')).toBe('expected artifact\n');
  });

  it('preserves an occupied destination outside the ownership manifest', async () => {
    const directory = await temporary();
    const options = await lifecycleOptions(directory, 'expected artifact\n');
    const occupied = await directory.write('pi-agent/extensions/bazframe.ts', 'other owner\n');

    await expect(installPiAdapter(options)).rejects.toThrow(/owned by another/u);
    expect(await readFile(occupied, 'utf8')).toBe('other owner\n');
  });

  it('adopts exact packaged bytes by writing ownership metadata', async () => {
    const directory = await temporary();
    const options = await lifecycleOptions(directory, 'exact artifact\n');
    await directory.write('pi-agent/extensions/bazframe.ts', 'exact artifact\n');

    const adopted = await installPiAdapter(options);
    expect(adopted.action).toBe('adopted');
    expect(await stat(adopted.manifestPath)).toBeDefined();
    expect((await inspectPiAdapter(options)).state).toBe('current');
  });

  it('uninstalls verified state and cache, then succeeds idempotently', async () => {
    const directory = await temporary();
    const options = await lifecycleOptions(directory, 'artifact\n');
    const installed = await installPiAdapter(options);
    await directory.write('bazframe-home/adapter-cache/pi/skill-aliases/a/SKILL.md', 'alias');

    const removed = await uninstallPiAdapter(options);
    expect(removed.action).toBe('uninstalled');
    await expect(stat(installed.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(installed.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(directory.path('bazframe-home/adapter-cache/pi')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const repeated = await uninstallPiAdapter(options);
    expect(repeated.action).toBe('absent');
  });

  it('preflights malformed cache state before removing owned artifacts', async () => {
    const directory = await temporary();
    const options = await lifecycleOptions(directory, 'artifact\n');
    const installed = await installPiAdapter(options);
    await directory.write('bazframe-home/adapter-cache/pi', 'malformed cache\n');

    await expect(uninstallPiAdapter(options)).rejects.toThrow(/physical directory/u);
    expect(await stat(installed.targetPath)).toBeDefined();
    expect(await stat(installed.manifestPath)).toBeDefined();
  });

  it('preserves a drifted artifact during uninstall', async () => {
    const directory = await temporary();
    const options = await lifecycleOptions(directory, 'artifact\n');
    const installed = await installPiAdapter(options);
    await directory.write(relativeToRoot(directory, installed.targetPath), 'changed\n');

    await expect(uninstallPiAdapter(options)).rejects.toThrow(/changed and was preserved/u);
    expect(await readFile(installed.targetPath, 'utf8')).toBe('changed\n');
    expect(await stat(installed.manifestPath)).toBeDefined();
  });
});

async function lifecycleOptions(
  directory: TempDirectory,
  artifact: string,
  artifactName = 'artifact.ts'
): Promise<PiAdapterLifecycleOptions> {
  const artifactPath = await directory.write(artifactName, artifact);
  return {
    bazframeHome: directory.path('bazframe-home'),
    bazframeVersion: '0.1.0-test',
    environment: {
      PI_CODING_AGENT_DIR: directory.path('pi-agent')
    },
    artifactUrl: pathToFileURL(artifactPath)
  };
}

function relativeToRoot(directory: TempDirectory, path: string): string {
  const prefix = `${directory.root}/`;
  if (!path.startsWith(prefix)) throw new Error(`Path is outside fixture: ${path}`);
  return path.slice(prefix.length);
}
