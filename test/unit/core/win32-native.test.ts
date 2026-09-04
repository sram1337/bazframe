import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../src/cli/run-cli.js';
import {
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
    ['missing export', { inspectWindowsPath: undefined }, 'WINDOWS_NATIVE_EXPORT_MISSING'],
    ['contract', { info: { contractVersion: 2 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH'],
    ['version', { info: { packageVersion: '0.1.0-other' } }, 'WINDOWS_NATIVE_VERSION_MISMATCH'],
    ['target', { info: { target: 'win32-arm64-msvc' } }, 'WINDOWS_NATIVE_TARGET_MISMATCH'],
    ['limit', { info: { maxStableReadBytes: 1 } }, 'WINDOWS_NATIVE_CONTRACT_MISMATCH']
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
    ['malformed volume GUID', { volume: { canonicalVolumeGuidPath: '\\\\?\\Volume{123456781234-1234-1234-123456789abc}\\' } }]
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
    contractVersion: 1,
    packageVersion: VERSION,
    target: 'win32-x64-msvc',
    maxStableReadBytes: BAZFRAME_WIN32_NATIVE_MAX_STABLE_READ_BYTES,
    ...record(overrides.info)
  };
  return {
    getNativeWindowsInfo: () => info,
    inspectWindowsPath: () => overrides.inspection ?? inspection(),
    readWindowsFileStable: () => Promise.resolve(overrides.stableRead ?? stableRead()),
    ...without(overrides, ['info', 'inspection', 'stableRead'])
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

function stableRead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bytes: Buffer.from('abc'),
    byteCount: '0000000000000003',
    before: observation(record(overrides.before)),
    after: observation(record(overrides.after)),
    ...without(overrides, ['before', 'after'])
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
