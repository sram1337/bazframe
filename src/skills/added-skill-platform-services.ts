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
  WindowsSecurityObservation
} from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { withWindowsOperationLock } from '../state/win32-operation-lock.js';
import {
  admitWindowsPrivateDirectory,
  createWindowsPrivateDirectory,
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
  /** Digest of the exact root inspection and complete direct-entry observations. */
  identity: string;
}

export type AddedSkillLinkState =
  | { kind: 'absent'; identity: string }
  | {
      kind: 'current';
      /** Usable drive-absolute junction spelling, not canonical authority. */
      targetPath: string;
      /** Native canonical physical target bound to the exact target identity. */
      canonicalTargetPath: string;
      identity: string;
    };

/**
 * Narrow internal product seam for the healthy local added-Skill lifecycle.
 * Supplying it never bypasses the public Windows platform gate.
 */
export interface AddedSkillPlatformServices {
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

/** Internal construction seam used by native conformance; public dispatch does not import it. */
export function createWindowsAddedSkillPlatformServicesForInternalTesting(
  backend: BazframeWin32NativeBackend & BazframeWin32LockBackend
): AddedSkillPlatformServices {
  return {
    async withLock(lockPath, details, operation) {
      const lockRootPath = win32.dirname(lockPath);
      const lockComponent = win32.basename(lockPath);
      if (!isValidWindowsPathComponent(lockComponent)) {
        throw failure('WINDOWS_ADDED_SKILL_LOCK_INVALID', 'The internal Windows added-Skill lock path is invalid.');
      }
      return withWindowsOperationLock({ backend, lockRootPath, lockComponent, details }, async (authority) => {
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
      return directoryProof(admitWindowsPrivateDirectory(backend, path));
    },

    ensurePrivateDirectory(parentPath, component) {
      if (!isValidWindowsPathComponent(component)) {
        throw failure('WINDOWS_ADDED_SKILL_DIRECTORY_INVALID', 'The internal Windows added-Skill directory name is invalid.');
      }
      const childPath = win32.join(parentPath, component);
      try {
        return directoryProof(admitWindowsPrivateDirectory(backend, childPath));
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
      const { names, entries, identity } = await enumerateWindowsPrivateDirectory(backend, path, maxEntries);
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
          const parent = admitWindowsPrivateDirectory(backend, parentPath);
          return { kind: 'absent', identity: `absent:${inspectionIdentity(parent)}:${skillId}` };
        }
        throw error;
      }
      let targetPath: string;
      try {
        targetPath = normalizeNodeJunctionTarget(await readlink(membershipPath));
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
          const parent = admitWindowsPrivateDirectory(backend, parentPath);
          return { kind: 'absent', identity: `absent:${inspectionIdentity(parent)}:${skillId}` };
        }
        throw error;
      }
    },

    async createSkillLink(authority, parentPath, skillId, targetPath) {
      authority.assertHeld();
      const created = await createWindowsSkillMembership({ backend, parentPath, skillId, targetPath });
      authority.assertHeld();
      return created.action;
    },

    async removeSkillLink(authority, parentPath, skillId, targetPath) {
      authority.assertHeld();
      const removed = await removeWindowsSkillMembership({ backend, parentPath, skillId, targetPath });
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
      proof.link.normalizedTarget,
      securityIdentity(proof.link.security)
    ].join(':')
  };
}

function inspectionIdentity(value: WindowsPathInspection): string {
  return createHash('sha256')
    .update('bazframe-added-skill-inspection-v1\0')
    .update(JSON.stringify(exactInspection(value)))
    .digest('hex');
}

function exactInspection(value: WindowsPathInspection) {
  return {
    canonicalPath: value.canonicalPath,
    kind: value.kind,
    ancestryReparseFree: value.ancestryReparseFree,
    volume: {
      identity: value.volume.identity,
      filesystemName: value.volume.filesystemName,
      driveType: value.volume.driveType,
      canonicalVolumeGuidPath: value.volume.canonicalVolumeGuidPath,
      remoteDevice: value.volume.remoteDevice
    },
    object: exactObject(value.object),
    security: {
      descriptorControl: value.security.descriptorControl,
      daclPresent: value.security.daclPresent,
      daclNull: value.security.daclNull,
      daclDefaulted: value.security.daclDefaulted,
      daclBytesBase64: value.security.daclBytes.toString('base64'),
      ownerSid: value.security.ownerSid,
      ownerDefaulted: value.security.ownerDefaulted,
      groupSid: value.security.groupSid,
      groupDefaulted: value.security.groupDefaulted,
      currentUserSid: value.security.currentUserSid
    }
  };
}

function exactObject(value: WindowsObjectObservation) {
  return {
    volumeIdentity: value.volumeIdentity,
    fileId: value.fileId,
    size: value.size,
    allocationSize: value.allocationSize,
    numberOfLinks: value.numberOfLinks,
    creationTime: value.creationTime,
    lastAccessTime: value.lastAccessTime,
    lastWriteTime: value.lastWriteTime,
    changeTime: value.changeTime,
    attributes: value.attributes,
    reparseTag: value.reparseTag,
    deletePending: value.deletePending,
    directory: value.directory
  };
}

function securityIdentity(value: WindowsSecurityObservation): string {
  return createHash('sha256')
    .update(JSON.stringify(exactInspectionSecurity(value)))
    .digest('hex');
}

function exactInspectionSecurity(value: WindowsSecurityObservation) {
  return {
    descriptorControl: value.descriptorControl,
    daclPresent: value.daclPresent,
    daclNull: value.daclNull,
    daclDefaulted: value.daclDefaulted,
    daclBytesBase64: value.daclBytes.toString('base64'),
    ownerSid: value.ownerSid,
    ownerDefaulted: value.ownerDefaulted,
    groupSid: value.groupSid,
    groupDefaulted: value.groupDefaulted,
    currentUserSid: value.currentUserSid
  };
}

function requireSameDirectory(left: WindowsPathInspection, right: WindowsPathInspection): void {
  if (left.kind !== 'directory' || right.kind !== 'directory') changed();
  requireSameInspection(left, right);
}

function requireSameInspection(left: WindowsPathInspection, right: WindowsPathInspection): void {
  if (JSON.stringify(exactInspection(left)) !== JSON.stringify(exactInspection(right))) changed();
}

function requireSameObject(left: WindowsObjectObservation, right: WindowsObjectObservation): void {
  if (left.volumeIdentity !== right.volumeIdentity || left.fileId !== right.fileId
    || left.directory !== right.directory || left.reparseTag !== right.reparseTag
    || left.numberOfLinks !== right.numberOfLinks || left.size !== right.size
    || left.allocationSize !== right.allocationSize
    || left.creationTime !== right.creationTime || left.lastAccessTime !== right.lastAccessTime
    || left.changeTime !== right.changeTime || left.lastWriteTime !== right.lastWriteTime
    || left.attributes !== right.attributes || left.deletePending !== right.deletePending) changed();
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
export async function enumerateWindowsPrivateDirectory(backend: BazframeWin32NativeBackend, path: string, maxEntries: number): Promise<AddedSkillDirectoryEnumeration & { nativeEntries: WindowsDirectoryEntryObservation[]; inspection: WindowsPathInspection }> {
  const before = admitWindowsPrivateDirectory(backend, path);
  const receipt = await backend.enumerateStableDirectory(path, maxEntries);
  requireSameDirectory(before, receipt.directoryBefore);
  requireSameDirectory(receipt.directoryBefore, receipt.directoryAfter);
  const after = admitWindowsPrivateDirectory(backend, path);
  requireSameDirectory(receipt.directoryAfter, after);
  const entries = [...receipt.entries].sort((left, right) => compare(left.name, right.name));
  const names = entries.map((entry) => entry.name);
  if (names.length > maxEntries || new Set(names.map(portableKey)).size !== names.length) {
    throw failure('WINDOWS_ADDED_SKILL_NAMESPACE_INVALID', 'The internal Windows added-Skill namespace is ambiguous.');
  }
  const closure = {
    root: exactInspection(after),
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
      .update('bazframe-added-skill-direct-directory-v1\0')
      .update(JSON.stringify(closure))
      .digest('hex')
  };
}
