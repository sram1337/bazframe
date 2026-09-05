import { describe, expect, it, vi } from 'vitest';
import type {
  BazframeWin32LockBackend,
  BazframeWin32NativeBackend,
  WindowsDirectoryEntryObservation,
  WindowsFileLockAcquisition,
  WindowsObjectObservation,
  WindowsPathInspection,
  WindowsPrivateDirectoryCreationReceipt,
  WindowsPrivateFileCreationReceipt,
  WindowsSecurityObservation
} from '../../../src/core/win32-native.js';
import {
  withWindowsOperationLock,
  type WindowsOperationLockAuthority
} from '../../../src/state/win32-operation-lock.js';

const VOLUME = '0020000000000001';
const USER = 'S-1-5-21-1000';
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const FULL = 0x001f01ff;

describe('Windows operation-lock composition', () => {
  it('publishes a proved owner, expires authority, and leaves persistent private files', async () => {
    const fixture = createFixture();
    let authority: WindowsOperationLockAuthority | undefined;
    await expect(withLock(fixture, async (held) => {
      authority = held;
      expect(held.recovery).toBe('none');
      held.assertHeld();
      expect(JSON.parse(fixture.files.get('C:\\locks\\state.lock\\owner')!.toString('utf8')))
        .toMatchObject({ status: 'held', pid: 42 });
      return 'done';
    })).resolves.toBe('done');

    expect(() => authority!.assertHeld()).toThrow(expect.objectContaining({
      code: 'WINDOWS_OPERATION_LOCK_AUTHORITY_INVALID'
    }));
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect([...fixture.files.keys()].sort()).toEqual([
      'C:\\locks\\state.lock\\guard',
      'C:\\locks\\state.lock\\owner'
    ]);
    expect(JSON.parse(fixture.files.get('C:\\locks\\state.lock\\owner')!.toString('utf8')))
      .toMatchObject({ status: 'released' });
  });

  it('reports coherent cross-process contention without mutation authority', async () => {
    const fixture = createFixture();
    await withLock(fixture, async () => undefined);
    fixture.restoreHeldOwner();
    fixture.acquisitionState = 'busy';
    fixture.processState = 'running';
    const operation = vi.fn(async () => undefined);

    await expect(withLock(fixture, operation)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_BUSY'
    });
    expect(operation).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed or inconsistent announcements while busy', async () => {
    const fixture = createFixture();
    await withLock(fixture, async () => undefined);
    fixture.acquisitionState = 'busy';
    fixture.files.set('C:\\locks\\state.lock\\owner', Buffer.from('{bad\n'));
    fixture.touch('C:\\locks\\state.lock\\owner');
    await expect(withLock(fixture, async () => undefined)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS'
    });

    fixture.restoreHeldOwner();
    fixture.processState = 'different';
    await expect(withLock(fixture, async () => undefined)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS'
    });

    fixture.inspectProcessInstance.mockImplementationOnce(() => {
      throw new Error('access denied');
    });
    await expect(withLock(fixture, async () => undefined)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS'
    });
  });

  it.each(['absent', 'exited', 'different'] as const)(
    'recovers a held announcement only after %s process-instance evidence',
    async (processState) => {
      const fixture = createFixture();
      await withLock(fixture, async () => undefined);
      fixture.restoreHeldOwner();
      fixture.processState = processState;
      await expect(withLock(fixture, async (authority) => authority.recovery)).resolves.toBe(
        'dead-owner'
      );
      expect(fixture.inspectProcessInstance).toHaveBeenCalledWith({
        pid: 42,
        creationTime: '0000000000000001'
      });
    }
  );

  it('refuses a live prior owner even after acquiring the kernel guard', async () => {
    const fixture = createFixture();
    await withLock(fixture, async () => undefined);
    fixture.restoreHeldOwner();
    fixture.processState = 'running';
    const operation = vi.fn(async () => undefined);
    await expect(withLock(fixture, operation)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_ANNOUNCEMENT_AMBIGUOUS'
    });
    expect(operation).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledTimes(2);
  });

  it('repairs an interrupted malformed announcement only while holding the guard', async () => {
    const fixture = createFixture();
    await withLock(fixture, async () => undefined);
    fixture.files.set('C:\\locks\\state.lock\\owner', Buffer.from('{torn\n'));
    fixture.touch('C:\\locks\\state.lock\\owner');
    await expect(withLock(fixture, async (authority) => authority.recovery)).resolves.toBe(
      'incomplete-announcement'
    );
    expect(JSON.parse(fixture.files.get('C:\\locks\\state.lock\\owner')!.toString('utf8')))
      .toMatchObject({ status: 'released' });
  });

  it('preserves callback and release rejection even when the rejection value is undefined', async () => {
    const callback = createFixture();
    await expect(withLock(callback, async () => Promise.reject(undefined))).rejects.toBeUndefined();
    expect(callback.release).toHaveBeenCalledTimes(1);

    const release = createFixture();
    await withLock(release, async () => undefined);
    release.rejectReleaseWithUndefined = true;
    await expect(withLock(release, async () => undefined)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_RELEASE_AMBIGUOUS'
    });
    expect(release.release).toHaveBeenCalledTimes(2);
  });

  it('releases the kernel guard after operation failure and after release-record failure', async () => {
    const fixture = createFixture();
    await expect(withLock(fixture, async () => { throw new Error('operation failed'); }))
      .rejects.toThrow(/operation failed/u);
    expect(fixture.release).toHaveBeenCalledTimes(1);

    fixture.failWrite = true;
    let invoked = false;
    await expect(withLock(fixture, async () => { invoked = true; }))
      .rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_RELEASE_AMBIGUOUS' });
    expect(invoked).toBe(true);
    expect(fixture.release).toHaveBeenCalledTimes(2);
  });

  it('rejects same-process reentrancy before a second native acquisition', async () => {
    const fixture = createFixture();
    await withLock(fixture, async () => {
      await expect(withLock(fixture, async () => undefined)).rejects.toMatchObject({
        code: 'WINDOWS_OPERATION_LOCK_REENTRANT'
      });
    });
    expect(fixture.acquireFileLock).toHaveBeenCalledTimes(1);
  });

  it('rejects noncanonical lock aliases before creating lock namespace state', async () => {
    const fixture = createFixture();
    await expect(withWindowsOperationLock({
      ...fixture.options,
      lockComponent: 'State.lock'
    }, async () => undefined)).rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_INVALID' });
    expect(fixture.directories.has('C:\\locks\\state.lock')).toBe(false);
    expect(fixture.acquireFileLock).not.toHaveBeenCalled();
  });

  it('rejects oversized details before creating lock namespace state', async () => {
    const fixture = createFixture();
    await expect(withWindowsOperationLock({
      ...fixture.options,
      details: { command: 'x'.repeat(5000), target: 'state' }
    }, async () => undefined)).rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_INVALID' });
    expect(fixture.directories.has('C:\\locks\\state.lock')).toBe(false);
  });

  it('refuses oversized owners and valid records bound to another lock key', async () => {
    const oversized = createFixture();
    oversized.directories.add('C:\\locks\\state.lock');
    oversized.addFile('C:\\locks\\state.lock\\guard', Buffer.alloc(0));
    oversized.addFile('C:\\locks\\state.lock\\owner', Buffer.alloc(4097));
    const operation = vi.fn(async () => undefined);
    await expect(withLock(oversized, operation)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_INVALID'
    });
    expect(operation).not.toHaveBeenCalled();
    expect(oversized.release).toHaveBeenCalledTimes(1);

    const wrongKey = createFixture();
    await withLock(wrongKey, async () => undefined);
    const stateOwner = Buffer.from(wrongKey.files.get('C:\\locks\\state.lock\\owner')!);
    wrongKey.directories.add('C:\\locks\\other.lock');
    wrongKey.addFile('C:\\locks\\other.lock\\guard', Buffer.alloc(0));
    wrongKey.addFile('C:\\locks\\other.lock\\owner', stateOwner);
    await expect(withWindowsOperationLock({
      ...wrongKey.options,
      lockComponent: 'other.lock'
    }, operation)).rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_INVALID' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('refuses unexpected namespace entries and owner-without-guard state', async () => {
    const unexpected = createFixture();
    unexpected.directories.add('C:\\locks\\state.lock');
    unexpected.addFile('C:\\locks\\state.lock\\foreign', Buffer.alloc(0));
    await expect(withLock(unexpected, async () => undefined)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_INVALID'
    });
    expect(unexpected.acquireFileLock).not.toHaveBeenCalled();

    const orphan = createFixture();
    orphan.directories.add('C:\\locks\\state.lock');
    orphan.addFile('C:\\locks\\state.lock\\owner', Buffer.alloc(0));
    await expect(withLock(orphan, async () => undefined)).rejects.toMatchObject({
      code: 'WINDOWS_OPERATION_LOCK_INVALID'
    });
    expect(orphan.acquireFileLock).not.toHaveBeenCalled();
  });
});

async function withLock<T>(
  fixture: ReturnType<typeof createFixture>,
  operation: (authority: WindowsOperationLockAuthority) => Promise<T>
): Promise<T> {
  return withWindowsOperationLock(fixture.options, operation);
}

function createFixture() {
  const directories = new Set(['C:\\locks']);
  const files = new Map<string, Buffer>();
  const fileIds = new Map<string, string>();
  const versions = new Map<string, number>();
  let nextId = 2n;
  let heldOwner = Buffer.alloc(0);
  let acquisitionState: 'acquired' | 'busy' = 'acquired';
  let processState: 'running' | 'exited' | 'different' | 'absent' = 'running';
  let failWrite = false;
  let rejectReleaseWithUndefined = false;
  const release = vi.fn();

  function id(path: string): string {
    let value = fileIds.get(path);
    if (value === undefined) {
      value = nextId.toString(16).padStart(32, '0');
      nextId += 1n;
      fileIds.set(path, value);
    }
    return value;
  }

  function object(path: string, directory: boolean): WindowsObjectObservation {
    const bytes = files.get(path);
    const size = bytes?.byteLength ?? 0;
    const version = versions.get(path) ?? 1;
    return {
      volumeIdentity: VOLUME,
      fileId: id(path),
      size: size.toString(16).padStart(16, '0'),
      allocationSize: size === 0 ? '0000000000000000' : '0000000000001000',
      numberOfLinks: '00000001',
      creationTime: '0000000000000001',
      lastAccessTime: '0000000000000001',
      lastWriteTime: version.toString(16).padStart(16, '0'),
      changeTime: version.toString(16).padStart(16, '0'),
      attributes: directory ? 16 : 32,
      reparseTag: null,
      deletePending: false,
      directory
    };
  }

  function inspection(path: string): WindowsPathInspection {
    if (directories.has(path) || path === 'C:\\') {
      return pathInspection(path, object(path, true), 'directory');
    }
    if (files.has(path)) return pathInspection(path, object(path, false), 'regular-file');
    throw Object.assign(new Error('missing'), { code: 'WINDOWS_NATIVE_PATH_NOT_FOUND' });
  }

  function directEntries(path: string): WindowsDirectoryEntryObservation[] {
    const prefix = `${path}\\`;
    const result: WindowsDirectoryEntryObservation[] = [];
    for (const child of [...directories, ...files.keys()]) {
      if (!child.startsWith(prefix) || child.slice(prefix.length).includes('\\')) continue;
      const observed = object(child, directories.has(child));
      result.push({
        name: child.slice(prefix.length),
        fileId: observed.fileId,
        size: observed.size,
        allocationSize: observed.allocationSize,
        creationTime: observed.creationTime,
        lastWriteTime: observed.lastWriteTime,
        changeTime: observed.changeTime,
        attributes: observed.attributes,
        reparseTag: observed.reparseTag,
        directory: observed.directory
      });
    }
    return result.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  }

  const acquireFileLock = vi.fn((guardPath: string): WindowsFileLockAcquisition => {
    const guard = inspection(guardPath);
    if (acquisitionState === 'busy') {
      return {
        state: 'busy',
        guardBefore: guard,
        guardAfter: guard,
        currentProcess: { pid: 42, creationTime: '0000000000000001' }
      };
    }
    let held = true;
    return {
      state: 'acquired',
      guardBefore: guard,
      guardAfter: guard,
      currentProcess: { pid: 42, creationTime: '0000000000000001' },
      capability: {
        assertHeld() {
          if (!held) throw new Error('not held');
        },
        release() {
          if (!held) return;
          held = false;
          release();
        }
      }
    };
  });
  const inspectProcessInstance = vi.fn(() => ({ state: processState }));

  const backend: BazframeWin32NativeBackend & BazframeWin32LockBackend = {
    inspectPath: inspection,
    inspectMembershipLink() { throw new Error('unexpected membership inspection'); },
    createPrivateJunction() { throw new Error('unexpected membership mutation'); },
    createPrivateDirectory(parentPath, finalComponent): WindowsPrivateDirectoryCreationReceipt {
      const path = `${parentPath}\\${finalComponent}`;
      if (directories.has(path) || files.has(path)) {
        throw Object.assign(new Error('occupied'), { code: 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED' });
      }
      const parent = inspection(parentPath);
      directories.add(path);
      return { parentBefore: parent, created: inspection(path), parentAfter: parent };
    },
    createPrivateFile(parentPath, finalComponent): WindowsPrivateFileCreationReceipt {
      const path = `${parentPath}\\${finalComponent}`;
      if (directories.has(path) || files.has(path)) {
        throw Object.assign(new Error('occupied'), { code: 'WINDOWS_NATIVE_DIRECTORY_OCCUPIED' });
      }
      const parent = inspection(parentPath);
      files.set(path, Buffer.alloc(0));
      return { parentBefore: parent, created: inspection(path), parentAfter: parent };
    },
    acquireFileLock,
    inspectProcessInstance,
    async renameDirectoryNoReplace() {},
    async readStableFile(path, maxBytes) {
      const bytes = Buffer.from(files.get(path) ?? Buffer.alloc(0));
      if (bytes.byteLength > maxBytes) throw new Error('limit');
      const observed = object(path, false);
      return {
        bytes,
        byteCount: bytes.byteLength.toString(16).padStart(16, '0'),
        before: observed,
        after: observed
      };
    },
    async enumerateStableDirectory(path, maxEntries) {
      const entries = directEntries(path);
      if (entries.length > maxEntries) throw new Error('limit');
      const directory = inspection(path);
      return { directoryBefore: directory, entries, directoryAfter: directory };
    }
  };

  const writes: Buffer[] = [];
  const options = {
    backend,
    lockRootPath: 'C:\\locks',
    lockComponent: 'state.lock',
    details: { command: 'bazframe test', target: 'state' },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    acquisitionId: () => 'a'.repeat(32),
    io: {
      async writeExistingFile(path: string, bytes: Uint8Array) {
        if (writes.length % 2 === 1) {
          if (rejectReleaseWithUndefined) return Promise.reject(undefined);
          if (failWrite) throw new Error('release write failed');
        }
        const value = Buffer.from(bytes);
        writes.push(value);
        if (JSON.parse(value.toString('utf8')).status === 'held') heldOwner = value;
        files.set(path, value);
        versions.set(path, (versions.get(path) ?? 1) + 1);
      }
    }
  };

  return {
    options,
    backend,
    directories,
    files,
    release,
    acquireFileLock,
    inspectProcessInstance,
    writes,
    addFile(path: string, bytes: Buffer) {
      files.set(path, bytes);
      id(path);
    },
    touch(path: string) {
      versions.set(path, (versions.get(path) ?? 1) + 1);
    },
    restoreHeldOwner() {
      files.set('C:\\locks\\state.lock\\owner', Buffer.from(heldOwner));
      versions.set('C:\\locks\\state.lock\\owner', (versions.get('C:\\locks\\state.lock\\owner') ?? 1) + 1);
    },
    get acquisitionState() { return acquisitionState; },
    set acquisitionState(value) { acquisitionState = value; },
    get processState() { return processState; },
    set processState(value) { processState = value; },
    get failWrite() { return failWrite; },
    set failWrite(value) { failWrite = value; },
    get rejectReleaseWithUndefined() { return rejectReleaseWithUndefined; },
    set rejectReleaseWithUndefined(value) { rejectReleaseWithUndefined = value; }
  };
}

function pathInspection(
  path: string,
  object: WindowsObjectObservation,
  kind: 'directory' | 'regular-file'
): WindowsPathInspection {
  return {
    canonicalPath: path,
    kind,
    volume: {
      identity: VOLUME,
      filesystemName: 'NTFS',
      driveType: 'fixed',
      canonicalVolumeGuidPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\',
      remoteDevice: false
    },
    object,
    security: privateSecurity(),
    ancestryReparseFree: true
  };
}

function privateSecurity(): WindowsSecurityObservation {
  return {
    descriptorControl: 0x1004,
    daclPresent: true,
    daclNull: false,
    daclDefaulted: false,
    daclBytes: acl([
      allowAce(USER, 3),
      allowAce(SYSTEM, 3),
      allowAce(ADMINISTRATORS, 3)
    ]),
    ownerSid: USER,
    ownerDefaulted: false,
    groupSid: USER,
    groupDefaulted: false,
    currentUserSid: USER
  };
}

function acl(aces: Buffer[]): Buffer {
  const size = 8 + aces.reduce((sum, ace) => sum + ace.length, 0);
  const result = Buffer.alloc(size);
  result[0] = 2;
  result.writeUInt16LE(size, 2);
  result.writeUInt16LE(aces.length, 4);
  let offset = 8;
  for (const ace of aces) {
    ace.copy(result, offset);
    offset += ace.length;
  }
  return result;
}

function allowAce(sid: string, flags: number): Buffer {
  const sidBytes = binarySid(sid);
  const result = Buffer.alloc(8 + sidBytes.length);
  result[0] = 0;
  result[1] = flags;
  result.writeUInt16LE(result.length, 2);
  result.writeUInt32LE(FULL, 4);
  sidBytes.copy(result, 8);
  return result;
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
  subauthorities.forEach((entry, index) => result.writeUInt32LE(entry, 8 + index * 4));
  return result;
}
