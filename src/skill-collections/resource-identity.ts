/** In-memory physical identity only. Windows IDs are never coerced into POSIX numbers. */
export type ResourceIdentity =
  | { domain?: 'posix'; device: bigint; inode: bigint }
  | { domain: 'windows'; volumeIdentity: string; fileId: string; creationTime: string; device?: never; inode?: never };
export type ResourceRootIdentity = ResourceIdentity & { root: string };
export function sameResourceIdentity(a: ResourceIdentity, b: ResourceIdentity): boolean {
  if (a.domain === 'windows' || b.domain === 'windows') return a.domain === 'windows' && b.domain === 'windows' && a.volumeIdentity === b.volumeIdentity && a.fileId === b.fileId && a.creationTime === b.creationTime;
  return a.device === b.device && a.inode === b.inode;
}
export function resourceIdentityText(value: ResourceIdentity): string {
  return value.domain === 'windows' ? `windows:${value.volumeIdentity}:${value.fileId}:${value.creationTime}` : `posix:${value.device}:${value.inode}`;
}

export const isRetainedResourceFile = (name: string): boolean => /^(?:resource-[a-f0-9]{32}\.tmp|\.bazframe-resource-[a-f0-9]{32}\.json)$/u.test(name);
