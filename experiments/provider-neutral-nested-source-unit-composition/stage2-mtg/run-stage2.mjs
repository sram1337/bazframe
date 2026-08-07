import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertOnlyBazframeHomeWritable, captureImmutableInputs } from '../fixture.mjs';
import { firstManifestDifference } from '../manifest.mjs';
import { prepareStage2Fixture, SOURCE_COMMIT } from './fixture.mjs';

const execute = promisify(execFile);
const stage2Root = dirname(fileURLToPath(import.meta.url));
const commandHelper = join(stage2Root, 'source-tree-command.mjs');
const piExecutable = process.env.PI_BIN ?? 'pi';

function environmentFor(fixture, configPath) {
  const home = fixture.bazframeHome;
  return {
    ...process.env,
    BAZFRAME_HOME: home,
    BAZFRAME_SOURCE_UNIT_PROBE_CONFIG: configPath,
    PI_CODING_AGENT_DIR: join(home, 'pi-agent'),
    HOME: join(home, 'home'),
    XDG_CONFIG_HOME: join(home, 'xdg', 'config'),
    XDG_CACHE_HOME: join(home, 'xdg', 'cache'),
    XDG_DATA_HOME: join(home, 'xdg', 'data'),
    XDG_STATE_HOME: join(home, 'xdg', 'state'),
    TMPDIR: join(home, 'tmp'),
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_offline: 'true',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'home', '.gitconfig')
  };
}

async function runProcess(executable, arguments_, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, arguments_, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        rejectRun(new Error(`Process failed: ${executable} ${arguments_.join(' ')} code=${code} signal=${signal}\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

async function runSourceTreeCommand(callerRoot, childRoot, script) {
  const run = await runProcess(process.execPath, [commandHelper, childRoot, script], {
    cwd: callerRoot,
    env: { ...process.env, npm_config_offline: 'true' }
  });
  return JSON.parse(run.stdout);
}

async function runPi(cwd, environment, prompt) {
  return runProcess(piExecutable, [
    '--print',
    '--no-session',
    '--offline',
    '--provider',
    'bazframe-source-unit-probe',
    '--model',
    'probe',
    '--thinking',
    'off',
    prompt
  ], { cwd, env: environment });
}

async function readJsonLines(path) {
  const contents = await readFile(path, 'utf8');
  return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function assertImmutable(fixture) {
  const statuses = await Promise.all(fixture.destinationRoots.map((path) => fixture.gitStatus(path)));
  assert.deepEqual(statuses, fixture.destinationGitStatus, 'Caller Git status changed.');
  const after = await captureImmutableInputs(fixture);
  for (const [label, beforeManifest, afterManifest] of [
    ['provider', fixture.before.provider, after.provider],
    ...fixture.before.destinations.map((manifest, index) => [
      `caller-${index + 1}`,
      manifest,
      after.destinations[index]
    ])
  ]) {
    const difference = firstManifestDifference(beforeManifest, afterManifest);
    assert.equal(difference, null, `${label} changed: ${JSON.stringify(difference)}`);
  }
  await assertOnlyBazframeHomeWritable(fixture);
  return { after, statuses };
}

export async function runStage2Proof() {
  const piVersion = (await execute(piExecutable, ['--version'], { encoding: 'utf8' })).stdout.trim();
  if (!/^0\.82\./u.test(piVersion)) throw new Error(`Stage 2 Pi projection requires Pi 0.82.x; found ${piVersion}.`);

  const fixture = await prepareStage2Fixture();
  try {
    const resolved = fixture.preparedResolution;
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.effectiveSkills.map(({ declaredName }) => declaredName), [
      'card-search',
      'deck-analysis'
    ]);
    assert.equal(fixture.dependencyPreparation.tsxVersion, '4.21.0');

    const sourceCommands = [];
    const commands = [
      ['card-search', 'scripts/card-search.ts'],
      ['deck-analysis', 'scripts/deck-analysis.ts']
    ];
    for (const callerRoot of fixture.destinationRoots) {
      for (const [childName, script] of commands) {
        const skill = resolved.effectiveSkills.find(({ declaredName }) => declaredName === childName);
        assert.ok(skill);
        const evidence = await runSourceTreeCommand(callerRoot, skill.skillRoot, script);
        assert.equal(evidence.startCwd, await realpath(callerRoot));
        assert.equal(evidence.executionCwd, skill.skillRoot);
        assert.equal(evidence.sourceRoot, resolved.directMembership.sourceRoot);
        assert.match(evidence.runtimePath, /node_modules\/tsx\/dist\/cli\.mjs$/u);
        assert.equal(evidence.installAttempted, false);
        assert.equal(evidence.networkMode, 'offline-proxy-blocked');
        sourceCommands.push({ callerRoot: await realpath(callerRoot), childName, ...evidence });
      }
    }
    for (const childName of commands.map(([name]) => name)) {
      const payloads = sourceCommands.filter((entry) => entry.childName === childName)
        .map((entry) => entry.payload);
      assert.deepEqual(payloads[0], payloads[1]);
      assert.equal(payloads[0].references.length, 2);
    }

    const capturePath = join(fixture.bazframeHome, 'captures', 'stage2.jsonl');
    const configPath = join(fixture.bazframeHome, 'stage2-pi-config.json');
    await writeFile(configPath, `${JSON.stringify({
      capturePath,
      scenario: 'stage2-mtg',
      sourceRoot: resolved.directMembership.sourceRoot,
      effectiveSkills: resolved.effectiveSkills
    }, null, 2)}\n`);
    const piRuns = [];
    for (const [index, cwd] of fixture.destinationRoots.entries()) {
      const run = await runPi(cwd, environmentFor(fixture, configPath), `stage2 mtg projection ${index + 1}`);
      assert.match(run.stdout, /probe-ok/u);
      piRuns.push({ cwd: await realpath(cwd), stdout: run.stdout.trim() });
    }
    const captures = await readJsonLines(capturePath);
    const discoveries = captures.filter(({ type }) => type === 'resources-discover');
    const providers = captures.filter(({ type }) => type === 'provider');
    assert.equal(discoveries.length, 2);
    assert.equal(providers.length, 2);
    const expectedPaths = resolved.effectiveSkills.map(({ definitionPath }) => definitionPath);
    for (const [index, discovery] of discoveries.entries()) {
      assert.equal(discovery.piVersion, piVersion);
      assert.equal(discovery.cwd, piRuns[index].cwd);
      assert.equal(discovery.compatible, true);
      assert.equal(discovery.groupingRootRequested, false);
      assert.deepEqual(discovery.skillPaths, expectedPaths);
      assert.deepEqual(discovery.loaded.map(({ diagnostics, skills }) => ({ diagnostics, skills })),
        resolved.effectiveSkills.map((skill) => ({
          diagnostics: [],
          skills: [{
            filePath: skill.definitionPath,
            baseDir: skill.skillRoot,
            name: skill.declaredName
          }]
        })));
    }
    assert.equal(providers.every(({ definitionPathsInPrompt }) =>
      definitionPathsInPrompt.every(({ present }) => present)), true);

    const provenance = JSON.parse(await readFile(join(fixture.sourceRoot, 'PROVENANCE.json'), 'utf8'));
    assert.equal(provenance.sourceCommit, SOURCE_COMMIT);
    assert.equal(provenance.exactCopies.length, 2);
    const immutable = await assertImmutable(fixture);

    return {
      schemaVersion: 1,
      experiment: 'provider-neutral-nested-source-unit-composition-stage2-mtg',
      result: 'passed',
      scope: 'source-tree-runtime-mechanics-not-bazframe-managed-gateway-or-lifecycle',
      piVersion,
      provenance,
      providerPreparation: fixture.dependencyPreparation,
      directMembership: resolved.directMembership,
      effectiveSkills: resolved.effectiveSkills,
      sourceCommands,
      piProjection: { runs: piRuns, discoveries },
      mutationEvidence: {
        providerManifestEntries: immutable.after.provider.length,
        callerManifestEntries: immutable.after.destinations.map((manifest) => manifest.length),
        callerGitStatus: immutable.statuses
      },
      claims: {
        twoIndependentChildren: true,
        bothChildrenRunFromBothUnrelatedGitCallers: true,
        childRootCwdUsed: true,
        sharedPureModulesConsumed: true,
        exactApprovedReferencesConsumed: true,
        syntheticImmutableInputsConsumed: true,
        ancestorLockedTsxConsumed: true,
        preparationCompletedBeforeMutationWindow: true,
        measurementOfflineAndNoInstall: true,
        exactChildDefinitionsAndOriginalBasesProjected: true,
        groupingRootNeverScannedByPi: true,
        providerAndCallersUnchanged: true,
        bazframeProductBehaviorUsedForAcquireInstallExecute: false,
        managedGatewayOrLifecycleProved: false
      }
    };
  } finally {
    await fixture.cleanup();
  }
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  runStage2Proof()
    .then((evidence) => process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
