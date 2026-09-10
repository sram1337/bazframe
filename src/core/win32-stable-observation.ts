import type { WindowsMembershipLinkInspection, WindowsObjectObservation, WindowsPathInspection } from './win32-native.js';

/** Windows unchanged-path content stability, not raw evidence or relocation authority.
 * Access time alone is incidental to reads; every other declared observation is retained. */
export function stableWindowsPathInspection(value: WindowsPathInspection) {
  return {
    canonicalPath: value.canonicalPath,
    kind: value.kind,
    ancestryReparseFree: value.ancestryReparseFree,
    volume: {
      identity: value.volume.identity,
      filesystemName: value.volume.filesystemName,
      driveType: value.volume.driveType,
      canonicalVolumeGuidPath: value.volume.canonicalVolumeGuidPath,
      remoteDevice: value.volume.remoteDevice
    },
    object: stableWindowsObjectObservation(value.object),
    security: {
      descriptorControl: value.security.descriptorControl,
      daclPresent: value.security.daclPresent,
      daclNull: value.security.daclNull,
      daclDefaulted: value.security.daclDefaulted,
      daclBytesBase64: value.security.daclBytes.toString('base64'),
      ownerSid: value.security.ownerSid,
      ownerDefaulted: value.security.ownerDefaulted,
      groupSid: value.security.groupSid,
      groupDefaulted: value.security.groupDefaulted,
      currentUserSid: value.security.currentUserSid
    }
  };
}

export function stableWindowsObjectObservation(value: WindowsObjectObservation) {
  return {
    volumeIdentity: value.volumeIdentity,
    fileId: value.fileId,
    size: value.size,
    allocationSize: value.allocationSize,
    numberOfLinks: value.numberOfLinks,
    creationTime: value.creationTime,
    lastWriteTime: value.lastWriteTime,
    changeTime: value.changeTime,
    attributes: value.attributes,
    reparseTag: value.reparseTag,
    deletePending: value.deletePending,
    directory: value.directory
  };
}

export function stableWindowsMembershipLinkInspection(value: WindowsMembershipLinkInspection) {
  return {
    canonicalPath: value.canonicalPath,
    ancestryReparseFree: value.ancestryReparseFree,
    volume: {
      identity: value.volume.identity,
      filesystemName: value.volume.filesystemName,
      driveType: value.volume.driveType,
      canonicalVolumeGuidPath: value.volume.canonicalVolumeGuidPath,
      remoteDevice: value.volume.remoteDevice
    },
    object: stableWindowsObjectObservation(value.object),
    security: {
      descriptorControl: value.security.descriptorControl,
      daclPresent: value.security.daclPresent,
      daclNull: value.security.daclNull,
      daclDefaulted: value.security.daclDefaulted,
      daclBytesBase64: value.security.daclBytes.toString('base64'),
      ownerSid: value.security.ownerSid,
      ownerDefaulted: value.security.ownerDefaulted,
      groupSid: value.security.groupSid,
      groupDefaulted: value.security.groupDefaulted,
      currentUserSid: value.security.currentUserSid
    },
    normalizedTarget: value.normalizedTarget,
    targetVolumeIdentity: value.targetVolumeIdentity,
    targetFileId: value.targetFileId
  };
}
