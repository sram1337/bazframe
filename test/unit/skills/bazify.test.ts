import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFlatSkillIdentities } from '../../../src/skill-collections/skill-collection-resolver.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillRoot = join(projectRoot, 'skills', 'bazify');
const script = join(skillRoot, 'scripts', 'bazify.mjs');
const bazframeCommand = join(projectRoot, 'dist', 'cli.js');
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Bazify Skill', () => {
  it('is Agent Skills-compatible and documents the consent-gated workflow', async () => {
    expect(loadFlatSkillIdentities([skillRoot])).toEqual([
      { name: 'bazify', definitionPath: join(skillRoot, 'SKILL.md') }
    ]);
    const definition = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
    expect(definition).toContain('node <bazify-skill-root>/scripts/bazify.mjs create');
    expect(definition).toContain('node <bazify-skill-root>/scripts/bazify.mjs validate');
    expect(definition).toContain('node <bazify-skill-root>/scripts/bazify.mjs publish');
    expect(definition).toContain('private');
    expect(definition).toContain('--yes');
    expect(definition).toContain('Never append `-bazframe`');
  });

  it('creates and validates a deterministic package at the default unsuffixed destination', async () => {
    const root = await temporaryRoot();
    const home = join(root, 'home');
    const source = await createSkill(join(root, 'provider', 'demo-skill'));
    await mkdir(home);
    await mkdir(join(source, '.git'));
    await writeFile(join(source, '.git', 'config'), 'provider git state\n');
    await mkdir(join(source, 'node_modules'));
    await writeFile(join(source, 'node_modules', 'ignored.js'), 'ignored\n');
    const environment = { ...process.env, HOME: home };

    const created = runBazify(['create', source, '--bazframe-command', bazframeCommand], environment);
    expect(created.status).toBe(0);
    const result = JSON.parse(created.stdout);
    const destination = join(home, 'demo-skill');
    expect(result).toMatchObject({
      command: 'create',
      packageName: 'demo-skill',
      skillName: 'demo-skill',
      destination: await canonical(destination),
      status: 'created',
      excluded: ['.git', 'node_modules']
    });
    expect(result.packageName).not.toContain('-bazframe');
    expect(JSON.parse(await readFile(join(destination, 'bazframe-package.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      build: ['node', 'scripts/build.mjs'],
      artifactRoot: 'dist',
      skillsRoot: 'skills'
    });
    expect(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'))).toMatchObject({
      name: 'demo-skill',
      private: true,
      description: 'Provider-owned Bazframe-compatible Skill package for demo-skill.',
      scripts: { build: 'node scripts/build.mjs' }
    });
    expect(await readFile(join(destination, 'README.md'), 'utf8')).toContain('provider-owned Agent Skill package');
    expect(await readFile(join(destination, 'src', 'skills', 'demo-skill', 'reference.txt'), 'utf8')).toBe('reference\n');
    expect(await readFile(join(destination, 'dist', 'skills', 'demo-skill', 'reference.txt'), 'utf8')).toBe('reference\n');
    await expect(lstat(join(destination, 'src', 'skills', 'demo-skill', '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(destination, 'src', 'skills', 'demo-skill', 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (process.platform !== 'win32') {
      expect((await lstat(join(destination, 'src', 'skills', 'demo-skill', 'scripts', 'run.sh'))).mode & 0o111).not.toBe(0);
    }

    await writeFile(join(destination, 'dist', 'stale.txt'), 'stale\n');
    const rebuilt = spawnSync(process.execPath, [join(destination, 'scripts', 'build.mjs')], {
      cwd: destination,
      encoding: 'utf8',
      shell: false
    });
    expect(rebuilt.status).toBe(0);
    await expect(lstat(join(destination, 'dist', 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const validated = runBazify(['validate', destination, '--bazframe-command', bazframeCommand], environment);
    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ status: 'valid', packageName: 'demo-skill' });
  });

  it('supports a custom safe name, dry-run, and fail-closed destination handling', async () => {
    const root = await temporaryRoot();
    const source = await createSkill(join(root, 'provider', 'demo-skill'));
    await writeFile(join(source, 'SKILL.md'), '---\nname: demo-skill # accepted YAML comment\ndescription: Test Skill for Bazify conversion.\n---\n# demo-skill\n');
    const parent = join(root, 'packages');
    const destination = join(parent, 'review-tool');
    const workspace = join(root, 'bazframe');
    await mkdir(parent);
    await mkdir(workspace);

    const insideWorkspace = runBazify([
      'create', source,
      '--name', 'review-tool',
      '--destination', join(workspace, 'review-tool'),
      '--dry-run'
    ], process.env, root);
    expect(insideWorkspace.status).toBe(2);
    expect(insideWorkspace.stderr).toContain('must remain outside Bazframe working area');

    const dryRun = runBazify([
      'create', source,
      '--name', 'review-tool',
      '--destination', destination,
      '--dry-run'
    ]);
    expect(dryRun.status).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ packageName: 'review-tool', status: 'planned' });
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(destination);
    const collision = runBazify([
      'create', source,
      '--name', 'review-tool',
      '--destination', destination,
      '--bazframe-command', bazframeCommand
    ]);
    expect(collision.status).toBe(4);
    expect(collision.stderr).toContain('already occupied');
    expect(await lstat(destination)).toBeDefined();
  });

  it('rejects internal links and obvious credential material without leaving a destination', async () => {
    const root = await temporaryRoot();
    const source = await createSkill(join(root, 'provider', 'linked-skill'), 'linked-skill');
    const destination = join(root, 'linked-skill');
    await symlink(join(source, 'reference.txt'), join(source, 'linked-reference'));
    const linked = runBazify(['create', source, '--destination', destination, '--bazframe-command', bazframeCommand]);
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain('symbolic link');
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    await rm(join(source, 'linked-reference'));
    await writeFile(join(source, '.env'), 'TOKEN=secret\n');
    const secret = runBazify(['create', source, '--destination', destination, '--bazframe-command', bazframeCommand]);
    expect(secret.status).toBe(1);
    expect(secret.stderr).toContain('credential file');
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires consent and publishes only through exact private GitHub argv', async () => {
    const root = await temporaryRoot();
    const source = await createSkill(join(root, 'provider', 'publish-skill'), 'publish-skill');
    const destination = join(root, 'package-parent', 'publish-skill');
    await mkdir(dirname(destination));
    const created = runBazify(['create', source, '--destination', destination, '--bazframe-command', bazframeCommand]);
    expect(created.status).toBe(0);
    const readmePath = join(destination, 'README.md');

    const bin = join(root, 'bin');
    const ghLog = join(root, 'gh.log');
    await mkdir(bin);
    const fakeGh = join(bin, 'gh');
    await writeFile(fakeGh, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.BAZIFY_GH_LOG, JSON.stringify({
  args,
  gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,
  gitConfigNoSystem: process.env.GIT_CONFIG_NOSYSTEM,
  gitConfigCount: process.env.GIT_CONFIG_COUNT
}) + '\\n');
if (args.join(' ') === 'api --hostname github.com user --jq .login') { process.stdout.write('test-owner\\n'); process.exit(0); }
if (args[0] === 'api') { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
if (args[0] === 'repo' && args[1] === 'create') process.exit(0);
process.exit(9);
`);
    await chmod(fakeGh, 0o755);
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      BAZIFY_GH_LOG: ghLog,
      GH_HOST: 'enterprise.invalid',
      GIT_CONFIG_GLOBAL: join(root, 'hostile.gitconfig'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://evil.invalid/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/'
    };

    const refused = runBazify(['publish', destination, '--bazframe-command', bazframeCommand], environment);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('requires explicit confirmation');
    await expect(lstat(ghLog)).rejects.toMatchObject({ code: 'ENOENT' });

    const preview = runBazify(['publish', destination, '--dry-run', '--bazframe-command', bazframeCommand], environment);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      repository: 'test-owner/publish-skill',
      visibility: 'private',
      status: 'planned'
    });

    const previewResult = JSON.parse(preview.stdout);
    expect(previewResult).toMatchObject({ host: 'github.com', repository: 'test-owner/publish-skill' });
    const reviewedReadme = await readFile(readmePath, 'utf8');
    await writeFile(readmePath, `${reviewedReadme}\nchanged after approval\n`);
    const drifted = runBazify([
      'publish', destination, '--yes', '--approval', previewResult.approval, '--bazframe-command', bazframeCommand
    ], environment);
    expect(drifted.status).toBe(2);
    expect(drifted.stderr).toContain('does not match');
    await expect(lstat(join(destination, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(readmePath, reviewedReadme);
    const refreshedPreview = runBazify(['publish', destination, '--dry-run', '--bazframe-command', bazframeCommand], environment);
    expect(refreshedPreview.status).toBe(0);
    const approval = JSON.parse(refreshedPreview.stdout).approval;

    const published = runBazify([
      'publish', destination, '--yes', '--approval', approval, '--bazframe-command', bazframeCommand
    ], environment);
    expect(published.status).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({
      host: 'github.com',
      repository: 'test-owner/publish-skill',
      visibility: 'private',
      status: 'published'
    });
    const calls = (await readFile(ghLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      args: string[];
      gitConfigGlobal?: string;
      gitConfigNoSystem?: string;
      gitConfigCount?: string;
    });
    const create = calls.find((call) => call.args[0] === 'repo' && call.args[1] === 'create');
    expect(create?.args).toEqual([
      'repo', 'create', 'test-owner/publish-skill', '--private', '--source', await canonical(destination), '--remote', 'origin', '--push'
    ]);
    expect(create).toMatchObject({ gitConfigGlobal: '/dev/null', gitConfigNoSystem: '1' });
    expect(create?.gitConfigCount).toBeUndefined();
    expect(calls.flatMap((call) => call.args)).not.toContain('--public');
    const tracked = spawnSync('git', ['-C', destination, 'ls-files'], { encoding: 'utf8', shell: false });
    expect(tracked.status).toBe(0);
    expect(tracked.stdout).toContain('src/skills/publish-skill/SKILL.md');
    expect(tracked.stdout).not.toContain('dist/');
  });

  it('stops before commit when package bytes change immediately after Git staging', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot();
    const source = await createSkill(join(root, 'provider', 'staged-skill'), 'staged-skill');
    const destination = join(root, 'output', 'staged-skill');
    await mkdir(dirname(destination));
    expect(runBazify(['create', source, '--destination', destination, '--bazframe-command', bazframeCommand]).status).toBe(0);
    const readmePath = join(destination, 'README.md');

    const bin = join(root, 'bin');
    const ghLog = join(root, 'gh.log');
    await mkdir(bin);
    const fakeGh = join(bin, 'gh');
    await writeFile(fakeGh, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.BAZIFY_GH_LOG, JSON.stringify(args) + '\\n');
if (args.join(' ') === 'api --hostname github.com user --jq .login') { process.stdout.write('test-owner\\n'); process.exit(0); }
if (args[0] === 'api') { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
if (args[0] === 'repo' && args[1] === 'create') process.exit(0);
process.exit(9);
`);
    await chmod(fakeGh, 0o755);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8', shell: false }).stdout.trim();
    expect(realGit).not.toBe('');
    const fakeGit = join(bin, 'git-wrapper');
    await writeFile(fakeGit, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const result = spawnSync(process.env.BAZIFY_REAL_GIT, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit', shell: false });
if (result.status === 0 && args[0] === 'add') appendFileSync(process.env.BAZIFY_MUTATE_PATH, '\\nchanged after staging\\n');
process.exit(result.status ?? 1);
`);
    await chmod(fakeGit, 0o755);
    const environment = {
      ...process.env,
      BAZIFY_GH_COMMAND: fakeGh,
      BAZIFY_GIT_COMMAND: fakeGit,
      BAZIFY_GH_LOG: ghLog,
      BAZIFY_REAL_GIT: realGit,
      BAZIFY_MUTATE_PATH: readmePath
    };
    const preview = runBazify(['publish', destination, '--dry-run', '--bazframe-command', bazframeCommand], environment);
    expect(preview.status).toBe(0);
    const approval = JSON.parse(preview.stdout).approval;
    const published = runBazify([
      'publish', destination, '--yes', '--approval', approval, '--bazframe-command', bazframeCommand
    ], environment);
    expect(published.status).toBe(1);
    expect(published.stderr).toContain('changed while preparing the Git commit');
    const calls = (await readFile(ghLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(calls.some((arguments_) => arguments_[0] === 'repo' && arguments_[1] === 'create')).toBe(false);
    expect(spawnSync(realGit, ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8', shell: false }).status).not.toBe(0);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bazify-test-'));
  temporaryRoots.push(root);
  return root;
}

async function createSkill(path: string, name = 'demo-skill'): Promise<string> {
  await mkdir(join(path, 'scripts'), { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Test Skill for Bazify conversion.\n---\n# ${name}\n`);
  await writeFile(join(path, 'reference.txt'), 'reference\n');
  await writeFile(join(path, 'scripts', 'run.sh'), '#!/bin/sh\necho test\n');
  await chmod(join(path, 'scripts', 'run.sh'), 0o755);
  return path;
}

function runBazify(
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = projectRoot
) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd: workingDirectory,
    env: environment,
    encoding: 'utf8',
    shell: false
  });
}

async function canonical(path: string): Promise<string> {
  return resolve(await realpath(path));
}
