import { isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { createHash } from 'node:crypto';
import { BazframeError } from '../core/errors.js';
import { isPortableRelativePath } from '../skill-collections/portable-relative-path.js';
import { managedGitAcquisitionLimitPolicy, type ManagedGitAcquisitionLimitPolicy } from '../profile-portability/profile-portability-policy.js';

export interface ManagedGitTreeEntry { path: string; mode: '100644' | '100755'; object: string }
export interface ManagedGitTreeEvidence { entries: readonly ManagedGitTreeEntry[]; sha256: string }

/** Decode exact -z output, never Git's quoted display paths or a lossy text conversion. */
export function decodeManagedGitTreeEvidence(bytes: Uint8Array, format: 'tree' | 'index', lower: Partial<ManagedGitAcquisitionLimitPolicy> = {}): ManagedGitTreeEvidence {
  const policy = managedGitAcquisitionLimitPolicy(lower);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('paths are not UTF-8'); }
  const fields = text === '' ? [] : text.split('\0');
  if (fields.length > 0 && fields.pop() !== '') throw invalid('truncated NUL-delimited output');
  if (fields.length > policy.maxCheckoutEntries) throw invalid('entry limit exceeded');
  const aliases = new Map<string, string>();
  const files = new Set<string>();
  const directories = new Set<string>();
  const entries: ManagedGitTreeEntry[] = fields.map((field) => {
    const match = (format === 'tree' ? /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u : /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/u).exec(field);
    if (match === null) throw invalid('unsupported type, mode, object ID, or index stage');
    const path = match[3]!;
    if (!isPortableRelativePath(path) || path === '.' || Buffer.byteLength(path) > policy.maxCheckoutPathBytes || path.split('/').length > policy.maxCheckoutDepth) throw invalid('nonportable path or path limit exceeded');
    const parts = path.split('/');
    if (parts.some((part) => !isValidWindowsPathComponent(part))) throw invalid('path cannot be materialized losslessly on Windows');
    for (let index = 1; index <= parts.length; index++) {
      const spelling = parts.slice(0, index).join('/');
      const key = spelling.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
      const prior = aliases.get(key);
      if (prior !== undefined && prior !== spelling) throw invalid('aliased path');
      aliases.set(key, spelling);
      if (index < parts.length) { if (files.has(spelling)) throw invalid('file/directory collision'); directories.add(spelling); }
    }
    if (files.has(path) || directories.has(path) || parts.some((part) => part.toLowerCase() === '.git')) throw invalid('duplicate, colliding, or metadata path');
    files.add(path);
    return { path, mode: match[1] as ManagedGitTreeEntry['mode'], object: match[2]! };
  });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { entries, sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
export function assertManagedGitIndexMatchesTree(tree: ManagedGitTreeEvidence, index: ManagedGitTreeEvidence): void {
  if (tree.sha256 !== index.sha256) throw invalid('index bytes or modes differ from exact commit tree');
}
function invalid(detail: string): BazframeError { return new BazframeError('MANAGED_GIT_TREE_INVALID', `Invalid exact managed Git tree evidence: ${detail}.`); }
