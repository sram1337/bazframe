import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileArtifact, ProfileArtifactResource } from '../../../src/profile-portability/profile-artifact.js';
import { readProfileArtifactDirectory } from '../../../src/profile-portability/profile-artifact-io.js';
import {
  planProfileImport,
  type ProfileImportPlanDependencies
} from '../../../src/profile-portability/profile-import-plan.js';
import type { ManagedGitExportHealthSnapshot } from '../../../src/providers/managed-git.js';
import type { ManagedGitRecord } from '../../../src/providers/managed-git-record.js';
import {
  classifyLocalPackageImportResource,
  type LocalPackageMappingSnapshot
} from '../../../src/profile-portability/profile-import-local-library.js';
import { encodeProfileCollectionReference } from '../../../src/profiles/profile-skill-collection-reference.js';
import type { DerivedSkill } from '../../../src/skill-collections/skill-collection-resolver.js';
import { snapshotFilesystem } from '../../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

interface Fixture {
  temporary: TempDirectory;
  root: string;
  home: string;
  artifact: string;
  instructions: Buffer;
}

async function fixture(
  resources: ProfileArtifactResource[] = [],
  profileOverrides: Partial<ProfileArtifact['profile']> = {}
): Promise<Fixture> {
  const temporary = await createTempDirectory('bazframe-profile-import-plan-');
  temporaryDirectories.push(temporary);
  const root = await realpath(temporary.root);
  const home = join(root, 'home');
  const artifact = join(root, 'artifact');
  const instructions = Buffer.from('private exact instructions\r\n', 'utf8');
  await mkdir(join(artifact, 'profile'), { recursive: true });
  await writeFile(join(artifact, 'profile', 'AGENTS.md'), instructions);
  const profile: ProfileArtifact['profile'] = {
    id: 'focused',
    instructions: {
      path: 'profile/AGENTS.md',
      sha256: createHash('sha256').update(instructions).digest('hex')
    },
    skills: resources.filter((resource) => resource.kind === 'skill').map((resource) => resource.id),
    omittedLocalSkills: [],
    libraries: resources.filter((resource) => resource.kind === 'library').map((resource) => resource.id),
    packages: resources.filter((resource) => resource.kind === 'package').map((resource) => resource.id),
    ...profileOverrides
  };
  const manifest: ProfileArtifact = {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile,
    resources
  };
  await writeFile(join(artifact, 'bazframe-profile.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { temporary, root, home, artifact, instructions };
}

function remote(kind: 'skill' | 'library' | 'package', id: string): ProfileArtifactResource {
  const source = {
    type: 'remoteGit' as const,
    remote: `example.test/team/${id}`,
    fetchUrl: `https://example.test/team/${id}.git`,
    branch: 'main',
    revision: id.charCodeAt(0).toString(16).padStart(2, '0').repeat(20).slice(0, 40)
  };
  if (kind === 'skill') return { kind, id, source };
  if (kind === 'library') return { kind, id, source };
  return { kind, id, source };
}

function fakeHealth(
  home: string,
  kind: 'skill' | 'library' | 'package',
  id: string
): ManagedGitExportHealthSnapshot {
  const resource = remote(kind, id);
  if (resource.source.type !== 'remoteGit') throw new Error('test fixture error');
  const root = join(home, 'providers', 'git', 'checkouts', kind, id);
  const record: ManagedGitRecord = {
    schemaVersion: 1,
    kind,
    id,
    root,
    remote: resource.source.remote,
    fetchUrl: resource.source.fetchUrl,
    transport: 'git',
    branch: resource.source.branch,
    revision: resource.source.revision
  };
  return {
    recordSnapshot: {
      record,
      path: join(home, 'providers', 'git', 'records', kind, `${id}.json`),
      device: 1n,
      inode: 2n,
      contentSha256: 'f'.repeat(64)
    },
    root: { path: root, device: 3n, inode: 4n },
    resourceIdentity: `${kind}:${id}`,
    ...(kind === 'library' ? {
      collectionSnapshot: {
        record: { schemaVersion: 1, library: id, root, digest: 'a'.repeat(64) },
        path: join(home, 'libraries', `${id}.json`),
        device: 5n,
        inode: 6n,
        contentSha256: 'b'.repeat(64)
      }
    } : kind === 'package' ? {
      collectionSnapshot: {
        record: {
          schemaVersion: 1,
          package: id,
          root,
          digest: 'a'.repeat(64),
          artifactRoot: 'dist',
          skillsRoot: 'skills'
        },
        path: join(home, 'packages', `${id}.json`),
        device: 5n,
        inode: 6n,
        contentSha256: 'b'.repeat(64)
      }
    } : {})
  };
}

function createClassifier(home: string, actions: Record<string, 'create' | 'reuse' | 'blocked'>): NonNullable<ProfileImportPlanDependencies['classifyResource']> {
  return vi.fn(async (_home, kind, id) => {
    const action = actions[`${kind}:${id}`] ?? 'create';
    if (action === 'reuse') {
      const health = fakeHealth(home, kind, id);
      try {
        const metadata = await lstat(health.root.path, { bigint: true });
        health.root.device = metadata.dev;
        health.root.inode = metadata.ino;
      } catch { /* Most injected planner tests do not inspect an existing profile link. */ }
      return { action, health };
    }
    return action === 'blocked'
        ? { action, reason: `blocked ${kind}:${id}\u001b[31m` }
        : { action };
  });
}

function loadedSkill(
  name: string,
  collectionId = 'toolkit',
  collectionKind: 'library' | 'package' = 'library'
): DerivedSkill {
  return {
    name,
    baseDir: `/snapshot/${collectionId}/${name}`,
    definitionPath: `/snapshot/${collectionId}/${name}/SKILL.md`,
    collectionKind,
    collectionId,
    collectionRoot: `/snapshot/${collectionId}`,
    relativePath: `${name}/SKILL.md`
  };
}

async function writePackageSource(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'bazframe-package.json'), `${JSON.stringify({
    schemaVersion: 1,
    build: [process.execPath, '-e', 'void 0'],
    artifactRoot: 'dist',
    skillsRoot: 'skills'
  }, null, 2)}\n`);
}

describe('profile import planner', () => {
  it.each([
    ['equal', (f: Fixture) => f.artifact],
    ['artifact contains missing home', (f: Fixture) => join(f.artifact, 'missing-home')],
    ['artifact contains existing home', (f: Fixture) => join(f.artifact, 'profile')],
    ['home contains artifact', (f: Fixture) => f.root]
  ] as const)('rejects artifact/home overlap before target classification: %s', async (_label, homeFor) => {
    const f = await fixture([remote('skill', 'alpha')]);
    const classifyResource = createClassifier(f.home, { 'skill:alpha': 'create' });
    await expect(planProfileImport(
      { bazframeHome: homeFor(f), artifactDirectory: f.artifact },
      { classifyResource }
    )).rejects.toMatchObject({ code: 'PROFILE_IMPORT_PATH_OVERLAP' });
    expect(classifyResource).not.toHaveBeenCalled();
  });

  it('does not confuse a nearby path prefix with artifact/home overlap', async () => {
    const f = await fixture([remote('skill', 'alpha')]);
    const home = join(f.root, 'artifact-nearby-home');
    const classifyResource = createClassifier(home, { 'skill:alpha': 'create' });
    await expect(planProfileImport(
      { bazframeHome: home, artifactDirectory: f.artifact },
      { classifyResource }
    )).resolves.toMatchObject({ plan: { profileAction: 'publish' } });
    expect(classifyResource).toHaveBeenCalled();
  });

  it('retains one physical artifact snapshot, projects no bytes or identities, and writes nothing', async () => {
    const f = await fixture();
    const before = await snapshotFilesystem(f.root);
    const readArtifact = vi.fn(readProfileArtifactDirectory);

    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { readArtifact }
    );

    expect(readArtifact).toHaveBeenCalledTimes(1);
    expect(result.plan).toMatchObject({
      exportedProfileId: 'focused',
      destinationProfileId: 'focused',
      profileAction: 'publish',
      activeSelection: { state: 'absent', willChange: false },
      composition: { status: 'ready' },
      exclusions: {
        activeSelectionWillChange: false,
        policyWillChange: false,
        collectionChildrenEnterDefault: false
      }
    });
    expect(result.homePath).toBe(f.home);
    expect(result.artifactSnapshot.instructions.bytes).toEqual(Uint8Array.from(f.instructions));
    const serialized = JSON.stringify(result.plan);
    expect(serialized).not.toContain('private exact instructions');
    expect(serialized).not.toContain('device');
    expect(serialized).not.toContain('inode');
    expect(serialized).not.toContain('homePath');
    expect(await snapshotFilesystem(f.root)).toEqual(before);
    await expect(lstat(f.home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies --as only to destination identity', async () => {
    const resource = remote('skill', 'review-tools');
    const f = await fixture([resource]);
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact, destinationProfileId: 'renamed' },
      { classifyResource: createClassifier(f.home, { 'skill:review-tools': 'create' }) }
    );
    expect(result.plan.exportedProfileId).toBe('focused');
    expect(result.plan.destinationProfileId).toBe('renamed');
    expect(result.plan.resources[0]).toMatchObject({ id: 'review-tools', action: 'create' });
    expect(result.plan.resources[0]?.source).toEqual(resource.source);
  });

  it('accepts Stage 3 remote packages and plans unresolved unsandboxed builds without manifest fabrication', async () => {
    const resources = [remote('package', 'automation')];
    const f = await fixture(resources);
    const classifyResource = createClassifier(f.home, { 'package:automation': 'create' });
    const hook = vi.fn();

    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { classifyResource, testHooks: { afterCapabilityValidation: hook } }
    );

    expect(hook).toHaveBeenCalledTimes(1);
    expect(classifyResource).toHaveBeenCalledTimes(2);
    expect(result.plan.packages).toEqual(['automation']);
    expect(result.plan.resources).toEqual([expect.objectContaining({
      kind: 'package', id: 'automation', action: 'create', networkRequired: true, buildRequired: true
    })]);
    expect(result.plan.composition).toMatchObject({ status: 'deferred', deferredPackages: ['automation'] });
    expect(result.plan.packageBuilds).toMatchObject({
      total: 1,
      remote: 1,
      local: 0,
      unresolvedRemotePackageIds: ['automation']
    });
    expect(result.plan.packageBuilds.warnings).toEqual([
      'Package builds execute with shell:false and inherit the parent environment.',
      'Package builds execute unsandboxed with current-process-user authority and may access credentials, networks, and user files.',
      'Each package build uses the package source root as its working directory.',
      'Arbitrary package-build side effects cannot be rolled back.'
    ]);
    expect(JSON.stringify(result.plan)).not.toMatch(/manifestSnapshot|bazframe-package\.json|argv|device|inode/u);
  });

  it('precomputes missing mapping blockers before remote classification and still returns the complete plan', async () => {
    const resource = { kind: 'library', id: 'toolkit', source: { type: 'localMapping' } } satisfies ProfileArtifactResource;
    const f = await fixture([remote('skill', 'alpha'), resource]);
    const events: string[] = [];
    const classifyResource = vi.fn(async () => { events.push('remote-classifier'); return { action: 'create' as const }; });
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      {
        classifyResource,
        testHooks: { afterMappingClosureValidation: (blockers) => {
          events.push('mapping-closure');
          expect(blockers).toContainEqual(expect.objectContaining({ code: 'PROFILE_IMPORT_MAPPING_REQUIRED', key: 'library:toolkit' }));
        } }
      }
    );
    expect(result.plan.resources).toEqual([
      expect.objectContaining({ kind: 'skill', id: 'alpha', action: 'create' }),
      expect.objectContaining({ kind: 'library', id: 'toolkit', source: { type: 'localMapping' }, action: 'blocked', networkRequired: false })
    ]);
    expect(result.plan.blockers).toContainEqual(expect.objectContaining({ code: 'PROFILE_IMPORT_MAPPING_REQUIRED', key: 'library:toolkit' }));
    expect(events[0]).toBe('mapping-closure');
    expect(classifyResource).toHaveBeenCalledTimes(2);
  });

  it('validates and projects canonical local-library mappings without remote work', async () => {
    const resource = { kind: 'library', id: 'toolkit', source: { type: 'localMapping' } } satisfies ProfileArtifactResource;
    const f = await fixture([resource]);
    const root = join(f.root, 'sources', 'toolkit');
    await mkdir(root, { recursive: true });
    const classifyResource = vi.fn();
    const classifyLocalLibrary = vi.fn(async () => ({ action: 'create' as const }));
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact, mappings: [{ kind: 'library', id: 'toolkit', root }] },
      { classifyResource, classifyLocalLibrary }
    );
    expect(result.plan.resources).toEqual([expect.objectContaining({
      kind: 'library', id: 'toolkit', source: { type: 'localMapping', root: await realpath(root) },
      action: 'create', networkRequired: false, buildRequired: false
    })]);
    expect(result.mappingSnapshots).toEqual([expect.objectContaining({ id: 'toolkit', root: await realpath(root) })]);
    expect(classifyResource).not.toHaveBeenCalled();
    expect(classifyLocalLibrary).toHaveBeenCalledTimes(2);

    await expect(planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact, mappings: [{ kind: 'library', id: 'extra', root }] }
    )).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
  });

  it('plans local package creation with private exact manifest evidence and intentional public root only', async () => {
    const resource = { kind: 'package', id: 'automation', source: { type: 'localMapping' } } satisfies ProfileArtifactResource;
    const f = await fixture([resource]);
    const root = join(f.root, 'sources', 'automation');
    await writePackageSource(root);
    const classifyResource = vi.fn();
    const classifyLocalPackage = vi.fn(async () => ({ action: 'create' as const }));

    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact, mappings: [{ kind: 'package', id: 'automation', root }] },
      { classifyResource, classifyLocalPackage }
    );

    expect(result.plan.resources).toEqual([expect.objectContaining({
      kind: 'package', id: 'automation', source: { type: 'localMapping', root: await realpath(root) },
      action: 'create', networkRequired: false, buildRequired: true
    })]);
    expect(result.plan.packageBuilds).toMatchObject({ total: 1, remote: 0, local: 1, unresolvedRemotePackageIds: [] });
    expect(result.plan.composition.deferredPackages).toEqual(['automation']);
    expect(result.mappingSnapshots).toEqual([expect.objectContaining({
      kind: 'package', id: 'automation', root: await realpath(root), manifestSnapshot: expect.any(Object)
    })]);
    expect(classifyResource).not.toHaveBeenCalled();
    expect(classifyLocalPackage).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(result.plan);
    expect(serialized).toContain(await realpath(root));
    expect(serialized).not.toMatch(/manifest|argv|device|inode|contentSha256|artifactRoot|skillsRoot/u);
  });

  it('reuses exact remote and local packages build-free while resolving their known children', async () => {
    const remoteFixture = await fixture([remote('package', 'automation')]);
    const resolveRemotePackage = vi.fn(async () => [loadedSkill('remote-child', 'automation', 'package')]);
    const remoteResult = await planProfileImport(
      { bazframeHome: remoteFixture.home, artifactDirectory: remoteFixture.artifact },
      {
        classifyResource: createClassifier(remoteFixture.home, { 'package:automation': 'reuse' }),
        resolvePackage: resolveRemotePackage,
        classifyDestination: async () => ({ action: 'publish' })
      }
    );
    expect(remoteResult.plan.resources).toEqual([expect.objectContaining({
      kind: 'package', action: 'reuse', networkRequired: false, buildRequired: false
    })]);
    expect(remoteResult.plan.packageBuilds).toEqual({ total: 0, remote: 0, local: 0, unresolvedRemotePackageIds: [], warnings: [] });
    expect(remoteResult.plan.composition).toMatchObject({
      status: 'ready', deferredPackages: [], knownCollectionSkillPreview: ['remote-child']
    });
    expect(resolveRemotePackage).toHaveBeenCalledTimes(1);

    const localResource = { kind: 'package', id: 'local-tools', source: { type: 'localMapping' } } satisfies ProfileArtifactResource;
    const localFixture = await fixture([localResource]);
    const localRoot = join(localFixture.root, 'sources', 'local-tools');
    await writePackageSource(localRoot);
    const classifyLocalPackage = vi.fn(async (_home: string, _id: string, mapping: LocalPackageMappingSnapshot) => ({
      action: 'reuse' as const,
      health: {
        mapping,
        collectionSnapshot: {
          record: {
            schemaVersion: 1 as const,
            package: mapping.id,
            root: mapping.root,
            digest: 'a'.repeat(64),
            artifactRoot: 'dist',
            skillsRoot: 'skills'
          },
          path: join(localFixture.home, 'packages', `${mapping.id}.json`),
          device: 7n,
          inode: 8n,
          contentSha256: 'b'.repeat(64)
        }
      }
    }));
    const resolveLocalPackage = vi.fn(async () => [loadedSkill('local-child', 'local-tools', 'package')]);
    const localResult = await planProfileImport(
      {
        bazframeHome: localFixture.home,
        artifactDirectory: localFixture.artifact,
        mappings: [{ kind: 'package', id: 'local-tools', root: localRoot }]
      },
      { classifyLocalPackage, resolvePackage: resolveLocalPackage, classifyDestination: async () => ({ action: 'publish' }) }
    );
    expect(localResult.plan.resources).toEqual([expect.objectContaining({ action: 'reuse', buildRequired: false })]);
    expect(localResult.plan.packageBuilds.total).toBe(0);
    expect(classifyLocalPackage).toHaveBeenCalledTimes(2);
    expect(resolveLocalPackage).toHaveBeenCalledTimes(1);
  });

  it('validates typed mapping closure and keeps same-ID library/package mappings independent', async () => {
    const resources = [
      { kind: 'library', id: 'shared', source: { type: 'localMapping' } },
      { kind: 'package', id: 'shared', source: { type: 'localMapping' } }
    ] satisfies ProfileArtifactResource[];
    const f = await fixture(resources);
    const libraryRoot = join(f.root, 'libraries', 'shared');
    const packageRoot = join(f.root, 'packages', 'shared');
    await mkdir(libraryRoot, { recursive: true });
    await writePackageSource(packageRoot);
    const classifyLocalCollection = vi.fn(async () => ({ action: 'create' as const }));
    const result = await planProfileImport(
      {
        bazframeHome: f.home,
        artifactDirectory: f.artifact,
        mappings: [
          { kind: 'package', id: 'shared', root: packageRoot },
          { kind: 'library', id: 'shared', root: libraryRoot }
        ]
      },
      { classifyLocalCollection }
    );
    expect(result.plan.resources.map((item) => `${item.kind}:${item.id}`)).toEqual(['library:shared', 'package:shared']);
    expect(result.mappingSnapshots.map((item) => `${item.kind}:${item.id}`)).toEqual(['library:shared', 'package:shared']);
    expect(result.plan.composition).toMatchObject({ deferredLibraries: ['shared'], deferredPackages: ['shared'] });

    const missing = await planProfileImport(
      {
        bazframeHome: f.home,
        artifactDirectory: f.artifact,
        mappings: [{ kind: 'library', id: 'shared', root: libraryRoot }]
      },
      { classifyLocalCollection }
    );
    expect(missing.plan.blockers).toContainEqual(expect.objectContaining({
      code: 'PROFILE_IMPORT_MAPPING_REQUIRED', key: 'package:shared'
    }));

    await expect(planProfileImport({
      bazframeHome: f.home,
      artifactDirectory: f.artifact,
      mappings: [
        { kind: 'library', id: 'shared', root: libraryRoot },
        { kind: 'library', id: 'shared', root: libraryRoot }
      ]
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
    await expect(planProfileImport({
      bazframeHome: f.home,
      artifactDirectory: f.artifact,
      mappings: [{ kind: 'package', id: 'other', root: packageRoot }]
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });

    const libraryOnly = await fixture([{ kind: 'library', id: 'shared', source: { type: 'localMapping' } }]);
    await expect(planProfileImport({
      bazframeHome: libraryOnly.home,
      artifactDirectory: libraryOnly.artifact,
      mappings: [{ kind: 'package', id: 'shared', root: packageRoot }]
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
  });

  it('blocks package provider occupancy, different-root state, and manifest drift without build work', async () => {
    const resource = { kind: 'package', id: 'automation', source: { type: 'localMapping' } } satisfies ProfileArtifactResource;
    for (const reason of ['Package automation has remote Git provider occupancy.', 'Local package automation is registered at another root.']) {
      const f = await fixture([resource]);
      const root = join(f.root, 'sources', 'automation');
      await writePackageSource(root);
      const result = await planProfileImport(
        { bazframeHome: f.home, artifactDirectory: f.artifact, mappings: [{ kind: 'package', id: 'automation', root }] },
        { classifyLocalPackage: async () => ({ action: 'blocked', reason }) }
      );
      expect(result.plan.resources).toEqual([expect.objectContaining({ action: 'blocked', networkRequired: false, buildRequired: false })]);
      expect(result.plan.profileAction).toBe('blocked');
      expect(result.plan.packageBuilds.total).toBe(0);
    }

    const drift = await fixture([resource]);
    const driftRoot = join(drift.root, 'sources', 'automation');
    await writePackageSource(driftRoot);
    let calls = 0;
    const classifyLocalPackage = vi.fn(async (home: string, id: string, mapping: LocalPackageMappingSnapshot) => {
      calls += 1;
      if (calls === 1) {
        const initial = await classifyLocalPackageImportResource(home, id, mapping);
        await writeFile(join(driftRoot, 'bazframe-package.json'), `${JSON.stringify({
          schemaVersion: 1, build: [process.execPath, '-e', 'void 1'], artifactRoot: 'dist', skillsRoot: 'skills'
        }, null, 2)}\n`);
        return initial;
      }
      return await classifyLocalPackageImportResource(home, id, mapping);
    });
    const changed = await planProfileImport(
      { bazframeHome: drift.home, artifactDirectory: drift.artifact, mappings: [{ kind: 'package', id: 'automation', root: driftRoot }] },
      { classifyLocalPackage, classifyDestination: async () => ({ action: 'publish' }) }
    );
    expect(changed.plan.resources).toEqual([expect.objectContaining({ action: 'blocked', buildRequired: false })]);
    expect(changed.plan.blockers).toContainEqual(expect.objectContaining({ code: 'PROFILE_IMPORT_RESOURCE_CHANGED' }));
    expect(changed.plan.packageBuilds.total).toBe(0);

    const rootDrift = await fixture([resource]);
    const rootDriftPath = join(rootDrift.root, 'sources', 'automation');
    const movedRoot = join(rootDrift.root, 'sources', 'moved-automation');
    await writePackageSource(rootDriftPath);
    let rootCalls = 0;
    const classifyRootDrift = vi.fn(async (home: string, id: string, mapping: LocalPackageMappingSnapshot) => {
      rootCalls += 1;
      if (rootCalls === 1) {
        const initial = await classifyLocalPackageImportResource(home, id, mapping);
        await rename(rootDriftPath, movedRoot);
        await writePackageSource(rootDriftPath);
        return initial;
      }
      return await classifyLocalPackageImportResource(home, id, mapping);
    });
    const rootChanged = await planProfileImport(
      {
        bazframeHome: rootDrift.home,
        artifactDirectory: rootDrift.artifact,
        mappings: [{ kind: 'package', id: 'automation', root: rootDriftPath }]
      },
      { classifyLocalPackage: classifyRootDrift, classifyDestination: async () => ({ action: 'publish' }) }
    );
    expect(rootChanged.plan.resources).toEqual([expect.objectContaining({ action: 'blocked', buildRequired: false })]);
    expect(rootChanged.plan.blockers).toContainEqual(expect.objectContaining({ code: 'PROFILE_IMPORT_RESOURCE_CHANGED' }));
  });

  it('rejects cross-kind mapping overlap', async () => {
    const f = await fixture([
      { kind: 'library', id: 'shared', source: { type: 'localMapping' } },
      { kind: 'package', id: 'shared', source: { type: 'localMapping' } }
    ]);
    const sharedRoot = join(f.root, 'sources', 'shared');
    await writePackageSource(sharedRoot);
    await expect(planProfileImport({
      bazframeHome: f.home,
      artifactDirectory: f.artifact,
      mappings: [
        { kind: 'library', id: 'shared', root: sharedRoot },
        { kind: 'package', id: 'shared', root: sharedRoot }
      ]
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_OVERLAP' });
  });

  it('rejects mapped-root overlap with BAZFRAME_HOME and other mappings', async () => {
    const one = await fixture([{ kind: 'library', id: 'toolkit', source: { type: 'localMapping' } }]);
    const insideHome = join(one.home, 'toolkit');
    await mkdir(insideHome, { recursive: true });
    await expect(planProfileImport({
      bazframeHome: one.home,
      artifactDirectory: one.artifact,
      mappings: [{ kind: 'library', id: 'toolkit', root: insideHome }]
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_OVERLAP' });

    const two = await fixture([
      { kind: 'library', id: 'alpha', source: { type: 'localMapping' } },
      { kind: 'library', id: 'beta', source: { type: 'localMapping' } }
    ]);
    const alpha = join(two.root, 'sources', 'alpha');
    const beta = join(alpha, 'beta');
    await mkdir(beta, { recursive: true });
    await expect(planProfileImport({
      bazframeHome: two.home,
      artifactDirectory: two.artifact,
      mappings: [
        { kind: 'library', id: 'alpha', root: alpha },
        { kind: 'library', id: 'beta', root: beta }
      ]
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_OVERLAP' });

    const artifactNested = await fixture([{ kind: 'library', id: 'toolkit', source: { type: 'localMapping' } }]);
    const enclosingMapping = join(artifactNested.root, 'toolkit');
    await mkdir(enclosingMapping);
    const nestedArtifact = join(enclosingMapping, 'artifact');
    await rename(artifactNested.artifact, nestedArtifact);
    await expect(planProfileImport({
      bazframeHome: artifactNested.home,
      artifactDirectory: nestedArtifact,
      mappings: [{ kind: 'library', id: 'toolkit', root: enclosingMapping }]
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_OVERLAP' });

    const homeNested = await fixture([{ kind: 'library', id: 'toolkit', source: { type: 'localMapping' } }]);
    const homeEnclosingMapping = join(homeNested.root, 'toolkit');
    await mkdir(homeEnclosingMapping);
    await expect(planProfileImport({
      bazframeHome: join(homeEnclosingMapping, 'home'),
      artifactDirectory: homeNested.artifact,
      mappings: [{ kind: 'library', id: 'toolkit', root: homeEnclosingMapping }]
    })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_OVERLAP' });

    const nearby = await fixture([{ kind: 'library', id: 'toolkit', source: { type: 'localMapping' } }]);
    const nearbyRoot = join(nearby.root, 'home-nearby', 'toolkit');
    await mkdir(nearbyRoot, { recursive: true });
    await expect(planProfileImport(
      {
        bazframeHome: nearby.home,
        artifactDirectory: nearby.artifact,
        mappings: [{ kind: 'library', id: 'toolkit', root: nearbyRoot }]
      },
      { classifyLocalLibrary: async () => ({ action: 'create' }) }
    )).resolves.toMatchObject({ plan: { resources: [expect.objectContaining({ action: 'create' })] } });
  });

  it('preserves canonical mixed resource/action order across Skill, library, and package namespaces', async () => {
    const resources = [
      remote('skill', 'alpha'),
      remote('skill', 'zeta'),
      remote('library', 'alpha'),
      remote('library', 'zeta'),
      remote('package', 'alpha'),
      remote('package', 'zeta')
    ];
    const f = await fixture(resources);
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      {
        classifyResource: createClassifier(f.home, {
          'skill:alpha': 'reuse',
          'skill:zeta': 'create',
          'library:alpha': 'blocked',
          'library:zeta': 'reuse',
          'package:alpha': 'create',
          'package:zeta': 'reuse'
        }),
        resolveLibrary: async () => [],
        resolvePackage: async () => [],
        classifyDestination: async () => ({ action: 'publish' })
      }
    );
    expect(result.plan.resources.map((resource) => `${resource.kind}:${resource.id}:${resource.action}`)).toEqual([
      'skill:alpha:reuse',
      'skill:zeta:create',
      'library:alpha:blocked',
      'library:zeta:reuse',
      'package:alpha:create',
      'package:zeta:reuse'
    ]);
    expect(result.plan.packageBuilds).toMatchObject({ total: 1, remote: 1, local: 0 });
  });

  it('keeps package-aware advisory planning read-only while reporting future network/build work', async () => {
    const localPackage = { kind: 'package', id: 'local-tools', source: { type: 'localMapping' } } satisfies ProfileArtifactResource;
    const f = await fixture([remote('package', 'automation'), localPackage]);
    const localRoot = join(f.root, 'sources', 'local-tools');
    await writePackageSource(localRoot);
    const before = await snapshotFilesystem(f.root);
    const classifyResource = createClassifier(f.home, { 'package:automation': 'create' });
    const classifyLocalPackage = vi.fn(async () => ({ action: 'create' as const }));

    const result = await planProfileImport(
      {
        bazframeHome: f.home,
        artifactDirectory: f.artifact,
        mappings: [{ kind: 'package', id: 'local-tools', root: localRoot }]
      },
      { classifyResource, classifyLocalPackage }
    );

    expect(result.plan.packageBuilds).toMatchObject({ total: 2, remote: 1, local: 1 });
    expect(result.plan.resources).toEqual([
      expect.objectContaining({ id: 'automation', networkRequired: true, buildRequired: true }),
      expect.objectContaining({ id: 'local-tools', networkRequired: false, buildRequired: true })
    ]);
    expect(await snapshotFilesystem(f.root)).toEqual(before);
    await expect(lstat(f.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(classifyResource).toHaveBeenCalledTimes(2);
    expect(classifyLocalPackage).toHaveBeenCalledTimes(2);
  });

  it('returns sorted escaped resource blockers and computes the profile action last', async () => {
    const resources = [remote('skill', 'alpha'), remote('library', 'zeta')];
    const f = await fixture(resources);
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { classifyResource: createClassifier(f.home, { 'skill:alpha': 'blocked', 'library:zeta': 'blocked' }) }
    );
    expect(result.plan.profileAction).toBe('blocked');
    expect(result.plan.blockers.map((item) => item.key)).toEqual(['library:zeta', 'skill:alpha']);
    expect(JSON.stringify(result.plan)).not.toContain('\u001b[31m');
    expect(result.plan.resources.every((resource) => resource.networkRequired === false)).toBe(true);
    expect(result.plan.composition.status).toBe('blocked');
  });

  it('blocks dangling and malformed active selection without changing it', async () => {
    const dangling = await fixture();
    await dangling.temporary.write('home/active-profile', 'focused\n');
    const danglingPlan = await planProfileImport({ bazframeHome: dangling.home, artifactDirectory: dangling.artifact });
    expect(danglingPlan.plan.profileAction).toBe('blocked');
    expect(danglingPlan.plan.activeSelection).toEqual({ state: 'selected', profileId: 'focused', willChange: false });
    expect(danglingPlan.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_DANGLING_ACTIVE_SELECTION' })
    ]));

    const other = await fixture();
    await other.temporary.write('home/active-profile', 'another-profile\n');
    const otherPlan = await planProfileImport({ bazframeHome: other.home, artifactDirectory: other.artifact });
    expect(otherPlan.plan.profileAction).toBe('publish');
    expect(otherPlan.plan.activeSelection).toEqual({ state: 'selected', profileId: 'another-profile', willChange: false });
    expect(otherPlan.plan.blockers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_DANGLING_ACTIVE_SELECTION' })
    ]));

    const malformed = await fixture();
    await malformed.temporary.write('home/active-profile', '../escape\n');
    const malformedPlan = await planProfileImport({ bazframeHome: malformed.home, artifactDirectory: malformed.artifact });
    expect(malformedPlan.plan.profileAction).toBe('blocked');
    expect(malformedPlan.plan.activeSelection).toMatchObject({ state: 'blocked', willChange: false });

    if (process.platform !== 'win32') {
      const linked = await fixture();
      await linked.temporary.write('selected-profile', 'focused\n');
      await mkdir(linked.home);
      await symlink(join(linked.root, 'selected-profile'), join(linked.home, 'active-profile'));
      const linkedPlan = await planProfileImport({ bazframeHome: linked.home, artifactDirectory: linked.artifact });
      expect(linkedPlan.plan.profileAction).toBe('blocked');
      expect(linkedPlan.plan.activeSelection).toMatchObject({ state: 'blocked', willChange: false });
    }
  });

  it('reuses an exact active or inactive destination and blocks physical differences', async () => {
    const f = await fixture();
    await mkdir(join(f.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await writeFile(join(f.home, 'profiles', 'focused', 'AGENTS.md'), f.instructions);
    await writeFile(join(f.home, 'active-profile'), 'focused\n');
    const before = await snapshotFilesystem(f.home);
    const exact = await planProfileImport({ bazframeHome: f.home, artifactDirectory: f.artifact });
    expect(exact.plan.profileAction).toBe('reuse');
    expect(exact.plan.activeSelection).toMatchObject({ state: 'selected', profileId: 'focused' });
    expect(await snapshotFilesystem(f.home)).toEqual(before);

    await writeFile(join(f.home, 'profiles', 'focused', 'README.md'), 'extra');
    const mismatched = await planProfileImport({ bazframeHome: f.home, artifactDirectory: f.artifact });
    expect(mismatched.plan.profileAction).toBe('blocked');
    expect(mismatched.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_PROFILE_COLLISION' })
    ]));
  });

  it('reuses exact direct links and library references without promoting collection children', async () => {
    const resources = [remote('skill', 'review-tools'), remote('library', 'toolkit')];
    const f = await fixture(resources);
    const skillRoot = fakeHealth(f.home, 'skill', 'review-tools').root.path;
    await mkdir(skillRoot, { recursive: true });
    await mkdir(join(f.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await mkdir(join(f.home, 'profiles', 'focused', 'libraries'));
    await writeFile(join(f.home, 'profiles', 'focused', 'AGENTS.md'), f.instructions);
    await symlink(skillRoot, join(f.home, 'profiles', 'focused', 'skills', 'review-tools'));
    await writeFile(
      join(f.home, 'profiles', 'focused', 'libraries', 'toolkit.json'),
      encodeProfileCollectionReference({ schemaVersion: 1, library: 'toolkit' })
    );
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      {
        classifyResource: createClassifier(f.home, {
          'skill:review-tools': 'reuse',
          'library:toolkit': 'reuse'
        }),
        resolveLibrary: async () => [loadedSkill('toolkit-child')]
      }
    );
    expect(result.plan.profileAction).toBe('reuse');
    expect(result.plan.composition).toEqual({
      status: 'ready',
      deferredLibraries: [],
      deferredPackages: [],
      knownCollectionSkillCount: 1,
      knownCollectionSkillPreview: ['toolkit-child']
    });
    expect(result.plan.skills).toEqual(['review-tools']);
    expect(result.plan.resources.map((resource) => resource.id)).toEqual(['review-tools', 'toolkit']);
    expect(result.resourceSnapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'library',
        id: 'toolkit',
        health: expect.objectContaining({ collectionSnapshot: expect.any(Object) })
      })
    ]));
    expect(JSON.stringify(result.plan)).not.toContain('collectionSnapshot');
  });

  it('reuses an exact destination with package references and package children kept out of direct Skills', async () => {
    const f = await fixture([remote('package', 'automation')]);
    await mkdir(join(f.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await mkdir(join(f.home, 'profiles', 'focused', 'packages'));
    await writeFile(join(f.home, 'profiles', 'focused', 'AGENTS.md'), f.instructions);
    await writeFile(
      join(f.home, 'profiles', 'focused', 'packages', 'automation.json'),
      encodeProfileCollectionReference({ schemaVersion: 1, package: 'automation' })
    );
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      {
        classifyResource: createClassifier(f.home, { 'package:automation': 'reuse' }),
        resolvePackage: async () => [loadedSkill('package-child', 'automation', 'package')]
      }
    );
    expect(result.plan.profileAction).toBe('reuse');
    expect(result.plan.skills).toEqual([]);
    expect(result.plan.packages).toEqual(['automation']);
    expect(result.plan.composition).toMatchObject({ status: 'ready', knownCollectionSkillPreview: ['package-child'] });
  });

  it('marks unavailable libraries deferred and blocks known direct or omitted collisions', async () => {
    const deferredFixture = await fixture([remote('library', 'toolkit')]);
    const deferred = await planProfileImport(
      { bazframeHome: deferredFixture.home, artifactDirectory: deferredFixture.artifact },
      { classifyResource: createClassifier(deferredFixture.home, { 'library:toolkit': 'create' }) }
    );
    expect(deferred.plan.composition).toEqual({
      status: 'deferred',
      deferredLibraries: ['toolkit'],
      deferredPackages: [],
      knownCollectionSkillCount: 0,
      knownCollectionSkillPreview: []
    });
    expect(deferred.plan.profileAction).toBe('publish');

    const collisionFixture = await fixture(
      [remote('skill', 'review-tools'), remote('library', 'toolkit')],
      { omittedLocalSkills: ['workstation-helper'] }
    );
    const collision = await planProfileImport(
      { bazframeHome: collisionFixture.home, artifactDirectory: collisionFixture.artifact },
      {
        classifyResource: createClassifier(collisionFixture.home, {
          'skill:review-tools': 'reuse',
          'library:toolkit': 'reuse'
        }),
        resolveLibrary: async () => [
          loadedSkill('review-tools'),
          loadedSkill('workstation-helper')
        ],
        classifyDestination: async () => ({ action: 'publish' })
      }
    );
    expect(collision.plan.composition.status).toBe('blocked');
    expect(collision.plan.profileAction).toBe('blocked');
    expect(collision.plan.blockers.filter((item) => item.code === 'PROFILE_IMPORT_COMPOSITION_BLOCKED')).toHaveLength(2);
    expect(collision.plan.omittedLocalSkills).toEqual(['workstation-helper']);
    expect(collision.plan.skills).toEqual(['review-tools']);
  });

  it('blocks linked or substituted destination namespace ancestry', async () => {
    if (process.platform === 'win32') return;
    const linked = await fixture();
    await mkdir(linked.home);
    await mkdir(join(linked.root, 'outside-profiles'));
    await symlink(join(linked.root, 'outside-profiles'), join(linked.home, 'profiles'));
    const linkedPlan = await planProfileImport({ bazframeHome: linked.home, artifactDirectory: linked.artifact });
    expect(linkedPlan.plan.profileAction).toBe('blocked');
    expect(linkedPlan.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_PROFILE_COLLISION' })
    ]));

    const substituted = await fixture();
    await mkdir(substituted.home);
    await mkdir(join(substituted.root, 'outside-profiles'));
    await expect(planProfileImport(
      { bazframeHome: substituted.home, artifactDirectory: substituted.artifact },
      { testHooks: { beforeDestinationFinalCheck: async () => {
        await symlink(join(substituted.root, 'outside-profiles'), join(substituted.home, 'profiles'));
      } } }
    )).rejects.toMatchObject({ code: 'READ_ONLY_PATH_CHANGED' });
  });

  it.each([
    ['registration identity', (health: ReturnType<typeof fakeHealth>) => { health.resourceIdentity = 'library:toolkit:changed'; }],
    ['omitted collection snapshot', (health: ReturnType<typeof fakeHealth>) => { health.collectionSnapshot = undefined; }],
    ['collection snapshot path', (health: ReturnType<typeof fakeHealth>) => {
      health.collectionSnapshot!.path = `${health.collectionSnapshot!.path}.changed`;
    }],
    ['collection snapshot content', (health: ReturnType<typeof fakeHealth>) => {
      health.collectionSnapshot!.contentSha256 = '0'.repeat(64);
    }]
  ])('uses captured collection evidence and blocks changed %s', async (_label, mutate) => {
    const f = await fixture([remote('library', 'toolkit')]);
    let calls = 0;
    const classifyResource: NonNullable<ProfileImportPlanDependencies['classifyResource']> = vi.fn(async () => {
      calls += 1;
      const health = fakeHealth(f.home, 'library', 'toolkit');
      if (calls > 1) mutate(health);
      return { action: 'reuse' as const, health };
    });
    const resolveLibrary = vi.fn(async (_home: string, _id: string, record: { digest: string }) => {
      expect(record.digest).toBe('a'.repeat(64));
      return [loadedSkill('known-child')];
    });
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { classifyResource, resolveLibrary, classifyDestination: async () => ({ action: 'publish' }) }
    );
    expect(resolveLibrary).toHaveBeenCalledTimes(1);
    expect(classifyResource).toHaveBeenCalledTimes(2);
    expect(result.plan.resources).toEqual([
      expect.objectContaining({ id: 'toolkit', action: 'blocked', networkRequired: false })
    ]);
    expect(result.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_RESOURCE_CHANGED' })
    ]));
    expect(result.resourceSnapshots).toEqual([]);
  });

  it.each([
    [1, 'ready', 1],
    [2, 'ready', 2],
    [3, 'blocked', 0]
  ] as const)('bounds aggregate known collection children at two: %s', async (count, status, knownCount) => {
    const f = await fixture([remote('library', 'toolkit')]);
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      {
        classifyResource: createClassifier(f.home, { 'library:toolkit': 'reuse' }),
        resolveLibrary: async () => Array.from({ length: count }, (_, index) => loadedSkill(`child-${index}`)),
        classifyDestination: async () => ({ action: 'publish' }),
        maxKnownCollectionSkills: 2
      }
    );
    expect(result.plan.composition.status).toBe(status);
    expect(result.plan.composition.knownCollectionSkillCount).toBe(knownCount);
    expect(result.plan.blockers.filter((item) => item.code === 'PROFILE_IMPORT_COMPOSITION_LIMIT'))
      .toHaveLength(count > 2 ? 1 : 0);
  });

  it('blocks collisions between referenced library and package children', async () => {
    const f = await fixture([remote('library', 'alpha'), remote('package', 'beta')]);
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      {
        classifyResource: createClassifier(f.home, { 'library:alpha': 'reuse', 'package:beta': 'reuse' }),
        resolveLibrary: async (_home, id) => [loadedSkill('shared-child', id)],
        resolvePackage: async (_home, id) => [loadedSkill('shared-child', id, 'package')],
        classifyDestination: async () => ({ action: 'publish' })
      }
    );
    expect(result.plan.composition.status).toBe('blocked');
    expect(result.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_COMPOSITION_BLOCKED' })
    ]));
  });

  it('treats empty optional namespaces as equivalent and detects destination content changes', async () => {
    const empty = await fixture();
    await mkdir(join(empty.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await mkdir(join(empty.home, 'profiles', 'focused', 'libraries'));
    await mkdir(join(empty.home, 'profiles', 'focused', 'packages'));
    await writeFile(join(empty.home, 'profiles', 'focused', 'AGENTS.md'), empty.instructions);
    await expect(planProfileImport({ bazframeHome: empty.home, artifactDirectory: empty.artifact }))
      .resolves.toMatchObject({ plan: { profileAction: 'reuse' } });

    const changed = await fixture();
    await mkdir(join(changed.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await writeFile(join(changed.home, 'profiles', 'focused', 'AGENTS.md'), 'different\n');
    await expect(planProfileImport({ bazframeHome: changed.home, artifactDirectory: changed.artifact }))
      .resolves.toMatchObject({ plan: { profileAction: 'blocked' } });
  });

  it('blocks wrong direct links, malformed references, and occupied --as destinations', async () => {
    if (process.platform === 'win32') return;
    const skillFixture = await fixture([remote('skill', 'review-tools')]);
    const expectedRoot = fakeHealth(skillFixture.home, 'skill', 'review-tools').root.path;
    const wrongRoot = join(skillFixture.home, 'wrong', 'review-tools');
    await mkdir(expectedRoot, { recursive: true });
    await mkdir(join(skillFixture.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await writeFile(join(skillFixture.home, 'profiles', 'focused', 'AGENTS.md'), skillFixture.instructions);
    await symlink(wrongRoot, join(skillFixture.home, 'profiles', 'focused', 'skills', 'review-tools'));
    const wrongLink = await planProfileImport(
      { bazframeHome: skillFixture.home, artifactDirectory: skillFixture.artifact },
      { classifyResource: createClassifier(skillFixture.home, { 'skill:review-tools': 'reuse' }) }
    );
    expect(wrongLink.plan.profileAction).toBe('blocked');

    const substitutedSkill = await fixture([remote('skill', 'review-tools')]);
    const substitutedRoot = fakeHealth(substitutedSkill.home, 'skill', 'review-tools').root.path;
    const replacementRoot = join(substitutedSkill.home, 'replacement', 'review-tools');
    await mkdir(substitutedRoot, { recursive: true });
    await mkdir(replacementRoot, { recursive: true });
    await mkdir(join(substitutedSkill.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await writeFile(join(substitutedSkill.home, 'profiles', 'focused', 'AGENTS.md'), substitutedSkill.instructions);
    const membership = join(substitutedSkill.home, 'profiles', 'focused', 'skills', 'review-tools');
    await symlink(substitutedRoot, membership);
    const substitutedLink = await planProfileImport(
      { bazframeHome: substitutedSkill.home, artifactDirectory: substitutedSkill.artifact },
      {
        classifyResource: createClassifier(substitutedSkill.home, { 'skill:review-tools': 'reuse' }),
        testHooks: { beforeDestinationFinalCheck: async () => {
          await rm(membership);
          await symlink(replacementRoot, membership);
        } }
      }
    );
    expect(substitutedLink.plan.profileAction).toBe('blocked');

    const referenceFixture = await fixture([remote('library', 'toolkit')]);
    await mkdir(join(referenceFixture.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await mkdir(join(referenceFixture.home, 'profiles', 'focused', 'libraries'));
    await writeFile(join(referenceFixture.home, 'profiles', 'focused', 'AGENTS.md'), referenceFixture.instructions);
    await writeFile(join(referenceFixture.home, 'profiles', 'focused', 'libraries', 'toolkit.json'), '{}\n');
    const malformedReference = await planProfileImport(
      { bazframeHome: referenceFixture.home, artifactDirectory: referenceFixture.artifact },
      {
        classifyResource: createClassifier(referenceFixture.home, { 'library:toolkit': 'reuse' }),
        resolveLibrary: async () => []
      }
    );
    expect(malformedReference.plan.profileAction).toBe('blocked');

    const substitutedReference = await fixture([remote('library', 'toolkit')]);
    await mkdir(join(substitutedReference.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await mkdir(join(substitutedReference.home, 'profiles', 'focused', 'libraries'));
    await writeFile(join(substitutedReference.home, 'profiles', 'focused', 'AGENTS.md'), substitutedReference.instructions);
    const referencePath = join(substitutedReference.home, 'profiles', 'focused', 'libraries', 'toolkit.json');
    await writeFile(referencePath, encodeProfileCollectionReference({ schemaVersion: 1, library: 'toolkit' }));
    const changedReference = await planProfileImport(
      { bazframeHome: substitutedReference.home, artifactDirectory: substitutedReference.artifact },
      {
        classifyResource: createClassifier(substitutedReference.home, { 'library:toolkit': 'reuse' }),
        resolveLibrary: async () => [],
        testHooks: { beforeDestinationFinalCheck: async () => { await writeFile(referencePath, '{}\n'); } }
      }
    );
    expect(changedReference.plan.profileAction).toBe('blocked');

    const renamed = await fixture();
    await mkdir(join(renamed.home, 'profiles', 'occupied'), { recursive: true });
    const occupied = await planProfileImport({
      bazframeHome: renamed.home,
      artifactDirectory: renamed.artifact,
      destinationProfileId: 'occupied'
    });
    expect(occupied.plan.destinationProfileId).toBe('occupied');
    expect(occupied.plan.profileAction).toBe('blocked');
  });

  it('detects destination mutation and returns deterministic hostile plans', async () => {
    const mutated = await fixture();
    await mkdir(join(mutated.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await writeFile(join(mutated.home, 'profiles', 'focused', 'AGENTS.md'), mutated.instructions);
    const mutation = await planProfileImport(
      { bazframeHome: mutated.home, artifactDirectory: mutated.artifact },
      { testHooks: { beforeDestinationFinalCheck: async () => {
        await writeFile(join(mutated.home, 'profiles', 'focused', 'late-entry'), 'late');
      } } }
    );
    expect(mutation.plan.profileAction).toBe('blocked');

    const deterministic = await fixture([remote('skill', 'alpha'), remote('library', 'zeta')]);
    const dependencies = {
      classifyResource: createClassifier(deterministic.home, { 'skill:alpha': 'blocked', 'library:zeta': 'blocked' })
    };
    const first = await planProfileImport(
      { bazframeHome: deterministic.home, artifactDirectory: deterministic.artifact },
      dependencies
    );
    const second = await planProfileImport(
      { bazframeHome: deterministic.home, artifactDirectory: deterministic.artifact },
      dependencies
    );
    expect(second.plan).toEqual(first.plan);
    expect(JSON.stringify(second.plan)).toBe(JSON.stringify(first.plan));
  });

  it('anchors a missing home to its held canonical parent', async () => {
    const f = await fixture();
    const parent = join(f.root, 'home-parent');
    const moved = join(f.root, 'moved-home-parent');
    const home = join(parent, 'nested', 'home');
    await mkdir(parent);
    const before = await snapshotFilesystem(f.root);
    let substituted = false;
    try {
      await expect(planProfileImport(
        { bazframeHome: home, artifactDirectory: f.artifact },
        { testHooks: { beforeDestinationFinalCheck: async () => {
          if (substituted) return;
          substituted = true;
          await rename(parent, moved);
          await mkdir(parent);
        } } }
      )).rejects.toMatchObject({ code: 'READ_ONLY_PATH_CHANGED' });
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rename(moved, parent);
    }
    expect(await snapshotFilesystem(f.root)).toEqual(before);
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });

    if (process.platform !== 'win32') {
      const alias = join(f.root, 'home-parent-alias');
      await symlink(parent, alias);
      const aliasedHome = join(alias, 'nested', 'aliased-home');
      await expect(planProfileImport(
        { bazframeHome: aliasedHome, artifactDirectory: f.artifact }
      )).resolves.toMatchObject({ plan: { profileAction: 'publish' } });
      await expect(lstat(aliasedHome)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each([false, true])('rejects planning after restored %s-home anchor substitution', async (existingHome) => {
    if (process.platform === 'win32') return;
    const f = await fixture([remote('skill', 'review-tools')]);
    const parent = join(f.root, 'home-parent');
    const home = existingHome ? f.home : join(parent, 'nested', 'home');
    const anchoredPath = existingHome ? home : parent;
    const moved = `${anchoredPath}.moved`;
    await mkdir(existingHome ? home : parent, { recursive: true });
    const before = await snapshotFilesystem(f.root);
    let calls = 0;
    const classifyResource: NonNullable<ProfileImportPlanDependencies['classifyResource']> = vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        await rename(anchoredPath, moved);
        await mkdir(anchoredPath);
        await rm(anchoredPath, { recursive: true });
        await rename(moved, anchoredPath);
      }
      return { action: 'create' as const };
    });
    await expect(planProfileImport(
      { bazframeHome: home, artifactDirectory: f.artifact },
      { classifyResource }
    )).rejects.toMatchObject({ code: 'READ_ONLY_PATH_CHANGED' });
    expect(await snapshotFilesystem(f.root)).toEqual(before);
    if (!existingHome) await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recaptures destination and active selection after final resource health', async () => {
    if (process.platform === 'win32') return;
    const destination = await fixture([remote('skill', 'review-tools')]);
    const skillRoot = fakeHealth(destination.home, 'skill', 'review-tools').root.path;
    await mkdir(skillRoot, { recursive: true });
    await mkdir(join(destination.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await writeFile(join(destination.home, 'profiles', 'focused', 'AGENTS.md'), destination.instructions);
    await symlink(skillRoot, join(destination.home, 'profiles', 'focused', 'skills', 'review-tools'));
    let destinationCalls = 0;
    const destinationClassifier: NonNullable<ProfileImportPlanDependencies['classifyResource']> = vi.fn(async () => {
      destinationCalls += 1;
      if (destinationCalls === 2) {
        await writeFile(join(destination.home, 'profiles', 'focused', 'AGENTS.md'), 'changed after initial destination capture\n');
      }
      const health = fakeHealth(destination.home, 'skill', 'review-tools');
      const metadata = await lstat(health.root.path, { bigint: true });
      health.root.device = metadata.dev;
      health.root.inode = metadata.ino;
      return { action: 'reuse' as const, health };
    });
    const changedDestination = await planProfileImport(
      { bazframeHome: destination.home, artifactDirectory: destination.artifact },
      { classifyResource: destinationClassifier }
    );
    expect(changedDestination.plan.profileAction).toBe('blocked');
    expect(changedDestination.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_PROFILE_CHANGED' })
    ]));

    const replaced = await fixture([remote('skill', 'review-tools')]);
    const replacedSkillRoot = fakeHealth(replaced.home, 'skill', 'review-tools').root.path;
    const replacedProfile = join(replaced.home, 'profiles', 'focused');
    await mkdir(replacedSkillRoot, { recursive: true });
    await mkdir(join(replacedProfile, 'skills'), { recursive: true });
    await writeFile(join(replacedProfile, 'AGENTS.md'), replaced.instructions);
    await symlink(replacedSkillRoot, join(replacedProfile, 'skills', 'review-tools'));
    let replacementCalls = 0;
    const replacementClassifier: NonNullable<ProfileImportPlanDependencies['classifyResource']> = vi.fn(async () => {
      replacementCalls += 1;
      if (replacementCalls === 2) {
        await rename(replacedProfile, `${replacedProfile}.old`);
        await mkdir(join(replacedProfile, 'skills'), { recursive: true });
        await writeFile(join(replacedProfile, 'AGENTS.md'), replaced.instructions);
        await symlink(replacedSkillRoot, join(replacedProfile, 'skills', 'review-tools'));
      }
      const health = fakeHealth(replaced.home, 'skill', 'review-tools');
      const metadata = await lstat(health.root.path, { bigint: true });
      health.root.device = metadata.dev;
      health.root.inode = metadata.ino;
      return { action: 'reuse' as const, health };
    });
    const replacedDestination = await planProfileImport(
      { bazframeHome: replaced.home, artifactDirectory: replaced.artifact },
      { classifyResource: replacementClassifier }
    );
    expect(replacedDestination.plan.profileAction).toBe('blocked');
    expect(replacedDestination.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_PROFILE_CHANGED' })
    ]));

    for (const initial of [undefined, 'another-profile\n'] as const) {
      const active = await fixture([remote('skill', 'review-tools')]);
      await mkdir(active.home);
      if (initial !== undefined) await writeFile(join(active.home, 'active-profile'), initial);
      let activeCalls = 0;
      const activeClassifier: NonNullable<ProfileImportPlanDependencies['classifyResource']> = vi.fn(async () => {
        activeCalls += 1;
        if (activeCalls === 2) await writeFile(join(active.home, 'active-profile'), 'focused\n');
        return { action: 'create' as const };
      });
      const planning = planProfileImport(
        { bazframeHome: active.home, artifactDirectory: active.artifact },
        { classifyResource: activeClassifier }
      );
      if (initial === undefined) {
        await expect(planning).rejects.toMatchObject({ code: 'READ_ONLY_PATH_CHANGED' });
        continue;
      }
      const changedActive = await planning;
      expect(changedActive.plan.profileAction).toBe('blocked');
      expect(changedActive.plan.activeSelection).toEqual({ state: 'selected', profileId: 'focused', willChange: false });
      expect(changedActive.plan.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'PROFILE_IMPORT_ACTIVE_SELECTION_CHANGED' }),
        expect.objectContaining({ code: 'PROFILE_IMPORT_DANGLING_ACTIVE_SELECTION' })
      ]));
    }
  });

  it('detects active-profile target disappearance during final recapture', async () => {
    const f = await fixture([remote('skill', 'review-tools')]);
    await mkdir(join(f.home, 'profiles', 'another-profile'), { recursive: true });
    await writeFile(join(f.home, 'active-profile'), 'another-profile\n');
    let calls = 0;
    const classifyResource: NonNullable<ProfileImportPlanDependencies['classifyResource']> = vi.fn(async () => {
      calls += 1;
      if (calls === 2) await rm(join(f.home, 'profiles', 'another-profile'), { recursive: true });
      return { action: 'create' as const };
    });
    const result = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { classifyResource }
    );
    expect(result.plan.profileAction).toBe('blocked');
    expect(result.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_IMPORT_ACTIVE_SELECTION_CHANGED' })
    ]));
  });

  it('bounds the direct-Skill namespace independently of the profile root', async () => {
    if (process.platform === 'win32') return;
    const resources = ['alpha', 'bravo', 'charlie', 'delta'].map((id) => remote('skill', id));
    const f = await fixture(resources);
    await mkdir(join(f.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await writeFile(join(f.home, 'profiles', 'focused', 'AGENTS.md'), f.instructions);
    for (const resource of resources) {
      const root = fakeHealth(f.home, 'skill', resource.id).root.path;
      await mkdir(root, { recursive: true });
      await symlink(root, join(f.home, 'profiles', 'focused', 'skills', resource.id));
    }
    const classifyResource = createClassifier(f.home, Object.fromEntries(
      resources.map((resource) => [`skill:${resource.id}`, 'reuse' as const])
    ));
    await expect(planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { classifyResource, maxProfileNamespaceEntries: 4 }
    )).resolves.toMatchObject({ plan: { profileAction: 'reuse' } });
    const blocked = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { classifyResource, maxProfileNamespaceEntries: 3 }
    );
    expect(blocked.plan.profileAction).toBe('blocked');
    expect(blocked.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('skills') })
    ]));
  });

  it('bounds the library-reference namespace independently of the profile root', async () => {
    const resources = ['alpha', 'bravo', 'charlie', 'delta'].map((id) => remote('library', id));
    const f = await fixture(resources);
    await mkdir(join(f.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await mkdir(join(f.home, 'profiles', 'focused', 'libraries'));
    await writeFile(join(f.home, 'profiles', 'focused', 'AGENTS.md'), f.instructions);
    for (const resource of resources) {
      await writeFile(
        join(f.home, 'profiles', 'focused', 'libraries', `${resource.id}.json`),
        encodeProfileCollectionReference({ schemaVersion: 1, library: resource.id })
      );
    }
    const classifyResource = createClassifier(f.home, Object.fromEntries(
      resources.map((resource) => [`library:${resource.id}`, 'reuse' as const])
    ));
    await expect(planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { classifyResource, resolveLibrary: async () => [], maxProfileNamespaceEntries: 4 }
    )).resolves.toMatchObject({ plan: { profileAction: 'reuse' } });
    const blocked = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { classifyResource, resolveLibrary: async () => [], maxProfileNamespaceEntries: 3 }
    );
    expect(blocked.plan.profileAction).toBe('blocked');
    expect(blocked.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('libraries') })
    ]));
  });

  it('streams destination namespaces within the lower-only entry limit', async () => {
    const f = await fixture();
    await mkdir(join(f.home, 'profiles', 'focused', 'skills'), { recursive: true });
    await writeFile(join(f.home, 'profiles', 'focused', 'AGENTS.md'), f.instructions);
    await expect(planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { maxProfileNamespaceEntries: 2 }
    )).resolves.toMatchObject({ plan: { profileAction: 'reuse' } });
    const blocked = await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { maxProfileNamespaceEntries: 1 }
    );
    expect(blocked.plan.profileAction).toBe('blocked');
    expect(blocked.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('entry import-planning limit') })
    ]));
    await expect(planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact },
      { maxProfileNamespaceEntries: 1025 }
    )).rejects.toMatchObject({ code: 'PROFILE_PORTABILITY_POLICY_INVALID' });
  });

  it('snapshots the environment once before target classification', async () => {
    const f = await fixture([remote('skill', 'review-tools')]);
    const environment: NodeJS.ProcessEnv = { MARKER: 'before' };
    const seen: Array<string | undefined> = [];
    const classifyResource: NonNullable<ProfileImportPlanDependencies['classifyResource']> = vi.fn(async (
      _home,
      _kind,
      _id,
      _source,
      capturedEnvironment
    ) => {
      seen.push(capturedEnvironment.MARKER);
      environment.MARKER = 'after';
      return { action: 'create' as const };
    });
    await planProfileImport(
      { bazframeHome: f.home, artifactDirectory: f.artifact, environment },
      { classifyResource }
    );
    expect(seen).toEqual(['before', 'before']);
  });
});
