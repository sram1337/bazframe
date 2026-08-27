import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
    expect(definition).toContain('node <bazify-skill-root>/scripts/bazify.mjs adapt');
    expect(definition).toContain('node <bazify-skill-root>/scripts/bazify.mjs validate');
    expect(definition).toContain('node <bazify-skill-root>/scripts/bazify.mjs publish');
    expect(definition).toContain('private');
    expect(definition).toContain('--yes');
    const help = runBazify(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--name <id>                 Create only; defaults to one Skill name or the collection-root name');
  });

  it('creates and validates a deterministic package at the default source-named destination', async () => {
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
      excluded: ['demo-skill/.git', 'demo-skill/node_modules']
    });
    expect(JSON.parse(await readFile(join(destination, 'bazframe-package.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      build: ['node', 'scripts/bazify-build.mjs'],
      artifactRoot: 'dist',
      skillsRoot: 'skills'
    });
    expect(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'))).toMatchObject({
      name: 'demo-skill',
      private: true,
      description: 'Provider-owned Bazframe-compatible Skill package containing 1 Skill.',
      scripts: { build: 'node scripts/bazify-build.mjs' }
    });
    const generatedReadme = await readFile(join(destination, 'README.md'), 'utf8');
    expect(generatedReadme).toContain('provider-owned Agent Skill package');
    expect(generatedReadme).not.toContain(`Bazframe ${'2'}`);
    expect(await readFile(join(destination, 'skills', 'demo-skill', 'reference.txt'), 'utf8')).toBe('reference\n');
    expect(await readFile(join(destination, 'dist', 'skills', 'demo-skill', 'reference.txt'), 'utf8')).toBe('reference\n');
    await expect(lstat(join(destination, 'skills', 'demo-skill', '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(destination, 'skills', 'demo-skill', 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (process.platform !== 'win32') {
      expect((await lstat(join(destination, 'skills', 'demo-skill', 'scripts', 'run.sh'))).mode & 0o111).not.toBe(0);
    }

    await writeFile(join(destination, 'dist', 'stale.txt'), 'stale\n');
    const rebuilt = spawnSync(process.execPath, [join(destination, 'scripts', 'bazify-build.mjs')], {
      cwd: destination,
      encoding: 'utf8',
      shell: false
    });
    expect(rebuilt.status).toBe(0);
    await expect(lstat(join(destination, 'dist', 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const providerReference = join(destination, 'skills', 'demo-skill', 'reference.txt');
    await rm(providerReference);
    await symlink(join(destination, 'skills', 'demo-skill', 'SKILL.md'), providerReference);
    const failedBuild = spawnSync(process.execPath, [join(destination, 'scripts', 'bazify-build.mjs')], {
      cwd: destination,
      encoding: 'utf8',
      shell: false
    });
    expect(failedBuild.status).not.toBe(0);
    expect(await readFile(join(destination, 'dist', 'skills', 'demo-skill', 'reference.txt'), 'utf8')).toBe('reference\n');
    await rm(providerReference);
    await writeFile(providerReference, 'reference\n');
    const validated = runBazify(['validate', destination, '--bazframe-command', bazframeCommand], environment);
    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ status: 'valid', packageName: 'demo-skill' });
  });

  it('extracts every immediate Skill from a project without copying unrelated project files', async () => {
    const root = await temporaryRoot();
    const project = join(root, 'tool-suite');
    await createSkill(join(project, 'skills', 'alpha-skill'), 'alpha-skill');
    await createSkill(join(project, 'skills', 'beta-skill'), 'beta-skill');
    await writeFile(join(project, 'README.md'), 'unrelated project documentation\n');
    await writeFile(join(project, '.env'), 'PROJECT_SECRET=not-copied\n');
    const parent = join(root, 'packages');
    await mkdir(parent);
    const destination = join(parent, 'tool-suite');

    const created = runBazify([
      'create', project, '--destination', destination, '--bazframe-command', bazframeCommand
    ]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      packageName: 'tool-suite',
      skillNames: ['alpha-skill', 'beta-skill'],
      status: 'created'
    });
    expect(await readFile(join(destination, 'skills', 'alpha-skill', 'SKILL.md'), 'utf8')).toContain('name: alpha-skill');
    expect(await readFile(join(destination, 'dist', 'skills', 'beta-skill', 'SKILL.md'), 'utf8')).toContain('name: beta-skill');
    await expect(lstat(join(destination, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(destination, 'README.md'), 'utf8')).not.toContain('unrelated project documentation');
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

  it('rejects a symlinked skills collection root for extraction and adaptation', async () => {
    const root = await temporaryRoot();
    const external = join(root, 'external-skills');
    await createSkill(join(external, 'linked-skill'), 'linked-skill');
    const repository = join(root, 'linked-collection');
    await mkdir(repository);
    await symlink(external, join(repository, 'skills'));
    const destinationParent = join(root, 'packages');
    await mkdir(destinationParent);

    const created = runBazify([
      'create', repository, '--destination', join(destinationParent, 'linked-collection'), '--dry-run'
    ]);
    expect(created.status).toBe(1);
    expect(created.stderr).toContain('must be a physical directory');
    const adapted = runBazify(['adapt', repository, '--dry-run']);
    expect(adapted.status).toBe(1);
    expect(adapted.stderr).toContain('must be a physical directory');
  });

  it('adapts a clean multi-Skill repository in place while preserving Git and provider files', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'personal-agent-network');
    await createSkill(join(repository, 'skills', 'personal-agent-network'), 'personal-agent-network');
    await createSkill(join(repository, 'skills', 'personal-agent-network-setup'), 'personal-agent-network-setup');
    await writeFile(join(repository, 'README.md'), 'provider readme\n');
    await writeFile(join(repository, 'AGENTS.md'), 'provider instructions\n');
    await writeFile(join(repository, 'package.json'), '{"name":"provider"}\n');
    await writeFile(join(repository, '.gitignore'), '.DS_Store\n.env\n');
    initializeRepository(repository, 'https://github.com/example/personal-agent-network.git');
    const headBefore = git(repository, ['rev-parse', 'HEAD']).stdout;
    const configBefore = await readFile(join(repository, '.git', 'config'));
    const ignoreModeBefore = (await lstat(join(repository, '.gitignore'))).mode & 0o777;
    const preserved = new Map<string, Buffer>();
    for (const path of ['README.md', 'AGENTS.md', 'package.json', 'skills/personal-agent-network/SKILL.md', 'skills/personal-agent-network-setup/SKILL.md']) {
      preserved.set(path, await readFile(join(repository, path)));
    }

    const adapted = runBazify(['adapt', repository, '--bazframe-command', bazframeCommand]);
    expect(adapted.status).toBe(0);
    expect(JSON.parse(adapted.stdout)).toMatchObject({
      packageName: 'personal-agent-network',
      skillNames: ['personal-agent-network', 'personal-agent-network-setup'],
      status: 'adapted'
    });
    expect(git(repository, ['rev-parse', 'HEAD']).stdout).toBe(headBefore);
    expect(await readFile(join(repository, '.git', 'config'))).toEqual(configBefore);
    for (const [path, bytes] of preserved) expect(await readFile(join(repository, path))).toEqual(bytes);
    expect(await readFile(join(repository, 'dist', 'skills', 'personal-agent-network', 'SKILL.md'), 'utf8')).toContain('name: personal-agent-network');
    expect(await readFile(join(repository, 'dist', 'skills', 'personal-agent-network-setup', 'SKILL.md'), 'utf8')).toContain('name: personal-agent-network-setup');
    expect(await readFile(join(repository, '.gitignore'), 'utf8')).toContain('/dist/\n');
    expect((await lstat(join(repository, '.gitignore'))).mode & 0o777).toBe(ignoreModeBefore);
    expect(git(repository, ['remote', 'get-url', 'origin']).stdout.trim()).toBe('https://github.com/example/personal-agent-network.git');

    const current = runBazify(['adapt', repository, '--bazframe-command', bazframeCommand]);
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout).status).toBe('current');
    const validated = runBazify(['validate', repository, '--bazframe-command', bazframeCommand]);
    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout).skillNames).toEqual(['personal-agent-network', 'personal-agent-network-setup']);
    const publication = runBazify(['publish', repository, '--dry-run', '--bazframe-command', bazframeCommand]);
    expect(publication.status).toBe(1);
    expect(publication.stderr).toContain('existing Git worktree');
  });

  it('keeps Git repository bytes unchanged during adapt dry-run and disables optional Git locks', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot();
    const repository = join(root, 'dry-run-repository');
    await createSkill(join(repository, 'skills', 'dry-run-skill'), 'dry-run-skill');
    initializeRepository(repository);
    const indexBefore = await readFile(join(repository, '.git', 'index'));
    const configBefore = await readFile(join(repository, '.git', 'config'));
    const definitionBefore = await readFile(join(repository, 'skills', 'dry-run-skill', 'SKILL.md'));
    const statusBefore = git(repository, ['status', '--porcelain', '--untracked-files=all']).stdout;

    const realGit = spawnSync('which', ['git'], { encoding: 'utf8', shell: false }).stdout.trim();
    expect(realGit).not.toBe('');
    const gitLog = join(root, 'git-inspection.log');
    const wrapper = join(root, 'git-wrapper');
    await writeFile(wrapper, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.BAZIFY_GIT_LOG, JSON.stringify({ args, optionalLocks: process.env.GIT_OPTIONAL_LOCKS }) + '\\n');
const result = spawnSync(process.env.BAZIFY_REAL_GIT, args, { cwd: process.cwd(), env: process.env, encoding: null, shell: false });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`);
    await chmod(wrapper, 0o755);
    const dryRun = runBazify(['adapt', repository, '--dry-run'], {
      ...process.env,
      BAZIFY_GIT_COMMAND: wrapper,
      BAZIFY_REAL_GIT: realGit,
      BAZIFY_GIT_LOG: gitLog
    });
    expect(dryRun.status).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ command: 'adapt', dryRun: true, status: 'planned' });
    const calls = (await readFile(gitLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      args: string[];
      optionalLocks?: string;
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.optionalLocks === '0')).toBe(true);
    expect(await readFile(join(repository, '.git', 'index'))).toEqual(indexBefore);
    expect(await readFile(join(repository, '.git', 'config'))).toEqual(configBefore);
    expect(await readFile(join(repository, 'skills', 'dry-run-skill', 'SKILL.md'))).toEqual(definitionBefore);
    expect(git(repository, ['status', '--porcelain', '--untracked-files=all']).stdout).toBe(statusBefore);
    await expect(lstat(join(repository, 'bazframe-package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adapts a SKILL.md-only root repository without treating generated scripts as source', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'root-skill');
    await mkdir(repository);
    await writeFile(join(repository, 'SKILL.md'), '---\nname: root-skill\ndescription: Root Skill.\n---\n# root-skill\n');
    initializeRepository(repository);

    const adapted = runBazify(['adapt', repository, '--bazframe-command', bazframeCommand]);
    expect(adapted.status).toBe(0);
    expect(JSON.parse(adapted.stdout)).toMatchObject({ skillNames: ['root-skill'], status: 'adapted' });
    expect(await readFile(join(repository, 'dist', 'skills', 'root-skill', 'SKILL.md'), 'utf8')).toContain('name: root-skill');
    await expect(lstat(join(repository, 'dist', 'skills', 'root-skill', 'scripts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses dirty or colliding repositories and rolls back failed adaptation', async () => {
    const root = await temporaryRoot();
    const dirty = join(root, 'dirty-repo');
    await createSkill(join(dirty, 'skills', 'dirty-skill'), 'dirty-skill');
    initializeRepository(dirty);
    await writeFile(join(dirty, 'untracked.txt'), 'dirty\n');
    const dirtyResult = runBazify(['adapt', dirty, '--bazframe-command', bazframeCommand]);
    expect(dirtyResult.status).toBe(1);
    expect(dirtyResult.stderr).toContain('clean Git worktree');
    await expect(lstat(join(dirty, 'bazframe-package.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const colliding = join(root, 'colliding-repo');
    await createSkill(join(colliding, 'skills', 'collision-skill'), 'collision-skill');
    await writeFile(join(colliding, 'bazframe-package.json'), '{}\n');
    initializeRepository(colliding);
    const collision = runBazify(['adapt', colliding, '--bazframe-command', bazframeCommand]);
    expect(collision.status).toBe(1);
    expect(collision.stderr).toContain('do not match');
    expect(await readFile(join(colliding, 'bazframe-package.json'), 'utf8')).toBe('{}\n');

    const trackedDist = join(root, 'tracked-dist-repo');
    await createSkill(join(trackedDist, 'skills', 'tracked-dist-skill'), 'tracked-dist-skill');
    await mkdir(join(trackedDist, 'dist'));
    await writeFile(join(trackedDist, 'dist', 'preserved.txt'), 'tracked artifact\n');
    initializeRepository(trackedDist);
    const trackedBytes = await readFile(join(trackedDist, 'dist', 'preserved.txt'));
    const trackedResult = runBazify(['adapt', trackedDist, '--bazframe-command', bazframeCommand]);
    expect(trackedResult.status).toBe(1);
    expect(trackedResult.stderr).toContain('dist to be generated, ignored, and untracked');
    expect(await readFile(join(trackedDist, 'dist', 'preserved.txt'))).toEqual(trackedBytes);
    await expect(lstat(join(trackedDist, 'bazframe-package.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const locked = join(root, 'locked-repo');
    await createSkill(join(locked, 'skills', 'locked-skill'), 'locked-skill');
    await writeFile(join(locked, '.gitignore'), '/.bazify-adapt-*/\n');
    initializeRepository(locked);
    await mkdir(join(locked, '.bazify-adapt-lock'));
    const lockedResult = runBazify(['adapt', locked, '--bazframe-command', bazframeCommand]);
    expect(lockedResult.status).toBe(1);
    expect(lockedResult.stderr).toContain('Another Bazify adaptation or recovery owns');
    await expect(lstat(join(locked, 'bazframe-package.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const preBackupFailure = join(root, 'pre-backup-failure');
    await createSkill(join(preBackupFailure, 'skills', 'pre-backup-skill'), 'pre-backup-skill');
    await writeFile(join(preBackupFailure, 'dist'), 'pre-existing non-directory artifact\n');
    const preBackupBytes = await readFile(join(preBackupFailure, 'dist'));
    const preBackupResult = runBazify(['adapt', preBackupFailure, '--bazframe-command', bazframeCommand]);
    expect(preBackupResult.status).toBe(1);
    expect(preBackupResult.stderr).toContain('dist must be a physical directory');
    expect(await readFile(join(preBackupFailure, 'dist'))).toEqual(preBackupBytes);
    await expect(lstat(join(preBackupFailure, 'bazframe-package.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const rollback = join(root, 'rollback-repo');
    await createSkill(join(rollback, 'skills', 'rollback-skill'), 'rollback-skill');
    await writeFile(join(rollback, '.gitignore'), '/dist/\n');
    initializeRepository(rollback);
    await mkdir(join(rollback, 'dist'));
    await writeFile(join(rollback, 'dist', 'preserved.txt'), 'old artifact\n');
    const ignoreBefore = await readFile(join(rollback, '.gitignore'));
    const ignoreModeBefore = (await lstat(join(rollback, '.gitignore'))).mode & 0o777;
    const failingBazframe = join(root, 'failing-bazframe');
    await writeFile(failingBazframe, '#!/bin/sh\nexit 1\n');
    await chmod(failingBazframe, 0o755);
    const failed = runBazify(['adapt', rollback, '--bazframe-command', failingBazframe]);
    expect(failed.status).toBe(1);
    expect(await readFile(join(rollback, '.gitignore'))).toEqual(ignoreBefore);
    expect((await lstat(join(rollback, '.gitignore'))).mode & 0o777).toBe(ignoreModeBefore);
    expect(await readFile(join(rollback, 'dist', 'preserved.txt'), 'utf8')).toBe('old artifact\n');
    await expect(lstat(join(rollback, 'bazframe-package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(rollback, 'scripts', 'bazify-build.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });

    const hostile = join(root, 'hostile-rollback');
    await createSkill(join(hostile, 'skills', 'hostile-skill'), 'hostile-skill');
    const mutatingBazframe = join(root, 'mutating-bazframe');
    await writeFile(mutatingBazframe, '#!/bin/sh\nprintf "external mutation\\n" >> "$3/bazframe-package.json"\nexit 1\n');
    await chmod(mutatingBazframe, 0o755);
    const hostileResult = runBazify(['adapt', hostile, '--bazframe-command', mutatingBazframe]);
    expect(hostileResult.status).toBe(1);
    expect(hostileResult.stderr).toContain('safe recovery could not be proven');
    expect(await readFile(join(hostile, 'bazframe-package.json'), 'utf8')).toContain('external mutation');
    await expect(lstat(join(hostile, '.bazify-adapt-lock'))).rejects.toMatchObject({ code: 'ENOENT' });

    const sourceDrift = join(root, 'source-drift');
    await createSkill(join(sourceDrift, 'skills', 'drift-skill'), 'drift-skill');
    const mutatingSuccess = join(root, 'mutating-success-bazframe');
    await writeFile(mutatingSuccess, `#!/bin/sh
"${process.execPath}" "$3/scripts/bazify-build.mjs" || exit 1
printf "changed during validation\\n" >> "$3/skills/drift-skill/reference.txt"
exit 0
`);
    await chmod(mutatingSuccess, 0o755);
    const driftResult = runBazify(['adapt', sourceDrift, '--bazframe-command', mutatingSuccess]);
    expect(driftResult.status).toBe(1);
    expect(driftResult.stderr).toContain('changed while adaptation was validated');
    expect(await readFile(join(sourceDrift, 'skills', 'drift-skill', 'reference.txt'), 'utf8')).toContain('changed during validation');
    await expect(lstat(join(sourceDrift, 'bazframe-package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a replaced dist and prior artifact when validated output ownership cannot be proven', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'replaced-dist');
    await createSkill(join(repository, 'skills', 'replacement-skill'), 'replacement-skill');
    await mkdir(join(repository, 'dist'));
    await writeFile(join(repository, 'dist', 'preserved.txt'), 'prior artifact\n');
    const inodeLog = join(root, 'dist-inodes.log');
    const replacingBazframe = join(root, 'replacing-dist-bazframe');
    await writeFile(replacingBazframe, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[4];
const build = spawnSync(process.execPath, [join(root, 'scripts', 'bazify-build.mjs')], { cwd: root, stdio: 'inherit', shell: false });
if (build.status !== 0) process.exit(build.status ?? 1);
const dist = join(root, 'dist');
const displaced = join(root, \`.external-dist-\${process.pid}\`);
const before = lstatSync(dist);
renameSync(dist, displaced);
cpSync(displaced, dist, { recursive: true });
mkdirSync(join(dist, 'external'));
writeFileSync(join(dist, 'external', 'marker.txt'), 'external replacement\\n');
const after = lstatSync(dist);
appendFileSync(process.env.BAZIFY_DIST_INODE_LOG, JSON.stringify({ before: String(before.ino), after: String(after.ino) }) + '\\n');
rmSync(displaced, { recursive: true, force: true });
process.exit(0);
`);
    await chmod(replacingBazframe, 0o755);

    const adapted = runBazify(['adapt', repository, '--bazframe-command', replacingBazframe], {
      ...process.env,
      BAZIFY_DIST_INODE_LOG: inodeLog
    });
    expect(adapted.status).toBe(1);
    expect(adapted.stderr).toContain('safe recovery could not be proven');
    expect(await readFile(join(repository, 'dist', 'external', 'marker.txt'), 'utf8')).toBe('external replacement\n');
    const inodes = JSON.parse((await readFile(inodeLog, 'utf8')).trim()) as { before: string; after: string };
    expect(inodes.before).not.toBe(inodes.after);
    const recovery = (await readdir(repository)).filter((name) => name.startsWith('.bazify-adapt-'));
    expect(recovery).toHaveLength(1);
    expect(await readFile(join(repository, recovery[0], 'dist', 'preserved.txt'), 'utf8')).toBe('prior artifact\n');
    await expect(lstat(join(repository, '.bazify-adapt-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves identical-content inode replacements instead of claiming them during rollback', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'identity-replacement');
    await createSkill(join(repository, 'skills', 'identity-skill'), 'identity-skill');
    const replacementLog = join(root, 'replacement.log');
    const replacingBazframe = join(root, 'replacing-bazframe');
    await writeFile(replacingBazframe, `#!/usr/bin/env node
import { appendFileSync, chmodSync, copyFileSync, lstatSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[4];
for (const relative of ['bazframe-package.json', 'scripts/bazify-build.mjs', '.gitignore']) {
  const path = join(root, relative);
  const temporary = join(root, \`.identical-replacement-\${process.pid}-\${relative.replaceAll('/', '-')}\`);
  const before = lstatSync(path);
  copyFileSync(path, temporary);
  chmodSync(temporary, before.mode & 0o777);
  renameSync(temporary, path);
  const after = lstatSync(path);
  appendFileSync(process.env.BAZIFY_REPLACEMENT_LOG, JSON.stringify({ relative, before: String(before.ino), after: String(after.ino) }) + '\\n');
}
process.exit(1);
`);
    await chmod(replacingBazframe, 0o755);
    const adapted = runBazify(['adapt', repository, '--bazframe-command', replacingBazframe], {
      ...process.env,
      BAZIFY_REPLACEMENT_LOG: replacementLog
    });
    expect(adapted.status).toBe(1);
    expect(adapted.stderr).toContain('safe recovery could not be proven');
    const replacements = (await readFile(replacementLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      relative: string;
      before: string;
      after: string;
    });
    expect(replacements.map((replacement) => replacement.relative)).toEqual([
      'bazframe-package.json', 'scripts/bazify-build.mjs', '.gitignore'
    ]);
    expect(replacements.every((replacement) => replacement.before !== replacement.after)).toBe(true);
    expect(JSON.parse(await readFile(join(repository, 'bazframe-package.json'), 'utf8'))).toMatchObject({ schemaVersion: 1 });
    expect(await readFile(join(repository, 'scripts', 'bazify-build.mjs'), 'utf8')).toContain('#!/usr/bin/env node');
    expect(await readFile(join(repository, '.gitignore'), 'utf8')).toContain('/dist/');
    await expect(lstat(join(repository, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(repository, '.bazify-adapt-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires consent and publishes only through exact private GitHub argv', async () => {
    const root = await temporaryRoot();
    const source = await createSkill(join(root, 'provider', 'publish-skill'), 'publish-skill');
    const destination = join(root, 'package-parent', 'publish-skill');
    await mkdir(dirname(destination));
    const created = runBazify(['create', source, '--destination', destination, '--bazframe-command', bazframeCommand]);
    expect(created.status).toBe(0);
    const readmePath = join(destination, 'README.md');
    const recoveryState = join(destination, '.bazify-recovery-leftover');
    await mkdir(recoveryState);
    const reserved = runBazify(['publish', destination, '--dry-run', '--bazframe-command', bazframeCommand]);
    expect(reserved.status).toBe(1);
    expect(reserved.stderr).toContain('unfinished Bazify staging or recovery state');
    await expect(lstat(join(destination, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(recoveryState, { recursive: true });

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
    expect(tracked.stdout).toContain('skills/publish-skill/SKILL.md');
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

function initializeRepository(path: string, remote?: string): void {
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.name', 'Test User']);
  git(path, ['config', 'user.email', 'test@example.com']);
  git(path, ['add', '--all']);
  git(path, ['commit', '-m', 'Initial provider']);
  if (remote !== undefined) git(path, ['remote', 'add', 'origin', remote]);
}

function git(path: string, arguments_: string[]) {
  const result = spawnSync('git', arguments_, { cwd: path, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr}`);
  return result;
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
