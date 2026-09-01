import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readlink, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProfileImportExecutionError,
  executeProfileImport
} from '../../src/profile-portability/profile-import.js';
import { encodeProfileArtifact, type ProfileArtifact } from '../../src/profile-portability/profile-artifact.js';
import { profileArtifactLimitPolicy } from '../../src/profile-portability/profile-portability-policy.js';
import { addProfile } from '../../src/profiles/profile-management.js';
import { readActiveProfile, writeActiveProfile } from '../../src/profiles/profile-store.js';
import { readManagedGitRecord } from '../../src/providers/managed-git-record.js';
import { readLibrary, readPackage } from '../../src/skill-collections/skill-collection-store.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));
const skillDefinition = (name: string) => `---\nname: ${name}\ndescription: ${name} Skill\n---\n# ${name}\n`;

interface PortableFixture {
  directory: TempDirectory;
  home: string;
  artifact: string;
  environment: NodeJS.ProcessEnv;
  revisions: { skill: string; library: string };
}

describe('profile-import execution integration', () => {
  it('imports historical exact resources, publishes an inactive profile, and reuses them for retry and --as', async () => {
    const fixture = await portableFixture('normal');
    await addProfile(fixture.home, 'existing');
    await writeActiveProfile(fixture.home, 'existing');
    const activeBytes = await readFile(join(fixture.home, 'active-profile'));
    const shown: unknown[] = [];

    const first = await executeProfileImport({
      bazframeHome: fixture.home,
      artifactDirectory: fixture.artifact,
      environment: fixture.environment,
      reportPlan: (plan) => { shown.push(plan); }
    });
    expect(first.profileOutcome).toBe('published');
    expect(first.resources.map((item) => item.outcome)).toEqual(['created', 'created']);
    expect(shown).toHaveLength(1);

    const skillRecord = (await readManagedGitRecord(fixture.home, 'skill', 'alpha')).record;
    const libraryRecord = (await readManagedGitRecord(fixture.home, 'library', 'toolkit')).record;
    expect(skillRecord.revision).toBe(fixture.revisions.skill);
    expect(libraryRecord.revision).toBe(fixture.revisions.library);
    expect(git(['rev-parse', 'HEAD'], skillRecord.root).trim()).toBe(fixture.revisions.skill);
    expect(git(['rev-parse', 'HEAD'], libraryRecord.root).trim()).toBe(fixture.revisions.library);
    expect(spawnSync(gitExecutable(), ['symbolic-ref', '-q', 'HEAD'], { cwd: skillRecord.root }).status).toBe(1);
    expect(spawnSync(gitExecutable(), ['symbolic-ref', '-q', 'HEAD'], { cwd: libraryRecord.root }).status).toBe(1);
    expect(await readlink(join(fixture.home, 'skills/alpha'))).toBe(skillRecord.root);
    expect((await readLibrary(fixture.home, 'toolkit')).root).toBe(libraryRecord.root);

    const profile = join(fixture.home, 'profiles/focused');
    expect(await readFile(join(profile, 'AGENTS.md'), 'utf8')).toBe('portable instructions\r\nexact bytes: é\n');
    expect(await readlink(join(profile, 'skills/alpha'))).toBe(skillRecord.root);
    expect(await readdir(join(profile, 'skills'))).toEqual(['alpha']);
    expect(JSON.parse(await readFile(join(profile, 'libraries/toolkit.json'), 'utf8'))).toEqual({ schemaVersion: 1, library: 'toolkit' });
    await expect(lstat(join(profile, 'packages'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(profile, 'skills/child'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(fixture.home, 'skills/child'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readActiveProfile(fixture.home)).toBe('existing');
    expect(await readFile(join(fixture.home, 'active-profile'))).toEqual(activeBytes);

    const disabled = { ...fixture.environment, TEST_FAIL_CLONE: '1' };
    const reused = await executeProfileImport({
      bazframeHome: fixture.home,
      artifactDirectory: fixture.artifact,
      environment: disabled,
      reportPlan: () => undefined
    });
    expect(reused.profileOutcome).toBe('reused');
    expect(reused.resources.map((item) => item.outcome)).toEqual(['reused', 'reused']);

    const renamed = await executeProfileImport({
      bazframeHome: fixture.home,
      artifactDirectory: fixture.artifact,
      destinationProfileId: 'renamed',
      environment: disabled,
      reportPlan: () => undefined
    });
    expect(renamed.profileOutcome).toBe('published');
    expect(await readFile(join(fixture.home, 'profiles/renamed/AGENTS.md'))).toEqual(await readFile(join(profile, 'AGENTS.md')));
    expect(await readlink(join(fixture.home, 'profiles/renamed/skills/alpha'))).toBe(skillRecord.root);
    expect(await readActiveProfile(fixture.home)).toBe('existing');
  }, 90_000);

  it('builds authorized remote and mapped packages last, publishes references, and retries without build or network', async () => {
    const fixture = await packageFixture();
    const reports: Array<{ packageId: string; source: { type: string } }> = [];
    const first = await executeProfileImport({
      bazframeHome: fixture.home,
      artifactDirectory: fixture.artifact,
      mappings: [{ kind: 'package', id: 'local-package', root: fixture.localPackage }],
      environment: fixture.environment,
      reportPlan: () => undefined,
      authorizePackageBuild: (report) => {
        reports.push({ packageId: report.packageId, source: { type: report.source.type } });
        return true;
      }
    });
    expect(first.resources).toEqual([
      { kind: 'package', id: 'local-package', outcome: 'created' },
      { kind: 'package', id: 'remote-package', outcome: 'created' }
    ]);
    expect(reports).toEqual([
      { packageId: 'local-package', source: { type: 'localMapping' } },
      { packageId: 'remote-package', source: { type: 'remoteGit' } }
    ]);
    expect(first.possibleNonrollbackablePackageEffects).toEqual(['local-package', 'remote-package']);
    expect(await readFile(join(fixture.localPackage, 'build-count'), 'utf8')).toBe('x');
    expect((await readPackage(fixture.home, 'local-package')).root).toBe(await realpath(fixture.localPackage));
    const remoteRecord = (await readManagedGitRecord(fixture.home, 'package', 'remote-package')).record;
    expect((await readPackage(fixture.home, 'remote-package')).root).toBe(remoteRecord.root);
    const profile = join(fixture.home, 'profiles/package-profile');
    expect(JSON.parse(await readFile(join(profile, 'packages/local-package.json'), 'utf8')))
      .toEqual({ schemaVersion: 1, package: 'local-package' });
    expect(JSON.parse(await readFile(join(profile, 'packages/remote-package.json'), 'utf8')))
      .toEqual({ schemaVersion: 1, package: 'remote-package' });
    expect(await readdir(join(profile, 'skills'))).toEqual([]);
    await expect(lstat(join(profile, 'skills/local-child'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(fixture.home, 'skills/remote-child'))).rejects.toMatchObject({ code: 'ENOENT' });

    const authorization = { calls: 0 };
    const retry = await executeProfileImport({
      bazframeHome: fixture.home,
      artifactDirectory: fixture.artifact,
      mappings: [{ kind: 'package', id: 'local-package', root: fixture.localPackage }],
      environment: { ...fixture.environment, TEST_FAIL_CLONE: '1' },
      reportPlan: () => undefined,
      authorizePackageBuild: () => { authorization.calls += 1; return false; }
    });
    expect(retry.profileOutcome).toBe('reused');
    expect(retry.resources.map((resource) => resource.outcome)).toEqual(['reused', 'reused']);
    expect(retry.packageBuildReports).toEqual([]);
    expect(retry.possibleNonrollbackablePackageEffects).toEqual([]);
    expect(authorization.calls).toBe(0);
    expect(await readFile(join(fixture.localPackage, 'build-count'), 'utf8')).toBe('x');
  }, 90_000);

  it('retains earlier exact resources on later failure, retries forward, and blocks deferred child collisions', async () => {
    const fixture = await portableFixture('normal');
    let firstError: unknown;
    try {
      await executeProfileImport({
        bazframeHome: fixture.home,
        artifactDirectory: fixture.artifact,
        environment: { ...fixture.environment, TEST_FAIL_LIBRARY: '1' },
        reportPlan: () => undefined
      });
    } catch (error) { firstError = error; }
    expect(firstError).toBeInstanceOf(ProfileImportExecutionError);
    expect((firstError as ProfileImportExecutionError).result).toMatchObject({
      profileOutcome: 'not-published',
      resources: [
        { kind: 'skill', id: 'alpha', outcome: 'created' },
        { kind: 'library', id: 'toolkit', outcome: 'not-created' }
      ]
    });
    await expect(readManagedGitRecord(fixture.home, 'skill', 'alpha')).resolves.toBeDefined();
    await expect(readManagedGitRecord(fixture.home, 'library', 'toolkit')).rejects.toBeDefined();
    await expect(lstat(join(fixture.home, 'profiles/focused'))).rejects.toMatchObject({ code: 'ENOENT' });

    const retried = await executeProfileImport({
      bazframeHome: fixture.home,
      artifactDirectory: fixture.artifact,
      environment: fixture.environment,
      reportPlan: () => undefined
    });
    expect(retried.profileOutcome).toBe('published');
    expect(retried.resources.map((item) => item.outcome)).toEqual(['reused', 'created']);

    const collision = await portableFixture('collision');
    let collisionError: unknown;
    try {
      await executeProfileImport({
        bazframeHome: collision.home,
        artifactDirectory: collision.artifact,
        environment: collision.environment,
        reportPlan: (plan) => { expect(plan.composition.status).toBe('deferred'); }
      });
    } catch (error) { collisionError = error; }
    expect(collisionError).toBeInstanceOf(ProfileImportExecutionError);
    expect((collisionError as ProfileImportExecutionError).result.profileOutcome).toBe('not-published');
    await expect(readManagedGitRecord(collision.home, 'skill', 'alpha')).resolves.toBeDefined();
    await expect(readManagedGitRecord(collision.home, 'library', 'toolkit')).resolves.toBeDefined();
    await expect(lstat(join(collision.home, 'profiles/focused'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(collision.home, 'skills/child'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});

async function portableFixture(variant: 'normal' | 'collision'): Promise<PortableFixture> {
  const directory = await createTempDirectory(`bazframe-profile-import-${variant}-`);
  directories.push(directory);
  const skillRemote = await directory.mkdir(`${variant}/remote/alpha`);
  await directory.write(`${variant}/remote/alpha/SKILL.md`, skillDefinition('alpha'));
  initialize(skillRemote);
  const skillRevision = git(['rev-parse', 'HEAD'], skillRemote).trim();
  await directory.write(`${variant}/remote/alpha/README.md`, 'advanced\n');
  git(['add', '.'], skillRemote); git(['commit', '-m', 'advance'], skillRemote);

  const libraryRemote = await directory.mkdir(`${variant}/remote/toolkit`);
  const childName = variant === 'collision' ? 'alpha' : 'child';
  await directory.write(`${variant}/remote/toolkit/${childName}/SKILL.md`, skillDefinition(childName));
  initialize(libraryRemote);
  const libraryRevision = git(['rev-parse', 'HEAD'], libraryRemote).trim();
  await directory.write(`${variant}/remote/toolkit/README.md`, 'advanced\n');
  git(['add', '.'], libraryRemote); git(['commit', '-m', 'advance'], libraryRemote);

  const instructions = Buffer.from('portable instructions\r\nexact bytes: é\n', 'utf8');
  const artifact = directory.path(`${variant}/artifact`);
  await mkdir(join(artifact, 'profile'), { recursive: true });
  await writeFile(join(artifact, 'profile/AGENTS.md'), instructions);
  const manifest: ProfileArtifact = {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile: {
      id: 'focused',
      instructions: {
        path: 'profile/AGENTS.md',
        sha256: createHash('sha256').update(instructions).digest('hex')
      },
      skills: ['alpha'],
      omittedLocalSkills: [],
      libraries: ['toolkit'],
      packages: []
    },
    resources: [
      { kind: 'skill', id: 'alpha', source: identity('alpha', skillRevision) },
      { kind: 'library', id: 'toolkit', source: identity('toolkit', libraryRevision) }
    ]
  };
  await writeFile(join(artifact, 'bazframe-profile.json'), encodeProfileArtifact(manifest, profileArtifactLimitPolicy()));
  const environment = await managedEnvironment(directory, variant, skillRemote, libraryRemote);
  return {
    directory,
    home: directory.path(`${variant}/home`),
    artifact,
    environment,
    revisions: { skill: skillRevision, library: libraryRevision }
  };
}

function identity(id: string, revision: string) {
  return {
    type: 'remoteGit' as const,
    remote: `example.test/team/${id}`,
    fetchUrl: `https://example.test/team/${id}.git`,
    branch: 'main',
    revision
  };
}

function initialize(remote: string): void {
  git(['init', '-b', 'main'], remote);
  git(['config', 'user.name', 'Test'], remote);
  git(['config', 'user.email', 'test@example.com'], remote);
  git(['add', '.'], remote);
  git(['commit', '-m', 'initial'], remote);
}

async function packageFixture(): Promise<{
  directory: TempDirectory;
  home: string;
  artifact: string;
  localPackage: string;
  environment: NodeJS.ProcessEnv;
}> {
  const directory = await createTempDirectory('bazframe-profile-import-packages-');
  directories.push(directory);
  const remotePackage = await directory.mkdir('packages/remote/remote-package');
  const buildScript = (child: string, count: boolean) => [
    "const{mkdirSync,writeFileSync,appendFileSync}=require('node:fs')",
    `mkdirSync('dist/skills/${child}',{recursive:true})`,
    `writeFileSync('dist/skills/${child}/SKILL.md',${JSON.stringify(skillDefinition(child))})`,
    ...(count ? ["appendFileSync('build-count','x')"] : [])
  ].join(';');
  await directory.write('packages/remote/remote-package/bazframe-package.json', JSON.stringify({
    schemaVersion: 1,
    build: [process.execPath, '-e', buildScript('remote-child', false)],
    artifactRoot: 'dist',
    skillsRoot: 'skills'
  }));
  initialize(remotePackage);
  const remoteRevision = git(['rev-parse', 'HEAD'], remotePackage).trim();

  const localPackage = await directory.mkdir('packages/local/local-package');
  await directory.write('packages/local/local-package/bazframe-package.json', JSON.stringify({
    schemaVersion: 1,
    build: [process.execPath, '-e', buildScript('local-child', true)],
    artifactRoot: 'dist',
    skillsRoot: 'skills'
  }));

  const artifact = directory.path('packages/artifact');
  await mkdir(join(artifact, 'profile'), { recursive: true });
  const instructions = Buffer.from('package profile\n', 'utf8');
  await writeFile(join(artifact, 'profile/AGENTS.md'), instructions);
  const manifest: ProfileArtifact = {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile: {
      id: 'package-profile',
      instructions: { path: 'profile/AGENTS.md', sha256: createHash('sha256').update(instructions).digest('hex') },
      skills: [], omittedLocalSkills: [], libraries: [],
      packages: ['local-package', 'remote-package']
    },
    resources: [
      { kind: 'package', id: 'local-package', source: { type: 'localMapping' } },
      { kind: 'package', id: 'remote-package', source: identity('remote-package', remoteRevision) }
    ]
  };
  await writeFile(join(artifact, 'bazframe-profile.json'), encodeProfileArtifact(manifest, profileArtifactLimitPolicy()));

  const wrapperName = 'packages/git-wrapper.mjs';
  const wrapper = directory.path(wrapperName);
  await directory.write(wrapperName, `#!/usr/bin/env node
import{spawnSync}from'node:child_process';
const args=process.argv.slice(2);const real=process.env.REAL_GIT;let original;
if(args.includes('clone')){
  if(process.env.TEST_FAIL_CLONE==='1')process.exit(87);
  const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));if(index<0)process.exit(88);
  original=args[index];args[index]=process.env.TEST_PACKAGE_REMOTE;
  const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';
}
const result=spawnSync(real,args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);
if(original){const destination=args.at(-1);const changed=spawnSync(real,['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
`);
  await chmod(wrapper, 0o755);
  return {
    directory,
    home: directory.path('packages/home'),
    artifact,
    localPackage,
    environment: {
      ...process.env,
      BAZFRAME_GIT_COMMAND: wrapper,
      BAZFRAME_GH_COMMAND: directory.path('packages/missing-gh'),
      REAL_GIT: gitExecutable(),
      TEST_PACKAGE_REMOTE: remotePackage
    }
  };
}

async function managedEnvironment(
  directory: TempDirectory,
  variant: string,
  skillRemote: string,
  libraryRemote: string
): Promise<NodeJS.ProcessEnv> {
  const name = `${variant}/git-wrapper.mjs`;
  const wrapper = directory.path(name);
  await directory.write(name, `#!/usr/bin/env node
import{spawnSync}from'node:child_process';
const args=process.argv.slice(2);const real=process.env.REAL_GIT;let original;
if(args.includes('clone')){
  if(process.env.TEST_FAIL_CLONE==='1')process.exit(87);
  const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));if(index<0)process.exit(88);
  original=args[index];
  if(process.env.TEST_FAIL_LIBRARY==='1'&&original.endsWith('/toolkit.git'))process.exit(89);
  args[index]=original.endsWith('/alpha.git')?process.env.TEST_SKILL_REMOTE:process.env.TEST_LIBRARY_REMOTE;
  const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';
}
const result=spawnSync(real,args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);
if(original){const destination=args.at(-1);const changed=spawnSync(real,['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
`);
  await chmod(wrapper, 0o755);
  return {
    ...process.env,
    BAZFRAME_GIT_COMMAND: wrapper,
    BAZFRAME_GH_COMMAND: directory.path(`${variant}/missing-gh`),
    REAL_GIT: gitExecutable(),
    TEST_SKILL_REMOTE: skillRemote,
    TEST_LIBRARY_REMOTE: libraryRemote
  };
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
