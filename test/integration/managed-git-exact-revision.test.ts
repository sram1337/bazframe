import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addManagedGitLibrary,
  addManagedGitLibraryAtRevision,
  addManagedGitSkillAtRevision,
  captureManagedGitExportHealth,
  classifyManagedGitImportOutcome
} from '../../src/providers/managed-git.js';
import { readManagedGitJournal, readManagedGitRecord, scanManagedGitRecords, type PathFreeManagedGitIdentity } from '../../src/providers/managed-git-record.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} Skill\n---\n# ${name}\n`;

describe('unexposed exact-revision remote Git lifecycle', () => {
  it('materializes a historical reachable library revision and reuses it without network', async () => {
    const directory = await createTempDirectory('bazframe-exact-git-history-'); directories.push(directory);
    const remote = await libraryRemote(directory, 'toolkit');
    const first = git(['rev-parse', 'HEAD'], remote).trim();
    await directory.write('remote/toolkit/beta/SKILL.md', skill('beta'));
    git(['add', '.'], remote); git(['commit', '-m', 'advance'], remote);
    const head = git(['rev-parse', 'HEAD'], remote).trim();
    const environment = await managedEnvironment(directory, remote);
    const home = directory.path('home');

    const added = await addManagedGitLibraryAtRevision({ bazframeHome: home, environment }, 'toolkit', identity('toolkit', first));
    expect(added).toMatchObject({ action: 'added', branch: 'main', revision: first });
    const record = (await readManagedGitRecord(home, 'library', 'toolkit')).record;
    expect(record).toMatchObject({ revision: first, branch: 'main', remote: 'example.test/team/toolkit' });
    expect(git(['rev-parse', 'HEAD'], record.root).trim()).toBe(first);
    expect(git(['rev-parse', 'refs/remotes/origin/main'], record.root).trim()).toBe(first);
    expect(spawnSync(gitExecutable(), ['symbolic-ref', '-q', 'HEAD'], { cwd: record.root }).status).toBe(1);
    expect(head).not.toBe(first);

    const reused = await addManagedGitLibraryAtRevision(
      { bazframeHome: home, environment: { ...environment, TEST_FAIL_CLONE: '1' } },
      'toolkit',
      identity('toolkit', first)
    );
    expect(reused).toMatchObject({ action: 'current', revision: first });
    const expectedHealth = await captureManagedGitExportHealth(home, 'library', 'toolkit', environment);
    const requiredReuse = await addManagedGitLibraryAtRevision(
      { bazframeHome: home, environment: { ...environment, TEST_FAIL_CLONE: '1' } },
      'toolkit',
      identity('toolkit', first),
      { mode: 'must-reuse', expectedHealth }
    );
    expect(requiredReuse).toMatchObject({ action: 'current', revision: first });
    await expect(addManagedGitLibraryAtRevision(
      { bazframeHome: home, environment: { ...environment, TEST_FAIL_CLONE: '1' } },
      'toolkit',
      identity('toolkit', head)
    )).rejects.toMatchObject({ code: 'MANAGED_GIT_IDENTITY_MISMATCH' });

    const replacementHome = directory.path('replacement-home');
    const replacement = await addManagedGitLibraryAtRevision({
      bazframeHome: replacementHome,
      environment,
      testHooks: {
        afterCloneOriginValidated: async () => {
          const containers = await readdir(join(replacementHome, 'providers/git/staging'));
          const root = join(replacementHome, 'providers/git/staging', containers[0]!, 'toolkit');
          git(['replace', first, head], root);
          git(['pack-refs', '--all'], root);
          await rm(join(root, '.git', 'refs', 'replace'), { recursive: true, force: true });
        }
      }
    }, 'toolkit', identity('toolkit', first));
    expect(replacement).toMatchObject({ revision: first });
    await expect(readFile(join(replacement.root, 'beta', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(['rev-parse', 'HEAD'], replacement.root).trim()).toBe(first);

    const hookHome = directory.path('hook-home');
    const gitLog = directory.path('managed-git-commands.log');
    const postCheckoutMarker = directory.path('post-checkout-ran');
    const referenceTransactionMarker = directory.path('reference-transaction-ran');
    await writeFile(gitLog, '');
    const hooked = await addManagedGitLibraryAtRevision({
      bazframeHome: hookHome,
      environment: {
        ...environment,
        TEST_GIT_LOG: gitLog,
        TEST_POST_CHECKOUT_MARKER: postCheckoutMarker,
        TEST_REFERENCE_TRANSACTION_MARKER: referenceTransactionMarker
      },
      testHooks: {
        afterCloneOriginValidated: async () => {
          const containers = await readdir(join(hookHome, 'providers/git/staging'));
          const root = join(hookHome, 'providers/git/staging', containers[0]!, 'toolkit');
          const hostileHooks = join(root, '.git', 'bazframe-hooks-disabled');
          await mkdir(hostileHooks);
          await writeFile(join(hostileHooks, 'post-checkout'), '#!/bin/sh\nprintf invoked > "$TEST_POST_CHECKOUT_MARKER"\n');
          await writeFile(join(hostileHooks, 'reference-transaction'), '#!/bin/sh\nprintf invoked > "$TEST_REFERENCE_TRANSACTION_MARKER"\n');
          await chmod(join(hostileHooks, 'post-checkout'), 0o700);
          await chmod(join(hostileHooks, 'reference-transaction'), 0o700);
        }
      }
    }, 'toolkit', identity('toolkit', first));
    expect(hooked).toMatchObject({ revision: first });
    expect(git(['rev-parse', 'HEAD'], hooked.root).trim()).toBe(first);
    expect(git(['rev-parse', 'refs/remotes/origin/main'], hooked.root).trim()).toBe(first);
    await expect(readFile(join(hooked.root, 'beta', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(postCheckoutMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(referenceTransactionMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    const loggedCommands = (await readFile(gitLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    const exactUpdate = loggedCommands.find((args) => args.includes('update-ref'));
    expect(exactUpdate).toEqual(expect.arrayContaining(['--no-replace-objects', 'core.hooksPath=/dev/null', 'update-ref', '--no-deref']));
    expect(loggedCommands.find((args) => args.includes('checkout'))).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null']));

    git(['update-ref', 'refs/remotes/origin/target', first], hooked.root);
    git(['symbolic-ref', 'refs/remotes/origin/main', 'refs/remotes/origin/target'], hooked.root);
    await expect(addManagedGitLibraryAtRevision(
      { bazframeHome: hookHome, environment: { ...environment, TEST_FAIL_CLONE: '1' } },
      'toolkit',
      identity('toolkit', first)
    )).rejects.toMatchObject({ code: 'MANAGED_GIT_BRANCH_INVALID' });
    expect(git(['rev-parse', 'refs/remotes/origin/target'], hooked.root).trim()).toBe(first);

    await writeFile(
      join(record.root, '.git', 'commondir'),
      `${relative(join(record.root, '.git'), join(remote, '.git'))}\n`
    );
    await expect(addManagedGitLibraryAtRevision(
      { bazframeHome: home, environment: { ...environment, TEST_FAIL_CLONE: '1' } },
      'toolkit',
      identity('toolkit', first)
    )).rejects.toMatchObject({ code: 'MANAGED_GIT_ROOT_INVALID' });

    if (process.platform !== 'win32') {
      await rm(join(record.root, '.git', 'commondir'));
      const externalObjects = directory.path('external-objects');
      await rename(join(record.root, '.git', 'objects'), externalObjects);
      await symlink(externalObjects, join(record.root, '.git', 'objects'));
      await expect(addManagedGitLibraryAtRevision(
        { bazframeHome: home, environment: { ...environment, TEST_FAIL_CLONE: '1' } },
        'toolkit',
        identity('toolkit', first)
      )).rejects.toMatchObject({ code: 'MANAGED_GIT_ROOT_INVALID' });
    }
  }, 30_000);

  it('materializes an exact branch head Skill while ordinary add still selects head', async () => {
    const directory = await createTempDirectory('bazframe-exact-git-head-'); directories.push(directory);
    const skillRemote = await directory.mkdir('remote/demo-skill');
    await directory.write('remote/demo-skill/SKILL.md', skill('demo-skill'));
    initialize(skillRemote);
    const revision = git(['rev-parse', 'HEAD'], skillRemote).trim();
    const skillEnvironment = await managedEnvironment(directory, skillRemote, 'skill-wrapper.mjs');
    const pseudoBranchHome = directory.path('pseudo-branch-home');
    for (const branch of ['HEAD', 'head', 'Head']) {
      await expect(addManagedGitSkillAtRevision(
        { bazframeHome: pseudoBranchHome, environment: { ...skillEnvironment, TEST_FAIL_CLONE: '1' } },
        'demo-skill',
        { ...identity('demo-skill', revision), branch }
      )).rejects.toMatchObject({ code: 'MANAGED_GIT_RECORD_INVALID' });
      await expect(lstat(pseudoBranchHome)).rejects.toMatchObject({ code: 'ENOENT' });
    }

    const symbolicHome = directory.path('symbolic-home');
    const symbolicLog = directory.path('symbolic-git-commands.log');
    await writeFile(symbolicLog, '');
    await expect(addManagedGitSkillAtRevision({
      bazframeHome: symbolicHome,
      environment: { ...skillEnvironment, TEST_GIT_LOG: symbolicLog },
      testHooks: {
        afterCloneOriginValidated: async () => {
          const containers = await readdir(join(symbolicHome, 'providers/git/staging'));
          const root = join(symbolicHome, 'providers/git/staging', containers[0]!, 'demo-skill');
          git(['update-ref', 'refs/remotes/origin/target', revision], root);
          git(['symbolic-ref', 'refs/remotes/origin/main', 'refs/remotes/origin/target'], root);
        }
      }
    }, 'demo-skill', identity('demo-skill', revision))).rejects.toMatchObject({ code: 'MANAGED_GIT_BRANCH_INVALID' });
    expect(await readdir(join(symbolicHome, 'providers/git/staging'))).toEqual([]);
    await expect(readFile(join(symbolicHome, 'providers/git/records/skill/demo-skill.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const symbolicCommands = (await readFile(symbolicLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(symbolicCommands.some((args) => args.includes('update-ref'))).toBe(false);

    const mismatchedHome = directory.path('mismatched-home');
    await expect(addManagedGitSkillAtRevision(
      { bazframeHome: mismatchedHome, environment: { ...skillEnvironment, TEST_FAIL_CLONE: '1' } },
      'other-skill',
      identity('demo-skill', revision)
    )).rejects.toBeDefined();
    await expect(lstat(mismatchedHome)).rejects.toMatchObject({ code: 'ENOENT' });
    const exact = await addManagedGitSkillAtRevision(
      { bazframeHome: directory.path('skill-home'), environment: skillEnvironment },
      'demo-skill',
      identity('demo-skill', revision)
    );
    expect(exact).toMatchObject({ action: 'added', revision });

    const libraryRemotePath = await libraryRemote(directory, 'ordinary');
    const initial = git(['rev-parse', 'HEAD'], libraryRemotePath).trim();
    await directory.write('remote/ordinary/beta/SKILL.md', skill('beta'));
    git(['add', '.'], libraryRemotePath); git(['commit', '-m', 'advance'], libraryRemotePath);
    const head = git(['rev-parse', 'HEAD'], libraryRemotePath).trim();
    const ordinaryEnvironment = await managedEnvironment(directory, libraryRemotePath, 'ordinary-wrapper.mjs');
    const ordinary = await addManagedGitLibrary(
      { bazframeHome: directory.path('ordinary-home'), environment: ordinaryEnvironment },
      'https://example.test/team/ordinary.git'
    );
    expect(ordinary).toMatchObject({ action: 'added', revision: head });
    expect(ordinary.revision).not.toBe(initial);
  }, 30_000);

  it('refuses missing, unrelated, tag, tree, blob, and rewritten-away revisions without residue', async () => {
    const directory = await createTempDirectory('bazframe-exact-git-refusal-'); directories.push(directory);
    const remote = await libraryRemote(directory, 'toolkit');
    const first = git(['rev-parse', 'HEAD'], remote).trim();
    const tree = git(['rev-parse', 'HEAD^{tree}'], remote).trim();
    const blob = git(['rev-parse', 'HEAD:alpha/SKILL.md'], remote).trim();
    git(['tag', '-a', 'release', '-m', 'release'], remote);
    const tag = git(['rev-parse', 'refs/tags/release'], remote).trim();
    git(['checkout', '--orphan', 'other'], remote);
    git(['rm', '-rf', '.'], remote);
    await directory.write('remote/toolkit/other/SKILL.md', skill('other'));
    git(['add', '.'], remote); git(['commit', '-m', 'unrelated'], remote);
    const unrelated = git(['rev-parse', 'HEAD'], remote).trim();
    git(['checkout', 'main'], remote);
    const environment = await managedEnvironment(directory, remote);

    const graftHome = directory.path('home-graft');
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: graftHome,
      environment,
      testHooks: {
        afterCloneOriginValidated: async () => {
          const containers = await readdir(join(graftHome, 'providers/git/staging'));
          const root = join(graftHome, 'providers/git/staging', containers[0]!, 'toolkit');
          await mkdir(join(root, '.git', 'info'), { recursive: true });
          await writeFile(join(root, '.git', 'info', 'grafts'), `${first} ${unrelated}\n`);
          expect(spawnSync(gitExecutable(), ['merge-base', '--is-ancestor', unrelated, first], { cwd: root }).status).toBe(0);
        }
      }
    }, 'toolkit', identity('toolkit', unrelated))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
    expect(await readdir(join(graftHome, 'providers/git/staging'))).toEqual([]);

    for (const [label, revision] of [
      ['missing', 'f'.repeat(40)],
      ['unrelated', unrelated],
      ['tag', tag],
      ['tree', tree],
      ['blob', blob]
    ] as const) {
      const home = directory.path(`home-${label}`);
      await expect(addManagedGitLibraryAtRevision({ bazframeHome: home, environment }, 'toolkit', identity('toolkit', revision))).rejects.toBeDefined();
      await expect(readFile(`${home}/providers/git/records/library/toolkit.json`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readManagedGitJournal(home, 'library', 'toolkit')).rejects.toBeDefined();
      expect(await readdir(`${home}/providers/git/staging`)).toEqual([]);
    }

    git(['reset', '--hard', unrelated], remote);
    git(['branch', '-D', 'other'], remote);
    git(['tag', '-d', 'release'], remote);
    const rewrittenHome = directory.path('home-rewritten');
    await expect(addManagedGitLibraryAtRevision({ bazframeHome: rewrittenHome, environment }, 'toolkit', identity('toolkit', first))).rejects.toBeDefined();
    await expect(readFile(`${rewrittenHome}/providers/git/records/library/toolkit.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(`${rewrittenHome}/providers/git/staging`)).toEqual([]);
  }, 45_000);

  it('never acquires when exact must-reuse evidence disappears', async () => {
    const directory = await createTempDirectory('bazframe-exact-git-must-reuse-'); directories.push(directory);
    const remote = await libraryRemote(directory, 'toolkit');
    const revision = git(['rev-parse', 'HEAD'], remote).trim();
    const environment = await managedEnvironment(directory, remote);
    const home = directory.path('home');
    await addManagedGitLibraryAtRevision({ bazframeHome: home, environment }, 'toolkit', identity('toolkit', revision));
    const expectedHealth = await captureManagedGitExportHealth(home, 'library', 'toolkit', environment);
    const recordPath = join(home, 'providers/git/records/library/toolkit.json');
    await rename(recordPath, `${recordPath}.removed`);
    await expect(addManagedGitLibraryAtRevision(
      { bazframeHome: home, environment: { ...environment, TEST_FAIL_CLONE: '1' } },
      'toolkit',
      identity('toolkit', revision),
      { mode: 'must-reuse', expectedHealth }
    )).rejects.not.toMatchObject({ code: 'MANAGED_GIT_PROCESS_FAILED' });
    expect(await readdir(join(home, 'providers/git/staging'))).toEqual([]);
  }, 45_000);

  it('retains exact recovery and staging on injected uncertain acquisition termination', async () => {
    const directory = await createTempDirectory('bazframe-exact-git-quarantine-'); directories.push(directory);
    const remote = await libraryRemote(directory, 'toolkit');
    const revision = git(['rev-parse', 'HEAD'], remote).trim();
    const environment = await managedEnvironment(directory, remote);
    const failedHome = directory.path('certain-failure-home');
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: failedHome,
      environment: { ...environment, TEST_FAIL_CLONE: '1' }
    }, 'toolkit', identity('toolkit', revision))).rejects.toBeDefined();
    expect(await readdir(join(failedHome, 'providers/git/staging'))).toEqual([]);
    await expect(readManagedGitJournal(failedHome, 'library', 'toolkit')).rejects.toBeDefined();

    const home = directory.path('exact-home');
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: home,
      environment: {
        ...environment,
        TEST_EXPECT_JOURNAL: join(home, 'providers/git/recovery/library-toolkit.json')
      },
      testHooks: { injectUncertainAcquisitionFailure: true }
    }, 'toolkit', identity('toolkit', revision))).rejects.toBeDefined();
    const journal = await readManagedGitJournal(home, 'library', 'toolkit');
    expect(journal.journal).toMatchObject({
      operation: 'add-exact',
      phase: 'acquisition-quarantined',
      branch: 'main',
      nextRevision: revision
    });
    expect(journal.journal.staging).not.toBeNull();
    await expect(lstat(journal.journal.staging!)).resolves.toMatchObject({});
    await expect(classifyManagedGitImportOutcome(home, 'library', 'toolkit', identity('toolkit', revision), environment))
      .resolves.toEqual({ state: 'recovery-required' });

    const ordinaryHome = directory.path('ordinary-home-quarantine');
    await expect(addManagedGitLibrary({
      bazframeHome: ordinaryHome,
      environment,
      testHooks: { injectUncertainAcquisitionFailure: true }
    }, 'https://example.test/team/toolkit.git')).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_QUARANTINED' });
    expect(await readdir(join(ordinaryHome, 'providers/git/staging'))).toHaveLength(1);
  }, 45_000);

  it('fails closed on remote-tracking ref mutation and post-clone or post-rename bounds', async () => {
    const directory = await createTempDirectory('bazframe-exact-git-races-'); directories.push(directory);
    const remote = await libraryRemote(directory, 'toolkit');
    const first = git(['rev-parse', 'HEAD'], remote).trim();
    await directory.write('remote/toolkit/beta/SKILL.md', skill('beta'));
    git(['add', '.'], remote); git(['commit', '-m', 'advance'], remote);
    const head = git(['rev-parse', 'HEAD'], remote).trim();
    const environment = await managedEnvironment(directory, remote);

    const raceHome = directory.path('race-home');
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: raceHome,
      environment,
      testHooks: {
        beforeExactRefUpdate: async () => {
          const containers = await readdir(`${raceHome}/providers/git/staging`);
          const root = `${raceHome}/providers/git/staging/${containers[0]}/toolkit`;
          git(['update-ref', 'refs/remotes/origin/main', first], root);
        }
      }
    }, 'toolkit', identity('toolkit', first))).rejects.toBeDefined();
    expect(await readdir(`${raceHome}/providers/git/staging`)).toEqual([]);

    const alternateHome = directory.path('alternate-home');
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: alternateHome,
      environment,
      testHooks: {
        afterCloneOriginValidated: async () => {
          const containers = await readdir(join(alternateHome, 'providers/git/staging'));
          const root = join(alternateHome, 'providers/git/staging', containers[0]!, 'toolkit');
          const externalObjects = directory.path('alternate-objects');
          await mkdir(externalObjects);
          await mkdir(join(root, '.git', 'objects', 'info'), { recursive: true });
          await writeFile(join(root, '.git', 'objects', 'info', 'Alternates'), `${externalObjects}\n`);
        }
      }
    }, 'toolkit', identity('toolkit', head))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
    expect(await readdir(join(alternateHome, 'providers/git/staging'))).toEqual([]);

    const boundedHome = directory.path('bounded-home');
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: boundedHome,
      environment,
      acquisitionLimits: { maxCheckoutFileBytes: 1 }
    }, 'toolkit', identity('toolkit', head))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    expect(await readdir(`${boundedHome}/providers/git/staging`)).toEqual([]);

    const liveHome = directory.path('live-bounded-home');
    const completionMarker = directory.path('slow-clone-completed');
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: liveHome,
      environment: { ...environment, TEST_SLOW_OVERSIZE: '1', TEST_COMPLETION_MARKER: completionMarker },
      acquisitionLimits: { maxStagingBytes: 1 }
    }, 'toolkit', identity('toolkit', head))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(readFile(completionMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(liveHome, 'providers/git/staging'))).toEqual([]);
    await expect(readManagedGitJournal(liveHome, 'library', 'toolkit')).rejects.toBeDefined();

    const recoveryHome = directory.path('recovery-home');
    const recoveryRoot = `${recoveryHome}/providers/git/checkouts/library/toolkit`;
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: recoveryHome,
      environment,
      testHooks: {
        afterPublishedCheckout: async () => {
          await rename(recoveryRoot, directory.path('displaced-recovery-toolkit'));
        }
      }
    }, 'toolkit', identity('toolkit', head))).rejects.toBeDefined();
    await expect(readManagedGitJournal(recoveryHome, 'library', 'toolkit')).resolves.toMatchObject({
      journal: { operation: 'add-exact', branch: 'main', nextRevision: head }
    });
    const recoveryDiagnostic = (await scanManagedGitRecords(recoveryHome)).diagnostics
      .find((diagnostic) => diagnostic.id === 'toolkit');
    expect(recoveryDiagnostic?.message).toContain(`originating exact profile import for https://example.test/team/toolkit.git at branch main and revision ${head}`);
    expect(recoveryDiagnostic?.message).not.toContain('bazframe library add');

    const publishedHome = directory.path('published-home');
    let publishedHookRan = false;
    await expect(addManagedGitLibraryAtRevision({
      bazframeHome: publishedHome,
      environment,
      testHooks: {
        afterPublishedCheckout: async () => {
          publishedHookRan = true;
          await directory.write('published-home/providers/git/checkouts/library/toolkit/oversized', '12');
        }
      },
      acquisitionLimits: { maxCheckoutEntries: 5 }
    }, 'toolkit', identity('toolkit', head))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    expect(publishedHookRan).toBe(true);
    await expect(readFile(`${publishedHome}/providers/git/records/library/toolkit.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${publishedHome}/providers/git/checkouts/library/toolkit/oversized`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(`${publishedHome}/providers/git/staging`)).toEqual([]);
  }, 45_000);
});

function identity(id: string, revision: string): PathFreeManagedGitIdentity {
  return {
    remote: `example.test/team/${id}`,
    fetchUrl: `https://example.test/team/${id}.git`,
    branch: 'main',
    revision
  };
}

async function libraryRemote(directory: TempDirectory, id: string): Promise<string> {
  const remote = await directory.mkdir(`remote/${id}`);
  await directory.write(`remote/${id}/alpha/SKILL.md`, skill('alpha'));
  initialize(remote);
  return remote;
}

function initialize(remote: string): void {
  git(['init', '-b', 'main'], remote);
  git(['config', 'user.name', 'Test'], remote);
  git(['config', 'user.email', 'test@example.com'], remote);
  git(['add', '.'], remote);
  git(['commit', '-m', 'initial'], remote);
}

async function managedEnvironment(directory: TempDirectory, remote: string, name = 'git-wrapper.mjs'): Promise<NodeJS.ProcessEnv> {
  const wrapper = directory.path(name);
  await directory.write(name, `#!/usr/bin/env node
import{spawnSync}from'node:child_process';import{appendFileSync}from'node:fs';
const args=process.argv.slice(2);const real=process.env.REAL_GIT;let original;if(process.env.TEST_GIT_LOG)appendFileSync(process.env.TEST_GIT_LOG,JSON.stringify(args)+'\\n');
if(args.includes('clone')){if(process.env.TEST_FAIL_CLONE==='1')process.exit(87);if(process.env.TEST_EXPECT_JOURNAL){const journal=JSON.parse((await import('node:fs')).readFileSync(process.env.TEST_EXPECT_JOURNAL,'utf8'));if(journal.phase!=='acquiring')process.exit(86);}const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));if(index<0)process.exit(88);original=args[index];args[index]=process.env.TEST_REMOTE;const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';if(process.env.TEST_SLOW_OVERSIZE==='1'){const fs=await import('node:fs');const path=await import('node:path');const destination=args.at(-1);fs.mkdirSync(path.join(destination,'.git','objects'),{recursive:true});fs.writeFileSync(path.join(destination,'.git','objects','growing'),'12');setTimeout(()=>fs.writeFileSync(process.env.TEST_COMPLETION_MARKER,'completed'),250);setInterval(()=>{},1000);}}
const result=spawnSync(real,args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);
if(original){const destination=args.at(-1);const changed=spawnSync(real,['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
`);
  await chmod(wrapper, 0o755);
  return { ...process.env, BAZFRAME_GIT_COMMAND: wrapper, BAZFRAME_GH_COMMAND: directory.path('missing-gh'), REAL_GIT: gitExecutable(), TEST_REMOTE: remote };
}

function git(args: string[], cwd: string): string {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git failed: ${args.join(' ')}`);
  return result.stdout;
}
function gitExecutable(): string {
  const result = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git is required for remote Git integration tests');
  return result.stdout.trim();
}
