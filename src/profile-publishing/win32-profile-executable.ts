import { BazframeError } from '../core/errors.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';

export const WINDOWS_EXECUTABLE_METADATA = '.bazframe-win32-executable.json';
export interface WindowsExecutableMetadata { schemaVersion: 1; files: Array<{ path: string; executable: boolean }> }
export function encodeWindowsExecutableMetadata(value: WindowsExecutableMetadata, lower: Partial<CapturedProfileLimitPolicy> = {}): Buffer {
  const policy = capturedProfileLimitPolicy(lower);
  if (value === null || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'files,schemaVersion' || value.schemaVersion !== 1 || !Array.isArray(value.files) || value.files.length > policy.maxEntries) throw invalid();
  const seen = new Set<string>();
  const spellings = new Map<string, string>();
  let previous = '';
  const files = value.files.map((file) => {
    if (file === null || typeof file !== 'object' || Object.keys(file).sort().join(',') !== 'executable,path' || typeof file.path !== 'string' || typeof file.executable !== 'boolean') throw invalid();
    const parts = file.path.split('/');
    if (file.path <= previous || [...file.path].some((character) => character.codePointAt(0) === 0x7f) || Buffer.byteLength(file.path) > policy.maxPathBytes || parts.length > policy.maxDepth || !parts.every(isValidWindowsPathComponent)
      || !(file.path === 'AGENTS.md' || parts[0] === 'skills' && isSafeSkillId(parts[1] ?? '') && parts.length >= 3)) throw invalid();
    const key = file.path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
    if (seen.has(key)) throw invalid();
    for (const old of seen) if (old.startsWith(`${key}/`) || key.startsWith(`${old}/`)) throw invalid();
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/'); const folded = prefix.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
      if (spellings.has(folded) && spellings.get(folded) !== prefix) throw invalid();
      spellings.set(folded, prefix);
    }
    seen.add(key); previous = file.path;
    return { path: file.path, executable: file.executable };
  });
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
  if (bytes.length > policy.maxManifestBytes) throw invalid();
  return bytes;
}
export function decodeWindowsExecutableMetadata(bytes: Uint8Array, lower: Partial<CapturedProfileLimitPolicy> = {}): WindowsExecutableMetadata {
  if (bytes.byteLength > capturedProfileLimitPolicy(lower).maxManifestBytes) throw invalid();
  let value: WindowsExecutableMetadata;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as WindowsExecutableMetadata; } catch { throw invalid(); }
  if (!encodeWindowsExecutableMetadata(value, lower).equals(Buffer.from(bytes))) throw invalid();
  return value;
}
function invalid(): BazframeError { return new BazframeError('WINDOWS_PROFILE_EXECUTABLE_INVALID', 'Invalid bounded canonical Windows executable metadata.'); }
