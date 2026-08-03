import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectPiAdapter } from '../adapters/pi/installer.js';
import type { PiAdapterInstallState } from '../adapters/pi/ownership.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { EXIT_STATUS } from '../core/exit-status.js';
import { loadProfile, readActiveProfile } from '../profiles/profile-store.js';
import { findGitRoot } from '../project/git-root.js';
import { readRepositoryRegistration } from '../project/registration-store.js';
import { resolvePiAgentDirectory } from '../state/paths.js';

export interface StatusOptions {
  bazframeHome: string;
  bazframeVersion: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  userHome?: string;
  artifactUrl?: URL;
}

export interface StatusResult {
  exitStatus: number;
  text: string;
}

export async function buildStatus(options: StatusOptions): Promise<StatusResult> {
  const corrections = new Set<string>();
  let attention = false;
  const adapter = await inspectPiAdapter({
    bazframeHome: options.bazframeHome,
    bazframeVersion: options.bazframeVersion,
    environment: options.environment,
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    ...(options.artifactUrl === undefined ? {} : { artifactUrl: options.artifactUrl })
  });
  if (adapter.state !== 'current') {
    attention = true;
    corrections.add(adapterCorrection(adapter.state, adapter.targetPath));
  }

  let activeProfile = '(none)';
  let instructionSource = '(none)';
  let skillCount = 0;
  let profileReady = false;
  try {
    const profileId = await readActiveProfile(options.bazframeHome);
    activeProfile = profileId;
    try {
      const profile = await loadProfile(options.bazframeHome, profileId);
      instructionSource = profile.instructionsPath;
      skillCount = profile.skillDirectories.length;
      profileReady = true;
    } catch (error) {
      if (error instanceof BazframeError && error.code === 'PROFILE_NOT_FOUND') {
        attention = true;
        corrections.add('Select an existing profile with `bazframe use <profile>`.');
      } else {
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof BazframeError && error.code === 'NO_ACTIVE_PROFILE') {
      attention = true;
      corrections.add('Select a profile with `bazframe use <profile>`.');
    } else {
      throw error;
    }
  }

  let repository = '(outside a Git worktree)';
  let registration = 'not applicable';
  let registered = false;
  try {
    repository = await findGitRoot(options.cwd, options.environment);
    const record = await readRepositoryRegistration(options.bazframeHome, repository);
    if (record === undefined) {
      registration = 'unregistered';
      attention = true;
      corrections.add('Register this worktree with `bazframe init`.');
    } else {
      registration = 'registered (adaptive-context, active profile)';
      registered = true;
    }
  } catch (error) {
    if (!(error instanceof BazframeError && error.code === 'NOT_GIT_WORKTREE')) throw error;
  }

  const aliasCount = await countAliasCache(options.bazframeHome);
  const launchReady = adapter.state === 'current' && registered && profileReady;
  const lines = [
    'Bazframe status',
    `Bazframe home: ${options.bazframeHome}`,
    `Pi agent directory: ${resolvePiAgentDirectory(options.environment, options.userHome)}`,
    `Pi adapter: ${adapter.state}`,
    `Pi adapter version: ${adapter.manifest?.bazframeVersion ?? '(none)'}`,
    `Pi extension: ${adapter.targetPath}`,
    `Repository: ${repository}`,
    `Registration: ${registration}`,
    `Active profile: ${activeProfile}`,
    `Profile instructions: ${instructionSource}`,
    `Profile skills: ${skillCount}`,
    `Cached collision aliases: ${aliasCount}`,
    'Launch:',
    ...(launchReady
      ? [
          '  pi       # native Pi context + active profile',
          '  pi -nc   # global Pi context + active profile'
        ]
      : ['  Complete the corrective actions below.']),
    'Corrective actions:',
    ...(corrections.size === 0
      ? ['  (none)']
      : [...corrections].map((correction) => `  - ${correction}`)),
    ''
  ];
  return {
    exitStatus: attention ? EXIT_STATUS.attention : EXIT_STATUS.success,
    text: lines.join('\n')
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
