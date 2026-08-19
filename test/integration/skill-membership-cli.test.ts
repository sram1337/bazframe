import { spawn } from 'node:child_process';
import { lstat, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotFilesystem } from '../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => item.cleanup())));
interface CliResult { status: number | null; stdout: string; stderr: string }

describe('default catalog and profile skill CLI', () => {
  it('registers, selects, and removes parallel links without changing provider content', async () => {
    if (process.platform === 'win32') return;
    const fixture = await setup();
    const before = await snapshotFilesystem(fixture.provider);
    expect(await run(['add', 'skill', fixture.source], fixture)).toMatchObject({ status: 0, stderr: '' });
    expect(await readlink(fixture.registration)).toBe(fixture.source);
    const listed = await run(['skills'], fixture);
    expect(listed.stdout).toContain('Source: (default)');
    expect(listed.stdout).toContain(`demo-skill -> ${fixture.source}`);
    expect((await run(['skill'], fixture)).stdout).toBe(listed.stdout);

    await run(['profile', 'use', 'focused'], fixture);
    const added = await run(['profile', 'skills', 'add', 'demo-skill'], fixture);
    expect(added).toMatchObject({ status: 0, stderr: '' });
    expect(await readlink(fixture.membership)).toBe(fixture.source);
    expect(await readlink(fixture.registration)).toBe(fixture.source);
    await expect(run(['remove', 'skill', 'demo-skill'], fixture)).resolves.toMatchObject({ status: 1 });
    await expect(run(['profile', 'skills', 'remove', 'demo-skill'], fixture)).resolves.toMatchObject({ status: 0 });
    await expect(run(['remove', 'skill', 'demo-skill'], fixture)).resolves.toMatchObject({ status: 0 });
    await expect(lstat(fixture.registration)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotFilesystem(fixture.provider)).toEqual(before);
  });

  it('is same-target idempotent and rejects occupied, malformed, and obsolete grammar', async () => {
    if (process.platform === 'win32') return;
    const fixture = await setup();
    await expect(run(['add', 'skill', fixture.source], fixture)).resolves.toMatchObject({ status: 0 });
    const current = await run(['add', 'skill', fixture.source], fixture);
    expect(current.stdout).toContain('Default skill registration: current');
    for (const argv of [
      ['add', 'demo-skill'], ['remove', 'demo-skill'], ['skill', 'add', fixture.source],
      ['skills', 'add', fixture.source], ['add', 'skills', fixture.source], ['add', 'skill', 'relative']
    ]) expect((await run(argv, fixture)).status).toBe(2);

    await rm(fixture.registration);
    await fixture.directory.mkdir('home/skills/demo-skill');
    const occupied = await run(['add', 'skill', fixture.source], fixture);
    expect(occupied.status).toBe(1);
    expect(occupied.stderr).toContain('occupied');
  });

  it('targets inactive profiles and rejects foreign membership links', async () => {
    if (process.platform === 'win32') return;
    const fixture = await setup();
    await run(['add', 'skill', fixture.source], fixture);
    await run(['profile', 'use', 'focused'], fixture);
    await expect(run(['profile', 'skills', 'add', 'demo-skill', '--profile', 'reviewer'], fixture)).resolves.toMatchObject({ status: 0 });
    expect(await readlink(fixture.reviewerMembership)).toBe(fixture.source);
    expect((await run(['profile', 'current'], fixture)).stdout).toBe('focused\n');
    await rm(fixture.reviewerMembership);
    const foreign = await fixture.directory.mkdir('foreign/demo-skill');
    await symlink(foreign, fixture.reviewerMembership);
    const refused = await run(['profile', 'skills', 'remove', 'demo-skill', '--profile', 'reviewer'], fixture);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('targets');
  });

  it('suggests close registered IDs and reports missing active selection', async () => {
    const fixture = await setup();
    await run(['add', 'skill', fixture.source], fixture);
    const missing = await run(['profile', 'skills', 'add', 'demo-skill'], fixture);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('No active profile');
    await run(['profile', 'use', 'focused'], fixture);
    const typo = await run(['profile', 'skills', 'add', 'demo-skil'], fixture);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain('Did you mean "demo-skill"?');
  });
});

async function setup() {
  const directory = await createTempDirectory('catalog-cli-'); directories.push(directory);
  const home = directory.path('home');
  await directory.write('home/profiles/focused/AGENTS.md', 'focused\n');
  await directory.mkdir('home/profiles/focused/skills');
  await directory.write('home/profiles/reviewer/AGENTS.md', 'reviewer\n');
  await directory.mkdir('home/profiles/reviewer/skills');
  await directory.write('provider/demo-skill/SKILL.md', skill('demo-skill'));
  await directory.write('provider/demo-skill/support.txt', 'provider\n');
  const source = await realpath(directory.path('provider/demo-skill'));
  return {
    directory, home, source, provider: directory.path('provider'),
    registration: directory.path('home/skills/demo-skill'),
    membership: directory.path('home/profiles/focused/skills/demo-skill'),
    reviewerMembership: directory.path('home/profiles/reviewer/skills/demo-skill'),
    cwd: await directory.mkdir('outside-git'),
    environment: { ...process.env, BAZFRAME_HOME: home }
  };
}
function skill(name: string) { return `---\nname: ${name}\ndescription: Integration fixture.\n---\n\n# ${name}\n`; }
function run(args: readonly string[], fixture: Awaited<ReturnType<typeof setup>>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: fixture.cwd, env: fixture.environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; }); child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject); child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}
