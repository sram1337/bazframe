import type { PiAdapterServices, AdapterFileSnapshots, AdapterFileWriter } from './adapter-services.js';
import { decodePiRuntimeBinding, encodePiRuntimeBinding, PI_BINDING_MAX_BYTES, PI_ARTIFACT_MAX_BYTES, type PiRuntimeBinding } from './runtime-binding.js';
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
  services?: PiAdapterServices;
}

export interface PiAdapterInspection {
  state: PiAdapterInstallState;
  targetPath: string;
  manifestPath: string;
  desired: FileIdentity;
  manifest?: PiAdapterManifest;
  installed?: FileIdentity;
  runtimeBinding?: { path: string; desired: PiRuntimeBinding; current: boolean };
  snapshots?: AdapterFileSnapshots;
}

export interface PiAdapterLifecycleResult extends PiAdapterInspection {
  action: 'current' | 'installed' | 'adopted' | 'updated' | 'repaired' | 'uninstalled' | 'absent';
}

export async function inspectPiAdapter(
  options: PiAdapterLifecycleOptions
): Promise<PiAdapterInspection> {
  const { artifactBytes, binding } = await desiredInstallation(options);
  return inspectWithDesired(options, identifyBytes(artifactBytes), binding);
}

export async function installPiAdapter(
  options: PiAdapterLifecycleOptions,
  force = false
): Promise<PiAdapterLifecycleResult> {
  const { artifactBytes, binding } = await desiredInstallation(options);
  const desired = identifyBytes(artifactBytes);
  const targetPath = adapterTargetPath(options);

  return withAdapterLock(options, force ? 'bazframe adapter install --force pi' : 'bazframe adapter install pi', targetPath, async (writer) => {
      const inspection = await inspectWithDesired(options, desired, binding);
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
          `The installed Pi adapter has changed: ${inspection.targetPath}. Run \`bazframe adapter install --force pi\` to restore Bazframe's artifact.`
        );
      }

      let action: PiAdapterLifecycleResult['action'];
      if (inspection.state === 'adoptable') {
        action = 'adopted';
      } else {
        if (writer !== undefined) await writer.publish(inspection.targetPath, Buffer.from(artifactBytes), inspection.snapshots!.extension, PI_ARTIFACT_MAX_BYTES);
        else await writeFileAtomic(inspection.targetPath, artifactBytes, {
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
        desired, options.services?.paths
      );
      if (writer !== undefined) {
        await writer.publish(inspection.runtimeBinding!.path, Buffer.from(encodePiRuntimeBinding(binding!)), inspection.snapshots!.binding, PI_BINDING_MAX_BYTES);
        await writer.publish(inspection.manifestPath, Buffer.from(encodePiAdapterManifest(manifest, options.services!.paths)), inspection.snapshots!.manifest, MAX_MANIFEST_BYTES);
        const finalDesired = await desiredInstallation(options);
        const verified = await inspectWithDesired(options, identifyBytes(finalDesired.artifactBytes), finalDesired.binding);
        if (verified.state !== 'current') throw new BazframeError('ADAPTER_INSTALL_VERIFY_FAILED', 'Pi installation did not converge; inspect retained installation and retry explicitly.');
      } else await writeFileAtomic(
        inspection.manifestPath,
        encodePiAdapterManifest(manifest),
        { managedRoot: options.bazframeHome }
      );
      if (writer === undefined) await verifyInstalledAdapter(inspection.targetPath, inspection.manifestPath, desired);
      return {
        ...inspection,
        state: 'current',
        installed: desired,
        manifest,
        action
      };
    });
}

export async function uninstallPiAdapter(
  options: PiAdapterLifecycleOptions
): Promise<PiAdapterLifecycleResult> {
  const { artifactBytes, binding } = await desiredInstallation(options);
  const desired = identifyBytes(artifactBytes);
  const targetPath = adapterTargetPath(options);

  return withAdapterLock(options, 'bazframe adapter uninstall pi', targetPath, async (writer) => {
      const inspection = await inspectWithDesired(options, desired, binding);
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

      if (options.services !== undefined) await options.services.detachAliasCache(options.bazframeHome, writer!);
      else await removeManagedDirectoryTree(
        options.bazframeHome,
        join(options.bazframeHome, 'adapter-cache', 'pi')
      );
      if (new Set<PiAdapterInstallState>([
        'current',
        'managed-outdated',
        'adoptable'
      ]).has(inspection.state)) {
        if (writer !== undefined) await writer.detach(inspection.targetPath, inspection.snapshots!.extension, PI_ARTIFACT_MAX_BYTES);
        else await rm(inspection.targetPath);
      }
      if (inspection.manifest !== undefined) {
        if (writer !== undefined) await writer.detach(inspection.manifestPath, inspection.snapshots!.manifest, MAX_MANIFEST_BYTES);
        else await rm(inspection.manifestPath);
      }

      if (writer !== undefined && inspection.snapshots!.binding.bytes !== undefined) await writer.detach(inspection.runtimeBinding!.path, inspection.snapshots!.binding, PI_BINDING_MAX_BYTES);
      if (options.services !== undefined && (await options.services.files.snapshot(inspection.targetPath, PI_ARTIFACT_MAX_BYTES)).bytes !== undefined) throw new BazframeError('ADAPTER_UNINSTALL_AMBIGUOUS', 'Pi extension remains loadable; preserve retained state and inspect installation.');

      return {
        ...inspection,
        state: 'missing',
        manifest: undefined,
        installed: undefined,
        action: inspection.state === 'missing' ? 'absent' : 'uninstalled'
      };
    });
}

async function inspectWithDesired(
  options: PiAdapterLifecycleOptions,
  desired: FileIdentity,
  binding?: PiRuntimeBinding
): Promise<PiAdapterInspection> {
  const targetPath = adapterTargetPath(options);
  const paths = options.services?.paths;
  const manifestPath = (paths?.join ?? join)(options.bazframeHome, 'adapters', 'pi.json');
  const bindingPath = (paths?.join ?? join)(resolvePiAgentDirectory(options.environment, options.userHome, paths), 'bazframe', 'runtime.json');
  const snapshots = options.services === undefined ? undefined : {
    extension: await options.services.files.snapshot(targetPath, PI_ARTIFACT_MAX_BYTES),
    manifest: await options.services.files.snapshot(manifestPath, MAX_MANIFEST_BYTES),
    binding: await options.services.files.snapshot(bindingPath, PI_BINDING_MAX_BYTES)
  };
  const manifest = snapshots === undefined ? await readOptionalManifest(manifestPath) : snapshots.manifest.bytes === undefined ? undefined : decodePiAdapterManifest(new TextDecoder('utf-8', { fatal: true }).decode(snapshots.manifest.bytes), manifestPath, paths);
  const target = snapshots === undefined ? await inspectTarget(targetPath) : { kind: snapshots.extension.bytes === undefined ? 'absent' as const : 'file' as const, identity: snapshots.extension.bytes === undefined ? undefined : identifyBytes(snapshots.extension.bytes) };
  const bindingCurrent = binding !== undefined && snapshots?.binding.bytes?.equals(Buffer.from(encodePiRuntimeBinding(binding))) === true;

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
  if (binding !== undefined && !bindingCurrent && state !== 'occupied' && state !== 'manifest-path-mismatch') {
    if (snapshots?.binding.bytes === undefined) {
      if (state === 'current' || state === 'adoptable') state = 'managed-outdated';
    } else {
      // Only an intact, manifest-proved previous extension can authorize an old binding.
      // A missing extension supplies no integrity reference for arbitrary partial-state bytes.
      const previousBindingProved = state === 'managed-outdated' && snapshots.extension.bytes !== undefined
        && provesInstalledBinding(snapshots.extension.bytes, bindingPath, snapshots.binding.bytes);
      if (!previousBindingProved) state = manifest === undefined ? 'occupied' : 'drifted';
    }
  }
  return {
    state,
    ...(snapshots === undefined ? {} : { snapshots }),
    ...(binding === undefined ? {} : { runtimeBinding: { path: bindingPath, desired: binding, current: bindingCurrent } }),
    targetPath,
    manifestPath,
    desired,
    ...(manifest === undefined ? {} : { manifest }),
    ...(target.identity === undefined ? {} : { installed: target.identity })
  };
}

function provesInstalledBinding(extension: Buffer, bindingPath: string, bytes: Buffer): boolean {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(extension);
    const matches = [...source.matchAll(/^const WINDOWS_INSTALL_REFERENCE = (.+);$/gmu)];
    if (matches.length !== 1) return false;
    const reference = JSON.parse(matches[0]![1]!) as { path?: unknown; binding?: unknown };
    return reference.path === bindingPath && bytes.equals(Buffer.from(encodePiRuntimeBinding(decodePiRuntimeBinding(JSON.stringify(reference.binding)))));
  } catch { return false; }
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
  return (options.services?.paths.join ?? join)(
    resolvePiAgentDirectory(options.environment, options.userHome, options.services?.paths),
    'extensions',
    'bazframe.ts'
  );
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}

async function desiredInstallation(options: PiAdapterLifecycleOptions) {
  const original = await (options.services?.readPackagedArtifact ?? readPackagedArtifact)(options.artifactUrl ?? DEFAULT_ARTIFACT_URL);
  if (options.services === undefined) return { artifactBytes: original, binding: undefined };
  const binding = await options.services.desiredBinding(options.bazframeVersion);
  const path = options.services.paths.join(resolvePiAgentDirectory(options.environment, options.userHome, options.services.paths), 'bazframe', 'runtime.json');
  const marker = 'const WINDOWS_INSTALL_REFERENCE = null;';
  const source = new TextDecoder('utf-8', { fatal: true }).decode(original);
  if (source.split(marker).length !== 2) throw new BazframeError('ADAPTER_ARTIFACT_INVALID', 'Packaged Pi artifact has no unique install-owned binding reference.');
  return { binding, artifactBytes: Buffer.from(source.replace(marker, `const WINDOWS_INSTALL_REFERENCE = ${JSON.stringify({ path, binding })};`)) };
}
function withAdapterLock<T>(options: PiAdapterLifecycleOptions, command: string, target: string, operation: (writer?: AdapterFileWriter) => Promise<T>): Promise<T> {
  if (options.services !== undefined) return options.services.files.withLock(options.bazframeHome, command, operation);
  return withStateLock(join(options.bazframeHome, 'locks', 'adapter-pi.lock'), { command, target }, () => operation(), { managedRoot: options.bazframeHome });
}
