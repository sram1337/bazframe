import { describe, expect, it, vi } from 'vitest';
import type {
  BazframeWin32NativeBackend,
  WindowsPathInspection,
  WindowsPrivateDirectoryCreationReceipt,
  WindowsPrivateFileCreationReceipt,
  WindowsSecurityObservation
} from '../../../src/core/win32-native.js';
import {
  admitWindowsPrivateDirectory,
  admitWindowsPrivateFile,
  createWindowsPrivateDirectory,
  createWindowsPrivateFile
} from '../../../src/state/win32-private-directory.js';
import { BazframeError } from '../../../src/core/errors.js';

const USER = 'S-1-5-21-1000';
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const FOREIGN = 'S-1-5-11';
const FULL = 0x001f01ff;
const FILE_DELETE_CHILD = 0x00000040;
const FILE_GENERIC_READ = 0x00120089;
const VOLUME = '0020000000000001';

describe('Windows private-directory composition', () => {
  it('admits and revalidates a protected owner-private directory', () => {
    const inspectPath = vi.fn(() => directory('C:\\state'));
    const backend = fakeBackend(inspectPath);
    expect(admitWindowsPrivateDirectory(backend, 'C:\\state').canonicalPath).toContain('state');
    expect(inspectPath).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['absent DACL', { daclPresent: false, descriptorControl: 0, daclBytes: Buffer.alloc(0) }],
    ['null DACL', { daclNull: true, daclBytes: Buffer.alloc(0) }],
    ['wrong owner', { ownerSid: SYSTEM }],
    ['malformed ACL header', { daclBytes: Buffer.from([2, 0, 9, 0, 0, 0, 0, 0]) }],
    ['unknown ACE', { daclBytes: acl([ace(17, USER)]) }],
    ['foreign allow', { daclBytes: privateAcl([ace(0, 'S-1-5-11')]) }],
    ['insufficient access', { daclBytes: privateAcl([], FULL & ~1, USER) }],
    ['non-propagating access', { daclBytes: privateAcl([], FULL, USER, 7) }],
    ['deny access', { daclBytes: privateAcl([ace(1, USER)]) }]
  ])('fails closed for %s', (_label, securityOverrides) => {
    const backend = fakeBackend(() => directory('C:\\state', { security: security(securityOverrides) }));
    expect(() => admitWindowsPrivateDirectory(backend, 'C:\\state')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED' })
    );
  });

  it('admits only owner-private, single-link files and revalidates their security', () => {
    const accepted = fakeBackend((path) => path.endsWith('file.txt')
      ? regularFile(path)
      : directory(path));
    expect(admitWindowsPrivateFile(accepted, 'C:\\state\\file.txt').kind).toBe('regular-file');

    const linked = fakeBackend((path) => path.endsWith('file.txt')
      ? regularFile(path, { numberOfLinks: '00000002' })
      : directory(path));
    expect(() => admitWindowsPrivateFile(linked, 'C:\\state\\file.txt')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_FILE_PRIVACY_UNPROVED' })
    );

    const broad = fakeBackend((path) => path.endsWith('file.txt')
      ? regularFile(path, { security: security({ daclBytes: privateAcl([ace(0, FOREIGN)]) }) })
      : directory(path));
    expect(() => admitWindowsPrivateFile(broad, 'C:\\state\\file.txt')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_FILE_PRIVACY_UNPROVED' })
    );

    let fileInspections = 0;
    const drift = fakeBackend((path) => {
      if (!path.endsWith('file.txt')) return directory(path);
      fileInspections += 1;
      return regularFile(path, fileInspections === 1 ? {} : {
        security: security({ daclBytes: privateAcl([ace(0, FOREIGN)]) })
      });
    });
    expect(() => admitWindowsPrivateFile(drift, 'C:\\state\\file.txt')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_FILE_PRIVACY_UNPROVED' })
    );
  });

  it('creates an empty protected owner-private file without replacement and revalidates it', () => {
    const parent = directory('C:\\state');
    const child = regularFile('C:\\state\\record.json');
    const create = vi.fn(() => fileCreation(parent, child));
    const backend = fakeBackend(
      (path) => path.endsWith('record.json') ? child : directory(path),
      undefined,
      create
    );
    expect(createWindowsPrivateFile(backend, 'C:\\state', 'record.json')).toEqual(child);
    expect(create).toHaveBeenCalledWith('C:\\state', 'record.json');

    const occupied = fakeBackend(
      (path) => path.endsWith('record.json') ? child : directory(path),
      undefined,
      () => { throw new BazframeError('WINDOWS_NATIVE_DIRECTORY_OCCUPIED', 'occupied'); }
    );
    expect(() => createWindowsPrivateFile(occupied, 'C:\\state', 'record.json')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_FILE_OCCUPIED' })
    );

    const invalidCreate = vi.fn(() => fileCreation(parent, child));
    expect(() => createWindowsPrivateFile(
      fakeBackend(() => parent, undefined, invalidCreate),
      'C:\\state',
      'invalid:name'
    )).toThrow(expect.objectContaining({ code: 'WINDOWS_PRIVATE_FILE_NAME_INVALID' }));
    expect(invalidCreate).not.toHaveBeenCalled();

    const broadChild = regularFile('C:\\state\\record.json', {
      security: security({ daclBytes: privateAcl([ace(0, FOREIGN)]) })
    });
    const ambiguous = fakeBackend(
      (path) => path.endsWith('record.json') ? broadChild : directory(path),
      undefined,
      () => fileCreation(parent, broadChild)
    );
    expect(() => createWindowsPrivateFile(ambiguous, 'C:\\state', 'record.json')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_FILE_CREATE_AMBIGUOUS' })
    );
  });

  it('accepts an unprotected private chain only when it reaches and revalidates a protected anchor', () => {
    const paths: string[] = [];
    const backend = fakeBackend((path) => {
      paths.push(path);
      return directory(path, { security: security({ descriptorControl: path === 'C:\\' ? 0x1004 : 4 }) });
    });
    expect(admitWindowsPrivateDirectory(backend, 'C:\\state\\child').kind).toBe('directory');
    expect(paths).toEqual([
      'C:\\state\\child', 'C:\\state', 'C:\\',
      'C:\\', 'C:\\state', 'C:\\state\\child'
    ]);
  });

  it('refuses an unprotected chain with no protected anchor', () => {
    const backend = fakeBackend((path) => directory(path, { security: security({ descriptorControl: 4 }) }));
    expect(() => admitWindowsPrivateDirectory(backend, 'C:\\state')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED' })
    );
  });

  it('refuses a protected child when an outer parent grants foreign delete-child access', () => {
    const backend = fakeBackend((path) => directory(path, {
      security: path === 'C:\\outer'
        ? security({ daclBytes: privateAcl([ace(0, FOREIGN, FILE_DELETE_CHILD, 0)]) })
        : security()
    }));
    expect(() => admitWindowsPrivateDirectory(backend, 'C:\\outer\\state')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED' })
    );
  });

  it('accepts the Windows servicing principal as an administrative namespace owner', () => {
    const backend = fakeBackend((path) => directory(path, {
      security: path === 'C:\\' ? security({ ownerSid: TRUSTED_INSTALLER }) : security()
    }));
    expect(admitWindowsPrivateDirectory(backend, 'C:\\state').kind).toBe('directory');
  });

  it('accepts harmless foreign read and traverse access on an outer namespace ancestor', () => {
    const backend = fakeBackend((path) => directory(path, {
      security: path === 'C:\\outer'
        ? security({ daclBytes: privateAcl([ace(0, FOREIGN, FILE_GENERIC_READ, 0)]) })
        : security()
    }));
    expect(admitWindowsPrivateDirectory(backend, 'C:\\outer\\state').kind).toBe('directory');
  });

  it('refuses outer namespace security drift during outer-to-inner revalidation', () => {
    let outerInspections = 0;
    const backend = fakeBackend((path) => {
      if (path !== 'C:\\outer') return directory(path);
      outerInspections += 1;
      return directory(path, {
        security: security({
          daclBytes: privateAcl(outerInspections === 1
            ? [ace(0, FOREIGN, FILE_GENERIC_READ, 0)]
            : [ace(0, FOREIGN, FILE_DELETE_CHILD, 0)])
        })
      });
    });
    expect(() => admitWindowsPrivateDirectory(backend, 'C:\\outer\\state')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED' })
    );
  });

  it.each(['', '.', '..', 'child\\other', 'child/other', 'stream:name', 'NUL', 'con.txt', 'name.', 'name ', '\u0001bad', '\ud800']) (
    'rejects invalid or reserved component %j before inspection or creation',
    (component) => {
      const inspectPath = vi.fn(() => directory('C:\\state'));
      const createPrivateDirectory = vi.fn();
      const backend = fakeBackend(inspectPath, createPrivateDirectory);
      expect(() => createWindowsPrivateDirectory(backend, 'C:\\state', component)).toThrow(
        expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_NAME_INVALID' })
      );
      expect(inspectPath).not.toHaveBeenCalled();
      expect(createPrivateDirectory).not.toHaveBeenCalled();
    }
  );

  it('refuses an unproved parent before invoking the mutating backend', () => {
    const create = vi.fn();
    const backend = fakeBackend(
      () => directory('C:\\state', { security: security({ ownerSid: SYSTEM }) }),
      create
    );
    expect(() => createWindowsPrivateDirectory(backend, 'C:\\state', 'child')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED' })
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses unsafe namespace ancestry before invoking the mutating backend', () => {
    const create = vi.fn();
    const backend = fakeBackend((path) => directory(path, {
      security: path === 'C:\\outer'
        ? security({ daclBytes: privateAcl([ace(0, FOREIGN, FILE_DELETE_CHILD, 0)]) })
        : security()
    }), create);
    expect(() => createWindowsPrivateDirectory(backend, 'C:\\outer\\state', 'child')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED' })
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('maps occupied no-replace creation distinctly and invokes the backend once', () => {
    const create = vi.fn(() => { throw new BazframeError('WINDOWS_NATIVE_DIRECTORY_OCCUPIED', 'occupied'); });
    const backend = fakeBackend(() => directory('C:\\state'), create);
    expect(() => createWindowsPrivateDirectory(backend, 'C:\\state', 'child')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_OCCUPIED' })
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('creates once after admission, then revalidates parent, child, and security', () => {
    const calls: string[] = [];
    const parent = directory('C:\\state');
    const child = directory('C:\\state\\child', { fileId: '00000000000000002000000000000002' });
    const create = vi.fn(() => { calls.push('create'); return creation(parent, child); });
    const backend = fakeBackend((path) => {
      calls.push(`inspect:${path}`);
      return path.toLowerCase().endsWith('\\child') ? child : parent;
    }, create);
    expect(createWindowsPrivateDirectory(backend, 'C:\\state', 'child').object.fileId).toBe(child.object.fileId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'inspect:C:\\state', 'inspect:C:\\',
      'inspect:C:\\', 'inspect:C:\\state',
      'create',
      'inspect:C:\\', 'inspect:C:\\state', 'inspect:C:\\state\\child'
    ]);
  });

  it('allows parent timestamps to change while preserving identity and security', () => {
    let inspectionCount = 0;
    const child = directory('C:\\state\\child', { fileId: '00000000000000002000000000000002' });
    const backend = fakeBackend((path) => {
      if (path.endsWith('child')) return child;
      inspectionCount += 1;
      return directory('C:\\state', { changeTime: hex(inspectionCount) });
    }, () => creation(
      directory('C:\\state', { changeTime: hex(2) }),
      child,
      directory('C:\\state', { changeTime: hex(3) })
    ));
    expect(() => createWindowsPrivateDirectory(backend, 'C:\\state', 'child')).not.toThrow();
  });

  it.each([
    ['malformed mutation receipt', (receipt: WindowsPrivateDirectoryCreationReceipt) => ({ ...receipt, created: directory('C:\\state\\other') })],
    ['parent identity drift', (receipt: WindowsPrivateDirectoryCreationReceipt) => ({ ...receipt, parentAfter: directory('C:\\state', { fileId: '00000000000000002000000000000009' }) })],
    ['created security drift', (receipt: WindowsPrivateDirectoryCreationReceipt) => ({ ...receipt, created: directory('C:\\state\\child', { fileId: '00000000000000002000000000000002', security: security({ ownerSid: SYSTEM }) }) })]
  ])('maps post-success %s to retained ambiguity', (_label, mutate) => {
    const parent = directory('C:\\state');
    const child = directory('C:\\state\\child', { fileId: '00000000000000002000000000000002' });
    const backend = fakeBackend(
      (path) => path.endsWith('child') ? child : parent,
      () => mutate(creation(parent, child)) as WindowsPrivateDirectoryCreationReceipt
    );
    expect(() => createWindowsPrivateDirectory(backend, 'C:\\state', 'child')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_CREATE_AMBIGUOUS' })
    );
  });

  it('maps parent or child reinspection drift after success to retained ambiguity', () => {
    let parentCalls = 0;
    const parent = directory('C:\\state');
    const child = directory('C:\\state\\child', { fileId: '00000000000000002000000000000002' });
    const backend = fakeBackend((path) => {
      if (path.endsWith('child')) return child;
      if (path === 'C:\\') return directory(path);
      parentCalls += 1;
      return parentCalls < 3 ? parent : directory('C:\\state', { security: security({ daclDefaulted: true, descriptorControl: 0x100c }) });
    }, () => creation(parent, child));
    expect(() => createWindowsPrivateDirectory(backend, 'C:\\state', 'child')).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_CREATE_AMBIGUOUS' })
    );
  });
});

function fakeBackend(
  inspectPath: (path: string) => WindowsPathInspection,
  createPrivateDirectory: (parentPath: string, component: string) => WindowsPrivateDirectoryCreationReceipt = () => {
    throw new Error('unexpected create');
  },
  createPrivateFile: (parentPath: string, component: string) => WindowsPrivateFileCreationReceipt = () => {
    throw new Error('unexpected create');
  }
): BazframeWin32NativeBackend {
  return {
    inspectPath(path) {
      const inspection = inspectPath(path);
      if (path === 'C:\\' && inspection.canonicalPath.toLowerCase() !== canonicalPath(path).toLowerCase()) {
        return directory(path);
      }
      return inspection;
    },
    inspectMembershipLink() { throw new Error('unexpected membership inspection'); },
    createPrivateJunction() { throw new Error('unexpected membership mutation'); },
    createPrivateDirectory,
    createPrivateFile,
    renameDirectoryNoReplace: async () => { throw new Error('unexpected rename'); },
    readStableFile: async () => { throw new Error('unexpected read'); },
    enumerateStableDirectory: async () => { throw new Error('unexpected enumeration'); }
  };
}

function creation(
  parentBefore: WindowsPathInspection,
  created: WindowsPathInspection,
  parentAfter = parentBefore
): WindowsPrivateDirectoryCreationReceipt {
  return { parentBefore, created, parentAfter };
}

function fileCreation(
  parentBefore: WindowsPathInspection,
  created: WindowsPathInspection,
  parentAfter = parentBefore
): WindowsPrivateFileCreationReceipt {
  return { parentBefore, created, parentAfter };
}

function directory(
  path: string,
  overrides: {
    fileId?: string;
    changeTime?: string;
    security?: WindowsSecurityObservation;
  } = {}
): WindowsPathInspection {
  const canonicalRoot = '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\';
  return {
    canonicalPath: canonicalPath(path),
    kind: 'directory',
    volume: {
      identity: VOLUME,
      filesystemName: 'NTFS',
      driveType: 'fixed',
      canonicalVolumeGuidPath: canonicalRoot,
      remoteDevice: false
    },
    object: {
      volumeIdentity: VOLUME,
      fileId: overrides.fileId ?? '00000000000000002000000000000001',
      size: '0000000000000000',
      allocationSize: '0000000000000000',
      numberOfLinks: '00000001',
      creationTime: '0000000000000001',
      lastAccessTime: '0000000000000001',
      lastWriteTime: '0000000000000001',
      changeTime: overrides.changeTime ?? '0000000000000001',
      attributes: 16,
      reparseTag: null,
      deletePending: false,
      directory: true
    },
    security: overrides.security ?? security(),
    ancestryReparseFree: true
  };
}

function regularFile(
  path: string,
  overrides: { numberOfLinks?: string; security?: WindowsSecurityObservation } = {}
): WindowsPathInspection {
  const result = directory(path, { security: overrides.security });
  return {
    ...result,
    kind: 'regular-file',
    object: {
      ...result.object,
      numberOfLinks: overrides.numberOfLinks ?? '00000001',
      attributes: 32,
      directory: false
    }
  };
}

function canonicalPath(path: string): string {
  const canonicalRoot = '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\';
  const suffix = path.slice(3).replaceAll('/', '\\');
  return suffix.length === 0 ? canonicalRoot : `${canonicalRoot}${suffix}`;
}

function security(overrides: Partial<WindowsSecurityObservation> = {}): WindowsSecurityObservation {
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
    currentUserSid: USER,
    ...overrides
  };
}

function privateAcl(
  additions: Buffer[] = [],
  userMask = FULL,
  userSid = USER,
  userFlags = 3
): Buffer {
  return acl([
    ace(0, userSid, userMask, userFlags),
    ace(0, SYSTEM, FULL, userFlags),
    ace(0, ADMINISTRATORS, FULL, userFlags),
    ...additions
  ]);
}

function acl(aces: Buffer[]): Buffer {
  const size = 8 + aces.reduce((total, entry) => total + entry.byteLength, 0);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt16LE(size, 2);
  header.writeUInt16LE(aces.length, 4);
  return Buffer.concat([header, ...aces]);
}

function ace(type: number, sid: string, mask = FULL, flags = 3): Buffer {
  const sidBytes = binarySid(sid);
  const result = Buffer.alloc(8 + sidBytes.byteLength);
  result[0] = type;
  result[1] = flags;
  result.writeUInt16LE(result.byteLength, 2);
  result.writeUInt32LE(mask, 4);
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

function hex(value: number): string {
  return value.toString(16).padStart(16, '0');
}
