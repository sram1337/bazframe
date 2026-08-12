import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { BazframeError, errorCode } from '../core/errors.js';

const KEYS = ['artifactRoot', 'build', 'schemaVersion', 'sourceUnitRoot'] as const;

export interface SourceBuildManifest {
  schemaVersion: 1;
  build: string[];
  artifactRoot: string;
  sourceUnitRoot: string;
}

export function isPortableSourceRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) return false;
  if (value === '.') return true;
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.startsWith('//')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function decodeSourceBuildManifest(value: unknown): SourceBuildManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('manifest must be a JSON object');
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== KEYS.length || !keys.every((key, index) => key === KEYS[index])) {
    throw invalid('manifest must contain exactly the schema-v1 fields');
  }
  if (candidate.schemaVersion !== 1) throw invalid('unsupported schemaVersion');
  if (!Array.isArray(candidate.build) || candidate.build.length === 0
    || !candidate.build.every((item) => typeof item === 'string' && item.length > 0 && !item.includes('\0'))) {
    throw invalid('build must be a nonempty literal argv array of nonempty strings');
  }
  if (!isPortableSourceRelativePath(candidate.artifactRoot)) throw invalid('artifactRoot is invalid');
  if (!isPortableSourceRelativePath(candidate.sourceUnitRoot)) throw invalid('sourceUnitRoot is invalid');
  return {
    schemaVersion: 1,
    build: [...candidate.build] as string[],
    artifactRoot: candidate.artifactRoot,
    sourceUnitRoot: candidate.sourceUnitRoot
  };
}

export async function readOptionalSourceBuildManifest(providerRoot: string): Promise<SourceBuildManifest | undefined> {
  const path = `${providerRoot}/bazframe-source.json`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalid('manifest must be a physical regular file');
    const bytes = await handle.readFile();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new BazframeError('SOURCE_BUILD_MANIFEST_INVALID', 'Source build manifest is not valid UTF-8.', { cause: error }); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) { throw new BazframeError('SOURCE_BUILD_MANIFEST_INVALID', 'Source build manifest is not valid JSON.', { cause: error }); }
    return decodeSourceBuildManifest(value);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    if (error instanceof BazframeError) throw error;
    if (errorCode(error) === 'ELOOP') throw invalid('manifest must be a physical regular file');
    throw new BazframeError('SOURCE_BUILD_MANIFEST_READ_FAILED', `Could not read source build manifest ${path}${formatCode(error)}`, { cause: error });
  } finally { await handle?.close().catch(() => undefined); }
}

function invalid(detail: string): BazframeError {
  return new BazframeError('SOURCE_BUILD_MANIFEST_INVALID', `Invalid source build manifest: ${detail}.`);
}
function formatCode(error: unknown): string { const code = errorCode(error); return code === undefined ? '' : ` (${code})`; }
