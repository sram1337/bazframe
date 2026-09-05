import { describe, expect, it, vi } from 'vitest';
import type {
  BazframeWin32NativeBackend,
  WindowsMembershipLinkInspection,
  WindowsPathInspection,
  WindowsSecurityObservation
} from '../../../src/core/win32-native.js';
import { BazframeError } from '../../../src/core/errors.js';
import {
  createWindowsSkillMembership,
  inspectWindowsSkillMembership,
  removeWindowsSkillMembership,
  type WindowsSkillMembershipIo
} from '../../../src/state/win32-skill-membership.js';

const USER = 'S-1-5-21-1000';
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const FULL = 0x001f01ff;
const VOLUME = '0020000000000001';
const PARENT = 'C:\\state\\skills';
const TARGET = 'C:\\provider\\demo-skill';
const MEMBER = `${PARENT}\\demo-skill`;

describe('Windows Skill membership composition', () => {
  it('creates only a junction to the requested target, proves it, and unlinks only the membership', async () => {
    const fixture = setup();
    await expect(createWindowsSkillMembership(fixture.options)).resolves.toMatchObject({
      action: 'added',
      proof: { membershipPath: MEMBER, target: { canonicalPath: canonical(TARGET) } }
    });
    expect(fixture.io.symlink).toHaveBeenCalledWith(TARGET, MEMBER, 'junction');
    expect(inspectWindowsSkillMembership(fixture.options).link.normalizedTarget).toBe(canonical(TARGET));

    await expect(removeWindowsSkillMembership(fixture.options)).resolves.toEqual({
      outcome: 'absent', effect: 'removed'
    });
    expect(fixture.io.unlink).toHaveBeenCalledWith(MEMBER);
    expect(fixture.inspectPath(TARGET).object.fileId).toBe(id(TARGET));
  });

  it('treats an existing exact junction with an inherited private ACL as current', async () => {
    const fixture = setup({ present: true });
    const inspectLink = fixture.backend.inspectMembershipLink;
    fixture.backend.inspectMembershipLink = (path) => {
      const result = inspectLink(path);
      result.security = security({ inherited: true });
      return result;
    };
    await expect(createWindowsSkillMembership(fixture.options)).resolves.toMatchObject({ action: 'current' });
    expect(fixture.io.symlink).not.toHaveBeenCalled();
  });

  it('refuses a foreign or parent-user-mismatched link ACL', () => {
    for (const change of [
      (value: WindowsSecurityObservation) => { value.daclBytes = acl(3, true); },
      (value: WindowsSecurityObservation) => {
        const otherUser = 'S-1-5-21-2000';
        value.ownerSid = otherUser;
        value.groupSid = otherUser;
        value.currentUserSid = otherUser;
        value.daclBytes = acl(3, false, otherUser);
      }
    ]) {
      const fixture = setup({ present: true });
      const inspectLink = fixture.backend.inspectMembershipLink;
      fixture.backend.inspectMembershipLink = (path) => {
        const result = inspectLink(path);
        change(result.security);
        return result;
      };
      expect(() => inspectWindowsSkillMembership(fixture.options)).toThrow(
        expect.objectContaining({ code: 'WINDOWS_SKILL_MEMBERSHIP_LINK_SECURITY_INVALID' })
      );
    }
  });

  it('is absent-idempotent without invoking unlink', async () => {
    const fixture = setup();
    await expect(removeWindowsSkillMembership(fixture.options)).resolves.toEqual({
      outcome: 'absent', effect: 'already-absent'
    });
    expect(fixture.io.unlink).not.toHaveBeenCalled();
  });

  it('reconciles before- and after-effect creation errors', async () => {
    const before = setup({ createError: 'before' });
    await expect(createWindowsSkillMembership(before.options)).rejects.toMatchObject({
      code: 'WINDOWS_SKILL_MEMBERSHIP_CREATE_FAILED'
    });

    const after = setup({ createError: 'after' });
    await expect(createWindowsSkillMembership(after.options)).resolves.toMatchObject({ action: 'added' });
  });

  it('reconciles before- and after-effect unlink errors without touching the target', async () => {
    const before = setup({ present: true, unlinkError: 'before' });
    await expect(removeWindowsSkillMembership(before.options)).resolves.toMatchObject({ outcome: 'present' });

    const after = setup({ present: true, unlinkError: 'after' });
    await expect(removeWindowsSkillMembership(after.options)).resolves.toEqual({
      outcome: 'absent', effect: 'removed'
    });
    expect(after.inspectPath(TARGET).object.fileId).toBe(id(TARGET));
  });

  it('refuses a wrong direct target and target substitution', async () => {
    const wrong = setup({ present: true, linkTarget: 'C:\\provider\\other' });
    expect(() => inspectWindowsSkillMembership(wrong.options)).toThrow(
      expect.objectContaining({ code: 'WINDOWS_SKILL_MEMBERSHIP_INVALID' })
    );

    const changed = setup({ present: true });
    const original = changed.backend.inspectPath;
    let targetReads = 0;
    changed.backend.inspectPath = (path) => {
      const result = original(path);
      if (path === TARGET && ++targetReads > 1) {
        return directory(path, 'ffffffffffffffffffffffffffffffff');
      }
      return result;
    };
    expect(() => inspectWindowsSkillMembership(changed.options)).toThrow(
      expect.objectContaining({ code: 'WINDOWS_SKILL_MEMBERSHIP_TARGET_CHANGED' })
    );
  });

  it.each([
    'WINDOWS_NATIVE_MEMBERSHIP_LINK_INVALID',
    'WINDOWS_NATIVE_MEMBERSHIP_TARGET_INVALID',
    'WINDOWS_NATIVE_MEMBERSHIP_CHANGED'
  ])('refuses occupied, foreign, chained, or unreadable state (%s)', async (code) => {
    const fixture = setup();
    fixture.backend.inspectMembershipLink = () => { throw new BazframeError(code, 'refused'); };
    await expect(createWindowsSkillMembership(fixture.options)).rejects.toMatchObject({ code });
    expect(fixture.io.symlink).not.toHaveBeenCalled();
  });

  it('detects parent and link substitution during immediate revalidation', () => {
    const changedParent = setup({ present: true });
    const inspectPath = changedParent.backend.inspectPath;
    let parentReads = 0;
    changedParent.backend.inspectPath = (path) => {
      const result = inspectPath(path);
      if (path === PARENT && ++parentReads > 1) {
        return directory(path, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
      }
      return result;
    };
    expect(() => inspectWindowsSkillMembership(changedParent.options)).toThrow(
      expect.objectContaining({ code: 'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED' })
    );

    const changedLink = setup({ present: true });
    const inspectLink = changedLink.backend.inspectMembershipLink;
    let linkReads = 0;
    changedLink.backend.inspectMembershipLink = (path) => {
      const result = inspectLink(path);
      if (++linkReads > 1) {
        result.security.groupSid = SYSTEM;
      }
      return result;
    };
    expect(() => inspectWindowsSkillMembership(changedLink.options)).toThrow(
      expect.objectContaining({ code: 'WINDOWS_SKILL_MEMBERSHIP_CHANGED' })
    );
  });

  it('reports substituted or unreadable post-remove state as ambiguous', async () => {
    const substituted = setup({ present: true, unlinkError: 'before' });
    const inspectLink = substituted.backend.inspectMembershipLink;
    let reads = 0;
    substituted.backend.inspectMembershipLink = (path) => {
      const result = inspectLink(path);
      if (++reads > 2) result.object.fileId = 'cccccccccccccccccccccccccccccccc';
      return result;
    };
    await expect(removeWindowsSkillMembership(substituted.options)).rejects.toMatchObject({
      code: 'WINDOWS_SKILL_MEMBERSHIP_REMOVE_AMBIGUOUS'
    });

    const unreadable = setup({ present: true, unlinkError: 'before' });
    const inspectReadableLink = unreadable.backend.inspectMembershipLink;
    let readableReads = 0;
    unreadable.backend.inspectMembershipLink = (path) => {
      if (++readableReads > 2) throw new BazframeError('WINDOWS_NATIVE_IO_FAILED', 'unreadable');
      return inspectReadableLink(path);
    };
    await expect(removeWindowsSkillMembership(unreadable.options)).rejects.toMatchObject({
      code: 'WINDOWS_SKILL_MEMBERSHIP_REMOVE_AMBIGUOUS'
    });
  });

  it('fails ambiguous when successful creation cannot be proved', async () => {
    const fixture = setup();
    fixture.io.symlink.mockImplementation(async () => undefined);
    await expect(createWindowsSkillMembership(fixture.options)).rejects.toMatchObject({
      code: 'WINDOWS_SKILL_MEMBERSHIP_CREATE_AMBIGUOUS'
    });
  });

  it('rejects unsafe inputs before any membership I/O', async () => {
    const fixture = setup();
    for (const skillId of [
      'CON',
      'Demo',
      '技能',
      'demo.skill',
      '-demo',
      'demo-',
      'demo--skill',
      'a'.repeat(65)
    ]) {
      await expect(createWindowsSkillMembership({ ...fixture.options, skillId }))
        .rejects.toMatchObject({ code: 'WINDOWS_SKILL_MEMBERSHIP_NAME_INVALID' });
    }
    await expect(createWindowsSkillMembership({ ...fixture.options, targetPath: 'relative' }))
      .rejects.toMatchObject({ code: 'WINDOWS_SKILL_MEMBERSHIP_PATH_INVALID' });
    expect(fixture.io.symlink).not.toHaveBeenCalled();
  });
});

function setup(options: {
  present?: boolean;
  linkTarget?: string;
  createError?: 'before' | 'after';
  unlinkError?: 'before' | 'after';
} = {}) {
  let link = options.present ? membership(options.linkTarget ?? TARGET) : undefined;
  const inspectPath = vi.fn((path: string) => directory(path));
  const backend: BazframeWin32NativeBackend = {
    inspectPath,
    inspectMembershipLink(path) {
      if (path !== MEMBER || link === undefined) {
        throw new BazframeError('WINDOWS_NATIVE_PATH_NOT_FOUND', 'absent');
      }
      const result = structuredClone(link);
      result.security.daclBytes = Buffer.from(link.security.daclBytes);
      return result;
    },
    createPrivateDirectory: () => { throw new Error('unexpected create directory'); },
    createPrivateFile: () => { throw new Error('unexpected create file'); },
    renameDirectoryNoReplace: async () => { throw new Error('unexpected rename'); },
    readStableFile: async () => { throw new Error('unexpected read'); },
    enumerateStableDirectory: async () => { throw new Error('unexpected enumeration'); }
  };
  const io = {
    symlink: vi.fn(async () => {
      if (options.createError === 'before') throw new Error('before create');
      link = membership(options.linkTarget ?? TARGET);
      if (options.createError === 'after') throw new Error('after create');
    }),
    unlink: vi.fn(async () => {
      if (options.unlinkError === 'before') throw new Error('before unlink');
      link = undefined;
      if (options.unlinkError === 'after') throw new Error('after unlink');
    })
  } satisfies WindowsSkillMembershipIo;
  return {
    backend,
    io,
    inspectPath,
    options: { backend, parentPath: PARENT, skillId: 'demo-skill', targetPath: TARGET, io }
  };
}

function membership(target: string): WindowsMembershipLinkInspection {
  return {
    canonicalPath: canonical(MEMBER),
    volume: volume(),
    object: object(id(MEMBER), 0x410, 0xa0000003, true),
    security: security(),
    ancestryReparseFree: true,
    normalizedTarget: canonical(target),
    targetVolumeIdentity: VOLUME,
    targetFileId: id(target)
  };
}

function directory(path: string, fileId = id(path)): WindowsPathInspection {
  return {
    canonicalPath: canonical(path),
    kind: 'directory',
    volume: volume(),
    object: object(fileId, 16, null, true),
    security: security(),
    ancestryReparseFree: true
  };
}

function volume() {
  return {
    identity: VOLUME,
    filesystemName: 'NTFS' as const,
    driveType: 'fixed' as const,
    canonicalVolumeGuidPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\',
    remoteDevice: false as const
  };
}

function object(fileId: string, attributes: number, reparseTag: number | null, directory: boolean) {
  return {
    volumeIdentity: VOLUME,
    fileId,
    size: '0000000000000000',
    allocationSize: '0000000000000000',
    numberOfLinks: '00000001',
    creationTime: '0000000000000001',
    lastAccessTime: '0000000000000001',
    lastWriteTime: '0000000000000001',
    changeTime: '0000000000000001',
    attributes,
    reparseTag,
    deletePending: false,
    directory
  };
}

function canonical(path: string): string {
  const root = '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\';
  return `${root}${path.slice(3)}`;
}

function id(path: string): string {
  const hex = Buffer.from(path).toString('hex').slice(0, 32);
  return hex.padEnd(32, '0');
}

function security(options: { inherited?: boolean } = {}): WindowsSecurityObservation {
  return {
    descriptorControl: options.inherited ? 0x0404 : 0x1004,
    daclPresent: true,
    daclNull: false,
    daclDefaulted: false,
    daclBytes: acl(options.inherited ? 0x13 : 3),
    ownerSid: USER,
    ownerDefaulted: false,
    groupSid: USER,
    groupDefaulted: false,
    currentUserSid: USER
  };
}

function acl(flags = 3, foreign = false, user = USER): Buffer {
  const principals = [user, SYSTEM, ADMINISTRATORS, ...(foreign ? ['S-1-1-0'] : [])];
  const entries = principals.map((sid) => ace(sid, flags));
  const size = 8 + entries.reduce((sum, entry) => sum + entry.length, 0);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt16LE(size, 2);
  header.writeUInt16LE(entries.length, 4);
  return Buffer.concat([header, ...entries]);
}

function ace(sid: string, flags = 3): Buffer {
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
  const subs = parts.slice(3).map(Number);
  const result = Buffer.alloc(8 + subs.length * 4);
  result[0] = 1;
  result[1] = subs.length;
  let remaining = authority;
  for (let index = 7; index >= 2; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  subs.forEach((entry, index) => result.writeUInt32LE(entry, 8 + index * 4));
  return result;
}
