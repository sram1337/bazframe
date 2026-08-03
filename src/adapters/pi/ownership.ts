import type { FileIdentity } from '../../state/file-identity.js';
import { sameFileIdentity } from '../../state/file-identity.js';
import type { PiAdapterManifest } from './manifest.js';

export type PiAdapterInstallState =
  | 'missing'
  | 'adoptable'
  | 'current'
  | 'managed-outdated'
  | 'managed-missing'
  | 'drifted'
  | 'occupied'
  | 'manifest-path-mismatch';

export interface PiAdapterInstallation {
  targetPath: string;
  desired: FileIdentity;
  manifest?: PiAdapterManifest;
  installed?: FileIdentity;
}

export function classifyPiAdapterInstallation(
  installation: PiAdapterInstallation
): PiAdapterInstallState {
  const { desired, installed, manifest, targetPath } = installation;
  if (manifest === undefined) {
    if (installed === undefined) return 'missing';
    return sameFileIdentity(installed, desired) ? 'adoptable' : 'occupied';
  }
  if (manifest.installedPath !== targetPath) return 'manifest-path-mismatch';
  if (installed === undefined) return 'managed-missing';

  const recorded: FileIdentity = {
    sha256: manifest.artifactSha256,
    bytes: manifest.artifactBytes
  };
  if (!sameFileIdentity(installed, recorded)) return 'drifted';
  return sameFileIdentity(installed, desired) ? 'current' : 'managed-outdated';
}
