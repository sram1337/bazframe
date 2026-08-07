import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
let rpcClient;

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
  const sourceProvider = join(temporaryRoot, 'source-provider');
  const sourceSkill = join(sourceProvider, 'source-probe');
  const sourceDefinition = [
    '---',
    'name: source-probe',
    'description: PACKED_SOURCE_SKILL',
    '---',
    '',
    '# Source probe',
    ''
  ].join('\n');
  mkdirSync(sourceSkill, { recursive: true });
  writeFileSync(join(sourceSkill, 'SKILL.md'), sourceDefinition);
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
  const sourceDescriptorPath = join(
    bazframeHome,
    'profiles',
    'focused',
    'source-units',
    'provider',
    'source.json'
  );
  const ownedBeforeSourceAdd = providerManifest(sourceDescriptorPath);
  const sourceBeforeAdd = providerManifest(sourceProvider);
  const sourceAdded = run(
    executable,
    ['profile', 'sources', 'add', 'provider', 'source', realpathSync(sourceProvider)],
    temporaryRoot,
    environment
  );
  const sourceAfterAdd = providerManifest(sourceProvider);
  const ownedAfterSourceAdd = providerManifest(sourceDescriptorPath);
  assert(sourceAfterAdd === sourceBeforeAdd, 'Source add changed provider bytes.');
  assert(ownedAfterSourceAdd !== ownedBeforeSourceAdd, 'Source add did not change descriptor state.');
  assert(sourceAdded.stdout.includes('Profile source membership: added'), 'Packed CLI did not add source membership.');
  assert(existsSync(sourceDescriptorPath), 'Source add did not create the Bazframe-owned descriptor.');
  const expectedSourceDescriptor = {
    schemaVersion: 1,
    providerId: 'provider',
    sourceId: 'source',
    sourceRoot: realpathSync(sourceProvider)
  };
  assert(
    JSON.stringify(JSON.parse(readFileSync(sourceDescriptorPath, 'utf8'))) === JSON.stringify(expectedSourceDescriptor),
    'Source add wrote an unexpected descriptor.'
  );
  const ownedBeforeIdempotentAdd = providerManifest(sourceDescriptorPath);
  const sourceBeforeIdempotentAdd = providerManifest(sourceProvider);
  const sourceCurrent = run(
    executable,
    ['profile', 'sources', 'add', 'provider', 'source', realpathSync(sourceProvider)],
    temporaryRoot,
    environment
  );
  const sourceAfterIdempotentAdd = providerManifest(sourceProvider);
  const ownedAfterIdempotentAdd = providerManifest(sourceDescriptorPath);
  assert(
    sourceAfterIdempotentAdd === sourceBeforeIdempotentAdd,
    'Idempotent source add changed provider bytes.'
  );
  assert(
    ownedAfterIdempotentAdd === ownedBeforeIdempotentAdd,
    'Idempotent source add changed descriptor state.'
  );
  assert(sourceCurrent.stdout.includes('Profile source membership: current'), 'Packed CLI source add was not idempotent.');
  assert(existsSync(sourceDescriptorPath), 'Idempotent source add removed the descriptor.');
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
  const ownedBeforeStatus = providerManifest(sourceDescriptorPath);
  const sourceBeforeStatus = providerManifest(sourceProvider);
  const status = run(executable, ['status'], repository, environment);
  const sourceAfterStatus = providerManifest(sourceProvider);
  const ownedAfterStatus = providerManifest(sourceDescriptorPath);
  assert(sourceAfterStatus === sourceBeforeStatus, 'Git status discovery changed provider bytes.');
  assert(ownedAfterStatus === ownedBeforeStatus, 'Git status discovery changed descriptor state.');
  assert(status.stdout.includes('Pi adapter: current'), 'Packed CLI status omitted current adapter.');
  assert(status.stdout.includes('Global policy: enabled'), 'Packed CLI status omitted global policy.');
  assert(
    status.stdout.includes('Project state: none (inherits global policy)'),
    'Packed CLI status omitted file-free project inheritance.'
  );
  assert(!existsSync(projectStatePath), 'Default project behavior wrote current project state.');
  assert(!existsSync(globalStatePath), 'Default global behavior wrote global state.');
  const ownedBeforeNonGitStatus = providerManifest(sourceDescriptorPath);
  const sourceBeforeNonGitStatus = providerManifest(sourceProvider);
  const nonGitStatus = run(executable, ['status'], nonGitDirectory, environment);
  const sourceAfterNonGitStatus = providerManifest(sourceProvider);
  const ownedAfterNonGitStatus = providerManifest(sourceDescriptorPath);
  assert(
    sourceAfterNonGitStatus === sourceBeforeNonGitStatus,
    'Non-Git status discovery changed provider bytes.'
  );
  assert(
    ownedAfterNonGitStatus === ownedBeforeNonGitStatus,
    'Non-Git status discovery changed descriptor state.'
  );
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
  const replacement = runPiPreservingProvider(
    sourceProvider, repository, environment, ['-nc'], 'replacement probe'
  );
  const additive = runPiPreservingProvider(
    sourceProvider, repository, environment, [], 'additive probe'
  );
  const nonGitEnabledRun = runPiPreservingProvider(
    sourceProvider, nonGitDirectory, environment, [], 'non-Git enabled probe'
  );
  const liveSource = join(sourceProvider, 'live-source');
  mkdirSync(liveSource);
  writeFileSync(join(liveSource, 'SKILL.md'), [
    '---',
    'name: live-source',
    'description: PACKED_LIVE_SOURCE',
    '---',
    '',
    '# Live source',
    ''
  ].join('\n'));

  const rpcOwnedRoots = [
    sourceDescriptorPath,
    join(bazframeHome, 'adapter-cache', 'pi', 'skill-aliases', 'focused')
  ];
  const ownedBeforeRpcProjection = ownedManifest(rpcOwnedRoots);
  const providerBeforeRpcProjection = providerManifest(sourceProvider);
  rpcClient = startPiRpc(repository, environment);
  const initialCommandsResponse = await rpcClient.request({ type: 'get_commands' });
  const providerAfterRpcProjection = providerManifest(sourceProvider);
  const ownedAfterRpcProjection = ownedManifest(rpcOwnedRoots);
  assert(
    providerAfterRpcProjection === providerBeforeRpcProjection,
    'Initial real-Pi RPC projection changed provider bytes.'
  );
  assert(
    ownedAfterRpcProjection === ownedBeforeRpcProjection,
    'Initial real-Pi RPC projection changed Bazframe-owned state.'
  );
  assert(initialCommandsResponse.success === true, 'Initial RPC command query failed.');
  const initialRpcCommands = rpcCommandNames(initialCommandsResponse);
  assert(initialRpcCommands.includes('bazframe'), 'RPC process did not load /bazframe.');
  assert(initialRpcCommands.includes('skill:source-probe'), 'RPC process omitted the initial source skill.');
  assert(initialRpcCommands.includes('skill:live-source'), 'RPC process omitted the live source skill.');
  assert(!initialRpcCommands.includes('skill:rpc-reloaded-source'), 'RPC process saw a future source change.');

  const rpcReloadSource = join(sourceProvider, 'rpc-reloaded-source');
  mkdirSync(rpcReloadSource);
  writeFileSync(join(rpcReloadSource, 'SKILL.md'), [
    '---',
    'name: rpc-reloaded-source',
    'description: PACKED_RPC_RELOADED_SOURCE',
    '---',
    '',
    '# RPC reloaded source',
    ''
  ].join('\n'));
  const ownedBeforeRpcReload = ownedManifest(rpcOwnedRoots);
  const providerBeforeRpcReload = providerManifest(sourceProvider);
  const reloadResponse = await rpcClient.request({
    type: 'prompt',
    message: '/bazframe reload'
  });
  const providerAfterRpcReload = providerManifest(sourceProvider);
  const ownedAfterRpcReload = ownedManifest(rpcOwnedRoots);
  assert(providerAfterRpcReload === providerBeforeRpcReload, 'RPC /bazframe reload changed provider bytes.');
  assert(ownedAfterRpcReload === ownedBeforeRpcReload, 'RPC /bazframe reload changed Bazframe-owned state.');
  assert(reloadResponse.success === true, 'RPC /bazframe reload did not return correlated success.');

  const ownedBeforeReloadedQuery = ownedManifest(rpcOwnedRoots);
  const providerBeforeReloadedQuery = providerManifest(sourceProvider);
  const reloadedCommandsResponse = await rpcClient.request({ type: 'get_commands' });
  const providerAfterReloadedQuery = providerManifest(sourceProvider);
  const ownedAfterReloadedQuery = ownedManifest(rpcOwnedRoots);
  assert(
    providerAfterReloadedQuery === providerBeforeReloadedQuery,
    'Reloaded RPC command query changed provider bytes.'
  );
  assert(
    ownedAfterReloadedQuery === ownedBeforeReloadedQuery,
    'Reloaded RPC command query changed Bazframe-owned state.'
  );
  assert(reloadedCommandsResponse.success === true, 'Reloaded RPC command query failed.');
  const reloadedRpcCommands = rpcCommandNames(reloadedCommandsResponse);
  assert(
    reloadedRpcCommands.includes('skill:rpc-reloaded-source'),
    'The same Pi RPC process did not expose the changed source after /bazframe reload.'
  );
  assert(rpcClient.modelEvents.length === 0, 'RPC reload unexpectedly invoked the model.');
  await rpcClient.close();
  rpcClient = undefined;

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
  const legacyDefaultRun = runPiPreservingProvider(
    sourceProvider, repository, environment, [], 'legacy default probe'
  );
  assert(legacyDefaultRun.stdout.includes('probe-ok'), 'Legacy-default probe response was missing.');
  const legacyCleaned = run(executable, ['project', 'enable'], repository, environment);
  assert(legacyCleaned.stdout.includes('Project policy: enabled'), 'Packed CLI did not clean legacy state.');
  assert(!existsSync(projectStatePath), 'Cleaning legacy defaults left current project state.');

  const globalDisabled = run(executable, ['global', 'disable'], repository, environment);
  assert(globalDisabled.stdout.includes('Global policy: disabled'), 'Packed CLI did not disable globally.');
  assert(existsSync(globalStatePath), 'Global disable did not write state.');
  const globalDisabledRun = runPiPreservingProvider(
    sourceProvider, repository, environment, [], 'global disabled probe'
  );
  const nonGitDisabledRun = runPiPreservingProvider(
    sourceProvider, nonGitDirectory, environment, [], 'non-Git disabled probe'
  );
  assert(globalDisabledRun.stdout.includes('probe-ok'), 'Global-disabled probe response was missing.');
  assert(nonGitDisabledRun.stdout.includes('probe-ok'), 'Non-Git disabled probe response was missing.');

  const projectEnabled = run(executable, ['project', 'enable'], repository, environment);
  assert(projectEnabled.stdout.includes('enabled project override'), 'Project enable did not override global disable.');
  const projectEnabledRun = runPiPreservingProvider(
    sourceProvider, repository, environment, ['-nc'], 'project enabled probe'
  );
  assert(projectEnabledRun.stdout.includes('probe-ok'), 'Project-enabled probe response was missing.');

  run(executable, ['global', 'enable'], repository, environment);
  assert(!existsSync(globalStatePath), 'Global enable left disabled state.');
  const projectDisabled = run(executable, ['project', 'disable'], repository, environment);
  assert(projectDisabled.stdout.includes('disabled project override'), 'Project disable did not override global enable.');
  const projectDisabledRun = runPiPreservingProvider(
    sourceProvider, repository, environment, [], 'project disabled probe'
  );
  assert(projectDisabledRun.stdout.includes('probe-ok'), 'Project-disabled probe response was missing.');

  const restored = run(executable, ['project', 'enable'], repository, environment);
  assert(restored.stdout.includes('Project policy: enabled'), 'Packed CLI did not restore inheritance.');
  assert(!existsSync(projectStatePath), 'Restoring inheritance left current project state.');
  const restoredRun = runPiPreservingProvider(
    sourceProvider, repository, environment, [], 'restored default probe'
  );
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
    assert(capture.systemPrompt.includes('PACKED_SOURCE_SKILL'), 'Derived source skill was missing.');
  }
  for (const capture of [globalDisabledCapture, nonGitDisabledCapture, projectDisabledCapture]) {
    assert(!capture.systemPrompt.includes('PACKED_PROFILE_INSTRUCTION'), 'Disabled policy retained profile instructions.');
    assert(!capture.systemPrompt.includes('PACKED_PROFILE_SKILL'), 'Disabled policy retained the profile skill.');
    assert(!capture.systemPrompt.includes('PACKED_SOURCE_SKILL'), 'Disabled policy retained the derived source skill.');
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
  assert(!replacementCapture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'Replacement run saw a future provider change.');
  assert(!additiveCapture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'Additive run saw a future provider change.');
  assert(!nonGitEnabledCapture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'Initial non-Git run saw a future provider change.');
  for (const capture of [legacyDefaultCapture, projectEnabledCapture, restoredCapture]) {
    assert(capture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'A later enabled run did not see the live provider change.');
  }
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

  const ownedBeforeSourceRemove = providerManifest(sourceDescriptorPath);
  const sourceBeforeRemove = providerManifest(sourceProvider);
  const sourceRemoved = run(
    executable,
    ['profile', 'sources', 'remove', 'provider', 'source'],
    temporaryRoot,
    environment
  );
  const sourceAfterRemove = providerManifest(sourceProvider);
  const ownedAfterSourceRemove = providerManifest(sourceDescriptorPath);
  assert(sourceAfterRemove === sourceBeforeRemove, 'Source removal changed provider bytes.');
  assert(ownedAfterSourceRemove !== ownedBeforeSourceRemove, 'Source removal did not change descriptor state.');
  assert(sourceRemoved.stdout.includes('Profile source membership: removed'), 'Packed CLI did not remove source membership.');
  assert(!existsSync(sourceDescriptorPath), 'Source removal left the Bazframe-owned descriptor.');

  const ownedBeforeAbsentRetry = providerManifest(sourceDescriptorPath);
  const sourceBeforeAbsentRetry = providerManifest(sourceProvider);
  const sourceAbsent = run(
    executable,
    ['profile', 'sources', 'remove', 'provider', 'source'],
    temporaryRoot,
    environment
  );
  const sourceAfterAbsentRetry = providerManifest(sourceProvider);
  const ownedAfterAbsentRetry = providerManifest(sourceDescriptorPath);
  assert(
    sourceAfterAbsentRetry === sourceBeforeAbsentRetry,
    'Absent source-remove retry changed provider bytes.'
  );
  assert(
    ownedAfterAbsentRetry === ownedBeforeAbsentRetry,
    'Absent source-remove retry changed descriptor state.'
  );
  assert(sourceAbsent.stdout.includes('Profile source membership: absent'), 'Source-remove retry was not absent.');
  assert(!existsSync(sourceDescriptorPath), 'Absent source-remove retry recreated the descriptor.');

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
    providerNeutralSourceProjection: true,
    liveProviderReload: true,
    sameProcessRpcReload: true,
    sourceProviderPreserved: true,
    repositoryStable: true
  }, null, 2)}\n`);
} finally {
  await rpcClient?.close();
  if (tarballPath !== undefined && existsSync(tarballPath)) unlinkSync(tarballPath);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function providerManifest(root) {
  const records = [];
  function visit(path, relativePath) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      records.push([relativePath, 'symlink', sha256(Buffer.from(readlinkSync(path)))]);
      return;
    }
    if (metadata.isFile()) {
      records.push([relativePath, 'file', sha256(readFileSync(path))]);
      return;
    }
    if (metadata.isDirectory()) {
      records.push([relativePath, 'directory', null]);
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relativePath === '.' ? name : `${relativePath}/${name}`);
      }
      return;
    }
    records.push([relativePath, 'other', null]);
  }
  if (!existsSync(root)) return JSON.stringify([['.', 'missing', null]]);
  visit(root, '.');
  return JSON.stringify(records);
}

function ownedManifest(roots) {
  return JSON.stringify(roots.map((root) => JSON.parse(providerManifest(root))));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function startPiRpc(cwd, environment) {
  const child = spawn(
    piExecutable,
    [
      '--mode',
      'rpc',
      '--no-session',
      '--offline',
      '--provider',
      'bazframe-probe',
      '--model',
      'probe',
      '--thinking',
      'off'
    ],
    { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuffer = '';
  let stderr = '';
  let requestSequence = 0;
  let closed = false;
  const pending = new Map();
  const events = [];
  const modelEvents = [];

  function rejectPending(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(error);
    }
    pending.clear();
  }

  function write(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function acceptLine(line) {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized.length === 0) return;
    let message;
    try {
      message = JSON.parse(normalized);
    } catch (error) {
      rejectPending(new Error(`Invalid Pi RPC JSONL record: ${normalized}`, { cause: error }));
      return;
    }
    if (message.type === 'response' && typeof message.id === 'string') {
      const item = pending.get(message.id);
      if (item !== undefined) {
        pending.delete(message.id);
        clearTimeout(item.timeout);
        item.resolve(message);
      }
      return;
    }
    events.push(message);
    if (message.type === 'agent_start' || message.type === 'message_start') {
      modelEvents.push(message);
    }
    if (message.type === 'extension_ui_request'
      && ['select', 'confirm', 'input', 'editor'].includes(message.method)) {
      write({ type: 'extension_ui_response', id: message.id, cancelled: true });
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const delimiter = stdoutBuffer.indexOf('\n');
      if (delimiter < 0) break;
      const line = stdoutBuffer.slice(0, delimiter);
      stdoutBuffer = stdoutBuffer.slice(delimiter + 1);
      acceptLine(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', rejectPending);
  child.on('exit', (code, signal) => {
    closed = true;
    if (pending.size > 0) {
      rejectPending(new Error(
        `Pi RPC exited before responding (code ${code}, signal ${signal}). stderr: ${stderr}`
      ));
    }
  });

  return {
    events,
    modelEvents,
    request(command) {
      const id = `bazframe-real-pi-${requestSequence += 1}`;
      return new Promise((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectResponse(new Error(`Timed out waiting for Pi RPC ${command.type}. stderr: ${stderr}`));
        }, 30_000);
        pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timeout });
        write({ id, ...command });
      });
    },
    async close() {
      if (closed) return;
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000))]);
      if (!closed) child.kill('SIGKILL');
    }
  };
}

function rpcCommandNames(response) {
  const commands = response?.data?.commands;
  if (!Array.isArray(commands)) throw new Error('Pi RPC get_commands returned malformed data.');
  return commands.map((command) => command.name).sort();
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

function runPiPreservingProvider(providerRoot, cwd, environment, extraArgs, prompt) {
  const descriptorPath = join(
    environment.BAZFRAME_HOME,
    'profiles',
    'focused',
    'source-units',
    'provider',
    'source.json'
  );
  const aliasRoot = join(
    environment.BAZFRAME_HOME,
    'adapter-cache',
    'pi',
    'skill-aliases',
    'focused'
  );
  const ownedBefore = ownedManifest([descriptorPath, aliasRoot]);
  const before = providerManifest(providerRoot);
  const result = runPi(cwd, environment, extraArgs, prompt);
  const after = providerManifest(providerRoot);
  const ownedAfter = ownedManifest([descriptorPath, aliasRoot]);
  assert(after === before, `Real-Pi projection changed provider bytes during ${prompt}.`);
  assert(ownedAfter === ownedBefore, `Real-Pi projection changed Bazframe-owned state during ${prompt}.`);
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
