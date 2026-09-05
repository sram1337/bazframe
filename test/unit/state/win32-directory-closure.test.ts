import { describe, expect, it } from 'vitest';
import type {
  BazframeWin32NativeBackend,
  WindowsDirectoryEntryObservation,
  WindowsObjectObservation,
  WindowsPathInspection,
  WindowsSecurityObservation,
  WindowsStableReadReceipt
} from '../../../src/core/win32-native.js';
import { BazframeError } from '../../../src/core/errors.js';
import {
  captureWindowsDirectoryClosure,
  WINDOWS_DIRECTORY_CLOSURE_PRODUCTION_POLICY,
  windowsDirectoryClosurePolicy
} from '../../../src/state/win32-directory-closure.js';

const VOLUME = '0020000000000001';
const USER = 'S-1-5-21-1';
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const FULL = 0x001f01ff;

type TestNode = {
  kind: 'directory' | 'file' | 'reparse';
  id: number;
  bytes?: Buffer;
  attributes?: number;
  reparseTag?: number;
  numberOfLinks?: number;
  security?: WindowsSecurityObservation;
};

describe('Windows directory closure composition', () => {
  it('captures deterministic nested files and empty directories with path-free identities', async () => {
    const backend = tree({
      'C:\\state': dir(1),
      'C:\\state\\z-empty': dir(2),
      'C:\\state\\a': dir(3),
      'C:\\state\\a\\note.txt': file(4, 'hello')
    });
    const first = await captureWindowsDirectoryClosure(backend, 'C:\\state');
    const second = await captureWindowsDirectoryClosure(backend, 'C:\\state');
    expect(first).toEqual(second);
    expect(first.rootIdentity).toBe(`${VOLUME}:${fileId(1)}`);
    expect(first.closure.entries).toEqual([
      { path: 'a', kind: 'directory', volumeIdentity: VOLUME, fileId: fileId(3) },
      {
        path: 'a/note.txt', kind: 'file', volumeIdentity: VOLUME, fileId: fileId(4),
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', bytes: 5
      },
      { path: 'z-empty', kind: 'directory', volumeIdentity: VOLUME, fileId: fileId(2) }
    ]);
    expect(first.closureSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses one remaining global entry budget and accepts the exact bound', async () => {
    const backend = tree({
      'C:\\state': dir(1),
      'C:\\state\\a': dir(2),
      'C:\\state\\a\\b': file(3, '')
    });
    const exact = await captureWindowsDirectoryClosure(backend, 'C:\\state', { maxEntries: 2 });
    expect(exact.closure.entries.map((item) => item.path)).toEqual(['a', 'a/b']);
    await expect(captureWindowsDirectoryClosure(backend, 'C:\\state', {
      maxEntries: 1
    })).rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED' });
    expect(backend.enumerationBounds).toContain(0);
  });

  it.each([
    [{ maxEntries: -1 }, 'maxEntries'],
    [{ maxDepth: WINDOWS_DIRECTORY_CLOSURE_PRODUCTION_POLICY.maxDepth + 1 }, 'maxDepth'],
    [{ maxPathBytes: 1.5 }, 'maxPathBytes'],
    [{ maxFileBytes: Number.NaN }, 'maxFileBytes'],
    [{ maxAggregateBytes: -0 }, 'maxAggregateBytes'],
    [{ unknown: 1 } as never, 'unknown']
  ])('rejects invalid lower-only policy %j', (lower, detail) => {
    expect(() => windowsDirectoryClosurePolicy(lower)).toThrow(
      expect.objectContaining({ code: 'WINDOWS_DIRECTORY_CLOSURE_POLICY_INVALID' })
    );
    expect(() => windowsDirectoryClosurePolicy(lower)).toThrow(detail);
  });

  it('enforces depth, path, per-file, and aggregate byte limits before accepting closure', async () => {
    const nested = tree({
      'C:\\state': dir(1),
      'C:\\state\\a': dir(2),
      'C:\\state\\a\\b': file(3, 'abc')
    });
    await expect(captureWindowsDirectoryClosure(nested, 'C:\\state', { maxDepth: 0 }))
      .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED' });
    await expect(captureWindowsDirectoryClosure(nested, 'C:\\state', { maxPathBytes: 2 }))
      .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED' });
    await expect(captureWindowsDirectoryClosure(nested, 'C:\\state', { maxFileBytes: 2 }))
      .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED' });
    await expect(captureWindowsDirectoryClosure(nested, 'C:\\state', { maxAggregateBytes: 2 }))
      .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED' });
  });

  it.each(['CON', 'file:stream', 'trail.', 'trail ', '\ud800'])(
    'rejects invalid Windows component %j',
    async (name) => {
      const backend = tree({ 'C:\\state': dir(1) });
      backend.entryOverride = [entry(name, file(2, 'x'))];
      await expect(captureWindowsDirectoryClosure(backend, 'C:\\state')).rejects.toMatchObject({
        code: 'WINDOWS_DIRECTORY_CLOSURE_INVALID'
      });
    }
  );

  it.each([
    ['case', 'A', 'a'],
    ['normalization', 'é', 'e\u0301']
  ])('rejects %s-equivalent path collisions', async (_label, left, right) => {
    const backend = tree({ 'C:\\state': dir(1) });
    backend.entryOverride = [entry(left, file(2, 'x')), entry(right, file(3, 'y'))];
    await expect(captureWindowsDirectoryClosure(backend, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_INVALID'
    });
  });

  it('rejects a reparse as a leaf without inspecting, reading, or enumerating its target', async () => {
    const backend = tree({
      'C:\\state': dir(1),
      'C:\\state\\link': reparse(2)
    });
    await expect(captureWindowsDirectoryClosure(backend, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_INVALID'
    });
    expect(backend.inspectCalls).not.toContain('C:\\state\\link');
    expect(backend.readCalls).not.toContain('C:\\state\\link');
    expect(backend.enumerateCalls).not.toContain('C:\\state\\link');
  });

  it.each([0x1020, 0x40020, 0x400020])(
    'rejects special, offline, or recall-on-access entry attributes %#x',
    async (attributes) => {
      const backend = tree({ 'C:\\state': dir(1) });
      backend.entryOverride = [entry('offline', { ...file(2, 'x'), attributes })];
      await expect(captureWindowsDirectoryClosure(backend, 'C:\\state')).rejects.toMatchObject({
        code: 'WINDOWS_DIRECTORY_CLOSURE_INVALID'
      });
    }
  );

  it('rejects multiply-linked or non-private files and non-private child directories', async () => {
    const linked = tree({
      'C:\\state': dir(1),
      'C:\\state\\linked': { ...file(2, 'x'), numberOfLinks: 2 }
    });
    await expect(captureWindowsDirectoryClosure(linked, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_INVALID'
    });

    const broadFile = tree({
      'C:\\state': dir(1),
      'C:\\state\\broad': { ...file(2, 'x'), security: foreignSecurity() }
    });
    await expect(captureWindowsDirectoryClosure(broadFile, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_INVALID'
    });

    const broadDirectory = tree({
      'C:\\state': dir(1),
      'C:\\state\\broad': { ...dir(2), security: foreignSecurity() }
    });
    await expect(captureWindowsDirectoryClosure(broadDirectory, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_INVALID'
    });
  });

  it('maps post-enumeration read, replacement, and file-security races to closure drift', async () => {
    const growth = tree({
      'C:\\state': dir(1),
      'C:\\state\\file': file(2, 'x')
    });
    growth.readOverride = async () => {
      throw new BazframeError('WINDOWS_NATIVE_READ_LIMIT_EXCEEDED', 'grew');
    };
    await expect(captureWindowsDirectoryClosure(growth, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
    });

    const replacement = tree({
      'C:\\state': dir(1),
      'C:\\state\\file': file(2, 'x')
    });
    replacement.readOverride = async (path, maximum) => {
      const receipt = await replacement.baseRead(path, maximum);
      replacement.nodes.set(path, reparse(9));
      return receipt;
    };
    await expect(captureWindowsDirectoryClosure(replacement, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
    });

    const securityDrift = tree({
      'C:\\state': dir(1),
      'C:\\state\\file': file(2, 'x')
    });
    securityDrift.readOverride = async (path, maximum) => {
      const receipt = await securityDrift.baseRead(path, maximum);
      securityDrift.nodes.get(path)!.security = foreignSecurity();
      return receipt;
    };
    await expect(captureWindowsDirectoryClosure(securityDrift, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
    });
  });

  it('binds listed identities to child inspection and stable reads', async () => {
    const backend = tree({
      'C:\\state': dir(1),
      'C:\\state\\file': file(2, 'x')
    });
    backend.entryOverride = [entry('file', file(9, 'x'))];
    await expect(captureWindowsDirectoryClosure(backend, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
    });

    const readDrift = tree({
      'C:\\state': dir(1),
      'C:\\state\\file': file(2, 'x')
    });
    readDrift.readOverride = async (path, maximum) => {
      const receipt = await readDrift.baseRead(path, maximum);
      return { ...receipt, before: { ...receipt.before, fileId: fileId(9) } };
    };
    await expect(captureWindowsDirectoryClosure(readDrift, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
    });
  });

  it('detects directory closure drift after children and between complete passes', async () => {
    const afterChild = tree({
      'C:\\state': dir(1),
      'C:\\state\\file': file(2, 'x')
    });
    afterChild.onEnumerate = (path, count) => {
      if (path === 'C:\\state' && count === 2) afterChild.nodes.set('C:\\state\\later', file(3, 'y'));
    };
    await expect(captureWindowsDirectoryClosure(afterChild, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
    });

    const between = tree({
      'C:\\state': dir(1),
      'C:\\state\\file': file(2, 'x')
    });
    await expect(captureWindowsDirectoryClosure(between, 'C:\\state', {}, {
      beforeSecondPass: () => { between.nodes.get('C:\\state\\file')!.bytes = Buffer.from('y'); }
    })).rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED' });
  });

  it('performs final private-root revalidation', async () => {
    const backend = tree({ 'C:\\state': dir(1) });
    backend.inspectOverride = (path, base) => path === 'C:\\state' && backend.enumerateCount >= 4
      ? inspection(path, { ...backend.nodes.get(path)!, id: 9 })
      : base;
    await expect(captureWindowsDirectoryClosure(backend, 'C:\\state')).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
    });
  });
});

function tree(initial: Record<string, TestNode>) {
  const nodes = new Map(Object.entries({ 'C:\\': dir(100), ...initial }));
  const inspectCalls: string[] = [];
  const readCalls: string[] = [];
  const enumerateCalls: string[] = [];
  const enumerationBounds: number[] = [];
  let enumerateCount = 0;
  const backend: BazframeWin32NativeBackend & {
    nodes: Map<string, TestNode>;
    inspectCalls: string[];
    readCalls: string[];
    enumerateCalls: string[];
    enumerationBounds: number[];
    enumerateCount: number;
    entryOverride?: WindowsDirectoryEntryObservation[];
    onEnumerate?: (path: string, count: number) => void;
    inspectOverride?: (path: string, base: WindowsPathInspection) => WindowsPathInspection;
    readOverride?: (path: string, maximum: number) => Promise<WindowsStableReadReceipt>;
    baseRead: (path: string, maximum: number) => Promise<WindowsStableReadReceipt>;
  } = {
    nodes,
    inspectCalls,
    readCalls,
    enumerateCalls,
    enumerationBounds,
    enumerateCount,
    inspectPath(path) {
      inspectCalls.push(path);
      const node = required(nodes, path);
      if (node.kind === 'reparse') throw new Error('reparse must not be inspected');
      const base = inspection(path, node);
      return backend.inspectOverride?.(path, base) ?? base;
    },
    inspectMembershipLink() { throw new Error('unexpected membership inspection'); },
    createPrivateJunction() { throw new Error('unexpected membership mutation'); },
    createPrivateDirectory() { throw new Error('unexpected mutation'); },
    createPrivateFile() { throw new Error('unexpected mutation'); },
    async renameDirectoryNoReplace() { throw new Error('unexpected mutation'); },
    async readStableFile(path, maximum) {
      readCalls.push(path);
      return backend.readOverride?.(path, maximum) ?? backend.baseRead(path, maximum);
    },
    async baseRead(path, maximum) {
      const node = required(nodes, path);
      if (node.kind !== 'file' || node.bytes === undefined || node.bytes.byteLength > maximum) {
        throw new BazframeError('WINDOWS_NATIVE_READ_LIMIT_EXCEEDED', 'refused');
      }
      const object = objectObservation(node);
      return {
        bytes: Buffer.from(node.bytes),
        byteCount: hex(node.bytes.byteLength),
        before: object,
        after: { ...object }
      };
    },
    async enumerateStableDirectory(path, maximum) {
      enumerateCalls.push(path);
      enumerationBounds.push(maximum);
      enumerateCount += 1;
      backend.enumerateCount = enumerateCount;
      backend.onEnumerate?.(path, enumerateCount);
      const parent = required(nodes, path);
      if (parent.kind !== 'directory') throw new Error('not directory');
      const prefix = path.endsWith('\\') ? path : `${path}\\`;
      const direct = backend.entryOverride ?? [...nodes.entries()]
        .filter(([candidate]) => candidate.startsWith(prefix)
          && !candidate.slice(prefix.length).includes('\\'))
        .map(([candidate, node]) => entry(candidate.slice(prefix.length), node));
      const entries = [...direct].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      if (entries.length > maximum) {
        throw new BazframeError('WINDOWS_NATIVE_ENUMERATION_LIMIT_EXCEEDED', 'refused');
      }
      const before = inspection(path, parent);
      return { directoryBefore: before, entries, directoryAfter: inspection(path, parent) };
    }
  };
  return backend;
}

function dir(id: number): TestNode { return { kind: 'directory', id, attributes: 0x10 }; }
function file(id: number, value: string): TestNode {
  return { kind: 'file', id, bytes: Buffer.from(value), attributes: 0x20 };
}
function reparse(id: number): TestNode {
  return { kind: 'reparse', id, attributes: 0x410, reparseTag: 0xa0000003 };
}

function entry(name: string, node: TestNode): WindowsDirectoryEntryObservation {
  const object = objectObservation(node);
  return {
    name,
    fileId: object.fileId,
    size: object.size,
    allocationSize: object.allocationSize,
    creationTime: object.creationTime,
    lastWriteTime: object.lastWriteTime,
    changeTime: object.changeTime,
    attributes: object.attributes,
    reparseTag: node.reparseTag ?? null,
    directory: node.kind !== 'file'
  };
}

function inspection(path: string, node: TestNode): WindowsPathInspection {
  const object = objectObservation(node);
  return {
    canonicalPath: canonical(path),
    kind: node.kind === 'directory' ? 'directory' : 'regular-file',
    volume: {
      identity: VOLUME,
      filesystemName: 'NTFS',
      driveType: 'fixed',
      canonicalVolumeGuidPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\',
      remoteDevice: false
    },
    object,
    security: node.security ?? security(),
    ancestryReparseFree: true
  };
}

function objectObservation(node: TestNode): WindowsObjectObservation {
  const size = node.bytes?.byteLength ?? 0;
  return {
    volumeIdentity: VOLUME,
    fileId: fileId(node.id),
    size: hex(size),
    allocationSize: hex(size),
    numberOfLinks: (node.numberOfLinks ?? 1).toString(16).padStart(8, '0'),
    creationTime: '0000000000000001',
    lastAccessTime: '0000000000000001',
    lastWriteTime: '0000000000000001',
    changeTime: '0000000000000001',
    attributes: node.attributes ?? (node.kind === 'file' ? 0x20 : 0x10),
    reparseTag: node.reparseTag ?? null,
    deletePending: false,
    directory: node.kind !== 'file'
  };
}

function canonical(path: string): string {
  const root = '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\';
  const suffix = path.slice(3);
  return suffix === '' ? root : `${root}${suffix}`;
}

function security(): WindowsSecurityObservation {
  return {
    descriptorControl: 0x1004,
    daclPresent: true,
    daclNull: false,
    daclDefaulted: false,
    daclBytes: privateAcl(),
    ownerSid: USER,
    ownerDefaulted: false,
    groupSid: USER,
    groupDefaulted: false,
    currentUserSid: USER
  };
}

function foreignSecurity(): WindowsSecurityObservation {
  return { ...security(), daclBytes: acl([ace('S-1-1-0')]) };
}

function privateAcl(): Buffer {
  return acl([
    ace(USER),
    ace(SYSTEM),
    ace(ADMINISTRATORS)
  ]);
}

function acl(aces: Buffer[]): Buffer {
  const size = 8 + aces.reduce((total, value) => total + value.byteLength, 0);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt16LE(size, 2);
  header.writeUInt16LE(aces.length, 4);
  return Buffer.concat([header, ...aces]);
}

function ace(sid: string): Buffer {
  const sidBytes = binarySid(sid);
  const value = Buffer.alloc(8 + sidBytes.byteLength);
  value[0] = 0;
  value[1] = 3;
  value.writeUInt16LE(value.byteLength, 2);
  value.writeUInt32LE(FULL, 4);
  sidBytes.copy(value, 8);
  return value;
}

function binarySid(value: string): Buffer {
  const parts = value.split('-');
  const authority = BigInt(parts[2]!);
  const subauthorities = parts.slice(3).map(Number);
  const result = Buffer.alloc(8 + subauthorities.length * 4);
  result[0] = 1;
  result[1] = subauthorities.length;
  let remaining = authority;
  for (let index = 7; index >= 2; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  subauthorities.forEach((part, index) => result.writeUInt32LE(part, 8 + index * 4));
  return result;
}

function required(nodes: Map<string, TestNode>, path: string): TestNode {
  const node = nodes.get(path);
  if (node === undefined) throw new Error(`missing test node: ${path}`);
  return node;
}

function fileId(value: number): string { return value.toString(16).padStart(32, '0'); }
function hex(value: number): string { return value.toString(16).padStart(16, '0'); }
