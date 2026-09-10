import { createWindowsApplicationServices } from './win32-application-services.js';
import path from 'node:path';
import type { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { PolicyServices } from '../policy/policy-services.js';
import type { GitRootServices } from '../project/git-root.js';
import type { ProfileLoadOptions, ActiveProfileReadServices } from '../profiles/profile-store.js';
import type { ProfileProvisioningServices } from '../profiles/profile-management.js';
import type { ProfileLifecycleServices } from '../profile-publishing/profile-lifecycle-services.js';
import type { ProfileFavoriteServices } from '../profiles/profile-favorites.js';
import type { ManagedProfileActivationServices } from '../profile-publishing/profile-managed-lifecycle.js';
import type { ProfileLifecycleDependencies } from '../profile-publishing/profile-lifecycle.js';
import type { ProfileResourceMembershipDependencies } from '../profile-publishing/profile-resource-membership.js';
import type { SkillCollectionLifecycleServices } from '../skill-collections/skill-collection-lifecycle.js';
import type { ProfileSystemViewReadServices } from '../profile-publishing/profile-view.js';
import type { createManagedGitProvider } from '../providers/managed-git.js';
import type { ManagedRuntimeProjectionServices } from '../profile-publishing/profile-runtime-projection.js';
import type { PiAdapterServices } from '../adapters/pi/adapter-services.js';
import type { PiAdapterLifecycleOptions } from '../adapters/pi/installer.js';
import type { ProfileInstructionEditorOptions } from '../profiles/profile-instruction-editor.js';
import type { SkillDefinitionEditorOptions } from '../skills/skill-definition-editor.js';
import type { ProfileLifecycleRuntimeOptions } from '../profile-publishing/profile-runtime.js';

/** One lazy effects object; the shared product functions continue to own decisions. */
export interface ApplicationServices {
  paths: typeof path;
  reads?: {
    stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    entries(path: string, external?: boolean): Promise<Array<{ name: string }>>;
    canonical(path: string): Promise<string>;
    instructions(path: string, label: string): Promise<string>;
  };
  policy?: PolicyServices;
  gitRoot?: GitRootServices;
  profiles?: ProfileLoadOptions;
  provisioning?: ProfileProvisioningServices;
  selection?: ActiveProfileReadServices;
  lifecycle?: ProfileLifecycleServices & ProfileFavoriteServices;
  activation?: ManagedProfileActivationServices;
  profileLifecycle?: ProfileLifecycleDependencies;
  copyProfileEffects?: (home: string, authority: import('../profile-publishing/profile-operation-lock.js').OperationMutationAuthority) => import('../profile-publishing/profile-publication.js').ProfileClosureCopyEffects;
  importedMembership?: ProfileResourceMembershipDependencies;
  packageProcessRunner?: import('../skill-collections/skill-collection-lifecycle.js').SkillCollectionLifecycleDependencies['packageProcessRunner'];
  collections?: SkillCollectionLifecycleServices;
  view?: ProfileSystemViewReadServices;
  projection?: ManagedRuntimeProjectionServices;
  providerRecords?: import('../providers/managed-git-record.js').ManagedGitRecordScanServices;
  countAliasCache?: (home: string) => Promise<number>;
  provider?: (home: string) => ReturnType<typeof createManagedGitProvider>;
  adapter?: (options: PiAdapterLifecycleOptions) => PiAdapterServices;
  profileEditor?: Pick<ProfileInstructionEditorOptions, 'targetProof' | 'resolveExecutable' | 'platform'>;
  skillEditor?: Pick<SkillDefinitionEditorOptions, 'targetProof' | 'resolveExecutable' | 'platform'>;
  runtimeOptions?: Pick<ProfileLifecycleRuntimeOptions, 'filesystem' | 'recoveryServices' | 'process'>;
  temporaryInstructions?: typeof import('../harness/temporary-instructions.js').createTemporaryInstructionFile;
  launcher?: NonNullable<Parameters<typeof import('../agents/spawn-pi.js').spawnPi>[4]>;
  parseFrontmatter?: typeof parseFrontmatter;
}
export const defaultApplicationServices: ApplicationServices = Object.freeze({ paths: path });
export function createApplicationServices(platform = process.platform): ApplicationServices { return platform === 'win32' ? createWindowsApplicationServices() : defaultApplicationServices; }
