import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { profilePublishingBlobRoot } from '../state/paths.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { assertOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from './profile-operation-lock.js';
import { assertStablePhysicalDirectory, openStablePhysicalDirectory, readStablePhysicalFile, stableReadChildPath } from './profile-filesystem.js';

const SHA = /^[a-f0-9]{64}$/u;
export function blobPath(home:string,sha256:string):string{if(!SHA.test(sha256))throw invalid('blob digest is invalid');return join(profilePublishingBlobRoot(home),sha256);}

export interface BlobStoreEffects {
  join(...parts: string[]): string;
  ensureDirectory(home: string, path: string): Promise<void>;
  writeTemporary(path: string, bytes: Uint8Array): Promise<void>;
  publish(temporary: string, destination: string): Promise<void>;
  read(path: string, max: number, home: string): Promise<Buffer>;
  occupied(error: unknown): boolean;
  siblingTemporary: boolean;
}
const defaultBlobEffects: BlobStoreEffects = {
  join, ensureDirectory: ensureManagedDirectory, siblingTemporary: false,
  async writeTemporary(path, bytes) { const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } },
  async publish(temporary, destination) { await link(temporary, destination); await syncDirectory(join(destination, '..')); },
  async read(path, max, home) { const root = await openStablePhysicalDirectory(join(path, '..'), home); try { const file = await readStablePhysicalFile(stableReadChildPath(root, path.split('/').at(-1)!), max); await assertStablePhysicalDirectory(root); return file.bytes; } finally { await root.handle.close().catch(() => undefined); } },
  occupied: (error) => errorCode(error) === 'EEXIST'
};
export async function publishStoredBlob(home: string, authority: OperationMutationAuthority, bytes: Uint8Array, expectedSha256: string, lower: Partial<CapturedProfileLimitPolicy> = {}, effects: BlobStoreEffects = defaultBlobEffects): Promise<{ sha256: string; bytes: number; reused: boolean }> {
  const policy = capturedProfileLimitPolicy(lower);
  const value = Buffer.from(bytes);
  if (!SHA.test(expectedSha256) || value.length > policy.maxBlobBytes || digest(value) !== expectedSha256) throw invalid('blob bytes do not match the expected bounded digest');
  const transactionId = operationAuthorityTransactionId(authority);
  const assertHeld = () => assertOperationMutationAuthority(authority, home, ['@store'], transactionId);
  assertHeld();
  const root = effects.join(home, 'profile-publishing', 'blobs');
  const staging = effects.siblingTemporary ? root : effects.join(home, 'profile-publishing', 'staging', transactionId);
  await effects.ensureDirectory(home, root); await effects.ensureDirectory(home, staging);
  const temporary = effects.join(staging, `.blob-${randomBytes(16).toString('hex')}`);
  assertHeld(); await effects.writeTemporary(temporary, value); assertHeld();
  let reused = false;
  try { await effects.publish(temporary, effects.join(root, expectedSha256)); }
  catch (error) {
    if (!effects.occupied(error)) throw error;
    const occupied = await readStoredBlob(home, expectedSha256, policy, effects);
    if (!occupied.equals(value)) throw invalid('occupied blob bytes differ');
    reused = true;
  }
  assertHeld();
  if (!(await readStoredBlob(home, expectedSha256, policy, effects)).equals(value)) throw invalid('published blob bytes differ');
  return { sha256: expectedSha256, bytes: value.length, reused };
}
export async function readStoredBlob(home: string, sha256: string, lower: Partial<CapturedProfileLimitPolicy> = {}, effects: BlobStoreEffects = defaultBlobEffects): Promise<Buffer> {
  if (!SHA.test(sha256)) throw invalid('blob digest is invalid');
  const policy = capturedProfileLimitPolicy(lower);
  let bytes: Buffer;
  try { bytes = await effects.read(effects.join(home, 'profile-publishing', 'blobs', sha256), policy.maxBlobBytes, home); }
  catch (error) { if (errorCode(error) === 'ENOENT' || errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND' || error instanceof BazframeError && errorCode(error.cause) === 'ENOENT') throw new BazframeError('PROFILE_BLOB_ABSENT', 'Profile blob is absent.', { cause: error }); throw error; }
  if (bytes.length > policy.maxBlobBytes || digest(bytes) !== sha256) throw invalid('stored blob digest is invalid');
  return bytes;
}

export async function assertStoredBlob(home:string,sha256:string,expectedBytes:number,lower:Partial<CapturedProfileLimitPolicy>={}):Promise<void>{const bytes=await readStoredBlob(home,sha256,lower);if(bytes.byteLength!==expectedBytes)throw invalid('stored blob size is invalid');}
async function syncDirectory(path:string):Promise<void>{const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
function digest(bytes:Uint8Array):string{return createHash('sha256').update(bytes).digest('hex');}
function invalid(detail:string):BazframeError{return new BazframeError('PROFILE_BLOB_INVALID',`Invalid profile blob: ${detail}.`);}
