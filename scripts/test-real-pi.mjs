import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = process.cwd();
const npmExecPath = process.env.npm_execpath;
const piExecutable = process.env.PI_BIN ?? 'pi';
const temporaryRoot = mkdtempSync(join(tmpdir(), 'bazframe-2-real-pi-'));
let tarballPath;

if (!npmExecPath) {
  throw new Error('test:real-pi must run through npm so npm_execpath is available.');
}

try {
  const piVersion = execFileSync(piExecutable, ['--version'], { encoding: 'utf8' }).trim();
  if (!/^0\.82\./u.test(piVersion)) {
    throw new Error(`Real-Pi acceptance requires Pi 0.82.x; found ${piVersion}.`);
  }

  const [{ filename }] = JSON.parse(execFileSync(
    process.execPath,
    [npmExecPath, 'pack', '--json'],
    { cwd: projectRoot, encoding: 'utf8' }
  ));
  tarballPath = resolve(projectRoot, filename);

  execFileSync(process.execPath, [npmExecPath, 'init', '-y'], {
    cwd: temporaryRoot,
    stdio: 'ignore'
  });
  execFileSync(
    process.execPath,
    [npmExecPath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    { cwd: temporaryRoot, stdio: 'ignore' }
  );

  const executable = process.platform === 'win32'
    ? join(temporaryRoot, 'node_modules', '.bin', 'bazframe.cmd')
    : join(temporaryRoot, 'node_modules', '.bin', 'bazframe');
  const bazframeHome = join(temporaryRoot, 'bazframe-home');
  const agentDirectory = join(temporaryRoot, 'pi-agent');
  const repository = join(temporaryRoot, 'repository');
  const nonGitDirectory = join(temporaryRoot, 'non-git-project');
  const capturePath = join(temporaryRoot, 'captures.jsonl');
  const skillbookLibrary = join(temporaryRoot, 'skillbook-library');
  const skillSource = join(skillbookLibrary, 'skills', 'profile-probe');
  const membership = join(
    bazframeHome,
    'profiles',
    'focused',
    'skills',
    'profile-probe'
  );
  const skillDefinition = [
    '---',
    'name: profile-probe',
    'description: PACKED_PROFILE_SKILL',
    '---',
    '',
    '# Profile probe',
    ''
  ].join('\n');
  const skillSupport = 'PACKED_SKILL_SUPPORT\n';
  const skillbookLock = '{"schemaVersion":1,"provider":"skillbook"}\n';
  mkdirSync(skillSource, { recursive: true });
  writeFileSync(join(skillSource, 'SKILL.md'), skillDefinition);
  writeFileSync(join(skillSource, 'support.txt'), skillSupport);
  writeFileSync(join(skillbookLibrary, 'skillbook.lock.json'), skillbookLock);
  mkdirSync(join(agentDirectory, 'extensions'), { recursive: true });
  writeFileSync(join(agentDirectory, 'AGENTS.md'), 'PACKED_GLOBAL_CONTEXT\n');
  writeFileSync(
    join(agentDirectory, 'settings.json'),
    `${JSON.stringify({ quietStartup: true, enableInstallTelemetry: false })}\n`
  );
  copyFileSync(
    join(projectRoot, 'experiments', 'pi-no-launcher-adapter', 'probe-provider.ts'),
    join(agentDirectory, 'extensions', '99-probe-provider.ts')
  );
  mkdirSync(repository, { recursive: true });
  mkdirSync(nonGitDirectory, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  writeFileSync(join(repository, 'AGENTS.md'), 'PACKED_REPOSITORY_CONTEXT\n');
  const canonicalRepository = realpathSync(repository);
  const canonicalNonGitDirectory = realpathSync(nonGitDirectory);
  const projectStatePath = join(
    bazframeHome,
    'projects',
    `${createHash('sha256').update(canonicalRepository).digest('hex')}.json`
  );
  const globalStatePath = join(bazframeHome, 'global.json');

  const environment = {
    ...process.env,
    BAZFRAME_HOME: bazframeHome,
    BAZFRAME_PI_PROBE_CAPTURE: capturePath,
    SKILLBOOK_LIBRARY: skillbookLibrary,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0'
  };
  const profileAdded = run(executable, ['profile', 'add', 'focused'], temporaryRoot, environment);
  assert(profileAdded.stdout.includes('Profile lifecycle: added'), 'Packed CLI did not create profile.');
  writeFileSync(
    join(bazframeHome, 'profiles', 'focused', 'AGENTS.md'),
    'PACKED_PROFILE_INSTRUCTION\n'
  );
  const profileList = run(executable, ['profile', 'list'], temporaryRoot, environment);
  assert(profileList.stdout === 'focused\n', 'Packed CLI profile list was not script-friendly.');
  run(executable, ['profile', 'use', 'focused'], temporaryRoot, environment);
  const profileCurrent = run(executable, ['profile', 'current'], temporaryRoot, environment);
  assert(profileCurrent.stdout === 'focused\n', 'Packed CLI current profile was incorrect.');
  const added = run(
    executable,
    ['profile', 'skills', 'add', 'profile-probe'],
    temporaryRoot,
    environment
  );
  assert(added.stdout.includes('Profile skill membership: added'), 'Packed CLI did not add membership.');
  assert(lstatSync(membership).isSymbolicLink(), 'Packed CLI membership is not a symlink.');
  assert(readlinkSync(membership) === skillSource, 'Packed CLI membership target is not the Skillbook source.');
  run(executable, ['adapter', 'install', 'pi'], temporaryRoot, environment);
  const status = run(executable, ['status'], repository, environment);
  assert(status.stdout.includes('Pi adapter: current'), 'Packed CLI status omitted current adapter.');
  assert(status.stdout.includes('Global policy: enabled'), 'Packed CLI status omitted global policy.');
  assert(
    status.stdout.includes('Project state: none (inherits global policy)'),
    'Packed CLI status omitted file-free project inheritance.'
  );
  assert(!existsSync(projectStatePath), 'Default project behavior wrote current project state.');
  assert(!existsSync(globalStatePath), 'Default global behavior wrote global state.');
  const nonGitStatus = run(executable, ['status'], nonGitDirectory, environment);
  assert(
    nonGitStatus.stdout.includes('Repository: (outside a Git worktree)'),
    'Packed CLI status did not identify the non-Git directory.'
  );
  assert(
    nonGitStatus.stdout.includes('Effective behavior: enabled (global-enabled)'),
    'Packed CLI status did not apply the enabled global policy outside Git.'
  );
  assert(
    nonGitStatus.stdout.includes('Active profile: focused'),
    'Packed CLI status did not load the active profile outside Git.'
  );

  const gitStatusBefore = execFileSync('git', ['status', '--short'], {
    cwd: repository,
    encoding: 'utf8'
  });
  const replacement = runPi(repository, environment, ['-nc'], 'replacement probe');
  const additive = runPi(repository, environment, [], 'additive probe');
  const nonGitEnabledRun = runPi(nonGitDirectory, environment, [], 'non-Git enabled probe');
  assert(replacement.stdout.includes('probe-ok'), 'Replacement-mode probe response was missing.');
  assert(additive.stdout.includes('probe-ok'), 'Additive-mode probe response was missing.');
  assert(nonGitEnabledRun.stdout.includes('probe-ok'), 'Non-Git enabled probe response was missing.');

  mkdirSync(join(bazframeHome, 'projects'), { recursive: true });
  writeFileSync(projectStatePath, `${JSON.stringify({
    schemaVersion: 1,
    repository: canonicalRepository,
    mode: 'adaptive-context',
    profile: 'active'
  }, null, 2)}\n`);
  const legacyDefaultRun = runPi(repository, environment, [], 'legacy default probe');
  assert(legacyDefaultRun.stdout.includes('probe-ok'), 'Legacy-default probe response was missing.');
  const legacyCleaned = run(executable, ['project', 'enable'], repository, environment);
  assert(legacyCleaned.stdout.includes('Project policy: enabled'), 'Packed CLI did not clean legacy state.');
  assert(!existsSync(projectStatePath), 'Cleaning legacy defaults left current project state.');

  const globalDisabled = run(executable, ['global', 'disable'], repository, environment);
  assert(globalDisabled.stdout.includes('Global policy: disabled'), 'Packed CLI did not disable globally.');
  assert(existsSync(globalStatePath), 'Global disable did not write state.');
  const globalDisabledRun = runPi(repository, environment, [], 'global disabled probe');
  const nonGitDisabledRun = runPi(nonGitDirectory, environment, [], 'non-Git disabled probe');
  assert(globalDisabledRun.stdout.includes('probe-ok'), 'Global-disabled probe response was missing.');
  assert(nonGitDisabledRun.stdout.includes('probe-ok'), 'Non-Git disabled probe response was missing.');

  const projectEnabled = run(executable, ['project', 'enable'], repository, environment);
  assert(projectEnabled.stdout.includes('enabled project override'), 'Project enable did not override global disable.');
  const projectEnabledRun = runPi(repository, environment, ['-nc'], 'project enabled probe');
  assert(projectEnabledRun.stdout.includes('probe-ok'), 'Project-enabled probe response was missing.');

  run(executable, ['global', 'enable'], repository, environment);
  assert(!existsSync(globalStatePath), 'Global enable left disabled state.');
  const projectDisabled = run(executable, ['project', 'disable'], repository, environment);
  assert(projectDisabled.stdout.includes('disabled project override'), 'Project disable did not override global enable.');
  const projectDisabledRun = runPi(repository, environment, [], 'project disabled probe');
  assert(projectDisabledRun.stdout.includes('probe-ok'), 'Project-disabled probe response was missing.');

  const restored = run(executable, ['project', 'enable'], repository, environment);
  assert(restored.stdout.includes('Project policy: enabled'), 'Packed CLI did not restore inheritance.');
  assert(!existsSync(projectStatePath), 'Restoring inheritance left current project state.');
  const restoredRun = runPi(repository, environment, [], 'restored default probe');
  assert(restoredRun.stdout.includes('probe-ok'), 'Restored-default probe response was missing.');

  const captures = readFileSync(capturePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(captures.length === 9, `Expected nine real-Pi captures; found ${captures.length}.`);
  const [
    replacementCapture,
    additiveCapture,
    nonGitEnabledCapture,
    legacyDefaultCapture,
    globalDisabledCapture,
    nonGitDisabledCapture,
    projectEnabledCapture,
    projectDisabledCapture,
    restoredCapture
  ] = captures;
  for (const capture of [nonGitEnabledCapture, nonGitDisabledCapture]) {
    assert(
      capture.cwd === canonicalNonGitDirectory,
      `Non-Git probe ran in the wrong directory: ${capture.cwd}`
    );
  }
  for (const capture of [
    replacementCapture,
    additiveCapture,
    nonGitEnabledCapture,
    legacyDefaultCapture,
    projectEnabledCapture,
    restoredCapture
  ]) {
    assert(capture.systemPrompt.includes('PACKED_GLOBAL_CONTEXT'), 'Global context was missing.');
    assert(count(capture.systemPrompt, 'PACKED_GLOBAL_CONTEXT') === 1, 'Global context was duplicated.');
    assert(capture.systemPrompt.includes('PACKED_PROFILE_INSTRUCTION'), 'Profile instructions were missing.');
    assert(capture.systemPrompt.includes('PACKED_PROFILE_SKILL'), 'Profile skill was missing.');
  }
  for (const capture of [globalDisabledCapture, nonGitDisabledCapture, projectDisabledCapture]) {
    assert(!capture.systemPrompt.includes('PACKED_PROFILE_INSTRUCTION'), 'Disabled policy retained profile instructions.');
    assert(!capture.systemPrompt.includes('PACKED_PROFILE_SKILL'), 'Disabled policy retained the profile skill.');
  }
  assert(
    nonGitDisabledCapture.systemPrompt.includes('PACKED_GLOBAL_CONTEXT'),
    'Disabled non-Git behavior omitted native global context.'
  );
  for (const capture of [globalDisabledCapture, projectDisabledCapture]) {
    assert(capture.systemPrompt.includes('PACKED_REPOSITORY_CONTEXT'), 'Disabled policy omitted native repository context.');
  }
  assert(
    !nonGitEnabledCapture.systemPrompt.includes('PACKED_REPOSITORY_CONTEXT'),
    'Non-Git enabled behavior invented repository context.'
  );
  assert(!replacementCapture.systemPrompt.includes('PACKED_REPOSITORY_CONTEXT'), 'Replacement mode retained repository context.');
  assert(additiveCapture.systemPrompt.includes('PACKED_REPOSITORY_CONTEXT'), 'Additive mode omitted repository context.');
  assert(projectEnabledCapture.systemPrompt.includes('PACKED_PROFILE_INSTRUCTION'), 'Project enable did not override global disable.');
  assert(readdirSync(join(bazframeHome, 'projects')).length === 0, 'Default cleanup left project state.');
  const finalGitStatus = execFileSync('git', ['status', '--short'], {
    cwd: repository,
    encoding: 'utf8'
  });
  assert(finalGitStatus === gitStatusBefore, 'Policy lifecycle changed Git status.');

  const removed = run(
    executable,
    ['profile', 'skills', 'remove', 'profile-probe'],
    temporaryRoot,
    environment
  );
  assert(removed.stdout.includes('Profile skill membership: removed'), 'Packed CLI did not remove membership.');
  assert(!existsSync(membership), 'Packed CLI remove left the profile membership.');
  assert(
    readFileSync(join(skillSource, 'SKILL.md'), 'utf8') === skillDefinition,
    'Packed CLI changed the Skillbook skill definition.'
  );
  assert(
    readFileSync(join(skillSource, 'support.txt'), 'utf8') === skillSupport,
    'Packed CLI changed the Skillbook support file.'
  );
  assert(
    readFileSync(join(skillbookLibrary, 'skillbook.lock.json'), 'utf8') === skillbookLock,
    'Packed CLI changed the Skillbook lockfile.'
  );

  run(executable, ['adapter', 'uninstall', 'pi'], temporaryRoot, environment);
  assert(!existsSync(join(agentDirectory, 'extensions', 'bazframe.ts')), 'Adapter uninstall left its artifact.');

  process.stdout.write(`${JSON.stringify({
    piVersion,
    packedCli: true,
    adapterLifecycle: true,
    fileFreeGlobalAndProjectDefaults: true,
    legacyProjectDefaults: true,
    globalDisable: true,
    enabledProjectOverride: true,
    disabledProjectOverride: true,
    restoredProjectInheritance: true,
    replacementMode: true,
    additiveMode: true,
    nonGitGlobalInheritance: true,
    profileSkill: true,
    profileLifecycle: true,
    skillbookMembershipLifecycle: true,
    skillbookProviderPreserved: true,
    repositoryStable: true
  }, null, 2)}\n`);
} finally {
  if (tarballPath !== undefined && existsSync(tarballPath)) unlinkSync(tarballPath);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(executable, args, cwd, environment) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    shell: false
  });
  if (result.status !== 0) {
    throw new Error([
      `${executable} ${args.join(' ')} failed (${result.status}).`,
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`
    ].join('\n'));
  }
  return result;
}

function runPi(cwd, environment, extraArgs, prompt) {
  return run(
    piExecutable,
    [
      '--print',
      '--no-session',
      '--offline',
      '--provider',
      'bazframe-probe',
      '--model',
      'probe',
      '--thinking',
      'off',
      ...extraArgs,
      prompt
    ],
    cwd,
    environment
  );
}

function count(value, marker) {
  return value.split(marker).length - 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
