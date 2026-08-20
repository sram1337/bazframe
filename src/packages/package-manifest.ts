import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { isPortableRelativePath } from '../skill-collections/portable-relative-path.js';

const KEYS = ['artifactRoot', 'build', 'schemaVersion', 'skillsRoot'] as const;
export const PACKAGE_MANIFEST = 'bazframe-package.json';

export interface PackageManifest {
  schemaVersion: 1;
  build: string[];
  artifactRoot: string;
  skillsRoot: string;
}

export interface PackageManifestSnapshot {
  manifest: PackageManifest;
  path: string;
  device: bigint;
  inode: bigint;
  contentSha256: string;
}

export function decodePackageManifest(value: unknown): PackageManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('manifest must be a JSON object');
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== KEYS.length || !keys.every((key, index) => key === KEYS[index])) throw invalid('manifest must contain exactly the schema-v1 fields');
  if (candidate.schemaVersion !== 1) throw invalid('unsupported schemaVersion');
  if (!Array.isArray(candidate.build) || candidate.build.length === 0
    || !candidate.build.every((item) => typeof item === 'string' && item.length > 0 && !item.includes('\0'))) {
    throw invalid('build must be a nonempty literal argv array of nonempty strings');
  }
  if (!isPortableRelativePath(candidate.artifactRoot)) throw invalid('artifactRoot is invalid');
  if (!isPortableRelativePath(candidate.skillsRoot)) throw invalid('skillsRoot is invalid');
  return { schemaVersion: 1, build: [...candidate.build] as string[], artifactRoot: candidate.artifactRoot, skillsRoot: candidate.skillsRoot };
}

export async function readPackageManifest(packageRoot: string): Promise<PackageManifestSnapshot> {
  const path = join(packageRoot, PACKAGE_MANIFEST);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw invalid('manifest must be a physical regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    if (!after.isFile() || pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== pathMetadata.dev || after.ino !== pathMetadata.ino) throw invalid('manifest identity changed while reading');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new BazframeError('PACKAGE_MANIFEST_INVALID', 'Package manifest is not valid UTF-8.', { cause: error }); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) { throw new BazframeError('PACKAGE_MANIFEST_INVALID', 'Package manifest is not valid JSON.', { cause: error }); }
    return {
      manifest: decodePackageManifest(value), path, device: before.dev, inode: before.ino,
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    };
  } catch (error) {
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) === 'ELOOP') throw invalid('manifest must be a physical regular file');
    throw new BazframeError('PACKAGE_MANIFEST_READ_FAILED', `Could not read package manifest ${path}${formatCode(error)}`, { cause: error });
  } finally { await handle?.close().catch(() => undefined); }
}

export function samePackageManifestSnapshot(left: PackageManifestSnapshot, right: PackageManifestSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode && left.contentSha256 === right.contentSha256;
}
function invalid(detail: string): BazframeError { return new BazframeError('PACKAGE_MANIFEST_INVALID', `Invalid package manifest: ${detail}.`); }
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
