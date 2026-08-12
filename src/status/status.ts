import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectPiAdapter } from '../adapters/pi/installer.js';
import type { PiAdapterInstallState } from '../adapters/pi/ownership.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { EXIT_STATUS } from '../core/exit-status.js';
import {
  resolveEffectivePolicy,
  type EffectivePolicyReason
} from '../policy/effective-policy.js';
import { globalPolicyPath, readGlobalPolicy } from '../policy/global-policy.js';
import { loadProfile, readActiveProfile } from '../profiles/profile-store.js';
import { findGitRoot } from '../project/git-root.js';
import { readRepositoryProjectState } from '../project/registration-store.js';
import {
  formatSourceDiagnostic,
  loadFlatSkillIdentities,
  resolveProfileSourceUnits,
  type DerivedSkill,
  type DirectSourceUnit,
  type SourceDiagnostic
} from '../source-units/source-unit-resolver.js';
import { resolvePiAgentDirectory } from '../state/paths.js';

export interface StatusOptions {
  bazframeHome: string;
  bazframeVersion: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  userHome?: string;
  artifactUrl?: URL;
}

export type StatusProjectState =
  | 'inherit'
  | 'enabled-override'
  | 'disabled-override'
  | 'legacy-inherit';

export type StatusRepository =
  | { kind: 'outside-git' }
  | { kind: 'git-worktree'; root: string; projectState: StatusProjectState };

export type StatusEffectiveBehavior =
  | {
      kind: 'outside-git' | 'git-worktree';
      enabled: true;
      reason: Extract<EffectivePolicyReason, 'project-enabled-override' | 'global-enabled'>;
    }
  | {
      kind: 'outside-git' | 'git-worktree';
      enabled: false;
      reason: Extract<EffectivePolicyReason, 'project-disabled-override' | 'global-disabled'>;
    };

export type StatusProfile =
  | {
      state: 'not-used';
      reason: Extract<
        EffectivePolicyReason,
        'project-disabled-override' | 'global-disabled'
      >;
    }
  | { state: 'unselected' }
  | { state: 'missing'; id: string }
  | {
      state: 'ready';
      id: string;
      instructionsPath: string;
      /** Compatibility alias for the flat direct skill count. */
      skillCount: number;
      flatSkillCount?: number;
      directSourceUnitCount?: number;
      directSourceUnits?: DirectSourceUnit[];
      derivedSkillCount?: number;
      derivedSkills?: DerivedSkill[];
      sourceDiagnostics?: SourceDiagnostic[];
    };

export interface StatusCorrectiveAction {
  id: 'adapter' | 'active-profile' | 'source-units';
  message: string;
}

export type StatusGlobalPolicy =
  | { policy: 'enabled' }
  | { policy: 'disabled'; statePath: string };

export interface StatusInspection {
  bazframeHome: string;
  piAgentDirectory: string;
  adapter: {
    state: PiAdapterInstallState;
    targetPath: string;
    installedBazframeVersion?: string;
  };
  globalPolicy: StatusGlobalPolicy;
  repository: StatusRepository;
  effectiveBehavior: StatusEffectiveBehavior;
  profile: StatusProfile;
  cachedCollisionAliasCount: number;
  correctiveActions: readonly StatusCorrectiveAction[];
}

export interface StatusResult {
  exitStatus: number;
  text: string;
}

export async function inspectStatus(options: StatusOptions): Promise<StatusInspection> {
  const corrections = new Map<StatusCorrectiveAction['id'], StatusCorrectiveAction>();
  const adapter = await inspectPiAdapter({
    bazframeHome: options.bazframeHome,
    bazframeVersion: options.bazframeVersion,
    environment: options.environment,
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    ...(options.artifactUrl === undefined ? {} : { artifactUrl: options.artifactUrl })
  });
  const globalPolicy = await readGlobalPolicy(options.bazframeHome);

  let repository: StatusRepository = { kind: 'outside-git' };
  let effectiveBehavior: StatusEffectiveBehavior = globalPolicy === 'enabled'
    ? { kind: 'outside-git', enabled: true, reason: 'global-enabled' }
    : { kind: 'outside-git', enabled: false, reason: 'global-disabled' };
  try {
    const root = await findGitRoot(options.cwd, options.environment);
    const state = await readRepositoryProjectState(options.bazframeHome, root);
    repository = {
      kind: 'git-worktree',
      root,
      projectState: state === undefined
        ? 'inherit'
        : state.schemaVersion === 3
          ? 'enabled-override'
          : state.schemaVersion === 2
            ? 'disabled-override'
            : 'legacy-inherit'
    };
    const effective = resolveEffectivePolicy(globalPolicy, state);
    effectiveBehavior = effective.enabled
      ? {
          kind: 'git-worktree',
          enabled: true,
          reason: effective.reason === 'project-enabled-override'
            ? 'project-enabled-override'
            : 'global-enabled'
        }
      : {
          kind: 'git-worktree',
          enabled: false,
          reason: effective.reason === 'project-disabled-override'
            ? 'project-disabled-override'
            : 'global-disabled'
        };
  } catch (error) {
    if (!(error instanceof BazframeError && error.code === 'NOT_GIT_WORKTREE')) throw error;
  }

  let profile: StatusProfile;
  if (!effectiveBehavior.enabled) {
    profile = { state: 'not-used', reason: effectiveBehavior.reason };
  } else {
    if (adapter.state !== 'current') {
      corrections.set('adapter', {
        id: 'adapter',
        message: adapterCorrection(adapter.state, adapter.targetPath)
      });
    }
    try {
      const profileId = await readActiveProfile(options.bazframeHome);
      try {
        const loaded = await loadProfile(options.bazframeHome, profileId);
        const flatSkills = loadFlatSkillIdentities(loaded.skillDirectories);
        const sources = await resolveProfileSourceUnits(loaded.directory, flatSkills);
        profile = {
          state: 'ready',
          id: profileId,
          instructionsPath: loaded.instructionsPath,
          skillCount: loaded.skillDirectories.length,
          flatSkillCount: loaded.skillDirectories.length,
          directSourceUnitCount: sources.directSourceUnits.length,
          directSourceUnits: sources.directSourceUnits,
          derivedSkillCount: sources.derivedSkills.length,
          derivedSkills: sources.derivedSkills,
          sourceDiagnostics: sources.diagnostics
        };
        if (sources.diagnostics.length > 0) {
          const buildRequired = sources.directSourceUnits
            .filter((source) => source.preparationState === 'build-required'
              || (source.preparationState === 'failed' && source.rebuildAvailability === 'available'))
            .map((source) => `bazframe profile sources build ${source.providerId} ${source.sourceId}`);
          corrections.set('source-units', {
            id: 'source-units',
            message: buildRequired.length === 0
              ? 'Inspect source-unit failures with `bazframe profile sources`.'
              : `Build the sources with: ${buildRequired.map((command) => `\`${command}\``).join(', ')}.`
          });
        }
      } catch (error) {
        if (error instanceof BazframeError && error.code === 'PROFILE_NOT_FOUND') {
          profile = { state: 'missing', id: profileId };
          corrections.set('active-profile', {
            id: 'active-profile',
            message: 'Select an existing profile with `bazframe profile use <profile>`.'
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof BazframeError && error.code === 'NO_ACTIVE_PROFILE') {
        profile = { state: 'unselected' };
        corrections.set('active-profile', {
          id: 'active-profile',
          message: 'Create a profile with `bazframe profile add <profile>` if needed, then select it with `bazframe profile use <profile>`.'
        });
      } else {
        throw error;
      }
    }
  }

  return {
    bazframeHome: options.bazframeHome,
    piAgentDirectory: resolvePiAgentDirectory(options.environment, options.userHome),
    adapter: {
      state: adapter.state,
      targetPath: adapter.targetPath,
      ...(adapter.manifest === undefined
        ? {}
        : { installedBazframeVersion: adapter.manifest.bazframeVersion })
    },
    globalPolicy: globalPolicy === 'enabled'
      ? { policy: 'enabled' }
      : {
          policy: 'disabled',
          statePath: globalPolicyPath(options.bazframeHome)
        },
    repository,
    effectiveBehavior,
    profile,
    cachedCollisionAliasCount: await countAliasCache(options.bazframeHome),
    correctiveActions: [...corrections.values()]
  };
}

export function formatStatus(status: StatusInspection): string {
  const repository = status.repository.kind === 'outside-git'
    ? '(outside a Git worktree)'
    : status.repository.root;
  const projectState = status.repository.kind === 'outside-git'
    ? 'not applicable'
    : status.repository.projectState === 'inherit'
      ? 'none (inherits global policy)'
      : status.repository.projectState === 'enabled-override'
        ? 'enabled override'
        : status.repository.projectState === 'disabled-override'
          ? 'disabled override'
          : 'legacy redundant inherit record';
  const behavior = status.effectiveBehavior.enabled
    ? `enabled (${status.effectiveBehavior.reason})`
    : `disabled (${status.effectiveBehavior.reason}; native Pi behavior)`;
  const notUsedReason = status.profile.state === 'not-used'
    ? `disabled: ${status.profile.reason}`
    : undefined;
  const activeProfile = status.profile.state === 'ready' || status.profile.state === 'missing'
    ? status.profile.id
    : status.profile.state === 'unselected'
      ? '(none)'
      : `(not used: ${notUsedReason})`;
  const instructionSource = status.profile.state === 'ready'
    ? status.profile.instructionsPath
    : status.profile.state === 'not-used'
      ? `(not used: ${notUsedReason})`
      : '(none)';
  const unavailableCount = status.profile.state === 'not-used'
    ? `(not used: ${notUsedReason})`
    : 0;
  const flatSkillCount: number | string = status.profile.state === 'ready'
    ? status.profile.flatSkillCount ?? status.profile.skillCount
    : unavailableCount;
  const directSourceUnitCount: number | string = status.profile.state === 'ready'
    ? status.profile.directSourceUnitCount ?? 0
    : unavailableCount;
  const directSourceUnits = status.profile.state === 'ready' ? status.profile.directSourceUnits ?? [] : [];
  const derivedSkillCount: number | string = status.profile.state === 'ready'
    ? status.profile.derivedSkillCount ?? 0
    : unavailableCount;
  const derivedSkills = status.profile.state === 'ready'
    ? status.profile.derivedSkills ?? []
    : [];
  const sourceDiagnostics = status.profile.state === 'ready'
    ? status.profile.sourceDiagnostics ?? []
    : [];
  const runtimeReady = status.adapter.state === 'current' && status.profile.state === 'ready';
  const globalState = status.globalPolicy.policy === 'enabled'
    ? 'none (enabled default)'
    : status.globalPolicy.statePath;
  const lines = [
    'Bazframe status',
    `Bazframe home: ${status.bazframeHome}`,
    `Pi agent directory: ${status.piAgentDirectory}`,
    `Pi adapter: ${status.adapter.state}`,
    `Pi adapter version: ${status.adapter.installedBazframeVersion ?? '(none)'}`,
    `Pi extension: ${status.adapter.targetPath}`,
    `Global policy: ${status.globalPolicy.policy}`,
    `Global state: ${globalState}`,
    `Repository: ${repository}`,
    `Project state: ${projectState}`,
    `Effective behavior: ${behavior}`,
    `Active profile: ${activeProfile}`,
    `Profile instructions: ${instructionSource}`,
    `Flat direct skills: ${flatSkillCount}`,
    `Direct source units: ${directSourceUnitCount}`,
    ...directSourceUnits.map((source) => `  - ${source.providerId}/${source.sourceId}: ${source.preparationState}; rebuild ${source.rebuildAvailability}${source.schemaVersion === 2 ? `; sha256:${source.snapshotDigest}; root:${source.sourceUnitRoot}` : ''}`),
    `Derived effective skills: ${derivedSkillCount}`,
    ...(derivedSkills.length === 0
      ? ['  (none)']
      : derivedSkills.map((skill) =>
          `  - ${skill.name} (${skill.providerId}/${skill.sourceId}:${skill.relativePath})`)),
    'Source failures:',
    ...(sourceDiagnostics.length === 0
      ? ['  (none)']
      : sourceDiagnostics.map((diagnostic) => `  - ${formatSourceDiagnostic(diagnostic)}`)),
    `Cached collision aliases: ${status.cachedCollisionAliasCount}`,
    'Launch:',
    ...(!status.effectiveBehavior.enabled
      ? ['  pi       # native Pi behavior (Bazframe disabled by effective policy)']
      : runtimeReady
        ? [
            '  pi       # native Pi context + active profile',
            '  pi -nc   # global Pi context + active profile'
          ]
        : ['  Complete the corrective actions below.']),
    'Corrective actions:',
    ...(status.correctiveActions.length === 0
      ? ['  (none)']
      : status.correctiveActions.map((correction) => `  - ${correction.message}`)),
    ''
  ];
  return lines.join('\n');
}

export function statusExitStatus(status: StatusInspection): number {
  return status.correctiveActions.length === 0
    ? EXIT_STATUS.success
    : EXIT_STATUS.attention;
}

export async function buildStatus(options: StatusOptions): Promise<StatusResult> {
  const status = await inspectStatus(options);
  return {
    exitStatus: statusExitStatus(status),
    text: formatStatus(status)
  };
}

function adapterCorrection(state: PiAdapterInstallState, targetPath: string): string {
  switch (state) {
    case 'missing':
    case 'adoptable':
    case 'managed-outdated':
    case 'managed-missing':
      return 'Install or update the adapter with `bazframe adapter install pi`.';
    case 'drifted':
      return 'Review the changed artifact, then restore it with `bazframe adapter install pi --force`.';
    case 'occupied':
      return `Resolve the independently owned destination at ${targetPath}, then run \`bazframe adapter install pi\`.`;
    case 'manifest-path-mismatch':
      return 'Use the Pi agent directory recorded by the ownership manifest or uninstall it there before changing PI_CODING_AGENT_DIR.';
    case 'current':
      throw new BazframeError('STATUS_INTERNAL_ERROR', 'Current adapter needs no correction.');
  }
}

async function countAliasCache(bazframeHome: string): Promise<number> {
  const root = join(bazframeHome, 'adapter-cache', 'pi', 'skill-aliases');
  if (!await physicalDirectoryExists(root)) return 0;

  let count = 0;
  for (const profile of await readdir(root)) {
    const profilePath = join(root, profile);
    await assertPhysicalDirectory(profilePath);
    for (const alias of await readdir(profilePath)) {
      const aliasPath = join(profilePath, alias);
      await assertPhysicalDirectory(aliasPath);
      const skillPath = join(aliasPath, 'SKILL.md');
      let metadata;
      try {
        metadata = await lstat(skillPath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new BazframeError(
          'ALIAS_CACHE_INVALID',
          `Cached skill alias must be a physical file: ${skillPath}`
        );
      }
      count += 1;
    }
  }
  return count;
}

async function physicalDirectoryExists(path: string): Promise<boolean> {
  try {
    await assertPhysicalDirectory(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function assertPhysicalDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError(
      'ALIAS_CACHE_INVALID',
      `Alias cache path must be a physical directory: ${path}`
    );
  }
}
