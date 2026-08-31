import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeManagedGitLibrary } from '../../src/providers/managed-git.js';
import { encodeManagedGitJournal, managedGitCheckoutRoot } from '../../src/providers/managed-git-record.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

interface Result { status: number | null; stdout: string; stderr: string }
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} Skill\n---\n# ${name}\n`;

describe('remote Git source CLI', () => {
  it('acquires, repeats, updates, and reports a Personal Agent Network-shaped package without profile activation', async () => {
    const directory = await createTempDirectory('bazframe-managed-git-cli-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const remote = await directory.mkdir('remote/personal-agent-network');
    await directory.write('remote/personal-agent-network/skills/personal-agent-network/SKILL.md', skill('personal-agent-network'));
    await directory.write('remote/personal-agent-network/skills/personal-agent-network-setup/SKILL.md', skill('personal-agent-network-setup'));
    await directory.write('remote/personal-agent-network/build.mjs', "import{cp,readFile,rm,writeFile}from'node:fs/promises';if(process.env.TEST_LOCK_CAPTURE)await writeFile(process.env.TEST_LOCK_CAPTURE,await readFile(process.env.BAZFRAME_HOME+'/locks/state.lock','utf8'));if(process.env.TEST_MANAGED_NOISE){console.log('managed-stdout');console.error('managed-stderr')}if(process.env.TEST_MANAGED_BUILD_FAIL==='1'){await writeFile('failed-output','dirty');process.exit(9)}await rm('dist',{recursive:true,force:true});await cp('skills','dist/skills',{recursive:true});\n");
    await directory.write('remote/personal-agent-network/.gitignore', 'dist/\nignored/\n');
    const c1BuildArgument = `${String.fromCharCode(0x9b)}31m`;
    const bidiBuildArgument = '\u202e';
    await directory.write('remote/personal-agent-network/bazframe-package.json', JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs', c1BuildArgument, bidiBuildArgument], artifactRoot: 'dist', skillsRoot: 'skills' }));
    git(['init', '-b', 'main'], remote); git(['config', 'user.name', 'Test'], remote); git(['config', 'user.email', 'test@example.com'], remote); git(['add', '.'], remote); git(['commit', '-m', 'initial'], remote);
    const initialRevision = git(['rev-parse', 'HEAD'], remote).trim();

    const environment = await managedEnvironment(directory, remote);
    await run(['profile', 'add', 'focused'], cwd, environment);
    await run(['profile', 'use', 'focused'], cwd, environment);

    const source = 'https://example.test/sram1337/personal-agent-network.git';
    const declined = await run(['package', 'add', source], cwd, environment);
    expect(declined.status).toBe(1);
    expect(declined.stdout, JSON.stringify(declined)).toContain('Remote package build authorization');
    expect(declined.stderr).toContain('requires --yes');
    const added = await run(['package', 'add', source, '--yes'], cwd, environment);
    expect(added).toMatchObject({ status: 0, stderr: '' });
    expect(added.stdout).toContain('Remote package build authorization');
    expect(added.stdout).toContain('without a shell or sandbox with ordinary user authority');
    expect(added.stdout).toContain('\\u009b31m');
    expect(added.stdout).toContain('\\u202e');
    expect(added.stdout).not.toContain(c1BuildArgument);
    expect(added.stdout).not.toContain(bidiBuildArgument);
    expect(added.stdout).toContain('Remote Git source package: added');
    expect(await readFile(directory.path('home/providers/git/checkouts/package/personal-agent-network/skills/personal-agent-network-setup/SKILL.md'), 'utf8')).toContain('name: personal-agent-network-setup');
    expect((await run(['profile', 'package', 'list'], cwd, environment)).stdout).toContain('Referenced packages:\n  (none)');

    const managedRoot = directory.path('home/providers/git/checkouts/package/personal-agent-network');
    await directory.write('home/providers/git/checkouts/package/personal-agent-network/local.txt', 'dirty\n');
    expect((await run(['package', 'add', source, '--yes'], cwd, environment)).stderr).toContain('local changes');
    git(['clean', '-fd'], managedRoot);
    git(['remote', 'set-url', 'origin', 'https://example.test/other/personal-agent-network.git'], managedRoot);
    expect((await run(['package', 'add', source, '--yes'], cwd, environment)).stderr).toContain('origin changed');
    git(['remote', 'set-url', 'origin', source], managedRoot);
    await directory.write('home/providers/git/checkouts/package/personal-agent-network/ignored/private.txt', 'ignored dirty state\n');
    expect((await run(['package', 'add', source, '--yes'], cwd, environment)).stderr).toContain('ignored additions');
    await rm(directory.path('home/providers/git/checkouts/package/personal-agent-network/ignored'), { recursive: true });
    git(['config', 'core.fsmonitor', '/tmp/hostile-monitor'], managedRoot);
    expect((await run(['package', 'add', source, '--yes'], cwd, environment)).stderr).toContain('unsupported key');
    git(['config', '--unset', 'core.fsmonitor'], managedRoot);
    git(['config', 'filter.evil.smudge', '/tmp/hostile-filter'], managedRoot);
    expect((await run(['package', 'add', source, '--yes'], cwd, environment)).stderr).toContain('unsupported key');
    git(['config', '--unset', 'filter.evil.smudge'], managedRoot);
    const repeated = await run(['package', 'add', source, '--yes'], cwd, { ...environment, TEST_FAIL_CLONE: '1' });
    expect(repeated).toMatchObject({ status: 0, stderr: '' });
    expect(repeated.stdout).toContain('Remote Git source package: current');
    expect(repeated.stdout).not.toContain('build authorization');

    await directory.write('remote/personal-agent-network/skills/personal-agent-network/note.txt', 'updated\n');
    git(['add', '.'], remote); git(['commit', '-m', 'update'], remote);
    const lockCapture=directory.path('update-lock.json');
    const updated = await run(['package', 'update', 'personal-agent-network', '--yes'], cwd, {...environment,TEST_LOCK_CAPTURE:lockCapture});
    expect(updated).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(await readFile(lockCapture,'utf8'))).toMatchObject({command:'bazframe package update'});
    expect(updated.stdout).toContain('Remote Git source package: updated');
    const fastForwardRevision = git(['rev-parse', 'HEAD'], remote).trim();
    await directory.write('remote/personal-agent-network/build.mjs', 'process.exit(9);\n');
    git(['add', '.'], remote); git(['commit', '-m', 'failing build'], remote);
    const failedUpdate = await run(['package', 'update', 'personal-agent-network', '--yes'], cwd, environment);
    expect(failedUpdate.status).toBe(1);
    expect(JSON.parse(await readFile(directory.path('home/providers/git/records/package/personal-agent-network.json'), 'utf8'))).toMatchObject({ revision: fastForwardRevision });
    expect(git(['rev-parse', 'HEAD'], directory.path('home/providers/git/checkouts/package/personal-agent-network')).trim()).toBe(fastForwardRevision);
    git(['checkout', fastForwardRevision, '--', 'build.mjs'], remote); git(['add', '.'], remote); git(['commit', '-m', 'restore build'], remote);
    expect((await run(['package', 'update', 'personal-agent-network', '--yes'], cwd, environment)).status).toBe(0);
    const beforeRewriteRevision = git(['rev-parse', 'HEAD'], remote).trim();
    git(['reset', '--hard', initialRevision], remote);
    await directory.write('remote/personal-agent-network/rewrite.txt', 'reviewed rewrite\n');
    git(['add', '.'], remote); git(['commit', '-m', 'rewritten branch'], remote);
    const refusedRewrite = await run(['package', 'update', 'personal-agent-network', '--yes'], cwd, environment);
    expect(refusedRewrite.status).toBe(1);
    expect(refusedRewrite.stderr).toContain('--accept-rewrite');
    expect(JSON.parse(await readFile(directory.path('home/providers/git/records/package/personal-agent-network.json'), 'utf8'))).toMatchObject({ revision: beforeRewriteRevision });
    expect((await run(['package', 'update', 'personal-agent-network', '--accept-rewrite', '--yes'], cwd, environment)).status).toBe(0);

    const failedBuild = await run(['package', 'build', 'personal-agent-network'], cwd, { ...environment, TEST_MANAGED_BUILD_FAIL: '1' });
    expect(failedBuild.status).toBe(1);
    expect(git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], managedRoot)).toBe('');
    expect((await run(['package', 'build', 'personal-agent-network'], cwd, environment)).status).toBe(0);
    const noisyJson=await run(['package','build','--json','personal-agent-network'],cwd,{...environment,TEST_MANAGED_NOISE:'1'});expect(noisyJson.status).toBe(0);expect(noisyJson.stderr).toContain('managed-stdout');expect(noisyJson.stderr).toContain('managed-stderr');expect(noisyJson.stdout.trim().split('\n')).toHaveLength(1);const noisyDocument=JSON.parse(noisyJson.stdout);expect(noisyDocument).toMatchObject({schemaVersion:1,ok:true,command:'package.build',result:{sourceType:'remoteGit'}});

    const status = await run(['status'], cwd, environment);
    expect(status.stdout).toContain('Remote Git sources:');
    expect(status.stdout).toContain('package personal-agent-network: ready; example.test/sram1337/personal-agent-network; branch:main; revision:');
    expect(status.stdout).toContain('bazframe package update personal-agent-network');
    const statusDocument = JSON.parse((await run(['status', '--json'], cwd, environment)).stdout);
    expect(statusDocument).toMatchObject({ result: { remoteGitSources: [expect.objectContaining({ kind: 'package', id: 'personal-agent-network' })], remoteGitSourceDiagnostics: [] } });
    const provenance = JSON.parse(await readFile(directory.path('home/providers/git/records/package/personal-agent-network.json'), 'utf8')) as { revision: string; remote: string };
    expect(provenance.remote).toBe('example.test/sram1337/personal-agent-network');
    expect(provenance.revision).toBe(git(['rev-parse', 'HEAD'], remote).trim());
    expect((await run(['profile', 'package', 'list'], cwd, environment)).stdout).toContain('Referenced packages:\n  (none)');
    await run(['profile', 'package', 'add', 'personal-agent-network'], cwd, environment);
    expect((await run(['package', 'remove', 'personal-agent-network'], cwd, environment)).status).toBe(1);
    await run(['profile', 'package', 'remove', 'personal-agent-network'], cwd, environment);
    expect((await run(['package', 'remove', 'personal-agent-network'], cwd, environment)).status).toBe(0);
    await expect(readFile(directory.path('home/providers/git/records/package/personal-agent-network.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run(['package', 'add', source, '--yes'], cwd, environment)).status).toBe(0);
    await directory.write('home/providers/git/recovery/package-personal-agent-network.json', '{"schemaVersion":1}\n');
    const recoveryStatus = await run(['status'], cwd, environment);
    expect(recoveryStatus.status).toBe(3);
    expect(recoveryStatus.stdout).toContain('recovery state requires inspection');
    const recoveryStatusDocument = JSON.parse((await run(['status', '--json'], cwd, environment)).stdout);
    expect(recoveryStatusDocument.result.correctiveActions).toContainEqual(expect.objectContaining({ id: 'remote-git' }));
    expect(recoveryStatusDocument.result.remoteGitSourceDiagnostics).not.toHaveLength(0);
  }, 60_000);

  it('retains recovery state instead of publishing a package-build replacement of the rollback backup', async () => {
    const directory = await createTempDirectory('bazframe-managed-hostile-backup-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const remote = await directory.mkdir('remote/hostile-package');
    await directory.write('remote/hostile-package/skills/alpha/SKILL.md', skill('alpha'));
    await directory.write('remote/hostile-package/.gitignore', 'dist/\n');
    await directory.write('remote/hostile-package/build.mjs', "import{cp,rm}from'node:fs/promises';await rm('dist',{recursive:true,force:true});await cp('skills','dist/skills',{recursive:true});\n");
    await directory.write('remote/hostile-package/bazframe-package.json', JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    git(['init', '-b', 'main'], remote); git(['config', 'user.name', 'Test'], remote); git(['config', 'user.email', 'test@example.com'], remote); git(['add', '.'], remote); git(['commit', '-m', 'initial'], remote);
    const initialRevision = git(['rev-parse', 'HEAD'], remote).trim();
    const environment = await managedEnvironment(directory, remote, 'hostile-backup-git-wrapper.mjs');
    const source = 'https://example.test/team/hostile-package.git';
    expect((await run(['package', 'add', source, '--yes'], cwd, environment)).status).toBe(0);
    await directory.write('remote/hostile-package/build.mjs', `import{mkdir,readFile,rm,writeFile}from'node:fs/promises';
const journal=JSON.parse(await readFile(process.env.BAZFRAME_HOME+'/providers/git/recovery/package-hostile-package.json','utf8'));
await rm(journal.backup,{recursive:true,force:true});await mkdir(journal.backup,{recursive:true});await writeFile(journal.backup+'/hostile.txt','replacement');process.exit(9);
`);
    git(['add', '.'], remote); git(['commit', '-m', 'replace backup during build'], remote);
    const failed = await run(['package', 'update', 'hostile-package', '--yes'], cwd, environment);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('could not prove complete recovery');
    const journalPath = directory.path('home/providers/git/recovery/package-hostile-package.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { backup: string };
    expect(await readFile(`${journal.backup}/hostile.txt`, 'utf8')).toBe('replacement');
    await expect(readFile(directory.path('home/providers/git/checkouts/package/hostile-package/bazframe-package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(directory.path('home/providers/git/records/package/hostile-package.json'), 'utf8'))).toMatchObject({ revision: initialRevision });
    expect((await run(['status'], cwd, environment)).status).toBe(3);
  }, 30_000);

  it('rejects a known same-kind collision before network or remote build authorization', async () => {
    const directory = await createTempDirectory('bazframe-managed-collision-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const local = await directory.mkdir('local/occupied-package');
    await directory.write('local/occupied-package/bazframe-package.json', JSON.stringify({ schemaVersion: 1, build: [process.execPath, '-e', "require('fs').mkdirSync('dist/skills',{recursive:true})"], artifactRoot: 'dist', skillsRoot: 'skills' }));
    const environment = { ...process.env, BAZFRAME_HOME: directory.path('home'), PI_CODING_AGENT_DIR: directory.path('pi-agent'), NO_COLOR: '1' };
    expect((await run(['package', 'add', local], cwd, environment)).status).toBe(0);
    const remote = await directory.mkdir('remote/occupied-package');
    git(['init', '-b', 'main'], remote); git(['config', 'user.name', 'Test'], remote); git(['config', 'user.email', 'test@example.com'], remote); git(['commit', '--allow-empty', '-m', 'initial'], remote);
    const managed = await managedEnvironment(directory, remote, 'collision-git-wrapper.mjs');
    const collision = await run(['package', 'add', 'https://example.test/team/occupied-package.git', '--yes'], cwd, { ...managed, TEST_FAIL_CLONE: '1' });
    expect(collision.status).toBe(1);
    expect(collision.stderr).toContain('already registered');
    expect(collision.stderr).not.toContain('Git clone failed');
    expect(collision.stdout).not.toContain('build authorization');
  });

  it('cleans acquired staging when concurrent adds serialize to one winner', async () => {
    const directory = await createTempDirectory('bazframe-managed-concurrent-add-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const remote = await directory.mkdir('remote/racing-library');
    await directory.write('remote/racing-library/alpha/SKILL.md', skill('alpha'));
    git(['init', '-b', 'main'], remote); git(['config', 'user.name', 'Test'], remote); git(['config', 'user.email', 'test@example.com'], remote); git(['add', '.'], remote); git(['commit', '-m', 'initial'], remote);
    const environment = await managedEnvironment(directory, remote, 'racing-git-wrapper.mjs');
    const racingEnvironment = { ...environment, TEST_CLONE_BARRIER: directory.path('clone-barrier') };
    const source = 'https://example.test/team/racing-library.git';
    const results = await Promise.all([
      run(['library', 'add', source], cwd, racingEnvironment),
      run(['library', 'add', source], cwd, racingEnvironment)
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([0, 1]);
    expect(results.find((result) => result.status === 1)?.stderr).toMatch(/became occupied|state is busy/u);
    expect(await readdir(directory.path('home/providers/git/staging'))).toEqual([]);
  }, 30_000);

  it('requires the state lock before reporting current add and update results', async () => {
    const directory = await createTempDirectory('bazframe-managed-current-lock-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const remote = await directory.mkdir('remote/current-library');
    await directory.write('remote/current-library/alpha/SKILL.md', skill('alpha'));
    git(['init', '-b', 'main'], remote); git(['config', 'user.name', 'Test'], remote); git(['config', 'user.email', 'test@example.com'], remote); git(['add', '.'], remote); git(['commit', '-m', 'initial'], remote);
    const environment = await managedEnvironment(directory, remote, 'current-lock-git-wrapper.mjs');
    const source = 'https://example.test/team/current-library.git';
    expect((await run(['library', 'add', source], cwd, environment)).status).toBe(0);

    for (const command of [['library', 'add', source], ['library', 'update', 'current-library']] as const) {
      await directory.write('home/locks/state.lock', `${JSON.stringify({
        schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString(),
        command: 'bazframe library remove', target: 'current-library', token: `test-${command[1]}`
      })}\n`);
      const current = await run(command, cwd, environment);
      expect(current.status, JSON.stringify(current)).toBe(1);
      expect(current.stderr).toContain('state is busy');
      await rm(directory.path('home/locks/state.lock'));
      expect(await readdir(directory.path('home/providers/git/staging'))).toEqual([]);
      expect(await run(command, cwd, environment)).toMatchObject({ status: 0, stderr: '' });
    }
    expect((await run(['library', 'list'], cwd, environment)).stdout).toContain('current-library');
  }, 30_000);

  it('resumes identity-verified forward removal after resource deletion', async () => {
    const directory = await createTempDirectory('bazframe-managed-remove-recovery-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const remote = await directory.mkdir('remote/recovery-library');
    await directory.write('remote/recovery-library/alpha/SKILL.md', skill('alpha'));
    git(['init', '-b', 'main'], remote); git(['config', 'user.name', 'Test'], remote); git(['config', 'user.email', 'test@example.com'], remote); git(['add', '.'], remote); git(['commit', '-m', 'initial'], remote);
    const environment = await managedEnvironment(directory, remote, 'remove-recovery-git-wrapper.mjs');
    expect((await run(['library', 'add', 'https://example.test/team/recovery-library.git'], cwd, environment)).status).toBe(0);
    const managedRoot = directory.path('home/providers/git/checkouts/library/recovery-library');
    const displacedRoot = directory.path('displaced-recovery-library');
    await expect(removeManagedGitLibrary({
      bazframeHome: directory.path('home'), environment,
      testHooks: { afterRemoveResource: async () => {
        await rename(managedRoot, displacedRoot);
        await mkdir(managedRoot);
        await rm(directory.path('home/providers/git/records/library/recovery-library.json'));
      } }
    }, 'recovery-library')).rejects.toThrow(/recovery/i);
    const journalPath = directory.path('home/providers/git/recovery/library-recovery-library.json');
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ operation: 'remove', resourceStateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    await expect(readFile(directory.path('home/providers/git/records/library/recovery-library.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(managedRoot, { recursive: true });
    await rename(displacedRoot, managedRoot);
    const resumed = await run(['library', 'remove', 'recovery-library'], cwd, environment);
    expect(resumed).toMatchObject({ status: 0, stderr: '' });
    expect(resumed.stdout).toContain('Remote Git source library: removed');
    await expect(readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(directory.path('home/providers/git/records/library/recovery-library.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${managedRoot}/alpha/SKILL.md`)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('refuses journal-only removal outside the deterministic managed checkout namespace', async () => {
    const directory = await createTempDirectory('bazframe-managed-remove-boundary-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const outside = await directory.mkdir('outside-library');
    await directory.write('outside-library/alpha/SKILL.md', skill('alpha'));
    git(['init', '-b', 'main'], outside); git(['config', 'user.name', 'Test'], outside); git(['config', 'user.email', 'test@example.com'], outside); git(['add', '.'], outside); git(['commit', '-m', 'initial'], outside);
    const revision = git(['rev-parse', 'HEAD'], outside).trim();
    const home = directory.path('home');
    await directory.write('home/providers/git/recovery/library-outside-library.json', encodeManagedGitJournal({
      schemaVersion: 1, operation: 'remove', phase: 'resource-removed', kind: 'library', id: 'outside-library',
      remote: 'example.test/team/outside-library', fetchUrl: 'https://example.test/team/outside-library.git', transport: 'git',
      branch: 'main', previousRevision: revision, nextRevision: revision, root: outside, staging: null, backup: null,
      resourceStateSha256: 'd'.repeat(64)
    }));
    const refused = await run(['library', 'remove', 'outside-library'], cwd, { ...process.env, BAZFRAME_HOME: home, PI_CODING_AGENT_DIR: directory.path('pi-agent'), NO_COLOR: '1' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('deterministic Bazframe-managed checkout path');
    expect(await readFile(directory.path('outside-library/alpha/SKILL.md'), 'utf8')).toContain('name: alpha');
  });

  it('refuses journal-only removal through a symlinked providers namespace', async () => {
    const directory = await createTempDirectory('bazframe-managed-remove-symlink-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const home = await directory.mkdir('home');
    const externalProviders = await directory.mkdir('external-providers');
    await directory.write('external-providers/git/checkouts/library/linked-library/sentinel.txt', 'outside\n');
    await directory.write('external-providers/git/recovery/library-linked-library.json', encodeManagedGitJournal({
      schemaVersion: 1, operation: 'remove', phase: 'resource-removed', kind: 'library', id: 'linked-library',
      remote: 'example.test/team/linked-library', fetchUrl: 'https://example.test/team/linked-library.git', transport: 'git',
      branch: 'main', previousRevision: 'a'.repeat(40), nextRevision: 'a'.repeat(40),
      root: managedGitCheckoutRoot(await realpath(home), 'library', 'linked-library'), staging: null, backup: null,
      resourceStateSha256: 'd'.repeat(64)
    }));
    await symlink(externalProviders, directory.path('home/providers'));
    const refused = await run(['library', 'remove', 'linked-library'], cwd, { ...process.env, BAZFRAME_HOME: home, PI_CODING_AGENT_DIR: directory.path('pi-agent'), NO_COLOR: '1' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('namespace must be physical');
    expect(await readFile(directory.path('external-providers/git/checkouts/library/linked-library/sentinel.txt'), 'utf8')).toBe('outside\n');
  });

  it('falls back from an authenticated GitHub CLI clone failure to Git HTTPS', async () => {
    const directory = await createTempDirectory('bazframe-managed-gh-fallback-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const remote = await directory.mkdir('remote/fallback-library');
    await directory.write('remote/fallback-library/alpha/SKILL.md', skill('alpha'));
    git(['init', '-b', 'main'], remote); git(['config', 'user.name', 'Test'], remote); git(['config', 'user.email', 'test@example.com'], remote); git(['add', '.'], remote); git(['commit', '-m', 'initial'], remote);
    const environment = await managedEnvironment(directory, remote, 'fallback-git-wrapper.mjs');
    const gh = directory.path('gh-wrapper.mjs');
    await directory.write('gh-wrapper.mjs', `#!/usr/bin/env node
import{mkdirSync}from'node:fs';const args=process.argv.slice(2);if(args[0]==='auth')process.exit(0);const destination=args[3];if(destination)mkdirSync(destination,{recursive:true});process.exit(19);
`);
    await chmod(gh, 0o755);
    const result = await run(['library', 'add', 'git:Example/Fallback-Library'], cwd, { ...environment, BAZFRAME_GH_COMMAND: gh, GIT_SSH_COMMAND: '/tmp/hostile-routing' });
    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('Remote Git source library: added');
  });

  it('acquires and updates through an authenticated GitHub CLI transport', async () => {
    const directory = await createTempDirectory('bazframe-managed-gh-success-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    const remote = await directory.mkdir('remote/private-library');
    await directory.write('remote/private-library/alpha/SKILL.md', skill('alpha'));
    git(['init', '-b', 'main'], remote); git(['config', 'user.name', 'Test'], remote); git(['config', 'user.email', 'test@example.com'], remote); git(['add', '.'], remote); git(['commit', '-m', 'initial'], remote);
    const environment = await managedEnvironment(directory, remote, 'gh-success-git-wrapper.mjs');
    const gh = directory.path('gh-success-wrapper.mjs');
    await directory.write('gh-success-wrapper.mjs', `#!/usr/bin/env node
import{spawnSync}from'node:child_process';
const args=process.argv.slice(2);if(args[0]==='auth')process.exit(0);if(args[0]!=='repo'||args[1]!=='clone')process.exit(91);
const separator=args.indexOf('--');if(separator<0)process.exit(92);const cloneFlags=args.slice(separator+1);
const result=spawnSync(process.env.REAL_GIT,['clone',...cloneFlags,process.env.TEST_REMOTE,args[3]],{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);
const changed=spawnSync(process.env.REAL_GIT,['-C',args[3],'remote','set-url','origin','https://github.com/example/private-library.git'],{stdio:'inherit',env:process.env});process.exit(changed.status??1);
`);
    await chmod(gh, 0o755);
    const githubEnvironment = { ...environment, BAZFRAME_GH_COMMAND: gh };
    const added = await run(['library', 'add', 'git:Example/Private-Library'], cwd, githubEnvironment);
    expect(added).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(await readFile(directory.path('home/providers/git/records/library/private-library.json'), 'utf8'))).toMatchObject({ transport: 'gh', remote: 'github.com/example/private-library' });
    await directory.write('remote/private-library/beta/SKILL.md', skill('beta'));
    git(['add', '.'], remote); git(['commit', '-m', 'update'], remote);
    expect((await run(['library', 'update', 'private-library'], cwd, githubEnvironment)).status).toBe(0);
    expect((await run(['library', 'list'], cwd, githubEnvironment)).stdout).toContain('beta');
  });

  it('updates remote Git Skills through stable profile links and acquires remote Git libraries through the shared lifecycle', async () => {
    const directory = await createTempDirectory('bazframe-managed-git-resources-'); directories.push(directory);
    const cwd = await directory.mkdir('cwd');
    await run(['profile', 'add', 'focused'], cwd, { ...process.env, BAZFRAME_HOME: directory.path('home'), PI_CODING_AGENT_DIR: directory.path('pi-agent'), NO_COLOR: '1' });
    await run(['profile', 'use', 'focused'], cwd, { ...process.env, BAZFRAME_HOME: directory.path('home'), PI_CODING_AGENT_DIR: directory.path('pi-agent'), NO_COLOR: '1' });

    const skillRemote = await directory.mkdir('skill-remote/demo-skill');
    await directory.write('skill-remote/demo-skill/SKILL.md', skill('demo-skill'));
    git(['init', '-b', 'main'], skillRemote); git(['config', 'user.name', 'Test'], skillRemote); git(['config', 'user.email', 'test@example.com'], skillRemote); git(['add', '.'], skillRemote); git(['commit', '-m', 'initial'], skillRemote);
    let environment = await managedEnvironment(directory, skillRemote, 'skill-git-wrapper.mjs');
    const addedSkill = await run(['skill', 'add', 'https://example.test/team/demo-skill.git'], cwd, environment);
    expect(addedSkill.status, JSON.stringify(addedSkill)).toBe(0);
    expect(await run(['profile', 'skill', 'add', 'demo-skill'], cwd, environment)).toMatchObject({ status: 0, stderr: '' });
    const membership = directory.path('home/profiles/focused/skills/demo-skill/SKILL.md');
    await directory.write('skill-remote/demo-skill/SKILL.md', `${skill('demo-skill')}\nUpdated.\n`);
    git(['add', '.'], skillRemote); git(['commit', '-m', 'update'], skillRemote);
    expect((await run(['skill', 'update', 'demo-skill'], cwd, environment)).status).toBe(0);
    expect(await readFile(membership, 'utf8')).toContain('Updated.');
    expect((await run(['skill', 'remove', 'demo-skill'], cwd, environment)).status).toBe(1);
    await run(['profile', 'skill', 'remove', 'demo-skill'], cwd, environment);
    expect((await run(['skill', 'remove', 'demo-skill'], cwd, environment)).status).toBe(0);
    expect((await run(['skill', 'add', 'https://example.test/team/demo-skill.git'], cwd, environment)).status).toBe(0);

    const libraryRemote = await directory.mkdir('library-remote/toolkit');
    await directory.write('library-remote/toolkit/alpha/SKILL.md', skill('alpha'));
    git(['init', '-b', 'main'], libraryRemote); git(['config', 'user.name', 'Test'], libraryRemote); git(['config', 'user.email', 'test@example.com'], libraryRemote); git(['add', '.'], libraryRemote); git(['commit', '-m', 'initial'], libraryRemote);
    environment = await managedEnvironment(directory, libraryRemote, 'library-git-wrapper.mjs');
    expect((await run(['library', 'add', 'ssh://git@example.test/team/toolkit.git'], cwd, environment)).status).toBe(0);
    await directory.write('library-remote/toolkit/beta/SKILL.md', skill('beta'));
    git(['add', '.'], libraryRemote); git(['commit', '-m', 'update'], libraryRemote);
    expect((await run(['library', 'update', 'toolkit'], cwd, environment)).status).toBe(0);
    expect((await run(['library', 'list'], cwd, environment)).stdout).toContain('beta');
    await run(['profile', 'library', 'add', 'toolkit'], cwd, environment);
    expect((await run(['library', 'remove', 'toolkit'], cwd, environment)).status).toBe(1);
    await run(['profile', 'library', 'remove', 'toolkit'], cwd, environment);
    expect((await run(['library', 'remove', 'toolkit'], cwd, environment)).status).toBe(0);
    expect((await run(['library', 'add', 'ssh://git@example.test/team/toolkit.git'], cwd, environment)).status).toBe(0);

    const linkedRemote = await directory.mkdir('skill-remote/linked-skill');
    await directory.write('skill-remote/linked-skill/definition.md', skill('linked-skill'));
    await symlink('definition.md', directory.path('skill-remote/linked-skill/SKILL.md'));
    git(['init', '-b', 'main'], linkedRemote); git(['config', 'user.name', 'Test'], linkedRemote); git(['config', 'user.email', 'test@example.com'], linkedRemote); git(['add', '.'], linkedRemote); git(['commit', '-m', 'linked'], linkedRemote);
    const linkedEnvironment = await managedEnvironment(directory, linkedRemote, 'linked-git-wrapper.mjs');
    const linked = await run(['skill', 'add', 'https://example.test/team/linked-skill.git'], cwd, linkedEnvironment);
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain('physical regular file');
  });
});

async function managedEnvironment(directory: TempDirectory, remote: string, wrapperName = 'git-wrapper.mjs'): Promise<NodeJS.ProcessEnv> {
  const wrapper = directory.path(wrapperName);
  await directory.write(wrapperName, `#!/usr/bin/env node
import{spawnSync}from'node:child_process';import{mkdirSync,readdirSync,writeFileSync}from'node:fs';
const args=process.argv.slice(2);const real=process.env.REAL_GIT;let original;if(process.env.GIT_SSH_COMMAND)process.exit(90);
if(args.includes('clone')){if(process.env.TEST_FAIL_CLONE==='1')process.exit(87);if(process.env.TEST_CLONE_BARRIER){mkdirSync(process.env.TEST_CLONE_BARRIER,{recursive:true});writeFileSync(process.env.TEST_CLONE_BARRIER+'/'+process.pid,'');const started=Date.now();while(readdirSync(process.env.TEST_CLONE_BARRIER).length<2){if(Date.now()-started>10000)process.exit(89);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));if(index<0)process.exit(88);original=args[index];args[index]=process.env.TEST_REMOTE;const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';}
const result=spawnSync(real,args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);
if(original){const destination=args.at(-1);const changed=spawnSync(real,['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
`);
  await chmod(wrapper, 0o755);
  return {
    ...process.env,
    BAZFRAME_HOME: directory.path('home'), PI_CODING_AGENT_DIR: directory.path('pi-agent'), NO_COLOR: '1',
    BAZFRAME_GIT_COMMAND: wrapper, BAZFRAME_GH_COMMAND: directory.path('missing-gh'),
    REAL_GIT: gitExecutable(), TEST_REMOTE: remote
  };
}

function git(args: string[], cwd: string): string {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git failed: ${args.join(' ')}`);
  return result.stdout;
}
function gitExecutable(): string {
  const result = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git is required for remote Git source integration tests');
  return result.stdout.trim();
}
function run(args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value: string) => { stdout += value; });
    child.stderr.on('data', (value: string) => { stderr += value; });
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
