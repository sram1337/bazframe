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
    ['missing create export', { createWindowsPrivateDirectory: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing file-create export', { createWindowsPrivateFile: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing lock-acquire export', { acquireWindowsFileLock: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing lock-release export', { releaseWindowsFileLock: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing process-inspection export', { inspectWindowsProcessInstance: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing rename export', { renameWindowsDirectoryNoReplace: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['missing enumerate export', { enumerateWindowsDirectoryStable: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['legacy contract v4', { info: { contractVersion: 4 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH'],
    ['contract', { info: { contractVersion: 1 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH'],
    ['version', { info: { packageVersion: '0.1.0-other' } }, 'WINDOWS_NATIVE_VERSION_MISMATCH'],
    ['target', { info: { target: 'win32-arm64-msvc' } }, 'WINDOWS_NATIVE_TARGET_MISMATCH'],
    ['read limit', { info: { maxStableReadBytes: 1 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH'],
    ['enumeration limit', { info: { maxStableDirectoryEntries: 1 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH']
  ])('rejects native %s drift', (_label, overrides, expectedCode) => {
    expect(() => load(module(overrides))).toThrow(expect.objectContaining({ code: expectedCode }));
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
    ['missing security', { security: undefined }],
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
    contractVersion: 5,
    packageVersion: VERSION,
    target: 'win32-x64-msvc',
    maxStableReadBytes: BAZFRAME_WIN32_NATIVE_MAX_STABLE_READ_BYTES,
    maxStableDirectoryEntries: BAZFRAME_WIN32_NATIVE_MAX_STABLE_DIRECTORY_ENTRIES,
    ...record(overrides.info)
  };
  return {
    getNativeWindowsInfo: () => info,
    inspectWindowsPath: () => overrides.inspection ?? inspection(),
    createWindowsPrivateDirectory: () => overrides.creation ?? creation(),
    createWindowsPrivateFile: () => overrides.privateFileCreation ?? privateFileCreation(),
    acquireWindowsFileLock: vi.fn(() => overrides.lockAcquisition ?? lockAcquisition()),
    releaseWindowsFileLock: vi.fn(),
    inspectWindowsProcessInstance: vi.fn(() => overrides.processInspection ?? { state: 'running' }),
    renameWindowsDirectoryNoReplace: vi.fn(() => Promise.resolve()),
    readWindowsFileStable: () => Promise.resolve(overrides.stableRead ?? stableRead()),
    enumerateWindowsDirectoryStable: () => Promise.resolve(overrides.enumeration ?? enumeration()),
    ...without(overrides, [
      'info', 'inspection', 'creation', 'privateFileCreation', 'lockAcquisition',
      'processInspection', 'stableRead', 'enumeration'
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
    security: Object.hasOwn(overrides, 'security') && overrides.security === undefined
      ? undefined
      : security(record(overrides.security)),
    ancestryReparseFree: true,
    ...without(overrides, ['volume', 'object', 'security'])
  };
}

function creation(): Record<string, unknown> {
  return {
    parentBefore: directoryInspection('state'),
    created: directoryInspection('state\\child', '00000000000000002000000000000002'),
    parentAfter: directoryInspection('state')
  };
}

function privateFileCreation(): Record<string, unknown> {
  return {
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
