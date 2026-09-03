import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PackageBuildAuthorizationReport } from '../../src/profile-portability/profile-import-package-build.js';
import { encodeCapturedProfile, type CapturedResource } from '../../src/profile-publishing/captured-profile.js';
import { readArtifactTree } from '../../src/profile-publishing/artifact-tree.js';
import { withProfileOperationLocks } from '../../src/profile-publishing/profile-operation-lock.js';
import { createProductionProfileLifecycleRemoteAdapter } from '../../src/profile-publishing/profile-remote-materializer.js';
import { importManagedProfile, type GitProfileSnapshot } from '../../src/profile-publishing/profile-lifecycle.js';
import { parseProfileGithubSource } from '../../src/profile-publishing/profile-github.js';
import { readOptionalManagedProfileState } from '../../src/profile-publishing/managed-profile-state.js';
import { capturedProfileLimitPolicy } from '../../src/profile-publishing/profile-publishing-policy.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((directory) => directory.cleanup())); });

const transaction = (prefix: string) => `${prefix}${'1'.repeat(31)}`;

async function expectRetainedRemoteWorkspace(home: string): Promise<void> {
  const entries = await readdir(join(home, 'profile-publishing', 'remote-materialization'));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatch(/^bazframe-profile-remote-/u);
}

describe('production hidden profile remote materializer', () => {
  it('acquires an exact library from a local bare repository, publishes runtime bytes, and privately retains its isolated home', async () => {
    const directory = await createTempDirectory('/tmp/bzf-rm-library-'); directories.push(directory);
    const remote = await bareRemote(directory, 'library', 'toolkit');
    const home = directory.path('home');
    await mkdir(join(home, 'profiles'), { recursive: true });
    const log = directory.path('git.log');
    const environment = await managedEnvironment(directory, remote.bare, { TEST_GIT_LOG: log, HOSTILE_SECRET: 'must-not-reach-git' });
    for (const [name, value] of Object.entries(environment)) if (value !== undefined) vi.stubEnv(name, value);
    const resource = remoteResource('library', 'toolkit', remote.revision, 'a');
    const instructions = Buffer.from('portable\n');
    const instructionSha = createHash('sha256').update(instructions).digest('hex');
    const captured = {
      schemaVersion: 1 as const,
      kind: 'bazframe-captured-profile' as const,
      profile: { name: 'portable', instructions: { path: 'AGENTS.md' as const, sha256: instructionSha, bytes: instructions.byteLength, executable: false } },
      resources: [resource],
      blobs: [{ sha256: instructionSha, bytes: instructions.byteLength }]
    };
    const snapshot: GitProfileSnapshot = {
      profile: captured,
      manifestBytes: Buffer.from(encodeCapturedProfile(captured, capturedProfileLimitPolicy())),
      blobs: [{ sha256: instructionSha, bytes: instructions.byteLength, bytesValue: instructions }],
      archiveBytes: 1,
      source: parseProfileGithubSource('git:owner/portable'), commit: 'd'.repeat(40), latestCommit: 'd'.repeat(40), visibility: 'private'
    };
    const imported = await importManagedProfile({ home, source: { kind: 'git', value: 'git:owner/portable' } }, {
      git: { inspect: async () => snapshot, list: async () => [{ commit: snapshot.commit }] }
    });
    expect(imported).toMatchObject({ action: 'imported', incomplete: false });
    const state = (await readOptionalManagedProfileState(home, 'portable'))!.state;
    const importedSource = state.importedResources[0]!.source;
    if (importedSource.kind !== 'remoteGit') throw new Error('expected ready remote state');
    const tree = await readArtifactTree(home, importedSource.treeId);
    expect(tree.manifest.role).toBe('library');
    expect(await readFile(join(tree.path, 'root', 'alpha', 'SKILL.md'), 'utf8')).toContain('name: alpha');
    const gitLog = await readFile(log, 'utf8');
    expect(gitLog.match(/"clone"/gu)).toHaveLength(1);
    expect(gitLog).not.toContain('must-not-reach-git');
    expect(gitLog).toContain('"terminal":"0"');
    await expectRetainedRemoteWorkspace(home);
  }, 120_000);

  it('authorizes a package once on an immutable adjacent report, declines safely, and supports preauthorization', async () => {
    const directory = await createTempDirectory('/tmp/bzf-rm-package-'); directories.push(directory);
    const remote = await bareRemote(directory, 'package', 'builder');
    const marker = directory.path('builds.log');
    const environment = await managedEnvironment(directory, remote.bare, { PACKAGE_BUILD_MARKER: marker });
    const resource = remoteResource('package', 'builder', remote.revision, 'b');
    const adapter = createProductionProfileLifecycleRemoteAdapter({ environment, childOutputPolicy: 'stdout-and-stderr-to-parent-stderr' });
    const interactiveHome = directory.path('h1');
    let calls = 0;
    let observed: PackageBuildAuthorizationReport | undefined;
    const interactive = await withProfileOperationLocks(interactiveHome, ['work', '@store'], (authority) => adapter.materialize(resource, {
      home: interactiveHome,
      authority,
      transactionId: transaction('2'),
      packageBuildAuthorization: { mode: 'interactive', authorize: (report) => {
        calls += 1; observed = report;
        expect(Object.isFrozen(report)).toBe(true);
        expect(Object.isFrozen(report.argv)).toBe(true);
        expect(Object.isFrozen(report.authority.access)).toBe(true);
        return true;
      } }
    }), transaction('2'));
    expect(interactive).toMatchObject({ kind: 'ready', cacheWritten: true, buildExecuted: true });
    expect(calls).toBe(1);
    expect(observed).toMatchObject({ packageId: 'builder', source: { type: 'remoteGit', revision: remote.revision }, shell: false });
    expect(await readFile(marker, 'utf8')).toBe('build\n');

    const declinedHome = directory.path('h2');
    await expect(withProfileOperationLocks(declinedHome, ['work', '@store'], (authority) => adapter.materialize(resource, {
      home: declinedHome, authority, transactionId: transaction('3'), packageBuildAuthorization: { mode: 'decline' }
    }), transaction('3'))).rejects.toMatchObject({ code: 'PROFILE_PACKAGE_BUILD_CONFIRMATION_REQUIRED' });
    expect(await readFile(marker, 'utf8')).toBe('build\n');
    await expectRetainedRemoteWorkspace(declinedHome);

    const automaticHome = directory.path('h3');
    const automatic = await withProfileOperationLocks(automaticHome, ['work', '@store'], (authority) => adapter.materialize(resource, {
      home: automaticHome, authority, transactionId: transaction('4'), packageBuildAuthorization: { mode: 'preauthorized' }
    }), transaction('4'));
    expect(automatic).toMatchObject({ kind: 'ready', cacheWritten: true, buildExecuted: true });
    expect(await readFile(marker, 'utf8')).toBe('build\nbuild\n');
    await expectRetainedRemoteWorkspace(interactiveHome);
    await expectRetainedRemoteWorkspace(automaticHome);
  }, 90_000);

  it('returns incomplete eligibility only for a settled clone failure and retains uncertain acquisition state', async () => {
    const directory = await createTempDirectory('/tmp/bzf-rm-unavailable-'); directories.push(directory);
    const remote = await bareRemote(directory, 'library', 'toolkit');
    const resource = remoteResource('library', 'toolkit', remote.revision, 'c');

    const unavailableHome = directory.path('h4');
    const unavailable = createProductionProfileLifecycleRemoteAdapter({
      environment: await managedEnvironment(directory, remote.bare, { TEST_FAIL_CLONE: '1' }), childOutputPolicy: 'stdout-and-stderr-to-parent-stderr'
    });
    const settled = await withProfileOperationLocks(unavailableHome, ['work', '@store'], (authority) => unavailable.materialize(resource, {
      home: unavailableHome, authority, transactionId: transaction('5'), packageBuildAuthorization: { mode: 'decline' }
    }), transaction('5'));
    expect(settled).toEqual({ kind: 'acquisitionUnavailable', diagnosticCode: 'REMOTE_UNAVAILABLE', cacheWritten: false, buildExecuted: false });
    await expectRetainedRemoteWorkspace(unavailableHome);

    const overflowHome = directory.path('h-overflow');
    const overflow = createProductionProfileLifecycleRemoteAdapter({
      environment: await managedEnvironment(directory, remote.bare, { TEST_OVERFLOW_CLONE: '1' }), childOutputPolicy: 'stdout-and-stderr-to-parent-stderr'
    });
    await expect(withProfileOperationLocks(overflowHome, ['work', '@store'], (authority) => overflow.materialize(resource, {
      home: overflowHome, authority, transactionId: transaction('8'), packageBuildAuthorization: { mode: 'decline' }
    }), transaction('8'))).rejects.toMatchObject({ code: 'MANAGED_GIT_PROCESS_FAILED' });
    await expectRetainedRemoteWorkspace(overflowHome);

    const arbitraryHome = directory.path('h5');
    const arbitrary = createProductionProfileLifecycleRemoteAdapter({
      environment: await managedEnvironment(directory, remote.bare), childOutputPolicy: 'stdout-and-stderr-to-parent-stderr',
      testHooks: { afterCloneOriginValidated: () => { throw new Error('arbitrary validation failure'); } }
    });
    await expect(withProfileOperationLocks(arbitraryHome, ['work', '@store'], (authority) => arbitrary.materialize(resource, {
      home: arbitraryHome, authority, transactionId: transaction('6'), packageBuildAuthorization: { mode: 'decline' }
    }), transaction('6'))).rejects.toThrow('arbitrary validation failure');
    await expectRetainedRemoteWorkspace(arbitraryHome);

    const uncertainHome = directory.path('h6');
    const uncertain = createProductionProfileLifecycleRemoteAdapter({
      environment: await managedEnvironment(directory, remote.bare), childOutputPolicy: 'stdout-and-stderr-to-parent-stderr',
      testHooks: { injectUncertainAcquisitionFailure: true }
    });
    await expect(withProfileOperationLocks(uncertainHome, ['work', '@store'], (authority) => uncertain.materialize(resource, {
      home: uncertainHome, authority, transactionId: transaction('7'), packageBuildAuthorization: { mode: 'decline' }
    }), transaction('7'))).rejects.toMatchObject({ code: 'PROFILE_REMOTE_MATERIALIZATION_RECOVERY_REQUIRED' });
    await expectRetainedRemoteWorkspace(uncertainHome);
  }, 90_000);
});

function remoteResource(kind: 'library' | 'package', name: string, revision: string, id: string): CapturedResource {
  return {
    id: id.repeat(64),
    key: { kind, name },
    payload: {
      kind: 'remoteGit',
      identity: {
        remote: `example.test/team/${name}`,
        fetchUrl: `https://example.test/team/${name}.git`,
        branch: 'main',
        revision
      }
    }
  };
}

async function bareRemote(directory: TempDirectory, kind: 'library' | 'package', name: string): Promise<{ bare: string; revision: string }> {
  const source = await directory.mkdir(`source-${kind}-${name}`);
  if (kind === 'library') {
    await mkdir(join(source, 'alpha'), { recursive: true });
    await writeFile(join(source, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha.\n---\n');
  } else {
    await writeFile(join(source, 'build.mjs'), "import{appendFileSync,mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/artifact.txt','ready\\n');if(process.env.PACKAGE_BUILD_MARKER)appendFileSync(process.env.PACKAGE_BUILD_MARKER,'build\\n');\n");
    await writeFile(join(source, 'bazframe-package.json'), `${JSON.stringify({ schemaVersion: 1, build: ['node', 'build.mjs'], artifactRoot: 'dist', skillsRoot: '.' }, null, 2)}\n`);
  }
  git(['init', '-b', 'main'], source);
  git(['config', 'user.name', 'Test'], source);
  git(['config', 'user.email', 'test@example.com'], source);
  git(['add', '.'], source);
  git(['commit', '-m', 'initial'], source);
  const revision = git(['rev-parse', 'HEAD'], source).trim();
  const bare = directory.path(`${kind}-${name}.git`);
  git(['clone', '--bare', source, bare], directory.root);
  return { bare, revision };
}

async function managedEnvironment(directory: TempDirectory, remote: string, extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const wrapper = directory.path(`git-wrapper-${Math.random().toString(16).slice(2)}.mjs`);
  const realGit = gitExecutable();
  await writeFile(wrapper, `#!/usr/bin/env node
import{spawnSync}from'node:child_process';import{appendFileSync}from'node:fs';
const realGit=${JSON.stringify(realGit)},testRemote=${JSON.stringify(remote)},log=${JSON.stringify(extra.TEST_GIT_LOG)},failClone=${JSON.stringify(extra.TEST_FAIL_CLONE === '1')},overflowClone=${JSON.stringify(extra.TEST_OVERFLOW_CLONE === '1')};
process.env.GIT_CONFIG_VALUE_2='always';const args=process.argv.slice(2);if(log)appendFileSync(log,JSON.stringify({args,hostile:process.env.HOSTILE_SECRET??null,home:process.env.HOME,terminal:process.env.GIT_TERMINAL_PROMPT})+'\\n');
if(args.includes('clone')){if(failClone){process.stderr.write("fatal: unable to access 'https://example.test/repo': Could not resolve host: example.test\\n");process.exit(87);}if(overflowClone){process.stderr.write('x'.repeat(1100000));process.exit(89);}const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));if(index<0)process.exit(88);const original=args[index];args[index]=testRemote;for(let offset=0;offset<args.length;offset+=1){if(args[offset]==='protocol.file.allow=never')args[offset]='protocol.file.allow=always';if(args[offset]==='protocol.allow'&&args[offset+1]==='never')args[offset+1]='always';}const result=spawnSync(realGit,args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);const destination=args.at(-1);const changed=spawnSync(realGit,['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
const result=spawnSync(realGit,args,{stdio:'inherit',env:process.env});process.exit(result.status??1);
`);
  await chmod(wrapper, 0o755);
  return { ...process.env, ...extra, BAZFRAME_GIT_COMMAND: wrapper, BAZFRAME_GH_COMMAND: directory.path('missing-gh') };
}

function git(args: string[], cwd: string): string {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git failed: ${args.join(' ')}`);
  return result.stdout;
}
function gitExecutable(): string {
  const result = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git is required');
  return result.stdout.trim();
}
