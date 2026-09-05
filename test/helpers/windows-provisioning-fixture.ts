import { win32 } from 'node:path';
import type {
  BazframeWin32NativeBackend, BazframeWin32LockBackend, WindowsDirectoryEntryObservation,
  WindowsObjectObservation, WindowsPathInspection, WindowsSecurityObservation
} from '../../src/core/win32-native.js';
import { BazframeError } from '../../src/core/errors.js';
const VOLUME = '0020000000000001';
const USER = 'S-1-5-21-1';
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const FULL = 0x001f01ff;
export type TestNode = {
  kind: 'directory' | 'file' | 'reparse'; id: number; bytes?: Buffer;
  attributes?: number; reparseTag?: number; numberOfLinks?: number;
  security?: WindowsSecurityObservation;
};

/** Lossless virtual native receipts; no host filesystem effects or native claims. */
export function windowsProvisioningFixture() {
  const nodes = new Map<string, TestNode>([['C:\\', dir(1)], ['C:\\boundary', dir(2)]]);
  let nextId = 3;
  const held = new Set<string>();
  const writes: string[] = [];
  const normalize = (path: string) => win32.normalize(path);
  const lookup = (path: string) => {
    const normalized = normalize(path);
    return [...nodes.keys()].find((name) => name.toLowerCase() === normalized.toLowerCase()) ?? normalized;
  };
  function inspect(path: string) {
    const exact = lookup(path);
    return inspection(exact, required(nodes, exact));
  }
  function create(parent: string, component: string, kind: 'directory' | 'file') {
    const parentBefore = inspect(parent);
    const path = win32.join(parent, component);
    if (nodes.has(lookup(path))) throw new BazframeError('WINDOWS_NATIVE_DIRECTORY_OCCUPIED', 'occupied');
    nodes.set(path, kind === 'directory' ? dir(nextId++) : file(nextId++, ''));
    writes.push(path);
    return { parentBefore, created: inspect(path), parentAfter: inspect(parent) };
  }
  const backend: BazframeWin32NativeBackend & BazframeWin32LockBackend = {
    inspectPath: inspect,
    inspectMembershipLink() { throw new Error('membership not configured in provisioning fixture'); },
    createPrivateJunction() { throw new Error('membership not configured in provisioning fixture'); },
    createPrivateDirectory(parent, component) { return create(parent, component, 'directory'); },
    createPrivateFile(parent, component) { return create(parent, component, 'file'); },
    async renameDirectoryNoReplace(parent, source, target) {
      moveTree(nodes, win32.join(parent, source), win32.join(parent, target));
    },
    async readStableFile(path, maxBytes) {
      const value = inspect(path);
      const bytes = Buffer.from(required(nodes, lookup(path)).bytes ?? []);
      if (bytes.byteLength > maxBytes) throw new BazframeError('WINDOWS_NATIVE_READ_LIMIT_EXCEEDED', 'limit');
      return { bytes, byteCount: hex(bytes.byteLength), before: value.object, after: inspect(path).object };
    },
    async enumerateStableDirectory(path, maxEntries) {
      const exact = lookup(path);
      const directoryBefore = inspect(exact);
      const prefix = exact.endsWith('\\') ? exact : `${exact}\\`;
      const entries = [...nodes].filter(([name]) => name.startsWith(prefix)
        && !name.slice(prefix.length).includes('\\')).map(([name, node]) => entry(name.slice(prefix.length), node))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      if (entries.length > maxEntries) throw new BazframeError('WINDOWS_NATIVE_ENUMERATION_LIMIT_EXCEEDED', 'limit');
      return { directoryBefore, entries, directoryAfter: inspect(exact) };
    },
    acquireFileLock(path) {
      const common = { guardBefore: inspect(path), guardAfter: inspect(path),
        currentProcess: { pid: 1234, creationTime: '0000000000000001' } };
      if (held.has(path)) return { ...common, state: 'busy' };
      held.add(path);
      return { ...common, state: 'acquired', capability: {
        assertHeld() { if (!held.has(path)) throw new Error('expired'); },
        release() { held.delete(path); }
      } };
    },
    inspectProcessInstance() { return { state: 'exited' }; }
  };
  const io = {
    async writeExistingFile(path: string, bytes: Uint8Array) {
      required(nodes, lookup(path)).bytes = Buffer.from(bytes);
      writes.push(path);
    },
    async rename(source: string, target: string) { moveTree(nodes, source, target); writes.push(target); }
  };
  return { nodes, backend, io, writes,
    directory(path: string) { nodes.set(path, dir(nextId++)); },
    file(path: string, contents: string) { nodes.set(path, file(nextId++, contents)); },
    reparse(path: string) { nodes.set(path, reparse(nextId++)); },
    snapshot() { return JSON.stringify([...nodes]); }
  };
}

function moveTree(nodes: Map<string, TestNode>, source: string, target: string): void {
  if (!nodes.has(source)) throw Object.assign(new Error('missing'), { code: 'WINDOWS_NATIVE_PATH_NOT_FOUND' });
  if (nodes.has(target)) throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
  const moving = [...nodes.entries()].filter(([path]) => path === source || path.startsWith(`${source}\\`));
  for (const [path] of moving) nodes.delete(path);
  for (const [path, node] of moving) nodes.set(`${target}${path.slice(source.length)}`, node);
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

function privateAcl(): Buffer {
  return acl([ace(USER), ace(SYSTEM), ace(ADMINISTRATORS)]);
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
  if (node === undefined) throw Object.assign(new Error(`missing test node: ${path}`), { code: 'WINDOWS_NATIVE_PATH_NOT_FOUND' });
  return node;
}

function fileId(value: number): string { return value.toString(16).padStart(32, '0'); }
function hex(value: number): string { return value.toString(16).padStart(16, '0'); }
