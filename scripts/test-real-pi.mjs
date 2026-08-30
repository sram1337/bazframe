import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { dirname, join, resolve } from 'node:path';

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
  const piVersionMatch = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(piVersion);
  const supportedPiVersion = piVersionMatch !== null
    && (Number(piVersionMatch[1]) > 0 || Number(piVersionMatch[2]) >= 82);
  if (!supportedPiVersion) {
    throw new Error(`Real-Pi acceptance requires a stable Pi 0.82.0 or newer; found ${piVersion}.`);
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
  const directSkillProvider = join(temporaryRoot, 'direct-skill-provider');
  const skillSource = join(directSkillProvider, 'profile-probe');
  const membership = join(
    bazframeHome,
    'profiles',
    'focused',
    'skills',
    'profile-probe'
  );
  const libraryProvider = join(temporaryRoot, 'demo-library');
  const sourceSkill = join(libraryProvider, 'source-probe');
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
  const packageProvider = join(temporaryRoot, 'demo-package');
  mkdirSync(join(packageProvider, 'src', 'package-probe'), { recursive: true });
  writeFileSync(join(packageProvider, 'src', 'package-probe', 'SKILL.md'), [
    '---', 'name: package-probe', 'description: PACKED_PACKAGE_SKILL', '---', '', '# Package probe', ''
  ].join('\n'));
  writeFileSync(join(packageProvider, 'build.mjs'), [
    "import { cp, mkdir, rm, writeFile } from 'node:fs/promises';",
    "await rm('dist', { recursive: true, force: true });",
    "await mkdir('dist/skills', { recursive: true });",
    "await cp('src', 'dist/skills', { recursive: true });",
    "await mkdir('dist/shared', { recursive: true });",
    "await writeFile('dist/shared/resource.txt', 'PACKED_SHARED_RESOURCE\\n');"
  ].join('\n'));
  writeFileSync(join(packageProvider, 'bazframe-package.json'), JSON.stringify({
    schemaVersion: 1,
    build: [process.execPath, 'build.mjs'],
    artifactRoot: 'dist',
    skillsRoot: 'skills'
  }));
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
  mkdirSync(skillSource, { recursive: true });
  writeFileSync(join(skillSource, 'SKILL.md'), skillDefinition);
  writeFileSync(join(skillSource, 'support.txt'), skillSupport);
  mkdirSync(join(agentDirectory, 'extensions'), { recursive: true });
  writeFileSync(join(agentDirectory, 'AGENTS.md'), 'PACKED_GLOBAL_CONTEXT\n');
  writeFileSync(
    join(agentDirectory, 'settings.json'),
    `${JSON.stringify({ quietStartup: true, enableInstallTelemetry: false })}\n`
  );
  copyFileSync(
    join(projectRoot, 'scripts', 'fixtures', 'pi-probe-provider.ts'),
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
  assert(profileList.stdout.includes('  - focused'), 'Packed CLI rich profile list was incorrect.');
  const profileListJson = JSON.parse(run(executable, ['profile', 'list', '--json'], temporaryRoot, environment).stdout);
  assert(profileListJson.schemaVersion === 1 && profileListJson.ok === true && profileListJson.command === 'profile.list', 'Packed CLI JSON profile list was incorrect.');
  run(executable, ['profile', 'use', 'focused'], temporaryRoot, environment);
  const profileCurrent = run(executable, ['profile', 'current'], temporaryRoot, environment);
  assert(profileCurrent.stdout === 'focused\n', 'Packed CLI current profile was incorrect.');
  const obsoleteGlobalPath = join(bazframeHome, 'sources', 'legacy.json');
  const obsoleteProfilePath = join(bazframeHome, 'profiles', 'focused', 'sources', 'legacy.json');
  const obsoleteSnapshotPath = join(bazframeHome, 'source-snapshots', 'legacy');
  mkdirSync(dirname(obsoleteGlobalPath), { recursive: true });
  mkdirSync(dirname(obsoleteProfilePath), { recursive: true });
  mkdirSync(obsoleteSnapshotPath, { recursive: true });
  writeFileSync(obsoleteGlobalPath, '{');
  writeFileSync(obsoleteProfilePath, '{');
  writeFileSync(join(obsoleteSnapshotPath, 'bytes'), 'legacy state\n');
  const obsoleteStateBefore = ownedManifest([obsoleteGlobalPath, obsoleteProfilePath, obsoleteSnapshotPath]);
  const libraryRecordPath = join(bazframeHome, 'libraries', 'demo-library.json');
  const libraryReferencePath = join(bazframeHome, 'profiles', 'focused', 'libraries', 'demo-library.json');
  const ownedBeforeLibraryAdd = providerManifest(libraryRecordPath);
  const libraryBeforeAdd = providerManifest(libraryProvider);
  const libraryAdded = run(executable, ['library', 'add', realpathSync(libraryProvider)], temporaryRoot, environment);
  assert(providerManifest(libraryProvider) === libraryBeforeAdd, 'Source add changed provider bytes.');
  assert(providerManifest(libraryRecordPath) !== ownedBeforeLibraryAdd, 'Source add did not change global source state.');
  assert(libraryAdded.stdout.includes('Global library: added'), 'Packed CLI did not add global source.');
  const referenceAdded = run(executable, ['profile', 'library', 'add', 'demo-library'], temporaryRoot, environment);
  assert(referenceAdded.stdout.includes('Profile library reference: added'), 'Packed CLI did not add source reference.');
  assert(existsSync(libraryReferencePath), 'Profile source reference was not created.');
  const expectedLibraryRecord = JSON.parse(readFileSync(libraryRecordPath, 'utf8'));
  assert(expectedLibraryRecord.schemaVersion === 1
    && expectedLibraryRecord.library === 'demo-library'
    && expectedLibraryRecord.root === realpathSync(libraryProvider)
    && /^[a-f0-9]{64}$/u.test(expectedLibraryRecord.digest)
, 'Source add wrote an unexpected global record.');
  const ownedBeforeOccupiedAdd = providerManifest(libraryRecordPath);
  const libraryBeforeOccupiedAdd = providerManifest(libraryProvider);
  const libraryOccupied = runFailure(executable, ['library', 'add', realpathSync(libraryProvider)], temporaryRoot, environment);
  assert(providerManifest(libraryProvider) === libraryBeforeOccupiedAdd, 'Occupied source add changed source bytes.');
  assert(providerManifest(libraryRecordPath) === ownedBeforeOccupiedAdd, 'Occupied source add changed global source state.');
  assert(libraryOccupied.stderr.includes('library name is already registered'), 'Packed CLI library add did not reject an occupied library name.');
  const packageRecordPath = join(bazframeHome, 'packages', 'demo-package.json');
  const packageReferencePath = join(bazframeHome, 'profiles', 'focused', 'packages', 'demo-package.json');
  const packageBeforeAdd = providerManifest(packageProvider);
  const packageAdded = run(executable, ['package', 'add', realpathSync(packageProvider)], temporaryRoot, environment);
  assert(packageAdded.stdout.includes('Global package: added'), 'Packed CLI did not add the package.');
  assert(providerManifest(packageProvider) !== packageBeforeAdd, 'Declared package build did not create its provider-owned artifact.');
  const expectedPackageRecord = JSON.parse(readFileSync(packageRecordPath, 'utf8'));
  assert(expectedPackageRecord.schemaVersion === 1
    && expectedPackageRecord.package === 'demo-package'
    && expectedPackageRecord.root === realpathSync(packageProvider)
    && expectedPackageRecord.artifactRoot === 'dist'
    && expectedPackageRecord.skillsRoot === 'skills'
    && /^[a-f0-9]{64}$/u.test(expectedPackageRecord.digest), 'Package add wrote an unexpected record.');
  const packageReferenceAdded = run(executable, ['profile', 'package', 'add', 'demo-package'], temporaryRoot, environment);
  assert(packageReferenceAdded.stdout.includes('Profile package reference: added'), 'Packed CLI did not add the package reference.');
  assert(existsSync(packageReferencePath), 'Profile package reference was not created.');
  const registered = run(executable, ['skill', 'add', realpathSync(skillSource)], temporaryRoot, environment);
  assert(registered.stdout.includes('Default skill registration: added'), 'Packed CLI did not register direct skill.');
  const catalogRegistration = join(bazframeHome, 'skills', 'profile-probe');
  assert(readlinkSync(catalogRegistration) === realpathSync(skillSource), 'Packed CLI catalog target is not canonical.');
  const added = run(
    executable,
    ['profile', 'skill', 'add', 'profile-probe'],
    temporaryRoot,
    environment
  );
  assert(added.stdout.includes('Profile skill membership: added'), 'Packed CLI did not add membership.');
  assert(lstatSync(membership).isSymbolicLink(), 'Packed CLI membership is not a symlink.');
  assert(readlinkSync(membership) === realpathSync(skillSource), 'Packed CLI membership target is not the direct provider source.');
  run(executable, ['adapter', 'install', 'pi'], temporaryRoot, environment);
  const ownedBeforeStatus = providerManifest(libraryRecordPath);
  const libraryBeforeStatus = providerManifest(libraryProvider);
  const status = run(executable, ['status'], repository, environment);
  const libraryAfterStatus = providerManifest(libraryProvider);
  const ownedAfterStatus = providerManifest(libraryRecordPath);
  assert(libraryAfterStatus === libraryBeforeStatus, 'Git status discovery changed provider bytes.');
  assert(ownedAfterStatus === ownedBeforeStatus, 'Git status discovery changed descriptor state.');
  assert(status.stdout.includes('Pi adapter: current'), 'Packed CLI status omitted current adapter.');
  assert(status.stdout.includes('Global policy: enabled'), 'Packed CLI status omitted global policy.');
  assert(
    status.stdout.includes('Project state: none (inherits global policy)'),
    'Packed CLI status omitted file-free project inheritance.'
  );
  assert(!existsSync(projectStatePath), 'Default project behavior wrote current project state.');
  assert(!existsSync(globalStatePath), 'Default global behavior wrote global state.');
  const ownedBeforeNonGitStatus = providerManifest(libraryRecordPath);
  const libraryBeforeNonGitStatus = providerManifest(libraryProvider);
  const nonGitStatus = run(executable, ['status'], nonGitDirectory, environment);
  const libraryAfterNonGitStatus = providerManifest(libraryProvider);
  const ownedAfterNonGitStatus = providerManifest(libraryRecordPath);
  assert(
    libraryAfterNonGitStatus === libraryBeforeNonGitStatus,
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
    libraryProvider, repository, environment, ['-nc'], 'replacement probe'
  );
  const additive = runPiPreservingProvider(
    libraryProvider, repository, environment, [], 'additive probe'
  );
  const nonGitEnabledRun = runPiPreservingProvider(
    libraryProvider, nonGitDirectory, environment, [], 'non-Git enabled probe'
  );
  const rpcOwnedRoots = [
    libraryRecordPath,
    packageRecordPath,
    join(bazframeHome, 'adapter-cache', 'pi', 'skill-aliases', 'focused')
  ];
  rpcClient = startPiRpc(repository, environment);
  const initialCommandsResponse = await rpcClient.request({ type: 'get_commands' });
  assert(initialCommandsResponse.success === true, 'Initial RPC command query failed.');
  const initialRpcCommands = rpcCommandNames(initialCommandsResponse);
  assert(initialRpcCommands.includes('bazframe'), 'RPC process did not load /bazframe.');
  assert(initialRpcCommands.includes('skill:source-probe'), 'RPC process omitted the initial library Skill.');
  assert(initialRpcCommands.includes('skill:package-probe'), 'RPC process omitted the initial package Skill.');
  assert(!initialRpcCommands.includes('skill:live-source'), 'RPC process saw a future library change.');
  assert(!initialRpcCommands.includes('skill:package-live'), 'RPC process saw a future package change.');
  const liveSkillDefinition = skillDefinition.replace('PACKED_PROFILE_SKILL', 'PACKED_PROFILE_SKILL_LIVE');
  writeFileSync(join(skillSource, 'SKILL.md'), liveSkillDefinition);
  assert(!JSON.stringify(await rpcClient.request({ type: 'get_commands' })).includes('PACKED_PROFILE_SKILL_LIVE'), 'RPC process saw live direct-skill provider mutation before reload.');

  const liveSource = join(libraryProvider, 'live-source');
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
  const beforeBuildCommands = rpcCommandNames(await rpcClient.request({ type: 'get_commands' }));
  assert(!beforeBuildCommands.includes('skill:live-source'), 'The same Pi process saw provider mutation before explicit build.');
  const nonRpcBeforeBuild = runPiPreservingProvider(libraryProvider, repository, environment, [], 'pre-build invisibility probe');
  assert(!nonRpcBeforeBuild.stdout.includes('PACKED_LIVE_SOURCE'), 'A fresh non-RPC Pi run saw provider mutation before explicit build.');

  const libraryBeforeExplicitUpdate = providerManifest(libraryProvider);
  const updatedForLiveSkill = run(executable, ['library', 'update', 'demo-library'], temporaryRoot, environment);
  assert(updatedForLiveSkill.stdout.includes('Global library: updated'), 'Explicit source build did not activate the provider change.');
  assert(providerManifest(libraryProvider) === libraryBeforeExplicitUpdate, 'Explicit snapshot-only build changed provider bytes.');
  const afterBuildBeforeReload = rpcCommandNames(await rpcClient.request({ type: 'get_commands' }));
  assert(!afterBuildBeforeReload.includes('skill:live-source'), 'The same Pi process saw the updated library snapshot before /bazframe reload.');
  mkdirSync(join(packageProvider, 'src', 'package-live'));
  writeFileSync(join(packageProvider, 'src', 'package-live', 'SKILL.md'), [
    '---', 'name: package-live', 'description: PACKED_PACKAGE_LIVE', '---', '', '# Package live', ''
  ].join('\n'));
  assert(!rpcCommandNames(await rpcClient.request({ type: 'get_commands' })).includes('skill:package-live'), 'RPC process saw package provider mutation before build.');
  const packageBuilt = run(executable, ['package', 'build', 'demo-package'], temporaryRoot, environment);
  assert(packageBuilt.stdout.includes('Global package: built'), 'Explicit package build did not activate provider output.');
  assert(!rpcCommandNames(await rpcClient.request({ type: 'get_commands' })).includes('skill:package-live'), 'RPC process saw the built package before reload.');

  const ownedBeforeRpcReload = ownedManifest(rpcOwnedRoots);
  const providerBeforeRpcReload = providerManifest(libraryProvider);
  const reloadResponse = await rpcClient.request({ type: 'prompt', message: '/bazframe reload' });
  assert(reloadResponse.success === true, 'RPC /bazframe reload did not return correlated success.');
  assert(providerManifest(libraryProvider) === providerBeforeRpcReload, 'RPC /bazframe reload changed provider bytes.');
  assert(ownedManifest(rpcOwnedRoots) === ownedBeforeRpcReload, 'RPC /bazframe reload changed Bazframe-owned state.');
  const afterReloadResponse = await rpcClient.request({ type: 'get_commands' });
  const afterReloadCommands = rpcCommandNames(afterReloadResponse);
  assert(afterReloadCommands.includes('skill:live-source'), 'The same Pi process did not expose the updated library after /bazframe reload.');
  assert(afterReloadCommands.includes('skill:package-live'), 'The same Pi process did not expose the built package after /bazframe reload.');
  assert(JSON.stringify(afterReloadResponse).includes('PACKED_PROFILE_SKILL_LIVE'), 'The same Pi process did not expose live direct-skill provider changes after /bazframe reload.');

  const rpcReloadSource = join(libraryProvider, 'rpc-reloaded-source');
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
  assert(!rpcCommandNames(await rpcClient.request({ type: 'get_commands' })).includes('skill:rpc-reloaded-source'), 'RPC process saw a second provider mutation before build.');
  const providerBeforeRpcUpdate = providerManifest(libraryProvider);
  const rpcUpdated = run(executable, ['library', 'update', 'demo-library'], temporaryRoot, environment);
  assert(rpcUpdated.stdout.includes('Global library: updated'), 'Explicit RPC-era source build did not activate.');
  assert(providerManifest(libraryProvider) === providerBeforeRpcUpdate, 'RPC-era source build changed provider bytes.');
  assert(!rpcCommandNames(await rpcClient.request({ type: 'get_commands' })).includes('skill:rpc-reloaded-source'), 'RPC process saw second rebuilt source before reload.');
  assert((await rpcClient.request({ type: 'prompt', message: '/bazframe reload' })).success === true, 'Second RPC reload failed.');
  assert(rpcCommandNames(await rpcClient.request({ type: 'get_commands' })).includes('skill:rpc-reloaded-source'), 'Second rebuilt source remained absent after reload.');
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
    libraryProvider, repository, environment, [], 'legacy default probe'
  );
  assert(legacyDefaultRun.stdout.includes('probe-ok'), 'Legacy-default probe response was missing.');
  const legacyCleaned = run(executable, ['project', 'enable'], repository, environment);
  assert(legacyCleaned.stdout.includes('Project policy: enabled'), 'Packed CLI did not clean legacy state.');
  assert(!existsSync(projectStatePath), 'Cleaning legacy defaults left current project state.');

  const globalDisabled = run(executable, ['global', 'disable'], repository, environment);
  assert(globalDisabled.stdout.includes('Global policy: disabled'), 'Packed CLI did not disable globally.');
  assert(existsSync(globalStatePath), 'Global disable did not write state.');
  const globalDisabledRun = runPiPreservingProvider(
    libraryProvider, repository, environment, [], 'global disabled probe'
  );
  const nonGitDisabledRun = runPiPreservingProvider(
    libraryProvider, nonGitDirectory, environment, [], 'non-Git disabled probe'
  );
  assert(globalDisabledRun.stdout.includes('probe-ok'), 'Global-disabled probe response was missing.');
  assert(nonGitDisabledRun.stdout.includes('probe-ok'), 'Non-Git disabled probe response was missing.');

  const projectEnabled = run(executable, ['project', 'enable'], repository, environment);
  assert(projectEnabled.stdout.includes('enabled project override'), 'Project enable did not override global disable.');
  const projectEnabledRun = runPiPreservingProvider(
    libraryProvider, repository, environment, ['-nc'], 'project enabled probe'
  );
  assert(projectEnabledRun.stdout.includes('probe-ok'), 'Project-enabled probe response was missing.');

  run(executable, ['global', 'enable'], repository, environment);
  assert(!existsSync(globalStatePath), 'Global enable left disabled state.');
  const projectDisabled = run(executable, ['project', 'disable'], repository, environment);
  assert(projectDisabled.stdout.includes('disabled project override'), 'Project disable did not override global enable.');
  const projectDisabledRun = runPiPreservingProvider(
    libraryProvider, repository, environment, [], 'project disabled probe'
  );
  assert(projectDisabledRun.stdout.includes('probe-ok'), 'Project-disabled probe response was missing.');

  const restored = run(executable, ['project', 'enable'], repository, environment);
  assert(restored.stdout.includes('Project policy: enabled'), 'Packed CLI did not restore inheritance.');
  assert(!existsSync(projectStatePath), 'Restoring inheritance left current project state.');
  const restoredRun = runPiPreservingProvider(
    libraryProvider, repository, environment, [], 'restored default probe'
  );
  assert(restoredRun.stdout.includes('probe-ok'), 'Restored-default probe response was missing.');

  const captures = readFileSync(capturePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(captures.length === 10, `Expected ten real-Pi captures; found ${captures.length}.`);
  const [
    replacementCapture,
    additiveCapture,
    nonGitEnabledCapture,
    preBuildCapture,
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
    preBuildCapture,
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
  assertMarkerOrder(
    replacementCapture.systemPrompt,
    ['PACKED_GLOBAL_CONTEXT', 'PACKED_PROFILE_INSTRUCTION'],
    'Replacement prompt order'
  );
  assertMarkerOrder(
    additiveCapture.systemPrompt,
    ['PACKED_GLOBAL_CONTEXT', 'PACKED_REPOSITORY_CONTEXT', 'PACKED_PROFILE_INSTRUCTION'],
    'Additive prompt order'
  );
  assert(
    replacementCapture.systemPrompt.includes('<bazframe_global_instructions path="'),
    'Replacement mode did not label restored global provenance.'
  );
  assert(
    !additiveCapture.systemPrompt.includes('<bazframe_global_instructions path="'),
    'Additive mode incorrectly relabeled Pi-native global provenance.'
  );
  for (const capture of [replacementCapture, additiveCapture]) {
    assert(
      capture.systemPrompt.includes('<bazframe_profile_instructions path="'),
      'Enabled mode did not label profile provenance.'
    );
  }
  assert(!replacementCapture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'Replacement run saw a future provider change.');
  assert(!additiveCapture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'Additive run saw a future provider change.');
  assert(!nonGitEnabledCapture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'Initial non-Git run saw a future provider change.');
  assert(!preBuildCapture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'Fresh Pi saw provider mutation before explicit build.');
  for (const capture of [legacyDefaultCapture, projectEnabledCapture, restoredCapture]) {
    assert(capture.systemPrompt.includes('PACKED_LIVE_SOURCE'), 'A later enabled run did not see the explicitly activated snapshot change.');
  }
  assert(projectEnabledCapture.systemPrompt.includes('PACKED_PROFILE_INSTRUCTION'), 'Project enable did not override global disable.');
  assert(readdirSync(join(bazframeHome, 'projects')).length === 0, 'Default cleanup left project state.');
  const finalGitStatus = execFileSync('git', ['status', '--short'], {
    cwd: repository,
    encoding: 'utf8'
  });
  assert(finalGitStatus === gitStatusBefore, 'Policy lifecycle changed Git status.');

  const referencedCatalogRemove = runFailure(executable, ['skill', 'remove', 'profile-probe'], temporaryRoot, environment);
  assert(referencedCatalogRemove.stderr.includes('referenced by profiles'), 'Packed CLI removed a referenced default skill.');
  const removed = run(
    executable,
    ['profile', 'skill', 'remove', 'profile-probe'],
    temporaryRoot,
    environment
  );
  assert(removed.stdout.includes('Profile skill membership: removed'), 'Packed CLI did not remove membership.');
  assert(!existsSync(membership), 'Packed CLI remove left the profile membership.');
  const catalogRemoved = run(executable, ['skill', 'remove', 'profile-probe'], temporaryRoot, environment);
  assert(catalogRemoved.stdout.includes('Default skill registration: removed'), 'Packed CLI did not remove default registration.');
  assert(
    readFileSync(join(skillSource, 'SKILL.md'), 'utf8') === liveSkillDefinition,
    'Packed CLI changed the provider skill definition.'
  );
  assert(
    readFileSync(join(skillSource, 'support.txt'), 'utf8') === skillSupport,
    'Packed CLI changed the provider support file.'
  );

  const ownedBeforeLibraryRemove = providerManifest(libraryRecordPath);
  const libraryBeforeRemove = providerManifest(libraryProvider);
  const libraryRemoved = run(executable, ['profile', 'library', 'remove', 'demo-library'], temporaryRoot, environment);
  assert(providerManifest(libraryProvider) === libraryBeforeRemove, 'Source detach changed provider bytes.');
  assert(providerManifest(libraryRecordPath) === ownedBeforeLibraryRemove, 'Source detach changed global source state.');
  assert(libraryRemoved.stdout.includes('Profile library reference: removed'), 'Packed CLI did not remove source reference.');
  assert(!existsSync(libraryReferencePath), 'Source detach left the profile reference.');
  const libraryAbsent = run(executable, ['profile', 'library', 'remove', 'demo-library'], temporaryRoot, environment);
  assert(libraryAbsent.stdout.includes('Profile library reference: absent'), 'Source detach retry was not absent.');
  const globalLibraryRemoved = run(executable, ['library', 'remove', 'demo-library'], temporaryRoot, environment);
  assert(globalLibraryRemoved.stdout.includes('Global library: removed'), 'Packed CLI did not remove unreferenced global source.');
  assert(!existsSync(libraryRecordPath), 'Global library removal left its record.');
  const packageBeforeRemove = providerManifest(packageProvider);
  const packageReferenceRemoved = run(executable, ['profile', 'package', 'remove', 'demo-package'], temporaryRoot, environment);
  assert(packageReferenceRemoved.stdout.includes('Profile package reference: removed'), 'Packed CLI did not remove package reference.');
  const globalPackageRemoved = run(executable, ['package', 'remove', 'demo-package'], temporaryRoot, environment);
  assert(globalPackageRemoved.stdout.includes('Global package: removed'), 'Packed CLI did not remove unreferenced package.');
  assert(!existsSync(packageRecordPath) && !existsSync(packageReferencePath), 'Package removal left Bazframe state.');
  assert(providerManifest(packageProvider) === packageBeforeRemove, 'Package removal changed provider-owned bytes.');
  assert(ownedManifest([obsoleteGlobalPath, obsoleteProfilePath, obsoleteSnapshotPath]) === obsoleteStateBefore, 'Obsolete pre-alpha state was read destructively or changed.');

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
    defaultCatalogMembershipLifecycle: true,
    directSkillProviderPreserved: true,
    liveDirectSkillReload: true,
    providerNeutralCollectionProjection: true,
    libraryUpdateLifecycle: true,
    packageBuildLifecycle: true,
    sharedPackageArtifact: true,
    obsoleteStateInertAndPreserved: true,
    sameProcessRpcReload: true,
    libraryProviderPreserved: true,
    repositoryStable: true
  }, null, 2)}\n`);
} finally {
  await rpcClient?.close();
  if (tarballPath !== undefined && existsSync(tarballPath)) unlinkSync(tarballPath);
  makeWritable(temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  try { chmodSync(path, metadata.isDirectory() ? 0o700 : 0o600); } catch { /* best-effort test cleanup */ }
  if (metadata.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
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

function runFailure(executable, args, cwd, environment) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    shell: false
  });
  if (result.status === 0) throw new Error(`${executable} ${args.join(' ')} unexpectedly succeeded.`);
  return result;
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
  const libraryRecord = join(environment.BAZFRAME_HOME, 'libraries', 'demo-library.json');
  const packageRecord = join(environment.BAZFRAME_HOME, 'packages', 'demo-package.json');
  const aliasRoot = join(
    environment.BAZFRAME_HOME,
    'adapter-cache',
    'pi',
    'skill-aliases',
    'focused'
  );
  const ownedBefore = ownedManifest([libraryRecord, packageRecord, aliasRoot]);
  const before = providerManifest(providerRoot);
  const result = runPi(cwd, environment, extraArgs, prompt);
  const after = providerManifest(providerRoot);
  const ownedAfter = ownedManifest([libraryRecord, packageRecord, aliasRoot]);
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

function assertMarkerOrder(value, markers, label) {
  let previous = -1;
  for (const marker of markers) {
    const index = value.indexOf(marker);
    assert(index >= 0, `${label} omitted ${marker}.`);
    assert(index > previous, `${label} did not preserve ${markers.join(' < ')}.`);
    previous = index;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
