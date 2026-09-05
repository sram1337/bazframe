import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type {
  BazframeWin32NativeBackend,
  WindowsDirectoryEntryObservation,
  WindowsObjectObservation,
  WindowsPathInspection,
  WindowsSecurityObservation,
  WindowsStableDirectoryEnumerationReceipt
} from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import {
  admitWindowsPrivateDirectory,
  admitWindowsPrivateFile,
  isValidWindowsPathComponent
} from './win32-private-directory.js';

const FILE_ATTRIBUTE_DEVICE = 0x40;
const FILE_ATTRIBUTE_OFFLINE = 0x1000;
const FILE_ATTRIBUTE_VIRTUAL = 0x1_0000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x4_0000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x40_0000;
const UNSUPPORTED_ATTRIBUTES = FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_OFFLINE
  | FILE_ATTRIBUTE_VIRTUAL | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

export interface WindowsDirectoryClosurePolicy {
  maxEntries: number;
  maxDepth: number;
  maxPathBytes: number;
  maxFileBytes: number;
  maxAggregateBytes: number;
}

export const WINDOWS_DIRECTORY_CLOSURE_PRODUCTION_POLICY: Readonly<WindowsDirectoryClosurePolicy>
  = Object.freeze({
    maxEntries: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries,
    maxDepth: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingDepth,
    maxPathBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingPathBytes,
    maxFileBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.checkoutFileBytes,
    maxAggregateBytes: PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingBytes
  });

export type WindowsDirectoryClosureEntryV1 =
  | { path: string; kind: 'directory'; volumeIdentity: string; fileId: string }
  | {
      path: string;
      kind: 'file';
      volumeIdentity: string;
      fileId: string;
      sha256: string;
      bytes: number;
    };

export interface WindowsDirectoryClosureV1 {
  schemaVersion: 1;
  root: { volumeIdentity: string; fileId: string };
  entries: WindowsDirectoryClosureEntryV1[];
}

export interface WindowsDirectoryClosureExpectation {
  rootIdentity: string;
  closureSha256: string;
  closure: WindowsDirectoryClosureV1;
}

export interface WindowsDirectoryClosureHooks {
  beforeSecondPass?: () => void | Promise<void>;
}

type Traversal = {
  entries: WindowsDirectoryClosureEntryV1[];
  paths: Set<string>;
  entryCount: number;
  aggregateBytes: number;
};

/** Internal composition seam. It does not bypass the public Windows gate. */
export async function captureWindowsDirectoryClosure(
  backend: BazframeWin32NativeBackend,
  rootPath: string,
  lowerLimits: Partial<WindowsDirectoryClosurePolicy> = {},
  hooks: WindowsDirectoryClosureHooks = {}
): Promise<WindowsDirectoryClosureExpectation> {
  const policy = windowsDirectoryClosurePolicy(lowerLimits);
  const initialRoot = admitWindowsPrivateDirectory(backend, rootPath);
  const first = await capturePass(backend, rootPath, initialRoot, policy);
  await hooks.beforeSecondPass?.();
  const second = await capturePass(backend, rootPath, initialRoot, policy);
  if (first.canonical !== second.canonical) {
    throw changed('directory contents changed between closure passes');
  }
  const finalRoot = admitWindowsPrivateDirectory(backend, rootPath);
  if (!sameDirectoryInspection(initialRoot, finalRoot)) {
    throw changed('directory root or private ancestry changed while capturing its closure',
      comparisonDiagnostic('initial-vs-final-root', 'directory', directoryDifferences(initialRoot, finalRoot)));
  }
  const rootIdentity = identity(initialRoot.object);
  return {
    rootIdentity,
    closureSha256: createHash('sha256')
      .update('bazframe-win32-directory-closure-v1\0')
      .update(second.canonical)
      .digest('hex'),
    closure: second.closure
  };
}

export function windowsDirectoryClosurePolicy(
  lowerLimits: Partial<WindowsDirectoryClosurePolicy> = {}
): Readonly<WindowsDirectoryClosurePolicy> {
  if (!isPlainRecord(lowerLimits)) throw policyInvalid('policy must be a plain data object');
  for (const key of Object.keys(lowerLimits)) {
    if (!(key in WINDOWS_DIRECTORY_CLOSURE_PRODUCTION_POLICY)) {
      throw policyInvalid(`${key} is unknown`);
    }
  }
  const policy = { ...WINDOWS_DIRECTORY_CLOSURE_PRODUCTION_POLICY, ...lowerLimits };
  for (const key of Object.keys(
    WINDOWS_DIRECTORY_CLOSURE_PRODUCTION_POLICY
  ) as Array<keyof WindowsDirectoryClosurePolicy>) {
    const value = policy[key];
    const maximum = WINDOWS_DIRECTORY_CLOSURE_PRODUCTION_POLICY[key];
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw policyInvalid(`${key} must be a finite nonnegative integer`);
    }
    if (value > maximum) throw policyInvalid(`${key} may lower but must not raise the production limit`);
  }
  return Object.freeze(policy);
}

async function capturePass(
  backend: BazframeWin32NativeBackend,
  rootPath: string,
  expectedRoot: WindowsPathInspection,
  policy: Readonly<WindowsDirectoryClosurePolicy>
): Promise<{ closure: WindowsDirectoryClosureV1; canonical: string }> {
  const traversal: Traversal = {
    entries: [],
    paths: new Set(),
    entryCount: 0,
    aggregateBytes: 0
  };
  await walkDirectory(backend, rootPath, '', 0, expectedRoot, policy, traversal);
  traversal.entries.sort((left, right) => compare(left.path, right.path));
  const closure: WindowsDirectoryClosureV1 = {
    schemaVersion: 1,
    root: {
      volumeIdentity: expectedRoot.object.volumeIdentity,
      fileId: expectedRoot.object.fileId
    },
    entries: traversal.entries
  };
  return { closure, canonical: `${JSON.stringify(closure, null, 2)}\n` };
}

async function walkDirectory(
  backend: BazframeWin32NativeBackend,
  path: string,
  relativePrefix: string,
  depth: number,
  expectedDirectory: WindowsPathInspection,
  policy: Readonly<WindowsDirectoryClosurePolicy>,
  traversal: Traversal
): Promise<void> {
  if (depth > policy.maxDepth) throw limit('directory closure exceeds its depth limit');
  const remaining = policy.maxEntries - traversal.entryCount;
  let receipt: WindowsStableDirectoryEnumerationReceipt;
  try {
    receipt = await backend.enumerateStableDirectory(path, remaining);
  } catch (error) {
    throw mapEnumerationFailure(error);
  }
  requireSameDirectory(expectedDirectory, receipt.directoryBefore, 'expected-vs-enumeration-before');
  requireSameDirectory(receipt.directoryBefore, receipt.directoryAfter, 'enumeration-before-vs-after');

  const relativePaths = new Map<WindowsDirectoryEntryObservation, string>();
  for (const entry of receipt.entries) {
    traversal.entryCount += 1;
    if (traversal.entryCount > policy.maxEntries) {
      throw limit('directory closure exceeds its entry limit');
    }
    if (!isValidWindowsPathComponent(entry.name)) {
      throw invalid('directory closure contains an invalid or reserved Windows component');
    }
    const relativePath = relativePrefix === '' ? entry.name : `${relativePrefix}/${entry.name}`;
    if (Buffer.byteLength(relativePath, 'utf8') > policy.maxPathBytes) {
      throw limit('directory closure path exceeds its byte limit');
    }
    const collisionKey = portableKey(relativePath);
    if (traversal.paths.has(collisionKey)) {
      throw invalid('directory closure contains a Windows or portable path collision');
    }
    traversal.paths.add(collisionKey);
    relativePaths.set(entry, relativePath);
    if (entry.reparseTag !== null) {
      throw invalid('directory closure contains an unsupported reparse entry');
    }
    if ((entry.attributes & UNSUPPORTED_ATTRIBUTES) !== 0) {
      throw invalid('directory closure contains an unsupported special or offline entry');
    }
  }

  for (const entry of receipt.entries) {
    const relativePath = relativePaths.get(entry)!;
    const childPath = win32.join(path, entry.name);
    if (entry.directory) {
      let child: WindowsPathInspection;
      try {
        child = admitWindowsPrivateDirectory(backend, childPath);
      } catch (error) {
        if (errorCode(error) === 'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED') {
          throw invalid('listed directory is not owner-private', error);
        }
        throw changed('listed directory could not be admitted after enumeration', error);
      }
      requireDirectChild(receipt.directoryBefore, child, entry.name);
      requireEntryMatchesObject(entry, child.object, 'entry-vs-directory-open');
      traversal.entries.push({
        path: relativePath,
        kind: 'directory',
        volumeIdentity: child.object.volumeIdentity,
        fileId: child.object.fileId
      });
      await walkDirectory(
        backend,
        childPath,
        relativePath,
        depth + 1,
        child,
        policy,
        traversal
      );
      continue;
    }

    let inspected: WindowsPathInspection;
    try {
      inspected = admitWindowsPrivateFile(backend, childPath);
    } catch (error) {
      if (errorCode(error) === 'WINDOWS_PRIVATE_FILE_PRIVACY_UNPROVED') {
        throw invalid('listed file is not an owner-private single-link regular file', error);
      }
      throw changed('listed file could not be admitted after enumeration', error);
    }
    requireDirectChild(receipt.directoryBefore, inspected, entry.name);
    requireEntryMatchesObject(entry, inspected.object, 'entry-vs-file-open');
    const size = hexToBoundedNumber(entry.size);
    if (size > policy.maxFileBytes) throw limit('directory closure file exceeds its byte limit');
    const remainingBytes = policy.maxAggregateBytes - traversal.aggregateBytes;
    if (size > remainingBytes) throw limit('directory closure exceeds its aggregate byte limit');
    let stable;
    try {
      stable = await backend.readStableFile(childPath, Math.min(policy.maxFileBytes, remainingBytes));
    } catch (error) {
      throw changed('directory closure file could not be read with its listed state', error);
    }
    requireEntryMatchesObject(entry, stable.before, 'entry-vs-file-read-before');
    requireEntryMatchesObject(entry, stable.after, 'entry-vs-file-read-after');
    if (!sameObject(inspected.object, stable.before)
      || !sameObject(stable.before, stable.after)
      || stable.bytes.byteLength !== size) {
      throw changed('directory closure file identity or size changed while reading');
    }
    let afterRead: WindowsPathInspection;
    try {
      afterRead = admitWindowsPrivateFile(backend, childPath);
    } catch (error) {
      throw changed('directory closure file privacy or identity changed while reading', error);
    }
    requireDirectChild(receipt.directoryBefore, afterRead, entry.name);
    requireEntryMatchesObject(entry, afterRead.object, 'entry-vs-file-final-open');
    if (!sameObject(stable.after, afterRead.object)
      || !sameSecurity(inspected.security, afterRead.security)) {
      throw changed('directory closure file security changed while reading');
    }
    traversal.aggregateBytes += stable.bytes.byteLength;
    traversal.entries.push({
      path: relativePath,
      kind: 'file',
      volumeIdentity: stable.after.volumeIdentity,
      fileId: stable.after.fileId,
      sha256: createHash('sha256').update(stable.bytes).digest('hex'),
      bytes: stable.bytes.byteLength
    });
  }

  let after: WindowsStableDirectoryEnumerationReceipt;
  try {
    after = await backend.enumerateStableDirectory(path, receipt.entries.length);
  } catch (error) {
    throw changed('directory entries changed after their closure was read', error);
  }
  if (!sameEnumeration(receipt, after)) {
    throw changed('directory entries changed after their closure was read',
      comparisonDiagnostic('initial-vs-final-enumeration', 'directory', enumerationDifferences(receipt, after)));
  }
}

function requireSameDirectory(
  a: WindowsPathInspection, b: WindowsPathInspection, comparison: ClosureComparison
): void {
  if (!sameDirectoryInspection(a, b)) throw changed('directory identity or metadata changed',
    comparisonDiagnostic(comparison, 'directory', directoryDifferences(a, b)));
}

function sameDirectoryInspection(a: WindowsPathInspection, b: WindowsPathInspection): boolean {
  return a.canonicalPath.toLowerCase() === b.canonicalPath.toLowerCase()
    && a.kind === 'directory' && b.kind === 'directory'
    && a.volume.identity === b.volume.identity
    && sameObject(a.object, b.object)
    && sameSecurity(a.security, b.security);
}

export function requireDirectChild(
  parent: WindowsPathInspection,
  child: WindowsPathInspection,
  component: string
): void {
  const separator = parent.canonicalPath.endsWith('\\') ? '' : '\\';
  if (child.object.volumeIdentity !== parent.object.volumeIdentity
    || child.canonicalPath.toLowerCase()
      !== `${parent.canonicalPath}${separator}${component}`.toLowerCase()) {
    throw changed('listed child no longer resolves to the enumerated direct child');
  }
}

export function requireEntryMatchesObject(
  entry: WindowsDirectoryEntryObservation,
  object: WindowsObjectObservation,
  comparison: ClosureComparison
): void {
  // NTFS enumeration lengths (FILE_ID_EXTD_DIR_INFO) and opened-directory
  // lengths (FILE_STANDARD_INFO) are distinct observation domains. Only files
  // authorize cross-domain length equality; both sources retain full independent
  // stability checks, and their receipts are never normalized.
  const compareLengths = !entry.directory || !object.directory;
  if (entry.fileId !== object.fileId
    || (compareLengths && entry.size !== object.size)
    || (compareLengths && entry.allocationSize !== object.allocationSize)
    || entry.creationTime !== object.creationTime
    || entry.lastWriteTime !== object.lastWriteTime
    || entry.changeTime !== object.changeTime
    || entry.attributes !== object.attributes
    || entry.reparseTag !== object.reparseTag
    || entry.directory !== object.directory
    || object.deletePending) {
    throw changed('listed child identity or metadata changed before it was consumed', comparisonDiagnostic(
      comparison, object.directory ? 'directory' : 'file',
      [...ENTRY_OBJECT_FIELDS.filter((field) => entry[field] !== object[field]
        && (compareLengths || (field !== 'size' && field !== 'allocationSize'))),
        ...(object.deletePending ? ['deletePending'] : [])]
    ));
  }
}

function sameEnumeration(
  a: WindowsStableDirectoryEnumerationReceipt,
  b: WindowsStableDirectoryEnumerationReceipt
): boolean {
  return sameDirectoryInspection(a.directoryBefore, b.directoryBefore)
    && sameDirectoryInspection(a.directoryAfter, b.directoryAfter)
    && JSON.stringify(a.entries) === JSON.stringify(b.entries);
}

function sameObject(a: WindowsObjectObservation, b: WindowsObjectObservation): boolean {
  return a.volumeIdentity === b.volumeIdentity
    && a.fileId === b.fileId
    && a.size === b.size
    && a.allocationSize === b.allocationSize
    && a.numberOfLinks === b.numberOfLinks
    && a.creationTime === b.creationTime
    && a.lastWriteTime === b.lastWriteTime
    && a.changeTime === b.changeTime
    && a.attributes === b.attributes
    && a.reparseTag === b.reparseTag
    && a.deletePending === b.deletePending
    && a.directory === b.directory;
}

function sameSecurity(a: WindowsSecurityObservation, b: WindowsSecurityObservation): boolean {
  return a.descriptorControl === b.descriptorControl
    && a.daclPresent === b.daclPresent
    && a.daclNull === b.daclNull
    && a.daclDefaulted === b.daclDefaulted
    && a.daclBytes.equals(b.daclBytes)
    && a.ownerSid === b.ownerSid
    && a.ownerDefaulted === b.ownerDefaulted
    && a.groupSid === b.groupSid
    && a.groupDefaulted === b.groupDefaulted
    && a.currentUserSid === b.currentUserSid;
}

// Diagnostics run only after the unchanged authorization comparisons fail.
// Enumerate static field names; never include observed values or entry names.
const ENTRY_OBJECT_FIELDS = [
  'fileId', 'size', 'allocationSize', 'creationTime', 'lastWriteTime',
  'changeTime', 'attributes', 'reparseTag', 'directory'
] as const;
const OBJECT_FIELDS = [
  'volumeIdentity', ...ENTRY_OBJECT_FIELDS, 'numberOfLinks', 'deletePending'
] as const;
const SECURITY_FIELDS = [
  'descriptorControl', 'daclPresent', 'daclNull', 'daclDefaulted', 'ownerSid',
  'ownerDefaulted', 'groupSid', 'groupDefaulted', 'currentUserSid'
] as const;
type ClosureComparison =
  | 'initial-vs-final-root' | 'expected-vs-enumeration-before' | 'enumeration-before-vs-after'
  | 'entry-vs-directory-open' | 'entry-vs-file-open' | 'entry-vs-file-read-before'
  | 'entry-vs-file-read-after' | 'entry-vs-file-final-open' | 'initial-vs-final-enumeration';

function comparisonDiagnostic(comparison: ClosureComparison, objectKind: 'directory' | 'file', differingFields: string[]): BazframeError {
  return Object.assign(new BazframeError('WINDOWS_DIRECTORY_CLOSURE_COMPARISON', comparison), {
    objectKind, differingFields
  });
}

function directoryDifferences(a: WindowsPathInspection, b: WindowsPathInspection): string[] {
  return [
    ...(a.canonicalPath.toLowerCase() !== b.canonicalPath.toLowerCase() ? ['canonicalPath'] : []),
    ...(a.kind !== 'directory' || b.kind !== 'directory' ? ['kind'] : []),
    ...(a.volume.identity !== b.volume.identity ? ['volume.identity'] : []),
    ...OBJECT_FIELDS.filter((field) => a.object[field] !== b.object[field]).map((field) => `object.${field}`),
    ...SECURITY_FIELDS.filter((field) => a.security[field] !== b.security[field]).map((field) => `security.${field}`),
    ...(!a.security.daclBytes.equals(b.security.daclBytes) ? ['security.daclBytes'] : [])
  ];
}

function enumerationDifferences(a: WindowsStableDirectoryEnumerationReceipt, b: WindowsStableDirectoryEnumerationReceipt): string[] {
  const fields = [
    ...directoryDifferences(a.directoryBefore, b.directoryBefore).map((field) => `directoryBefore.${field}`),
    ...directoryDifferences(a.directoryAfter, b.directoryAfter).map((field) => `directoryAfter.${field}`)
  ];
  if (a.entries.length !== b.entries.length) fields.push('entries.length');
  const entryFields = ['name', ...ENTRY_OBJECT_FIELDS] as const;
  for (const field of entryFields) {
    if (a.entries.some((entry, index) => b.entries[index] !== undefined && entry[field] !== b.entries[index]![field])) {
      fields.push(`entries.${field}`);
    }
  }
  // Preserve visibility of the original exact serialized-enumeration comparison,
  // including any ordering/shape discrepancy not represented by field equality.
  if (JSON.stringify(a.entries) !== JSON.stringify(b.entries)) fields.push('entries.serialization');
  return fields;
}

function identity(object: WindowsObjectObservation): string {
  return `${object.volumeIdentity}:${object.fileId}`;
}

function hexToBoundedNumber(value: string): number {
  const parsed = BigInt(`0x${value}`);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw limit('directory closure size is not representable');
  return Number(parsed);
}

function portableKey(path: string): string {
  return path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapEnumerationFailure(error: unknown): BazframeError {
  const code = errorCode(error);
  if (code === 'WINDOWS_NATIVE_ENUMERATION_LIMIT_EXCEEDED') {
    return limit('directory closure exceeds its entry limit', error);
  }
  if (code === 'WINDOWS_NATIVE_DIRECTORY_CHANGED') {
    return changed('directory changed while enumerating', error);
  }
  return invalid('directory could not be enumerated with admissible stable evidence', error);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function policyInvalid(detail: string): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_CLOSURE_POLICY_INVALID',
    `Invalid Windows directory closure policy: ${detail}.`
  );
}

function invalid(detail: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_CLOSURE_INVALID',
    `Invalid Windows directory closure: ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}

function limit(detail: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED',
    `Windows directory closure limit exceeded: ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}

function changed(detail: string, cause?: unknown): BazframeError {
  return new BazframeError(
    'WINDOWS_DIRECTORY_CLOSURE_CHANGED',
    `Windows directory closure changed: ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}
