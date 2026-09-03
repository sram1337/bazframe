import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import {
  createCanonicalProfileZip,
  defaultProfileZipPath,
  readProfileZip,
  writeProfileZip,
  type ProfileZipBlob
} from '../../../src/profile-publishing/profile-zip.js';
import { capturedResourceId, ordinaryResourceIdentity, type CapturedProfileV1 } from '../../../src/profile-publishing/captured-profile.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });

function blob(text: string): ProfileZipBlob {
  const bytesValue = Buffer.from(text);
  return { sha256: createHash('sha256').update(bytesValue).digest('hex'), bytes: bytesValue.byteLength, bytesValue };
}

function fixture(twoBlobs = false): { profile: CapturedProfileV1; blobs: ProfileZipBlob[] } {
  const instructions = blob('portable\n');
  return {
    profile: {
      schemaVersion: 1,
      kind: 'bazframe-captured-profile',
      profile: { name: 'portable', instructions: { path: 'AGENTS.md', sha256: instructions.sha256, bytes: instructions.bytes, executable: false } },
      resources: twoBlobs ? [{
        id: capturedResourceId('skill', ordinaryResourceIdentity('skill', 'review')),
        key: { kind: 'skill', name: 'review' },
        payload: { kind: 'bundled', role: 'skill', files: [{ path: 'SKILL.md', sha256: blob('skill\n').sha256, bytes: blob('skill\n').bytes, executable: false }] }
      }] : [],
      blobs: (twoBlobs ? [instructions, blob('skill\n')] : [instructions]).map(({ sha256, bytes }) => ({ sha256, bytes })).sort((left, right) => left.sha256.localeCompare(right.sha256))
    },
    blobs: (twoBlobs ? [instructions, blob('skill\n')] : [instructions]).sort((left, right) => left.sha256.localeCompare(right.sha256))
  };
}

async function archivePath(bytes: Uint8Array): Promise<string> {
  temporary ??= await createTempDirectory('/tmp/bzf-zip-');
  const path = temporary.path('profile.zip');
  await writeFile(path, bytes);
  return path;
}

function centralOffset(bytes: Buffer): number {
  const offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (offset < 0) throw new Error('central directory absent');
  return offset;
}

function dataOffset(bytes: Buffer, localOffset = 0): number {
  return localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
}

function duplicateSecondBlobName(archive: Buffer, caseOnly = false): Buffer {
  const value = Buffer.from(archive);
  const locals: number[] = [];
  let local = 0;
  while (value.readUInt32LE(local) === 0x04034b50) {
    locals.push(local);
    local = dataOffset(value, local) + value.readUInt32LE(local + 18);
  }
  const centrals: number[] = [];
  let central = centralOffset(value);
  while (value.readUInt32LE(central) === 0x02014b50) {
    centrals.push(central);
    central += 46 + value.readUInt16LE(central + 28) + value.readUInt16LE(central + 30) + value.readUInt16LE(central + 32);
  }
  const firstLocal = locals[1]!, secondLocal = locals[2]!, firstCentral = centrals[1]!, secondCentral = centrals[2]!;
  const length = value.readUInt16LE(firstLocal + 26);
  if (length !== value.readUInt16LE(secondLocal + 26)) throw new Error('blob entry lengths differ');
  const name = Buffer.from(value.subarray(firstLocal + 30, firstLocal + 30 + length));
  if (caseOnly) name[0] = 0x42;
  name.copy(value, secondLocal + 30);
  name.copy(value, secondCentral + 46);
  if (!caseOnly) value.subarray(firstCentral + 46, firstCentral + 46 + length).copy(value, secondCentral + 46);
  return value;
}

function replaceFirstEntryName(archive: Buffer, prefix: string): Buffer {
  const value = Buffer.from(archive);
  const length = value.readUInt16LE(26);
  const name = Buffer.from(prefix.padEnd(length, 'x').slice(0, length));
  if (name.byteLength !== length) throw new Error('hostile name length mismatch');
  name.copy(value, 30);
  name.copy(value, centralOffset(value) + 46);
  return value;
}

describe('canonical profile ZIP', () => {
  it('writes deterministic STORE archives and reads exact manifest/blob closure', async () => {
    const { profile, blobs } = fixture();
    const first = await createCanonicalProfileZip(profile, blobs);
    const second = await createCanonicalProfileZip(profile, blobs);
    expect(first).toEqual(second);
    expect(first.readUInt32LE(0)).toBe(0x04034b50);
    expect(first.readUInt16LE(6)).toBe(0x0800);
    expect(first.readUInt16LE(8)).toBe(0);
    expect(first.readUInt16LE(10)).toBe(0);
    expect(first.readUInt16LE(12)).toBe(0x21);
    const snapshot = await readProfileZip(await archivePath(first));
    expect(snapshot.profile).toEqual(profile);
    expect(snapshot.manifestBytes.at(-1)).toBe(0x0a);
    expect(snapshot.blobs[0]!.bytesValue).toEqual(Buffer.from('portable\n'));
    expect(snapshot.archiveBytes).toBe(first.byteLength);
  });

  it('writes atomically and requires explicit overwrite', async () => {
    temporary = await createTempDirectory('/tmp/bzf-zip-');
    const { profile, blobs } = fixture();
    const output = temporary.path('portable.bazframe-profile.zip');
    await writeFile(output, 'occupied');
    await expect(writeProfileZip(output, profile, blobs)).rejects.toMatchObject({ code: 'PROFILE_ZIP_OUTPUT_OCCUPIED' });
    expect(await readFile(output, 'utf8')).toBe('occupied');
    const written = await writeProfileZip(output, profile, blobs, { overwrite: true });
    expect(written.overwritten).toBe(true);
    expect((await readProfileZip(output)).profile).toEqual(profile);
    expect(defaultProfileZipPath('portable', temporary.root)).toBe(output);
  });

  it('removes the temporary sibling before successful new-output publication completes', async () => {
    temporary = await createTempDirectory('/tmp/bzf-zip-');
    const { profile, blobs } = fixture();
    await writeProfileZip(temporary.path('new.bazframe-profile.zip'), profile, blobs);
    expect(await readdir(temporary.root)).toEqual(['new.bazframe-profile.zip']);
  });

  it.each([
    ['prepended data', (archive: Buffer) => Buffer.concat([Buffer.from([0]), archive])],
    ['appended data', (archive: Buffer) => Buffer.concat([archive, Buffer.from([0])])],
    ['data descriptor flag', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt16LE(0x0808, 6); value.writeUInt16LE(0x0808, centralOffset(value) + 8); return value; }],
    ['noncanonical central mode', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt32LE((0o100644 << 16) >>> 0, centralOffset(value) + 38); return value; }],
    ['multi-disk entry metadata', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt16LE(1, centralOffset(value) + 34); return value; }],
    ['local-central disagreement', (archive: Buffer) => { const value = Buffer.from(archive); value[30] = 0x78; return value; }],
    ['corrupt body CRC', (archive: Buffer) => { const value = Buffer.from(archive); value[dataOffset(value)]! ^= 1; return value; }],
    ['traversal name', (archive: Buffer) => replaceFirstEntryName(archive, '../evil/')],
    ['absolute name', (archive: Buffer) => replaceFirstEntryName(archive, '/absolute/')],
    ['drive-absolute name', (archive: Buffer) => replaceFirstEntryName(archive, 'C:/evil/')],
    ['backslash name', (archive: Buffer) => replaceFirstEntryName(archive, 'bad\\name/')],
    ['NUL name', (archive: Buffer) => { const value = Buffer.from(archive); value[30] = 0x00; value[centralOffset(value) + 46] = 0x00; return value; }],
    ['control-character name', (archive: Buffer) => { const value = Buffer.from(archive); value[30] = 0x1f; value[centralOffset(value) + 46] = 0x1f; return value; }],
    ['invalid UTF-8 name', (archive: Buffer) => { const value = Buffer.from(archive); value[30] = 0xff; value[centralOffset(value) + 46] = 0xff; return value; }],
    ['missing UTF-8 flags', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt16LE(0, 6); value.writeUInt16LE(0, centralOffset(value) + 8); return value; }],
    ['unsupported compression', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt16LE(8, 8); value.writeUInt16LE(8, centralOffset(value) + 10); return value; }],
    ['encrypted entry flag', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt16LE(0x0801, 6); value.writeUInt16LE(0x0801, centralOffset(value) + 8); return value; }],
    ['symbolic-link external mode', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt32LE((0o120777 << 16) >>> 0, centralOffset(value) + 38); return value; }],
    ['directory external mode', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt32LE((0o040755 << 16) >>> 0, centralOffset(value) + 38); return value; }],
    ['special-device external mode', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt32LE((0o020600 << 16) >>> 0, centralOffset(value) + 38); return value; }],
    ['local-central size disagreement', (archive: Buffer) => { const value = Buffer.from(archive); value.writeUInt32LE(value.readUInt32LE(22) + 1, 22); return value; }],
    ['overlapping local ranges', (archive: Buffer) => { const value = Buffer.from(archive); const second = value.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), centralOffset(value) + 4); value.writeUInt32LE(0, second + 42); return value; }]
  ])('rejects %s', async (_label, corrupt) => {
    const { profile, blobs } = fixture();
    const archive = await createCanonicalProfileZip(profile, blobs);
    await expect(readProfileZip(await archivePath(corrupt(archive)))).rejects.toMatchObject({ code: 'PROFILE_ZIP_INVALID' });
  });

  it.each([
    ['duplicate entries', false],
    ['portable case-colliding entries', true]
  ] as const)('rejects %s', async (_label, caseOnly) => {
    const { profile, blobs } = fixture(true);
    const archive = await createCanonicalProfileZip(profile, blobs);
    await expect(readProfileZip(await archivePath(duplicateSecondBlobName(archive, caseOnly)))).rejects.toMatchObject({ code: 'PROFILE_ZIP_INVALID' });
  });

  it('rejects unknown entries even when local and central names agree', async () => {
    const { profile, blobs } = fixture();
    const archive = await createCanonicalProfileZip(profile, blobs);
    const value = Buffer.from(archive);
    const blobName = `blobs/${blobs[0]!.sha256}`;
    const firstBlobLocal = dataOffset(value) + value.readUInt32LE(18);
    const localNameOffset = firstBlobLocal + 30;
    const secondCentral = value.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), centralOffset(value) + 4);
    expect(value.subarray(localNameOffset, localNameOffset + blobName.length).toString()).toBe(blobName);
    value[localNameOffset] = 0x78;
    value[secondCentral + 46] = 0x78;
    await expect(readProfileZip(await archivePath(value))).rejects.toMatchObject({ code: 'PROFILE_ZIP_INVALID' });
  });

  it('enforces archive, manifest, entry, and extracted aggregate bounds without writes', async () => {
    const { profile, blobs } = fixture();
    const archive = await createCanonicalProfileZip(profile, blobs);
    const path = await archivePath(archive);
    const before = await readFile(path);
    await expect(readProfileZip(path, { limitPolicy: { maxAggregateBytes: archive.byteLength - 1 } })).rejects.toMatchObject({ code: 'PROFILE_ZIP_INVALID' });
    await expect(readProfileZip(path, { limitPolicy: { maxManifestBytes: Buffer.byteLength(JSON.stringify(profile)) } })).rejects.toBeDefined();
    await expect(readProfileZip(path, { limitPolicy: { maxBlobBytes: blobs[0]!.bytes - 1 } })).rejects.toBeDefined();
    await expect(readProfileZip(path, { limitPolicy: { maxEntries: 1 } })).rejects.toBeDefined();
    expect(await readFile(path)).toEqual(before);
  });

  it('rejects missing, reordered, and corrupt blob sources before writing', async () => {
    const { profile, blobs } = fixture();
    await expect(createCanonicalProfileZip(profile, [])).rejects.toMatchObject({ code: 'PROFILE_ZIP_INVALID' });
    await expect(createCanonicalProfileZip(profile, [{ ...blobs[0]!, bytesValue: Buffer.from('changed') }])).rejects.toBeDefined();
  });
});
