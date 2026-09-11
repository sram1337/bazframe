import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../src/cli/run-cli.js';
import {
  BAZFRAME_WIN32_NATIVE_MAX_STABLE_DIRECTORY_ENTRIES,
  BAZFRAME_WIN32_NATIVE_MAX_STABLE_READ_BYTES,
  loadBazframeWin32Native
} from '../../../src/core/win32-native.js';

const VERSION = '0.1.0-beta.3';
const VOLUME = '0020000000000001';
const FILE_ID = '00000000000000002000000000000001';

describe('Bazframe-owned Windows native loader', () => {
  it('uses one fixed package-relative root-bundled artifact path', () => {
    let loadedPath = '';
    load(module(), (path) => { loadedPath = path; return module(); });
    expect(loadedPath.replaceAll('\\', '/')).toMatch(
      /\/artifacts\/native\/win32-x64-msvc\/bazframe-win32\.node$/u
    );
  });

  it.each([
    ['MODULE_NOT_FOUND', 'WINDOWS_NATIVE_ARTIFACT_MISSING'],
    ['ERR_MODULE_NOT_FOUND', 'WINDOWS_NATIVE_ARTIFACT_MISSING'],
    ['ERR_DLOPEN_FAILED', 'WINDOWS_NATIVE_ARTIFACT_INCOMPATIBLE'],
    ['EACCES', 'WINDOWS_NATIVE_ARTIFACT_LOAD_FAILED']
  ])('maps %s without falling back', (nativeCode, expectedCode) => {
    const loadModule = vi.fn(() => { throw coded(nativeCode); });
    expect(() => load(undefined, loadModule)).toThrow(expect.objectContaining({ code: expectedCode }));
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['platform', { platform: 'linux' as const }, 'WINDOWS_NATIVE_PLATFORM_UNSUPPORTED'],
    ['architecture', { arch: 'arm64' }, 'WINDOWS_NATIVE_ARCH_UNSUPPORTED']
  ])('rejects the wrong %s before loading', (_label, overrides, expectedCode) => {
    const loadModule = vi.fn(() => module());
    expect(() => load(undefined, loadModule, overrides)).toThrow(expect.objectContaining({ code: expectedCode }));
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('rejects a non-object native module with a stable export diagnostic', () => {
    expect(() => loadBazframeWin32Native({
      platform: 'win32',
      arch: 'x64',
      loadPackageManifest: () => ({ version: VERSION }),
      loadModule: () => null
    })).toThrow(expect.objectContaining({ code: 'WINDOWS_NATIVE_EXPORT_MISSING' }));
  });

  it('rejects missing or malformed installed root-package metadata before native loading', () => {
    const loadModule = vi.fn(() => module());
    expect(() => loadBazframeWin32Native({
      platform: 'win32',
      arch: 'x64',
      loadPackageManifest: () => ({ version: 3 }),
      loadModule
    })).toThrow(expect.objectContaining({ code: 'WINDOWS_NATIVE_PACKAGE_METADATA_INVALID' }));
    expect(loadModule).not.toHaveBeenCalled();
  });

  it.each([
    ['missing inspect export', { inspectWindowsPath: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing membership inspect export', { inspectWindowsMembershipLink: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing junction-create export', { createWindowsPrivateJunction: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing create export', { createWindowsPrivateDirectory: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing file-create export', { createWindowsPrivateFile: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing lock-acquire export', { acquireWindowsFileLock: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing lock-release export', { releaseWindowsFileLock: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing process-inspection export', { inspectWindowsProcessInstance: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing file rename export', { renameWindowsFileNoReplace: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing cross-parent move export', { moveWindowsDirectoryNoReplace: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing rename export', { renameWindowsDirectoryNoReplace: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing ZIP source classifier', { inspectWindowsZipSource: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing range read export', { readWindowsFileRangeStable: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing enumerate export', { enumerateWindowsDirectoryStable: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['legacy contract v5', { info: { contractVersion: 5 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH'],
    ['contract', { info: { contractVersion: 1 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH'],
    ['version', { info: { packageVersion: '0.1.0-other' } }, 'WINDOWS_NATIVE_VERSION_MISMATCH'],
    ['target', { info: { target: 'win32-arm64-msvc' } }, 'WINDOWS_NATIVE_TARGET_MISMATCH'],
    ['read limit', { info: { maxStableReadBytes: 1 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH'],
    ['enumeration limit', { info: { maxStableDirectoryEntries: 1 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH']
  ])('rejects native %s drift', (_label, overrides, expectedCode) => {
    expect(() => load(module(overrides))).toThrow(expect.objectContaining({ code: expectedCode }));
  });

  it('rejects old contract 7 and admits only descriptor-free ordinary receipts with explicit creation evidence', () => {
    expect(() => load(module({ info: { contractVersion: 7 } }))).toThrow(expect.objectContaining({ code: 'WINDOWS_NATIVE_CONTRACT_MISMATCH' }));
    const backend = load(module());
    expect(backend.inspectPath('C:\\state')).not.toHaveProperty('security');
    expect(backend.inspectMembershipLink('C:\\state\\membership')).not.toHaveProperty('security');
    for (const creationSecurity of [undefined, { ...security(), daclBytes: 'not bytes' }, { ...security(), ownerSid: 'not-a-sid' }]) {
      const raw = { ...creation(), creationSecurity };
      expect(() => load(module({ creation: raw })).createPrivateDirectory('C:\\state', 'child')).toThrow(expect.objectContaining({ code: 'WINDOWS_NATIVE_CREATE_AMBIGUOUS' }));
    }
    expect(backend.createPrivateDirectory('C:\\state', 'child')).toHaveProperty('creationSecurity');
    expect(load(module({ inspectWindowsZipSource: () => observation({ numberOfLinks: '00000002' }) })).inspectZipSource('C:\\input.zip').numberOfLinks).toBe('00000002');
  });

  it('accepts exact identities beyond JavaScript safe integer range without numeric conversion', async () => {
    const backend = load(module());
    const inspection = backend.inspectPath('C:\\state');
    expect(inspection.volume.identity).toBe(VOLUME);
    expect(inspection.object.fileId).toBe(FILE_ID);
    expect(typeof inspection.volume.identity).toBe('string');

    const receipt = await backend.readStableFile('C:\\state\\record.json', 3);
    expect(receipt.bytes).toEqual(Buffer.from('abc'));
    expect(receipt.before.volumeIdentity).toBe(VOLUME);
    expect(receipt.before.fileId).toBe(FILE_ID);
  });

  it.each([
    ['uppercase identity', { object: { volumeIdentity: 'a020000000000001'.toUpperCase() } }],
    ['short identity', { object: { volumeIdentity: '1' } }],
    ['numeric file identity', { object: { fileId: Number.MAX_SAFE_INTEGER } }],
    ['reparse final entry', { object: { reparseTag: 0xa000000c } }],
    ['remote volume', { volume: { remoteDevice: true } }],
    ['filesystem', { volume: { filesystemName: 'ReFS' } }],
    ['ancestry', { ancestryReparseFree: false }],
    ['kind mismatch', { kind: 'directory', object: { directory: false } }],
    ['canonical volume mismatch', { canonicalPath: '\\\\?\\Volume{aaaaaaaa-1234-1234-1234-123456789abc}\\state' }],
    ['malformed volume GUID', { volume: { canonicalVolumeGuidPath: '\\\\?\\Volume{123456781234-1234-1234-123456789abc}\\' } }],
    ['obsolete ordinary security field', { security: undefined }],
    ['noncanonical owner SID', { security: { ownerSid: 'S-1-05-18' } }],
    ['numeric current user SID', { security: { currentUserSid: 5 } }],
    ['oversized descriptor control', { security: { descriptorControl: 0x1_0000 } }],
    ['non-byte DACL', { security: { daclBytes: 'acl' } }]
  ])('rejects malformed or inadmissible path receipt: %s', (_label, receiptOverrides) => {
    const native = module({ inspection: inspection(receiptOverrides) });
    expect(() => load(native).inspectPath('C:\\state')).toThrow(expect.objectContaining({
      code: 'WINDOWS_NATIVE_RECEIPT_INVALID'
    }));
  });

  it.each([
    ['changed identity', { after: { fileId: '10000000000000002000000000000001' } }],
    ['changed size', { after: { size: '0000000000000002' } }],
    ['changed timestamp', { after: { changeTime: '0000000000000002' } }],
    ['changed attributes', { after: { attributes: 33 } }],
    ['byte count mismatch', { byteCount: '0000000000000002' }],
    ['receipt exceeds bound', { bytes: Buffer.from('abc'), byteCount: '0000000000000003' }, 2],
    ['directory', { before: { directory: true }, after: { directory: true } }]
  ])('rejects unstable or inconsistent read receipt: %s', async (_label, receiptOverrides, bound = 3) => {
    const native = module({ stableRead: stableRead(receiptOverrides) });
    await expect(load(native).readStableFile('C:\\state\\record.json', bound)).rejects.toMatchObject({
      code: expect.stringMatching(/^WINDOWS_NATIVE_(?:READ_CHANGED|RECEIPT_INVALID)$/u)
    });
  });

  it('accepts a stable sparse/compressed receipt whose allocation is smaller than logical size', async () => {
    const sparse = stableRead({
      before: { allocationSize: '0000000000000001' },
      after: { allocationSize: '0000000000000001' }
    });
    await expect(load(module({ stableRead: sparse })).readStableFile(
      'C:\\state\\record.json', 3
    )).resolves.toMatchObject({ byteCount: '0000000000000003' });
  });

  it.each([-1, 1.5, Number.NaN, BAZFRAME_WIN32_NATIVE_MAX_STABLE_READ_BYTES + 1])(
    'rejects invalid caller read bound %s before native invocation',
    async (maxBytes) => {
      const read = vi.fn(() => stableRead());
      const native = module({ readWindowsFileStable: read });
      await expect(load(native).readStableFile('C:\\state\\record.json', maxBytes)).rejects.toMatchObject({
        code: 'WINDOWS_NATIVE_READ_LIMIT_INVALID'
      });
      expect(read).not.toHaveBeenCalled();
    }
  );

  it.each(Array.from({ length: 16 }, (_, index) => 0x9000001a + index * 0x1000))('admits only concrete cloud byte-source tags %s without managed namespace inspection', (tag) => {
    const inspect = vi.fn(() => { throw new Error('managed inspection must not run'); });
    const backend = load(module({ inspectWindowsPath: inspect, inspectWindowsZipSource: () => observation({ attributes: 0x420, reparseTag: tag }) }));
    expect(backend.inspectZipSource('C:\\external\\input.zip').reparseTag).toBe(tag);
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each([
    { directory: true }, { deletePending: true },
    { attributes: 0x420, reparseTag: 0xa0000003 }, { attributes: 0x420, reparseTag: 0xa000000c },
    { attributes: 0x20, reparseTag: 0x9000001a }, { attributes: 0x420, reparseTag: 0 }, { attributes: 0x60 }
  ])('refuses special, generic-reparse and inconsistent ZIP source receipts', (change) => {
    expect(() => load(module({ inspectWindowsZipSource: () => observation(change) })).inspectZipSource('C:\\external\\input.zip')).toThrow();
  });

  it('reads a bounded range beyond the whole-file ceiling with lossless whole-object evidence', async () => {
    const size = (70 * 1024 * 1024).toString(16).padStart(16, '0');
    const receipt = stableRead({ before: { size }, after: { size } });
    const read = vi.fn(() => Promise.resolve(receipt));
    const backend = load(module({ readWindowsFileRangeStable: read }));
    expect((await backend.readStableFileRange('C:\\state\\large.zip', 64 * 1024 * 1024, 3, 1536 * 1024 * 1024)).bytes).toEqual(Buffer.from('abc'));
    expect(read).toHaveBeenCalledWith('C:\\state\\large.zip', 64 * 1024 * 1024, 3, 1536 * 1024 * 1024);
  });

  it.each([
    [-1, 1, 10], [-0, 1, 10], [1.5, 1, 10], [Number.MAX_SAFE_INTEGER, 2, 10],
    [0, 64 * 1024 * 1024 + 1, 1536 * 1024 * 1024], [0, 1, 1536 * 1024 * 1024 + 1], [10, 1, 10], [0, -1, 10]
  ])('refuses invalid native range arithmetic %s/%s/%s before invocation', async (offset, length, maximum) => {
    const read = vi.fn();
    await expect(load(module({ readWindowsFileRangeStable: read })).readStableFileRange('C:\\state\\archive.zip', offset, length, maximum)).rejects.toMatchObject({ code: 'WINDOWS_NATIVE_READ_LIMIT_INVALID' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { bytes: Buffer.from('ab'), byteCount: '0000000000000002' },
    { after: { fileId: '10000000000000002000000000000001' } },
    { after: { changeTime: '0000000000000002' } },
    { before: { size: '0000000000000002' }, after: { size: '0000000000000002' } }
  ])('refuses truncated or drifting range receipts', async (changed) => {
    await expect(load(module({ stableRead: stableRead(changed) })).readStableFileRange('C:\\state\\archive.zip', 0, 3, 10)).rejects.toThrow();
  });

  it('accepts exact no-follow directory symlink and junction inspection receipts', () => {
    const backend = load(module());
    expect(backend.inspectMembershipLink('C:\\state\\membership')).toMatchObject({
      object: { reparseTag: 0xa0000003, directory: true },
      normalizedTarget: expect.stringContaining('\\target'),
      targetVolumeIdentity: VOLUME,
      targetFileId: FILE_ID
    });

    expect(load(module({ membershipInspection: membershipInspection({ object: { reparseTag: 0xa000000c } }) }))
      .inspectMembershipLink('C:\\state\\membership').object.reparseTag).toBe(0xa000000c);

    for (const malformed of [
      { extra: true },
      { ancestryReparseFree: false },
      { normalizedTarget: 'C:\\target' },
      { targetVolumeIdentity: '1' },
      { targetFileId: '1' },
      { security: { extra: true } },
      { security: { ownerSid: 'not-a-sid' } },
      { object: { reparseTag: 0x8000001b } },
      { object: { attributes: 16 } },
      { object: { deletePending: true } }
    ]) {
      expect(() => load(module({ membershipInspection: membershipInspection(malformed) }))
        .inspectMembershipLink('C:\\state\\membership'))
        .toThrow(expect.objectContaining({ code: 'WINDOWS_NATIVE_RECEIPT_INVALID' }));
    }
  });

  it.each([
    ['ERR_WIN32_MEMBERSHIP_LINK_INVALID', 'WINDOWS_NATIVE_MEMBERSHIP_LINK_INVALID'],
    ['ERR_WIN32_MEMBERSHIP_TARGET_INVALID', 'WINDOWS_NATIVE_MEMBERSHIP_TARGET_INVALID'],
    ['ERR_WIN32_MEMBERSHIP_CHANGED', 'WINDOWS_NATIVE_MEMBERSHIP_CHANGED']
  ])('maps native membership refusal %s without fallback', (nativeCode, expectedCode) => {
    const inspect = vi.fn(() => { throw coded(nativeCode); });
    const native = module({ inspectWindowsMembershipLink: inspect });
    expect(() => load(native).inspectMembershipLink('C:\\state\\membership'))
      .toThrow(expect.objectContaining({ code: expectedCode }));
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('validates private-junction mutation receipts and maps malformed success to ambiguity', () => {
    const backend = load(module());
    expect(backend.createPrivateJunction('C:\\state', 'membership', 'C:\\target'))
      .toMatchObject({
        parentBefore: { kind: 'directory' },
        created: { object: { reparseTag: 0xa0000003 } },
        parentAfter: { kind: 'directory' }
      });

    for (const malformed of [
      { extra: true },
      { parentAfter: directoryInspection('other-parent') },
      { created: membershipInspection({ object: { reparseTag: 0xa000000c } }) },
      { created: membershipInspection({ canonicalPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\state\\other' }) }
    ]) {
      expect(() => load(module({ junctionCreation: junctionCreation(malformed) }))
        .createPrivateJunction('C:\\state', 'membership', 'C:\\target'))
        .toThrow(expect.objectContaining({ code: 'WINDOWS_NATIVE_CREATE_AMBIGUOUS' }));
    }
  });

  it('validates private-directory mutation receipts and maps malformed success to ambiguity', () => {
    const native = module();
    const backend = load(native);
    const receipt = backend.createPrivateDirectory('C:\\state', 'child');
    expect(receipt.created.kind).toBe('directory');
    expect(native.createWindowsPrivateDirectory).toBeTypeOf('function');

    const malformed = module({ creation: { parentBefore: directoryInspection('state') } });
    expect(() => load(malformed).createPrivateDirectory('C:\\state', 'child')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_NATIVE_CREATE_AMBIGUOUS' })
    );
  });

  it('requires stable parent identity but allows timestamp changes in create receipts', () => {
    const timestampOnly = creation();
    timestampOnly.parentAfter = directoryInspection('state');
    (timestampOnly.parentAfter as Record<string, unknown>).object = observation({
      directory: true,
      attributes: 16,
      changeTime: '0000000000000002'
    });
    expect(() => load(module({ creation: timestampOnly })).createPrivateDirectory('C:\\state', 'child')).not.toThrow();

    const identityDrift = creation();
    identityDrift.parentAfter = directoryInspection('state', '00000000000000002000000000000009');
    expect(() => load(module({ creation: identityDrift })).createPrivateDirectory('C:\\state', 'child')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_NATIVE_CREATE_AMBIGUOUS' })
    );
  });

  it.each([
    ['ERR_WIN32_ALREADY_EXISTS', 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED'],
    ['ERR_WIN32_CREATE_AMBIGUOUS', 'WINDOWS_NATIVE_CREATE_AMBIGUOUS'],
    ['UNKNOWN_NATIVE_FAILURE', 'WINDOWS_NATIVE_CREATE_AMBIGUOUS']
  ])('maps native create refusal %s distinctly', (nativeCode, expectedCode) => {
    const native = module({
      createWindowsPrivateDirectory: () => { throw coded(nativeCode); }
    });
    expect(() => load(native).createPrivateDirectory('C:\\state', 'child')).toThrow(
      expect.objectContaining({ code: expectedCode })
    );
  });

  it('validates first-visible private-file creation receipts', () => {
    const native = module();
    const backend = load(native);
    expect(backend.createPrivateFile('C:\\state', 'journal.json').created).toMatchObject({
      kind: 'regular-file',
      object: { size: '0000000000000000', numberOfLinks: '00000001' }
    });
    const malformed = module({ privateFileCreation: creation() });
    expect(() => load(malformed).createPrivateFile('C:\\state', 'journal.json')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_NATIVE_CREATE_AMBIGUOUS' })
    );
  });

  it('wraps acquired file locks in an expiring capability and validates process instances', () => {
    const native = module();
    const backend = load(native);
    const acquired = backend.acquireFileLock('C:\\state\\guard');
    expect(acquired.state).toBe('acquired');
    if (acquired.state !== 'acquired') throw new Error('expected acquired lock');
    acquired.capability.assertHeld();
    acquired.capability.release();
    acquired.capability.release();
    expect(native.releaseWindowsFileLock).toHaveBeenCalledWith('0000000000000001');
    expect(() => acquired.capability.assertHeld()).toThrow(expect.objectContaining({
      code: 'WINDOWS_NATIVE_LOCK_NOT_HELD'
    }));
    expect(backend.inspectProcessInstance({ pid: 42, creationTime: '0000000000000001' }))
      .toEqual({ state: 'running' });
    expect(native.inspectWindowsProcessInstance).toHaveBeenCalledWith(42, '0000000000000001');
  });

  it('accepts an exact busy lock receipt with an explicit null token', () => {
    const busy = { ...lockAcquisition(), state: 'busy', token: null };
    expect(load(module({ lockAcquisition: busy })).acquireFileLock('C:\\state\\guard'))
      .toMatchObject({ state: 'busy', currentProcess: { pid: 42 } });

    const missingToken = Object.fromEntries(
      Object.entries(busy).filter(([key]) => key !== 'token')
    );
    expect(() => load(module({ lockAcquisition: missingToken })).acquireFileLock(
      'C:\\state\\guard'
    )).toThrow(expect.objectContaining({ code: 'WINDOWS_NATIVE_RECEIPT_INVALID' }));
  });

  it('rejects malformed acquired lock receipts only after releasing their native handle', () => {
    const release = vi.fn();
    const native = module({
      releaseWindowsFileLock: release,
      lockAcquisition: { ...lockAcquisition(), unexpected: true }
    });
    expect(() => load(native).acquireFileLock('C:\\state\\guard')).toThrow(expect.objectContaining({
      code: 'WINDOWS_NATIVE_RECEIPT_INVALID'
    }));
    expect(release).toHaveBeenCalledWith('0000000000000001');
  });

  it('calls only the native no-replace rename with validated sibling components', async () => {
    const native = module();
    const backend = load(native);
    await backend.renameDirectoryNoReplace('C:\\state', 'candidate', 'profile');
    expect(native.renameWindowsDirectoryNoReplace).toHaveBeenCalledWith(
      'C:\\state', 'candidate', 'profile'
    );
    await expect(backend.renameDirectoryNoReplace('C:\\state', 'PROFILE', 'profile')).rejects.toMatchObject({
      code: 'WINDOWS_NATIVE_PATH_INVALID'
    });
    expect(native.renameWindowsDirectoryNoReplace).toHaveBeenCalledTimes(1);
  });

  it('passes two separately validated parents to directory no-replace movement', async () => {
    const native = module(); const backend = load(native);
    await backend.moveDirectoryNoReplace('C:\\staging', 'repo', 'C:\\checkouts', 'repo');
    expect(native.moveWindowsDirectoryNoReplace).toHaveBeenCalledWith('C:\\staging', 'repo', 'C:\\checkouts', 'repo');
    for (const component of ['other/repo', '../repo', 'repo\\child']) await expect(backend.moveDirectoryNoReplace('C:\\staging', component, 'C:\\checkouts', 'repo')).rejects.toThrow();
    await expect(backend.moveDirectoryNoReplace('C:\\staging', 'repo', 'C:\\staging', 'REPO')).rejects.toThrow();
    expect(native.moveWindowsDirectoryNoReplace).toHaveBeenCalledTimes(1);
    expect(native.renameWindowsDirectoryNoReplace).not.toHaveBeenCalled();
  });

  it('uses the distinct regular-file no-replace export and refuses aliases or non-sibling components', async () => {
    const native = module(); const backend = load(native);
    await backend.renameFileNoReplace('C:\\state', '.blob-123', 'digest');
    expect(native.renameWindowsFileNoReplace).toHaveBeenCalledWith('C:\\state', '.blob-123', 'digest');
    expect(native.renameWindowsDirectoryNoReplace).not.toHaveBeenCalled();
    for (const [source, destination] of [['DIGEST', 'digest'], ['../outside', 'digest'], ['source', 'other/file']]) {
      await expect(backend.renameFileNoReplace('C:\\state', source!, destination!)).rejects.toThrow();
    }
    expect(native.renameWindowsFileNoReplace).toHaveBeenCalledTimes(1);
    const occupied = module({ renameWindowsFileNoReplace: () => Promise.reject(coded('GenericFailure', 'ERR_WIN32_ALREADY_EXISTS: occupied')) });
    await expect(load(occupied).renameFileNoReplace('C:\\state', 'source', 'target')).rejects.toMatchObject({ code: 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED' });
  });

  it('maps native no-replace rename refusals without a fallback', async () => {
    const native = module({
      renameWindowsDirectoryNoReplace: () => Promise.reject(
        coded('GenericFailure', 'ERR_WIN32_ALREADY_EXISTS: occupied')
      )
    });
    await expect(load(native).renameDirectoryNoReplace(
      'C:\\state', 'candidate', 'profile'
    )).rejects.toMatchObject({ code: 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED' });
  });

  it('maps typed native operation refusal without exposing a weaker path', () => {
    const native = module({
      inspectWindowsPath: () => { throw coded('ERR_WIN32_VOLUME_REMOTE'); }
    });
    expect(() => load(native).inspectPath('Z:\\state')).toThrow(expect.objectContaining({
      code: 'WINDOWS_NATIVE_VOLUME_REMOTE'
    }));
  });

  it('maps an asynchronous native rejection and distinguishes input size from caller validation', async () => {
    const native = module({
      readWindowsFileStable: () => Promise.reject(
        coded('GenericFailure', 'ERR_WIN32_READ_LIMIT: input exceeds bound')
      )
    });
    await expect(load(native).readStableFile('C:\\state\\record.json', 3)).rejects.toMatchObject({
      code: 'WINDOWS_NATIVE_READ_LIMIT_EXCEEDED'
    });
  });

  it('accepts exact stable directory enumeration facts in UTF-16 ordinal order', async () => {
    const receipt = enumeration({
      entries: [entry({ name: 'a' }), entry({ name: '😀', fileId: '00000000000000002000000000000002' })]
    });
    await expect(load(module({ enumeration: receipt })).enumerateStableDirectory(
      'C:\\state', 2
    )).resolves.toMatchObject({
      entries: [
        { name: 'a', fileId: FILE_ID, reparseTag: null, directory: false },
        { name: '😀', fileId: '00000000000000002000000000000002' }
      ]
    });
  });

  it.each([
    ['extra receipt key', { extra: true }, 2],
    ['over bound array', { entries: [entry()] }, 0],
    ['duplicate names', { entries: [entry(), entry()] }, 2],
    ['unsorted names', { entries: [entry({ name: 'b' }), entry({ name: 'a' })] }, 2],
    ['separator name', { entries: [entry({ name: 'a\\\\b' })] }, 2],
    ['unpaired UTF-16 name', { entries: [entry({ name: '\ud800' })] }, 2],
    ['short file ID', { entries: [entry({ fileId: '1' })] }, 2],
    ['directory flag mismatch', { entries: [entry({ directory: true })] }, 2],
    ['reparse flag mismatch', { entries: [entry({ reparseTag: 0xa000000c })] }, 2]
  ])('rejects malformed directory enumeration receipt: %s', async (_label, overrides, bound) => {
    await expect(load(module({ enumeration: enumeration(overrides) })).enumerateStableDirectory(
      'C:\\state', bound
    )).rejects.toMatchObject({ code: 'WINDOWS_NATIVE_RECEIPT_INVALID' });
  });

  it('distinguishes changed directory receipts from malformed evidence', async () => {
    const receipt = enumeration({
      directoryAfter: directoryInspection('state', '00000000000000002000000000000009')
    });
    await expect(load(module({ enumeration: receipt })).enumerateStableDirectory(
      'C:\\state', 0
    )).rejects.toMatchObject({ code: 'WINDOWS_NATIVE_DIRECTORY_CHANGED' });
  });

  it.each([-1, -0, 1.5, Number.NaN, BAZFRAME_WIN32_NATIVE_MAX_STABLE_DIRECTORY_ENTRIES + 1])(
    'rejects invalid caller enumeration bound %s before native invocation',
    async (maxEntries) => {
      const enumerate = vi.fn(() => enumeration());
      const native = module({ enumerateWindowsDirectoryStable: enumerate });
      await expect(load(native).enumerateStableDirectory('C:\\state', maxEntries)).rejects.toMatchObject({
        code: 'WINDOWS_NATIVE_ENUMERATION_LIMIT_INVALID'
      });
      expect(enumerate).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['ERR_WIN32_ENUMERATION_LIMIT', 'WINDOWS_NATIVE_ENUMERATION_LIMIT_EXCEEDED'],
    ['ERR_WIN32_ENUMERATION_CHANGED', 'WINDOWS_NATIVE_DIRECTORY_CHANGED'],
    ['ERR_WIN32_ENUMERATION_INCOMPLETE', 'WINDOWS_NATIVE_ENUMERATION_INCOMPLETE']
  ])('maps native enumeration refusal %s', async (nativeCode, expectedCode) => {
    const native = module({
      enumerateWindowsDirectoryStable: () => Promise.reject(coded('GenericFailure', `${nativeCode}: refused`))
    });
    await expect(load(native).enumerateStableDirectory('C:\\state', 1)).rejects.toMatchObject({
      code: expectedCode
    });
  });

  it('does not connect the internal loader seam to the public Windows CLI gate', async () => {
    const reached: string[] = [];
    let stderr = '';
    const status = await runCli(['status'], {
      platform: 'win32',
      environment: {},
      userHome: 'C:\\must-not-be-read',
      cwd: () => { reached.push('cwd'); return 'C:\\must-not-be-read'; },
      writeStdout: () => undefined,
      writeStderr: (text) => { stderr += text; },
      profileRuntime: async () => { reached.push('runtime'); throw new Error('bypass'); }
    });
    expect(status).toBe(1);
    expect(reached).toEqual([]);
    expect(stderr).toContain('WINDOWS_PLATFORM_UNSUPPORTED');
  });
});

function load(
  native: Record<string, unknown> = module(),
  loadModule: (path: string) => unknown = () => native,
  overrides: { platform?: NodeJS.Platform; arch?: string } = {}
) {
  return loadBazframeWin32Native({
    platform: overrides.platform ?? 'win32',
    arch: overrides.arch ?? 'x64',
    loadPackageManifest: () => ({ version: VERSION }),
    loadModule
  });
}

function module(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const info = {
    contractVersion: 8,
    packageVersion: VERSION,
    target: 'win32-x64-msvc',
    maxStableReadBytes: BAZFRAME_WIN32_NATIVE_MAX_STABLE_READ_BYTES,
    maxStableDirectoryEntries: BAZFRAME_WIN32_NATIVE_MAX_STABLE_DIRECTORY_ENTRIES,
    ...record(overrides.info)
  };
  return {
    getNativeWindowsInfo: () => info,
    inspectWindowsPath: () => overrides.inspection ?? inspection(),
    inspectWindowsEditorTarget: vi.fn(),
    inspectWindowsMembershipLink: () => overrides.membershipInspection ?? membershipInspection(),
    createWindowsPrivateJunction: () => overrides.junctionCreation ?? junctionCreation(),
    createWindowsPrivateDirectory: () => overrides.creation ?? creation(),
    createWindowsPrivateFile: () => overrides.privateFileCreation ?? privateFileCreation(),
    acquireWindowsFileLock: vi.fn(() => overrides.lockAcquisition ?? lockAcquisition()),
    releaseWindowsFileLock: vi.fn(),
    inspectWindowsProcessInstance: vi.fn(() => overrides.processInspection ?? { state: 'running' }),
    moveWindowsDirectoryNoReplace: vi.fn(() => Promise.resolve()),
    renameWindowsDirectoryNoReplace: vi.fn(() => Promise.resolve()),
    renameWindowsFileNoReplace: vi.fn(() => Promise.resolve()),
    inspectWindowsZipSource: () => inspection().object,
    readWindowsFileRangeStable: () => Promise.resolve(overrides.stableRead ?? stableRead()),
    readWindowsFileStable: () => Promise.resolve(overrides.stableRead ?? stableRead()),
    enumerateWindowsDirectoryStable: () => Promise.resolve(overrides.enumeration ?? enumeration()),
    ...without(overrides, [
      'info', 'inspection', 'membershipInspection', 'junctionCreation', 'creation', 'privateFileCreation',
      'lockAcquisition', 'processInspection', 'stableRead', 'enumeration'
    ])
  };
}

function inspection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canonicalPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\state',
    kind: 'regular-file',
    volume: {
      identity: VOLUME,
      filesystemName: 'NTFS',
      driveType: 'fixed',
      canonicalVolumeGuidPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\',
      remoteDevice: false,
      ...record(overrides.volume)
    },
    object: observation(record(overrides.object)),
    ancestryReparseFree: true,
    ...without(overrides, ['volume', 'object'])
  };
}

function membershipInspection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canonicalPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\state\\membership',
    volume: {
      identity: VOLUME,
      filesystemName: 'NTFS',
      driveType: 'fixed',
      canonicalVolumeGuidPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\',
      remoteDevice: false,
      ...record(overrides.volume)
    },
    object: observation({
      directory: true,
      attributes: 0x410,
      reparseTag: 0xa0000003,
      ...record(overrides.object)
    }),
    ancestryReparseFree: true,
    normalizedTarget: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\target',
    targetVolumeIdentity: VOLUME,
    targetFileId: FILE_ID,
    ...without(overrides, ['volume', 'object'])
  };
}

function junctionCreation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    creationSecurity: security(),
    parentBefore: directoryInspection('state'),
    created: membershipInspection(),
    parentAfter: directoryInspection('state'),
    ...overrides
  };
}

function creation(): Record<string, unknown> {
  return {
    creationSecurity: security(),
    parentBefore: directoryInspection('state'),
    created: directoryInspection('state\\child', '00000000000000002000000000000002'),
    parentAfter: directoryInspection('state')
  };
}

function privateFileCreation(): Record<string, unknown> {
  return {
    creationSecurity: security(),
    parentBefore: directoryInspection('state'),
    created: inspection({
      canonicalPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\state\\journal.json',
      object: { size: '0000000000000000' }
    }),
    parentAfter: directoryInspection('state')
  };
}

function lockAcquisition(): Record<string, unknown> {
  const guard = inspection({ object: { size: '0000000000000000' } });
  return {
    state: 'acquired',
    token: '0000000000000001',
    guardBefore: guard,
    guardAfter: guard,
    currentProcess: { pid: 42, creationTime: '0000000000000001' }
  };
}

function directoryInspection(path: string, fileId = FILE_ID): Record<string, unknown> {
  return inspection({
    canonicalPath: `\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\${path}`,
    kind: 'directory',
    object: { directory: true, attributes: 16, fileId }
  });
}

function security(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptorControl: 0x1004,
    daclPresent: true,
    daclNull: false,
    daclDefaulted: false,
    daclBytes: Buffer.from([2, 0, 8, 0, 0, 0, 0, 0]),
    ownerSid: 'S-1-5-21-1',
    ownerDefaulted: false,
    groupSid: 'S-1-5-21-1',
    groupDefaulted: false,
    currentUserSid: 'S-1-5-21-1',
    ...overrides
  };
}

function stableRead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bytes: Buffer.from('abc'),
    byteCount: '0000000000000003',
    before: observation(record(overrides.before)),
    after: observation(record(overrides.after)),
    ...without(overrides, ['before', 'after'])
  };
}

function enumeration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    directoryBefore: directoryInspection('state'),
    entries: [],
    directoryAfter: directoryInspection('state'),
    ...overrides
  };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'a',
    fileId: FILE_ID,
    size: '0000000000000003',
    allocationSize: '0000000000001000',
    creationTime: '0000000000000001',
    lastWriteTime: '0000000000000001',
    changeTime: '0000000000000001',
    attributes: 32,
    reparseTag: 0,
    directory: false,
    ...overrides
  };
}

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    volumeIdentity: VOLUME,
    fileId: FILE_ID,
    size: '0000000000000003',
    allocationSize: '0000000000001000',
    numberOfLinks: '00000001',
    creationTime: '0000000000000001',
    lastAccessTime: '0000000000000001',
    lastWriteTime: '0000000000000001',
    changeTime: '0000000000000001',
    attributes: 32,
    reparseTag: 0,
    deletePending: false,
    directory: false,
    ...overrides
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function without(value: Record<string, unknown>, excluded: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key)));
}

function coded(code: string, message = 'native failure'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('error-only native read-change diagnosis', async () => {
  const { sanitizeProductError } = await import(new URL('../../../scripts/test-win32-profile-provisioning-child.mjs', import.meta.url).href);
  const diagnostic = { site: 'reopened-prefix', objectKind: 'directory', prefixRole: 'ancestor', differingFields: ['object.changeTime', 'canonicalPath'] };
  const reason = 'read-change|reopened-prefix|directory|ancestor|object.changeTime,canonicalPath';
  it.each(['sync', 'async'])('decodes %s native transport without replacing its original cause', async (mode) => {
    const original = coded(mode === 'sync' ? 'ERR_WIN32_READ_CHANGED' : 'GenericFailure', mode === 'sync' ? reason : `ERR_WIN32_READ_CHANGED: ${reason}`);
    const originalCause = new Error('PRIVATE-SID-PATH');
    original.cause = originalCause;
    const backend = load(module({ inspectWindowsPath() { throw original; }, readWindowsFileStable() { return Promise.reject(original); } }));
    const error = await (async () => { try { return mode === 'sync' ? backend.inspectPath('C:\\private') : await backend.readStableFile('C:\\private', 3); } catch (error) { return error; } })();
    expect(error).toMatchObject({ code: 'WINDOWS_NATIVE_READ_CHANGED', nativeReadChange: diagnostic });
    expect((error as Error).cause).toBe(original);
    expect(original.cause).toBe(originalCause);
    const sanitized = sanitizeProductError(error);
    expect(sanitized.nativeReadChange).toEqual(diagnostic);
    expect(sanitizeProductError(JSON.parse(JSON.stringify(sanitized)))).toEqual(sanitized);
    expect(JSON.stringify(sanitized)).not.toContain('PRIVATE');
  });
  const maximalFields = [
    'object.volumeIdentity', 'object.fileId', 'object.size', 'object.allocationSize', 'object.numberOfLinks',
    'object.creationTime', 'object.lastWriteTime', 'object.changeTime', 'object.attributes', 'object.reparseTag',
    'object.deletePending', 'object.directory',

    'canonicalPath'
  ];
  const maximalReason = ['read-change', 'reopened-prefix', 'regular-file', 'drive-root', maximalFields.join(',')].join('|');
  it.each(['sync', 'async'])('accepts the maximal supported %s diagnostic with its original cause', async (mode) => {
    expect(maximalReason.length).toBe(289); // Fixture length, not a production limit.
    const original = coded(mode === 'sync' ? 'ERR_WIN32_READ_CHANGED' : 'GenericFailure',
      mode === 'sync' ? maximalReason : `ERR_WIN32_READ_CHANGED: ${maximalReason}`);
    const backend = load(module({ inspectWindowsPath() { throw original; }, readWindowsFileStable: () => Promise.reject(original) }));
    const error = await (async () => { try { return mode === 'sync' ? backend.inspectPath('C:\\private') : await backend.readStableFile('C:\\private', 3); } catch (error) { return error; } })();
    expect(error).toMatchObject({ code: 'WINDOWS_NATIVE_READ_CHANGED', nativeReadChange: {
      site: 'reopened-prefix', objectKind: 'regular-file', prefixRole: 'drive-root', differingFields: maximalFields
    } });
    expect((error as Error).cause).toBe(original);
    expect(sanitizeProductError(error).nativeReadChange.differingFields).toEqual(maximalFields);
  });
  it.each(['sync', 'async'])('rejects oversized %s text before splitting, retaining code/cause', (mode) => {
    const oversized = `${maximalReason}${"X".repeat(100)}`;
    const original = coded(mode === 'sync' ? 'ERR_WIN32_READ_CHANGED' : 'GenericFailure',
      mode === 'sync' ? oversized : `ERR_WIN32_READ_CHANGED: ${oversized}`);
    const backend = load(module({ inspectWindowsPath() { throw original; } }));
    const split = vi.spyOn(String.prototype, 'split');
    let error: unknown, splitCalls: number;
    try { backend.inspectPath('C:\\private'); } catch (caught) { error = caught; }
    finally { splitCalls = split.mock.calls.length; split.mockRestore(); }
    expect(splitCalls).toBe(0);
    expect(error).toMatchObject({ code: 'WINDOWS_NATIVE_READ_CHANGED' });
    expect((error as Error).cause).toBe(original);
    expect(error).not.toHaveProperty('nativeReadChange');
  });
  it.each(['iterator-private', 'iterator-throws', 'methods-invalid', 'changing-index', 'sparse', 'duplicate', 'over-count'])(
    'captures only validated indexed fields at the native decoder seam: %s', (mode) => {
      const fields = mode === 'sparse' ? new Array<string>(1) : mode === 'over-count' ? new Array<string>(24)
        : mode === 'duplicate' ? ['object.changeTime', 'object.changeTime'] : [mode === 'methods-invalid' ? 'PRIVATE' : 'object.changeTime'];
      let iteratorCalls = 0, indexReads = 0;
      Object.defineProperty(fields, Symbol.iterator, { value: function* () {
        iteratorCalls++;
        if (mode === 'iterator-throws') throw new Error('PRIVATE iterator');
        yield 'PRIVATE';
      } });
      Object.defineProperty(fields, 'some', { value: () => false });
      if (mode === 'changing-index' || mode === 'over-count') Object.defineProperty(fields, '0', { get() {
        indexReads++;
        return indexReads === 1 ? 'object.changeTime' : 'PRIVATE';
      } });
      const original = coded('ERR_WIN32_READ_CHANGED', 'read-change|reopened-prefix|directory|ancestor|object.changeTime');
      const backend = load(module({ inspectWindowsPath() { throw original; } }));
      // Inject at the parser's field-array seam without exporting the internal validator.
      const split = vi.spyOn(String.prototype, 'split')
        .mockReturnValueOnce(['read-change', 'reopened-prefix', 'directory', 'ancestor', 'object.changeTime'])
        .mockReturnValueOnce(fields);
      let error: unknown;
      try { backend.inspectPath('C:\\private'); } catch (caught) { error = caught; }
      finally { split.mockRestore(); }
      expect(error).toMatchObject({ code: 'WINDOWS_NATIVE_READ_CHANGED' });
      expect((error as Error).cause).toBe(original);
      expect(iteratorCalls).toBe(0);
      expect(indexReads).toBe(mode === 'changing-index' ? 1 : 0);
      const sanitized = sanitizeProductError(error);
      if (['iterator-private', 'iterator-throws', 'changing-index'].includes(mode)) {
        expect(sanitized.nativeReadChange.differingFields).toEqual(['object.changeTime']);
      } else expect(error).not.toHaveProperty('nativeReadChange');
      expect(JSON.stringify(sanitized)).not.toContain('PRIVATE');
      expect(sanitizeProductError(JSON.parse(JSON.stringify(sanitized)))).toEqual(sanitized);
    }
  );
  it.each([
    ['inspect-opened-path', 'regular-file', 'none', 'object.fileId'],
    ['rename-parent', 'directory', 'none', 'kindDirectory,reparseTagZero,notDeletePending,objectDirectory'],
    ['stable-read-growth', 'regular-file', 'none', 'growthProbeNonzero'],
    ['stable-read-final', 'regular-file', 'none', 'byteCountExpected,afterSizeByteCount,object.size'],
    ['reopened-prefix', 'directory', 'drive-root', 'object.lastWriteTime'],
    ['reopened-prefix', 'regular-file', 'final', 'object.fileId']
  ])('decodes fixed site/kind/role/predicates %s %s %s', async (site, objectKind, prefixRole, fields) => {
    const original = coded('GenericFailure', `ERR_WIN32_READ_CHANGED: read-change|${site}|${objectKind}|${prefixRole}|${fields}`);
    const backend = load(module({ readWindowsFileStable: () => Promise.reject(original) }));
    await expect(backend.readStableFile('C:\\private', 3)).rejects.toMatchObject({ nativeReadChange: { site, objectKind, prefixRole, differingFields: fields.split(',') }, cause: original });
  });
  it.each([
    'legacy private native message', `${reason}|PRIVATE`, `${reason},PRIVATE`,
    'read-change|PRIVATE|directory|ancestor|object.size',
    'read-change|reopened-prefix|PRIVATE|ancestor|object.size',
    'read-change|reopened-prefix|directory|PRIVATE|object.size',
    'read-change|reopened-prefix|directory|none|object.size',
    'read-change|reopened-prefix|directory|ancestor|object.size,object.size',
    'read-change|reopened-prefix|directory|ancestor|',
    'read-change|reopened-prefix|directory|ancestor|security.PRIVATE',
    'read-change|stable-read-final|regular-file|none|security.daclBytes',
    'read-change|stable-read-growth|regular-file|none|object.size',
    'read-change|stable-read-receipt|regular-file|none|beforeDirectory',
    `PRIVATE ${reason}`, `${reason}\nPRIVATE`
  ])('retains legacy/malformed rejection without admitting diagnostic text: %s', async (message) => {
    const original = coded('ERR_WIN32_READ_CHANGED', message);
    const error = await load(module({ readWindowsFileStable: () => Promise.reject(original) })).readStableFile('C:\\private', 3).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'WINDOWS_NATIVE_READ_CHANGED', cause: original });
    expect(error).not.toHaveProperty('nativeReadChange');
  });
  it.each(['ERR_WIN32_READ_CHANGED', 'GenericFailure', 'ERR_WIN32_FUTURE'])('never coerces hostile non-string messages for %s', async (code) => {
    const original = coded(code);
    Object.defineProperty(original, 'message', { value: { toString() { throw new Error('coerced private message'); } } });
    const error = await load(module({ readWindowsFileStable: () => Promise.reject(original) })).readStableFile('C:\\private', 3).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: code === 'ERR_WIN32_READ_CHANGED' ? 'WINDOWS_NATIVE_READ_CHANGED' : 'WINDOWS_NATIVE_OPERATION_FAILED', cause: original });
    expect(error).not.toHaveProperty('nativeReadChange');
  });
  it.each(['ERR_WIN32_READ_CHANGED', 'GenericFailure'])('does not let a hostile message getter replace the original %s cause', async (code) => {
    const original = coded(code);
    Object.defineProperty(original, 'message', { get() { throw new Error('PRIVATE accessor'); } });
    const error = await load(module({ readWindowsFileStable: () => Promise.reject(original) })).readStableFile('C:\\private', 3).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: code === 'ERR_WIN32_READ_CHANGED' ? 'WINDOWS_NATIVE_READ_CHANGED' : 'WINDOWS_NATIVE_OPERATION_FAILED' });
    expect((error as Error).cause).toBe(original);
    expect(error).not.toHaveProperty('nativeReadChange');
  });
  it('does not add native diagnostics to unknown codes even with a valid-looking reason', async () => {
    const original = coded('ERR_WIN32_FUTURE', reason);
    const error = await load(module({ readWindowsFileStable: () => Promise.reject(original) })).readStableFile('C:\\private', 3).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'WINDOWS_NATIVE_OPERATION_FAILED', cause: original });
    expect(error).not.toHaveProperty('nativeReadChange');
  });
  it('distinguishes the receipt-only refusal and leaves its cause absent', async () => {
    const value = stableRead({ before: { directory: true }, after: { directory: true } });
    const error = await load(module({ stableRead: value })).readStableFile('C:\\private', 3).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'WINDOWS_NATIVE_READ_CHANGED', nativeReadChange: {
      site: 'stable-read-receipt', objectKind: 'directory', prefixRole: 'none', differingFields: ['beforeDirectory', 'afterDirectory']
    } });
    expect((error as Error).cause).toBeUndefined();
  });
  it('reports exact receipt fields without normalizing them or including last-access time', async () => {
    const unchanged = stableRead({ after: { lastAccessTime: '0000000000000002' } });
    await expect(load(module({ stableRead: unchanged })).readStableFile('C:\\private', 3)).resolves.toMatchObject({ byteCount: '0000000000000003' });
    const changed = stableRead({ after: { changeTime: '0000000000000002', size: '0000000000000004' } });
    await expect(load(module({ stableRead: changed })).readStableFile('C:\\private', 3)).rejects.toMatchObject({ code: 'WINDOWS_NATIVE_READ_CHANGED', nativeReadChange: {
      differingFields: ['object.size', 'object.changeTime', 'afterSizeByteCount']
    } });
  });
});
