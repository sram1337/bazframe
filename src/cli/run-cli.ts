import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import {
  inspectPiAdapter,
  installPiAdapter,
  uninstallPiAdapter
} from '../adapters/pi/installer.js';
import { buildPiArgs } from '../agents/pi-args.js';
import { childExitStatus, spawnPi } from '../agents/spawn-pi.js';
import { BazframeError } from '../core/errors.js';
import { EXIT_STATUS } from '../core/exit-status.js';
import { composeInstructions } from '../harness/compose-instructions.js';
import { createTemporaryInstructionFile } from '../harness/temporary-instructions.js';
import { resolveEffectivePolicy } from '../policy/effective-policy.js';
import {
  disableGlobally,
  enableGlobally,
  globalPolicyPath,
  readGlobalPolicy,
  type GlobalPolicy
} from '../policy/global-policy.js';
import {
  addProfile,
  currentProfile,
  duplicateProfile,
  listProfiles,
  removeProfile,
  renameProfile,
  type ProfileDuplicateResult,
  type ProfileLifecycleResult,
  type ProfileRenameResult
} from '../profiles/profile-management.js';
import {
  addActiveProfileSkill,
  addProfileSkill,
  removeActiveProfileSkill,
  removeProfileSkill,
  type ProfileSkillMembershipResult
} from '../profiles/profile-skill-membership.js';
import {
  loadProfile,
  readActiveProfile,
  resolveBazframeHome,
  selectProfile
} from '../profiles/profile-store.js';
import { findGitRoot } from '../project/git-root.js';
import {
  disableRepository,
  enableRepository,
  listRepositoryProjectStates,
  readRepositoryProjectState
} from '../project/registration-store.js';
import type { RepositoryProjectState } from '../project/registration.js';
import { loadRootRepositoryInstructions } from '../project/repository-instructions.js';
import { listAvailableSkills } from '../skills/skill-library.js';
import { buildStatus } from '../status/status.js';
import {
  colorizeHelp,
  colorizeStatus,
  createCliColors,
  shouldUseColor,
  type CliColors
} from './color.js';
import {
  ADAPTER_HELP,
  ADD_HELP,
  GLOBAL_HELP,
  PI_HELP,
  PROFILE_ADD_HELP,
  PROFILE_CURRENT_HELP,
  PROFILE_DUPLICATE_HELP,
  PROFILE_HELP,
  PROFILE_LIST_HELP,
  PROFILE_REMOVE_HELP,
  PROFILE_RENAME_HELP,
  PROFILE_SKILLS_ADD_HELP,
  PROFILE_SKILLS_HELP,
  PROFILE_SKILLS_REMOVE_HELP,
  PROFILE_USE_HELP,
  PROJECT_HELP,
  REMOVE_HELP,
  ROOT_HELP,
  SKILLS_HELP,
  STATUS_HELP,
  TUI_HELP,
  USE_HELP,
  VERSION
} from './help.js';
import { parseArgv, type Command, type HelpTopic } from './parse-argv.js';

export interface CliDependencies {
  cwd?: () => string;
  environment?: NodeJS.ProcessEnv;
  temporaryRoot?: string;
  piExecutable?: string;
  userHome?: string;
  adapterArtifactUrl?: URL;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
  stderrIsTty?: boolean;
  terminateProcess?: (status: number) => void;
  launchTui?: (options: {
    bazframeHome: string;
    bazframeVersion: string;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    userHome?: string;
    adapterArtifactUrl?: URL;
    stdin: NodeJS.ReadStream;
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
    terminateProcess: (status: number) => void;
  }) => Promise<number>;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {}
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  const environment = dependencies.environment ?? process.env;
  const stdoutColors = createCliColors(shouldUseColor(
    environment,
    dependencies.stdoutIsTty ?? process.stdout.isTTY === true
  ));
  const stderrColors = createCliColors(shouldUseColor(
    environment,
    dependencies.stderrIsTty ?? process.stderr.isTTY === true
  ));
  const parsed = parseArgv(argv);

  if (parsed.kind === 'help') {
    writeStdout(colorizeHelp(helpFor(parsed.topic), stdoutColors));
    return EXIT_STATUS.success;
  }
  if (parsed.kind === 'version') {
    writeStdout(`Bazframe 2 prototype ${VERSION}\n`);
    return EXIT_STATUS.success;
  }
  if (parsed.kind === 'usage-error') {
    writeStderr(
      `${stderrColors.error('error:')} ${parsed.message}\n\n${colorizeHelp(helpFor(parsed.topic), stderrColors)}`
    );
    return EXIT_STATUS.usage;
  }

  try {
    return await runCommand(
      parsed.command,
      dependencies,
      writeStdout,
      writeStderr,
      stdoutColors,
      stderrColors
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`${stderrColors.error('error:')} ${message}\n`);
    return EXIT_STATUS.failure;
  }
}

async function runCommand(
  command: Command,
  dependencies: CliDependencies,
  writeStdout: (text: string) => void,
  writeStderr: (text: string) => void,
  stdoutColors: CliColors,
  stderrColors: CliColors
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  if (command.name === 'tui') {
    const stdinIsTty = dependencies.stdinIsTty ?? process.stdin.isTTY === true;
    const stdoutIsTty = dependencies.stdoutIsTty ?? process.stdout.isTTY === true;
    if (!stdinIsTty || !stdoutIsTty) {
      writeStderr(
        'error: `bazframe tui` requires interactive stdin and stdout. Use `bazframe profiles` and `bazframe skills` in non-interactive environments.\n'
      );
      return EXIT_STATUS.failure;
    }
    const launchTui = dependencies.launchTui ?? (async (options) => {
      const { runTui } = await import('../tui/run-tui.js');
      return runTui(options);
    });
    return launchTui({
      bazframeHome: resolveBazframeHome(environment, dependencies.userHome),
      bazframeVersion: VERSION,
      cwd: (dependencies.cwd ?? process.cwd)(),
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { adapterArtifactUrl: dependencies.adapterArtifactUrl }),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      terminateProcess: dependencies.terminateProcess ?? ((status) => process.exit(status))
    });
  }

  const bazframeHome = resolveBazframeHome(environment, dependencies.userHome);
  if (command.name === 'adapters-overview') {
    const adapter = await inspectPiAdapter({
      bazframeHome,
      bazframeVersion: VERSION,
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { artifactUrl: dependencies.adapterArtifactUrl })
    });
    writeStdout(formatAdaptersOverview(adapter.state, adapter.targetPath, stdoutColors));
    return EXIT_STATUS.success;
  }
  if (command.name === 'adapter-install-pi') {
    const result = await installPiAdapter({
      bazframeHome,
      bazframeVersion: VERSION,
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { artifactUrl: dependencies.adapterArtifactUrl })
    }, command.force);
    writeStdout([
      `Pi adapter: ${result.action}`,
      `Extension: ${result.targetPath}`,
      `Ownership manifest: ${result.manifestPath}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'adapter-uninstall-pi') {
    const result = await uninstallPiAdapter({
      bazframeHome,
      bazframeVersion: VERSION,
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { artifactUrl: dependencies.adapterArtifactUrl })
    });
    writeStdout([
      `Pi adapter: ${result.action}`,
      `Extension: ${result.targetPath}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profiles-overview') {
    const result = await listProfiles(bazframeHome);
    let activeProfile: string | undefined;
    try {
      activeProfile = await currentProfile(bazframeHome);
    } catch (error) {
      if (!(error instanceof BazframeError && error.code === 'NO_ACTIVE_PROFILE')) throw error;
    }
    writeStdout(formatProfilesOverview(result.profileIds, activeProfile, stdoutColors));
    for (const diagnostic of result.diagnostics) {
      writeStderr(`${stderrColors.warning('warning:')} ${diagnostic}\n`);
    }
    return EXIT_STATUS.success;
  }
  if (command.name === 'skills-overview') {
    const result = await listAvailableSkills({
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome })
    });
    writeStdout(formatSkillsOverview(result.skillsRoot, result.skillIds, stdoutColors));
    for (const diagnostic of result.diagnostics) {
      writeStderr(`${stderrColors.warning('warning:')} ${diagnostic}\n`);
    }
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-skills-overview') {
    const profileId = await readActiveProfile(bazframeHome);
    const profile = await loadProfile(bazframeHome, profileId);
    writeStdout(formatProfileSkillsOverview(
      profileId,
      profile.skillDirectories.map((directory) => basename(directory)),
      stdoutColors
    ));
    return EXIT_STATUS.success;
  }
  if (command.name === 'use' || command.name === 'profile-use') {
    const profile = await selectProfile(bazframeHome, command.profileId);
    writeStdout([
      `Active profile: ${profile.id}`,
      `Profile directory: ${profile.directory}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-add') {
    writeStdout(formatProfileLifecycle(await addProfile(bazframeHome, command.profileId)));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-duplicate') {
    writeStdout(formatProfileDuplicate(await duplicateProfile(
      bazframeHome,
      command.sourceProfileId,
      command.profileId
    )));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-remove') {
    writeStdout(formatProfileLifecycle(
      await removeProfile(bazframeHome, command.profileId, command.force)
    ));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-rename') {
    writeStdout(formatProfileRename(await renameProfile(
      bazframeHome,
      command.previousProfileId,
      command.profileId
    )));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-list') {
    const result = await listProfiles(bazframeHome);
    if (result.profileIds.length > 0) writeStdout(`${result.profileIds.join('\n')}\n`);
    for (const diagnostic of result.diagnostics) {
      writeStderr(`${stderrColors.warning('warning:')} ${diagnostic}\n`);
    }
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-current') {
    writeStdout(`${await currentProfile(bazframeHome)}\n`);
    return EXIT_STATUS.success;
  }
  if (command.name === 'add' || command.name === 'remove') {
    const options = {
      bazframeHome,
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome })
    };
    const result = command.profileId === undefined
      ? command.name === 'add'
        ? await addActiveProfileSkill(options, command.skillId)
        : await removeActiveProfileSkill(options, command.skillId)
      : command.name === 'add'
        ? await addProfileSkill(options, command.profileId, command.skillId)
        : await removeProfileSkill(options, command.profileId, command.skillId);
    writeStdout(formatMembershipResult(result, command.profileId !== undefined));
    return EXIT_STATUS.success;
  }
  if (command.name === 'global-overview') {
    const policy = await readGlobalPolicy(bazframeHome);
    writeStdout(formatGlobalOverview(policy, globalPolicyPath(bazframeHome), stdoutColors));
    return EXIT_STATUS.success;
  }
  if (command.name === 'global-disable') {
    const action = await disableGlobally(bazframeHome);
    writeStdout([
      `Global policy: disabled`,
      `Policy state: ${action}`,
      `State file: ${globalPolicyPath(bazframeHome)}`,
      'Project enabled overrides still take precedence.',
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'global-enable') {
    await validateRuntimeReady(bazframeHome, environment, dependencies);
    const action = await enableGlobally(bazframeHome);
    writeStdout([
      'Global policy: enabled',
      `Policy state: ${action}`,
      'State file: none (enabled is the default)',
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }

  const cwd = (dependencies.cwd ?? process.cwd)();
  if (command.name === 'projects-overview') {
    const result = await listRepositoryProjectStates(bazframeHome);
    const globalPolicy = await readGlobalPolicy(bazframeHome);
    let currentWorktree: string | undefined;
    let currentProjectState: RepositoryProjectState | undefined;
    try {
      currentWorktree = await findGitRoot(cwd, environment);
      currentProjectState = await readRepositoryProjectState(bazframeHome, currentWorktree);
    } catch (error) {
      if (!(error instanceof BazframeError && error.code === 'NOT_GIT_WORKTREE')) throw error;
    }
    writeStdout(formatProjectsOverview(
      result.projectStates,
      currentWorktree,
      currentProjectState,
      globalPolicy,
      stdoutColors
    ));
    for (const diagnostic of result.diagnostics) {
      writeStderr(`${stderrColors.warning('warning:')} ${diagnostic}\n`);
    }
    return EXIT_STATUS.success;
  }
  if (command.name === 'status') {
    const status = await buildStatus({
      bazframeHome,
      bazframeVersion: VERSION,
      environment,
      cwd,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { artifactUrl: dependencies.adapterArtifactUrl })
    });
    writeStdout(colorizeStatus(status.text, stdoutColors));
    return status.exitStatus;
  }
  if (command.name === 'project-disable') {
    const repositoryRoot = await findGitRoot(cwd, environment);
    const result = await disableRepository(bazframeHome, repositoryRoot);
    writeStdout([
      'Project policy: disabled',
      `Project state: ${result.action}`,
      `Repository: ${repositoryRoot}`,
      `Global policy: ${result.globalPolicy}`,
      `Precedence: ${result.globalPolicy === 'disabled' ? 'inherits global disabled policy' : 'disabled project override'}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'project-enable') {
    const repositoryRoot = await findGitRoot(cwd, environment);
    const profileId = await validateRuntimeReady(bazframeHome, environment, dependencies);
    const result = await enableRepository(bazframeHome, repositoryRoot);
    writeStdout([
      'Project policy: enabled',
      `Project state: ${result.action}`,
      `Repository: ${repositoryRoot}`,
      `Global policy: ${result.globalPolicy}`,
      `Precedence: ${result.globalPolicy === 'disabled' ? 'enabled project override' : 'inherits global enabled policy'}`,
      `Profile selection: active (${profileId})`,
      'Run `pi` for native context plus the profile.',
      'Run `pi -nc` for global Pi context plus the profile.',
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }

  const repositoryRoot = await findGitRoot(cwd, environment);
  const globalPolicy = await readGlobalPolicy(bazframeHome);
  const projectState = await readRepositoryProjectState(bazframeHome, repositoryRoot);
  const effectivePolicy = resolveEffectivePolicy(globalPolicy, projectState);
  if (!effectivePolicy.enabled) {
    throw new Error(
      `Bazframe is disabled for this worktree (${effectivePolicy.reason}). Invoke \`pi\` directly, or run \`bazframe project enable\` first.`
    );
  }
  const profileId = await readActiveProfile(bazframeHome);
  const profile = await loadProfile(bazframeHome, profileId);
  const repositoryInstructions = await loadRootRepositoryInstructions(repositoryRoot);
  const effectiveInstructions = composeInstructions({
    profileId,
    profile: { path: profile.instructionsPath, text: profile.instructions },
    ...(repositoryInstructions === undefined
      ? {}
      : { repository: repositoryInstructions })
  });

  const summary = formatHarnessSummary(
    command.dryRun,
    profile.id,
    repositoryRoot,
    cwd,
    profile.instructionsPath,
    repositoryInstructions?.path,
    profile.skillDirectories
  );

  if (command.dryRun) {
    const conceptualPath = '<temporary .baz.agents.md outside repository>';
    const conceptualArgs = buildPiArgs(
      conceptualPath,
      profile.skillDirectories,
      command.forwardedArgs
    );
    writeStdout([
      summary,
      '--- effective instructions ---',
      effectiveInstructions,
      '--- end effective instructions ---',
      '',
      `Would launch executable: ${dependencies.piExecutable ?? 'pi'}`,
      'Would launch argv:',
      ...conceptualArgs.map((argument) => `  - ${JSON.stringify(argument)}`),
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }

  const temporary = await createTemporaryInstructionFile(
    effectiveInstructions,
    repositoryRoot,
    dependencies.temporaryRoot ?? tmpdir()
  );
  try {
    const piArgs = buildPiArgs(
      temporary.path,
      profile.skillDirectories,
      command.forwardedArgs
    );
    writeStderr([
      summary,
      `Effective instructions file: ${temporary.path}`,
      'Launching Pi...',
      ''
    ].join('\n'));
    const child = await spawnPi(
      piArgs,
      cwd,
      environment,
      dependencies.piExecutable ?? 'pi'
    );
    return childExitStatus(child);
  } finally {
    await temporary.cleanup();
  }
}

async function validateRuntimeReady(
  bazframeHome: string,
  environment: NodeJS.ProcessEnv,
  dependencies: CliDependencies
): Promise<string> {
  const adapter = await inspectPiAdapter({
    bazframeHome,
    bazframeVersion: VERSION,
    environment,
    ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
    ...(dependencies.adapterArtifactUrl === undefined
      ? {}
      : { artifactUrl: dependencies.adapterArtifactUrl })
  });
  if (adapter.state !== 'current') {
    throw new Error(
      `Pi adapter state is ${adapter.state}. Run \`bazframe adapter install pi\`, then retry.`
    );
  }
  const profileId = await readActiveProfile(bazframeHome);
  await loadProfile(bazframeHome, profileId);
  return profileId;
}

function formatGlobalOverview(
  policy: GlobalPolicy,
  path: string,
  colors: CliColors
): string {
  return [
    colors.heading('Global policy'),
    policy === 'enabled'
      ? colors.success('  enabled (default; no state file)')
      : colors.warning('  disabled'),
    `State: ${policy === 'enabled' ? '(none)' : path}`,
    'Project overrides take precedence.',
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe global enable'),
    colors.command('  bazframe global disable'),
    ''
  ].join('\n');
}

function formatProfilesOverview(
  profileIds: readonly string[],
  activeProfile: string | undefined,
  colors: CliColors
): string {
  const activeAvailable = activeProfile !== undefined && profileIds.includes(activeProfile);
  const activeSummary = `Active profile: ${activeProfile === undefined
    ? '(none)'
    : `${activeProfile}${activeAvailable ? '' : ' (unavailable)'}`}`;
  return [
    colors.heading('Profiles'),
    ...(profileIds.length === 0
      ? [colors.muted('  (none)')]
      : profileIds.map((profileId) => profileId === activeProfile
        ? colors.success(`  * ${profileId} (active)`)
        : `  - ${profileId}`)),
    activeAvailable ? colors.success(activeSummary) : colors.warning(activeSummary),
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe profile add <profile>'),
    colors.command('  bazframe profile duplicate <source> <new>'),
    colors.command('  bazframe profile use <profile>'),
    colors.command('  bazframe profile rename <old> <new>'),
    colors.command('  bazframe profile remove <profile> [--force]'),
    colors.command('  bazframe profile skills'),
    colors.command('  bazframe profile list'),
    colors.command('  bazframe profile current'),
    ''
  ].join('\n');
}

function formatSkillsOverview(
  skillsRoot: string,
  skillIds: readonly string[],
  colors: CliColors
): string {
  return [
    colors.heading('Skills'),
    `Source: ${skillsRoot}`,
    ...(skillIds.length === 0
      ? [colors.muted('  (none)')]
      : skillIds.map((skillId) => `  - ${skillId}`)),
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe profile skills'),
    colors.command('  bazframe profile skills add <skill> [--profile <profile>]'),
    colors.command('  bazframe profile skills remove <skill> [--profile <profile>]'),
    ''
  ].join('\n');
}

function formatProfileSkillsOverview(
  profileId: string,
  skillIds: readonly string[],
  colors: CliColors
): string {
  return [
    colors.heading('Profile skills'),
    colors.success(`Active profile: ${profileId}`),
    ...(skillIds.length === 0
      ? [colors.muted('  (none)')]
      : skillIds.map((skillId) => `  - ${skillId}`)),
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe profile skills add <skill> [--profile <profile>]'),
    colors.command('  bazframe profile skills remove <skill> [--profile <profile>]'),
    ''
  ].join('\n');
}

function formatProjectsOverview(
  projectStates: readonly RepositoryProjectState[],
  currentWorktree: string | undefined,
  currentProjectState: RepositoryProjectState | undefined,
  globalPolicy: GlobalPolicy,
  colors: CliColors
): string {
  const effective = currentWorktree === undefined
    ? undefined
    : resolveEffectivePolicy(globalPolicy, currentProjectState);
  const currentBehavior = currentWorktree === undefined
    ? '(outside a Git worktree)'
    : `${currentWorktree} (${effective?.enabled === true ? 'enabled' : 'disabled'}; ${effective?.reason})`;
  return [
    colors.heading('Project overrides'),
    `Global policy: ${globalPolicy}`,
    ...(projectStates.length === 0
      ? [colors.muted('  (none)')]
      : projectStates.map((projectState) => {
          const description = projectState.schemaVersion === 3
            ? 'enabled override'
            : projectState.schemaVersion === 2
              ? 'disabled override'
              : 'legacy redundant inherit record';
          const line = `  ${projectState.repository === currentWorktree ? '*' : '-'} ${projectState.repository} (${description})`;
          return projectState.repository === currentWorktree
            ? effective?.enabled === true ? colors.success(line) : colors.warning(line)
            : line;
        })),
    currentWorktree === undefined
      ? colors.muted(`Current worktree: ${currentBehavior}`)
      : effective?.enabled === true
        ? colors.success(`Current worktree: ${currentBehavior}`)
        : colors.warning(`Current worktree: ${currentBehavior}`),
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe project enable'),
    colors.command('  bazframe project disable'),
    ''
  ].join('\n');
}

function formatAdaptersOverview(
  state: string,
  targetPath: string,
  colors: CliColors
): string {
  const adapter = `  - pi (${state})`;
  return [
    colors.heading('Adapters'),
    state === 'current' ? colors.success(adapter) : colors.warning(adapter),
    `Extension: ${targetPath}`,
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe adapter install pi [--force]'),
    colors.command('  bazframe adapter uninstall pi'),
    ''
  ].join('\n');
}

function formatProfileLifecycle(result: ProfileLifecycleResult<string>): string {
  return [
    `Profile lifecycle: ${result.action}`,
    `Profile: ${result.profileId}`,
    `Profile directory: ${result.directory}`,
    ''
  ].join('\n');
}

function formatProfileDuplicate(result: ProfileDuplicateResult): string {
  return [
    `Profile lifecycle: ${result.action}`,
    `Source profile: ${result.sourceProfileId}`,
    `Profile: ${result.profileId}`,
    `Profile directory: ${result.directory}`,
    'Active selection updated: no',
    ''
  ].join('\n');
}

function formatProfileRename(result: ProfileRenameResult): string {
  return [
    `Profile lifecycle: ${result.action}`,
    `Previous profile: ${result.previousProfileId}`,
    `Profile: ${result.profileId}`,
    `Profile directory: ${result.directory}`,
    `Active selection updated: ${result.activeSelectionUpdated ? 'yes' : 'no'}`,
    ''
  ].join('\n');
}

function formatMembershipResult(
  result: ProfileSkillMembershipResult,
  explicitlyTargeted = false
): string {
  return [
    `Profile skill membership: ${result.action}`,
    `${explicitlyTargeted ? 'Profile' : 'Active profile'}: ${result.profileId}`,
    `Skill: ${result.skillId}`,
    `Source: ${result.sourceDirectory}`,
    `Membership: ${result.membershipPath}`,
    ''
  ].join('\n');
}

function formatHarnessSummary(
  dryRun: boolean,
  profileId: string,
  repositoryRoot: string,
  cwd: string,
  profileInstructionsPath: string,
  repositoryInstructionsPath: string | undefined,
  skillDirectories: readonly string[]
): string {
  return [
    `Bazframe 2 experimental prototype${dryRun ? ' dry run' : ''}`,
    `Profile: ${profileId}`,
    `Repository: ${repositoryRoot}`,
    `Working directory: ${cwd}`,
    `Profile instructions: ${profileInstructionsPath}`,
    `Repository instructions: ${repositoryInstructionsPath ?? '(none)'}`,
    'Profile skills:',
    ...(skillDirectories.length === 0
      ? ['  (none)']
      : skillDirectories.map((path) => `  - ${path}`)),
    ''
  ].join('\n');
}

function helpFor(topic: HelpTopic): string {
  switch (topic) {
    case 'root': return ROOT_HELP;
    case 'adapter': return ADAPTER_HELP;
    case 'global': return GLOBAL_HELP;
    case 'status': return STATUS_HELP;
    case 'tui': return TUI_HELP;
    case 'use': return USE_HELP;
    case 'add': return ADD_HELP;
    case 'remove': return REMOVE_HELP;
    case 'profile': return PROFILE_HELP;
    case 'profile-add': return PROFILE_ADD_HELP;
    case 'profile-duplicate': return PROFILE_DUPLICATE_HELP;
    case 'profile-remove': return PROFILE_REMOVE_HELP;
    case 'profile-rename': return PROFILE_RENAME_HELP;
    case 'profile-use': return PROFILE_USE_HELP;
    case 'profile-list': return PROFILE_LIST_HELP;
    case 'profile-current': return PROFILE_CURRENT_HELP;
    case 'profile-skills': return PROFILE_SKILLS_HELP;
    case 'profile-skills-add': return PROFILE_SKILLS_ADD_HELP;
    case 'profile-skills-remove': return PROFILE_SKILLS_REMOVE_HELP;
    case 'skills': return SKILLS_HELP;
    case 'project': return PROJECT_HELP;
    case 'pi': return PI_HELP;
  }
}
