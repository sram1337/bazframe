import { execFileSync } from 'node:child_process';
import { appendFile, link, lstat, mkdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectManagedGitAcquisition,
  inspectManagedGitPublishedCheckout,
  sampleManagedGitAcquisitionInProgress
} from '../../../src/providers/managed-git-acquisition-inspection.js';
import {
  managedGitAcquisitionLimitPolicy,
  type ManagedGitAcquisitionLimitPolicy
} from '../../../src/profile-portability/profile-portability-policy.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const temporaryDirectories: TempDirectory[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((item) => item.cleanup())));

async function fixture(): Promise<{ temporary: TempDirectory; container: string; root: string }> {
  const temporary = await createTempDirectory('bazframe-git-acquisition-inspection-');
  temporaryDirectories.push(temporary);
  const container = temporary.path('container');
  const root = join(container, 'toolkit');
  await mkdir(join(root, '.git', 'objects'), { recursive: true });
  return { temporary, container, root };
}

function policy(overrides: Partial<ManagedGitAcquisitionLimitPolicy> = {}): Readonly<ManagedGitAcquisitionLimitPolicy> {
  return managedGitAcquisitionLimitPolicy({
    maxGitObjectBytes: 1024,
    maxCheckoutEntries: 32,
    maxCheckoutDepth: 8,
    maxCheckoutPathBytes: 128,
    maxCheckoutFileBytes: 128,
    maxCheckoutAggregateBytes: 512,
    maxStagingEntries: 64,
    maxStagingDepth: 16,
    maxStagingPathBytes: 256,
    maxStagingBytes: 1024,
    ...overrides
  });
}

describe('managed Git acquisition inspection', () => {
  it('accepts exact limits and rejects one above entry, file, aggregate, and staging limits', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'a'), '12');
    await writeFile(join(f.root, 'b'), '345');
    const exact = policy({ maxCheckoutEntries: 3, maxCheckoutFileBytes: 3, maxCheckoutAggregateBytes: 5, maxStagingBytes: 5 });
    await expect(inspectManagedGitAcquisition(f.container, f.root, exact)).resolves.toMatchObject({ checkoutEntries: 3, checkoutBytes: 5, stagingEntries: 5, stagingBytes: 5 });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxCheckoutEntries: 2 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxCheckoutEntries: 0 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxCheckoutFileBytes: 2 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxCheckoutAggregateBytes: 4 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxStagingBytes: 4 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
  });

  it('enforces checkout depth and UTF-8 relative path bytes at exact boundaries', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'deep'));
    await writeFile(join(f.root, 'deep', 'x'), 'x');
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxCheckoutDepth: 2, maxCheckoutPathBytes: 6 }))).resolves.toBeDefined();
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxCheckoutDepth: 1 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxCheckoutPathBytes: 5 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
  });

  it('enforces total staging entry, depth, and UTF-8 path ceilings across Git metadata', async () => {
    const f = await fixture();
    await mkdir(join(f.root, '.git', 'meta'));
    await writeFile(join(f.root, '.git', 'meta', 'é'), 'x');
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({
      maxStagingEntries: 5,
      maxStagingDepth: 3,
      maxStagingPathBytes: 12
    }))).resolves.toMatchObject({ stagingEntries: 5 });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxStagingEntries: 4 })))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxStagingDepth: 2 })))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxStagingPathBytes: 11 })))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
  });

  it('enforces Git object bytes and staging aggregate independently', async () => {
    const f = await fixture();
    await writeFile(join(f.root, '.git', 'objects', 'pack'), '1234');
    await writeFile(join(f.root, 'work'), '12');
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxGitObjectBytes: 4, maxStagingBytes: 6 }))).resolves.toMatchObject({ gitObjectBytes: 4, stagingBytes: 6 });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxGitObjectBytes: 3 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxStagingBytes: 5 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
  });

  it('case-folds the Git objects namespace for exact and one-above object-byte accounting', async () => {
    const f = await fixture();
    await rename(join(f.root, '.git', 'objects'), join(f.root, '.git', 'ObJeCtS'));
    await writeFile(join(f.root, '.git', 'ObJeCtS', 'pack'), '1234');
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxGitObjectBytes: 4 })))
      .resolves.toMatchObject({ gitObjectBytes: 4 });
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy({ maxGitObjectBytes: 3 })))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
  });

  it('rejects Git common-directory, linked-worktree, nested-repository, and hard-link indirection', async () => {
    if (process.platform === 'win32') return;
    const common = await fixture();
    await writeFile(join(common.root, '.git', 'commondir'), '../../outside');
    await expect(inspectManagedGitAcquisition(common.container, common.root, policy()))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const linkedWorktree = await fixture();
    await rm(join(linkedWorktree.root, '.git'), { recursive: true });
    await writeFile(join(linkedWorktree.root, '.git'), 'gitdir: /outside/worktree\n');
    await expect(inspectManagedGitAcquisition(linkedWorktree.container, linkedWorktree.root, policy()))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const worktreeRegistry = await fixture();
    await mkdir(join(worktreeRegistry.root, '.git', 'worktrees'));
    await expect(inspectManagedGitAcquisition(worktreeRegistry.container, worktreeRegistry.root, policy()))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const nested = await fixture();
    await mkdir(join(nested.root, '.git', 'modules'));
    await expect(inspectManagedGitAcquisition(nested.container, nested.root, policy()))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const nestedCheckout = await fixture();
    await mkdir(join(nestedCheckout.root, 'child', '.git'), { recursive: true });
    await expect(inspectManagedGitAcquisition(nestedCheckout.container, nestedCheckout.root, policy()))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const hardLinked = await fixture();
    await writeFile(join(hardLinked.root, 'source'), 'x');
    await link(join(hardLinked.root, 'source'), join(hardLinked.root, 'alias'));
    await expect(inspectManagedGitAcquisition(hardLinked.container, hardLinked.root, policy()))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
  });

  it.each([
    ['.git/CommonDir', 'file'],
    ['.git/GitDir', 'file'],
    ['.git/WorkTrees', 'directory'],
    ['.git/Modules', 'directory'],
    ['.git/Info/Grafts', 'file'],
    ['.git/Refs/Replace', 'directory'],
    ['.git/Objects/Info/Alternates', 'file'],
    ['.git/Objects/Info/Http-Alternates', 'file']
  ] as const)('conservatively rejects case-variant reserved Git metadata path %s', async (relativePath, kind) => {
    const f = await fixture();
    const path = join(f.root, ...relativePath.split('/'));
    if (kind === 'directory') await mkdir(path, { recursive: true });
    else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'outside\n');
    }
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy()))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
  });

  it('rejects linked Git metadata and object alternates without following worktree links', async () => {
    if (process.platform === 'win32') return;
    const linked = await fixture();
    await mkdir(linked.temporary.path('outside'));
    await symlink(linked.temporary.path('outside'), join(linked.root, '.git', 'linked'));
    await expect(inspectManagedGitAcquisition(linked.container, linked.root, policy())).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const alternate = await fixture();
    await mkdir(join(alternate.root, '.git', 'objects', 'info'));
    await writeFile(join(alternate.root, '.git', 'objects', 'info', 'alternates'), '/outside\n');
    await expect(inspectManagedGitAcquisition(alternate.container, alternate.root, policy())).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const worktree = await fixture();
    await writeFile(worktree.temporary.path('target'), 'outside');
    await symlink(worktree.temporary.path('target'), join(worktree.root, 'link'));
    await expect(inspectManagedGitAcquisition(worktree.container, worktree.root, policy())).resolves.toMatchObject({ checkoutEntries: 2 });
  });

  it('rejects concurrent growth, root substitution, special files, and unexpected container occupancy', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'file'), 'a');
    await expect(inspectManagedGitAcquisition(f.container, f.root, policy(), {
      afterFirstInspection: async () => { await appendFile(join(f.root, 'file'), 'b'); }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_CHANGED' });

    const substituted = await fixture();
    const displaced = substituted.temporary.path('displaced');
    await expect(inspectManagedGitAcquisition(substituted.container, substituted.root, policy(), {
      afterFirstInspection: async () => {
        await rename(substituted.root, displaced);
        await mkdir(join(substituted.root, '.git', 'objects'), { recursive: true });
      }
    })).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_CHANGED' });

    if (process.platform !== 'win32') {
      const special = await fixture();
      execFileSync('mkfifo', [join(special.root, 'pipe')]);
      await expect(inspectManagedGitAcquisition(special.container, special.root, policy())).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
    }

    const occupied = await fixture();
    await writeFile(join(occupied.container, 'extra'), 'x');
    await expect(inspectManagedGitAcquisition(occupied.container, occupied.root, policy())).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
  });

  it('samples absent, exact-boundary, and above-boundary in-progress acquisition state', async () => {
    const temporary = await createTempDirectory('bazframe-git-acquisition-live-');
    temporaryDirectories.push(temporary);
    const container = temporary.path('container');
    const root = join(container, 'toolkit');
    await mkdir(container);
    const containerMetadata = await lstat(container, { bigint: true });
    const identity = { device: containerMetadata.dev, inode: containerMetadata.ino };
    await expect(sampleManagedGitAcquisitionInProgress(container, root, policy(), identity)).resolves.toBeUndefined();
    await mkdir(join(root, '.git', 'objects'), { recursive: true });
    await writeFile(join(root, 'file'), '123');
    await expect(sampleManagedGitAcquisitionInProgress(
      container,
      root,
      policy({ maxCheckoutEntries: 2, maxCheckoutFileBytes: 3, maxCheckoutAggregateBytes: 3, maxStagingBytes: 3 }),
      identity
    )).resolves.toBeUndefined();
    await expect(sampleManagedGitAcquisitionInProgress(
      container,
      root,
      policy({ maxCheckoutFileBytes: 2 }),
      identity
    )).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });

    if (process.platform !== 'win32') {
      const probe = join(root, '.git', 'tAb12Z9');
      await symlink('testing', probe);
      await expect(sampleManagedGitAcquisitionInProgress(container, root, policy(), identity)).resolves.toBeUndefined();
      await expect(inspectManagedGitAcquisition(container, root, policy()))
        .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
      await unlink(probe);
      await symlink('../outside', join(root, '.git', 'other-link'));
      await expect(sampleManagedGitAcquisitionInProgress(container, root, policy(), identity))
        .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });
    }
  });

  it('rejects observed hostile live entries and container substitution without following links', async () => {
    if (process.platform === 'win32') return;
    const linkedRoot = await createTempDirectory('bazframe-git-acquisition-live-link-');
    temporaryDirectories.push(linkedRoot);
    const linkedContainer = linkedRoot.path('container');
    const external = linkedRoot.path('external');
    const linkedCheckout = join(linkedContainer, 'toolkit');
    await mkdir(linkedContainer);
    await mkdir(external);
    await writeFile(join(external, 'foreign'), 'do not follow');
    await symlink(external, linkedCheckout);
    const linkedMetadata = await lstat(linkedContainer, { bigint: true });
    await expect(sampleManagedGitAcquisitionInProgress(
      linkedContainer,
      linkedCheckout,
      policy(),
      { device: linkedMetadata.dev, inode: linkedMetadata.ino }
    )).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const hardLinked = await fixture();
    const containerMetadata = await lstat(hardLinked.container, { bigint: true });
    const identity = { device: containerMetadata.dev, inode: containerMetadata.ino };
    await writeFile(join(hardLinked.root, 'source'), 'x');
    await link(join(hardLinked.root, 'source'), join(hardLinked.root, 'alias'));
    await expect(sampleManagedGitAcquisitionInProgress(hardLinked.container, hardLinked.root, policy(), identity))
      .rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const special = await fixture();
    const specialMetadata = await lstat(special.container, { bigint: true });
    execFileSync('mkfifo', [join(special.root, 'pipe')]);
    await expect(sampleManagedGitAcquisitionInProgress(
      special.container,
      special.root,
      policy(),
      { device: specialMetadata.dev, inode: specialMetadata.ino }
    )).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const reserved = await fixture();
    const reservedMetadata = await lstat(reserved.container, { bigint: true });
    await writeFile(join(reserved.root, '.git', 'commondir'), '../outside');
    await expect(sampleManagedGitAcquisitionInProgress(
      reserved.container,
      reserved.root,
      policy(),
      { device: reservedMetadata.dev, inode: reservedMetadata.ino }
    )).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_INVALID' });

    const substituted = await fixture();
    const substitutedMetadata = await lstat(substituted.container, { bigint: true });
    await rename(substituted.container, `${substituted.container}.moved`);
    await mkdir(substituted.container);
    await expect(sampleManagedGitAcquisitionInProgress(
      substituted.container,
      substituted.root,
      policy(),
      { device: substitutedMetadata.dev, inode: substitutedMetadata.ino }
    )).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_CHANGED' });
  });

  it('rechecks published checkout limits without requiring its former container', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'file'), '123');
    await expect(inspectManagedGitPublishedCheckout(f.root, policy({ maxCheckoutFileBytes: 3 }))).resolves.toMatchObject({ checkoutBytes: 3 });
    await expect(inspectManagedGitPublishedCheckout(f.root, policy({ maxCheckoutFileBytes: 2 }))).rejects.toMatchObject({ code: 'MANAGED_GIT_ACQUISITION_LIMIT' });
  });
});
