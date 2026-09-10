import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';

/** Snapshots are operation-local; constructing services acquires no authority. */
export interface PolicySnapshot { bytes?: Buffer; identity: string }
export interface PolicyServices {
  paths: typeof path;
  snapshot(file: string, maxBytes: number): Promise<PolicySnapshot>;
  entries(directory: string): Promise<string[]>;
  retained(name: string): boolean;
  withLock<T>(home: string, command: string, operation: (writer: PolicyWriter) => Promise<T>): Promise<T>;
}
export interface PolicyWriter {
  assertHeld(): void;
  publish(file: string, bytes: Buffer, expected: PolicySnapshot, maxBytes: number): Promise<void>;
  detach(file: string, expected: PolicySnapshot, maxBytes: number): Promise<void>;
}
export const posixPolicyServices: PolicyServices = {
  paths: path,
  async snapshot(file, maxBytes) {
    let metadata;
    try { metadata = await lstat(file); }
    catch (error) { if (errorCode(error) === 'ENOENT') return { identity: 'absent' }; throw error; }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) throw new BazframeError('POLICY_FILE_INVALID', `Policy must be a bounded physical file: ${file}`);
    const bytes = await readFile(file);
    if (bytes.length > maxBytes) throw new BazframeError('POLICY_FILE_INVALID', `Policy exceeds its byte bound: ${file}`);
    return { bytes, identity: `${metadata.dev}:${metadata.ino}:${metadata.mtimeMs}:${bytes.toString('base64')}` };
  },
  async entries(directory) {
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new BazframeError('REGISTRATION_DIRECTORY_INVALID', `Project-state path must be a physical directory: ${directory}`);
      return (await readdir(directory)).sort();
    } catch (error) { if (errorCode(error) === 'ENOENT') return []; throw error; }
  },
  retained: () => false,
  withLock(home, command, operation) {
    return withStateLock(path.join(home, 'locks', 'state.lock'), { command, target: home }, () => operation({
      assertHeld() {},
      publish: (file, bytes) => writeFileAtomic(file, bytes, { managedRoot: home }),
      detach: (file) => rm(file)
    }), { managedRoot: home });
  }
};
export function policyText(snapshot: PolicySnapshot): string | undefined {
  return snapshot.bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes);
}
