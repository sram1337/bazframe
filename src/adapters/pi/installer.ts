import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BazframeError, errorCode } from '../../core/errors.js';
import {
  removeManagedDirectoryTree,
  writeFileAtomic
} from '../../state/atomic-file.js';
import {
  identifyBytes,
  identifyFile,
  sameFileIdentity,
  type FileIdentity
} from '../../state/file-identity.js';
import { withStateLock } from '../../state/lock.js';
import { resolvePiAgentDirectory } from '../../state/paths.js';
import {
  createPiAdapterManifest,
  decodePiAdapterManifest,
  encodePiAdapterManifest,
  type PiAdapterManifest
} from './manifest.js';
import {
  classifyPiAdapterInstallation,
  type PiAdapterInstallState
} from './ownership.js';

const MAX_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_ARTIFACT_URL = new URL('../../../artifacts/pi/bazframe.ts', import.meta.url);

export interface PiAdapterLifecycleOptions {
  bazframeHome: string;
  bazframeVersion: string;
  environment: NodeJS.ProcessEnv;
  userHome?: string;
  artifactUrl?: URL;
}

export interface PiAdapterInspection {
  state: PiAdapterInstallState;
  targetPath: string;
  manifestPath: string;
  desired: FileIdentity;
  manifest?: PiAdapterManifest;
  installed?: FileIdentity;
}

export interface PiAdapterLifecycleResult extends PiAdapterInspection {
  action: 'current' | 'installed' | 'adopted' | 'updated' | 'repaired' | 'uninstalled' | 'absent';
}

export async function inspectPiAdapter(
  options: PiAdapterLifecycleOptions
): Promise<PiAdapterInspection> {
  const artifactBytes = await readPackagedArtifact(options.artifactUrl);
  return inspectWithDesired(options, identifyBytes(artifactBytes));
}

export async function installPiAdapter(
  options: PiAdapterLifecycleOptions,
  force = false
): Promise<PiAdapterLifecycleResult> {
  const artifactBytes = await readPackagedArtifact(options.artifactUrl);
  const desired = identifyBytes(artifactBytes);
  const targetPath = adapterTargetPath(options);

  return withStateLock(
    join(options.bazframeHome, 'locks', 'adapter-pi.lock'),
    { command: force ? 'bazframe adapter install pi --force' : 'bazframe adapter install pi', target: targetPath },
    async () => {
      const inspection = await inspectWithDesired(options, desired);
      if (inspection.state === 'current') {
        return { ...inspection, action: 'current' };
      }
      if (inspection.state === 'occupied') {
        throw new BazframeError(
          'ADAPTER_DESTINATION_OCCUPIED',
          `Pi extension destination is owned by another file: ${inspection.targetPath}`
        );
      }
      if (inspection.state === 'manifest-path-mismatch') {
        throw new BazframeError(
          'ADAPTER_PATH_MISMATCH',
          `The Pi adapter manifest identifies ${inspection.manifest?.installedPath}; the effective Pi extension path is ${inspection.targetPath}.`
        );
      }
      if (inspection.state === 'drifted' && !force) {
        throw new BazframeError(
          'ADAPTER_DRIFTED',
          `The installed Pi adapter has changed: ${inspection.targetPath}. Run \`bazframe adapter install pi --force\` to restore Bazframe's artifact.`
        );
      }

      let action: PiAdapterLifecycleResult['action'];
      if (inspection.state === 'adoptable') {
        action = 'adopted';
      } else {
        await writeFileAtomic(inspection.targetPath, artifactBytes, {
          managedRoot: resolvePiAgentDirectory(options.environment, options.userHome),
          chmodExistingDirectories: false
        });
        action = inspection.state === 'missing' || inspection.state === 'managed-missing'
          ? 'installed'
          : inspection.state === 'drifted'
            ? 'repaired'
            : 'updated';
      }

      const manifest = createPiAdapterManifest(
        options.bazframeVersion,
        inspection.targetPath,
        desired
      );
      await writeFileAtomic(
        inspection.manifestPath,
        encodePiAdapterManifest(manifest),
        { managedRoot: options.bazframeHome }
      );
      await verifyInstalledAdapter(inspection.targetPath, inspection.manifestPath, desired);
      return {
        ...inspection,
        state: 'current',
        installed: desired,
        manifest,
        action
      };
    },
    { managedRoot: options.bazframeHome }
  );
}

export async function uninstallPiAdapter(
  options: PiAdapterLifecycleOptions
): Promise<PiAdapterLifecycleResult> {
  const artifactBytes = await readPackagedArtifact(options.artifactUrl);
  const desired = identifyBytes(artifactBytes);
  const targetPath = adapterTargetPath(options);

  return withStateLock(
    join(options.bazframeHome, 'locks', 'adapter-pi.lock'),
    { command: 'bazframe adapter uninstall pi', target: targetPath },
    async () => {
      const inspection = await inspectWithDesired(options, desired);
      if (inspection.state === 'occupied') {
        throw new BazframeError(
          'ADAPTER_DESTINATION_OCCUPIED',
          `Pi extension destination is owned by another file: ${inspection.targetPath}`
        );
      }
      if (inspection.state === 'manifest-path-mismatch') {
        throw new BazframeError(
          'ADAPTER_PATH_MISMATCH',
          `The Pi adapter manifest identifies ${inspection.manifest?.installedPath}; the effective Pi extension path is ${inspection.targetPath}.`
        );
      }
      if (inspection.state === 'drifted') {
        throw new BazframeError(
          'ADAPTER_DRIFTED',
          `The installed Pi adapter has changed and was preserved: ${inspection.targetPath}.`
        );
      }

      await removeManagedDirectoryTree(
        options.bazframeHome,
        join(options.bazframeHome, 'adapter-cache', 'pi')
      );
      if (new Set<PiAdapterInstallState>([
        'current',
        'managed-outdated',
        'adoptable'
      ]).has(inspection.state)) {
        await rm(inspection.targetPath);
      }
      if (inspection.manifest !== undefined) {
        await rm(inspection.manifestPath);
      }

      return {
        ...inspection,
        state: 'missing',
        manifest: undefined,
        installed: undefined,
        action: inspection.state === 'missing' ? 'absent' : 'uninstalled'
      };
    },
    { managedRoot: options.bazframeHome }
  );
}

async function inspectWithDesired(
  options: PiAdapterLifecycleOptions,
  desired: FileIdentity
): Promise<PiAdapterInspection> {
  const targetPath = adapterTargetPath(options);
  const manifestPath = join(options.bazframeHome, 'adapters', 'pi.json');
  const manifest = await readOptionalManifest(manifestPath);
  const target = await inspectTarget(targetPath);

  let state: PiAdapterInstallState;
  if (target.kind === 'unsafe') {
    state = manifest?.installedPath === targetPath ? 'drifted' : 'occupied';
  } else {
    state = classifyPiAdapterInstallation({
      targetPath,
      desired,
      ...(manifest === undefined ? {} : { manifest }),
      ...(target.identity === undefined ? {} : { installed: target.identity })
    });
  }
  return {
    state,
    targetPath,
    manifestPath,
    desired,
    ...(manifest === undefined ? {} : { manifest }),
    ...(target.identity === undefined ? {} : { installed: target.identity })
  };
}

async function readPackagedArtifact(artifactUrl = DEFAULT_ARTIFACT_URL): Promise<Uint8Array> {
  try {
    return await readFile(artifactUrl);
  } catch (error) {
    throw new BazframeError(
      'ADAPTER_ARTIFACT_READ_FAILED',
      `Could not read packaged Pi adapter artifact: ${fileURLToPath(artifactUrl)}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
}

async function readOptionalManifest(path: string): Promise<PiAdapterManifest | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
    throw new BazframeError(
      'ADAPTER_MANIFEST_INVALID',
      `Pi adapter manifest must be a physical file no larger than ${MAX_MANIFEST_BYTES} bytes: ${path}`
    );
  }
  return decodePiAdapterManifest(await readFile(path, 'utf8'), path);
}

async function inspectTarget(
  path: string
): Promise<{ kind: 'absent' | 'file' | 'unsafe'; identity?: FileIdentity }> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) return { kind: 'unsafe' };
  return { kind: 'file', identity: await identifyFile(path) };
}

async function verifyInstalledAdapter(
  targetPath: string,
  manifestPath: string,
  desired: FileIdentity
): Promise<void> {
  const installed = await identifyFile(targetPath);
  const manifest = decodePiAdapterManifest(await readFile(manifestPath, 'utf8'), manifestPath);
  const recorded = {
    sha256: manifest.artifactSha256,
    bytes: manifest.artifactBytes
  };
  if (!sameFileIdentity(installed, desired) || !sameFileIdentity(recorded, desired)) {
    throw new BazframeError(
      'ADAPTER_INSTALL_VERIFY_FAILED',
      `Pi adapter verification failed after installation: ${targetPath}`
    );
  }
}

function adapterTargetPath(options: PiAdapterLifecycleOptions): string {
  return join(
    resolvePiAgentDirectory(options.environment, options.userHome),
    'extensions',
    'bazframe.ts'
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
