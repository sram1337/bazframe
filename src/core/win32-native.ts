import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BazframeError, errorCode } from './errors.js';

export const BAZFRAME_WIN32_NATIVE_CONTRACT_VERSION = 4;
export const BAZFRAME_WIN32_NATIVE_TARGET = 'win32-x64-msvc';
// Must remain equal to native/win32/src/lib.rs and the authoritative profile
// portability production ceilings.
export const BAZFRAME_WIN32_NATIVE_MAX_STABLE_READ_BYTES = 64 * 1024 * 1024;
export const BAZFRAME_WIN32_NATIVE_MAX_STABLE_DIRECTORY_ENTRIES = 32_768;

const HEX_32 = /^[a-f0-9]{8}$/u;
const HEX_64 = /^[a-f0-9]{16}$/u;
const HEX_128 = /^[a-f0-9]{32}$/u;
const VOLUME_GUID = /^\\\\\?\\Volume\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}\\$/u;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const requireFromHere = createRequire(import.meta.url);
const nativeArtifactUrl = new URL(
  '../../artifacts/native/win32-x64-msvc/bazframe-win32.node',
  import.meta.url
);
const packageManifestUrl = new URL('../../package.json', import.meta.url);

export interface WindowsVolumeObservation {
  identity: string;
  filesystemName: 'NTFS';
  driveType: 'fixed';
  canonicalVolumeGuidPath: string;
  remoteDevice: false;
}

export interface WindowsObjectObservation {
  volumeIdentity: string;
  fileId: string;
  size: string;
  allocationSize: string;
  numberOfLinks: string;
  creationTime: string;
  lastAccessTime: string;
  lastWriteTime: string;
  changeTime: string;
  attributes: number;
  reparseTag: number | null;
  deletePending: boolean;
  directory: boolean;
}

export interface WindowsSecurityObservation {
  descriptorControl: number;
  daclPresent: boolean;
  daclNull: boolean;
  daclDefaulted: boolean;
  daclBytes: Buffer;
  ownerSid: string;
  ownerDefaulted: boolean;
  groupSid: string;
  groupDefaulted: boolean;
  currentUserSid: string;
}

export interface WindowsPathInspection {
  canonicalPath: string;
  kind: 'regular-file' | 'directory';
  volume: WindowsVolumeObservation;
  object: WindowsObjectObservation;
  security: WindowsSecurityObservation;
  ancestryReparseFree: true;
}

export interface WindowsPrivateDirectoryCreationReceipt {
  parentBefore: WindowsPathInspection;
  created: WindowsPathInspection;
  parentAfter: WindowsPathInspection;
}

export interface WindowsStableReadReceipt {
  bytes: Buffer;
  byteCount: string;
  before: WindowsObjectObservation;
  after: WindowsObjectObservation;
}

export interface WindowsDirectoryEntryObservation {
  name: string;
  fileId: string;
  size: string;
  allocationSize: string;
  creationTime: string;
  lastWriteTime: string;
  changeTime: string;
  attributes: number;
  reparseTag: number | null;
  directory: boolean;
}

export interface WindowsStableDirectoryEnumerationReceipt {
  directoryBefore: WindowsPathInspection;
  entries: WindowsDirectoryEntryObservation[];
  directoryAfter: WindowsPathInspection;
}

export interface BazframeWin32NativeBackend {
  inspectPath(path: string): WindowsPathInspection;
  createPrivateDirectory(parentPath: string, finalComponent: string): WindowsPrivateDirectoryCreationReceipt;
  renameDirectoryNoReplace(
    parentPath: string,
    sourceComponent: string,
    destinationComponent: string
  ): Promise<void>;
  readStableFile(path: string, maxBytes: number): Promise<WindowsStableReadReceipt>;
  enumerateStableDirectory(
    path: string,
    maxEntries: number
  ): Promise<WindowsStableDirectoryEnumerationReceipt>;
}

interface RawNativeModule {
  getNativeWindowsInfo: () => unknown;
  inspectWindowsPath: (path: string) => unknown;
  createWindowsPrivateDirectory: (parentPath: string, finalComponent: string) => unknown;
  renameWindowsDirectoryNoReplace: (
    parentPath: string,
    sourceComponent: string,
    destinationComponent: string
  ) => unknown;
  readWindowsFileStable: (path: string, maxBytes: number) => unknown;
  enumerateWindowsDirectoryStable: (path: string, maxEntries: number) => unknown;
}

export interface Win32NativeLoadOptions {
  /** Internal conformance seams; production callers omit these values. */
  platform?: NodeJS.Platform;
  arch?: string;
  loadModule?: (absolutePath: string) => unknown;
  loadPackageManifest?: (absolutePath: string) => unknown;
}

/**
 * Loads the root-bundled Bazframe binary for internal capability tests.
 * The public CLI platform gate does not call or expose this function.
 */
export function loadBazframeWin32Native(
  options: Win32NativeLoadOptions = {}
): BazframeWin32NativeBackend {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'win32') {
    throw failure(
      'WINDOWS_NATIVE_PLATFORM_UNSUPPORTED',
      'The Bazframe native Windows backend requires native Windows.'
    );
  }
  if (arch !== 'x64') {
    throw failure(
      'WINDOWS_NATIVE_ARCH_UNSUPPORTED',
      'The Bazframe native Windows backend requires Windows x64.'
    );
  }
  const expectedPackageVersion = installedPackageVersion(options.loadPackageManifest);
  const absolutePath = fileURLToPath(nativeArtifactUrl);
  let loaded: unknown;
  try {
    loaded = (options.loadModule ?? ((path) => requireFromHere(path)))(absolutePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw failure(
        'WINDOWS_NATIVE_ARTIFACT_MISSING',
        'The bundled Bazframe Windows native artifact is missing. Reinstall Bazframe from the reviewed package.',
        error
      );
    }
    throw failure(
      code === 'ERR_DLOPEN_FAILED'
        ? 'WINDOWS_NATIVE_ARTIFACT_INCOMPATIBLE'
        : 'WINDOWS_NATIVE_ARTIFACT_LOAD_FAILED',
      'The bundled Bazframe Windows native artifact could not be loaded. Reinstall Bazframe for Windows x64 with a supported Node version.',
      error
    );
  }
  let native: RawNativeModule;
  try {
    native = nativeModule(loaded);
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    throw failure(
      'WINDOWS_NATIVE_EXPORT_MISSING',
      'The bundled Bazframe Windows native artifact does not expose its required contract.',
      error
    );
  }
  let info: Record<string, unknown>;
  try {
    info = exactRecord(native.getNativeWindowsInfo(), [
      'contractVersion',
      'packageVersion',
      'target',
      'maxStableReadBytes',
      'maxStableDirectoryEntries'
    ], 'native contract information');
  } catch (error) {
    throw receiptFailure('Native contract information is malformed.', error);
  }
  if (info.contractVersion !== BAZFRAME_WIN32_NATIVE_CONTRACT_VERSION) {
    throw failure(
      'WINDOWS_NATIVE_CONTRACT_MISMATCH',
      'The bundled Bazframe Windows native contract is incompatible with this Bazframe build.'
    );
  }
  if (info.packageVersion !== expectedPackageVersion) {
    throw failure(
      'WINDOWS_NATIVE_VERSION_MISMATCH',
      'The bundled Bazframe Windows native artifact does not match this Bazframe package version.'
    );
  }
  if (info.target !== BAZFRAME_WIN32_NATIVE_TARGET) {
    throw failure(
      'WINDOWS_NATIVE_TARGET_MISMATCH',
      'The bundled Bazframe Windows native artifact reports an unexpected target.'
    );
  }
  if (info.maxStableReadBytes !== BAZFRAME_WIN32_NATIVE_MAX_STABLE_READ_BYTES
    || info.maxStableDirectoryEntries !== BAZFRAME_WIN32_NATIVE_MAX_STABLE_DIRECTORY_ENTRIES) {
    throw failure(
      'WINDOWS_NATIVE_CONTRACT_MISMATCH',
      'The bundled Bazframe Windows native limits do not match this Bazframe build.'
    );
  }

  return Object.freeze({
    inspectPath(path: string): WindowsPathInspection {
      requirePath(path);
      let receipt: unknown;
      try {
        receipt = native.inspectWindowsPath(path);
      } catch (error) {
        throw nativeOperationFailure(error);
      }
      return pathInspection(receipt);
    },
    createPrivateDirectory(
      parentPath: string,
      finalComponent: string
    ): WindowsPrivateDirectoryCreationReceipt {
      requirePath(parentPath);
      requireFinalComponent(finalComponent);
      let receipt: unknown;
      try {
        receipt = native.createWindowsPrivateDirectory(parentPath, finalComponent);
      } catch (error) {
        throw nativeCreationFailure(error);
      }
      try {
        return privateDirectoryCreationReceipt(receipt, finalComponent);
      } catch (error) {
        throw failure(
          'WINDOWS_NATIVE_CREATE_AMBIGUOUS',
          'The native Windows private-directory creation result is malformed; the created path must be inspected before reuse.',
          error
        );
      }
    },
    async renameDirectoryNoReplace(
      parentPath: string,
      sourceComponent: string,
      destinationComponent: string
    ): Promise<void> {
      requirePath(parentPath);
      requireFinalComponent(sourceComponent);
      requireFinalComponent(destinationComponent);
      if (portableComponentKey(sourceComponent) === portableComponentKey(destinationComponent)) {
        throw failure(
          'WINDOWS_NATIVE_PATH_INVALID',
          'The native Windows rename components must be distinct.'
        );
      }
      try {
        await Promise.resolve(native.renameWindowsDirectoryNoReplace(
          parentPath,
          sourceComponent,
          destinationComponent
        ));
      } catch (error) {
        throw nativeOperationFailure(error);
      }
    },
    async readStableFile(path: string, maxBytes: number): Promise<WindowsStableReadReceipt> {
      requirePath(path);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
        || maxBytes > BAZFRAME_WIN32_NATIVE_MAX_STABLE_READ_BYTES) {
        throw failure(
          'WINDOWS_NATIVE_READ_LIMIT_INVALID',
          'The Bazframe native stable-read byte bound is invalid.'
        );
      }
      let receipt: unknown;
      try {
        receipt = await Promise.resolve(native.readWindowsFileStable(path, maxBytes));
      } catch (error) {
        throw nativeOperationFailure(error);
      }
      return stableReadReceipt(receipt, maxBytes);
    },
    async enumerateStableDirectory(
      path: string,
      maxEntries: number
    ): Promise<WindowsStableDirectoryEnumerationReceipt> {
      requirePath(path);
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || Object.is(maxEntries, -0)
        || maxEntries > BAZFRAME_WIN32_NATIVE_MAX_STABLE_DIRECTORY_ENTRIES) {
        throw failure(
          'WINDOWS_NATIVE_ENUMERATION_LIMIT_INVALID',
          'The Bazframe native stable-directory entry bound is invalid.'
        );
      }
      let receipt: unknown;
      try {
        receipt = await Promise.resolve(native.enumerateWindowsDirectoryStable(path, maxEntries));
      } catch (error) {
        throw nativeOperationFailure(error);
      }
      return stableDirectoryEnumerationReceipt(receipt, maxEntries);
    }
  });
}

function installedPackageVersion(
  loadManifest: ((absolutePath: string) => unknown) | undefined
): string {
  try {
    const value = (loadManifest ?? ((path) => requireFromHere(path)))(fileURLToPath(packageManifestUrl));
    const version = plainRecord(value).version;
    if (typeof version !== 'string' || version.length === 0) invalid();
    return version;
  } catch (error) {
    throw failure(
      'WINDOWS_NATIVE_PACKAGE_METADATA_INVALID',
      'The installed Bazframe package metadata is unavailable or invalid.',
      error
    );
  }
}

function nativeModule(value: unknown): RawNativeModule {
  const record = plainRecord(value);
  for (const name of [
    'getNativeWindowsInfo',
    'inspectWindowsPath',
    'createWindowsPrivateDirectory',
    'renameWindowsDirectoryNoReplace',
    'readWindowsFileStable',
    'enumerateWindowsDirectoryStable'
  ] as const) {
    if (typeof record[name] !== 'function') {
      throw failure(
        'WINDOWS_NATIVE_EXPORT_MISSING',
        'The bundled Bazframe Windows native artifact is missing a required capability export.'
      );
    }
  }
  return record as unknown as RawNativeModule;
}

function pathInspection(value: unknown): WindowsPathInspection {
  try {
    const record = exactRecord(value, [
      'canonicalPath', 'kind', 'volume', 'object', 'security', 'ancestryReparseFree'
    ], 'path inspection');
    if (typeof record.canonicalPath !== 'string' || record.canonicalPath.length === 0) invalid();
    if (record.kind !== 'regular-file' && record.kind !== 'directory') invalid();
    if (record.ancestryReparseFree !== true) invalid();
    const volume = volumeObservation(record.volume);
    const object = objectObservation(record.object);
    const security = securityObservation(record.security);
    if (!record.canonicalPath.toLowerCase().startsWith(volume.canonicalVolumeGuidPath.toLowerCase())
      || object.volumeIdentity !== volume.identity || object.reparseTag !== null
      || object.deletePending || object.directory !== (record.kind === 'directory')) invalid();
    return {
      canonicalPath: record.canonicalPath,
      kind: record.kind,
      volume,
      object,
      security,
      ancestryReparseFree: true
    };
  } catch (error) {
    throw receiptFailure('Native Windows path inspection is malformed or inadmissible.', error);
  }
}

function privateDirectoryCreationReceipt(
  value: unknown,
  finalComponent: string
): WindowsPrivateDirectoryCreationReceipt {
  const record = exactRecord(value, ['parentBefore', 'created', 'parentAfter'], 'private directory creation');
  const parentBefore = pathInspection(record.parentBefore);
  const created = pathInspection(record.created);
  const parentAfter = pathInspection(record.parentAfter);
  if (parentBefore.kind !== 'directory' || parentAfter.kind !== 'directory'
    || created.kind !== 'directory' || !sameDirectoryIdentity(parentBefore, parentAfter)
    || parentBefore.volume.identity !== created.volume.identity
    || parentBefore.volume.identity !== parentAfter.volume.identity
    || !isDirectCanonicalChild(parentBefore.canonicalPath, created.canonicalPath, finalComponent)) {
    invalid();
  }
  return { parentBefore, created, parentAfter };
}

function stableReadReceipt(value: unknown, maxBytes: number): WindowsStableReadReceipt {
  try {
    const record = exactRecord(value, ['bytes', 'byteCount', 'before', 'after'], 'stable read');
    if (!(record.bytes instanceof Uint8Array)) invalid();
    const byteCount = hex(record.byteCount, HEX_64);
    const count = BigInt(`0x${byteCount}`);
    const bytes = Buffer.from(record.bytes);
    if (count !== BigInt(bytes.byteLength) || count > BigInt(maxBytes)) invalid();
    const before = objectObservation(record.before);
    const after = objectObservation(record.after);
    if (before.directory || after.directory || before.reparseTag !== null || after.reparseTag !== null
      || before.deletePending || after.deletePending || before.size !== byteCount
      || after.size !== byteCount || !sameStableObservation(before, after)) {
      throw failure(
        'WINDOWS_NATIVE_READ_CHANGED',
        'The native stable-read receipt reports changed or inconsistent file state.'
      );
    }
    return { bytes, byteCount, before, after };
  } catch (error) {
    if (error instanceof BazframeError && error.code === 'WINDOWS_NATIVE_READ_CHANGED') throw error;
    throw receiptFailure('Native Windows stable-read evidence is malformed.', error);
  }
}

function stableDirectoryEnumerationReceipt(
  value: unknown,
  maxEntries: number
): WindowsStableDirectoryEnumerationReceipt {
  try {
    const record = exactRecord(
      value,
      ['directoryBefore', 'entries', 'directoryAfter'],
      'stable directory enumeration'
    );
    const directoryBefore = pathInspection(record.directoryBefore);
    const directoryAfter = pathInspection(record.directoryAfter);
    if (directoryBefore.kind !== 'directory' || directoryAfter.kind !== 'directory'
      || !sameDirectoryIdentity(directoryBefore, directoryAfter)
      || !sameStableObservation(directoryBefore.object, directoryAfter.object)
      || !sameSecurityObservation(directoryBefore.security, directoryAfter.security)) {
      throw failure(
        'WINDOWS_NATIVE_DIRECTORY_CHANGED',
        'The native stable-directory receipt reports changed directory state.'
      );
    }
    if (!Array.isArray(record.entries) || record.entries.length > maxEntries) invalid();
    const entries = record.entries.map((entry) => directoryEntryObservation(entry));
    for (let index = 0; index < entries.length; index += 1) {
      const current = entries[index]!;
      if (index > 0 && compareUtf16(entries[index - 1]!.name, current.name) >= 0) invalid();
    }
    return { directoryBefore, entries, directoryAfter };
  } catch (error) {
    if (error instanceof BazframeError && error.code === 'WINDOWS_NATIVE_DIRECTORY_CHANGED') throw error;
    throw receiptFailure('Native Windows stable-directory evidence is malformed.', error);
  }
}

function directoryEntryObservation(value: unknown): WindowsDirectoryEntryObservation {
  const record = exactRecord(value, [
    'name', 'fileId', 'size', 'allocationSize', 'creationTime', 'lastWriteTime',
    'changeTime', 'attributes', 'reparseTag', 'directory'
  ], 'directory entry observation');
  const name = directoryEntryName(record.name);
  const attributes = uint32(record.attributes);
  const rawTag = uint32(record.reparseTag);
  const reparseTag = rawTag === 0 ? null : rawTag;
  const directory = boolean(record.directory);
  if (((attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0) !== directory
    || ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) !== (reparseTag !== null)) invalid();
  return {
    name,
    fileId: hex(record.fileId, HEX_128),
    size: hex(record.size, HEX_64),
    allocationSize: hex(record.allocationSize, HEX_64),
    creationTime: hex(record.creationTime, HEX_64),
    lastWriteTime: hex(record.lastWriteTime, HEX_64),
    changeTime: hex(record.changeTime, HEX_64),
    attributes,
    reparseTag,
    directory
  };
}

function directoryEntryName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..'
    || value.includes('\0') || value.includes('\\') || value.includes('/')) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  return value;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function volumeObservation(value: unknown): WindowsVolumeObservation {
  const record = exactRecord(value, [
    'identity', 'filesystemName', 'driveType', 'canonicalVolumeGuidPath', 'remoteDevice'
  ], 'volume observation');
  const identity = hex(record.identity, HEX_64);
  if (record.filesystemName !== 'NTFS' || record.driveType !== 'fixed'
    || record.remoteDevice !== false || typeof record.canonicalVolumeGuidPath !== 'string'
    || !VOLUME_GUID.test(record.canonicalVolumeGuidPath)) invalid();
  return {
    identity,
    filesystemName: 'NTFS',
    driveType: 'fixed',
    canonicalVolumeGuidPath: record.canonicalVolumeGuidPath,
    remoteDevice: false
  };
}

function securityObservation(value: unknown): WindowsSecurityObservation {
  const record = exactRecord(value, [
    'descriptorControl', 'daclPresent', 'daclNull', 'daclDefaulted', 'daclBytes',
    'ownerSid', 'ownerDefaulted', 'groupSid', 'groupDefaulted', 'currentUserSid'
  ], 'security observation');
  if (!(record.daclBytes instanceof Uint8Array) || record.daclBytes.byteLength > 0xffff) invalid();
  return {
    descriptorControl: uint16(record.descriptorControl),
    daclPresent: boolean(record.daclPresent),
    daclNull: boolean(record.daclNull),
    daclDefaulted: boolean(record.daclDefaulted),
    daclBytes: Buffer.from(record.daclBytes),
    ownerSid: canonicalSid(record.ownerSid),
    ownerDefaulted: boolean(record.ownerDefaulted),
    groupSid: canonicalSid(record.groupSid),
    groupDefaulted: boolean(record.groupDefaulted),
    currentUserSid: canonicalSid(record.currentUserSid)
  };
}

function objectObservation(value: unknown): WindowsObjectObservation {
  const record = exactRecord(value, [
    'volumeIdentity', 'fileId', 'size', 'allocationSize', 'numberOfLinks',
    'creationTime', 'lastAccessTime', 'lastWriteTime', 'changeTime', 'attributes',
    'reparseTag', 'deletePending', 'directory'
  ], 'object observation');
  const observation: WindowsObjectObservation = {
    volumeIdentity: hex(record.volumeIdentity, HEX_64),
    fileId: hex(record.fileId, HEX_128),
    size: hex(record.size, HEX_64),
    allocationSize: hex(record.allocationSize, HEX_64),
    numberOfLinks: hex(record.numberOfLinks, HEX_32),
    creationTime: hex(record.creationTime, HEX_64),
    lastAccessTime: hex(record.lastAccessTime, HEX_64),
    lastWriteTime: hex(record.lastWriteTime, HEX_64),
    changeTime: hex(record.changeTime, HEX_64),
    attributes: uint32(record.attributes),
    reparseTag: uint32(record.reparseTag) === 0 ? null : uint32(record.reparseTag),
    deletePending: boolean(record.deletePending),
    directory: boolean(record.directory)
  };
  return observation;
}

function sameDirectoryIdentity(a: WindowsPathInspection, b: WindowsPathInspection): boolean {
  return a.canonicalPath.toLowerCase() === b.canonicalPath.toLowerCase()
    && a.kind === 'directory' && b.kind === 'directory'
    && a.volume.identity === b.volume.identity
    && a.object.volumeIdentity === b.object.volumeIdentity
    && a.object.fileId === b.object.fileId
    && a.object.reparseTag === null && b.object.reparseTag === null
    && !a.object.deletePending && !b.object.deletePending
    && a.object.directory && b.object.directory;
}

function sameSecurityObservation(
  a: WindowsSecurityObservation,
  b: WindowsSecurityObservation
): boolean {
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

function isDirectCanonicalChild(parent: string, child: string, component: string): boolean {
  const separator = parent.endsWith('\\') ? '' : '\\';
  return child.toLowerCase() === `${parent}${separator}${component}`.toLowerCase();
}

function sameStableObservation(a: WindowsObjectObservation, b: WindowsObjectObservation): boolean {
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

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = plainRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid ${label}`);
  }
  return record;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function hex(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
}

function uint16(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff) invalid();
  return value;
}

function uint32(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) invalid();
  return value;
}

function canonicalSid(value: unknown): string {
  if (typeof value !== 'string' || value.length > 184) invalid();
  const parts = /^S-([0-9]+)-([0-9]+)((?:-[0-9]+)+)$/u.exec(value);
  if (parts === null || parts[1] !== '1') invalid();
  const authority = decimal(parts[2]!, 0xffff_ffff_ffffn);
  const subauthorities = parts[3]!.slice(1).split('-');
  if (subauthorities.length === 0 || subauthorities.length > 15
    || subauthorities.some((part) => decimal(part, 0xffff_ffffn) === undefined)
    || authority === undefined) invalid();
  return value;
}

function decimal(value: string, maximum: bigint): bigint | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= maximum ? parsed : undefined;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function requirePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw failure('WINDOWS_NATIVE_PATH_INVALID', 'The native Windows path input is invalid.');
  }
}

function portableComponentKey(value: string): string {
  return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}

function requireFinalComponent(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || value.includes('\\') || value.includes('/')) {
    throw failure('WINDOWS_NATIVE_PATH_INVALID', 'The native Windows final path component is invalid.');
  }
}

function invalid(): never {
  throw new Error('invalid native receipt');
}

function receiptFailure(message: string, cause: unknown): BazframeError {
  if (cause instanceof BazframeError) return cause;
  return failure('WINDOWS_NATIVE_RECEIPT_INVALID', message, cause);
}

function nativeCreationFailure(error: unknown): BazframeError {
  const mapped = nativeOperationFailure(error);
  if (mapped.code !== 'WINDOWS_NATIVE_OPERATION_FAILED') return mapped;
  return failure(
    'WINDOWS_NATIVE_CREATE_AMBIGUOUS',
    'The native Windows private-directory creation outcome is ambiguous; retain and inspect the destination.',
    error
  );
}

function nativeOperationFailure(error: unknown): BazframeError {
  const mapped: Record<string, { code: string; message?: string }> = {
    ERR_WIN32_ACCESS_DENIED: { code: 'WINDOWS_NATIVE_ACCESS_DENIED' },
    ERR_WIN32_ALREADY_EXISTS: { code: 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED' },
    ERR_WIN32_CREATE_AMBIGUOUS: {
      code: 'WINDOWS_NATIVE_CREATE_AMBIGUOUS',
      message: 'The native Windows private-directory creation outcome is ambiguous; retain and inspect the destination.'
    },
    ERR_WIN32_FILESYSTEM_UNSUPPORTED: { code: 'WINDOWS_NATIVE_FILESYSTEM_UNSUPPORTED' },
    ERR_WIN32_ENUMERATION_CHANGED: { code: 'WINDOWS_NATIVE_DIRECTORY_CHANGED' },
    ERR_WIN32_ENUMERATION_INCOMPLETE: { code: 'WINDOWS_NATIVE_ENUMERATION_INCOMPLETE' },
    ERR_WIN32_ENUMERATION_LIMIT: { code: 'WINDOWS_NATIVE_ENUMERATION_LIMIT_EXCEEDED' },
    ERR_WIN32_INVALID_PATH: { code: 'WINDOWS_NATIVE_PATH_INVALID' },
    ERR_WIN32_IO: { code: 'WINDOWS_NATIVE_IO_FAILED' },
    ERR_WIN32_METADATA_UNAVAILABLE: { code: 'WINDOWS_NATIVE_METADATA_UNAVAILABLE' },
    ERR_WIN32_NOT_DIRECTORY: { code: 'WINDOWS_NATIVE_NOT_DIRECTORY' },
    ERR_WIN32_NOT_REGULAR_FILE: { code: 'WINDOWS_NATIVE_NOT_REGULAR_FILE' },
    ERR_WIN32_PATH_NOT_FOUND: { code: 'WINDOWS_NATIVE_PATH_NOT_FOUND' },
    ERR_WIN32_READ_CHANGED: { code: 'WINDOWS_NATIVE_READ_CHANGED' },
    ERR_WIN32_READ_INCOMPLETE: { code: 'WINDOWS_NATIVE_READ_INCOMPLETE' },
    ERR_WIN32_READ_LIMIT: {
      code: 'WINDOWS_NATIVE_READ_LIMIT_EXCEEDED',
      message: 'The Windows file exceeds the Bazframe-supplied stable-read byte bound.'
    },
    ERR_WIN32_REPARSE_REFUSED: { code: 'WINDOWS_NATIVE_REPARSE_REFUSED' },
    ERR_WIN32_SHARING_VIOLATION: { code: 'WINDOWS_NATIVE_SHARING_VIOLATION' },
    ERR_WIN32_UNSUPPORTED_TARGET: { code: 'WINDOWS_NATIVE_TARGET_UNSUPPORTED' },
    ERR_WIN32_VOLUME_NOT_FIXED: { code: 'WINDOWS_NATIVE_VOLUME_NOT_FIXED' },
    ERR_WIN32_VOLUME_REMOTE: { code: 'WINDOWS_NATIVE_VOLUME_REMOTE' }
  };
  const nativeCode = nativeOperationCode(error);
  const result = nativeCode === undefined ? undefined : mapped[nativeCode];
  return failure(
    result?.code ?? 'WINDOWS_NATIVE_OPERATION_FAILED',
    result?.message ?? 'The Bazframe native Windows operation failed without producing admissible evidence.',
    error
  );
}

function nativeOperationCode(error: unknown): string | undefined {
  const direct = errorCode(error);
  if (direct?.startsWith('ERR_WIN32_')) return direct;
  if (error instanceof Error) {
    return /(?:^|\b)(ERR_WIN32_[A-Z0-9_]+):/u.exec(error.message)?.[1];
  }
  return undefined;
}

function failure(code: string, message: string, cause?: unknown): BazframeError {
  return new BazframeError(code, message, cause === undefined ? undefined : { cause });
}
