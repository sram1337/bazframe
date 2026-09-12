import { createWindowsManagedGitRecordEffects } from '../providers/managed-git-services.js';
import { readWindowsSelectionSnapshot } from '../profiles/win32-profile-selection.js';
import { stableWindowsObjectObservation, stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { createHash } from 'node:crypto';
import { readlink } from 'node:fs/promises';
import { win32 } from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  BazframeWin32LockBackend,
  BazframeWin32NativeBackend,
  WindowsObjectObservation,
  WindowsDirectoryEntryObservation,
  WindowsPathInspection,
} from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { withWindowsOperationLock } from '../state/win32-operation-lock.js';
import {
  admitWindowsPhysicalDirectory,
  createWindowsPrivateDirectory,
  ensureWindowsPrivateDirectoryPath,
  isValidWindowsPathComponent
} from '../state/win32-private-directory.js';
import {
  createWindowsSkillMembership,
  inspectWindowsSkillMembership,
  removeWindowsSkillMembership,
  type WindowsSkillMembershipProof
} from '../state/win32-skill-membership.js';

export const ADDED_SKILL_NAMESPACE_ENTRY_LIMIT = 1024;

export interface AddedSkillLockDetails {
  command: string;
  target: string;
}

export interface AddedSkillMutationAuthority {
  assertHeld(): void;
}

export interface AddedSkillDirectoryProof {
  /** Native canonical physical path used only for identity and overlap decisions. */
  canonicalPath: string;
  identity: string;
}

export interface AddedSkillDirectoryEntryProof {
  name: string;
  directory: boolean;
  reparseTag: number | null;
}

export interface AddedSkillDirectoryEnumeration {
  names: string[];
  entries: AddedSkillDirectoryEntryProof[];
  /** Digest of the stable root inspection and complete direct-entry observations. */
  identity: string;
}

export type AddedSkillLinkState =
  | { kind: 'absent'; identity: string }
  | {
      kind: 'current';
      /** Usable drive-absolute direct-link spelling, not canonical authority. */
      targetPath: string;
      /** Native canonical physical target bound to the exact target identity. */
      canonicalTargetPath: string;
      identity: string;
    };

/**
 * Platform effects for the healthy local added-Skill lifecycle.
 */
export interface AddedSkillPlatformServices {
  /** Read-only canonical home spelling through physically admitted existing ancestry. */
  canonicalHomePath?(home: string): string;
  /** Protected bootstrap; callers must validate source and overlap before creation. */
  ensureHomePath?(home: string): void;
  assertManagedSkillLocation?(home: string, canonicalTarget: string): Promise<void>;
  joinPath?: typeof win32.join;
  resolvePath?: typeof win32.resolve;
  isAbsolutePath?: typeof win32.isAbsolute;
  selectionReadServices?: import('../profiles/profile-store.js').ActiveProfileReadServices;
  withLock<T>(
    lockPath: string,
    details: AddedSkillLockDetails,
    operation: (authority: AddedSkillMutationAuthority) => Promise<T>
  ): Promise<T>;
  inspectPhysicalDirectory(path: string): AddedSkillDirectoryProof;
  inspectPrivateDirectory(path: string): AddedSkillDirectoryProof;
  ensurePrivateDirectory(parentPath: string, component: string): AddedSkillDirectoryProof;
  enumeratePrivateDirectory(path: string, maxEntries: number): Promise<AddedSkillDirectoryEnumeration>;
  readStableUtf8File(path: string, label: string, maxBytes: number): Promise<string>;
  readSkillLink(parentPath: string, skillId: string): Promise<AddedSkillLinkState>;
  inspectSkillLink(parentPath: string, skillId: string, targetPath: string): AddedSkillLinkState;
  createSkillLink(
    authority: AddedSkillMutationAuthority,
    parentPath: string,
    skillId: string,
    targetPath: string
  ): Promise<'added' | 'current'>;
  removeSkillLink(
    authority: AddedSkillMutationAuthority,
    parentPath: string,
    skillId: string,
    targetPath: string
  ): Promise<'removed' | 'absent'>;
}

/** Shared Windows construction seam, also used by native conformance. */
export function createWindowsAddedSkillPlatformServicesForInternalTesting(
  backend: BazframeWin32NativeBackend & BazframeWin32LockBackend,
  options: { lockIo?: import('../state/win32-operation-lock.js').WindowsOperationLockIo; membershipIo?: import('../state/win32-skill-membership.js').WindowsSkillMembershipIo; readLinkPath?: (path: string) => Promise<string> } = {}
): AddedSkillPlatformServices {
  return {
    joinPath: win32.join, resolvePath: win32.resolve, isAbsolutePath: win32.isAbsolute,
    canonicalHomePath(home) {
      const missing: string[] = [];
      let cursor = home;
      for (;;) {
        try {
          const existing = admitWindowsPhysicalDirectory(backend, cursor);
          return win32.join(existing.canonicalPath, ...missing);
        } catch (error) {
          if (errorCode(error) !== 'WINDOWS_NATIVE_PATH_NOT_FOUND') throw error;
          const parent = win32.dirname(cursor);
          if (parent === cursor || !isValidWindowsPathComponent(win32.basename(cursor))) throw error;
          missing.unshift(win32.basename(cursor));
          cursor = parent;
        }
      }
    },
    ensureHomePath(home) { ensureWindowsPrivateDirectoryPath(backend, home); },
    selectionReadServices: { readSelectedProfileId: async (home) => (await readWindowsSelectionSnapshot(backend, home)).profileId },
    async assertManagedSkillLocation(home, canonicalTarget) {
      const id = win32.basename(canonicalTarget);
      const record = await createWindowsManagedGitRecordEffects(backend).readManagedGitRecord(home, 'skill', id);
      if (physicalDirectory(backend.inspectPath(record.record.root)).canonicalPath !== canonicalTarget) throw failure('WINDOWS_MANAGED_SKILL_INVALID', 'Managed Skill provenance does not prove its target.');
    },
    async withLock(lockPath, details, operation) {
      const lockRootPath = win32.dirname(lockPath);
      const lockComponent = win32.basename(lockPath);
      if (!isValidWindowsPathComponent(lockComponent)) {
        throw failure('WINDOWS_ADDED_SKILL_LOCK_INVALID', 'The internal Windows added-Skill lock path is invalid.');
      }
      return withWindowsOperationLock({ backend, lockRootPath, lockComponent, details, io: options.lockIo }, async (authority) => {
        authority.assertHeld();
        const result = await operation(authority);
        authority.assertHeld();
        return result;
      });
    },

    inspectPhysicalDirectory(path) {
      return physicalDirectory(backend.inspectPath(path));
    },

    inspectPrivateDirectory(path) {
      return directoryProof(admitWindowsPhysicalDirectory(backend, path));
    },

    ensurePrivateDirectory(parentPath, component) {
      if (!isValidWindowsPathComponent(component)) {
        throw failure('WINDOWS_ADDED_SKILL_DIRECTORY_INVALID', 'The internal Windows added-Skill directory name is invalid.');
      }
      const childPath = win32.join(parentPath, component);
      try {
        return directoryProof(admitWindowsPhysicalDirectory(backend, childPath));
      } catch (error) {
        if (errorCode(error) !== 'WINDOWS_NATIVE_PATH_NOT_FOUND') throw error;
      }
      return directoryProof(createWindowsPrivateDirectory(backend, parentPath, component));
    },

    async enumeratePrivateDirectory(path, maxEntries) {
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 0
        || maxEntries > ADDED_SKILL_NAMESPACE_ENTRY_LIMIT) {
        throw failure('WINDOWS_ADDED_SKILL_ENUMERATION_LIMIT_INVALID', 'The internal Windows added-Skill enumeration bound is invalid.');
      }
      const { names, entries, identity } = await enumerateWindowsPhysicalDirectory(backend, path, maxEntries);
      return { names, entries, identity };
    },

    async readStableUtf8File(path, label, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw failure('WINDOWS_ADDED_SKILL_READ_LIMIT_INVALID', 'The internal Windows added-Skill read bound is invalid.');
      }
      const before = backend.inspectPath(path);
      requirePhysicalFile(before);
      const receipt = await backend.readStableFile(path, maxBytes);
      requireSameObject(before.object, receipt.before);
      requireSameObject(receipt.before, receipt.after);
      if (receipt.bytes.byteLength > maxBytes
        || receipt.byteCount !== receipt.after.size
        || BigInt(receipt.bytes.byteLength) !== BigInt(`0x${receipt.byteCount}`)) {
        throw failure('WINDOWS_ADDED_SKILL_READ_CHANGED', `${label} changed while being read.`);
      }
      const after = backend.inspectPath(path);
      requirePhysicalFile(after);
      requireSameInspection(before, after);
      requireSameObject(receipt.after, after.object);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(receipt.bytes);
      } catch (error) {
        throw failure('INSTRUCTION_INVALID_UTF8', `${label} is not valid UTF-8.`, error);
      }
      if (text.includes('\0')) {
        throw failure('INSTRUCTION_CONTAINS_NUL', `${label} contains a NUL byte.`);
      }
      return text;
    },

    async readSkillLink(parentPath, skillId) {
      const membershipPath = win32.join(parentPath, skillId);
      try {
        backend.inspectMembershipLink(membershipPath);
      } catch (error) {
        if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') {
          const parent = admitWindowsPhysicalDirectory(backend, parentPath);
          return { kind: 'absent', identity: `absent:${inspectionIdentity(parent)}:${skillId}` };
        }
        throw error;
      }
      let targetPath: string;
      try {
        targetPath = normalizeNodeJunctionTarget(await (options.readLinkPath ?? readlink)(membershipPath));
      } catch (error) {
        throw failure(
          'WINDOWS_ADDED_SKILL_LINK_INVALID',
          'The internal Windows added-Skill junction target spelling is unavailable.',
          error
        );
      }
      return linkState(
        inspectWindowsSkillMembership({ backend, parentPath, skillId, targetPath }),
        targetPath
      );
    },

    inspectSkillLink(parentPath, skillId, targetPath) {
      try {
        return linkState(
          inspectWindowsSkillMembership({ backend, parentPath, skillId, targetPath }),
          targetPath
        );
      } catch (error) {
        if (errorCode(error) === 'WINDOWS_SKILL_MEMBERSHIP_ABSENT') {
          const parent = admitWindowsPhysicalDirectory(backend, parentPath);
          return { kind: 'absent', identity: `absent:${inspectionIdentity(parent)}:${skillId}` };
        }
        throw error;
      }
    },

    async createSkillLink(authority, parentPath, skillId, targetPath) {
      authority.assertHeld();
      const created = await createWindowsSkillMembership({ backend, parentPath, skillId, targetPath, io: options.membershipIo });
      authority.assertHeld();
      return created.action;
    },

    async removeSkillLink(authority, parentPath, skillId, targetPath) {
      authority.assertHeld();
      const removed = await removeWindowsSkillMembership({ backend, parentPath, skillId, targetPath, io: options.membershipIo });
      authority.assertHeld();
      if (removed.outcome === 'present') {
        throw failure(
          'WINDOWS_ADDED_SKILL_REMOVE_AMBIGUOUS',
          'The internal Windows added-Skill link remains present after removal.'
        );
      }
      return removed.effect === 'removed' ? 'removed' : 'absent';
    }
  };
}

function physicalDirectory(inspection: WindowsPathInspection): AddedSkillDirectoryProof {
  if (inspection.kind !== 'directory' || !inspection.object.directory
    || inspection.object.reparseTag !== null || inspection.object.deletePending
    || inspection.object.volumeIdentity !== inspection.volume.identity
    || !inspection.ancestryReparseFree) {
    throw failure('WINDOWS_ADDED_SKILL_TARGET_INVALID', 'The added-Skill target is not an admitted physical directory.');
  }
  return directoryProof(inspection);
}

function requirePhysicalFile(inspection: WindowsPathInspection): void {
  if (inspection.kind !== 'regular-file' || inspection.object.directory
    || inspection.object.reparseTag !== null || inspection.object.deletePending
    || inspection.object.volumeIdentity !== inspection.volume.identity
    || !inspection.ancestryReparseFree) {
    throw failure('WINDOWS_ADDED_SKILL_FILE_INVALID', 'The added-Skill file is not an admitted physical regular file.');
  }
}

function directoryProof(inspection: WindowsPathInspection): AddedSkillDirectoryProof {
  return { canonicalPath: inspection.canonicalPath, identity: inspectionIdentity(inspection) };
}

function linkState(
  proof: WindowsSkillMembershipProof,
  targetPath: string = proof.target.canonicalPath
): AddedSkillLinkState {
  return {
    kind: 'current',
    targetPath,
    canonicalTargetPath: proof.target.canonicalPath,
    identity: [
      inspectionIdentity(proof.parent),
      inspectionIdentity(proof.target),
      proof.link.object.volumeIdentity,
      proof.link.object.fileId,
      proof.link.normalizedTarget
    ].join(':')
  };
}

function inspectionIdentity(value: WindowsPathInspection): string {
  return createHash('sha256')
    .update('bazframe-added-skill-inspection-v2\0')
    .update(JSON.stringify(stableWindowsPathInspection(value)))
    .digest('hex');
}

function requireSameDirectory(left: WindowsPathInspection, right: WindowsPathInspection): void {
  if (left.kind !== 'directory' || right.kind !== 'directory') changed();
  requireSameInspection(left, right);
}

function requireSameInspection(left: WindowsPathInspection, right: WindowsPathInspection): void {
  if (JSON.stringify(stableWindowsPathInspection(left)) !== JSON.stringify(stableWindowsPathInspection(right))) changed();
}

function requireSameObject(left: WindowsObjectObservation, right: WindowsObjectObservation): void {
  if (JSON.stringify(stableWindowsObjectObservation(left)) !== JSON.stringify(stableWindowsObjectObservation(right))) changed();
}

function changed(): never {
  throw failure('WINDOWS_ADDED_SKILL_NAMESPACE_CHANGED', 'The internal Windows added-Skill namespace changed during validation.');
}

function normalizeNodeJunctionTarget(value: string): string {
  const target = value.startsWith('\\\\?\\') || value.startsWith('\\??\\')
    ? value.slice(4)
    : value;
  if (!/^[A-Za-z]:\\/u.test(target) || target.includes('\0')) {
    throw new Error('junction target is not drive-absolute');
  }
  return target;
}

function utf16Hex(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    result += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return result;
}

function portableKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function failure(code: string, message: string, cause?: unknown): BazframeError {
  return new BazframeError(code, message, cause === undefined ? undefined : { cause });
}

/** Native observation shared by bounded internal profile readers; callers own their domain ceiling. */
export async function enumerateWindowsPhysicalDirectory(backend: BazframeWin32NativeBackend, path: string, maxEntries: number): Promise<AddedSkillDirectoryEnumeration & { nativeEntries: WindowsDirectoryEntryObservation[]; inspection: WindowsPathInspection }> {
  const before = admitWindowsPhysicalDirectory(backend, path);
  const receipt = await backend.enumerateStableDirectory(path, maxEntries);
  requireSameDirectory(before, receipt.directoryBefore);
  requireSameDirectory(receipt.directoryBefore, receipt.directoryAfter);
  const after = admitWindowsPhysicalDirectory(backend, path);
  requireSameDirectory(receipt.directoryAfter, after);
  const entries = [...receipt.entries].sort((left, right) => compare(left.name, right.name));
  const names = entries.map((entry) => entry.name);
  if (names.length > maxEntries || new Set(names.map(portableKey)).size !== names.length) {
    throw failure('WINDOWS_ADDED_SKILL_NAMESPACE_INVALID', 'The internal Windows added-Skill namespace is ambiguous.');
  }
  const closure = {
    root: stableWindowsPathInspection(after),
    entries: entries.map((entry) => ({
      nameUtf16: utf16Hex(entry.name),
      volumeIdentity: after.object.volumeIdentity,
      fileId: entry.fileId,
      size: entry.size,
      allocationSize: entry.allocationSize,
      creationTime: entry.creationTime,
      lastWriteTime: entry.lastWriteTime,
      changeTime: entry.changeTime,
      attributes: entry.attributes,
      reparseTag: entry.reparseTag,
      directory: entry.directory
    }))
  };
  return {
    nativeEntries: entries, inspection: after,
    names,
    entries: entries.map((entry) => ({
      name: entry.name,
      directory: entry.directory,
      reparseTag: entry.reparseTag
    })),
    identity: createHash('sha256')
      .update('bazframe-added-skill-direct-directory-v2\0')
      .update(JSON.stringify(closure))
      .digest('hex')
  };
}
