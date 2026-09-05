import { randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { BazframeWin32NativeBackend, WindowsPathInspection } from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { decodeActiveProfileState, MAX_ACTIVE_PROFILE_STATE_BYTES } from '../profiles/profile-store.js';
import { readWindowsPrivateFileSnapshot, readWindowsSelectionSnapshot, type WindowsSelectionSnapshot } from '../profiles/win32-profile-selection.js';
import { admitWindowsPrivateDirectory, createWindowsPrivateFile } from './win32-private-directory.js';

export interface WindowsSelectionPublicationIo {
  writeExistingFile(path: string, bytes: Uint8Array): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}
export interface WindowsSelectionPublicationHooks {
  afterPrivateCreation?(): void | Promise<void>;
  afterCandidateRead?(): void | Promise<void>;
  beforeReplacement?(): void | Promise<void>;
  afterReplacement?(): void | Promise<void>;
}
export interface WindowsSelectionPublicationOptions {
  backend: BazframeWin32NativeBackend;
  home: string;
  expected: WindowsSelectionSnapshot;
  bytes: Uint8Array;
  authority: { assertHeld(): void };
  io?: WindowsSelectionPublicationIo;
  hooks?: WindowsSelectionPublicationHooks;
  validateDependencies?(): Promise<void>;
}
const nativeIo: WindowsSelectionPublicationIo = {
  async writeExistingFile(path, bytes) {
    // The protected CREATE_NEW file already exists: no create, truncate, or fallback.
    const handle = await open(path, 'r+');
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  },
  rename
};

/** Selection-only file replacement. Retained candidates are never automatically replayed or deleted. */
export async function publishWindowsSelection(options: WindowsSelectionPublicationOptions): Promise<{ effect: 'committed' }> {
  const { backend, home, authority, expected } = options;
  const bytes = Buffer.from(options.bytes);
  decodeActiveProfileState(bytes, 'active-profile');
  const io = options.io ?? nativeIo;
  authority.assertHeld();
  const parent = admitWindowsPrivateDirectory(backend, home);
  if ((await readWindowsSelectionSnapshot(backend, home)).digest !== expected.digest) throw refused('EXPECTED_STATE_CHANGED');
  const component = `selection-${randomBytes(16).toString('hex')}.tmp`;
  const candidatePath = win32.join(home, component);
  const destination = win32.join(home, 'active-profile');
  let candidate: Awaited<ReturnType<typeof readWindowsPrivateFileSnapshot>>;
  try {
    authority.assertHeld();
    const created = createWindowsPrivateFile(backend, home, component);
    await options.hooks?.afterPrivateCreation?.();
    authority.assertHeld();
    const empty = await readWindowsPrivateFileSnapshot(backend, candidatePath, MAX_ACTIVE_PROFILE_STATE_BYTES);
    if (!sameObject(created, empty.inspection) || empty.bytes.length !== 0) throw refused('CANDIDATE_CHANGED');
    await io.writeExistingFile(candidatePath, bytes);
    candidate = await readWindowsPrivateFileSnapshot(backend, candidatePath, MAX_ACTIVE_PROFILE_STATE_BYTES);
    if (!sameObject(created, candidate.inspection) || !candidate.bytes.equals(bytes)) throw refused('CANDIDATE_CHANGED');
    await options.hooks?.afterCandidateRead?.();
    await options.hooks?.beforeReplacement?.();
    await options.validateDependencies?.();
    authority.assertHeld();
    if (!sameObject(parent, admitWindowsPrivateDirectory(backend, home))) throw refused('PARENT_CHANGED');
    const finalCandidate = await readWindowsPrivateFileSnapshot(backend, candidatePath, MAX_ACTIVE_PROFILE_STATE_BYTES);
    if (!exactFile(candidate, finalCandidate)) throw refused('CANDIDATE_CHANGED');
    // Last dependent observation immediately precedes the ordinary sibling FILE rename.
    if ((await readWindowsSelectionSnapshot(backend, home)).digest !== expected.digest) throw refused('EXPECTED_STATE_CHANGED');
    authority.assertHeld();
  } catch (error) {
    throw new BazframeError('WINDOWS_SELECTION_BEFORE_EFFECT', `Selection was not replaced; a private candidate may be retained at ${candidatePath}. Retry from current selection.`, { cause: error });
  }
  let renameFailed = false;
  try { await io.rename(candidatePath, destination); await options.hooks?.afterReplacement?.(); }
  catch { renameFailed = true; }
  // Reconcile even when rename reports success. Syscall return is not an effect receipt.
  try {
    authority.assertHeld();
    if (!sameObject(parent, admitWindowsPrivateDirectory(backend, home))) throw refused('PARENT_CHANGED');
    const current = await readWindowsSelectionSnapshot(backend, home);
    let retained: typeof candidate | undefined;
    try { retained = await readWindowsPrivateFileSnapshot(backend, candidatePath, MAX_ACTIVE_PROFILE_STATE_BYTES); }
    catch (error) { if (errorCode(error) !== 'WINDOWS_NATIVE_PATH_NOT_FOUND') throw error; }
    if (current.inspection !== undefined && current.bytes !== undefined && retained === undefined
      && sameObject(candidate.inspection, current.inspection)
      && candidate.inspection.object.size === current.inspection.object.size
      && candidate.inspection.object.allocationSize === current.inspection.object.allocationSize
      && candidate.inspection.object.lastWriteTime === current.inspection.object.lastWriteTime
      && current.bytes.equals(bytes)) return { effect: 'committed' };
    if (renameFailed && current.digest === expected.digest && retained !== undefined && exactFile(candidate, retained)) {
      throw new BazframeError('WINDOWS_SELECTION_NO_EFFECT', `Selection replacement had no effect; the exact private candidate is retained at ${candidatePath}. Resolve sharing and retry from current selection.`);
    }
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_SELECTION_NO_EFFECT') throw error;
    throw new BazframeError('WINDOWS_SELECTION_AMBIGUOUS', `Selection replacement is ambiguous; inspect current selection and retain ${candidatePath}. No rollback or cleanup was attempted.`, { cause: error });
  }
  throw new BazframeError('WINDOWS_SELECTION_AMBIGUOUS', `Selection replacement is ambiguous; inspect current selection and retain ${candidatePath}. No rollback or cleanup was attempted.`);
}

/** Rename may change path/timestamps; immutable identity and exact security must survive. */
function sameObject(left: WindowsPathInspection, right: WindowsPathInspection): boolean {
  return left.kind === right.kind && left.object.volumeIdentity === right.object.volumeIdentity
    && left.object.fileId === right.object.fileId && left.object.creationTime === right.object.creationTime
    && left.object.numberOfLinks === right.object.numberOfLinks && left.object.attributes === right.object.attributes
    && JSON.stringify(left.security) === JSON.stringify(right.security);
}
function exactFile(left: { bytes: Buffer; inspection: WindowsPathInspection }, right: { bytes: Buffer; inspection: WindowsPathInspection }): boolean {
  return left.bytes.equals(right.bytes) && JSON.stringify(left.inspection) === JSON.stringify(right.inspection);
}
function refused(detail: string): BazframeError { return new BazframeError('WINDOWS_SELECTION_REFUSED', `Selection publication refused: ${detail}.`); }
