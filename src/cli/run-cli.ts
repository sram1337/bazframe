import { tmpdir } from 'node:os';
import { buildPiArgs } from '../agents/pi-args.js';
import { childExitStatus, spawnPi } from '../agents/spawn-pi.js';
import { EXIT_STATUS } from '../core/exit-status.js';
import { composeInstructions } from '../harness/compose-instructions.js';
import { createTemporaryInstructionFile } from '../harness/temporary-instructions.js';
import {
  loadProfile,
  readActiveProfile,
  resolveBazframeHome,
  writeActiveProfile
} from '../profiles/profile-store.js';
import { findGitRoot } from '../project/git-root.js';
import { loadRootRepositoryInstructions } from '../project/repository-instructions.js';
import { PI_HELP, ROOT_HELP, USE_HELP, VERSION } from './help.js';
import { parseArgv, type Command, type HelpTopic } from './parse-argv.js';

export interface CliDependencies {
  cwd?: () => string;
  environment?: NodeJS.ProcessEnv;
  temporaryRoot?: string;
  piExecutable?: string;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {}
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  const parsed = parseArgv(argv);

  if (parsed.kind === 'help') {
    writeStdout(helpFor(parsed.topic));
    return EXIT_STATUS.success;
  }
  if (parsed.kind === 'version') {
    writeStdout(`Bazframe 2 prototype ${VERSION}\n`);
    return EXIT_STATUS.success;
  }
  if (parsed.kind === 'usage-error') {
    writeStderr(`error: ${parsed.message}\n\n${ROOT_HELP}`);
    return EXIT_STATUS.usage;
  }

  try {
    return await runCommand(
      parsed.command,
      dependencies,
      writeStdout,
      writeStderr
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`error: ${message}\n`);
    return EXIT_STATUS.failure;
  }
}

async function runCommand(
  command: Command,
  dependencies: CliDependencies,
  writeStdout: (text: string) => void,
  writeStderr: (text: string) => void
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const bazframeHome = resolveBazframeHome(environment);
  if (command.name === 'use') {
    const profile = await loadProfile(bazframeHome, command.profileId);
    await writeActiveProfile(bazframeHome, command.profileId);
    writeStdout([
      `Active profile: ${profile.id}`,
      `Profile directory: ${profile.directory}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }

  const cwd = (dependencies.cwd ?? process.cwd)();
  const profileId = await readActiveProfile(bazframeHome);
  const profile = await loadProfile(bazframeHome, profileId);
  const repositoryRoot = await findGitRoot(cwd, environment);
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
    case 'use': return USE_HELP;
    case 'pi': return PI_HELP;
  }
}
