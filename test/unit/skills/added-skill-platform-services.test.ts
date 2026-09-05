import { describe, expect, it, vi } from 'vitest';
import type {
  BazframeWin32LockBackend,
  BazframeWin32NativeBackend,
  WindowsPathInspection
} from '../../../src/core/win32-native.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../../../src/skills/added-skill-platform-services.js';

describe('Windows added-Skill platform services', () => {
  it('proves a physical target and performs one bounded stable UTF-8 read', async () => {
    const inspected = inspection();
    const file = inspection({ directory: false, attributes: 0 });
    file.kind = 'regular-file';
    file.canonicalPath = 'C:\\demo-skill\\SKILL.md';
    const inspectPath = vi.fn((path: string) => path.endsWith('SKILL.md') ? file : inspected);
    const readStableFile = vi.fn(async () => ({
      bytes: Buffer.from('---\nname: demo-skill\n---\n'),
      byteCount: '0000000000000019',
      before: file.object,
      after: file.object
    }));
    const services = createWindowsAddedSkillPlatformServicesForInternalTesting(
      { inspectPath, readStableFile } as unknown as BazframeWin32NativeBackend & BazframeWin32LockBackend
    );

    expect(services.inspectPhysicalDirectory('C:\\demo-skill')).toMatchObject({
      canonicalPath: 'C:\\demo-skill',
      identity: expect.any(String)
    });
    await expect(services.readStableUtf8File('C:\\demo-skill\\SKILL.md', 'Skill definition', 1024))
      .resolves.toBe('---\nname: demo-skill\n---\n');
    expect(readStableFile).toHaveBeenCalledWith('C:\\demo-skill\\SKILL.md', 1024);
  });

  it.each([
    ['final object metadata', (value: WindowsPathInspection) => {
      value.object.lastAccessTime = '0000000000000099';
    }],
    ['final security flags', (value: WindowsPathInspection) => {
      value.security.daclPresent = false;
      value.security.daclNull = true;
    }]
  ])('rejects %s drift after the stable read receipt', async (_label, mutate) => {
    const before = inspection({ directory: false, attributes: 0 });
    before.kind = 'regular-file';
    before.canonicalPath = 'C:\\demo-skill\\SKILL.md';
    const after = cloneInspection(before);
    mutate(after);
    const backend = {
      inspectPath: vi.fn()
        .mockReturnValueOnce(before)
        .mockReturnValueOnce(after),
      readStableFile: vi.fn(async () => ({
        bytes: Buffer.from('---\nname: demo-skill\n---\n'),
        byteCount: '0000000000000019',
        before: before.object,
        after: before.object
      }))
    } as unknown as BazframeWin32NativeBackend & BazframeWin32LockBackend;
    const services = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
    await expect(services.readStableUtf8File(
      'C:\\demo-skill\\SKILL.md',
      'Skill definition',
      1024
    )).rejects.toMatchObject({ code: 'WINDOWS_ADDED_SKILL_NAMESPACE_CHANGED' });
  });

  it('binds same-name direct-entry replacement into the directory closure digest', async () => {
    const home = privateDirectoryInspection('C:\\home', '00000000000000000000000000000002');
    const root = privateDirectoryInspection('C:\\', '00000000000000000000000000000001');
    let entryFileId = '00000000000000000000000000000003';
    const backend = {
      inspectPath: vi.fn((path: string) => cloneInspection(path === 'C:\\' ? root : home)),
      enumerateStableDirectory: vi.fn(async () => ({
        directoryBefore: cloneInspection(home),
        entries: [{
          name: 'demo-skill',
          fileId: entryFileId,
          size: '0000000000000000',
          allocationSize: '0000000000000000',
          creationTime: '0000000000000005',
          lastWriteTime: '0000000000000006',
          changeTime: '0000000000000007',
          attributes: 0x410,
          reparseTag: 0xa0000003,
          directory: true
        }],
        directoryAfter: cloneInspection(home)
      }))
    } as unknown as BazframeWin32NativeBackend & BazframeWin32LockBackend;
    const services = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
    const before = await services.enumeratePrivateDirectory('C:\\home', 10);
    entryFileId = '00000000000000000000000000000004';
    const after = await services.enumeratePrivateDirectory('C:\\home', 10);
    expect(after.names).toEqual(before.names);
    expect(after.identity).not.toBe(before.identity);
    expect(after.entries).toEqual([
      { name: 'demo-skill', directory: true, reparseTag: 0xa0000003 }
    ]);
  });

  it('rejects a reparse-backed target and raised namespace bound', async () => {
    const services = createWindowsAddedSkillPlatformServicesForInternalTesting({
      inspectPath: () => inspection({ reparseTag: 0xa0000003 })
    } as unknown as BazframeWin32NativeBackend & BazframeWin32LockBackend);
    expect(() => services.inspectPhysicalDirectory('C:\\demo-skill'))
      .toThrow(expect.objectContaining({ code: 'WINDOWS_ADDED_SKILL_TARGET_INVALID' }));
    await expect(services.enumeratePrivateDirectory('C:\\home', 1025))
      .rejects.toMatchObject({ code: 'WINDOWS_ADDED_SKILL_ENUMERATION_LIMIT_INVALID' });
  });
});

function cloneInspection(value: WindowsPathInspection): WindowsPathInspection {
  return {
    ...value,
    volume: { ...value.volume },
    object: { ...value.object },
    security: { ...value.security, daclBytes: Buffer.from(value.security.daclBytes) }
  };
}

function inspection(
  objectOverrides: Partial<WindowsPathInspection['object']> = {}
): WindowsPathInspection {
  return {
    kind: 'directory',
    canonicalPath: 'C:\\demo-skill',
    ancestryReparseFree: true,
    volume: {
      identity: '0000000000000001',
      filesystemName: 'NTFS',
      driveType: 'fixed',
      canonicalVolumeGuidPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\',
      remoteDevice: false
    },
    object: {
      volumeIdentity: '0000000000000001',
      fileId: '00000000000000000000000000000002',
      directory: true,
      reparseTag: null,
      numberOfLinks: '00000001',
      size: '0000000000000019',
      allocationSize: '0000000000001000',
      creationTime: '0000000000000001',
      lastAccessTime: '0000000000000002',
      changeTime: '0000000000000003',
      lastWriteTime: '0000000000000004',
      attributes: 0x10,
      deletePending: false,
      ...objectOverrides
    },
    security: {
      ownerSid: 'S-1-5-21-1',
      groupSid: 'S-1-5-21-1',
      currentUserSid: 'S-1-5-21-1',
      descriptorControl: 0x1004,
      daclPresent: true,
      daclNull: false,
      daclDefaulted: false,
      daclBytes: privateAcl(),
      ownerDefaulted: false,
      groupDefaulted: false
    }
  };
}

function privateDirectoryInspection(path: string, fileId: string): WindowsPathInspection {
  const value = inspection({ fileId });
  value.canonicalPath = path === 'C:\\'
    ? '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\'
    : '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\home';
  return value;
}

const USER = 'S-1-5-21-1';
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const FULL = 0x001f01ff;
function privateAcl(): Buffer {
  return acl([ace(USER), ace(SYSTEM), ace(ADMINISTRATORS)]);
}
function acl(aces: Buffer[]): Buffer {
  const size = 8 + aces.reduce((total, entry) => total + entry.byteLength, 0);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt16LE(size, 2);
  header.writeUInt16LE(aces.length, 4);
  return Buffer.concat([header, ...aces]);
}
function ace(sid: string): Buffer {
  const sidBytes = binarySid(sid);
  const result = Buffer.alloc(8 + sidBytes.byteLength);
  result[0] = 0;
  result[1] = 3;
  result.writeUInt16LE(result.byteLength, 2);
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
