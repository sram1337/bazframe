import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BazframeError } from '../core/errors.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { requireProfileGithubAuthentication } from './profile-github.js';
import { createProfileGithubIsolation, defaultProfileGithubProcess, type ProfileGithubInteractionMode, type ProfileGithubProcess } from './profile-github-process.js';
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
  const dryRun = options.mode === 'dry-run';
  const workspaceParent = dryRun
    ? await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'bazframe-profile-dry-run-'))
    : join(options.home, 'profile-publishing', 'github-workspaces');
  if (!dryRun) await ensureManagedDirectory(options.home, workspaceParent);
  const isolation = await createProfileGithubIsolation(
    workspaceParent,
    environment,
    githubConfigDirectory(environment)
  );
  const processBoundary = options.process ?? defaultProfileGithubProcess;
  try {
    const access = options.access ?? 'authenticated';
    let authenticatedTransport: ProductionProfileGithubTransportAdapter | undefined;
    let loginStarted = false;
    const ensureAuthenticated = async (): Promise<ProductionProfileGithubTransportAdapter> => {
      if (authenticatedTransport !== undefined) return authenticatedTransport;
      const authentication = await (options.authenticate ?? requireProfileGithubAuthentication)(
        { process: processBoundary, isolation, cwd: options.cwd },
        interactionMode(options.mode)
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
        authenticated: true
      });
      return authenticatedTransport;
    };
    if (access === 'authenticated') await ensureAuthenticated();
    const publicGit = createPublicProfileGithubTransportAdapter({ process: processBoundary, isolation, cwd: options.cwd, quarantineParent: workspaceParent });
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
    if (!dryRun) {
      try { recovery = await (options.recover ?? recoverProfilePublishingTransactions)(options.home, authenticatedTransport); }
      catch (error) {
        if (!(error instanceof BazframeError) || error.code !== 'PROFILE_RECOVERY_ADAPTER_REQUIRED') throw error;
        recovery = await (options.recover ?? recoverProfilePublishingTransactions)(options.home, await ensureAuthenticated());
      }
    }
    const git = access === 'authenticated' ? authenticatedTransport! : access === 'import' ? importGit : publicGit;
    const effects = noProfileLifecycleMutationEffects();
    Object.defineProperty(effects, 'loginStarted', { enumerable: true, get: () => loginStarted });
    const value = await run({ lifecycle: { git }, ...(authenticatedTransport === undefined ? {} : { publication: authenticatedTransport }), recovery, effects, workspaceParent });
    return { value, effects: { ...effects, loginStarted } };
  } finally {
    await isolation.dispose();
  }
}

function githubConfigDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  if (environment.GH_CONFIG_DIR !== undefined) return environment.GH_CONFIG_DIR;
  if (environment.XDG_CONFIG_HOME !== undefined) return join(environment.XDG_CONFIG_HOME, 'gh');
  return environment.HOME === undefined ? undefined : join(environment.HOME, '.config', 'gh');
}

function interactionMode(mode: ProfileLifecycleRuntimeMode): ProfileGithubInteractionMode {
  return mode;
}
