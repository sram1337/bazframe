import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalLibraryMappingSnapshot,
  captureLocalLibraryMapping,
  classifyLocalLibraryImportOutcome,
  classifyLocalLibraryImportResource,
  sameLocalLibraryHealth
} from '../../../src/profile-portability/profile-import-local-library.js';
import { managedGitCheckoutRoot } from '../../../src/providers/managed-git-record.js';
import { addLibrary } from '../../../src/skill-collections/skill-collection-lifecycle.js';
import { readLibrary } from '../../../src/skill-collections/skill-collection-store.js';
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
