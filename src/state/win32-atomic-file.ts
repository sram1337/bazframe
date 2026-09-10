import { stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { BazframeWin32NativeBackend, WindowsPathInspection } from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { decodeActiveProfileState, MAX_ACTIVE_PROFILE_STATE_BYTES } from '../profiles/profile-store.js';
import { readWindowsPrivateFileSnapshot, readWindowsSelectionSnapshot, type WindowsSelectionSnapshot } from '../profiles/win32-profile-selection.js';
import { admitWindowsPrivateDirectory, createWindowsPrivateFile, isValidWindowsPathComponent } from './win32-private-directory.js';

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

/** Selection codec and limits remain at its concrete caller. */
export async function publishWindowsSelection(options: WindowsSelectionPublicationOptions): Promise<{ effect: 'committed' }> {
  decodeActiveProfileState(options.bytes, 'active-profile');
  return publishWindowsPrivateStateFile({ ...options, component: 'active-profile', temporaryPrefix: 'selection', maxBytes: MAX_ACTIVE_PROFILE_STATE_BYTES,
    readSnapshot: () => readWindowsSelectionSnapshot(options.backend, options.home) });
}
export interface WindowsPrivateStatePublicationOptions extends Omit<WindowsSelectionPublicationOptions, 'expected'> {
  expected: Pick<WindowsSelectionSnapshot, 'digest' | 'bytes' | 'inspection'>;
  component: string;
  temporaryPrefix: 'selection' | 'favorites' | 'resource';
  noReplaceOnAbsent?: boolean;
  maxBytes: number;
  readSnapshot(): Promise<Pick<WindowsSelectionSnapshot, 'digest' | 'bytes' | 'inspection'>>;
}
/** Bounded protected sibling publication shared by selection and favorites. No replay or cleanup. */
export async function publishWindowsPrivateStateFile(options: WindowsPrivateStatePublicationOptions): Promise<{ effect: 'committed' }> {
  const { backend, home, authority, expected } = options;
  // Keep the selection error codes/API compatible; diagnostics name the actual file's state.
  if (!isValidWindowsPathComponent(options.component)) throw new BazframeError('WINDOWS_SELECTION_REFUSED', 'Invalid private state component.');
  const label = options.component === 'active-profile' ? 'Selection' : options.component === 'profile-favorites.json' ? 'Favorites' : 'Resource';
  const state = label.toLowerCase();
  const refused = (detail: string) => new BazframeError('WINDOWS_SELECTION_REFUSED', `${label} publication refused: ${detail}.`);
  const bytes = Buffer.from(options.bytes);
  if (bytes.length > options.maxBytes) throw refused('BYTE_LIMIT');
  const io = options.io ?? nativeIo;
  authority.assertHeld();
  const parent = admitWindowsPrivateDirectory(backend, home);
  if ((await options.readSnapshot()).digest !== expected.digest) throw refused('EXPECTED_STATE_CHANGED');
  const component = `${options.temporaryPrefix}-${randomBytes(16).toString('hex')}.tmp`;
  const candidatePath = win32.join(home, component);
  const destination = win32.join(home, options.component);
  let candidate: Awaited<ReturnType<typeof readWindowsPrivateFileSnapshot>>;
  try {
    authority.assertHeld();
    const created = createWindowsPrivateFile(backend, home, component);
    await options.hooks?.afterPrivateCreation?.();
    authority.assertHeld();
    const empty = await readWindowsPrivateFileSnapshot(backend, candidatePath, options.maxBytes);
    if (!sameObject(created, empty.inspection) || empty.bytes.length !== 0) throw refused('CANDIDATE_CHANGED');
    await io.writeExistingFile(candidatePath, bytes);
    candidate = await readWindowsPrivateFileSnapshot(backend, candidatePath, options.maxBytes);
    if (!sameObject(created, candidate.inspection) || !candidate.bytes.equals(bytes)) throw refused('CANDIDATE_CHANGED');
    await options.hooks?.afterCandidateRead?.();
    await options.hooks?.beforeReplacement?.();
    await options.validateDependencies?.();
    authority.assertHeld();
    if (!sameObject(parent, admitWindowsPrivateDirectory(backend, home))) throw refused('PARENT_CHANGED');
    const finalCandidate = await readWindowsPrivateFileSnapshot(backend, candidatePath, options.maxBytes);
    if (!exactFile(candidate, finalCandidate)) throw refused('CANDIDATE_CHANGED');
    // Last dependent observation immediately precedes the ordinary sibling FILE rename.
    if ((await options.readSnapshot()).digest !== expected.digest) throw refused('EXPECTED_STATE_CHANGED');
    authority.assertHeld();
  } catch (error) {
    throw new BazframeError('WINDOWS_SELECTION_BEFORE_EFFECT', `${label} ${state === 'selection' ? 'was' : 'were'} not replaced; a private candidate may be retained at ${candidatePath}. Retry from current ${state}.`, { cause: error });
  }
  let renameFailed = false;
  try {
    if (options.noReplaceOnAbsent === true && expected.inspection === undefined) await backend.renameFileNoReplace(home, component, options.component);
    else await io.rename(candidatePath, destination);
    await options.hooks?.afterReplacement?.();
  }
  catch { renameFailed = true; }
  // Reconcile even when rename reports success. Syscall return is not an effect receipt.
  try {
    authority.assertHeld();
    if (!sameObject(parent, admitWindowsPrivateDirectory(backend, home))) throw refused('PARENT_CHANGED');
    const current = await options.readSnapshot();
    let retained: typeof candidate | undefined;
    try { retained = await readWindowsPrivateFileSnapshot(backend, candidatePath, options.maxBytes); }
    catch (error) { if (errorCode(error) !== 'WINDOWS_NATIVE_PATH_NOT_FOUND') throw error; }
    if (current.inspection !== undefined && current.bytes !== undefined && retained === undefined
      && sameObject(candidate.inspection, current.inspection)
      && candidate.inspection.object.size === current.inspection.object.size
      && candidate.inspection.object.allocationSize === current.inspection.object.allocationSize
      && candidate.inspection.object.lastWriteTime === current.inspection.object.lastWriteTime
      && current.bytes.equals(bytes)) return { effect: 'committed' };
    if (renameFailed && current.digest === expected.digest && retained !== undefined && exactFile(candidate, retained)) {
      throw new BazframeError('WINDOWS_SELECTION_NO_EFFECT', `${label} replacement had no effect; the exact private candidate is retained at ${candidatePath}. Resolve sharing and retry from current ${state}.`);
    }
  } catch (error) {
    if (errorCode(error) === 'WINDOWS_SELECTION_NO_EFFECT') throw error;
    throw new BazframeError('WINDOWS_SELECTION_AMBIGUOUS', `${label} replacement is ambiguous; inspect current ${state} and retain ${candidatePath}. No rollback or cleanup was attempted.`, { cause: error });
  }
  throw new BazframeError('WINDOWS_SELECTION_AMBIGUOUS', `${label} replacement is ambiguous; inspect current ${state} and retain ${candidatePath}. No rollback or cleanup was attempted.`);
}

/** Rename may change path/timestamps; immutable identity and exact security must survive. */
function sameObject(left: WindowsPathInspection, right: WindowsPathInspection): boolean {
  return left.kind === right.kind && left.object.volumeIdentity === right.object.volumeIdentity
    && left.object.fileId === right.object.fileId && left.object.creationTime === right.object.creationTime
    && left.object.numberOfLinks === right.object.numberOfLinks && left.object.attributes === right.object.attributes
    && JSON.stringify(left.security) === JSON.stringify(right.security);
}
function exactFile(left: { bytes: Buffer; inspection: WindowsPathInspection }, right: { bytes: Buffer; inspection: WindowsPathInspection }): boolean {
  return left.bytes.equals(right.bytes) && JSON.stringify(stableWindowsPathInspection(left.inspection)) === JSON.stringify(stableWindowsPathInspection(right.inspection));
}
