import { win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { open, rename } from 'node:fs/promises';
import { BazframeError } from '../../../src/core/errors.js';
import type { WindowsPathInspection } from '../../../src/core/win32-native.js';
import { withProfileOperationLocks, withWindowsProfileOperationLocksForInternalTesting, type OperationMutationAuthority } from '../../../src/profile-publishing/profile-operation-lock.js';
import { encodeTransactionJournal, transactionJournalRequiredAuthorityKeys, transitionTransactionJournal, type CandidateSwapJournalV2, type TransactionJournalV2 } from '../../../src/profile-publishing/transaction-journal.js';
import { readWindowsTransactionJournal, writeWindowsTransactionJournal, type WindowsTransactionJournalOptions } from '../../../src/profile-publishing/win32-transaction-journal.js';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { createTempDirectory } from '../../helpers/temp-directory.js';

vi.mock('node:fs/promises', async (original) => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }; });
afterEach(() => { vi.clearAllMocks(); vi.mocked(open).mockReset(); vi.mocked(rename).mockReset(); });
const HOME = 'C:\\boundary\\home', PUBLISHING = `${HOME}\\profile-publishing`, ROOT = `${PUBLISHING}\\transactions`;
const TX = '0123456789abcdef0123456789abcdef', NAME = `${TX}.json`, PATH = `${ROOT}\\${NAME}`;
const SHA = 'a'.repeat(64), SHA2 = 'b'.repeat(64);
const proof = { identity: 'win32-ntfs:ffffffffffffffff:00000000000000000000000000000001' as const, sidecarSha256: null, profileClosureSha256: SHA };
const candidate: CandidateSwapJournalV2 = { schemaVersion: 2, identityDomain: 'win32-ntfs', kind: 'candidate-swap', transactionId: TX, operation: 'fresh-import', profileName: 'work', expectedOld: { kind: 'absent' }, candidate: { token: `candidate:${TX}`, identity: null, sidecarSha256: null, profileClosureSha256: null }, backup: null, activeProfileBefore: null, phase: 'PLANNED', possiblePackageEffects: [] };
const journals: TransactionJournalV2[] = [candidate,
  { schemaVersion: 2, identityDomain: 'win32-ntfs', kind: 'rename-profile', transactionId: TX, oldName: 'work', newName: 'work-new', expectedOld: proof, expectedNew: { kind: 'absent' }, activeBefore: 'work', activeAfter: 'work-new', favoritesBeforeSha256: null, favoritesAfterCanonicalBytesSha256: SHA2, phase: 'INTENT' },
  { schemaVersion: 2, identityDomain: 'win32-ntfs', kind: 'remove-profile', transactionId: TX, profileName: 'work', expectedProfile: proof, quarantine: { token: `backup:${TX}` }, activeBefore: 'other', activeBeforeSha256: SHA2, favoritesBeforeSha256: SHA, favoritesAfterCanonicalBytesSha256: SHA2, phase: 'INTENT' },
  { schemaVersion: 2, identityDomain: 'win32-ntfs', kind: 'publication', transactionId: TX, profileName: 'work', expectedProfile: proof, origin: 'github.com/user-name/work', expectedBaseCommit: null, capturedManifestSha256: SHA2, originalVisibility: 'absent', desiredVisibility: 'private', repositoryCreated: false, repositoryId: null, observedCommit: null, phase: 'INTENT' }
];
const updated = transitionTransactionJournal(candidate, 'MATERIALIZING');
const wire = (value: TransactionJournalV2) => encodeTransactionJournal(value);
function fixture() {
  const f = windowsProvisioningFixture(); f.directory(HOME);
  // The shared fixture's rename remains directory/no-replace oriented. Override FILES locally only.
  const io = { ...f.io, rename: vi.fn(async (source: string, destination: string) => {
    const node = f.nodes.get(source)!;
    if (node.kind !== 'file' || win32.dirname(source) !== win32.dirname(destination)) throw new Error('not sibling files');
    f.nodes.delete(source); f.nodes.set(destination, node);
  }) };
  return { ...f, io,
    namespace() { f.directory(PUBLISHING); f.directory(ROOT); },
    temps: () => [...f.nodes.keys()].filter((name) => name.startsWith(`${ROOT}\\.tmp-`)),
    run<T>(operation: (authority: OperationMutationAuthority) => Promise<T>, journal = candidate as TransactionJournalV2, keys = transactionJournalRequiredAuthorityKeys(journal), transactionId = journal.transactionId) {
      return withWindowsProfileOperationLocksForInternalTesting(f.backend, HOME, keys, transactionId, operation, { lockIo: f.io });
    }
  };
}
type Fixture = ReturnType<typeof fixture>;
function write(f: Fixture, authority: OperationMutationAuthority, journal: TransactionJournalV2 = candidate, options: WindowsTransactionJournalOptions = {}) {
  return writeWindowsTransactionJournal(f.backend, HOME, authority, journal, { io: f.io, ...options });
}
function read(f: Fixture) { return readWindowsTransactionJournal(f.backend, HOME, TX); }
const beforeCode = { code: 'WINDOWS_TRANSACTION_JOURNAL_BEFORE_REPLACEMENT' };

// Host adapter tests; real ACL/sharing behavior needs Windows execution.
describe('internal Windows V2 journal storage', () => {
  it.each(journals)('persists actual Windows-issued $kind and an update, retaining full V2 proof and unrelated source bytes', async (journal) => {
    const f = fixture(); f.directory(`${HOME}\\profiles`); f.file(`${HOME}\\profiles\\source`, 'source\r\n');
    const source = JSON.stringify(f.nodes.get(`${HOME}\\profiles\\source`));
    const input = wire(journal);
    await f.run(async (authority) => {
      expect(await write(f, authority, journal, { hooks: { afterPrivateCreation() {
        expect(f.nodes.get(PATH)?.bytes).toEqual(Buffer.alloc(0));
        expect(f.backend.inspectPath(PATH).security.descriptorControl & 0x1000).toBe(0x1000);
        expect(f.io.rename).not.toHaveBeenCalled();
      } } })).toEqual(journal);
      const oldId = f.nodes.get(PATH)!.id;
      const next = transitionTransactionJournal(journal, 'AMBIGUOUS');
      expect(await write(f, authority, next)).toEqual(next);
      expect(f.nodes.get(PATH)!.id).not.toBe(oldId);
      expect(await read(f)).toEqual(next);
      expect(f.nodes.get(PATH)!.bytes).toEqual(Buffer.from(wire(next)));
    }, journal);
    expect(wire(journal)).toBe(input);
    expect(JSON.stringify(f.nodes.get(`${HOME}\\profiles\\source`))).toBe(source);
    expect(f.temps()).toEqual([]);
  });

  it.each(['none', 'publishing', 'transactions'] as const)('proves absence through stable %s namespace with zero writes', async (level) => {
    const f = fixture();
    if (level !== 'none') f.directory(PUBLISHING);
    if (level === 'transactions') f.directory(ROOT);
    const before = f.snapshot();
    expect(await read(f)).toBeUndefined();
    expect(f.snapshot()).toBe(before); expect(f.writes).toEqual([]);
  });
  it('refuses unavailable home rather than bootstrapping or reporting absent', async () => {
    const f = fixture(); f.nodes.delete(HOME);
    await expect(read(f)).rejects.toMatchObject({ code: 'WINDOWS_TRANSACTION_JOURNAL_REFUSED' });
    expect(f.writes).toEqual([]);
  });
  it.each(['publishing', 'transactions', 'final', 'directory', 'reparse', 'hardlink', 'private'] as const)('refuses occupied %s namespace without reading through or repairing it', async (kind) => {
    const f = fixture(); f.namespace();
    if (kind === 'publishing') { f.nodes.delete(PUBLISHING); f.directory(`${HOME}\\Profile-Publishing`); }
    if (kind === 'transactions') { f.nodes.delete(ROOT); f.directory(`${PUBLISHING}\\Transactions`); }
    if (kind === 'final') f.file(`${ROOT}\\${TX.toUpperCase()}.json`, '');
    if (kind === 'directory') f.directory(PATH);
    if (kind === 'reparse') f.reparse(PATH);
    if (kind === 'hardlink') { f.file(PATH, wire(candidate)); f.nodes.get(PATH)!.numberOfLinks = 2; }
    if (kind === 'private') { f.file(PATH, wire(candidate)); const security = f.backend.inspectPath(PATH).security; f.nodes.get(PATH)!.security = { ...security, ownerSid: 'S-1-5-18' }; }
    const before = f.snapshot();
    await expect(read(f)).rejects.toThrow(); expect(f.snapshot()).toBe(before);
  });
  it.each(['directory', 'file', 'substitution'] as const)('listed %s disappearance or drift is never absence', async (kind) => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    const enumerate = f.backend.enumerateStableDirectory;
    let mutated = false;
    f.backend.enumerateStableDirectory = async (...args) => {
      const result = await enumerate(...args);
      const trigger = kind === 'directory' ? PUBLISHING : ROOT;
      if (!mutated && args[0] === trigger) {
        mutated = true;
        if (kind === 'directory') f.nodes.delete(ROOT);
        if (kind === 'file') f.nodes.delete(PATH);
        if (kind === 'substitution') f.file(PATH, wire(candidate));
      }
      return result;
    };
    await expect(read(f)).rejects.toThrow(); expect(mutated).toBe(true);
  });
  it('reads only the requested payload; other finals and retained partial temps are inert and unchanged', async () => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    f.file(`${ROOT}\\${'e'.repeat(32)}.json`, 'malformed unrelated');
    f.file(`${ROOT}\\.tmp-${'f'.repeat(32)}`, '{partial');
    const spy = vi.spyOn(f.backend, 'readStableFile'), before = f.snapshot();
    expect(await read(f)).toEqual(candidate);
    expect(spy.mock.calls.map(([path]) => path)).toEqual([PATH]); expect(f.snapshot()).toBe(before);
  });
  it.each(['empty', 'partial', 'noncanonical', 'v1', 'old-v2', 'domain', 'id'] as const)('refuses occupied %s final on read and write, without overwrite', async (kind) => {
    const f = fixture(); f.namespace();
    const bytes = kind === 'empty' ? '' : kind === 'partial' ? '{' : kind === 'noncanonical' ? JSON.stringify(candidate)
      : kind === 'v1' ? wire(candidate).replace('"schemaVersion": 2,\n  "identityDomain": "win32-ntfs",', '"schemaVersion": 1,')
        : kind === 'old-v2' ? `${JSON.stringify({ ...candidate, candidate: { ...candidate.candidate, observationIdentity: null } }, null, 2)}\n`
        : kind === 'domain' ? wire(candidate).replace('win32-ntfs', 'posix') : wire(candidate).replaceAll(TX, 'e'.repeat(32));
    f.file(PATH, bytes);
    await expect(read(f)).rejects.toThrow();
    await f.run(async (authority) => {
      const before = f.snapshot(), count = f.writes.length;
      await expect(write(f, authority)).rejects.toMatchObject(beforeCode);
      expect(f.snapshot()).toBe(before); expect(f.writes).toHaveLength(count);
    });
  });
  it.each(['v1', 'domain', 'schema', 'invalid-phase', 'byte-limit', 'resource-limit', 'raised-limit'] as const)('validates/owns %s input before namespace effects', async (kind) => {
    const f = fixture();
    await f.run(async (authority) => {
      const before = f.snapshot(), count = f.writes.length;
      const value = kind === 'v1' ? JSON.parse(wire(candidate).replace('"schemaVersion": 2,\n  "identityDomain": "win32-ntfs",', '"schemaVersion": 1,')) as TransactionJournalV2
        : kind === 'domain' ? { ...candidate, identityDomain: 'posix' } as unknown as TransactionJournalV2
          : kind === 'schema' ? { ...candidate, schemaVersion: 3 } as unknown as TransactionJournalV2
            : kind === 'invalid-phase' ? updated : kind === 'resource-limit' ? { ...candidate, possiblePackageEffects: [SHA] } : candidate;
      const lower = kind === 'byte-limit' ? { maxManifestBytes: Buffer.byteLength(wire(candidate)) - 1 } : kind === 'resource-limit' ? { maxResources: 0 } : kind === 'raised-limit' ? { maxEntries: 32769 } : {};
      await expect(write(f, authority, value, { lower })).rejects.toMatchObject(beforeCode);
      expect(f.snapshot()).toBe(before); expect(f.writes).toHaveLength(count);
    });
  });
  it('owns mutable caller input before its first awaited admission', async () => {
    const f = fixture(); const value = structuredClone(candidate);
    await f.run(async (authority) => {
      const operation = write(f, authority, value);
      value.profileName = 'other'; value.possiblePackageEffects.push(SHA);
      expect(await operation).toEqual(candidate);
    });
  });
  it.each(['forged', 'backend', 'home', 'key', 'transaction', 'expired', 'supported'] as const)('requires actual Windows authority: %s refuses with zero adapter effects', async (kind) => {
    const f = fixture();
    const attempt = async (authority: OperationMutationAuthority) => {
      const before = f.snapshot(), count = f.writes.length;
      await expect(writeWindowsTransactionJournal(kind === 'backend' ? { ...f.backend } : f.backend, kind === 'home' ? `${HOME}-other` : HOME, authority, candidate, { io: f.io })).rejects.toMatchObject(beforeCode);
      expect(f.snapshot()).toBe(before); expect(f.writes).toHaveLength(count); expect(f.io.rename).not.toHaveBeenCalled();
    };
    if (kind === 'forged') await attempt({} as OperationMutationAuthority);
    else if (kind === 'supported') {
      const temp = await createTempDirectory('/tmp/bzf-op-');
      try { await withProfileOperationLocks(temp.root, ['work', '@store'], attempt, TX); }
      finally { await temp.cleanup(); }
    } else if (kind === 'expired') {
      let escaped: OperationMutationAuthority | undefined;
      await f.run(async (authority) => { escaped = authority; }); await attempt(escaped!);
    } else await f.run(attempt, candidate, kind === 'key' ? ['work'] : ['work', '@store'], kind === 'transaction' ? 'e'.repeat(32) : TX);
  });
  it('enforces exact/lowered bytes and all-entry bounds; replacement still needs a temporary slot', async () => {
    const f = fixture(); f.namespace();
    await f.run(async (authority) => {
      await write(f, authority, candidate, { lower: { maxManifestBytes: Buffer.byteLength(wire(candidate)), maxEntries: 2 } });
      expect(await readWindowsTransactionJournal(f.backend, HOME, TX, { maxManifestBytes: Buffer.byteLength(wire(candidate)), maxEntries: 2 })).toEqual(candidate);
      await expect(readWindowsTransactionJournal(f.backend, HOME, TX, { maxManifestBytes: Buffer.byteLength(wire(candidate)) - 1 })).rejects.toThrow();
      f.file(`${ROOT}\\.tmp-${'f'.repeat(32)}`, 'partial');
      const before = f.snapshot(), count = f.writes.length;
      await expect(write(f, authority, updated, { lower: { maxEntries: 2 } })).rejects.toMatchObject(beforeCode);
      expect(f.snapshot()).toBe(before); expect(f.writes).toHaveLength(count);
      await expect(readWindowsTransactionJournal(f.backend, HOME, TX, { maxEntries: 1 })).rejects.toThrow();
      await write(f, authority, updated, { lower: { maxEntries: 3 } });
      expect(f.temps()).toHaveLength(1);
    });
  });
  it.each(['old-proof', 'old-bytes', 'old-identity', 'temp-identity', 'temp-bytes', 'root-security', 'root-identity'] as const)('refuses fresh %s drift before rename, retaining state', async (kind) => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    await f.run(async (authority) => {
      await expect(write(f, authority, updated, { hooks: { beforeReplacement() {
        if (kind === 'old-proof') f.nodes.get(PATH)!.bytes = Buffer.from(wire({ ...candidate, possiblePackageEffects: [SHA] }));
        if (kind === 'old-bytes') f.nodes.get(PATH)!.bytes = Buffer.from(JSON.stringify(candidate));
        if (kind === 'old-identity') f.file(PATH, wire(candidate));
        if (kind === 'temp-identity') f.file(f.temps()[0]!, wire(updated));
        if (kind === 'temp-bytes') f.nodes.get(f.temps()[0]!)!.bytes = Buffer.from(wire(candidate));
        if (kind === 'root-identity') f.directory(ROOT);
        if (kind === 'root-security') f.nodes.get(ROOT)!.security = { ...f.backend.inspectPath(ROOT).security, groupSid: 'S-1-5-18' };
      } } })).rejects.toMatchObject(beforeCode);
      expect(f.io.rename).not.toHaveBeenCalled(); expect(f.temps()).toHaveLength(1);
    });
  });
  it.each(['success', 'rejected-old-temp', 'rejected-after-effect', 'false-success', 'substitution', 'both-absent', 'temp-retained', 'read-failure', 'post-hook'] as const)('reconciles settled file rename tuple %s without retries/cleanup', async (outcome) => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate)); const old = JSON.stringify(f.nodes.get(PATH));
    await f.run(async (authority) => {
      const cause = outcome === 'read-failure' ? new BazframeError('WINDOWS_TRANSACTION_JOURNAL_NO_EFFECT', 'untrusted read error code') : new Error('private path must not leak');
      const operation = write(f, authority, updated, { io: { ...f.io, async rename(source, destination) {
        if (outcome === 'rejected-old-temp') throw cause;
        if (outcome === 'false-success') return;
        const temp = f.nodes.get(source)!;
        await f.io.rename(source, destination);
        if (outcome === 'rejected-after-effect') throw cause;
        if (outcome === 'substitution') f.file(PATH, wire(updated));
        if (outcome === 'both-absent') f.nodes.delete(PATH);
        if (outcome === 'temp-retained') f.nodes.set(source, temp);
        if (outcome === 'read-failure') { const read = f.backend.readStableFile; f.backend.readStableFile = async (...args) => { if (args[0] === PATH) throw cause; return read(...args); }; }
      } }, hooks: { afterReplacement() { if (outcome === 'post-hook') throw cause; } } });
      if (['success', 'rejected-after-effect', 'post-hook'].includes(outcome)) expect(await operation).toEqual(updated);
      else {
        const error = await operation.catch((value: unknown) => value) as BazframeError;
        expect(error.code).toBe(outcome === 'rejected-old-temp' ? 'WINDOWS_TRANSACTION_JOURNAL_NO_EFFECT' : 'WINDOWS_TRANSACTION_JOURNAL_AMBIGUOUS');
        expect(error.message).not.toContain('private path'); expect(error.message).not.toContain(HOME);
        if (outcome === 'rejected-old-temp') { expect(error.cause).toBe(cause); expect(JSON.stringify(f.nodes.get(PATH))).toBe(old); expect(f.temps()).toHaveLength(1); }
      }
    });
  });
});

function observationDrift(f: Fixture, target: (path: string) => boolean, transform: (value: WindowsPathInspection, path: string) => WindowsPathInspection) {
  const inspect = f.backend.inspectPath, read = f.backend.readStableFile, enumerate = f.backend.enumerateStableDirectory;
  f.backend.inspectPath = (path) => target(path) ? transform(inspect(path), path) : inspect(path);
  f.backend.readStableFile = async (...args) => {
    const value = await read(...args);
    if (!target(args[0])) return value;
    return { ...value, before: transform({ ...inspect(args[0]), object: value.before }, args[0]).object, after: transform({ ...inspect(args[0]), object: value.after }, args[0]).object };
  };
  f.backend.enumerateStableDirectory = async (...args) => {
    const value = await enumerate(...args);
    return { ...value, directoryBefore: target(args[0]) ? transform(value.directoryBefore, args[0]) : value.directoryBefore, directoryAfter: target(args[0]) ? transform(value.directoryAfter, args[0]) : value.directoryAfter,
      entries: value.entries.map((entry) => {
        const path = win32.join(args[0], entry.name);
        if (!target(path)) return entry;
        const object = transform(inspect(path), path).object;
        return { ...entry, fileId: object.fileId, size: object.size, allocationSize: object.allocationSize, creationTime: object.creationTime, lastWriteTime: object.lastWriteTime, changeTime: object.changeTime, attributes: object.attributes, reparseTag: object.reparseTag, directory: object.directory };
      }) };
  };
}

describe('unchanged-path observations, own namespace effects and drained I/O', () => {
  it.each(['old', 'temp'].flatMap((target) => ['creationTime', 'lastWriteTime', 'changeTime', 'allocationSize', 'attributes', 'security'].map((field) => ({ target, field }))))('retains and refuses $target $field drift', async ({ target, field }) => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    await f.run(async (authority) => {
      await expect(write(f, authority, updated, { hooks: { beforeReplacement() {
        observationDrift(f, (path) => target === 'old' ? path === PATH : f.temps().includes(path), (value) => field === 'security' ? { ...value, security: { ...value.security, groupSid: 'S-1-5-18' } }
          : { ...value, object: { ...value.object, [field]: field === 'attributes' ? 0x22 : '0000000000000002' } });
      } } })).rejects.toMatchObject(beforeCode);
      expect(f.io.rename).not.toHaveBeenCalled(); expect(f.temps()).toHaveLength(1);
    });
  });
  it.each(['success', 'no-effect'] as const)('ignores ONLY access time for old/temp %s snapshots, without modifying raw receipts', async (outcome) => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate)); let clock = 10;
    const observations: WindowsPathInspection[] = [], copies: string[] = [];
    await f.run(async (authority) => {
      const operation = write(f, authority, updated, { io: { ...f.io, async rename(...args) { if (outcome === 'no-effect') throw new Error('sharing'); await f.io.rename(...args); } }, hooks: { afterCandidateRead() {
        observationDrift(f, (path) => path === PATH || f.temps().includes(path), (value) => {
          const result = { ...value, object: { ...value.object, lastAccessTime: (++clock).toString(16).padStart(16, '0') } };
          observations.push(result); copies.push(JSON.stringify(result)); return result;
        });
      } } });
      if (outcome === 'success') expect(await operation).toEqual(updated);
      else await expect(operation).rejects.toMatchObject({ code: 'WINDOWS_TRANSACTION_JOURNAL_NO_EFFECT' });
    });
    expect(observations.length).toBeGreaterThan(0); expect(observations.map((value) => JSON.stringify(value))).toEqual(copies);
  });
  it('accepts directory write/change times across private creation while retaining anchor admission', async () => {
    const f = fixture(); const clocks = new Map<string, number>();
    observationDrift(f, (path) => clocks.has(path), (value, path) => ({ ...value, object: { ...value.object, lastWriteTime: clocks.get(path)!.toString(16).padStart(16, '0'), changeTime: clocks.get(path)!.toString(16).padStart(16, '0') } }));
    // Each authorized child creation changes its parent's two namespace timestamps.
    const createDirectory = f.backend.createPrivateDirectory, createFile = f.backend.createPrivateFile;
    f.backend.createPrivateDirectory = (parent, name) => { const value = createDirectory(parent, name); clocks.set(parent, (clocks.get(parent) ?? 1) + 1); return { ...value, parentAfter: f.backend.inspectPath(parent) }; };
    f.backend.createPrivateFile = (parent, name) => { const value = createFile(parent, name); clocks.set(parent, (clocks.get(parent) ?? 1) + 1); return { ...value, parentAfter: f.backend.inspectPath(parent) }; };
    await f.run(async (authority) => { expect(await write(f, authority)).toEqual(candidate); expect(await write(f, authority, updated)).toEqual(updated); });
  });
  it('tolerates an unrelated sibling change during protected file creation', async () => {
    const f = fixture(); f.namespace(); const other = `${ROOT}\\.tmp-${'f'.repeat(32)}`; f.file(other, 'partial');
    await f.run(async (authority) => {
      const create = f.backend.createPrivateFile;
      f.backend.createPrivateFile = (parent, name) => { const result = create(parent, name); if (parent === ROOT) f.file(other, 'changed'); return result; };
      expect(await write(f, authority)).toEqual(candidate);
      expect(f.nodes.get(PATH)?.bytes).toEqual(Buffer.from(wire(candidate))); expect(f.io.rename).not.toHaveBeenCalled();
    });
  });
  it('retains directory enumeration/open length distinction while requiring within-source stability', async () => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    const enumerate = f.backend.enumerateStableDirectory;
    f.backend.enumerateStableDirectory = async (...args) => {
      const value = await enumerate(...args);
      return { ...value, entries: value.entries.map((entry) => entry.directory ? { ...entry, size: '0000000000000099', allocationSize: '0000000000000099' } : entry) };
    };
    expect(await read(f)).toEqual(candidate);
  });
  it.each(['initial', 'update'].flatMap((mode) => ['write', 'sync', 'close', 'success'].map((stage) => ({ mode, stage }))))('awaits default r+ $mode I/O through $stage; uncertainties remain occupied even if complete', async ({ mode, stage }) => {
    const f = fixture(); const events: string[] = []; let release: (() => void) | undefined;
    if (mode === 'update') { f.namespace(); f.file(PATH, wire(candidate)); }
    const value = mode === 'initial' ? candidate : updated;
    await f.run(async (authority) => {
      let writtenPath = '';
      const handle = {
        async writeFile(bytes: Uint8Array) { events.push('write'); await new Promise<void>((resolve) => { release = resolve; }); f.nodes.get(writtenPath)!.bytes = Buffer.from(bytes); if (stage === 'write') throw new Error(stage); },
        async sync() { events.push('sync'); if (stage === 'sync') throw new Error(stage); },
        async close() { events.push('close'); if (stage === 'close') throw new Error(stage); }
      };
      vi.mocked(open).mockImplementation(async (path) => { writtenPath = String(path); return handle as unknown as Awaited<ReturnType<typeof open>>; });
      vi.mocked(rename).mockImplementation(async (source, destination) => f.io.rename(String(source), String(destination)));
      let settled = false;
      const operation = writeWindowsTransactionJournal(f.backend, HOME, authority, value).finally(() => { settled = true; });
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(settled).toBe(false); expect(events).toEqual(['write']); expect(open).toHaveBeenCalledWith(mode === 'initial' ? PATH : f.temps()[0], 'r+');
      release!();
      if (stage === 'success') expect(await operation).toEqual(value);
      else await expect(operation).rejects.toMatchObject(beforeCode);
      expect(events).toEqual(stage === 'write' ? ['write', 'close'] : ['write', 'sync', 'close']);
      expect(f.nodes.get(stage === 'success' ? PATH : writtenPath)?.bytes).toEqual(Buffer.from(wire(value)));
      if (mode === 'initial' || stage !== 'success') expect(f.io.rename).not.toHaveBeenCalled();
      if (mode === 'update' && stage !== 'success') expect(f.nodes.get(PATH)?.bytes).toEqual(Buffer.from(wire(candidate)));
    });
  });
  it.each(['empty', 'partial', 'complete', 'substituted'] as const)('retains interrupted %s initial final and never blindly initializes over it', async (kind) => {
    const f = fixture();
    await f.run(async (authority) => {
      await expect(write(f, authority, candidate, { hooks: { afterPrivateCreation() { if (kind === 'empty') throw new Error('interrupt'); } }, io: { ...f.io, async writeExistingFile(path, bytes) {
        if (kind === 'substituted') { f.file(path, Buffer.from(bytes).toString()); return; }
        f.nodes.get(path)!.bytes = Buffer.from(kind === 'partial' ? '{' : bytes);
        throw new Error('drained failure');
      } } })).rejects.toMatchObject(beforeCode);
      const before = f.snapshot(); await expect(write(f, authority)).rejects.toMatchObject(beforeCode);
      expect(f.snapshot()).toBe(before); expect(f.io.rename).not.toHaveBeenCalled();
    });
  });
  it.each(['initial', 'replacement', 'reconciliation'] as const)('expires live proof during %s and retains uncertainty', async (stage) => {
    const f = fixture(); if (stage !== 'initial') { f.namespace(); f.file(PATH, wire(candidate)); }
    const acquire = f.backend.acquireFileLock; let valid = true;
    f.backend.acquireFileLock = (path) => { const result = acquire(path); if (result.state !== 'acquired') return result; return { ...result, capability: { ...result.capability, assertHeld() { result.capability.assertHeld(); if (!valid) throw new Error('expired'); } } }; };
    await f.run(async (authority) => {
      const operation = write(f, authority, stage === 'initial' ? candidate : updated, { hooks: {
        afterPrivateCreation() { if (stage === 'initial') valid = false; },
        beforeReplacement() { if (stage === 'replacement') valid = false; },
        afterReplacement() {
          if (stage === 'reconciliation') {
            const nativeRead = f.backend.readStableFile;
            f.backend.readStableFile = async (...args) => { const value = await nativeRead(...args); if (args[0] === PATH) valid = false; return value; };
          }
        }
      } });
      await expect(operation).rejects.toMatchObject({ code: stage === 'reconciliation' ? 'WINDOWS_TRANSACTION_JOURNAL_AMBIGUOUS' : beforeCode.code });
      valid = true;
    });
  });
});

const inspectionChanges: { field: string; change(value: WindowsPathInspection): WindowsPathInspection }[] = [
  ...['volumeIdentity', 'fileId', 'size', 'allocationSize', 'numberOfLinks', 'creationTime', 'lastWriteTime', 'changeTime', 'attributes', 'reparseTag', 'deletePending', 'directory'].map((field) => ({ field: `object.${field}`, change: (value: WindowsPathInspection) => ({ ...value, object: { ...value.object, [field]: field === 'fileId' ? 'f'.repeat(32) : field === 'numberOfLinks' ? '00000002' : field === 'attributes' ? 0x22 : field === 'reparseTag' ? 0xa0000003 : field === 'deletePending' || field === 'directory' ? true : '0000000000000002' } }) })),
  ...['identity', 'filesystemName', 'driveType', 'canonicalVolumeGuidPath', 'remoteDevice'].map((field) => ({ field: `volume.${field}`, change: (value: WindowsPathInspection) => ({ ...value, volume: { ...value.volume, [field]: field === 'remoteDevice' ? true : 'changed' } }) })),
  ...['descriptorControl', 'daclPresent', 'daclNull', 'daclDefaulted', 'daclBytes', 'ownerSid', 'ownerDefaulted', 'groupSid', 'groupDefaulted', 'currentUserSid'].map((field) => ({ field: `security.${field}`, change: (value: WindowsPathInspection) => ({ ...value, security: { ...value.security, [field]: field === 'descriptorControl' ? 0x1404 : field === 'daclBytes' ? Buffer.alloc(8) : field.endsWith('Sid') ? 'S-1-5-18' : field === 'daclPresent' ? false : true } }) })),
  { field: 'canonicalPath', change: (value) => ({ ...value, canonicalPath: `${value.canonicalPath}-other` }) },
  { field: 'kind', change: (value) => ({ ...value, kind: 'directory' }) },
  { field: 'ancestryReparseFree', change: (value) => ({ ...value, ancestryReparseFree: false }) as unknown as WindowsPathInspection }
];
describe('complete same-path evidence and creation boundaries', () => {
  it.each(['old', 'temporary'].flatMap((target) => inspectionChanges.map((change) => ({ target, ...change }))))('never discards retained $target $field evidence', async ({ target, change }) => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    await f.run(async (authority) => {
      await expect(write(f, authority, updated, { hooks: { beforeReplacement() {
        observationDrift(f, (path) => target === 'old' ? path === PATH : f.temps().includes(path), change);
      } } })).rejects.toMatchObject(beforeCode);
      expect(f.io.rename).not.toHaveBeenCalled(); expect(f.temps()).toHaveLength(1);
    });
  });
  it.each(['allocationSize', 'lastWriteTime', 'creationTime', 'numberOfLinks', 'attributes', 'security', 'bytes', 'changeTime', 'lastAccessTime'] as const)('uses movement-specific final %s rule, never full same-path equality across rename', async (field) => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    await f.run(async (authority) => {
      const operation = write(f, authority, updated, { hooks: { afterReplacement() {
        if (field === 'bytes') f.nodes.get(PATH)!.bytes = Buffer.from(wire(candidate));
        else observationDrift(f, (path) => path === PATH, (value) => field === 'security' ? { ...value, security: { ...value.security, groupSid: 'S-1-5-18' } } : { ...value, object: { ...value.object, [field]: field === 'numberOfLinks' ? '00000002' : field === 'attributes' ? 0x22 : '0000000000000002' } });
      } } });
      if (field === 'changeTime' || field === 'lastAccessTime') expect(await operation).toEqual(updated);
      else await expect(operation).rejects.toMatchObject({ code: 'WINDOWS_TRANSACTION_JOURNAL_AMBIGUOUS' });
    });
  });
  it.each(['exact', 'alias', 'ambiguous'] as const)('freshly admits only exact occupied namespace race %s, with one protected create attempt', async (kind) => {
    const f = fixture();
    await f.run(async (authority) => {
      const create = f.backend.createPrivateDirectory; let attempts = 0;
      f.backend.createPrivateDirectory = (parent, name) => {
        if (parent !== PUBLISHING || name !== 'transactions') return create(parent, name);
        attempts++;
        create(parent, kind === 'alias' ? 'Transactions' : name);
        throw new BazframeError(kind === 'ambiguous' ? 'WINDOWS_NATIVE_CREATE_AMBIGUOUS' : 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED', 'injected');
      };
      if (kind === 'exact') expect(await write(f, authority)).toEqual(candidate);
      else await expect(write(f, authority)).rejects.toMatchObject(beforeCode);
      expect(attempts).toBe(1);
      expect(f.nodes.has(kind === 'alias' ? `${PUBLISHING}\\Transactions` : ROOT)).toBe(true);
    });
  });
  it.each(['occupied', 'ambiguous', 'empty-substitution', 'empty-metadata', 'readback'] as const)('retains final creation %s uncertainty without retry or overwrite', async (kind) => {
    const f = fixture();
    await f.run(async (authority) => {
      const create = f.backend.createPrivateFile; let attempts = 0;
      f.backend.createPrivateFile = (parent, name) => {
        const result = create(parent, name);
        if (parent === ROOT) {
          attempts++;
          if (kind === 'occupied' || kind === 'ambiguous') throw new BazframeError(kind === 'occupied' ? 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED' : 'WINDOWS_NATIVE_CREATE_AMBIGUOUS', 'injected');
        }
        return result;
      };
      await expect(write(f, authority, candidate, { hooks: { afterPrivateCreation() {
        if (kind === 'empty-substitution') f.file(PATH, '');
        if (kind === 'empty-metadata') observationDrift(f, (path) => path === PATH, (value) => ({ ...value, object: { ...value.object, changeTime: '0000000000000002' } }));
      } }, io: { ...f.io, async writeExistingFile(path, bytes) {
        await f.io.writeExistingFile(path, bytes);
        if (kind === 'readback') { const read = f.backend.readStableFile; f.backend.readStableFile = async (...args) => { if (args[0] === PATH) throw new Error('readback'); return read(...args); }; }
      } } })).rejects.toMatchObject(beforeCode);
      expect(attempts).toBe(1); expect(f.nodes.has(PATH)).toBe(true); expect(f.io.rename).not.toHaveBeenCalled();
    });
  });
  it('preserves previous raw security snapshot even if an injected observation buffer is later mutated', async () => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    f.nodes.get(PATH)!.security = f.backend.inspectPath(PATH).security;
    await f.run(async (authority) => {
      await expect(write(f, authority, updated, { hooks: { beforeReplacement() { f.nodes.get(PATH)!.security!.groupSid = 'S-1-5-18'; } } })).rejects.toMatchObject(beforeCode);
      expect(f.io.rename).not.toHaveBeenCalled();
    });
  });
  it('tolerates namespace timestamp mutation while a requested payload is read', async () => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    const nativeRead = f.backend.readStableFile; let installed = false;
    f.backend.readStableFile = async (...args) => {
      const result = await nativeRead(...args);
      if (!installed && args[0] === PATH) {
        installed = true;
        observationDrift(f, (path) => path === ROOT, (value) => ({ ...value, object: { ...value.object, lastWriteTime: '0000000000000002', changeTime: '0000000000000002' } }));
      }
      return result;
    };
    expect(await read(f)).toEqual(candidate); expect(installed).toBe(true);
  });
  it('requires room before initial final creation and before missing transactions creation', async () => {
    const f = fixture();
    await f.run(async (authority) => {
      const before = f.snapshot();
      // profile-publishing already contains operation-locks; max1 permits enumeration, not another child.
      await expect(write(f, authority, candidate, { lower: { maxEntries: 1 } })).rejects.toMatchObject(beforeCode);
      expect(f.snapshot()).toBe(before);
      f.directory(ROOT); f.file(`${ROOT}\\.tmp-${'e'.repeat(32)}`, ''); f.file(`${ROOT}\\.tmp-${'f'.repeat(32)}`, '');
      const full = f.snapshot();
      await expect(write(f, authority, candidate, { lower: { maxEntries: 2 } })).rejects.toMatchObject(beforeCode);
      expect(f.snapshot()).toBe(full);
    });
  });
});

describe('requested-entry and directory anchor admission', () => {
  it.each([HOME, PUBLISHING, ROOT])('refuses changed private %s anchor during requested read', async (target) => {
    const f = fixture(); f.namespace(); f.file(PATH, wire(candidate));
    const nativeRead = f.backend.readStableFile;
    f.backend.readStableFile = async (...args) => {
      const value = await nativeRead(...args);
      if (args[0] === PATH) f.nodes.get(target)!.security = { ...f.backend.inspectPath(target).security, groupSid: 'S-1-5-18' };
      return value;
    };
    await expect(read(f)).rejects.toMatchObject({ code: 'WINDOWS_TRANSACTION_JOURNAL_REFUSED' });
    expect(f.nodes.get(PATH)!.bytes).toEqual(Buffer.from(wire(candidate)));
  });
  it.each(['read', 'initial', 'update', 'reconcile'] as const)('ignores unrequested entries during %s but counts their capacity', async (stage) => {
    const f = fixture(); f.namespace();
    const sibling = `${ROOT}\\unrelated`;
    f.reparse(sibling);
    if (stage !== 'initial') f.file(PATH, wire(candidate));
    const nativeRead = f.backend.readStableFile;
    const inspect = vi.spyOn(f.backend, 'inspectPath'), readPayload = vi.spyOn(f.backend, 'readStableFile');
    const mutate = () => { f.directory(sibling); f.file(`${PUBLISHING}\\unrelated`, 'new'); };
    if (stage === 'read') {
      readPayload.mockImplementation(async (...args) => { const value = await nativeRead(...args); if (args[0] === PATH) mutate(); return value; });
      expect(await read(f)).toEqual(candidate);
    } else await f.run(async (authority) => {
      expect(await write(f, authority, stage === 'initial' ? candidate : updated, { hooks: stage === 'reconcile' ? { afterReplacement: mutate } : { afterPrivateCreation: mutate } })).toEqual(stage === 'initial' ? candidate : updated);
    });
    expect(inspect.mock.calls.some(([path]) => path === sibling)).toBe(false);
    expect(readPayload.mock.calls.some(([path]) => path === sibling)).toBe(false);
    await expect(readWindowsTransactionJournal(f.backend, HOME, TX, { maxEntries: 1 })).rejects.toThrow();
  });
});

describe('last pre-write authority and root admission', () => {
  it.each(['authority', 'root-security'] as const)('refuses %s change during created-empty read before any payload write', async (kind) => {
    const f = fixture(); let valid = true;
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (path) => {
      const result = acquire(path); if (result.state !== 'acquired') return result;
      return { ...result, capability: { ...result.capability, assertHeld() { result.capability.assertHeld(); if (!valid) throw new Error('expired'); } } };
    };
    await f.run(async (authority) => {
      const nativeRead = f.backend.readStableFile, payloadWrite = vi.fn(f.io.writeExistingFile);
      f.backend.readStableFile = async (...args) => {
        const value = await nativeRead(...args);
        if (args[0] === PATH && value.bytes.length === 0) {
          if (kind === 'authority') valid = false;
          else f.nodes.get(ROOT)!.security = { ...f.backend.inspectPath(ROOT).security, groupSid: 'S-1-5-18' };
        }
        return value;
      };
      await expect(write(f, authority, candidate, { io: { ...f.io, writeExistingFile: payloadWrite } })).rejects.toMatchObject(beforeCode);
      expect(payloadWrite).not.toHaveBeenCalled(); expect(f.nodes.get(PATH)?.bytes).toEqual(Buffer.alloc(0));
      valid = true;
    });
  });
});
