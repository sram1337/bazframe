import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalLibraryMappingSnapshot,
  assertLocalPackageMappingSnapshot,
  captureLocalLibraryMapping,
  captureLocalPackageMapping,
  classifyLocalLibraryImportOutcome,
  classifyLocalLibraryImportResource,
  classifyLocalPackageImportOutcome,
  classifyLocalPackageImportResource,
  sameLocalLibraryHealth,
  sameLocalPackageHealth
} from '../../../src/profile-portability/profile-import-local-library.js';
import { managedGitCheckoutRoot } from '../../../src/providers/managed-git-record.js';
import { addLibrary, addPackage } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import { readLibrary, readPackage } from '../../../src/skill-collections/skill-collection-store.js';
import { snapshotFilesystem } from '../../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup())));

async function fixture(id = 'toolkit') {
  const temporary = await createTempDirectory('bazframe-local-library-import-');
  temporaryDirectories.push(temporary);
  const root = await realpath(temporary.root);
  const home = join(root, 'home');
  const library = join(root, 'sources', id);
  await mkdir(library, { recursive: true });
  await writeFile(join(library, 'SKILL.md'), `---\nname: ${id}\ndescription: Local mapping fixture.\n---\n# ${id}\n`);
  return { root, home, library: await realpath(library), id };
}

async function writePackageSource(packageRoot: string, id: string): Promise<void> {
  await mkdir(join(packageRoot, 'dist', 'skills', id), { recursive: true });
  await writeFile(
    join(packageRoot, 'bazframe-package.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      build: [process.execPath, '-e', 'void 0'],
      artifactRoot: 'dist',
      skillsRoot: 'skills'
    }, null, 2)}\n`
  );
  await writeFile(
    join(packageRoot, 'dist', 'skills', id, 'SKILL.md'),
    `---\nname: ${id}\ndescription: Local package mapping fixture.\n---\n# ${id}\n`
  );
}

async function packageFixture(id = 'automation') {
  const temporary = await createTempDirectory('bazframe-local-package-import-');
  temporaryDirectories.push(temporary);
  const root = await realpath(temporary.root);
  const home = join(root, 'home');
  const packageRoot = join(root, 'sources', id);
  await writePackageSource(packageRoot, id);
  return { root, home, packageRoot: await realpath(packageRoot), id };
}

describe('local-library profile import inspection', () => {
  it('captures a canonical physical mapping and rejects missing, linked, and wrong-basename roots', async () => {
    const f = await fixture();
    const snapshot = await captureLocalLibraryMapping({ kind: 'library', id: f.id, root: f.library });
    expect(snapshot).toMatchObject({ kind: 'library', id: f.id, root: f.library });
    expect(typeof snapshot.device).toBe('bigint');
    await expect(assertLocalLibraryMappingSnapshot(snapshot)).resolves.toEqual(snapshot);

    const wrongBasename = await captureLocalLibraryMapping({ kind: 'library', id: 'other', root: f.library }).catch((error: unknown) => error);
    expect(wrongBasename).toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
    expect((wrongBasename as Error).message).not.toContain(f.library);
    const missing = join(f.root, 'missing', f.id);
    const missingError = await captureLocalLibraryMapping({ kind: 'library', id: f.id, root: missing }).catch((error: unknown) => error);
    expect(missingError).toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
    expect((missingError as Error).message).not.toContain(missing);
    const linked = join(f.root, 'linked-toolkit');
    await symlink(f.library, linked);
    const linkedError = await captureLocalLibraryMapping({ kind: 'library', id: 'linked-toolkit', root: linked }).catch((error: unknown) => error);
    expect(linkedError).toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
    expect((linkedError as Error).message).not.toContain(linked);
    const file = join(f.root, 'file-root');
    await writeFile(file, 'not a directory');
    await expect(captureLocalLibraryMapping({ kind: 'library', id: 'file-root', root: file }))
      .rejects.toBeInstanceOf(Error);
  });

  it.skipIf(process.platform === 'win32')('rejects a special final mapping entry without disclosing its path', async () => {
    const socketDirectory = await mkdtemp('/tmp/bf-map-socket-');
    const enteredSocketPath = join(socketDirectory, 'socket-root');
    const server = createServer();
    server.listen(enteredSocketPath);
    await once(server, 'listening');
    try {
      const socketPath = await realpath(enteredSocketPath);
      const error = await captureLocalLibraryMapping({ kind: 'library', id: 'socket-root', root: socketPath })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
      expect((error as Error).message).not.toContain(socketPath);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(socketDirectory, { recursive: true, force: true });
    }
  });

  it('classifies stable absence as create and exact activated state as reuse', async () => {
    const f = await fixture();
    const mapping = await captureLocalLibraryMapping({ kind: 'library', id: f.id, root: f.library });
    const before = await snapshotFilesystem(f.root);
    await expect(classifyLocalLibraryImportResource(f.home, f.id, mapping)).resolves.toEqual({ action: 'create' });
    expect(await snapshotFilesystem(f.root)).toEqual(before);

    await addLibrary({ bazframeHome: f.home }, f.library);
    const first = await classifyLocalLibraryImportResource(f.home, f.id, mapping);
    const second = await classifyLocalLibraryImportResource(f.home, f.id, mapping);
    expect(first.action).toBe('reuse');
    expect(second.action).toBe('reuse');
    if (first.action === 'reuse' && second.action === 'reuse') {
      expect(sameLocalLibraryHealth(first.health, second.health)).toBe(true);
    }
    await expect(classifyLocalLibraryImportOutcome(f.home, f.id, mapping)).resolves.toMatchObject({ state: 'exact' });
  });

  it('blocks malformed records and broken activated snapshots', async () => {
    const malformed = await fixture('malformed');
    const malformedMapping = await captureLocalLibraryMapping({ kind: 'library', id: malformed.id, root: malformed.library });
    await addLibrary({ bazframeHome: malformed.home }, malformed.library);
    await writeFile(join(malformed.home, 'libraries', 'malformed.json'), '{}\n');
    await expect(classifyLocalLibraryImportResource(malformed.home, malformed.id, malformedMapping))
      .resolves.toEqual({ action: 'blocked', reason: 'Local library malformed state could not be verified safely.' });

    const broken = await fixture('broken');
    const brokenMapping = await captureLocalLibraryMapping({ kind: 'library', id: broken.id, root: broken.library });
    await addLibrary({ bazframeHome: broken.home }, broken.library);
    const record = await readLibrary(broken.home, broken.id);
    const snapshotRoot = join(broken.home, 'skill-snapshots', 'sha256', record.digest);
    const artifactRoot = join(snapshotRoot, 'artifact');
    await chmod(snapshotRoot, 0o700);
    await chmod(artifactRoot, 0o700);
    await rm(artifactRoot, { recursive: true });
    await expect(classifyLocalLibraryImportResource(broken.home, broken.id, brokenMapping))
      .resolves.toEqual({ action: 'blocked', reason: 'Local library broken state could not be verified safely.' });
  });

  it('blocks another registered root and same-kind managed-provider occupancy without cross-kind collision', async () => {
    const f = await fixture();
    const mapping = await captureLocalLibraryMapping({ kind: 'library', id: f.id, root: f.library });
    const otherRoot = join(f.root, 'other', f.id);
    await mkdir(otherRoot, { recursive: true });
    await writeFile(join(otherRoot, 'SKILL.md'), `---\nname: ${f.id}\ndescription: Other root.\n---\n# other\n`);
    await addLibrary({ bazframeHome: f.home }, otherRoot);
    await expect(classifyLocalLibraryImportResource(f.home, f.id, mapping)).resolves.toMatchObject({ action: 'blocked' });

    const occupied = await fixture('occupied');
    const occupiedMapping = await captureLocalLibraryMapping({ kind: 'library', id: occupied.id, root: occupied.library });
    await mkdir(managedGitCheckoutRoot(occupied.home, 'library', occupied.id), { recursive: true });
    await expect(classifyLocalLibraryImportResource(occupied.home, occupied.id, occupiedMapping))
      .resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('provider occupancy') });

    const packageOnly = await fixture('shared-id');
    const packageMapping = await captureLocalLibraryMapping({ kind: 'library', id: packageOnly.id, root: packageOnly.library });
    await mkdir(managedGitCheckoutRoot(packageOnly.home, 'package', packageOnly.id), { recursive: true });
    await expect(classifyLocalLibraryImportResource(packageOnly.home, packageOnly.id, packageMapping))
      .resolves.toEqual({ action: 'create' });
  });
});

describe('local-package profile import inspection', () => {
  it('captures an exact bounded manifest and rejects missing, linked, special, and wrong-basename inputs', async () => {
    const f = await packageFixture();
    const snapshot = await captureLocalPackageMapping({ kind: 'package', id: f.id, root: f.packageRoot });
    expect(snapshot).toMatchObject({ kind: 'package', id: f.id, root: f.packageRoot });
    expect(snapshot.manifestSnapshot).toMatchObject({
      manifest: { schemaVersion: 1, artifactRoot: 'dist', skillsRoot: 'skills' },
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(Object.isFrozen(snapshot.manifestSnapshot)).toBe(true);
    await expect(assertLocalPackageMappingSnapshot(snapshot)).resolves.toMatchObject({ kind: 'package', id: f.id });

    await expect(captureLocalPackageMapping({ kind: 'package', id: 'other', root: f.packageRoot }))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });

    const absentRoot = join(f.root, 'absent', f.id);
    await expect(captureLocalPackageMapping({ kind: 'package', id: f.id, root: absentRoot }))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
    const linkedRoot = join(f.root, 'linked-root', f.id);
    await mkdir(join(f.root, 'linked-root'), { recursive: true });
    await symlink(f.packageRoot, linkedRoot);
    await expect(captureLocalPackageMapping({ kind: 'package', id: f.id, root: linkedRoot }))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
    const specialRoot = join(f.root, 'special-root');
    await writeFile(specialRoot, 'not a directory');
    await expect(captureLocalPackageMapping({ kind: 'package', id: 'special-root', root: specialRoot }))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });

    const missing = await packageFixture('missing-manifest');
    await rm(join(missing.packageRoot, 'bazframe-package.json'));
    const missingError = await captureLocalPackageMapping({ kind: 'package', id: missing.id, root: missing.packageRoot })
      .catch((error: unknown) => error);
    expect(missingError).toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
    expect((missingError as Error).message).not.toContain(missing.packageRoot);

    const linked = await packageFixture('linked-manifest');
    const manifestPath = join(linked.packageRoot, 'bazframe-package.json');
    const manifestTarget = join(linked.root, 'manifest-target.json');
    await rename(manifestPath, manifestTarget);
    await symlink(manifestTarget, manifestPath);
    await expect(captureLocalPackageMapping({ kind: 'package', id: linked.id, root: linked.packageRoot }))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });

    const special = await packageFixture('special-manifest');
    const specialManifest = join(special.packageRoot, 'bazframe-package.json');
    await rm(specialManifest);
    await mkdir(specialManifest);
    await expect(captureLocalPackageMapping({ kind: 'package', id: special.id, root: special.packageRoot }))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_INVALID' });
  });

  it('classifies stable absence as create and exact healthy package state as build-free reuse', async () => {
    const f = await packageFixture();
    const mapping = await captureLocalPackageMapping({ kind: 'package', id: f.id, root: f.packageRoot });
    const before = await snapshotFilesystem(f.root);
    await expect(classifyLocalPackageImportResource(f.home, f.id, mapping)).resolves.toEqual({ action: 'create' });
    expect(await snapshotFilesystem(f.root)).toEqual(before);

    let buildCallbacks = 0;
    await addPackage(
      { bazframeHome: f.home },
      f.packageRoot,
      {
        expectedRootIdentity: { root: mapping.root, device: mapping.device, inode: mapping.inode },
        expectedPackageManifest: mapping.manifestSnapshot,
        beforePackageBuild: () => { buildCallbacks += 1; }
      }
    );
    expect(buildCallbacks).toBe(1);

    const first = await classifyLocalPackageImportResource(f.home, f.id, mapping);
    const second = await classifyLocalPackageImportResource(f.home, f.id, mapping);
    expect(first.action).toBe('reuse');
    expect(second.action).toBe('reuse');
    expect(buildCallbacks).toBe(1);
    if (first.action === 'reuse' && second.action === 'reuse') {
      expect(sameLocalPackageHealth(first.health, second.health)).toBe(true);
    }
    await expect(classifyLocalPackageImportOutcome(f.home, f.id, mapping)).resolves.toMatchObject({ state: 'exact' });
  });

  it('blocks other-root records, managed package occupancy, and unhealthy immutable snapshots', async () => {
    const otherRoot = await packageFixture('other-root');
    const mapping = await captureLocalPackageMapping({ kind: 'package', id: otherRoot.id, root: otherRoot.packageRoot });
    const replacement = join(otherRoot.root, 'other', otherRoot.id);
    await writePackageSource(replacement, otherRoot.id);
    await addPackage({ bazframeHome: otherRoot.home }, replacement);
    await expect(classifyLocalPackageImportResource(otherRoot.home, otherRoot.id, mapping))
      .resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('another root') });

    const occupied = await packageFixture('occupied');
    const occupiedMapping = await captureLocalPackageMapping({ kind: 'package', id: occupied.id, root: occupied.packageRoot });
    await mkdir(managedGitCheckoutRoot(occupied.home, 'package', occupied.id), { recursive: true });
    await expect(classifyLocalPackageImportResource(occupied.home, occupied.id, occupiedMapping))
      .resolves.toMatchObject({ action: 'blocked', reason: expect.stringContaining('provider occupancy') });

    const malformed = await packageFixture('malformed-package');
    const malformedMapping = await captureLocalPackageMapping({ kind: 'package', id: malformed.id, root: malformed.packageRoot });
    await addPackage({ bazframeHome: malformed.home }, malformed.packageRoot);
    await writeFile(join(malformed.home, 'packages', `${malformed.id}.json`), '{}\n');
    await expect(classifyLocalPackageImportResource(malformed.home, malformed.id, malformedMapping))
      .resolves.toEqual({ action: 'blocked', reason: 'Local package malformed-package state could not be verified safely.' });

    const broken = await packageFixture('broken-package');
    const brokenMapping = await captureLocalPackageMapping({ kind: 'package', id: broken.id, root: broken.packageRoot });
    await addPackage({ bazframeHome: broken.home }, broken.packageRoot);
    const record = await readPackage(broken.home, broken.id);
    const snapshotRoot = join(broken.home, 'skill-snapshots', 'sha256', record.digest);
    const artifactRoot = join(snapshotRoot, 'artifact');
    await chmod(snapshotRoot, 0o700);
    await chmod(artifactRoot, 0o700);
    await chmod(join(artifactRoot, 'skills'), 0o700);
    await chmod(join(artifactRoot, 'skills', broken.id), 0o700);
    await rm(artifactRoot, { recursive: true });
    await expect(classifyLocalPackageImportResource(broken.home, broken.id, brokenMapping))
      .resolves.toEqual({ action: 'blocked', reason: 'Local package broken-package state could not be verified safely.' });
  });

  it('fails closed on mapped-root identity or package-manifest substitution', async () => {
    const identity = await packageFixture('identity-change');
    const identityMapping = await captureLocalPackageMapping({ kind: 'package', id: identity.id, root: identity.packageRoot });
    const moved = join(identity.root, 'moved-package');
    await rename(identity.packageRoot, moved);
    await writePackageSource(identity.packageRoot, identity.id);
    await expect(assertLocalPackageMappingSnapshot(identityMapping))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_CHANGED' });
    await expect(classifyLocalPackageImportResource(identity.home, identity.id, identityMapping))
      .resolves.toMatchObject({ action: 'blocked' });

    const manifestIdentity = await packageFixture('manifest-identity-change');
    const manifestIdentityMapping = await captureLocalPackageMapping({
      kind: 'package', id: manifestIdentity.id, root: manifestIdentity.packageRoot
    });
    const manifestIdentityPath = join(manifestIdentity.packageRoot, 'bazframe-package.json');
    const identicalManifestBytes = await readFile(manifestIdentityPath);
    await rename(manifestIdentityPath, join(manifestIdentity.root, 'original-package-manifest.json'));
    await writeFile(manifestIdentityPath, identicalManifestBytes);
    const replacedManifestMapping = await captureLocalPackageMapping({
      kind: 'package', id: manifestIdentity.id, root: manifestIdentity.packageRoot
    });
    expect(await readFile(manifestIdentityPath)).toEqual(identicalManifestBytes);
    expect(replacedManifestMapping.manifestSnapshot.contentSha256)
      .toBe(manifestIdentityMapping.manifestSnapshot.contentSha256);
    expect(replacedManifestMapping.manifestSnapshot.inode)
      .not.toBe(manifestIdentityMapping.manifestSnapshot.inode);
    await expect(assertLocalPackageMappingSnapshot(manifestIdentityMapping))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_CHANGED' });

    const manifest = await packageFixture('manifest-change');
    const manifestMapping = await captureLocalPackageMapping({ kind: 'package', id: manifest.id, root: manifest.packageRoot });
    await writeFile(
      join(manifest.packageRoot, 'bazframe-package.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        build: [process.execPath, '-e', 'void 1'],
        artifactRoot: 'dist',
        skillsRoot: 'skills'
      }, null, 2)}\n`
    );
    await expect(assertLocalPackageMappingSnapshot(manifestMapping))
      .rejects.toMatchObject({ code: 'PROFILE_IMPORT_MAPPING_CHANGED' });
    await expect(classifyLocalPackageImportResource(manifest.home, manifest.id, manifestMapping))
      .resolves.toMatchObject({ action: 'blocked' });
  });

  it('keeps same-ID library and package mappings and provider namespaces independent', async () => {
    const f = await fixture('shared-id');
    const packageRoot = join(f.root, 'package-sources', f.id);
    await writePackageSource(packageRoot, f.id);
    const canonicalPackageRoot = await realpath(packageRoot);
    const libraryMapping = await captureLocalLibraryMapping({ kind: 'library', id: f.id, root: f.library });
    const packageMapping = await captureLocalPackageMapping({ kind: 'package', id: f.id, root: canonicalPackageRoot });

    await addLibrary({ bazframeHome: f.home }, f.library);
    await expect(classifyLocalPackageImportResource(f.home, f.id, packageMapping)).resolves.toEqual({ action: 'create' });
    await addPackage({ bazframeHome: f.home }, canonicalPackageRoot);
    await expect(classifyLocalLibraryImportResource(f.home, f.id, libraryMapping)).resolves.toMatchObject({ action: 'reuse' });
    await expect(classifyLocalPackageImportResource(f.home, f.id, packageMapping)).resolves.toMatchObject({ action: 'reuse' });

    await mkdir(managedGitCheckoutRoot(f.home, 'library', 'package-only-provider'), { recursive: true });
    const packageOnly = await packageFixture('package-only-provider');
    const packageOnlyRoot = join(f.root, 'package-provider-test', packageOnly.id);
    await writePackageSource(packageOnlyRoot, packageOnly.id);
    const packageOnlyMapping = await captureLocalPackageMapping({
      kind: 'package', id: packageOnly.id, root: await realpath(packageOnlyRoot)
    });
    await expect(classifyLocalPackageImportResource(f.home, packageOnly.id, packageOnlyMapping))
      .resolves.toEqual({ action: 'create' });
  });
});
