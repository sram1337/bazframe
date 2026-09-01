import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
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
import { addLibrary, addPackage } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import {
  encodePackage,
  readPackage
} from '../../../src/skill-collections/skill-collection-store.js';
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
  kind: 'skill' | 'library' | 'package',
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

async function createPackageSource(root: string, childName: string): Promise<string> {
  await createSkill(join(root, 'dist', 'skills', childName), childName);
  await writeFile(
    join(root, 'build.mjs'),
    `import{mkdir,writeFile}from'node:fs/promises';await mkdir('dist/skills/${childName}',{recursive:true});await writeFile('dist/skills/${childName}/SKILL.md',${JSON.stringify(`---\nname: ${childName}\ndescription: Export fixture.\n---\n# ${childName}\n`)});\n`
  );
  await writeFile(join(root, 'bazframe-package.json'), `${JSON.stringify({
    schemaVersion: 1,
    build: [process.execPath, 'build.mjs'],
    artifactRoot: 'dist',
    skillsRoot: 'skills'
  }, null, 2)}\n`);
  return await realpath(root);
}

async function addPackageReference(f: Fixture, id: string): Promise<void> {
  const directory = join(f.profile, 'packages');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.json`),
    encodeProfileCollectionReference({ schemaVersion: 1, package: id })
  );
}

async function addLocalPackage(f: Fixture, id: string, childName = `${id}-child`): Promise<string> {
  const root = await createPackageSource(join(f.root, 'packages', id), childName);
  await addPackage({ bazframeHome: f.home }, root);
  await addPackageReference(f, id);
  return root;
}

async function addRemotePackage(
  f: Fixture,
  id: string,
  childName = `${id}-child`
): Promise<ReturnType<typeof initializeManagedGit>> {
  const root = managedGitCheckoutRoot(f.home, 'package', id);
  await createPackageSource(root, childName);
  const managed = await initializeManagedGit(f, 'package', id, root);
  await addPackage({ bazframeHome: f.home }, root);
  await addPackageReference(f, id);
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

  it('sorts the complete Skill to library to package closure deterministically', async () => {
    const f = await fixture();
    await addLocalDirect(f, 'z-local');
    await addLocalDirect(f, 'a-local');
    const remoteZ = await addRemoteDirect(f, 'z-remote');
    await addRemoteDirect(f, 'a-remote');
    for (const id of ['z-library', 'a-library']) {
      const root = await createSkill(join(f.root, 'libraries', id), `${id}-child`);
      await addLibrary({ bazframeHome: f.home }, root);
      await addLibraryReference(f, id);
    }
    await addLocalPackage(f, 'z-package');
    await addLocalPackage(f, 'a-package');
    const result = await exportProfile({
      bazframeHome: f.home,
      profileId: 'portable',
      outputDirectory: f.output,
      environment: remoteZ.environment
    });
    expect(result.skills).toEqual(['a-remote', 'z-remote']);
    expect(result.omittedLocalSkills).toEqual(['a-local', 'z-local']);
    expect(result.libraries).toEqual(['a-library', 'z-library']);
    expect(result.packages).toEqual(['a-package', 'z-package']);
    expect(result.resources.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
      'skill:a-remote',
      'skill:z-remote',
      'library:a-library',
      'library:z-library',
      'package:a-package',
      'package:z-package'
    ]);
  }, 15_000);

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

  it('exports healthy local libraries and packages path-free from immutable snapshots after source removal', async () => {
    const f = await fixture();
    const libraryRoot = await createSkill(join(f.root, 'libraries', 'local-library'), 'library-child');
    await addLibrary({ bazframeHome: f.home }, libraryRoot);
    await addLibraryReference(f, 'local-library');
    const packageRoot = await addLocalPackage(f, 'local-package', 'package-child');
    await rm(libraryRoot, { recursive: true });
    await rm(packageRoot, { recursive: true });

    const result = await exportProfile({ bazframeHome: f.home, profileId: 'portable', outputDirectory: f.output });
    expect(result).toMatchObject({
      skills: [],
      libraries: ['local-library'],
      packages: ['local-package']
    });
    expect(result.resources).toEqual([
      { kind: 'library', id: 'local-library', source: { type: 'localMapping' } },
      { kind: 'package', id: 'local-package', source: { type: 'localMapping' } }
    ]);
    const manifestText = await readFile(join(f.output, 'bazframe-profile.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    expect(manifest.profile.packages).toEqual(['local-package']);
    expect(manifest.resources[1].source).toEqual({ type: 'localMapping' });
    for (const forbidden of [f.root, packageRoot, libraryRoot, 'artifactRoot', 'skillsRoot', 'build.mjs', process.execPath, 'digest', 'manifest', 'argv', 'transport', 'device', 'inode']) {
      expect(manifestText).not.toContain(forbidden);
    }
  });

  it('exports a healthy remote package at exact revision without promoting package children', async () => {
    const f = await fixture();
    const managed = await addRemotePackage(f, 'remote-package', 'package-child');
    const result = await exportProfile({
      bazframeHome: f.home,
      profileId: 'portable',
      outputDirectory: f.output,
      environment: managed.environment
    });
    expect(result.skills).toEqual([]);
    expect(result.packages).toEqual(['remote-package']);
    expect(result.resources).toEqual([{
      kind: 'package',
      id: 'remote-package',
      source: {
        type: 'remoteGit',
        remote: managed.record.remote,
        fetchUrl: managed.record.fetchUrl,
        branch: managed.record.branch,
        revision: managed.record.revision
      }
    }]);
    const manifestText = await readFile(join(f.output, 'bazframe-profile.json'), 'utf8');
    expect(manifestText).not.toContain(managed.record.root);
    for (const forbidden of ['transport', 'artifactRoot', 'skillsRoot', 'manifest', 'argv', 'digest', 'device', 'inode']) {
      expect(manifestText).not.toContain(forbidden);
    }
    expect(await readFile(managed.log, 'utf8')).not.toMatch(/\b(?:clone|fetch)\b/u);
  });

  it('rejects malformed package references, records, and immutable snapshots', async () => {
    const malformedReference = await fixture();
    await mkdir(join(malformedReference.profile, 'packages'));
    await writeFile(join(malformedReference.profile, 'packages', 'bad.json'), '{}\n');
    await expect(exportProfile({
      bazframeHome: malformedReference.home,
      profileId: 'portable',
      outputDirectory: malformedReference.output
    })).rejects.toMatchObject({ code: 'SKILL_COLLECTION_REFERENCE_INVALID' });

    const malformedRecord = await fixture();
    await addLocalPackage(malformedRecord, 'malformed-record');
    await writeFile(join(malformedRecord.home, 'packages', 'malformed-record.json'), '{}\n');
    await expect(exportProfile({
      bazframeHome: malformedRecord.home,
      profileId: 'portable',
      outputDirectory: malformedRecord.output
    })).rejects.toMatchObject({ code: 'SKILL_COLLECTION_RECORD_INVALID' });

    const brokenSnapshot = await fixture();
    await addLocalPackage(brokenSnapshot, 'broken-snapshot');
    const record = await readPackage(brokenSnapshot.home, 'broken-snapshot');
    const snapshotRoot = join(brokenSnapshot.home, 'skill-snapshots', 'sha256', record.digest);
    await chmod(snapshotRoot, 0o700);
    await chmod(join(snapshotRoot, 'artifact'), 0o700);
    await chmod(join(snapshotRoot, 'artifact', 'skills'), 0o700);
    await chmod(join(snapshotRoot, 'artifact', 'skills', 'broken-snapshot-child'), 0o700);
    await rm(join(snapshotRoot, 'artifact'), { recursive: true });
    await expect(exportProfile({
      bazframeHome: brokenSnapshot.home,
      profileId: 'portable',
      outputDirectory: brokenSnapshot.output
    })).rejects.toMatchObject({ code: 'SKILL_COLLECTION_CANDIDATE_INVALID' });
  });

  it('rejects dirty, recovering, provenance-mismatched, and provenance-free managed package state', async () => {
    const dirty = await fixture();
    const dirtyManaged = await addRemotePackage(dirty, 'dirty-package');
    await writeFile(join(dirtyManaged.record.root, 'untracked.txt'), 'dirty\n');
    await expect(exportProfile({
      bazframeHome: dirty.home,
      profileId: 'portable', outputDirectory: dirty.output,
      environment: dirtyManaged.environment
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_DIRTY' });

    const recovery = await fixture();
    const recoveryManaged = await addRemotePackage(recovery, 'recovery-package');
    await mkdir(join(recovery.home, 'providers', 'git', 'recovery'), { recursive: true });
    await writeFile(join(recovery.home, 'providers', 'git', 'recovery', 'package-recovery-package.json'), '{}\n');
    await expect(exportProfile({
      bazframeHome: recovery.home,
      profileId: 'portable', outputDirectory: recovery.output,
      environment: recoveryManaged.environment
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_RECOVERY_REQUIRED' });

    const mismatch = await fixture();
    const mismatchManaged = await addRemotePackage(mismatch, 'mismatch-package');
    const packageRecord = await readPackage(mismatch.home, 'mismatch-package');
    await writeFile(
      join(mismatch.home, 'packages', 'mismatch-package.json'),
      encodePackage({ ...packageRecord, root: join(mismatch.root, 'other', 'mismatch-package') })
    );
    await expect(exportProfile({
      bazframeHome: mismatch.home,
      profileId: 'portable', outputDirectory: mismatch.output,
      environment: mismatchManaged.environment
    })).rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_INVALID' });

    const orphaned = await fixture();
    const orphanedRoot = await createPackageSource(
      managedGitCheckoutRoot(orphaned.home, 'package', 'orphaned-package'),
      'orphaned-child'
    );
    await addPackage({ bazframeHome: orphaned.home }, orphanedRoot);
    await addPackageReference(orphaned, 'orphaned-package');
    await expect(exportProfile({
      bazframeHome: orphaned.home,
      profileId: 'portable', outputDirectory: orphaned.output
    })).rejects.toMatchObject({ code: 'PROFILE_EXPORT_SOURCE_INVALID' });
  });

  it('rejects direct/package and library/package child collisions without promoting children', async () => {
    const directCollision = await fixture();
    await addLocalDirect(directCollision, 'same-name');
    await addLocalPackage(directCollision, 'runner', 'same-name');
    await expect(exportProfile({
      bazframeHome: directCollision.home,
      profileId: 'portable', outputDirectory: directCollision.output
    })).rejects.toMatchObject({ code: 'PROFILE_EXPORT_COMPOSITION_INVALID' });

    const collectionCollision = await fixture();
    const libraryRoot = await createSkill(join(collectionCollision.root, 'libraries', 'toolkit'), 'same-name');
    await addLibrary({ bazframeHome: collectionCollision.home }, libraryRoot);
    await addLibraryReference(collectionCollision, 'toolkit');
    await addLocalPackage(collectionCollision, 'runner', 'same-name');
    await expect(exportProfile({
      bazframeHome: collectionCollision.home,
      profileId: 'portable', outputDirectory: collectionCollision.output
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

    const packageDrift = await fixture();
    await addLocalPackage(packageDrift, 'drifting-package');
    const initialRecord = await readPackage(packageDrift.home, 'drifting-package');
    await expect(exportProfile(
      { bazframeHome: packageDrift.home, profileId: 'portable', outputDirectory: packageDrift.output },
      { testHooks: { afterCapture: async (number) => {
        if (number === 2) {
          await writeFile(
            join(packageDrift.home, 'packages', 'drifting-package.json'),
            encodePackage({ ...initialRecord, root: join(packageDrift.root, 'moved', 'drifting-package') })
          );
        }
      } } }
    )).rejects.toMatchObject({ code: 'PROFILE_EXPORT_FAILED', commitState: 'not-published' });
    await expect(import('node:fs/promises').then(({ lstat }) => lstat(packageDrift.output)))
      .rejects.toMatchObject({ code: 'ENOENT' });
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
