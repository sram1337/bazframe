import { describe, expect, it } from 'vitest';
import type { WindowsMembershipLinkInspection, WindowsObjectObservation, WindowsPathInspection, WindowsVolumeObservation } from '../../../src/core/win32-native.js';
import { stableWindowsMembershipLinkInspection, stableWindowsObjectObservation, stableWindowsPathInspection } from '../../../src/core/win32-stable-observation.js';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';

// Explicit DTO inventories: adding any declared field requires updating this contract.
const objectKeys: Record<keyof WindowsObjectObservation, true> = {
  volumeIdentity: true, fileId: true, size: true, allocationSize: true, numberOfLinks: true,
  creationTime: true, lastAccessTime: true, lastWriteTime: true, changeTime: true,
  attributes: true, reparseTag: true, deletePending: true, directory: true
};
const volumeKeys: Record<keyof WindowsVolumeObservation, true> = {
  identity: true, filesystemName: true, driveType: true, canonicalVolumeGuidPath: true, remoteDevice: true
};
const pathKeys: Record<keyof WindowsPathInspection, true> = {
  canonicalPath: true, kind: true, volume: true, object: true, ancestryReparseFree: true
};
const membershipKeys: Record<keyof WindowsMembershipLinkInspection, true> = {
  canonicalPath: true, volume: true, object: true, ancestryReparseFree: true,
  normalizedTarget: true, targetVolumeIdentity: true, targetFileId: true
};
function fixture(kind: 'file' | 'directory' = 'directory') {
  const f = windowsProvisioningFixture();
  if (kind === 'file') f.file('C:\\boundary\\file', 'bytes');
  return f.backend.inspectPath(kind === 'file' ? 'C:\\boundary\\file' : 'C:\\boundary');
}
function membership(value: WindowsPathInspection): WindowsMembershipLinkInspection {
  return { canonicalPath: value.canonicalPath, volume: value.volume, object: value.object,
    ancestryReparseFree: value.ancestryReparseFree,
    normalizedTarget: 'C:\\target', targetVolumeIdentity: value.object.volumeIdentity, targetFileId: 'f'.repeat(32) };
}
function different(value: unknown): unknown {
  if (Buffer.isBuffer(value)) { const bytes = Buffer.from(value); bytes[bytes.length - 1]! ^= 1; return bytes; }
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  return `${String(value)}-changed`;
}

describe('Windows explicitly typed unchanged-path stable projections', () => {
  it.each(['file', 'directory'] as const)('exempts only access time for %s and preserves both raw inputs ', (kind) => {
    const before = fixture(kind);
    const after = { ...before, object: { ...before.object, lastAccessTime: '0000000000000099' } };
    const rawBefore = JSON.stringify(before), rawAfter = JSON.stringify(after);
    expect(stableWindowsPathInspection(after)).toEqual(stableWindowsPathInspection(before));
    expect(stableWindowsObjectObservation(after.object)).toEqual(stableWindowsObjectObservation(before.object));
    expect(stableWindowsMembershipLinkInspection(membership(after))).toEqual(stableWindowsMembershipLinkInspection(membership(before)));
    expect(JSON.stringify(before)).toBe(rawBefore); expect(JSON.stringify(after)).toBe(rawAfter);
    expect(after.object.lastAccessTime).not.toBe(before.object.lastAccessTime);
  });
  it('covers every DTO key with exactly the documented representation substitutions', () => {
    const raw = fixture(), projected = stableWindowsPathInspection(raw);
    const keys = (value: object) => Object.keys(value).sort();
    expect(keys(raw)).toEqual(keys(pathKeys)); expect(keys(projected)).toEqual(keys(pathKeys));
    expect(keys(raw.object)).toEqual(keys(objectKeys));
    expect(keys(projected.object)).toEqual(keys(objectKeys).filter((key) => key !== 'lastAccessTime'));
    expect(keys(raw.volume)).toEqual(keys(volumeKeys)); expect(keys(projected.volume)).toEqual(keys(volumeKeys));
    expect(keys(membership(raw))).toEqual(keys(membershipKeys));
    expect(keys(stableWindowsMembershipLinkInspection(membership(raw)))).toEqual(keys(membershipKeys));
  });
  for (const [section, inventory] of [['object', objectKeys], ['volume', volumeKeys]] as const) {
    it.each(Object.keys(inventory).filter((key) => key !== 'lastAccessTime'))(`retains ${section}.%s for path and membership`, (key) => {
      const before = fixture();
      const values = before[section] as unknown as Record<string, unknown>;
      const after = { ...before, [section]: { ...values, [key]: different(values[key]) } } as WindowsPathInspection;
      expect(stableWindowsPathInspection(after)).not.toEqual(stableWindowsPathInspection(before));
      expect(stableWindowsMembershipLinkInspection(membership(after))).not.toEqual(stableWindowsMembershipLinkInspection(membership(before)));
    });
  }
  it.each(['canonicalPath', 'kind', 'ancestryReparseFree'] as const)('retains path %s', (key) => {
    const before = fixture(), after = { ...before, [key]: different(before[key]) } as WindowsPathInspection;
    expect(stableWindowsPathInspection(after)).not.toEqual(stableWindowsPathInspection(before));
  });
  it.each(['canonicalPath', 'ancestryReparseFree', 'normalizedTarget', 'targetVolumeIdentity', 'targetFileId'] as const)('retains membership %s', (key) => {
    const before = membership(fixture()), after = { ...before, [key]: different(before[key]) } as WindowsMembershipLinkInspection;
    expect(stableWindowsMembershipLinkInspection(after)).not.toEqual(stableWindowsMembershipLinkInspection(before));
  });
});
