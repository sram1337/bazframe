import { pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { installPiAdapter } from '../../../src/adapters/pi/installer.js';
import { writeActiveProfile } from '../../../src/profiles/profile-store.js';
import { findGitRoot } from '../../../src/project/git-root.js';
import { registerRepository } from '../../../src/project/registration-store.js';
import { buildStatus, type StatusOptions } from '../../../src/status/status.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

async function temporary(): Promise<TempDirectory> {
  const directory = await createTempDirectory();
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('Bazframe status', () => {
  it('reports a healthy adapter, registration, profile, aliases, and launch modes', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    await directory.write('bazframe-home/profiles/focused/AGENTS.md', 'profile\n');
    await directory.write('bazframe-home/profiles/focused/skills/review/SKILL.md', 'skill\n');
    await writeActiveProfile(options.bazframeHome, 'focused');
    await installPiAdapter(options);
    await registerRepository(
      options.bazframeHome,
      await findGitRoot(options.cwd, options.environment)
    );
    await directory.write(
      'bazframe-home/adapter-cache/pi/skill-aliases/focused/review-x-bazframe/SKILL.md',
      'alias\n'
    );

    const status = await buildStatus(options);

    expect(status.exitStatus, status.text).toBe(0);
    expect(status.text).toContain('Pi adapter: current');
    expect(status.text).toContain('Registration: registered');
    expect(status.text).toContain('Active profile: focused');
    expect(status.text).toContain('Profile skills: 1');
    expect(status.text).toContain('Cached collision aliases: 1');
    expect(status.text).toContain('pi -nc');
    expect(status.text).toContain('Corrective actions:\n  (none)');
  });

  it('reports incomplete setup with corrective commands while remaining read-only', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);

    const status = await buildStatus(options);

    expect(status.exitStatus).toBe(3);
    expect(status.text).toContain('Pi adapter: missing');
    expect(status.text).toContain('Registration: unregistered');
    expect(status.text).toContain('Active profile: (none)');
    expect(status.text).toContain('bazframe adapter install pi');
    expect(status.text).toContain('bazframe use <profile>');
    expect(status.text).toContain('bazframe init');
    await expect(stat(options.bazframeHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails on malformed managed alias-cache state', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    await directory.write('bazframe-home/adapter-cache/pi/skill-aliases', 'not a directory\n');

    await expect(buildStatus(options)).rejects.toThrow(/physical directory/u);
  });

  it('reports drift with explicit repair guidance', async () => {
    const directory = await temporary();
    const options = await statusOptions(directory);
    const installed = await installPiAdapter(options);
    await directory.write(relativeToRoot(directory, installed.targetPath), 'changed\n');

    const status = await buildStatus(options);

    expect(status.exitStatus).toBe(3);
    expect(status.text).toContain('Pi adapter: drifted');
    expect(status.text).toContain('adapter install pi --force');
  });
});

async function statusOptions(directory: TempDirectory): Promise<StatusOptions> {
  const repository = await directory.initGit('repository');
  const artifact = await directory.write('artifact.ts', 'adapter artifact\n');
  return {
    bazframeHome: directory.path('bazframe-home'),
    bazframeVersion: '0.1.0-test',
    environment: {
      PI_CODING_AGENT_DIR: directory.path('pi-agent')
    },
    cwd: repository,
    artifactUrl: pathToFileURL(artifact)
  };
}

function relativeToRoot(directory: TempDirectory, path: string): string {
  const prefix = `${directory.root}/`;
  if (!path.startsWith(prefix)) throw new Error(`Path is outside fixture: ${path}`);
  return path.slice(prefix.length);
}
