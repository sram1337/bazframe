import { win32 } from 'node:path';
import type {
  BazframeWin32NativeBackend,
  WindowsPathInspection,
  WindowsSecurityObservation
} from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';

const LOCAL_SYSTEM_SID = 'S-1-5-18';
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544';
const FILE_ALL_ACCESS = 0x001f01ff;
const SE_OWNER_DEFAULTED = 0x0001;
const SE_GROUP_DEFAULTED = 0x0002;
const SE_DACL_PRESENT = 0x0004;
const SE_DACL_DEFAULTED = 0x0008;
const SE_DACL_PROTECTED = 0x1000;
const ACCESS_ALLOWED_ACE_TYPE = 0;
const ACCESS_DENIED_ACE_TYPE = 1;
const OBJECT_INHERIT_ACE = 0x01;
const CONTAINER_INHERIT_ACE = 0x02;
const NO_PROPAGATE_INHERIT_ACE = 0x04;
const INHERIT_ONLY_ACE = 0x08;
const INHERITED_ACE = 0x10;
const KNOWN_ACE_FLAGS = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
  | NO_PROPAGATE_INHERIT_ACE | INHERIT_ONLY_ACE | INHERITED_ACE;
const WINDOWS_RESERVED_COMPONENT = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;

type ChainEntry = {
  path: string;
  inspection: WindowsPathInspection;
};
type ParsedAce = { type: 'allow' | 'deny'; flags: number; mask: number; sid: string };

/** Internal composition seam. It does not bypass the public Windows gate. */
export function admitWindowsPhysicalDirectory(
  backend: BazframeWin32NativeBackend,
  path: string
): WindowsPathInspection {
  const chain = inspectPhysicalChain(backend, path);
  return revalidateChain(backend, chain)[0]!.inspection;
}

/** Admits a stable physical regular file beneath physical directory ancestry. */
export function admitWindowsPhysicalFile(
  backend: BazframeWin32NativeBackend,
  path: string
): WindowsPathInspection {
  requireDriveAbsolutePath(path);
  const parentPath = win32.dirname(path);
  const component = win32.basename(path);
  if (parentPath.toLowerCase() === path.toLowerCase() || !isValidWindowsPathComponent(component)) {
    throw fileInvalid('path does not name one valid child file');
  }
  const chain = inspectPhysicalChain(backend, parentPath);
  const admittedParent = revalidateChain(backend, chain)[0]!.inspection;
  const before = backend.inspectPath(path);
  assertPhysicalFile(before);
  requireDirectFileChild(admittedParent, before, component);

  const afterChain = revalidateChain(backend, chain);
  requireSameDirectory(admittedParent, afterChain[0]!.inspection);
  const after = backend.inspectPath(path);
  assertPhysicalFile(after);
  requireSameRegularFile(before, after);
  requireDirectFileChild(afterChain[0]!.inspection, after, component);
  return after;
}

/** Creates one protected, owner-private child without replacement or cleanup. */
export function createWindowsPrivateDirectory(
  backend: BazframeWin32NativeBackend,
  parentPath: string,
  finalComponent: string
): WindowsPathInspection {
  validateFinalComponent(finalComponent);
  return createPrivateDirectoryUnderChain(backend, parentPath, finalComponent, inspectPhysicalChain(backend, parentPath));
}

function createPrivateDirectoryUnderChain(
  backend: BazframeWin32NativeBackend,
  parentPath: string,
  finalComponent: string,
  chain: ChainEntry[]
): WindowsPathInspection {
  const admittedChain = revalidateChain(backend, chain);
  const admittedParent = admittedChain[0]!.inspection;
  let receipt;
  try {
    receipt = backend.createPrivateDirectory(parentPath, finalComponent);
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED') {
      throw failure('WINDOWS_PRIVATE_DIRECTORY_OCCUPIED', 'The private directory destination is already occupied.', error);
    }
    if (errorCode(error) === 'WINDOWS_NATIVE_CREATE_AMBIGUOUS') throw ambiguous(error);
    throw error;
  }

  try {
    requireSameDirectory(admittedParent, receipt.parentBefore);
    requireSameDirectory(receipt.parentBefore, receipt.parentAfter);
    requireDirectChild(receipt.parentBefore, receipt.created, finalComponent);
    assertPhysicalDirectory(receipt.created);
    assertWindowsPrivateCreationSecurity(receipt.creationSecurity);

    const afterChain = revalidateChain(backend, admittedChain);
    requireSameDirectory(receipt.parentAfter, afterChain[0]!.inspection);
    const child = backend.inspectPath(win32.join(parentPath, finalComponent));
    assertPhysicalDirectory(child);
    requireSameDirectory(receipt.created, child);
    requireDirectChild(afterChain[0]!.inspection, child, finalComponent);
    return child;
  } catch (error) {
    throw ambiguous(error);
  }
}

/** Bootstrap only: existing ancestors need physical admission, never ACL repair.
 * Every missing component is protected from first visibility. Occupancy requires
 * fresh physical admission and exact spelling, not an ownership assumption.
 */
export function ensureWindowsPrivateDirectoryPath(
  backend: BazframeWin32NativeBackend,
  path: string
): WindowsPathInspection {
  requireDriveAbsolutePath(path);
  const components = path.slice(3).split('\\');
  if (components.length === 0 || components.some((name) => !isValidWindowsPathComponent(name))) {
    throw failure('WINDOWS_PRIVATE_DIRECTORY_PATH_INVALID', 'The Windows bootstrap path spelling is invalid.');
  }
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      backend.inspectPath(current);
      break;
    } catch (error) {
      if (errorCode(error) !== 'WINDOWS_NATIVE_PATH_NOT_FOUND') throw error;
      missing.unshift(win32.basename(current));
      const parent = win32.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  if (missing.length === 0) {
    const admitted = admitWindowsPhysicalDirectory(backend, path);
    assertExactSpelling(backend, path);
    return admitted;
  }
  const chain: ChainEntry[] = [];
  let ancestor = current;
  while (true) {
    const inspection = backend.inspectPath(ancestor);
    assertPhysicalDirectory(inspection);
    chain.push({ path: ancestor, inspection });
    const parent = win32.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  requireChainRelationships(chain);
  assertExactSpelling(backend, current);
  let proof = revalidateChain(backend, chain);
  for (const component of missing) {
    const child = win32.join(current, component);
    try {
      createPrivateDirectoryUnderChain(backend, current, component, proof);
    } catch (error) {
      if (errorCode(error) !== 'WINDOWS_PRIVATE_DIRECTORY_OCCUPIED') throw error;
      revalidateChain(backend, proof);
      admitWindowsPhysicalDirectory(backend, child);
    }
    assertExactSpelling(backend, child);
    current = child;
    proof = inspectPhysicalChain(backend, current);
  }
  return admitWindowsPhysicalDirectory(backend, path);
}

function assertExactSpelling(backend: BazframeWin32NativeBackend, path: string): void {
  let current = path;
  while (win32.dirname(current) !== current) {
    if (win32.basename(backend.inspectPath(current).canonicalPath) !== win32.basename(current)) {
      throw failure('WINDOWS_PRIVATE_DIRECTORY_PATH_INVALID', 'The Windows bootstrap path uses an alias spelling.');
    }
    current = win32.dirname(current);
  }
}

/** Creates one protected, owner-private empty file without replacement or cleanup. */
export function createWindowsPrivateFile(
  backend: BazframeWin32NativeBackend,
  parentPath: string,
  finalComponent: string
): WindowsPathInspection {
  if (!isValidWindowsPathComponent(finalComponent)) {
    throw failure(
      'WINDOWS_PRIVATE_FILE_NAME_INVALID',
      'The Windows private-file name is invalid or reserved.'
    );
  }
  const chain = inspectPhysicalChain(backend, parentPath);
  const admittedChain = revalidateChain(backend, chain);
  const admittedParent = admittedChain[0]!.inspection;
  let receipt;
  try {
    receipt = backend.createPrivateFile(parentPath, finalComponent);
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED') {
      throw failure('WINDOWS_PRIVATE_FILE_OCCUPIED', 'The private file destination is already occupied.', error);
    }
    if (errorCode(error) === 'WINDOWS_NATIVE_CREATE_AMBIGUOUS') throw fileCreateAmbiguous(error);
    throw error;
  }

  try {
    requireSameDirectory(admittedParent, receipt.parentBefore);
    requireSameDirectory(receipt.parentBefore, receipt.parentAfter);
    requireDirectFileChild(receipt.parentBefore, receipt.created, finalComponent);
    assertPhysicalFile(receipt.created);
    assertPrivateFileSecurity(receipt.creationSecurity);
    if (receipt.created.object.numberOfLinks !== '00000001') throw fileInvalid('new file is multiply linked');
    if (receipt.created.object.size !== '0000000000000000') {
      throw fileInvalid('created file is not empty');
    }
    if (!isProtected(receipt.creationSecurity)) throw fileInvalid('created file DACL is not protected');

    const afterChain = revalidateChain(backend, admittedChain);
    requireSameDirectory(receipt.parentAfter, afterChain[0]!.inspection);
    const child = backend.inspectPath(win32.join(parentPath, finalComponent));
    assertPhysicalFile(child);
    if (child.object.size !== '0000000000000000') throw fileInvalid('created file is not empty');
    requireSameRegularFile(receipt.created, child);
    requireDirectFileChild(afterChain[0]!.inspection, child, finalComponent);
    return child;
  } catch (error) {
    throw fileCreateAmbiguous(error);
  }
}

function inspectPhysicalChain(backend: BazframeWin32NativeBackend, path: string): ChainEntry[] {
  requireDriveAbsolutePath(path);
  const chain: ChainEntry[] = [];
  let current = path;
  while (true) {
    const inspection = backend.inspectPath(current);
    assertPhysicalDirectory(inspection);
    chain.push({ path: current, inspection });
    const parent = win32.dirname(current);
    if (parent.toLowerCase() === current.toLowerCase()) {
      requireChainRelationships(chain);
      return chain;
    }
    current = parent;
  }
}

function revalidateChain(
  backend: BazframeWin32NativeBackend,
  chain: readonly ChainEntry[]
): ChainEntry[] {
  const result = new Array<ChainEntry>(chain.length);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index]!;
    const inspection = backend.inspectPath(entry.path);
    assertPhysicalDirectory(inspection);
    requireSameDirectory(entry.inspection, inspection);
    result[index] = { path: entry.path, inspection };
  }
  return result;
}

function assertPhysicalFile(inspection: WindowsPathInspection): void {
  if (inspection.kind !== 'regular-file' || inspection.object.directory
    || inspection.object.reparseTag !== null || inspection.object.deletePending
    || inspection.object.volumeIdentity !== inspection.volume.identity
    || inspection.ancestryReparseFree !== true) {
    throw fileInvalid('path is not an admitted physical regular file');
  }
}

function assertPhysicalDirectory(inspection: WindowsPathInspection): void {
  if (inspection.kind !== 'directory' || !inspection.object.directory
    || inspection.object.reparseTag !== null || inspection.object.deletePending
    || inspection.object.volumeIdentity !== inspection.volume.identity
    || inspection.ancestryReparseFree !== true) {
    invalid('path is not an admitted physical directory');
  }
}

/** Verifies our fresh protected creation recipe, never existing-object admission. */
export function assertWindowsPrivateCreationSecurity(security: WindowsSecurityObservation): void {
  if (!isProtected(security)) invalid('created directory DACL is not protected');
  assertSecurityDescriptor(security);
  if (security.ownerSid !== security.currentUserSid) {
    invalid('directory ownership is not private');
  }
  const trusted = new Set([
    security.currentUserSid,
    LOCAL_SYSTEM_SID,
    BUILTIN_ADMINISTRATORS_SID
  ]);
  const required = new Set(trusted);
  for (const ace of parseAcl(security.daclBytes)) {
    if (ace.type === 'deny') invalid('deny ACE cannot prove required private access');
    if (!trusted.has(ace.sid)) invalid('foreign allow ACE is not owner-private');
    const effective = (ace.flags & INHERIT_ONLY_ACE) === 0;
    const inheritable = (ace.flags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE))
      === (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
      && (ace.flags & NO_PROPAGATE_INHERIT_ACE) === 0;
    if (effective && inheritable && (ace.mask & FILE_ALL_ACCESS) === FILE_ALL_ACCESS) {
      required.delete(ace.sid);
    }
  }
  if (required.size !== 0) invalid('trusted principals do not have effective inheritable full control');
}

function assertPrivateFileSecurity(security: WindowsSecurityObservation): void {
  let aces: ParsedAce[];
  try {
    assertSecurityDescriptor(security);
    aces = parseAcl(security.daclBytes);
  } catch (cause) {
    throw fileInvalid('security descriptor or ACL is malformed', cause);
  }
  if (security.ownerSid !== security.currentUserSid) {
    throw fileInvalid('file ownership is not private');
  }
  const trusted = new Set([
    security.currentUserSid,
    LOCAL_SYSTEM_SID,
    BUILTIN_ADMINISTRATORS_SID
  ]);
  const required = new Set(trusted);
  for (const ace of aces) {
    if (ace.type === 'deny') throw fileInvalid('deny ACE cannot prove required private access');
    if (!trusted.has(ace.sid)) throw fileInvalid('foreign allow ACE is not owner-private');
    if ((ace.flags & INHERIT_ONLY_ACE) === 0
      && (ace.mask & FILE_ALL_ACCESS) === FILE_ALL_ACCESS) {
      required.delete(ace.sid);
    }
  }
  if (required.size !== 0) {
    throw fileInvalid('trusted principals do not have effective full control');
  }
}

function assertSecurityDescriptor(security: WindowsSecurityObservation): void {
  const control = security.descriptorControl;
  if (((control & SE_OWNER_DEFAULTED) !== 0) !== security.ownerDefaulted
    || ((control & SE_GROUP_DEFAULTED) !== 0) !== security.groupDefaulted
    || ((control & SE_DACL_PRESENT) !== 0) !== security.daclPresent
    || ((control & SE_DACL_DEFAULTED) !== 0) !== security.daclDefaulted) {
    invalid('security descriptor control flags are inconsistent');
  }
  if (!security.daclPresent || security.daclNull || security.daclBytes.byteLength === 0) {
    invalid('directory DACL is absent, null, or empty');
  }
}

function parseAcl(bytes: Buffer): ParsedAce[] {
  if (bytes.byteLength < 8) invalid('DACL is truncated');
  const revision = bytes[0];
  if ((revision !== 2 && revision !== 4) || bytes[1] !== 0
    || bytes.readUInt16LE(2) !== bytes.byteLength || bytes.readUInt16LE(6) !== 0) {
    invalid('DACL header is malformed');
  }
  const count = bytes.readUInt16LE(4);
  const result: ParsedAce[] = [];
  let offset = 8;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > bytes.byteLength) invalid('ACE is truncated');
    const type = bytes[offset];
    const flags = bytes[offset + 1]!;
    const size = bytes.readUInt16LE(offset + 2);
    if ((type !== ACCESS_ALLOWED_ACE_TYPE && type !== ACCESS_DENIED_ACE_TYPE)
      || (flags & ~KNOWN_ACE_FLAGS) !== 0 || size < 20 || offset + size > bytes.byteLength) {
      invalid('ACE type, flags, or size is unsupported');
    }
    const sid = binarySid(bytes.subarray(offset + 8, offset + size));
    const expectedSize = 8 + binarySidSize(bytes, offset + 8);
    if (size !== expectedSize) invalid('ACE contains trailing or incomplete SID bytes');
    result.push({
      type: type === ACCESS_ALLOWED_ACE_TYPE ? 'allow' : 'deny',
      flags,
      mask: bytes.readUInt32LE(offset + 4),
      sid
    });
    offset += size;
  }
  if (offset !== bytes.byteLength) invalid('DACL contains trailing bytes');
  return result;
}

function binarySidSize(bytes: Buffer, offset: number): number {
  if (offset + 8 > bytes.byteLength || bytes[offset] !== 1) invalid('SID is malformed');
  const count = bytes[offset + 1]!;
  if (count > 15) invalid('SID has too many subauthorities');
  const size = 8 + count * 4;
  if (offset + size > bytes.byteLength) invalid('SID is truncated');
  return size;
}

function binarySid(bytes: Buffer): string {
  const size = binarySidSize(bytes, 0);
  if (size !== bytes.byteLength) invalid('SID bytes are not canonical');
  let authority = 0n;
  for (let index = 2; index < 8; index += 1) authority = (authority << 8n) | BigInt(bytes[index]!);
  const parts = [`S-1-${authority}`];
  for (let index = 0; index < bytes[1]!; index += 1) {
    parts.push(String(bytes.readUInt32LE(8 + index * 4)));
  }
  return parts.join('-');
}

function requireSameDirectory(a: WindowsPathInspection, b: WindowsPathInspection): void {
  if (a.canonicalPath.toLowerCase() !== b.canonicalPath.toLowerCase()
    || a.kind !== 'directory' || b.kind !== 'directory'
    || a.volume.identity !== b.volume.identity
    || a.object.volumeIdentity !== b.object.volumeIdentity
    || a.object.fileId !== b.object.fileId
    || a.object.reparseTag !== null || b.object.reparseTag !== null
    || a.object.deletePending || b.object.deletePending
    || !a.object.directory || !b.object.directory) {
    invalid('directory identity changed');
  }
}

function requireSameRegularFile(a: WindowsPathInspection, b: WindowsPathInspection): void {
  if (a.canonicalPath.toLowerCase() !== b.canonicalPath.toLowerCase()
    || a.kind !== 'regular-file' || b.kind !== 'regular-file'
    || a.volume.identity !== b.volume.identity
    || a.object.volumeIdentity !== b.object.volumeIdentity
    || a.object.fileId !== b.object.fileId
    || a.object.size !== b.object.size
    || a.object.allocationSize !== b.object.allocationSize
    || a.object.numberOfLinks !== b.object.numberOfLinks
    || a.object.creationTime !== b.object.creationTime
    || a.object.lastWriteTime !== b.object.lastWriteTime
    || a.object.changeTime !== b.object.changeTime
    || a.object.attributes !== b.object.attributes
    || a.object.reparseTag !== null || b.object.reparseTag !== null
    || a.object.deletePending || b.object.deletePending
    || a.object.directory || b.object.directory) {
    throw fileInvalid('file identity or stable metadata changed');
  }
}

function requireChainRelationships(chain: readonly ChainEntry[]): void {
  for (let index = 0; index + 1 < chain.length; index += 1) {
    const child = chain[index]!.inspection;
    const parent = chain[index + 1]!.inspection;
    if (child.volume.identity !== parent.volume.identity
      || win32.dirname(child.canonicalPath).toLowerCase() !== parent.canonicalPath.toLowerCase()) {
      invalid('physical ancestry chain is inconsistent');
    }
  }
}

function requireDirectFileChild(
  parent: WindowsPathInspection,
  child: WindowsPathInspection,
  component: string
): void {
  const separator = parent.canonicalPath.endsWith('\\') ? '' : '\\';
  if (parent.volume.identity !== child.volume.identity
    || child.canonicalPath.toLowerCase()
      !== `${parent.canonicalPath}${separator}${component}`.toLowerCase()) {
    throw fileInvalid('file is not the requested direct child');
  }
}

function requireDirectChild(
  parent: WindowsPathInspection,
  child: WindowsPathInspection,
  component: string
): void {
  const separator = parent.canonicalPath.endsWith('\\') ? '' : '\\';
  if (parent.volume.identity !== child.volume.identity
    || child.canonicalPath.toLowerCase()
      !== `${parent.canonicalPath}${separator}${component}`.toLowerCase()) {
    invalid('created directory is not the requested direct child');
  }
}

function isProtected(security: WindowsSecurityObservation): boolean {
  return (security.descriptorControl & SE_DACL_PROTECTED) !== 0;
}

function requireDriveAbsolutePath(path: string): void {
  if (typeof path !== 'string' || !/^[A-Za-z]:\\/u.test(path) || path.includes('\0')) {
    throw failure('WINDOWS_PRIVATE_DIRECTORY_PATH_INVALID', 'The Windows private-directory path is invalid.');
  }
}

export function isValidWindowsPathComponent(value: string): boolean {
  if (typeof value !== 'string') return false;
  let paired = true;
  let hasControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f) hasControlCharacter = true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) paired = false;
      else index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) paired = false;
  }
  return value.length > 0 && value.length <= 255 && value !== '.' && value !== '..'
    && !hasControlCharacter && !/[<>:"/\\|?*]/u.test(value) && !/[ .]$/u.test(value)
    && !WINDOWS_RESERVED_COMPONENT.test(value) && paired;
}

function validateFinalComponent(value: string): void {
  if (!isValidWindowsPathComponent(value)) {
    throw failure(
      'WINDOWS_PRIVATE_DIRECTORY_NAME_INVALID',
      'The Windows private-directory name is invalid or reserved.'
    );
  }
}

function invalid(reason: string): never {
  throw failure(
    'WINDOWS_DIRECTORY_PROOF_INVALID',
    `Windows directory proof failed: ${reason}.`
  );
}

function fileInvalid(reason: string, cause?: unknown): BazframeError {
  return failure(
    'WINDOWS_FILE_PROOF_INVALID',
    `Windows file proof failed: ${reason}.`,
    cause
  );
}

function fileCreateAmbiguous(cause: unknown): BazframeError {
  return failure(
    'WINDOWS_PRIVATE_FILE_CREATE_AMBIGUOUS',
    'Private-file creation may have changed storage; retain and inspect the destination before reuse.',
    cause
  );
}

function ambiguous(cause: unknown): BazframeError {
  return failure(
    'WINDOWS_PRIVATE_DIRECTORY_CREATE_AMBIGUOUS',
    'Private-directory creation may have changed storage; retain and inspect the destination before reuse.',
    cause
  );
}

function failure(code: string, message: string, cause?: unknown): BazframeError {
  return new BazframeError(code, message, cause === undefined ? undefined : { cause });
}
