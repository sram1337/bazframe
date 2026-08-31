import { basename } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { classifyManagedGitProviderOccupancy } from '../providers/managed-git.js';
import { resolveGlobalSkillCollection } from '../skill-collections/skill-collection-resolver.js';
import {
  readLibrarySnapshot,
  sameCollectionSnapshot,
  type LibraryRecord,
  type SkillCollectionRecordSnapshot
} from '../skill-collections/skill-collection-store.js';
import {
  assertReadOnlyPathAnchor,
  closeReadOnlyPathAnchor,
  holdReadOnlyPathAnchor
} from '../state/read-only-path-anchor.js';

export interface ProfileImportMappingInput {
  kind: 'library';
  id: string;
  root: string;
}

export interface LocalLibraryMappingSnapshot {
  kind: 'library';
  id: string;
  root: string;
  device: bigint;
  inode: bigint;
}

export interface LocalLibraryHealthSnapshot {
  mapping: LocalLibraryMappingSnapshot;
  collectionSnapshot: SkillCollectionRecordSnapshot<LibraryRecord>;
}

export type LocalLibraryImportResourceClassification =
  | { action: 'create' }
  | { action: 'reuse'; health: LocalLibraryHealthSnapshot }
  | { action: 'blocked'; reason: string };

export type LocalLibraryImportOutcomeClassification =
  | { state: 'exact'; health: LocalLibraryHealthSnapshot }
  | { state: 'absent' }
  | { state: 'ambiguous'; reason: string };

export async function captureLocalLibraryMapping(
  mapping: ProfileImportMappingInput
): Promise<LocalLibraryMappingSnapshot> {
  let anchor;
  try {
    anchor = await holdReadOnlyPathAnchor(mapping.root);
  } catch (cause) {
    throw invalidMappingRoot(mapping.id, cause);
  }
  let result: LocalLibraryMappingSnapshot | undefined;
  let failure: unknown;
  try {
    if (anchor.firstAbsentPath !== undefined) {
      throw new BazframeError('PROFILE_IMPORT_MAPPING_INVALID', `Mapped library ${mapping.id} root does not exist.`);
    }
    if (basename(anchor.path) !== mapping.id) {
      throw new BazframeError(
        'PROFILE_IMPORT_MAPPING_INVALID',
        `Mapped library root basename must equal ${mapping.id}.`
      );
    }
    try {
      await assertReadOnlyPathAnchor(anchor);
    } catch (cause) {
      throw invalidMappingRoot(mapping.id, cause);
    }
    result = {
      kind: 'library',
      id: mapping.id,
      root: anchor.path,
      device: anchor.ancestor.device,
      inode: anchor.ancestor.inode
    };
  } catch (error) {
    failure = error;
  }
  try {
    await closeReadOnlyPathAnchor(anchor);
  } catch (cause) {
    failure ??= invalidMappingRoot(mapping.id, cause);
  }
  if (failure !== undefined) throw failure;
  return result!;
}

export async function assertLocalLibraryMappingSnapshot(
  expected: LocalLibraryMappingSnapshot
): Promise<LocalLibraryMappingSnapshot> {
  let current: LocalLibraryMappingSnapshot;
  try {
    current = await captureLocalLibraryMapping({ kind: 'library', id: expected.id, root: expected.root });
  } catch (cause) {
    throw changedMappingRoot(expected.id, cause);
  }
  if (!sameLocalLibraryMappingSnapshot(expected, current)) {
    throw changedMappingRoot(expected.id);
  }
  return current;
}

export function sameLocalLibraryMappingSnapshot(
  left: LocalLibraryMappingSnapshot,
  right: LocalLibraryMappingSnapshot
): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && left.root === right.root
    && left.device === right.device
    && left.inode === right.inode;
}

export function sameLocalLibraryHealth(
  left: LocalLibraryHealthSnapshot,
  right: LocalLibraryHealthSnapshot
): boolean {
  return sameLocalLibraryMappingSnapshot(left.mapping, right.mapping)
    && left.collectionSnapshot.path === right.collectionSnapshot.path
    && sameCollectionSnapshot(left.collectionSnapshot, right.collectionSnapshot);
}

export async function classifyLocalLibraryImportResource(
  home: string,
  id: string,
  mapping: LocalLibraryMappingSnapshot
): Promise<LocalLibraryImportResourceClassification> {
  try {
    const exact = await classifyLocalLibraryImportOutcome(home, id, mapping);
    if (exact.state === 'exact') return { action: 'reuse', health: exact.health };
    if (exact.state === 'absent') return { action: 'create' };
    return { action: 'blocked', reason: exact.reason };
  } catch {
    return { action: 'blocked', reason: safeReason(id) };
  }
}

export async function classifyLocalLibraryImportOutcome(
  home: string,
  id: string,
  mapping: LocalLibraryMappingSnapshot
): Promise<LocalLibraryImportOutcomeClassification> {
  try {
    await assertLocalLibraryMappingSnapshot(mapping);
    if (await classifyManagedGitProviderOccupancy(home, 'library', id) !== 'absent') {
      return { state: 'ambiguous', reason: `Library ${id} has remote Git provider occupancy.` };
    }
    const initial = await readOptionalLibrary(home, id);
    if (initial === undefined) {
      const current = await readOptionalLibrary(home, id);
      await assertLocalLibraryMappingSnapshot(mapping);
      if (current !== undefined || await classifyManagedGitProviderOccupancy(home, 'library', id) !== 'absent') {
        return { state: 'ambiguous', reason: `Local library ${id} occupancy changed during inspection.` };
      }
      return { state: 'absent' };
    }
    if (initial.record.root !== mapping.root) {
      return { state: 'ambiguous', reason: `Local library ${id} is registered at another root.` };
    }
    await resolveGlobalSkillCollection(home, initial.record);
    const current = await readOptionalLibrary(home, id);
    await assertLocalLibraryMappingSnapshot(mapping);
    if (current === undefined || !sameCollectionSnapshot(initial, current)
      || current.record.root !== mapping.root
      || await classifyManagedGitProviderOccupancy(home, 'library', id) !== 'absent') {
      return { state: 'ambiguous', reason: `Local library ${id} changed during inspection.` };
    }
    return { state: 'exact', health: { mapping: { ...mapping }, collectionSnapshot: current } };
  } catch {
    return { state: 'ambiguous', reason: safeReason(id) };
  }
}

async function readOptionalLibrary(
  home: string,
  id: string
): Promise<SkillCollectionRecordSnapshot<LibraryRecord> | undefined> {
  try {
    return await readLibrarySnapshot(home, id);
  } catch (error) {
    if (error instanceof BazframeError
      && error.code === 'SKILL_COLLECTION_RECORD_READ_FAILED'
      && error.cause !== undefined
      && errorCode(error.cause) === 'ENOENT') return undefined;
    throw error;
  }
}

function invalidMappingRoot(id: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'PROFILE_IMPORT_MAPPING_INVALID',
    `Mapped library ${id} root could not be validated as a stable physical directory.`,
    cause === undefined ? {} : { cause }
  );
}

function changedMappingRoot(id: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'PROFILE_IMPORT_MAPPING_CHANGED',
    `Mapped library ${id} root changed or could not be revalidated.`,
    cause === undefined ? {} : { cause }
  );
}

function safeReason(id: string): string {
  return `Local library ${id} state could not be verified safely.`;
}
