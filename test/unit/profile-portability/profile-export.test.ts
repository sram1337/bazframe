import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportProfile,
  ProfileExportError
} from '../../../src/profile-portability/profile-export.js';
import { readProfileArtifactDirectory } from '../../../src/profile-portability/profile-artifact-io.js';
import {
  encodeManagedGitRecord,
  managedGitCheckoutRoot,
  type ManagedGitRecord
} from '../../../src/providers/managed-git-record.js';
import {
  encodeProfileCollectionReference
} from '../../../src/profiles/profile-skill-collection-reference.js';
import { addLibrary } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

interface Fixture {
  root: string;
  home: string;
  profile: string;
  output: string;
}

async function fixture(instructions = Buffer.from('exact\r\nmultibyte: é 世界\n', 'utf8')): Promise<Fixture> {
  const temporary = await createTempDirectory('bazframe-profile-export-');
  temporaryDirectories.push(temporary);
  const root = await realpath(temporary.root);
  const home = join(root, 'home');
  const profile = join(home, 'profiles', 'portable');
  const output = join(root, 'exports', 'portable.bazframe-profile');
  await mkdir(join(profile, 'skills'), { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(join(profile, 'AGENTS.md'), instructions);
  return { root, home: await realpath(home), profile, output };
}

async function createSkill(root: string, name: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Export fixture.\n---\n# ${name}\n`
  );
  return await realpath(root);
}

async function addLocalDirect(f: Fixture, id: string): Promise<string> {
  const target = await createSkill(join(f.root, 'local-skills', id), id);
  await mkdir(join(f.home, 'skills'), { recursive: true });
  await symlink(target, join(f.home, 'skills', id));
  await symlink(target, join(f.profile, 'skills', id));
  return target;
}

async function initializeManagedGit(
  f: Fixture,
  kind: 'skill' | 'library',
  id: string,
  root: string
): Promise<{ record: ManagedGitRecord; environment: NodeJS.ProcessEnv; log: string }> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'initial'],
    { cwd: root }
  );
  const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const fetchUrl = `https://example.test/team/${id}.git`;
  await execFileAsync('git', ['remote', 'add', 'origin', fetchUrl], { cwd: root });
  await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', revision], { cwd: root });
  await execFileAsync('git', ['checkout', '--detach', revision], { cwd: root });
  const record: ManagedGitRecord = {
    schemaVersion: 1,
    kind,
    id,
    root,
    remote: `example.test/team/${id}`,
    fetchUrl,
    transport: 'git',
    branch: 'main',
    revision
  };
  const recordPath = join(f.home, 'providers', 'git', 'records', kind, `${id}.json`);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, encodeManagedGitRecord(record));
  const log = join(f.root, `${kind}-${id}-git.log`);
  const wrapper = join(f.root, `${kind}-${id}-git-wrapper.sh`);
  await writeFile(
    wrapper,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GIT_LOG"\ncase " $* " in *" clone "*|*" fetch "*) exit 97;; esac\nexec git "$@"\n'
  );
  await chmod(wrapper, 0o700);
  return { record, log, environment: { ...process.env, BAZFRAME_GIT_COMMAND: wrapper, GIT_LOG: log } };
}

async function addRemoteDirect(f: Fixture, id: string): Promise<ReturnType<typeof initializeManagedGit>> {
  const root = managedGitCheckoutRoot(f.home, 'skill', id);
  await createSkill(root, id);
  const managed = await initializeManagedGit(f, 'skill', id, root);
  await mkdir(join(f.home, 'skills'), { recursive: true });
  await symlink(root, join(f.home, 'skills', id));
  await symlink(root, join(f.profile, 'skills', id));
  return managed;
}

async function addLibraryReference(f: Fixture, id: string): Promise<void> {
  const directory = join(f.profile, 'libraries');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.json`),
    encodeProfileCollectionReference({ schemaVersion: 1, library: id })
  );
}

async function addRemoteLibrary(
  f: Fixture,
  id: string,
  childName = `${id}-child`
): Promise<ReturnType<typeof initializeManagedGit>> {
  const root = managedGitCheckoutRoot(f.home, 'library', id);
  await createSkill(join(root, childName), childName);
  const managed = await initializeManagedGit(f, 'library', id, root);
  await addLibrary({ bazframeHome: f.home }, root);
  await addLibraryReference(f, id);
  return managed;
}

describe('Stage 1 profile export service', () => {
  it('publishes a minimal canonical artifact with exact instruction bytes and structured review warning', async () => {
    const bytes = Buffer.from('first\r\nsecond: é 世界\n', 'utf8');
    const f = await fixture(bytes);
    const result = await exportProfile({
      bazframeHome: f.home,
      profileId: 'portable',
      outputDirectory: f.output
    });

    expect(result).toMatchObject({
      action: 'published',
      exportedProfileId: 'portable',
      outputPath: f.output,
      skills: [],
      omittedLocalSkills: [],
      libraries: [],
      packages: [],
      resources: [],
      warnings: [{ code: 'PROFILE_EXPORT_REVIEW_INSTRUCTIONS', path: 'profile/AGENTS.md' }]
    });
    expect(await readFile(join(f.output, 'profile', 'AGENTS.md'))).toEqual(bytes);
    const artifact = await readProfileArtifactDirectory(f.output, {
      maxManifestBytes: 1024 * 1024,
      maxProfileEntries: 1024,
      maxResources: 256
    });
    expect(artifact.artifact.profile.instructions.sha256).toBe(result.instructions.sha256);
    expect(await readdir(f.output)).toEqual(expect.arrayContaining(['bazframe-profile.json', 'profile']));
  });

  it('omits a healthy local direct Skill and returns a deterministic omission warning', async () => {
    const f = await fixture();
    await addLocalDirect(f, 'workstation-helper');
    const result = await exportProfile({ bazframeHome: f.home, profileId: 'portable', outputDirectory: f.output });
    expect(result.skills).toEqual([]);
    expect(result.omittedLocalSkills).toEqual(['workstation-helper']);
    expect(result.warnings[0]).toEqual({
      code: 'PROFILE_EXPORT_LOCAL_SKILLS_OMITTED',
      skillIds: ['workstation-helper']
    });
    const manifest = JSON.parse(await readFile(join(f.output, 'bazframe-profile.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('checkout');
    expect(await readFile(join(f.output, 'bazframe-profile.json'), 'utf8')).not.toContain(f.root);
  });

  it('includes a healthy remote Git direct Skill without clone or fetch', async () => {
    const f = await fixture();
    const managed = await addRemoteDirect(f, 'review-tools');
    const result = await exportProfile({
      bazframeHome: f.home,
      profileId: 'portable',
      outputDirectory: f.output,
      environment: managed.environment
    });
    expect(result.skills).toEqual(['review-tools']);
    expect(result.resources).toEqual([{
      kind: 'skill',
      id: 'review-tools',
      source: {
        type: 'remoteGit',
        remote: managed.record.remote,
        fetchUrl: managed.record.fetchUrl,
        branch: 'main',
        revision: managed.record.revision
      }
    }]);
    expect(await readFile(managed.log, 'utf8')).not.toMatch(/\b(?:clone|fetch)\b/u);
  });

  it('includes a healthy remote Git library as one resource and never promotes its children', async () => {
    const f = await fixture();
    const managed = await addRemoteLibrary(f, 'toolkit');
    const result = await exportProfile({
      bazframeHome: f.home,
      profileId: 'portable',
      outputDirectory: f.output,
      environment: managed.environment
    });
    expect(result.libraries).toEqual(['toolkit']);
    expect(result.skills).toEqual([]);
    expect(result.resources.map(({ kind, id }) => `${kind}:${id}`)).toEqual(['library:toolkit']);
    expect(await readFile(managed.log, 'utf8')).not.toMatch(/\b(?:clone|fetch)\b/u);
  });

  it('sorts the complete closure deterministically', async () => {
    const f = await fixture();
    await addLocalDirect(f, 'z-local');
    await addLocalDirect(f, 'a-local');
    const remoteZ = await addRemoteDirect(f, 'z-remote');
    await addRemoteDirect(f, 'a-remote');
    const result = await exportProfile({
      bazframeHome: f.home,
      profileId: 'portable',
      outputDirectory: f.output,
      environment: remoteZ.environment
    });
    expect(result.skills).toEqual(['a-remote', 'z-remote']);
    expect(result.omittedLocalSkills).toEqual(['a-local', 'z-local']);
    expect(result.resources.map(({ id }) => id)).toEqual(['a-remote', 'z-remote']);
  });

  it.each(['profile-root', 'instructions', 'skills'] as const)('rejects linked %s input', async (target) => {
    const f = await fixture();
    if (target === 'profile-root') {
      const realProfile = join(f.home, 'profiles', 'real-profile');
      await mkdir(join(realProfile, 'skills'), { recursive: true });
      await writeFile(join(realProfile, 'AGENTS.md'), 'linked\n');
      const linked = join(f.home, 'profiles', 'linked-profile');
      await symlink(realProfile, linked);
      await expect(exportProfile({ bazframeHome: f.home, profileId: 'linked-profile', outputDirectory: f.output }))
        .rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_INVALID' });
      return;
    }
    if (target === 'instructions') {
      const instructions = join(f.root, 'linked-instructions');
      await writeFile(instructions, 'linked\n');
      await import('node:fs/promises').then(({ unlink }) => unlink(join(f.profile, 'AGENTS.md')));
      await symlink(instructions, join(f.profile, 'AGENTS.md'));
    } else {
      const external = join(f.root, 'linked-skills');
      await mkdir(external);
      await import('node:fs/promises').then(({ rmdir }) => rmdir(join(f.profile, 'skills')));
      await symlink(external, join(f.profile, 'skills'));
    }
    await expect(exportProfile({ bazframeHome: f.home, profileId: 'portable', outputDirectory: f.output }))
      .rejects.toBeInstanceOf(Error);
  });

  it('rejects unknown profile-root content and enforces below/at/above namespace limits at +1', async () => {
    const unknown = await fixture();
    await writeFile(join(unknown.profile, 'README.md'), 'unknown\n');
    await expect(exportProfile({ bazframeHome: unknown.home, profileId: 'portable', outputDirectory: unknown.output }))
      .rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_INVALID' });

    const below = await fixture();
    await expect(exportProfile(
      { bazframeHome: below.home, profileId: 'portable', outputDirectory: below.output },
      { limitPolicy: { maxProfileNamespaceEntries: 1, maxProfileEntries: 1 } }
    )).resolves.toMatchObject({ omittedLocalSkills: [] });

    const at = await fixture();
    await addLocalDirect(at, 'one');
    await expect(exportProfile(
      { bazframeHome: at.home, profileId: 'portable', outputDirectory: at.output },
      { limitPolicy: { maxProfileNamespaceEntries: 1, maxProfileEntries: 1 } }
    )).resolves.toMatchObject({ omittedLocalSkills: ['one'] });

    const above = await fixture();
    await addLocalDirect(above, 'one');
    await addLocalDirect(above, 'two');
    await expect(exportProfile(
      { bazframeHome: above.home, profileId: 'portable', outputDirectory: above.output },
      { limitPolicy: { maxProfileNamespaceEntries: 1 } }
    )).rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_INVALID' });
  });

  it.each(['physical', 'relative', 'broken', 'chained', 'mismatched'] as const)('rejects %s direct Skill entries', async (kind) => {
    const f = await fixture();
    const target = await addLocalDirect(f, 'demo');
    const { unlink, rm } = await import('node:fs/promises');
    await unlink(join(f.profile, 'skills', 'demo'));
    if (kind === 'physical') await mkdir(join(f.profile, 'skills', 'demo'));
    if (kind === 'relative') await symlink('../../../local-skills/demo', join(f.profile, 'skills', 'demo'));
    if (kind === 'broken') await symlink(join(f.root, 'missing', 'demo'), join(f.profile, 'skills', 'demo'));
    if (kind === 'chained') {
      const chain = join(f.root, 'chain-demo');
      await symlink(target, chain);
      await symlink(chain, join(f.profile, 'skills', 'demo'));
    }
    if (kind === 'mismatched') {
      const other = await createSkill(join(f.root, 'other', 'demo'), 'demo');
      await symlink(other, join(f.profile, 'skills', 'demo'));
    }
    await expect(exportProfile({ bazframeHome: f.home, profileId: 'portable', outputDirectory: f.output }))
      .rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_INVALID' });
    await rm(target, { recursive: true, force: true });
  });

  it('rejects a managed-checkout Skill without provenance and mismatched same-ID provenance', async () => {
    const absent = await fixture();
    const root = managedGitCheckoutRoot(absent.home, 'skill', 'managed');
    await createSkill(root, 'managed');
    await mkdir(join(absent.home, 'skills'), { recursive: true });
    await symlink(root, join(absent.home, 'skills', 'managed'));
    await symlink(root, join(absent.profile, 'skills', 'managed'));
    await expect(exportProfile({ bazframeHome: absent.home, profileId: 'portable', outputDirectory: absent.output }))
      .rejects.toBeInstanceOf(Error);

    const mismatch = await fixture();
    await addLocalDirect(mismatch, 'managed');
    const foreignRoot = managedGitCheckoutRoot(mismatch.home, 'skill', 'managed');
    await createSkill(foreignRoot, 'managed');
    const managed = await initializeManagedGit(mismatch, 'skill', 'managed', foreignRoot);
    await expect(exportProfile({
      bazframeHome: mismatch.home,
      profileId: 'portable',
      outputDirectory: mismatch.output,
      environment: managed.environment
    })).rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_INVALID' });
  });

  it('rejects dirty, revision-mismatched, and recovering managed Git sources without publication', async () => {
    const dirty = await fixture();
    const dirtyManaged = await addRemoteDirect(dirty, 'dirty-skill');
    await writeFile(join(dirtyManaged.record.root, 'untracked.txt'), 'dirty\n');
    await expect(exportProfile({
      bazframeHome: dirty.home,
      profileId: 'portable', outputDirectory: dirty.output,
      environment: dirtyManaged.environment
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_DIRTY' });

    const revision = await fixture();
    const revisionManaged = await addRemoteDirect(revision, 'revision-skill');
    const changedRecord = { ...revisionManaged.record, revision: '0'.repeat(40) };
    await writeFile(
      join(revision.home, 'providers', 'git', 'records', 'skill', 'revision-skill.json'),
      encodeManagedGitRecord(changedRecord)
    );
    await expect(exportProfile({
      bazframeHome: revision.home,
      profileId: 'portable', outputDirectory: revision.output,
      environment: revisionManaged.environment
    })).rejects.toBeInstanceOf(Error);

    const recovery = await fixture();
    const recoveryManaged = await addRemoteDirect(recovery, 'recovery-skill');
    await mkdir(join(recovery.home, 'providers', 'git', 'recovery'), { recursive: true });
    await writeFile(join(recovery.home, 'providers', 'git', 'recovery', 'skill-recovery-skill.json'), '{}\n');
    await expect(exportProfile({
      bazframeHome: recovery.home,
      profileId: 'portable', outputDirectory: recovery.output,
      environment: recoveryManaged.environment
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_RECOVERY_REQUIRED' });
  });

  it('exports local libraries path-free while rejecting malformed libraries, packages, and composition collisions', async () => {
    const malformed = await fixture();
    await mkdir(join(malformed.profile, 'libraries'));
    await writeFile(join(malformed.profile, 'libraries', 'bad.json'), '{}\n');
    await expect(exportProfile({ bazframeHome: malformed.home, profileId: 'portable', outputDirectory: malformed.output }))
      .rejects.toMatchObject({ code: 'SKILL_COLLECTION_REFERENCE_INVALID' });

    const local = await fixture();
    const localRoot = await createSkill(join(local.root, 'libraries', 'local-library'), 'local-library');
    await addLibrary({ bazframeHome: local.home }, localRoot);
    await addLibraryReference(local, 'local-library');
    await import('node:fs/promises').then(({ rm }) => rm(localRoot, { recursive: true }));
    const localResult = await exportProfile({ bazframeHome: local.home, profileId: 'portable', outputDirectory: local.output });
    expect(localResult.resources).toEqual([{ kind: 'library', id: 'local-library', source: { type: 'localMapping' } }]);
    const localManifest = await readFile(join(local.output, 'bazframe-profile.json'), 'utf8');
    expect(localManifest).not.toContain(localRoot);
    expect(localManifest).not.toContain('digest');

    const orphanedManaged = await fixture();
    const orphanedRoot = await createSkill(managedGitCheckoutRoot(orphanedManaged.home, 'library', 'orphaned'), 'orphaned-child');
    await addLibrary({ bazframeHome: orphanedManaged.home }, orphanedRoot);
    await addLibraryReference(orphanedManaged, 'orphaned');
    await expect(exportProfile({ bazframeHome: orphanedManaged.home, profileId: 'portable', outputDirectory: orphanedManaged.output }))
      .rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_INVALID' });

    const packaged = await fixture();
    await mkdir(join(packaged.profile, 'packages'));
    await writeFile(
      join(packaged.profile, 'packages', 'runner.json'),
      encodeProfileCollectionReference({ schemaVersion: 1, package: 'runner' })
    );
    await expect(exportProfile({ bazframeHome: packaged.home, profileId: 'portable', outputDirectory: packaged.output }))
      .rejects.toMatchObject({
        code: 'PROFILE_EXPORT_STAGE2_UNSUPPORTED',
        message: 'Stage 2 profile export does not support package references.'
      });

    const collision = await fixture();
    await addLocalDirect(collision, 'same-name');
    const managed = await addRemoteLibrary(collision, 'toolkit', 'same-name');
    await expect(exportProfile({
      bazframeHome: collision.home,
      profileId: 'portable', outputDirectory: collision.output,
      environment: managed.environment
    })).rejects.toMatchObject({ code: 'PROFILE_EXPORT_COMPOSITION_INVALID' });
  });

  it('detects drift between the authorization captures and again inside publisher beforeCommit', async () => {
    const early = await fixture();
    await expect(exportProfile(
      { bazframeHome: early.home, profileId: 'portable', outputDirectory: early.output },
      { testHooks: { afterCapture: async (number) => {
        if (number === 1) await writeFile(join(early.profile, 'AGENTS.md'), 'changed between captures\n');
      } } }
    )).rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_CHANGED' });
    await expect(import('node:fs/promises').then(({ lstat }) => lstat(early.output))).rejects.toMatchObject({ code: 'ENOENT' });

    const late = await fixture();
    await expect(exportProfile(
      { bazframeHome: late.home, profileId: 'portable', outputDirectory: late.output },
      { testHooks: { afterCapture: async (number) => {
        if (number === 2) await writeFile(join(late.profile, 'AGENTS.md'), 'changed before commit\n');
      } } }
    )).rejects.toMatchObject({
      code: 'PROFILE_EXPORT_FAILED',
      commitState: 'not-published'
    });
    await expect(import('node:fs/promises').then(({ lstat }) => lstat(late.output))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delegates occupied and home-overlapping output classification without replacement or staging disclosure', async () => {
    const overlap = await fixture();
    const overlappingOutput = join(overlap.home, 'exports', 'artifact');
    await mkdir(dirname(overlappingOutput), { recursive: true });
    await expect(exportProfile({
      bazframeHome: overlap.home,
      profileId: 'portable',
      outputDirectory: overlappingOutput
    })).rejects.toMatchObject({ code: 'PROFILE_EXPORT_FAILED', commitState: 'not-published' });

    const f = await fixture();
    await mkdir(f.output);
    await writeFile(join(f.output, 'owned.txt'), 'keep\n');
    let failure: unknown;
    try {
      await exportProfile({ bazframeHome: f.home, profileId: 'portable', outputDirectory: f.output });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProfileExportError);
    expect(failure).toMatchObject({ commitState: 'not-published', outputPath: f.output });
    expect((failure as Error).message).not.toContain('.bazframe-profile-staging-');
    expect(await readFile(join(f.output, 'owned.txt'), 'utf8')).toBe('keep\n');
  });
});
