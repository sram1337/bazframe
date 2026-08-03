import { isAbsolute, resolve } from 'node:path';
import { BazframeError } from '../../core/errors.js';
import type { FileIdentity } from '../../state/file-identity.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_VERSION_LENGTH = 128;

export interface PiAdapterManifest {
  schemaVersion: 1;
  adapter: 'pi';
  bazframeVersion: string;
  installedPath: string;
  artifactSha256: string;
  artifactBytes: number;
}

export function createPiAdapterManifest(
  bazframeVersion: string,
  installedPath: string,
  artifact: FileIdentity
): PiAdapterManifest {
  return validateManifest({
    schemaVersion: 1,
    adapter: 'pi',
    bazframeVersion,
    installedPath,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes
  }, 'Pi adapter manifest');
}

export function decodePiAdapterManifest(
  text: string,
  source = 'Pi adapter manifest'
): PiAdapterManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new BazframeError('ADAPTER_MANIFEST_INVALID', `Invalid JSON in ${source}.`, {
      cause: error
    });
  }
  return validateManifest(value, source);
}

export function encodePiAdapterManifest(manifest: PiAdapterManifest): string {
  const validated = validateManifest(manifest, 'Pi adapter manifest');
  return `${JSON.stringify(validated, null, 2)}\n`;
}

function validateManifest(value: unknown, source: string): PiAdapterManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidManifest(source);
  }
  const candidate = value as Partial<PiAdapterManifest>;
  if (
    candidate.schemaVersion !== 1
    || candidate.adapter !== 'pi'
    || typeof candidate.bazframeVersion !== 'string'
    || candidate.bazframeVersion.length === 0
    || candidate.bazframeVersion.length > MAX_VERSION_LENGTH
    || candidate.bazframeVersion.includes('\0')
    || typeof candidate.installedPath !== 'string'
    || !isNormalizedAbsolutePath(candidate.installedPath)
    || typeof candidate.artifactSha256 !== 'string'
    || !SHA256.test(candidate.artifactSha256)
    || typeof candidate.artifactBytes !== 'number'
    || !Number.isSafeInteger(candidate.artifactBytes)
    || candidate.artifactBytes < 0
  ) {
    throw invalidManifest(source);
  }
  return {
    schemaVersion: 1,
    adapter: 'pi',
    bazframeVersion: candidate.bazframeVersion,
    installedPath: candidate.installedPath,
    artifactSha256: candidate.artifactSha256,
    artifactBytes: candidate.artifactBytes
  };
}

function isNormalizedAbsolutePath(path: string): boolean {
  return path.length > 0
    && !path.includes('\0')
    && isAbsolute(path)
    && resolve(path) === path;
}

function invalidManifest(source: string): BazframeError {
  return new BazframeError(
    'ADAPTER_MANIFEST_INVALID',
    `${source} must be a schema-v1 Pi adapter ownership manifest.`
  );
}
