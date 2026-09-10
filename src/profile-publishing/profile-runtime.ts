import { executableEnvironmentValue } from '../core/executable-resolution.js';
import type { ProfileGithubGitEffects } from './profile-github-git.js';
import type { ProfileLifecycleServices } from './profile-lifecycle-services.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { BazframeError } from '../core/errors.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { requireProfileGithubAuthentication } from './profile-github.js';
import { createProfileGithubIsolation, createResolvedProfileGithubProcess, type ProfileGithubInteractionMode, type ProfileGithubProcess } from './profile-github-process.js';
import type { ProfileLifecycleGitAdapter } from './profile-lifecycle.js';
import { createProductionProfileGithubTransportAdapter, createPublicProfileGithubTransportAdapter, type ProductionProfileGithubTransportAdapter } from './profile-github-transport.js';
import { noProfileLifecycleMutationEffects, type ProfileLifecycleMutationEffects } from './profile-lifecycle-effects.js';
import { recoverProfilePublishingTransactions, type ProfileRecoveryResult } from './profile-recovery.js';

export type ProfileLifecycleRuntimeMode = 'human' | 'json' | 'dry-run';

export interface ProfileLifecycleRuntimeSession {
  lifecycle: { git: ProfileLifecycleGitAdapter };
  publication?: ProductionProfileGithubTransportAdapter;
  recovery: ProfileRecoveryResult[];
  effects: ProfileLifecycleMutationEffects;
  workspaceParent: string;
}

export interface ProfileLifecycleRuntimeOptions {
  home: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  mode: ProfileLifecycleRuntimeMode;
  access?: 'authenticated' | 'public-read' | 'import';
  temporaryRoot?: string;
  process?: ProfileGithubProcess;
  transport?: ProductionProfileGithubTransportAdapter;
  authenticate?: typeof requireProfileGithubAuthentication;
  recover?: typeof recoverProfilePublishingTransactions;
  readOnly?: boolean;
  recoveryServices?: ProfileLifecycleServices;
  filesystem?: {
    platform?: NodeJS.Platform;
    joinPath(...parts: string[]): string;
    createWorkspaceParent(home: string, temporaryRoot: string | undefined, temporary: boolean): Promise<string>;
    createIsolation: typeof createProfileGithubIsolation;
    disposeWorkspaceParent?(parent: string): Promise<void>;
    homeExists?(home: string): Promise<boolean>;
    gitEffects: ProfileGithubGitEffects;
  };
}

/**
 * Creates one production GitHub transport and runs startup recovery before a
 * mutating lifecycle callback. Dry-run uses a private OS-temporary retained
 * workspace, never recovers/mutates Bazframe state, and never starts login.
 */
export async function withProductionProfileLifecycleRuntime<T>(
  options: ProfileLifecycleRuntimeOptions,
  run: (session: ProfileLifecycleRuntimeSession) => Promise<T>
): Promise<{ value: T; effects: ProfileLifecycleMutationEffects }> {
  const environment = { ...(options.environment ?? process.env) };
  const ghConfigDirectory = githubConfigDirectory(environment, options.filesystem?.joinPath, options.filesystem?.platform);
  const dryRun = options.mode === 'dry-run' || options.readOnly === true;
  const workspaceParent = options.filesystem !== undefined ? await options.filesystem.createWorkspaceParent(options.home, options.temporaryRoot, dryRun) : dryRun
    ? await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'bazframe-profile-dry-run-'))
    : join(options.home, 'profile-publishing', 'github-workspaces');
  if (!dryRun && options.filesystem === undefined) await ensureManagedDirectory(options.home, workspaceParent);
  const isolation = await (options.filesystem?.createIsolation ?? createProfileGithubIsolation)(
    workspaceParent,
    environment,
    ghConfigDirectory
  ).catch(async (error: unknown) => {
    try { await options.filesystem?.disposeWorkspaceParent?.(workspaceParent); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Profile runtime isolation and temporary ownership proof both failed.', { cause: cleanup }); }
    throw error;
  });
  const processBoundary = options.process ?? createResolvedProfileGithubProcess({ cwd: options.cwd, environment, platform: options.filesystem?.platform, excludedRoots: [workspaceParent] });
  let operationError: unknown;
  let result: { value: T; effects: ProfileLifecycleMutationEffects } | undefined;
  try {
    const access = options.access ?? 'authenticated';
    let authenticatedTransport: ProductionProfileGithubTransportAdapter | undefined;
    let loginStarted = false;
    const ensureAuthenticated = async (): Promise<ProductionProfileGithubTransportAdapter> => {
      if (authenticatedTransport !== undefined) return authenticatedTransport;
      const authentication = await (options.authenticate ?? requireProfileGithubAuthentication)(
        { process: processBoundary, isolation, cwd: options.cwd },
        interactionMode(options.readOnly === true ? 'dry-run' : options.mode)
      );
      loginStarted ||= authentication.loginStarted;
      if (options.mode !== 'human' && loginStarted) {
        throw new BazframeError('PROFILE_GITHUB_AUTH_REQUIRED', 'JSON and dry-run modes never start GitHub login.');
      }
      authenticatedTransport = options.transport ?? createProductionProfileGithubTransportAdapter({
        process: processBoundary,
        isolation,
        cwd: options.cwd,
        quarantineParent: workspaceParent,
        authenticated: true,
        effects: options.filesystem?.gitEffects
      });
      return authenticatedTransport;
    };
    if (access === 'authenticated') await ensureAuthenticated();
    const publicGit = createPublicProfileGithubTransportAdapter({ process: processBoundary, isolation, cwd: options.cwd, quarantineParent: workspaceParent, effects: options.filesystem?.gitEffects });
    const importGit: ProfileLifecycleGitAdapter = {
      inspect: async (source, revision) => {
        try { return await publicGit.inspect(source, revision); }
        catch (error) {
          if (!(error instanceof BazframeError) || error.code !== 'PROFILE_GITHUB_MAIN_UNAVAILABLE') throw error;
          return (await ensureAuthenticated()).inspect(source, revision);
        }
      },
      list: async (source) => {
        try { return await publicGit.list(source); }
        catch (error) {
          if (!(error instanceof BazframeError) || error.code !== 'PROFILE_GITHUB_MAIN_UNAVAILABLE') throw error;
          return (await ensureAuthenticated()).list(source);
        }
      }
    };
    let recovery: ProfileRecoveryResult[] = [];
    if (!dryRun && (await options.filesystem?.homeExists?.(options.home) ?? true)) {
      try { recovery = await (options.recover ?? recoverProfilePublishingTransactions)(options.home, authenticatedTransport, options.recoveryServices); }
      catch (error) {
        if (!(error instanceof BazframeError) || error.code !== 'PROFILE_RECOVERY_ADAPTER_REQUIRED') throw error;
        recovery = await (options.recover ?? recoverProfilePublishingTransactions)(options.home, await ensureAuthenticated(), options.recoveryServices);
      }
    }
    const git = access === 'authenticated' ? authenticatedTransport! : access === 'import' ? importGit : publicGit;
    const effects = noProfileLifecycleMutationEffects();
    Object.defineProperty(effects, 'loginStarted', { enumerable: true, get: () => loginStarted });
    const value = await run({ lifecycle: { git }, ...(authenticatedTransport === undefined ? {} : { publication: authenticatedTransport }), recovery, effects, workspaceParent });
    result = { value, effects: { ...effects, loginStarted } };
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors: unknown[] = [];
  try { await isolation.dispose(); } catch (error) { cleanupErrors.push(error); }
  try { await options.filesystem?.disposeWorkspaceParent?.(workspaceParent); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length > 0) {
    if (operationError !== undefined) throw new AggregateError([operationError, ...cleanupErrors], 'Profile runtime operation and retained isolation proof both failed.', { cause: cleanupErrors[0] });
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    throw new AggregateError(cleanupErrors, 'Profile runtime retained ownership proofs failed.', { cause: cleanupErrors[0] });
  }
  if (operationError !== undefined) throw operationError;
  return result!;
}

/** Resolve incoming gh configuration before replacing HOME/XDG in isolation; never read or create it. */
export function githubConfigDirectory(environment: NodeJS.ProcessEnv, pathJoin = join, platform = process.platform): string | undefined {
  if (platform !== 'win32') {
    if (environment.GH_CONFIG_DIR !== undefined) return environment.GH_CONFIG_DIR;
    if (environment.XDG_CONFIG_HOME !== undefined) return pathJoin(environment.XDG_CONFIG_HOME, 'gh');
    return environment.HOME === undefined ? undefined : pathJoin(environment.HOME, '.config', 'gh');
  }
  // gh help environment: GH_CONFIG_DIR > XDG_CONFIG_HOME/gh > AppData/GitHub CLI > HOME/.config/gh.
  // USERPROFILE is deliberately not an additional, guessed fallback.
  const value = (key: string) => executableEnvironmentValue(environment, key, true);
  let result = value('GH_CONFIG_DIR');
  if (result === undefined) { const xdg = value('XDG_CONFIG_HOME'); if (xdg !== undefined) result = win32.join(xdg, 'gh'); }
  if (result === undefined) { const appData = value('APPDATA'); if (appData !== undefined) result = win32.join(appData, 'GitHub CLI'); }
  if (result === undefined) { const home = value('HOME'); if (home !== undefined) result = win32.join(home, '.config', 'gh'); }
  if (result !== undefined && (!/^[a-z]:[\\/]/iu.test(result) || !win32.isAbsolute(result) || result.includes('\0'))) throw new BazframeError('PROFILE_GITHUB_PROCESS_INVALID', 'GitHub configuration directory must be an absolute local Windows path.');
  return result;
}

function interactionMode(mode: ProfileLifecycleRuntimeMode): ProfileGithubInteractionMode {
  return mode;
}
