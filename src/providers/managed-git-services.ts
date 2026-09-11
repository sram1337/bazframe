import { createHash, randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend, WindowsPathInspection } from '../core/win32-native.js';
import { stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { enumerateWindowsPhysicalDirectory } from '../skills/added-skill-platform-services.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { admitWindowsPhysicalDirectory, admitWindowsPhysicalFile, ensureWindowsPrivateDirectoryPath, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { publishWindowsPrivateStateFile } from '../state/win32-atomic-file.js';
import { readWindowsPhysicalFileSnapshot } from '../profiles/win32-profile-selection.js';
import { writeWindowsProfileFile } from '../profile-publishing/win32-profile-storage.js';
import type { WindowsProfileLifecycleOptions } from '../profile-publishing/win32-profile-lifecycle.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { sameResourceIdentity, type ResourceIdentity } from '../skill-collections/resource-identity.js';
import { decodeManagedGitRecord, decodeManagedGitJournal, MAX_MANAGED_GIT_RECORD_BYTES, type ManagedGitResourceKind, type ManagedGitRecordSnapshot, type ManagedGitJournalSnapshot } from './managed-git-record.js';

export const windowsManagedGitPathPolicy = { basename: win32.basename, isCanonicalAbsolute: (path: string) => /^[A-Za-z]:\\/u.test(path) && win32.normalize(path) === path && path.slice(3).split('\\').every(isValidWindowsPathComponent) };
export const windowsResourceIdentity = (value: WindowsPathInspection): ResourceIdentity => ({ domain: 'windows', volumeIdentity: value.object.volumeIdentity, fileId: value.object.fileId, creationTime: value.object.creationTime });
export const managedGitRetainedName = (name: string): boolean => /^\.bazframe-provider-[a-f0-9]{32}\.json$/u.test(name) || /^resource-[a-f0-9]{32}\.tmp$/u.test(name);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const key = (value: string) => value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
export const windowsManagedGitPaths = {
  managedGitCheckoutRoot: (home: string, kind: ManagedGitResourceKind, id: string) => win32.join(home, 'providers', 'git', 'checkouts', kind, id),
  managedGitRecordPath: (home: string, kind: ManagedGitResourceKind, id: string) => win32.join(home, 'providers', 'git', 'records', kind, `${id}.json`),
  managedGitJournalPath: (home: string, kind: ManagedGitResourceKind, id: string) => win32.join(home, 'providers', 'git', 'recovery', `${kind}-${id}.json`),
  managedGitRecoveryRoot: (home: string) => win32.join(home, 'providers', 'git', 'recovery'),
  managedGitStagingRoot: (home: string) => win32.join(home, 'providers', 'git', 'staging')
};

/** Bounded physical record effects. These preserve provider schema-v1 bytes. */
export function createWindowsManagedGitRecordEffects(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, options: WindowsProfileLifecycleOptions = {}, authority?: { assertHeld(): void }) {
  const maximum = PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries;
  async function absent(path: string): Promise<boolean> {
    if (!windowsManagedGitPathPolicy.isCanonicalAbsolute(path)) throw refused('noncanonical path');
    const parent = win32.dirname(path);
    if (parent === path) return false;
    let namespace;
    try { namespace = await enumerateWindowsPhysicalDirectory(backend, parent, maximum); }
    catch (error) { if (errorCode(error) === 'WINDOWS_NATIVE_PATH_NOT_FOUND' && await absent(parent)) return true; throw error; }
    const matches = namespace.names.filter((name) => key(name) === key(win32.basename(path)));
    if (matches.length === 0) return true;
    if (matches.length !== 1 || matches[0] !== win32.basename(path)) throw refused('aliased namespace');
    return false;
  }
  async function snapshot(path: string, maximumBytes = MAX_MANAGED_GIT_RECORD_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_MANAGED_GIT_RECORD_BYTES) throw refused('record byte limit');
    const ancestors: Array<{ path: string; inspection: WindowsPathInspection }> = [];
    for (let cursor = win32.dirname(path);;) { ancestors.push({ path: cursor, inspection: backend.inspectPath(cursor) }); const parent = win32.dirname(cursor); if (parent === cursor) break; cursor = parent; }
    const result = await readWindowsPhysicalFileSnapshot(backend, path, maximumBytes);
    for (const before of ancestors) {
      const after = backend.inspectPath(before.path);
      if (!sameResourceIdentity(windowsResourceIdentity(before.inspection), windowsResourceIdentity(after)) || before.inspection.object.attributes !== after.object.attributes) throw refused('record namespace changed during bounded read');
    }
    return { ...result, ...windowsResourceIdentity(result.inspection), sha256: hash(result.bytes), digest: hash(Buffer.from(JSON.stringify(stableWindowsPathInspection(result.inspection)) + hash(result.bytes))) };
  }
  async function state(path: string) { return await absent(path) ? { digest: hash(Buffer.from('absent')) } : snapshot(path); }
  async function readManagedGitRecord(home: string, kind: ManagedGitResourceKind, id: string, limits: { maxBytes?: number } = {}): Promise<ManagedGitRecordSnapshot> {
    if (!isSafeSkillId(id)) throw refused('invalid record ID');
    const path = windowsManagedGitPaths.managedGitRecordPath(home, kind, id);
    const value = await snapshot(path, limits.maxBytes);
    const record = decodeManagedGitRecord(json(value.bytes), { kind, id }, windowsManagedGitPathPolicy);
    if (record.root !== windowsManagedGitPaths.managedGitCheckoutRoot(home, kind, id)) throw refused('nondeterministic checkout path');
    return { ...windowsResourceIdentity(value.inspection), record, path, contentSha256: value.sha256 };
  }
  async function readManagedGitJournal(home: string, kind: ManagedGitResourceKind, id: string, limits: { maxBytes?: number } = {}): Promise<ManagedGitJournalSnapshot> {
    if (!isSafeSkillId(id)) throw refused('invalid journal ID');
    const path = windowsManagedGitPaths.managedGitJournalPath(home, kind, id), value = await snapshot(path, limits.maxBytes);
    const journal = decodeManagedGitJournal(json(value.bytes), { kind, id }, windowsManagedGitPathPolicy);
    if (journal.root !== windowsManagedGitPaths.managedGitCheckoutRoot(home, kind, id)) throw refused('nondeterministic journal root');
    return { ...windowsResourceIdentity(value.inspection), journal, path, contentSha256: value.sha256 };
  }
  async function optionalManagedGitRecord(home: string, kind: ManagedGitResourceKind, id: string) {
    return await absent(windowsManagedGitPaths.managedGitRecordPath(home, kind, id)) ? undefined : readManagedGitRecord(home, kind, id);
  }
  async function optionalManagedGitRecordInExistingNamespace(home: string, kind: ManagedGitResourceKind, id: string) {
    const path = win32.dirname(windowsManagedGitPaths.managedGitRecordPath(home, kind, id));
    const before = admitWindowsPhysicalDirectory(backend, path);
    const record = await optionalManagedGitRecord(home, kind, id);
    if (!sameResourceIdentity(windowsResourceIdentity(before), windowsResourceIdentity(admitWindowsPhysicalDirectory(backend, path)))) throw refused('record namespace changed while checking optional provenance');
    return record;
  }
  function assertAuthority() { if (authority === undefined) throw refused('live mutation authority required'); authority.assertHeld(); }
  async function publish(path: string, bytes: Buffer, expected: Awaited<ReturnType<typeof state>>) {
    assertAuthority();
    await publishWindowsPrivateStateFile({ backend, home: win32.dirname(path), component: win32.basename(path) as `${string}.json`, temporaryPrefix: 'resource', noReplaceOnAbsent: true, expected, bytes, maxBytes: MAX_MANAGED_GIT_RECORD_BYTES, authority: { assertHeld: assertAuthority }, io: options.stateIo, readSnapshot: () => state(path) });
    assertAuthority();
  }
  async function detach(path: string, expected: ResourceIdentity & { sha256: string }) {
    assertAuthority(); const before = await snapshot(path);
    if (!sameResourceIdentity(before, expected) || before.sha256 !== expected.sha256) throw refused('file changed before detachment');
    const parentPath = win32.dirname(path), parent = admitWindowsPhysicalDirectory(backend, parentPath);
    const name = `.bazframe-provider-${randomBytes(16).toString('hex')}.json`, destination = win32.join(parentPath, name);
    assertAuthority(); let error: unknown;
    try { await backend.renameFileNoReplace(parentPath, win32.basename(path), name); } catch (cause) { error = cause; }
    assertAuthority();
    if (!sameResourceIdentity(windowsResourceIdentity(parent), windowsResourceIdentity(admitWindowsPhysicalDirectory(backend, parentPath)))) throw refused('detach parent changed', error);
    const missing = await absent(path);
    if (missing && !await absent(destination)) { const moved = await snapshot(destination); if (sameResourceIdentity(before, moved) && moved.bytes.equals(before.bytes)) return; }
    throw refused('file detachment unproven; retain both leaves', error);
  }
  async function assertReadyProviderState(home: string) {
    const provider = win32.join(home, 'providers');
    if (await absent(provider)) return;
    const roots = await enumerateWindowsPhysicalDirectory(backend, provider, maximum);
    if (roots.names.some((name) => name !== 'git')) throw refused('unrecognized provider');
    if (!roots.names.includes('git')) return;
    const root = win32.join(provider, 'git');
    for (const name of (await enumerateWindowsPhysicalDirectory(backend, root, maximum)).names) {
      if (!['records', 'checkouts', 'recovery', 'staging', 'isolation'].includes(name)) throw refused('unrecognized provider namespace');
      const path = win32.join(root, name); admitWindowsPhysicalDirectory(backend, path);
      if (name === 'staging' || name === 'isolation' || name === 'checkouts') continue;
      if (name === 'recovery') {
        for (const leaf of (await enumerateWindowsPhysicalDirectory(backend, path, maximum)).names) {
          if (managedGitRetainedName(leaf)) { admitWindowsPhysicalFile(backend, win32.join(path, leaf)); continue; }
          if (/^(?:skill|library|package)-[a-z0-9-]+-[a-f0-9-]{36}$/u.test(leaf) || /^retained-[a-f0-9]{32}$/u.test(leaf)) { admitWindowsPhysicalDirectory(backend, win32.join(path, leaf)); continue; }
          const journal = /^(skill|library|package)-(.+)\.json$/u.exec(leaf);
          if (journal !== null) { await readManagedGitJournal(home, journal[1] as ManagedGitResourceKind, journal[2]!); continue; }
          throw refused('provider recovery requires inspection');
        }
      } else for (const kind of (await enumerateWindowsPhysicalDirectory(backend, path, maximum)).names) {
        if (!['skill', 'library', 'package'].includes(kind)) throw refused('invalid provider kind');
        const directory = win32.join(path, kind);
        for (const leaf of (await enumerateWindowsPhysicalDirectory(backend, directory, maximum)).names) {
          if (managedGitRetainedName(leaf)) { admitWindowsPhysicalFile(backend, win32.join(directory, leaf)); continue; }
          if (!leaf.endsWith('.json')) throw refused('invalid provider record name');
          await readManagedGitRecord(home, kind as ManagedGitResourceKind, leaf.slice(0, -5));
        }
      }
    }
  }
  return { ...windowsManagedGitPaths, absent, snapshot, state, publish, detach, assertReadyProviderState, readManagedGitRecord, readManagedGitJournal, optionalManagedGitRecord, optionalManagedGitRecordInExistingNamespace,
    async ensureDirectory(path: string) { assertAuthority(); ensureWindowsPrivateDirectoryPath(backend, path); assertAuthority(); },
    async createFile(path: string, text: string) { assertAuthority(); if (!await absent(path)) throw refused('file destination occupied'); await writeWindowsProfileFile(backend, path, Buffer.from(text), options.storageIo); assertAuthority(); return snapshot(path); }
  };
}
function json(bytes: Buffer): unknown { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw refused('invalid UTF-8 JSON'); } }
function refused(detail: string, cause?: unknown): BazframeError { return new BazframeError('WINDOWS_MANAGED_GIT_REFUSED', `Windows managed Git refused: ${detail}.`, { cause }); }
