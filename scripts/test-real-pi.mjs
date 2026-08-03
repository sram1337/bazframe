import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  const capturePath = join(temporaryRoot, 'captures.jsonl');
  mkdirSync(join(bazframeHome, 'profiles', 'focused', 'skills', 'profile-probe'), {
    recursive: true
  });
  writeFileSync(
    join(bazframeHome, 'profiles', 'focused', 'AGENTS.md'),
    'PACKED_PROFILE_INSTRUCTION\n'
  );
  writeFileSync(
    join(bazframeHome, 'profiles', 'focused', 'skills', 'profile-probe', 'SKILL.md'),
    [
      '---',
      'name: profile-probe',
      'description: PACKED_PROFILE_SKILL',
      '---',
      '',
      '# Profile probe',
      ''
    ].join('\n')
  );
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
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  writeFileSync(join(repository, 'AGENTS.md'), 'PACKED_REPOSITORY_CONTEXT\n');

  const environment = {
    ...process.env,
    BAZFRAME_HOME: bazframeHome,
    BAZFRAME_PI_PROBE_CAPTURE: capturePath,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0'
  };
  run(executable, ['use', 'focused'], temporaryRoot, environment);
  run(executable, ['adapter', 'install', 'pi'], temporaryRoot, environment);
  run(executable, ['init'], repository, environment);
  const status = run(executable, ['status'], repository, environment);
  assert(status.stdout.includes('Pi adapter: current'), 'Packed CLI status omitted current adapter.');
  assert(status.stdout.includes('Registration: registered'), 'Packed CLI status omitted registration.');

  const gitStatusBefore = execFileSync('git', ['status', '--short'], {
    cwd: repository,
    encoding: 'utf8'
  });
  const replacement = runPi(repository, environment, ['-nc'], 'replacement probe');
  const additive = runPi(repository, environment, [], 'additive probe');
  const gitStatusAfter = execFileSync('git', ['status', '--short'], {
    cwd: repository,
    encoding: 'utf8'
  });
  assert(replacement.stdout.includes('probe-ok'), 'Replacement-mode probe response was missing.');
  assert(additive.stdout.includes('probe-ok'), 'Additive-mode probe response was missing.');
  assert(gitStatusAfter === gitStatusBefore, 'Real Pi acceptance changed Git status.');

  const captures = readFileSync(capturePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(captures.length === 2, `Expected two real-Pi captures; found ${captures.length}.`);
  const [replacementCapture, additiveCapture] = captures;
  for (const capture of captures) {
    assert(capture.systemPrompt.includes('PACKED_GLOBAL_CONTEXT'), 'Global context was missing.');
    assert(count(capture.systemPrompt, 'PACKED_GLOBAL_CONTEXT') === 1, 'Global context was duplicated.');
    assert(capture.systemPrompt.includes('PACKED_PROFILE_INSTRUCTION'), 'Profile instructions were missing.');
    assert(capture.systemPrompt.includes('PACKED_PROFILE_SKILL'), 'Profile skill was missing.');
  }
  assert(
    !replacementCapture.systemPrompt.includes('PACKED_REPOSITORY_CONTEXT'),
    'Replacement mode retained repository context.'
  );
  assert(
    additiveCapture.systemPrompt.includes('PACKED_REPOSITORY_CONTEXT'),
    'Additive mode omitted repository context.'
  );

  run(executable, ['uninit'], repository, environment);
  run(executable, ['adapter', 'uninstall', 'pi'], temporaryRoot, environment);
  assert(!existsSync(join(agentDirectory, 'extensions', 'bazframe.ts')), 'Adapter uninstall left its artifact.');

  process.stdout.write(`${JSON.stringify({
    piVersion,
    packedCli: true,
    adapterLifecycle: true,
    externalRegistration: true,
    replacementMode: true,
    additiveMode: true,
    profileSkill: true,
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
