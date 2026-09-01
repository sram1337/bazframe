import { basename } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  readPackageManifest,
  samePackageManifestSnapshot,
  type PackageManifestSnapshot
} from '../packages/package-manifest.js';
import { classifyManagedGitProviderOccupancy } from '../providers/managed-git.js';
import { resolveGlobalSkillCollection } from '../skill-collections/skill-collection-resolver.js';
import {
  readCollectionSnapshot,
  sameCollectionSnapshot,
  type LibraryRecord,
  type PackageRecord,
  type SkillCollectionKind,
  type SkillCollectionRecordSnapshot
} from '../skill-collections/skill-collection-store.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import {
  assertReadOnlyPathAnchor,
  closeReadOnlyPathAnchor,
  holdReadOnlyPathAnchor
} from '../state/read-only-path-anchor.js';

export type LocalCollectionMappingInput =
  | { kind: 'library'; id: string; root: string }
  | { kind: 'package'; id: string; root: string };

/** Stage 2 compatibility alias. */
export interface ProfileImportMappingInput {
  kind: 'library';
  id: string;
  root: string;
}

interface LocalCollectionMappingSnapshotBase {
  kind: SkillCollectionKind;
  id: string;
  root: string;
  device: bigint;
  inode: bigint;
}

export interface LocalLibraryMappingSnapshot extends LocalCollectionMappingSnapshotBase {
  kind: 'library';
}

export interface LocalPackageMappingSnapshot extends LocalCollectionMappingSnapshotBase {
  kind: 'package';
  /** Private import evidence retained for addPackage authorization and revalidation. */
  manifestSnapshot: PackageManifestSnapshot;
}

export type LocalCollectionMappingSnapshot = LocalLibraryMappingSnapshot | LocalPackageMappingSnapshot;

type MappingSnapshotFor<K extends SkillCollectionKind> = K extends 'library'
  ? LocalLibraryMappingSnapshot
  : LocalPackageMappingSnapshot;

export interface LocalLibraryHealthSnapshot {
  mapping: LocalLibraryMappingSnapshot;
  collectionSnapshot: SkillCollectionRecordSnapshot<LibraryRecord>;
}

export interface LocalPackageHealthSnapshot {
  mapping: LocalPackageMappingSnapshot;
  collectionSnapshot: SkillCollectionRecordSnapshot<PackageRecord>;
}

export type LocalCollectionHealthSnapshot = LocalLibraryHealthSnapshot | LocalPackageHealthSnapshot;
type HealthSnapshotFor<K extends SkillCollectionKind> = K extends 'library'
  ? LocalLibraryHealthSnapshot
  : LocalPackageHealthSnapshot;

export type LocalCollectionImportResourceClassification<K extends SkillCollectionKind = SkillCollectionKind> =
  | { action: 'create' }
  | { action: 'reuse'; health: HealthSnapshotFor<K> }
  | { action: 'blocked'; reason: string };

export type LocalCollectionImportOutcomeClassification<K extends SkillCollectionKind = SkillCollectionKind> =
  | { state: 'exact'; health: HealthSnapshotFor<K> }
  | { state: 'absent' }
  | { state: 'ambiguous'; reason: string };

/** Stage 2 compatibility aliases. */
export type LocalLibraryImportResourceClassification = LocalCollectionImportResourceClassification<'library'>;
export type LocalLibraryImportOutcomeClassification = LocalCollectionImportOutcomeClassification<'library'>;

export async function captureLocalCollectionMapping<K extends SkillCollectionKind>(
  mapping: { kind: K; id: string; root: string }
): Promise<MappingSnapshotFor<K>> {
  if (!isSafeSkillId(mapping.id)) throw invalidMappingRoot(mapping.kind, mapping.id);
  let anchor;
  try {
    anchor = await holdReadOnlyPathAnchor(mapping.root);
  } catch (cause) {
    throw invalidMappingRoot(mapping.kind, mapping.id, cause);
  }
  let result: LocalCollectionMappingSnapshot | undefined;
  let failure: unknown;
  try {
    if (anchor.firstAbsentPath !== undefined) {
      throw new BazframeError(
        'PROFILE_IMPORT_MAPPING_INVALID',
        `Mapped ${mapping.kind} ${mapping.id} root does not exist.`
      );
    }
    if (basename(anchor.path) !== mapping.id) {
      throw new BazframeError(
        'PROFILE_IMPORT_MAPPING_INVALID',
        `Mapped ${mapping.kind} root basename must equal ${mapping.id}.`
      );
    }
    try {
      await assertReadOnlyPathAnchor(anchor);
    } catch (cause) {
      throw invalidMappingRoot(mapping.kind, mapping.id, cause);
    }
    if (mapping.kind === 'package') {
      let manifestSnapshot: PackageManifestSnapshot;
      try {
        manifestSnapshot = freezePackageManifestSnapshot(await readPackageManifest(anchor.path));
        await assertReadOnlyPathAnchor(anchor);
      } catch (cause) {
        throw invalidMappingRoot(mapping.kind, mapping.id, cause);
      }
      result = {
        kind: 'package',
        id: mapping.id,
        root: anchor.path,
        device: anchor.ancestor.device,
        inode: anchor.ancestor.inode,
        manifestSnapshot
      };
    } else {
      result = {
        kind: 'library',
        id: mapping.id,
        root: anchor.path,
        device: anchor.ancestor.device,
        inode: anchor.ancestor.inode
      };
    }
  } catch (error) {
    failure = error;
  }
  try {
    await closeReadOnlyPathAnchor(anchor);
  } catch (cause) {
    failure ??= invalidMappingRoot(mapping.kind, mapping.id, cause);
  }
  if (failure !== undefined) throw failure;
  return result! as MappingSnapshotFor<K>;
}

export function captureLocalLibraryMapping(
  mapping: ProfileImportMappingInput
): Promise<LocalLibraryMappingSnapshot> {
  return captureLocalCollectionMapping(mapping);
}

export function captureLocalPackageMapping(
  mapping: Extract<LocalCollectionMappingInput, { kind: 'package' }>
): Promise<LocalPackageMappingSnapshot> {
  return captureLocalCollectionMapping(mapping);
}

export async function assertLocalCollectionMappingSnapshot<K extends SkillCollectionKind>(
  expected: MappingSnapshotFor<K>
): Promise<MappingSnapshotFor<K>> {
  let current: LocalCollectionMappingSnapshot;
  try {
    current = expected.kind === 'library'
      ? await captureLocalCollectionMapping({ kind: 'library', id: expected.id, root: expected.root })
      : await captureLocalCollectionMapping({ kind: 'package', id: expected.id, root: expected.root });
  } catch (cause) {
    throw changedMappingRoot(expected.kind, expected.id, cause);
  }
  if (!sameLocalCollectionMappingSnapshot(expected, current)) {
    throw changedMappingRoot(expected.kind, expected.id);
  }
  return current as MappingSnapshotFor<K>;
}

export async function assertLocalLibraryMappingSnapshot(
  expected: LocalLibraryMappingSnapshot
): Promise<LocalLibraryMappingSnapshot> {
  return await assertLocalCollectionMappingSnapshot<'library'>(expected);
}

export async function assertLocalPackageMappingSnapshot(
  expected: LocalPackageMappingSnapshot
): Promise<LocalPackageMappingSnapshot> {
  return await assertLocalCollectionMappingSnapshot<'package'>(expected);
}

export function sameLocalCollectionMappingSnapshot(
  left: LocalCollectionMappingSnapshot,
  right: LocalCollectionMappingSnapshot
): boolean {
  if (left.kind !== right.kind
    || left.id !== right.id
    || left.root !== right.root
    || left.device !== right.device
    || left.inode !== right.inode) return false;
  return left.kind === 'library'
    || (right.kind === 'package'
      && samePackageManifestSnapshot(left.manifestSnapshot, right.manifestSnapshot));
}

export function sameLocalLibraryMappingSnapshot(
  left: LocalLibraryMappingSnapshot,
  right: LocalLibraryMappingSnapshot
): boolean {
  return sameLocalCollectionMappingSnapshot(left, right);
}

export function sameLocalPackageMappingSnapshot(
  left: LocalPackageMappingSnapshot,
  right: LocalPackageMappingSnapshot
): boolean {
  return sameLocalCollectionMappingSnapshot(left, right);
}

export function sameLocalCollectionHealth(
  left: LocalCollectionHealthSnapshot,
  right: LocalCollectionHealthSnapshot
): boolean {
  return sameLocalCollectionMappingSnapshot(left.mapping, right.mapping)
    && left.collectionSnapshot.path === right.collectionSnapshot.path
    && sameCollectionSnapshot(left.collectionSnapshot, right.collectionSnapshot);
}

export function sameLocalLibraryHealth(
  left: LocalLibraryHealthSnapshot,
  right: LocalLibraryHealthSnapshot
): boolean {
  return sameLocalCollectionHealth(left, right);
}

export function sameLocalPackageHealth(
  left: LocalPackageHealthSnapshot,
  right: LocalPackageHealthSnapshot
): boolean {
  return sameLocalCollectionHealth(left, right);
}

export async function classifyLocalCollectionImportResource<K extends SkillCollectionKind>(
  home: string,
  id: string,
  mapping: MappingSnapshotFor<K>
): Promise<LocalCollectionImportResourceClassification<K>> {
  try {
    const exact = await classifyLocalCollectionImportOutcome(home, id, mapping);
    if (exact.state === 'exact') return { action: 'reuse', health: exact.health };
    if (exact.state === 'absent') return { action: 'create' };
    return { action: 'blocked', reason: exact.reason };
  } catch {
    return { action: 'blocked', reason: safeReason(mapping.kind, id) };
  }
}

export function classifyLocalLibraryImportResource(
  home: string,
  id: string,
  mapping: LocalLibraryMappingSnapshot
): Promise<LocalLibraryImportResourceClassification> {
  return classifyLocalCollectionImportResource<'library'>(home, id, mapping);
}

export function classifyLocalPackageImportResource(
  home: string,
  id: string,
  mapping: LocalPackageMappingSnapshot
): Promise<LocalCollectionImportResourceClassification<'package'>> {
  return classifyLocalCollectionImportResource<'package'>(home, id, mapping);
}

export async function classifyLocalCollectionImportOutcome<K extends SkillCollectionKind>(
  home: string,
  id: string,
  mapping: MappingSnapshotFor<K>
): Promise<LocalCollectionImportOutcomeClassification<K>> {
  const kind = mapping.kind;
  try {
    if (mapping.id !== id) {
      return { state: 'ambiguous', reason: `Mapped local ${kind} identity does not match ${id}.` };
    }
    await assertLocalCollectionMappingSnapshot(mapping);
    if (await classifyManagedGitProviderOccupancy(home, kind, id) !== 'absent') {
      return { state: 'ambiguous', reason: `${title(kind)} ${id} has remote Git provider occupancy.` };
    }
    const initial = await readOptionalCollection(home, kind, id);
    if (initial === undefined) {
      const current = await readOptionalCollection(home, kind, id);
      await assertLocalCollectionMappingSnapshot(mapping);
      if (current !== undefined || await classifyManagedGitProviderOccupancy(home, kind, id) !== 'absent') {
        return { state: 'ambiguous', reason: `Local ${kind} ${id} occupancy changed during inspection.` };
      }
      return { state: 'absent' };
    }
    if (initial.record.root !== mapping.root) {
      return { state: 'ambiguous', reason: `Local ${kind} ${id} is registered at another root.` };
    }
    await resolveGlobalSkillCollection(home, initial.record);
    const current = await readOptionalCollection(home, kind, id);
    await assertLocalCollectionMappingSnapshot(mapping);
    if (current === undefined || !sameCollectionSnapshot(initial, current)
      || current.record.root !== mapping.root
      || await classifyManagedGitProviderOccupancy(home, kind, id) !== 'absent') {
      return { state: 'ambiguous', reason: `Local ${kind} ${id} changed during inspection.` };
    }
    return {
      state: 'exact',
      health: {
        mapping: copyMapping(mapping),
        collectionSnapshot: current
      } as HealthSnapshotFor<K>
    };
  } catch {
    return { state: 'ambiguous', reason: safeReason(kind, id) };
  }
}

export function classifyLocalLibraryImportOutcome(
  home: string,
  id: string,
  mapping: LocalLibraryMappingSnapshot
): Promise<LocalLibraryImportOutcomeClassification> {
  return classifyLocalCollectionImportOutcome<'library'>(home, id, mapping);
}

export function classifyLocalPackageImportOutcome(
  home: string,
  id: string,
  mapping: LocalPackageMappingSnapshot
): Promise<LocalCollectionImportOutcomeClassification<'package'>> {
  return classifyLocalCollectionImportOutcome<'package'>(home, id, mapping);
}

async function readOptionalCollection(
  home: string,
  kind: SkillCollectionKind,
  id: string
): Promise<SkillCollectionRecordSnapshot | undefined> {
  try {
    return await readCollectionSnapshot(home, { kind, id });
  } catch (error) {
    if (error instanceof BazframeError
      && error.code === 'SKILL_COLLECTION_RECORD_READ_FAILED'
      && error.cause !== undefined
      && errorCode(error.cause) === 'ENOENT') return undefined;
    throw error;
  }
}

function copyMapping<K extends SkillCollectionKind>(mapping: MappingSnapshotFor<K>): MappingSnapshotFor<K> {
  return (mapping.kind === 'library'
    ? { ...mapping }
    : { ...mapping, manifestSnapshot: mapping.manifestSnapshot }) as MappingSnapshotFor<K>;
}

function freezePackageManifestSnapshot(snapshot: PackageManifestSnapshot): PackageManifestSnapshot {
  Object.freeze(snapshot.manifest.build);
  Object.freeze(snapshot.manifest);
  return Object.freeze(snapshot);
}

function invalidMappingRoot(kind: SkillCollectionKind, id: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'PROFILE_IMPORT_MAPPING_INVALID',
    `Mapped ${kind} ${id} root could not be validated as a stable physical directory${kind === 'package' ? ' with an exact package manifest' : ''}.`,
    cause === undefined ? {} : { cause }
  );
}

function changedMappingRoot(kind: SkillCollectionKind, id: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'PROFILE_IMPORT_MAPPING_CHANGED',
    `Mapped ${kind} ${id} root${kind === 'package' ? ' or package manifest' : ''} changed or could not be revalidated.`,
    cause === undefined ? {} : { cause }
  );
}

function safeReason(kind: SkillCollectionKind, id: string): string {
  return `Local ${kind} ${id} state could not be verified safely.`;
}

function title(kind: SkillCollectionKind): string {
  return kind === 'library' ? 'Library' : 'Package';
}
