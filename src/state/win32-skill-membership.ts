import { unlink } from 'node:fs/promises';
import { win32 } from 'node:path';
import type {
  BazframeWin32NativeBackend,
  WindowsMembershipLinkInspection,
  WindowsPathInspection,
  WindowsPrivateJunctionCreationReceipt,
  WindowsSecurityObservation
} from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import {
  admitWindowsPrivateDirectory,
  assertWindowsOwnerPrivateSecurity,
  isValidWindowsPathComponent
} from './win32-private-directory.js';

export interface WindowsSkillMembershipIo {
  createJunction?(
    backend: BazframeWin32NativeBackend,
    parentPath: string,
    skillId: string,
    targetPath: string
  ): WindowsPrivateJunctionCreationReceipt | Promise<WindowsPrivateJunctionCreationReceipt>;
  unlink?(path: string): Promise<void>;
}

export interface WindowsSkillMembershipOptions {
  backend: BazframeWin32NativeBackend;
  parentPath: string;
  skillId: string;
  targetPath: string;
  io?: WindowsSkillMembershipIo;
}

export interface WindowsSkillMembershipProof {
  membershipPath: string;
  parent: WindowsPathInspection;
  target: WindowsPathInspection;
  link: WindowsMembershipLinkInspection;
}

export type WindowsSkillMembershipCreation = {
  action: 'added' | 'current';
  proof: WindowsSkillMembershipProof;
};

export type WindowsSkillMembershipRemoval =
  | { outcome: 'absent'; effect: 'already-absent' | 'removed' }
  | { outcome: 'present'; proof: WindowsSkillMembershipProof };

const defaultCreateJunction: NonNullable<WindowsSkillMembershipIo['createJunction']> = (
  backend,
  parentPath,
  skillId,
  targetPath
) => backend.createPrivateJunction(parentPath, skillId, targetPath);

const defaultUnlink: NonNullable<WindowsSkillMembershipIo['unlink']> = (path) => unlink(path);

/** Internal Windows composition seam. It does not bypass the public platform gate. */
export function inspectWindowsSkillMembership(
  options: WindowsSkillMembershipOptions
): WindowsSkillMembershipProof {
  const inputs = validateOptions(options);
  const state = inspectState(options.backend, inputs);
  if (state.kind === 'absent') {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_ABSENT',
      'The Windows Skill membership is absent.'
    );
  }
  return revalidateProof(options.backend, inputs, state.proof);
}

/** Creates exactly one no-replace directory junction and proves its direct target. */
export async function createWindowsSkillMembership(
  options: WindowsSkillMembershipOptions
): Promise<WindowsSkillMembershipCreation> {
  const inputs = validateOptions(options);
  const initial = inspectState(options.backend, inputs);
  if (initial.kind === 'present') {
    return { action: 'current', proof: revalidateProof(options.backend, inputs, initial.proof) };
  }

  const beforeParent = admitWindowsPrivateDirectory(options.backend, inputs.parentPath);
  const beforeTarget = inspectTarget(options.backend, inputs.targetPath);
  requireSameParent(inputs.parent, beforeParent);
  requireSameTarget(inputs.target, beforeTarget);

  let mutationReceipt: WindowsPrivateJunctionCreationReceipt | undefined;
  let mutationError: unknown;
  try {
    mutationReceipt = await (options.io?.createJunction ?? defaultCreateJunction)(
      options.backend,
      inputs.parentPath,
      inputs.skillId,
      inputs.targetPath
    );
  } catch (error) {
    mutationError = error;
  }

  try {
    const afterParent = admitWindowsPrivateDirectory(options.backend, inputs.parentPath);
    const afterTarget = inspectTarget(options.backend, inputs.targetPath);
    requireSameParent(beforeParent, afterParent);
    requireSameTarget(beforeTarget, afterTarget);
    if (mutationReceipt !== undefined) {
      requireSameParent(beforeParent, mutationReceipt.parentBefore);
      requireSameParent(mutationReceipt.parentBefore, mutationReceipt.parentAfter);
      const receiptProof = prove({
        ...inputs,
        parent: mutationReceipt.parentAfter,
        target: beforeTarget
      }, mutationReceipt.created);
      requireSameParent(mutationReceipt.parentAfter, afterParent);
      requireSameTarget(receiptProof.target, afterTarget);
    }
    const after = inspectState(options.backend, {
      ...inputs,
      parent: afterParent,
      target: afterTarget
    });
    if (after.kind === 'present') {
      const proof = revalidateProof(options.backend, inputs, after.proof);
      if (mutationReceipt !== undefined && !sameLink(mutationReceipt.created, proof.link)) {
        throw new Error('created membership differs from the native creation receipt');
      }
      return { action: 'added', proof };
    }
    if (mutationError !== undefined) {
      throw failure(
        'WINDOWS_SKILL_MEMBERSHIP_CREATE_FAILED',
        'The Windows Skill membership was not created and the namespace remained unchanged.',
        mutationError
      );
    }
    throw new Error('junction creation reported success but the membership is absent');
  } catch (error) {
    if (error instanceof BazframeError
      && error.code === 'WINDOWS_SKILL_MEMBERSHIP_CREATE_FAILED') throw error;
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_CREATE_AMBIGUOUS',
      'The Windows Skill membership creation outcome is ambiguous; inspect the retained namespace before retrying.',
      error
    );
  }
}

/** Removes only the proved membership pathname and reconciles the final namespace. */
export async function removeWindowsSkillMembership(
  options: WindowsSkillMembershipOptions
): Promise<WindowsSkillMembershipRemoval> {
  const inputs = validateOptions(options);
  const initial = inspectState(options.backend, inputs);
  if (initial.kind === 'absent') {
    return { outcome: 'absent', effect: 'already-absent' };
  }
  const before = revalidateProof(options.backend, inputs, initial.proof);

  let mutationError: unknown;
  try {
    await (options.io?.unlink ?? defaultUnlink)(inputs.membershipPath);
  } catch (error) {
    mutationError = error;
  }

  try {
    const afterParent = admitWindowsPrivateDirectory(options.backend, inputs.parentPath);
    const afterTarget = inspectTarget(options.backend, inputs.targetPath);
    requireSameParent(before.parent, afterParent);
    requireSameTarget(before.target, afterTarget);
    const after = inspectState(options.backend, {
      ...inputs,
      parent: afterParent,
      target: afterTarget
    });
    if (after.kind === 'absent') {
      return { outcome: 'absent', effect: 'removed' };
    }
    const proof = revalidateProof(options.backend, inputs, after.proof);
    if (mutationError !== undefined && sameLink(before.link, proof.link)) {
      return { outcome: 'present', proof };
    }
    throw new Error('membership remained or changed after unlink');
  } catch (error) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_REMOVE_AMBIGUOUS',
      'The Windows Skill membership removal outcome is ambiguous; the target was not removed.',
      error
    );
  }
}

interface ValidatedInputs {
  parentPath: string;
  skillId: string;
  targetPath: string;
  membershipPath: string;
  parent: WindowsPathInspection;
  target: WindowsPathInspection;
}

type MembershipState =
  | { kind: 'absent' }
  | { kind: 'present'; proof: WindowsSkillMembershipProof };

function validateOptions(options: WindowsSkillMembershipOptions): ValidatedInputs {
  if (!isDriveAbsolute(options.parentPath) || !isDriveAbsolute(options.targetPath)) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_PATH_INVALID',
      'Windows Skill membership paths must be drive-absolute without NUL bytes.'
    );
  }
  if (!isSafeSkillId(options.skillId) || !isValidWindowsPathComponent(options.skillId)) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_NAME_INVALID',
      'The Windows Skill membership name is invalid or reserved.'
    );
  }
  const parent = admitWindowsPrivateDirectory(options.backend, options.parentPath);
  const target = inspectTarget(options.backend, options.targetPath);
  return {
    parentPath: options.parentPath,
    skillId: options.skillId,
    targetPath: options.targetPath,
    membershipPath: win32.join(options.parentPath, options.skillId),
    parent,
    target
  };
}

function inspectState(
  backend: BazframeWin32NativeBackend,
  inputs: ValidatedInputs
): MembershipState {
  let link: WindowsMembershipLinkInspection;
  try {
    link = backend.inspectMembershipLink(inputs.membershipPath);
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return { kind: 'absent' };
    throw error;
  }
  const proof = prove(inputs, link);
  return { kind: 'present', proof };
}

function prove(
  inputs: ValidatedInputs,
  link: WindowsMembershipLinkInspection
): WindowsSkillMembershipProof {
  const expectedPath = canonicalChild(inputs.parent.canonicalPath, inputs.skillId);
  try {
    assertWindowsOwnerPrivateSecurity(
      link.security,
      inputs.parent.security.currentUserSid
    );
  } catch (error) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_LINK_SECURITY_INVALID',
      'The Windows Skill membership link is not owner-private for the admitted parent user.',
      error
    );
  }
  if (link.canonicalPath.toLowerCase() !== expectedPath.toLowerCase()
    || link.volume.identity !== inputs.parent.volume.identity
    || link.object.volumeIdentity !== inputs.parent.volume.identity
    || link.normalizedTarget.toLowerCase() !== inputs.target.canonicalPath.toLowerCase()
    || link.targetVolumeIdentity !== inputs.target.object.volumeIdentity
    || link.targetFileId !== inputs.target.object.fileId) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_INVALID',
      'The Windows Skill membership does not directly reference the expected physical target.'
    );
  }
  return {
    membershipPath: inputs.membershipPath,
    parent: inputs.parent,
    target: inputs.target,
    link
  };
}

function revalidateProof(
  backend: BazframeWin32NativeBackend,
  inputs: ValidatedInputs,
  expected: WindowsSkillMembershipProof
): WindowsSkillMembershipProof {
  const parent = admitWindowsPrivateDirectory(backend, inputs.parentPath);
  const target = inspectTarget(backend, inputs.targetPath);
  requireSameParent(expected.parent, parent);
  requireSameTarget(expected.target, target);
  const link = backend.inspectMembershipLink(inputs.membershipPath);
  const proof = prove({ ...inputs, parent, target }, link);
  if (!sameLink(expected.link, proof.link)) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_CHANGED',
      'The Windows Skill membership changed during immediate revalidation.'
    );
  }
  return proof;
}

function inspectTarget(
  backend: BazframeWin32NativeBackend,
  path: string
): WindowsPathInspection {
  const target = backend.inspectPath(path);
  if (target.kind !== 'directory' || !target.object.directory
    || target.object.reparseTag !== null || target.object.deletePending
    || target.object.volumeIdentity !== target.volume.identity
    || target.ancestryReparseFree !== true) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_TARGET_INVALID',
      'The Windows Skill membership target is not an admitted physical directory.'
    );
  }
  return target;
}

function requireSameParent(
  before: WindowsPathInspection,
  after: WindowsPathInspection
): void {
  if (!sameDirectory(before, after) || !sameSecurity(before.security, after.security)) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_PARENT_CHANGED',
      'The Windows Skill membership parent changed during revalidation.'
    );
  }
}

function requireSameTarget(
  before: WindowsPathInspection,
  after: WindowsPathInspection
): void {
  if (!sameDirectory(before, after)) {
    throw failure(
      'WINDOWS_SKILL_MEMBERSHIP_TARGET_CHANGED',
      'The Windows Skill membership target changed during revalidation.'
    );
  }
}

function sameDirectory(left: WindowsPathInspection, right: WindowsPathInspection): boolean {
  return left.canonicalPath.toLowerCase() === right.canonicalPath.toLowerCase()
    && left.kind === 'directory' && right.kind === 'directory'
    && left.volume.identity === right.volume.identity
    && left.object.volumeIdentity === right.object.volumeIdentity
    && left.object.fileId === right.object.fileId
    && left.object.reparseTag === null && right.object.reparseTag === null
    && !left.object.deletePending && !right.object.deletePending
    && left.object.directory && right.object.directory;
}

function sameLink(
  left: WindowsMembershipLinkInspection,
  right: WindowsMembershipLinkInspection
): boolean {
  return left.canonicalPath.toLowerCase() === right.canonicalPath.toLowerCase()
    && left.volume.identity === right.volume.identity
    && left.object.volumeIdentity === right.object.volumeIdentity
    && left.object.fileId === right.object.fileId
    && left.object.size === right.object.size
    && left.object.allocationSize === right.object.allocationSize
    && left.object.numberOfLinks === right.object.numberOfLinks
    && left.object.creationTime === right.object.creationTime
    && left.object.lastWriteTime === right.object.lastWriteTime
    && left.object.changeTime === right.object.changeTime
    && left.object.attributes === right.object.attributes
    && left.object.reparseTag === right.object.reparseTag
    && left.object.deletePending === right.object.deletePending
    && left.object.directory === right.object.directory
    && sameSecurity(left.security, right.security)
    && left.normalizedTarget.toLowerCase() === right.normalizedTarget.toLowerCase()
    && left.targetVolumeIdentity === right.targetVolumeIdentity
    && left.targetFileId === right.targetFileId;
}

function sameSecurity(
  left: WindowsSecurityObservation,
  right: WindowsSecurityObservation
): boolean {
  return left.descriptorControl === right.descriptorControl
    && left.daclPresent === right.daclPresent
    && left.daclNull === right.daclNull
    && left.daclDefaulted === right.daclDefaulted
    && left.daclBytes.equals(right.daclBytes)
    && left.ownerSid === right.ownerSid
    && left.ownerDefaulted === right.ownerDefaulted
    && left.groupSid === right.groupSid
    && left.groupDefaulted === right.groupDefaulted
    && left.currentUserSid === right.currentUserSid;
}

function canonicalChild(parent: string, component: string): string {
  return `${parent}${parent.endsWith('\\') ? '' : '\\'}${component}`;
}

function isDriveAbsolute(path: string): boolean {
  return typeof path === 'string' && /^[A-Za-z]:\\/u.test(path) && !path.includes('\0');
}

function failure(code: string, message: string, cause?: unknown): BazframeError {
  return new BazframeError(code, message, cause === undefined ? undefined : { cause });
}
