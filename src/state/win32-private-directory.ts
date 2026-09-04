import { win32 } from 'node:path';
import type {
  BazframeWin32NativeBackend,
  WindowsPathInspection,
  WindowsSecurityObservation
} from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';

const LOCAL_SYSTEM_SID = 'S-1-5-18';
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544';
const TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const FILE_ALL_ACCESS = 0x001f01ff;
const DELETE = 0x0001_0000;
const FILE_DELETE_CHILD = 0x0000_0040;
const WRITE_DAC = 0x0004_0000;
const WRITE_OWNER = 0x0008_0000;
const GENERIC_ALL = 0x1000_0000;
const NAMESPACE_TAKEOVER_ACCESS = DELETE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER | GENERIC_ALL;
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
  proof: 'private' | 'namespace';
};
type ParsedAce = { type: 'allow' | 'deny'; flags: number; mask: number; sid: string };

/** Internal composition seam. It does not bypass the public Windows gate. */
export function admitWindowsPrivateDirectory(
  backend: BazframeWin32NativeBackend,
  path: string
): WindowsPathInspection {
  const chain = inspectPrivateChain(backend, path);
  return revalidateChain(backend, chain)[0]!.inspection;
}

/** Creates one protected, owner-private child without replacement or cleanup. */
export function createWindowsPrivateDirectory(
  backend: BazframeWin32NativeBackend,
  parentPath: string,
  finalComponent: string
): WindowsPathInspection {
  validateFinalComponent(finalComponent);
  const chain = inspectPrivateChain(backend, parentPath);
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
    requireSameSecurity(admittedParent.security, receipt.parentBefore.security);
    requireSameDirectory(receipt.parentBefore, receipt.parentAfter);
    requireSameSecurity(receipt.parentBefore.security, receipt.parentAfter.security);
    requireDirectChild(receipt.parentBefore, receipt.created, finalComponent);
    requireSameCurrentUser(receipt.parentBefore, receipt.created);
    assertPrivateDirectory(receipt.created);
    if (!isProtected(receipt.created.security)) invalid('created directory DACL is not protected');

    const afterChain = revalidateChain(backend, admittedChain);
    requireSameDirectory(receipt.parentAfter, afterChain[0]!.inspection);
    requireSameSecurity(receipt.parentAfter.security, afterChain[0]!.inspection.security);
    const child = backend.inspectPath(win32.join(parentPath, finalComponent));
    assertPrivateDirectory(child);
    if (!isProtected(child.security)) invalid('created directory DACL is not protected');
    requireSameDirectory(receipt.created, child);
    requireSameSecurity(receipt.created.security, child.security);
    requireDirectChild(afterChain[0]!.inspection, child, finalComponent);
    requireSameCurrentUser(afterChain[0]!.inspection, child);
    return child;
  } catch (error) {
    throw ambiguous(error);
  }
}

function inspectPrivateChain(backend: BazframeWin32NativeBackend, path: string): ChainEntry[] {
  requireDriveAbsolutePath(path);
  const chain: ChainEntry[] = [];
  let current = path;
  let requiresPrivateProof = true;
  while (true) {
    const inspection = backend.inspectPath(current);
    if (requiresPrivateProof) assertPrivateDirectory(inspection);
    else assertNamespaceDirectory(inspection);
    chain.push({
      path: current,
      inspection,
      proof: requiresPrivateProof ? 'private' : 'namespace'
    });
    if (requiresPrivateProof && isProtected(inspection.security)) requiresPrivateProof = false;
    const parent = win32.dirname(current);
    if (parent.toLowerCase() === current.toLowerCase()) {
      if (requiresPrivateProof) {
        throw failure(
          'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED',
          'The directory does not have a protected owner-private ancestry anchor.'
        );
      }
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
    if (entry.proof === 'private') assertPrivateDirectory(inspection);
    else assertNamespaceDirectory(inspection);
    requireSameDirectory(entry.inspection, inspection);
    requireSameSecurity(entry.inspection.security, inspection.security);
    result[index] = { path: entry.path, inspection, proof: entry.proof };
  }
  return result;
}

function assertPrivateDirectory(inspection: WindowsPathInspection): void {
  assertPhysicalDirectory(inspection);
  assertPrivateSecurity(inspection.security);
}

function assertNamespaceDirectory(inspection: WindowsPathInspection): void {
  assertPhysicalDirectory(inspection);
  assertNamespaceSecurity(inspection.security);
}

function assertPhysicalDirectory(inspection: WindowsPathInspection): void {
  if (inspection.kind !== 'directory' || !inspection.object.directory
    || inspection.object.reparseTag !== null || inspection.object.deletePending
    || inspection.object.volumeIdentity !== inspection.volume.identity
    || inspection.ancestryReparseFree !== true) {
    invalid('path is not an admitted physical directory');
  }
}

function assertPrivateSecurity(security: WindowsSecurityObservation): void {
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

function assertNamespaceSecurity(security: WindowsSecurityObservation): void {
  assertSecurityDescriptor(security);
  const trusted = new Set([
    security.currentUserSid,
    LOCAL_SYSTEM_SID,
    BUILTIN_ADMINISTRATORS_SID,
    TRUSTED_INSTALLER_SID
  ]);
  if (!trusted.has(security.ownerSid)) {
    invalid('namespace ancestor owner could rewrite its protection');
  }
  for (const ace of parseAcl(security.daclBytes)) {
    const effective = (ace.flags & INHERIT_ONLY_ACE) === 0;
    if (ace.type === 'allow' && effective && !trusted.has(ace.sid)
      && (ace.mask & NAMESPACE_TAKEOVER_ACCESS) !== 0) {
      invalid('namespace ancestor grants foreign deletion or protection-rewrite access');
    }
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

function requireSameSecurity(a: WindowsSecurityObservation, b: WindowsSecurityObservation): void {
  if (a.descriptorControl !== b.descriptorControl || a.daclPresent !== b.daclPresent
    || a.daclNull !== b.daclNull || a.daclDefaulted !== b.daclDefaulted
    || !a.daclBytes.equals(b.daclBytes) || a.ownerSid !== b.ownerSid
    || a.ownerDefaulted !== b.ownerDefaulted || a.groupSid !== b.groupSid
    || a.groupDefaulted !== b.groupDefaulted || a.currentUserSid !== b.currentUserSid) {
    invalid('directory security changed');
  }
}

function requireChainRelationships(chain: readonly ChainEntry[]): void {
  for (let index = 0; index + 1 < chain.length; index += 1) {
    const child = chain[index]!.inspection;
    const parent = chain[index + 1]!.inspection;
    if (child.volume.identity !== parent.volume.identity
      || win32.dirname(child.canonicalPath).toLowerCase() !== parent.canonicalPath.toLowerCase()
      || child.security.currentUserSid !== parent.security.currentUserSid) {
      invalid('private ancestry chain is inconsistent');
    }
  }
}

function requireSameCurrentUser(a: WindowsPathInspection, b: WindowsPathInspection): void {
  if (a.security.currentUserSid !== b.security.currentUserSid) {
    invalid('current-user security identity changed');
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

function validateFinalComponent(value: string): void {
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
  if (value.length === 0 || value.length > 255 || value === '.' || value === '..'
    || hasControlCharacter || /[<>:"/\\|?*]/u.test(value) || /[ .]$/u.test(value)
    || WINDOWS_RESERVED_COMPONENT.test(value) || !paired) {
    throw failure(
      'WINDOWS_PRIVATE_DIRECTORY_NAME_INVALID',
      'The Windows private-directory name is invalid or reserved.'
    );
  }
}

function invalid(reason: string): never {
  throw failure(
    'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED',
    `The directory cannot be proved owner-private: ${reason}.`
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
