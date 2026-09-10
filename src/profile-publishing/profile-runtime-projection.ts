import { dirname, join } from 'node:path';
import { BazframeError } from '../core/errors.js';
import { loadFlatSkillIdentities, loadFlatSkillIdentitiesWithEffects, type SkillCollectionResolverEffects, type FlatSkillIdentity } from '../skill-collections/skill-collection-resolver.js';
import { readArtifactTree } from './artifact-tree.js';
import { readProfileSystemView, type ProfileSystemViewReadServices, type ProfileResourceInstanceView } from './profile-view.js';

export interface ManagedRuntimeProjectionServices {
  view: ProfileSystemViewReadServices;
  readTree: typeof readArtifactTree;
  resolver: SkillCollectionResolverEffects;
}

export interface ManagedProfileRuntimeProjection {
  skillDirectories: string[];
  skills: FlatSkillIdentity[];
}

/**
 * Projects immutable imported artifacts into the same Skill-directory input
 * used by the launcher and Pi adapter. Physical/catalog memberships remain
 * owned by the existing profile representation and are intentionally omitted.
 */
export async function projectManagedProfileRuntime(
  home: string,
  profileName: string,
  services?: ManagedRuntimeProjectionServices
): Promise<ManagedProfileRuntimeProjection> {
  const view = await readProfileSystemView(home, services?.view);
  const profile = view.profiles.find((candidate) => candidate.name === profileName);
  if (profile === undefined) throw new BazframeError('PROFILE_NOT_FOUND', `Profile not found: ${profileName}`);

  const directories = new Set<string>();
  for (const identity of profile.resourceIdentities) {
    if (!identity.startsWith('imported:')) continue;
    const resource = view.resources.find((candidate) => candidate.stableIdentity === identity);
    if (resource === undefined) throw invalid();
    await addImportedSkillDirectories(home, resource, directories, services);
  }
  const skillDirectories = [...directories].sort();
  return { skillDirectories, skills: services === undefined ? loadFlatSkillIdentities(skillDirectories) : await loadFlatSkillIdentitiesWithEffects(skillDirectories, services.resolver) };
}

async function addImportedSkillDirectories(
  home: string,
  resource: ProfileResourceInstanceView,
  directories: Set<string>,
  services?: ManagedRuntimeProjectionServices
): Promise<void> {
  const materialization = resource.materialization;
  if (materialization.kind === 'missingRemoteGit') return;
  if (materialization.kind === 'ordinary' || materialization.kind === 'profileLocal') throw invalid();
  const tree = await (services?.readTree ?? readArtifactTree)(home, materialization.treeId);
  if (tree.path !== (services?.resolver.dirname ?? dirname)(materialization.treeRoot) || (services?.resolver.joinPath ?? join)(tree.path, 'root') !== materialization.treeRoot) throw invalid();
  if (tree.manifest.role === 'skill') {
    if (!tree.manifest.files.some((file) => file.path === 'SKILL.md')) throw invalid();
    directories.add(materialization.treeRoot);
    return;
  }
  for (const file of tree.manifest.files) {
    if (file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md')) {
      directories.add(file.path === 'SKILL.md' ? materialization.treeRoot : (services?.resolver.joinPath ?? join)(materialization.treeRoot, dirname(file.path)));
    }
  }
}

function invalid(): BazframeError {
  return new BazframeError('PROFILE_RUNTIME_PROJECTION_INVALID', 'Managed profile runtime projection is invalid.');
}
