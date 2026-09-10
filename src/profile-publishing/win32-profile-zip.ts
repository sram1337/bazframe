import { createHash, randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, WindowsPathInspection, WindowsObjectObservation } from '../core/win32-native.js';
import { stableWindowsObjectObservation, stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { enumerateWindowsPrivateDirectory } from '../skills/added-skill-platform-services.js';
import { admitWindowsNamespaceDirectory, admitWindowsPrivateFile, createWindowsPrivateFile, createWindowsPrivateDirectory, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { createCanonicalProfileZip, readProfileZipRangeSource, type ProfileZipRangeSource, type readProfileZip, type writeProfileZip } from './profile-zip.js';

const CHUNK = 1024 * 1024;
const key = (value: string) => value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
export interface WindowsProfileZipIo {
  readInput(path: string, maximum: number): AsyncIterable<Uint8Array>;
  writeExistingFile(path: string, chunks: AsyncIterable<Uint8Array>, maximum: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}
const defaultIo: WindowsProfileZipIo = {
  async *readInput(path, maximum) {
    const handle = await open(path, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) throw refused('input is not a bounded regular file');
      let offset = 0;
      while (offset < Number(before.size)) {
        const buffer = Buffer.alloc(Math.min(CHUNK, Number(before.size) - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) throw refused('input truncated during copying');
        offset += bytesRead; yield buffer.subarray(0, bytesRead);
      }
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw refused('input changed during copying');
    } finally { await handle.close(); }
  },
  async writeExistingFile(path, chunks, maximum) {
    const handle = await open(path, 'r+');
    try {
      let total = 0;
      for await (const chunk of chunks) {
        total += chunk.length;
        if (!Number.isSafeInteger(total) || total > maximum) throw refused('copied bytes exceed the archive ceiling');
        await handle.writeFile(chunk);
      }
      await handle.sync();
    } finally { await handle.close(); }
  },
  rename
};

/** One admitted copied/private archive. Every native range is bounded; observations span the complete parser read. */
export function openWindowsProfileZipRangeSource(backend: BazframeWin32NativeBackend, path: string, maximum: number, privateFile = true): ProfileZipRangeSource {
  const inspect = () => inspectFile(backend, path, privateFile);
  const before = inspect();
  const size = Number(BigInt(`0x${before.object.size}`));
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > capturedProfileLimitPolicy().maxAggregateBytes || size > maximum) throw refused('archive exceeds its byte ceiling');
  const validateInspection = () => { const after = inspect(); if (!exact(before, after)) throw refused('archive object changed between ranges'); };
  async function readRange(offset: number, length: number) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) throw refused('archive range is outside the admitted file');
    validateInspection();
    const chunks: Buffer[] = [];
    for (let position = offset; position < offset + length || (length === 0 && position === offset);) {
      const count = Math.min(CHUNK, offset + length - position);
      const receipt = await backend.readStableFileRange(path, position, count, maximum);
      if (receipt.bytes.length !== count || BigInt(`0x${receipt.byteCount}`) !== BigInt(count)
        || JSON.stringify(stableWindowsObjectObservation(before.object)) !== JSON.stringify(stableWindowsObjectObservation(receipt.before))
        || JSON.stringify(stableWindowsObjectObservation(receipt.before)) !== JSON.stringify(stableWindowsObjectObservation(receipt.after))) throw refused('archive range receipt changed or truncated');
      chunks.push(Buffer.from(receipt.bytes)); position += count;
      if (count === 0) break;
    }
    validateInspection();
    return Buffer.concat(chunks, length);
  }
  return { fileSize: size, readRange, async validate() { await readRange(0, 0); } };
}

/** Internal concrete ZIP effects only; canonical parsing and lifecycle policy stay shared. */
export function createWindowsProfileZipEffects(backend: BazframeWin32NativeBackend, options: { io?: WindowsProfileZipIo; temporaryRoot?: string } = {}): { readZip: typeof readProfileZip; writeZip: typeof writeProfileZip } {
  const io = options.io ?? defaultIo;
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const readZip: typeof readProfileZip = async (input, readOptions = {}) => {
    const policy = capturedProfileLimitPolicy(readOptions.limitPolicy);
    // Sources are untrusted bytes, never managed roots. Local classification admits
    // only ordinary/cloud disk files without requiring trusted source ownership.
    const local = !/^\\\\[^?.]/u.test(input);
    const sourcePath = local ? canonicalPath(win32.resolve(input)) : input;
    if (!local && (win32.normalize(input) !== input || !input.slice(2).split('\\').every(isValidWindowsPathComponent))) throw refused('invalid network byte-source spelling');
    const sourceBefore: WindowsObjectObservation | undefined = local ? backend.inspectZipSource(sourcePath) : undefined;
    const stageName = `bazframe-zip-${randomBytes(16).toString('hex')}`;
    const stage = win32.join(temporaryRoot, stageName);
    createWindowsPrivateDirectory(backend, temporaryRoot, stageName, { parentPolicy: 'namespace' });
    const path = win32.join(stage, 'input.zip');
    const created = createWindowsPrivateFile(backend, stage, 'input.zip');
    let total = 0;
    const digest = createHash('sha256');
    async function* chunks() {
      for await (const value of io.readInput(sourcePath, policy.maxAggregateBytes)) {
        total += value.length;
        if (!Number.isSafeInteger(total) || total > policy.maxAggregateBytes) throw refused('input copy exceeds the archive ceiling');
        digest.update(value); yield value;
      }
    }
    await io.writeExistingFile(path, chunks(), policy.maxAggregateBytes);
    if (sourceBefore !== undefined && JSON.stringify(stableWindowsObjectObservation(sourceBefore)) !== JSON.stringify(stableWindowsObjectObservation(backend.inspectZipSource(sourcePath)))) throw refused('source changed during private copying');
    const copied = inspectFile(backend, path, true);
    if (!sameObject(created, copied)) throw refused('private staging object changed');
    const source = openWindowsProfileZipRangeSource(backend, path, policy.maxAggregateBytes);
    if (source.fileSize !== total || await hashSource(source) !== digest.digest('hex')) throw refused('private input copy did not converge');
    return readProfileZipRangeSource(source, readOptions);
  };
  const writeZip: typeof writeProfileZip = async (output, profile, blobs, writeOptions = {}) => {
    const destination = canonicalPath(win32.resolve(output)), parentPath = win32.dirname(destination), component = win32.basename(destination);
    const policy = capturedProfileLimitPolicy(writeOptions.limitPolicy);
    const parent = admitWindowsNamespaceDirectory(backend, parentPath);
    const expected = await optionalOutput(destination, policy.maxAggregateBytes);
    if (expected !== undefined && writeOptions.overwrite !== true) throw new BazframeError('PROFILE_ZIP_OUTPUT_OCCUPIED', 'Profile ZIP output already exists; use --overwrite to replace it.');
    const archive = await createCanonicalProfileZip(profile, blobs, writeOptions.limitPolicy);
    const candidateName = `.bazframe-zip-${randomBytes(16).toString('hex')}.tmp`, candidatePath = win32.join(parentPath, candidateName);
    const created = createWindowsPrivateFile(backend, parentPath, candidateName, { parentPolicy: 'namespace' });
    await io.writeExistingFile(candidatePath, (async function* () { for (let offset = 0; offset < archive.length; offset += CHUNK) yield archive.subarray(offset, offset + CHUNK); })(), policy.maxAggregateBytes);
    const candidate = await optionalOutput(candidatePath, policy.maxAggregateBytes, true);
    if (candidate === undefined || !sameObject(created, candidate.inspection) || candidate.sha256 !== createHash('sha256').update(archive).digest('hex')) throw refused('ZIP candidate write did not converge');
    if (!sameObject(parent, admitWindowsNamespaceDirectory(backend, parentPath)) || !sameSnapshot(expected, await optionalOutput(destination, policy.maxAggregateBytes)) || !sameSnapshot(candidate, await optionalOutput(candidatePath, policy.maxAggregateBytes, true))) throw refused('ZIP publication baseline changed');
    let rejected = false;
    try {
      if (expected === undefined) await backend.renameFileNoReplace(parentPath, candidateName, component);
      else await io.rename(candidatePath, destination);
    } catch { rejected = true; }
    try {
      if (!sameObject(parent, admitWindowsNamespaceDirectory(backend, parentPath))) throw refused('ZIP parent changed');
      const after = await optionalOutput(destination, policy.maxAggregateBytes), retained = await optionalOutput(candidatePath, policy.maxAggregateBytes, true);
      if (after !== undefined && retained === undefined && sameObject(candidate.inspection, after.inspection) && after.sha256 === candidate.sha256 && after.inspection.object.size === candidate.inspection.object.size) return { path: destination, bytes: archive.length, overwritten: expected !== undefined };
      if (rejected && sameSnapshot(expected, after) && sameSnapshot(candidate, retained)) throw new BazframeError('WINDOWS_PROFILE_ZIP_NO_EFFECT', `ZIP publication had no effect; private candidate retained at ${candidatePath}.`);
    } catch (error) {
      if (errorCode(error) === 'WINDOWS_PROFILE_ZIP_NO_EFFECT') throw error;
      throw new BazframeError('WINDOWS_PROFILE_ZIP_AMBIGUOUS', `ZIP publication is ambiguous; retain ${candidatePath} and inspect output.`, { cause: error });
    }
    throw new BazframeError('WINDOWS_PROFILE_ZIP_AMBIGUOUS', `ZIP publication is ambiguous; retain ${candidatePath} and inspect output.`);
  };
  async function optionalOutput(path: string, maximum: number, privateFile = false) {
    const parent = win32.dirname(path), name = win32.basename(path);
    const namespace = await enumerateWindowsPrivateDirectory(backend, parent, capturedProfileLimitPolicy().maxEntries, admitWindowsNamespaceDirectory);
    const matches = namespace.names.filter((entry) => key(entry) === key(name));
    if (!matches.length) return undefined;
    if (matches.length !== 1 || matches[0] !== name) throw refused('ZIP output is aliased');
    const inspection = inspectFile(backend, path, privateFile);
    const source = openWindowsProfileZipRangeSource(backend, path, maximum, privateFile);
    const sha256 = await hashSource(source);
    if (!exact(inspection, inspectFile(backend, path, privateFile))) throw refused('ZIP output changed');
    return { inspection, sha256 };
  }
  return { readZip, writeZip };
}
async function hashSource(source: ProfileZipRangeSource): Promise<string> {
  const hash = createHash('sha256');
  for (let offset = 0; offset < source.fileSize; offset += CHUNK) hash.update(await source.readRange(offset, Math.min(CHUNK, source.fileSize - offset)));
  await source.validate(); return hash.digest('hex');
}
function canonicalPath(path: string): string {
  if (!/^[A-Za-z]:\\/u.test(path) || path !== win32.normalize(path) || !path.slice(3).split('\\').every(isValidWindowsPathComponent)) throw refused('ZIP path is not canonical local Windows spelling');
  return path;
}
function inspectFile(backend: BazframeWin32NativeBackend, path: string, privateFile: boolean): WindowsPathInspection {
  canonicalPath(path);
  const parent = admitWindowsNamespaceDirectory(backend, win32.dirname(path));
  const value = privateFile ? admitWindowsPrivateFile(backend, path, { parentPolicy: 'namespace' }) : backend.inspectPath(path);
  if (value.kind !== 'regular-file' || value.object.directory || value.object.reparseTag !== null || value.object.deletePending || value.object.numberOfLinks !== '00000001' || !value.ancestryReparseFree || value.canonicalPath !== win32.join(parent.canonicalPath, win32.basename(path))) throw refused('ZIP file is unsafe or aliased');
  return value;
}
function sameObject(a: WindowsPathInspection, b: WindowsPathInspection): boolean { return a.kind === b.kind && a.object.volumeIdentity === b.object.volumeIdentity && a.object.fileId === b.object.fileId && a.object.creationTime === b.object.creationTime && a.object.numberOfLinks === b.object.numberOfLinks && a.object.attributes === b.object.attributes && JSON.stringify(a.security) === JSON.stringify(b.security); }
function exact(a: WindowsPathInspection, b: WindowsPathInspection): boolean { return JSON.stringify(stableWindowsPathInspection(a)) === JSON.stringify(stableWindowsPathInspection(b)); }
function sameSnapshot(a: { inspection: WindowsPathInspection; sha256: string } | undefined, b: { inspection: WindowsPathInspection; sha256: string } | undefined): boolean { return a === undefined || b === undefined ? a === b : a.sha256 === b.sha256 && exact(a.inspection, b.inspection); }
function refused(detail: string): BazframeError { return new BazframeError('WINDOWS_PROFILE_ZIP_REFUSED', `Windows ZIP effects refused: ${detail}. Private staging is retained; no cleanup was attempted.`); }
