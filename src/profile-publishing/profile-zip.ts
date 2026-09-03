import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { ZipFile as ZipWriter } from 'yazl';
import { fromFdPromise, type Entry, type LocalFileHeader, type ZipFile } from 'yauzl';
import { BazframeError, errorCode } from '../core/errors.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import {
  assertBlobBytes,
  decodeCapturedProfileBytes,
  decodeCapturedProfileObject,
  encodeCapturedProfile,
  type CapturedProfileV1,
  type Sha256
} from './captured-profile.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';

export interface ProfileZipBlob {
  sha256: Sha256;
  bytes: number;
  bytesValue: Uint8Array;
}

export interface ProfileZipSnapshot {
  profile: CapturedProfileV1;
  manifestBytes: Buffer;
  blobs: Array<{ sha256: Sha256; bytes: number; bytesValue: Buffer }>;
  archiveBytes: number;
}

export interface ProfileZipReadOptions {
  limitPolicy?: Partial<CapturedProfileLimitPolicy>;
}

export interface ProfileZipWriteOptions {
  overwrite?: boolean;
  limitPolicy?: Partial<CapturedProfileLimitPolicy>;
}

const MANIFEST_NAME = 'bazframe-profile.json';
const BLOB_NAME = /^blobs\/([a-f0-9]{64})$/u;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 63;
const FIXED_DOS_DATE = 0x21;
const FIXED_DOS_TIME = 0;
const FIXED_MODE = 0o100600;
const FIXED_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const DRIVE_PREFIX = /^[A-Za-z]:/u;

export function defaultProfileZipPath(profileName: string, directory = process.cwd()): string {
  if (!isSafeProfileId(profileName)) throw invalid('profile name is invalid');
  return resolve(directory, `${profileName}.bazframe-profile.zip`);
}

export async function createCanonicalProfileZip(
  profile: CapturedProfileV1,
  blobs: readonly ProfileZipBlob[],
  lowerLimits: Partial<CapturedProfileLimitPolicy> = {}
): Promise<Buffer> {
  const policy = capturedProfileLimitPolicy(lowerLimits);
  let source: ReturnType<typeof validateSource>;
  try { source = validateSource(profile, blobs, policy); }
  catch (error) { if (error instanceof BazframeError && error.code === 'PROFILE_ZIP_INVALID') throw error; throw invalid('capture source is invalid', error); }
  const writer = new ZipWriter();
  const chunks: Buffer[] = [];
  let total = 0;
  const output = writer.outputStream as Readable;
  const completed = new Promise<Buffer>((resolveOutput, reject) => {
    output.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > policy.maxAggregateBytes) {
        output.destroy(invalid('archive exceeds its input-byte limit'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    output.once('error', reject);
    output.once('end', () => resolveOutput(Buffer.concat(chunks, total)));
  });
  const options = { compress: false, forceZip64Format: false, forceDosTimestamp: true, mtime: FIXED_MTIME, mode: FIXED_MODE };
  writer.addBuffer(source.manifestBytes, MANIFEST_NAME, options);
  for (const blob of source.blobs) writer.addBuffer(blob.bytesValue, `blobs/${blob.sha256}`, options);
  writer.end({ forceZip64Format: false, comment: '' });
  try { return await completed; }
  catch (error) { if (error instanceof BazframeError) throw error; throw invalid('archive creation failed', error); }
}

export async function writeProfileZip(
  outputPath: string,
  profile: CapturedProfileV1,
  blobs: readonly ProfileZipBlob[],
  options: ProfileZipWriteOptions = {}
): Promise<{ path: string; bytes: number; overwritten: boolean }> {
  const destination = resolve(outputPath);
  const parent = dirname(destination);
  const archive = await createCanonicalProfileZip(profile, blobs, options.limitPolicy);
  const temporary = join(parent, `.${basename(destination)}.${randomBytes(16).toString('hex')}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    temporaryCreated = true;
    try { await handle.writeFile(archive); await handle.sync(); } finally { await handle.close(); }
    let occupied = false;
    try {
      const metadata = await lstat(destination, { bigint: true });
      occupied = true;
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new BazframeError('PROFILE_ZIP_OUTPUT_OCCUPIED', 'Profile ZIP output is occupied by a non-file or link.');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    if (occupied && options.overwrite !== true) throw new BazframeError('PROFILE_ZIP_OUTPUT_OCCUPIED', 'Profile ZIP output already exists; use --overwrite to replace it.');
    if (occupied) {
      await rename(temporary, destination);
      temporaryCreated = false;
    } else {
      try { await link(temporary, destination); }
      catch (error) {
        if (errorCode(error) === 'EEXIST') throw new BazframeError('PROFILE_ZIP_OUTPUT_OCCUPIED', 'Profile ZIP output already exists; use --overwrite to replace it.');
        throw error;
      }
      await rm(temporary);
      temporaryCreated = false;
    }
    await syncDirectory(parent);
    return { path: destination, bytes: archive.byteLength, overwritten: occupied };
  } finally {
    if (temporaryCreated) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readProfileZip(path: string, options: ProfileZipReadOptions = {}): Promise<ProfileZipSnapshot> {
  const policy = capturedProfileLimitPolicy(options.limitPolicy);
  let handle: FileHandle | undefined;
  let zip: ZipFile | undefined;
  try {
    handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(policy.maxAggregateBytes)) throw invalid('archive is not a bounded physical file');
    const fileSize = Number(before.size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 22) throw invalid('archive size is invalid');
    const eocd = await readExactly(handle, fileSize - 22, 22);
    const directory = decodeEndOfCentralDirectory(eocd, fileSize);
    const first = await readExactly(handle, 0, 4);
    if (first.readUInt32LE(0) !== LOCAL_SIGNATURE) throw invalid('archive contains prepended bytes or no local header');
    zip = await fromFdPromise(handle.fd, { autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
    if (zip.comment !== '' || zip.entryCount !== directory.entryCount || zip.entryCount === 0 || zip.entryCount > policy.maxEntries) throw invalid('archive central directory is not canonical');

    const entries: Entry[] = [];
    for await (const entry of zip.eachEntry()) entries.push(entry);
    if (entries.length !== zip.entryCount) throw invalid('archive entry count changed');
    const expectedNames = [MANIFEST_NAME];
    let previousEnd = 0;
    let extractedBytes = 0;
    let manifestBytes: Buffer | undefined;
    const bodyByName = new Map<string, Buffer>();
    const portableNames = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      validateCentralEntry(entry, policy);
      if (index === 0 && entry.fileName !== MANIFEST_NAME) throw invalid('manifest must be the first archive entry');
      const collisionKey = portableCollisionKey(entry.fileName);
      if (portableNames.has(collisionKey)) throw invalid('archive entry names collide');
      portableNames.add(collisionKey);
      const local = await zip.readLocalFileHeaderPromise(entry);
      validateLocalHeader(entry, local);
      if (entry.relativeOffsetOfLocalHeader !== previousEnd) throw invalid('archive entries overlap or contain gaps');
      const dataEnd = local.fileDataStart + entry.compressedSize;
      if (dataEnd > directory.centralOffset) throw invalid('archive entry extends outside its body');
      previousEnd = dataEnd;
      const maximum = entry.fileName === MANIFEST_NAME ? policy.maxManifestBytes : policy.maxBlobBytes;
      const body = await readEntry(zip, entry, maximum);
      extractedBytes += body.byteLength;
      if (!Number.isSafeInteger(extractedBytes) || extractedBytes > policy.maxAggregateBytes) throw invalid('extracted bytes exceed their aggregate limit');
      if (crc32(body) !== entry.crc32) throw invalid('archive entry CRC does not match');
      bodyByName.set(entry.fileName, body);
      if (entry.fileName === MANIFEST_NAME) {
        manifestBytes = body;
        const decoded = decodeCapturedProfileBytes(body, policy);
        expectedNames.push(...decoded.blobs.map((blob) => `blobs/${blob.sha256}`));
      }
    }
    if (previousEnd !== directory.centralOffset) throw invalid('archive body and central directory are not contiguous');
    validateRawCentralDirectory(await readExactly(handle, directory.centralOffset, directory.centralSize), entries);
    if (manifestBytes === undefined) throw invalid('archive manifest is missing');
    const profile = decodeCapturedProfileBytes(manifestBytes, policy);
    if (entries.length !== expectedNames.length || entries.some((entry, index) => entry.fileName !== expectedNames[index])) throw invalid('archive entries do not match the manifest closure and order');
    const blobs = profile.blobs.map((record) => {
      const bytesValue = bodyByName.get(`blobs/${record.sha256}`);
      if (bytesValue === undefined || bytesValue.byteLength !== record.bytes) throw invalid('archive blob size does not match the manifest');
      assertBlobBytes(record, bytesValue);
      return { sha256: record.sha256, bytes: record.bytes, bytesValue: Buffer.from(bytesValue) };
    });
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw invalid('archive changed while being read');
    return { profile, manifestBytes: Buffer.from(manifestBytes), blobs, archiveBytes: fileSize };
  } catch (error) {
    if (error instanceof BazframeError && error.code === 'PROFILE_ZIP_INVALID') throw error;
    throw invalid('archive is malformed or unreadable', error);
  } finally {
    // fromFdPromise is opened with autoClose:false; the FileHandle remains the sole fd owner.
    await handle?.close().catch(() => undefined);
  }
}

function validateSource(profile: CapturedProfileV1, blobs: readonly ProfileZipBlob[], policy: Readonly<CapturedProfileLimitPolicy>): { manifestBytes: Buffer; blobs: Array<{ sha256: Sha256; bytes: number; bytesValue: Buffer }> } {
  const validated = decodeCapturedProfileObject(profile, policy);
  const manifestBytes = Buffer.from(encodeCapturedProfile(validated, policy));
  const expected = validated.blobs;
  if (blobs.length !== expected.length) throw invalid('blob source closure does not match the manifest');
  const normalized = blobs.map((blob, index) => {
    const record = expected[index];
    if (record === undefined || blob.sha256 !== record.sha256 || blob.bytes !== record.bytes) throw invalid('blob sources must match manifest order and sizes');
    assertBlobBytes(record, blob.bytesValue);
    return { sha256: record.sha256, bytes: record.bytes, bytesValue: Buffer.from(blob.bytesValue) };
  });
  if (expected.length + 1 > policy.maxEntries) throw invalid('archive entry count exceeds its limit');
  return { manifestBytes, blobs: normalized };
}

function validateCentralEntry(entry: Entry, policy: Readonly<CapturedProfileLimitPolicy>): void {
  if (entry.generalPurposeBitFlag !== UTF8_FLAG || entry.compressionMethod !== 0 || entry.versionNeededToExtract !== VERSION_NEEDED || entry.versionMadeBy !== VERSION_MADE_BY) throw invalid('archive entry flags, method, or version are not canonical');
  if (entry.lastModFileDate !== FIXED_DOS_DATE || entry.lastModFileTime !== FIXED_DOS_TIME) throw invalid('archive entry timestamp is not canonical');
  if (entry.extraFieldLength !== 0 || entry.extraFieldRaw.byteLength !== 0 || entry.fileCommentLength !== 0 || entry.fileCommentRaw.byteLength !== 0 || entry.fileComment !== '') throw invalid('archive entry extras or comments are forbidden');
  if (entry.internalFileAttributes !== 0 || (entry.externalFileAttributes >>> 16) !== FIXED_MODE || (entry.externalFileAttributes & 0xffff) !== 0) throw invalid('archive entry mode is not canonical regular-file metadata');
  if (!safeArchiveName(entry.fileName, policy) || !entry.fileNameRaw.equals(Buffer.from(entry.fileName, 'utf8'))) throw invalid('archive entry name is invalid or noncanonical UTF-8');
  if (entry.compressedSize !== entry.uncompressedSize || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > policy.maxBlobBytes) throw invalid('archive entry size is invalid');
  if (entry.fileName === MANIFEST_NAME) {
    if (entry.uncompressedSize > policy.maxManifestBytes) throw invalid('archive manifest exceeds its limit');
  } else if (BLOB_NAME.exec(entry.fileName) === null) throw invalid('archive contains an unknown entry');
}

function validateLocalHeader(entry: Entry, local: LocalFileHeader): void {
  if (local.versionNeededToExtract !== entry.versionNeededToExtract || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag || local.compressionMethod !== entry.compressionMethod || local.lastModFileTime !== entry.lastModFileTime || local.lastModFileDate !== entry.lastModFileDate || local.crc32 !== entry.crc32 || local.compressedSize !== entry.compressedSize || local.uncompressedSize !== entry.uncompressedSize || local.extraFieldLength !== 0 || local.extraField.byteLength !== 0 || !local.fileName.equals(entry.fileNameRaw)) throw invalid('local and central entry headers disagree');
}

function validateRawCentralDirectory(bytes: Buffer, entries: readonly Entry[]): void {
  let offset = 0;
  for (const entry of entries) {
    if (offset + 46 > bytes.byteLength || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw invalid('central directory record is malformed');
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const diskNumberStart = bytes.readUInt16LE(offset + 34);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > bytes.byteLength || extraLength !== 0 || commentLength !== 0 || diskNumberStart !== 0) throw invalid('central directory contains unsupported or multi-disk data');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (!rawName.equals(entry.fileNameRaw)) throw invalid('central directory filename changed');
    offset += recordLength;
  }
  if (offset !== bytes.byteLength) throw invalid('central directory contains trailing or unknown records');
}

function decodeEndOfCentralDirectory(bytes: Buffer, fileSize: number): { entryCount: number; centralSize: number; centralOffset: number } {
  if (bytes.readUInt32LE(0) !== EOCD_SIGNATURE) throw invalid('archive has a comment, appended bytes, ZIP64, or no canonical end record');
  const disk = bytes.readUInt16LE(4);
  const centralDisk = bytes.readUInt16LE(6);
  const entriesOnDisk = bytes.readUInt16LE(8);
  const entryCount = bytes.readUInt16LE(10);
  const centralSize = bytes.readUInt32LE(12);
  const centralOffset = bytes.readUInt32LE(16);
  const commentLength = bytes.readUInt16LE(20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || commentLength !== 0 || centralOffset + centralSize !== fileSize - 22) throw invalid('archive end record is noncanonical, multi-disk, or ZIP64');
  return { entryCount, centralSize, centralOffset };
}

async function readEntry(zip: ZipFile, entry: Entry, maximum: number): Promise<Buffer> {
  const stream = await zip.openReadStreamPromise(entry, { decodeFileData: false });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (!Number.isSafeInteger(bytes) || bytes > maximum || bytes > entry.uncompressedSize) {
      stream.destroy();
      throw invalid('archive entry exceeds its declared or configured size');
    }
    chunks.push(buffer);
  }
  if (bytes !== entry.uncompressedSize) throw invalid('archive entry ended at an unexpected size');
  return Buffer.concat(chunks, bytes);
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) throw invalid('archive record range is invalid');
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw invalid('archive record is truncated');
    offset += result.bytesRead;
  }
  return buffer;
}

function safeArchiveName(name: string, policy: Readonly<CapturedProfileLimitPolicy>): boolean {
  if (name.length === 0 || name.startsWith('/') || DRIVE_PREFIX.test(name) || name.includes('\\') || name.includes('\0') || Buffer.byteLength(name, 'utf8') > policy.maxPathBytes) return false;
  for (const character of name) {
    const point = character.codePointAt(0)!;
    if (point < 0x20 || point === 0x7f) return false;
  }
  const segments = name.split('/');
  return segments.length <= policy.maxDepth && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function portableCollisionKey(value: string): string {
  return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function invalid(detail: string, cause?: unknown): BazframeError {
  return new BazframeError('PROFILE_ZIP_INVALID', `Invalid Bazframe profile ZIP: ${detail}.`, cause === undefined ? {} : { cause });
}
