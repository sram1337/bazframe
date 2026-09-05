import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { BazframeWin32NativeBackend, WindowsPathInspection } from '../core/win32-native.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { enumerateWindowsPrivateDirectory } from '../skills/added-skill-platform-services.js';
import { admitWindowsPrivateDirectory, admitWindowsPrivateFile } from '../state/win32-private-directory.js';
import { decodeActiveProfileState, MAX_ACTIVE_PROFILE_STATE_BYTES, type ActiveProfileReadServices } from './profile-store.js';

export interface WindowsSelectionSnapshot {
  profileId?: string;
  /** Onboarding dependent-state digest domain is deliberately unchanged. */
  digest: string;
  bytes?: Buffer;
  inspection?: WindowsPathInspection;
}

/** Read-only selected-ID proof. Never bootstraps, locks, recovers, or loads a profile. */
export async function readWindowsSelectionSnapshot(backend: BazframeWin32NativeBackend, home: string): Promise<WindowsSelectionSnapshot> {
  try { admitWindowsPrivateDirectory(backend, home); }
  catch (error) {
    if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return { digest: digest('absent') };
    throw error;
  }
  const namespace = await enumerateWindowsPrivateDirectory(backend, home, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries);
  const names = namespace.names.filter((name) => key(name) === key('active-profile'));
  if (names.length === 0) return { digest: digest('absent') };
  if (names.length !== 1 || names[0] !== 'active-profile') throw invalid('Active selection uses an alias spelling.');
  const path = win32.join(home, 'active-profile');
  const { bytes, inspection } = await readWindowsPrivateFileSnapshot(backend, path, MAX_ACTIVE_PROFILE_STATE_BYTES);
  const after = await enumerateWindowsPrivateDirectory(backend, home, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries);
  if (after.identity !== namespace.identity) throw invalid('Active selection namespace changed during its read.');
  return { profileId: decodeActiveProfileState(bytes, path), bytes, inspection, digest: digest(JSON.stringify(inspection), bytes) };
}

/** Lossless private opened-file observation, also used for candidate reconciliation. */
export async function readWindowsPrivateFileSnapshot(backend: BazframeWin32NativeBackend, path: string, maxBytes: number): Promise<{ bytes: Buffer; inspection: WindowsPathInspection }> {
  const before = admitWindowsPrivateFile(backend, path);
  const receipt = await backend.readStableFile(path, maxBytes);
  const after = admitWindowsPrivateFile(backend, path);
  if (JSON.stringify(before) !== JSON.stringify(after)
    || JSON.stringify(before.object) !== JSON.stringify(receipt.before)
    || JSON.stringify(receipt.before) !== JSON.stringify(receipt.after)
    || receipt.bytes.byteLength > maxBytes || receipt.byteCount !== receipt.after.size
    || BigInt(receipt.bytes.byteLength) !== BigInt(`0x${receipt.after.size}`)) throw invalid('Private file changed during its bounded read.');
  return { bytes: Buffer.from(receipt.bytes), inspection: after };
}

export function createWindowsProfileSelectionReadServicesForInternalTesting(backend: BazframeWin32NativeBackend): ActiveProfileReadServices {
  return { async readSelectedProfileId(home) { return (await readWindowsSelectionSnapshot(backend, home)).profileId; } };
}
function key(value: string): string { return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase(); }
function digest(value: string, bytes?: Uint8Array): string {
  const hash = createHash('sha256').update('bazframe-win32-profile-add-selection-v1\0').update(value);
  if (bytes !== undefined) hash.update(bytes);
  return hash.digest('hex');
}
function invalid(message: string): BazframeError { return new BazframeError('WINDOWS_PROFILE_PROVISIONING_REFUSED', message); }
