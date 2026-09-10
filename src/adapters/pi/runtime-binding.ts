import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BazframeError } from '../../core/errors.js';

export const PI_BINDING_MAX_BYTES = 64 * 1024;
export const PI_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export interface PiRuntimeBinding {
  schemaVersion: 1;
  bazframeVersion: string;
  packageRoot: string;
  packageSha256: string;
  runtimeSha256: string;
  nativeSha256: string;
}
export const bindingRuntimeRelativePath = 'dist/application/win32-application-services.js';
export const bindingNativeRelativePath = 'artifacts/native/win32-x64-msvc/bazframe-win32.node';
export function encodePiRuntimeBinding(value: PiRuntimeBinding): string {
  return `${JSON.stringify(decodePiRuntimeBinding(JSON.stringify(value)), null, 2)}\n`;
}
export function decodePiRuntimeBinding(text: string): PiRuntimeBinding {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'bazframeVersion,nativeSha256,packageRoot,packageSha256,runtimeSha256,schemaVersion'
    || record.schemaVersion !== 1 || typeof record.bazframeVersion !== 'string' || record.bazframeVersion.length === 0 || record.bazframeVersion.length > 128
    || typeof record.packageRoot !== 'string' || !/^[a-z]:\\/iu.test(record.packageRoot) || win32.resolve(record.packageRoot) !== record.packageRoot || record.packageRoot.includes('\0')
    || !['packageSha256', 'runtimeSha256', 'nativeSha256'].every((key) => typeof record[key] === 'string' && /^[a-f0-9]{64}$/u.test(record[key] as string))) throw invalid();
  return record as unknown as PiRuntimeBinding;
}
export async function createInstallerRuntimeBinding(version: string, read: (path: string, max: number) => Promise<Buffer>, packageRoot = fileURLToPath(new URL('../../../', import.meta.url))): Promise<PiRuntimeBinding> {
  const packageBytes = await read(win32.join(packageRoot, 'package.json'), PI_BINDING_MAX_BYTES);
  const manifest = JSON.parse(packageBytes.toString('utf8')) as { name?: unknown; version?: unknown };
  if (manifest.name !== 'bazframe' || manifest.version !== version) throw invalid();
  return decodePiRuntimeBinding(JSON.stringify({ schemaVersion: 1, bazframeVersion: version, packageRoot,
    packageSha256: hash(packageBytes), runtimeSha256: hash(await read(win32.join(packageRoot, bindingRuntimeRelativePath), PI_ARTIFACT_MAX_BYTES)),
    nativeSha256: hash(await read(win32.join(packageRoot, bindingNativeRelativePath), PI_ARTIFACT_MAX_BYTES)) }));
}
export function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function invalid(): BazframeError { return new BazframeError('PI_RUNTIME_BINDING_INVALID', 'The install-owned Windows Pi runtime binding is missing, stale or invalid. Reinstall this exact Bazframe package, then run `bazframe adapter install pi` (use --force only after reviewing drift).'); }
