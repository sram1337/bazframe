import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { BazframeError, errorCode } from '../core/errors.js';
import { profileDirectory } from '../profiles/profile-store.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { decodeManagedProfileStateBytes, encodeManagedProfileState, publicationSidecarName, type ManagedProfileStateV1 } from './publication-state.js';
import { assertPhysicalDirectoryIdentity, assertStablePhysicalDirectory, openStablePhysicalDirectory, readStablePhysicalFile, stableReadChildPath, writeOwnedStagingFileAtomic } from './profile-filesystem.js';

export interface ManagedProfileStateSnapshot { state: ManagedProfileStateV1; sha256: string; bytes: number; device: bigint; inode: bigint }

export function managedProfileStatePath(home: string, profileId: string): string { assertSafeProfileId(profileId); return join(profileDirectory(home, profileId), publicationSidecarName()); }

export async function readOptionalManagedProfileState(home: string, profileId: string, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}): Promise<ManagedProfileStateSnapshot | undefined> {
  const policy = capturedProfileLimitPolicy(lowerLimits); const directory = await openStablePhysicalDirectory(profileDirectory(home, profileId), home);
  try {
    try {
      const file = await readStablePhysicalFile(stableReadChildPath(directory, publicationSidecarName()), policy.maxManifestBytes);
      const state = decodeManagedProfileStateBytes(file.bytes, policy); await assertStablePhysicalDirectory(directory);
      return { state, sha256: createHash('sha256').update(file.bytes).digest('hex'), bytes: file.bytes.byteLength, device: file.identity.device, inode: file.identity.inode };
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || (error instanceof BazframeError && error.cause !== undefined && errorCode(error.cause) === 'ENOENT')) { await assertStablePhysicalDirectory(directory); return undefined; }
      throw error;
    }
  } finally { await directory.handle.close().catch(() => undefined); }
}

/** Writes only into an unpublished random candidate directory owned by the caller. */
export async function writeCandidateManagedProfileState(home: string, candidateDirectory: string, state: ManagedProfileStateV1, lowerLimits: Partial<CapturedProfileLimitPolicy> = {}): Promise<ManagedProfileStateSnapshot> {
  const candidatePath = resolve(candidateDirectory);
  const profilesPath = resolve(home, 'profiles');
  if (dirname(candidatePath) !== profilesPath || !/^\.bazframe-candidate-[a-f0-9]{32}$/u.test(basename(candidatePath))) {
    throw new BazframeError('PROFILE_PUBLICATION_CANDIDATE_INVALID', 'Managed profile state may be written only to a reserved unpublished candidate directory.');
  }
  const policy = capturedProfileLimitPolicy(lowerLimits); const candidate = await openStablePhysicalDirectory(candidatePath, home);
  try {
    const bytes = Buffer.from(encodeManagedProfileState(state, policy));
    await writeOwnedStagingFileAtomic(candidate, publicationSidecarName(), bytes, 0o600);
    const file = await readStablePhysicalFile(stableReadChildPath(candidate, publicationSidecarName()), policy.maxManifestBytes);
    const decoded = decodeManagedProfileStateBytes(file.bytes, policy); await assertPhysicalDirectoryIdentity(candidate);
    return { state: decoded, sha256: createHash('sha256').update(file.bytes).digest('hex'), bytes: file.bytes.byteLength, device: file.identity.device, inode: file.identity.inode };
  } finally { await candidate.handle.close().catch(() => undefined); }
}

export async function assertManagedProfileSidecarAbsent(home: string, profileId: string): Promise<void> {
  const profile = await openStablePhysicalDirectory(profileDirectory(home, profileId), home);
  try {
    try { await lstat(stableReadChildPath(profile, publicationSidecarName())); }
    catch (error) { if (errorCode(error) === 'ENOENT') { await assertStablePhysicalDirectory(profile); return; } throw error; }
    throw new BazframeError('PROFILE_PUBLICATION_STATE_OCCUPIED', `Managed profile state already exists for ${JSON.stringify(profileId)}.`);
  } finally { await profile.handle.close().catch(() => undefined); }
}
