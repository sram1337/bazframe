import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  writeFile
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assertOnlyBazframeHomeWritable,
  captureImmutableInputs,
  prepareFixture,
  writeSkill
} from './fixture.mjs';
import { firstManifestDifference } from './manifest.mjs';
import { resolveSourceUnit } from './resolver.mjs';

const execute = promisify(execFile);
const experimentRoot = dirname(fileURLToPath(import.meta.url));
const extensionSource = join(experimentRoot, 'pi-projection-extension.ts');
const piExecutable = process.env.PI_BIN ?? 'pi';

function isWithin(path, root) {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..');
}

async function readJsonLines(path) {
  const contents = await readFile(path, 'utf8');
  return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function setupPiHome({ bazframeHome }) {
  const agentDirectory = join(bazframeHome, 'pi-agent');
  const paths = {
    agentDirectory,
    home: join(bazframeHome, 'home'),
    xdgConfig: join(bazframeHome, 'xdg', 'config'),
    xdgCache: join(bazframeHome, 'xdg', 'cache'),
    xdgData: join(bazframeHome, 'xdg', 'data'),
    xdgState: join(bazframeHome, 'xdg', 'state'),
    temp: join(bazframeHome, 'tmp'),
    captures: join(bazframeHome, 'captures')
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  await mkdir(join(agentDirectory, 'extensions'), { recursive: true });
  await copyFile(extensionSource, join(agentDirectory, 'extensions', 'source-unit-probe.ts'));
  await writeFile(
    join(agentDirectory, 'settings.json'),
    `${JSON.stringify({ quietStartup: true, enableInstallTelemetry: false })}\n`
  );
  await writeFile(join(paths.home, '.gitconfig'), '[init]\n\tdefaultBranch = main\n');
}

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
    npm_config_cache: join(home, 'xdg', 'cache', 'npm'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'home', '.gitconfig')
  };
}

async function runPi(cwd, environment, prompt) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(piExecutable, [
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
    ], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        rejectRun(new Error([
          `Pi probe failed in ${cwd}: code=${code} signal=${signal}`,
          `stdout: ${stdout}`,
          `stderr: ${stderr}`
        ].join('\n')));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

async function assertImmutable(fixture) {
  const statuses = await Promise.all(fixture.destinationRoots.map((path) => fixture.gitStatus(path)));
  assert.deepEqual(statuses, fixture.destinationGitStatus, 'Destination Git status changed.');
  const after = await captureImmutableInputs(fixture);
  for (const [label, beforeManifest, afterManifest] of [
    ['provider', fixture.before.provider, after.provider],
    ...fixture.before.destinations.map((manifest, index) => [
      `destination-${index + 1}`,
      manifest,
      after.destinations[index]
    ])
  ]) {
    const difference = firstManifestDifference(beforeManifest, afterManifest);
    assert.equal(
      difference,
      null,
      `${label} manifest changed; first diff: ${JSON.stringify(difference)}`
    );
  }
  await assertOnlyBazframeHomeWritable(fixture);
  return { after, statuses };
}

async function resolveFixture(fixture) {
  const result = await resolveSourceUnit({
    providerId: fixture.providerId,
    sourceId: fixture.sourceId,
    membershipPath: fixture.membershipPath
  });
  assert.equal(result.ok, true, `Structural resolution failed: ${JSON.stringify(result)}`);
  return result;
}

async function runPositiveScenario(piVersion) {
  const fixture = await prepareFixture({ setupHome: setupPiHome });
  try {
    const resolved = await resolveFixture(fixture);
    assert.deepEqual(resolved.effectiveSkills.map((skill) => skill.declaredName), ['alpha', 'beta']);
    const capturePath = join(fixture.bazframeHome, 'captures', 'positive.jsonl');
    const configPath = join(fixture.bazframeHome, 'positive-config.json');
    await writeFile(configPath, `${JSON.stringify({
      capturePath,
      scenario: 'positive',
      sourceRoot: resolved.directMembership.sourceRoot,
      effectiveSkills: resolved.effectiveSkills
    }, null, 2)}\n`);
    const environment = environmentFor(fixture, configPath);
    const runs = [];
    for (const [index, cwd] of fixture.destinationRoots.entries()) {
      const run = await runPi(cwd, environment, `source-unit positive probe ${index + 1}`);
      assert.match(run.stdout, /probe-ok/u);
      runs.push({ cwd: await realpath(cwd), stdout: run.stdout.trim() });
    }

    const captures = await readJsonLines(capturePath);
    const discoveries = captures.filter((capture) => capture.type === 'resources-discover');
    const providers = captures.filter((capture) => capture.type === 'provider');
    assert.equal(discoveries.length, 2);
    assert.equal(providers.length, 2);
    const expectedPaths = resolved.effectiveSkills.map((skill) => skill.definitionPath);
    for (const [index, discovery] of discoveries.entries()) {
      assert.equal(discovery.piVersion, piVersion);
      assert.equal(discovery.cwd, runs[index].cwd);
      assert.equal(discovery.compatible, true);
      assert.equal(discovery.groupingRootRequested, false);
      assert.deepEqual(discovery.skillPaths, expectedPaths);
      assert.equal(discovery.skillPaths.includes(resolved.directMembership.sourceRoot), false);
      assert.deepEqual(
        discovery.loaded.map(({ diagnostics, skills }) => ({ diagnostics, skills })),
        resolved.effectiveSkills.map((skill) => ({
          diagnostics: [],
          skills: [{
            filePath: skill.definitionPath,
            baseDir: skill.skillRoot,
            name: skill.declaredName
          }]
        }))
      );
    }
    for (const provider of providers) {
      assert.equal(provider.definitionPathsInPrompt.every(({ present }) => present), true);
    }

    const sharedReferences = [];
    for (const skill of discoveries[0].loaded.flatMap((entry) => entry.skills)) {
      const sharedPath = await realpath(resolve(skill.baseDir, '../shared/reference.md'));
      assert.equal(isWithin(sharedPath, resolved.directMembership.sourceRoot), true);
      const contents = await readFile(sharedPath, 'utf8');
      assert.equal(contents, 'provider-owned shared reference\n');
      sharedReferences.push({
        childBase: skill.baseDir,
        canonicalPath: sharedPath,
        contents
      });
    }
    assert.equal(new Set(sharedReferences.map(({ canonicalPath }) => canonicalPath)).size, 1);
    const immutable = await assertImmutable(fixture);
    return {
      directMembership: resolved.directMembership,
      effectiveSkills: resolved.effectiveSkills,
      runs,
      discoveries,
      sharedReferences,
      manifestEntryCounts: {
        provider: immutable.after.provider.length,
        destinations: immutable.after.destinations.map((manifest) => manifest.length)
      },
      destinationGitStatus: immutable.statuses
    };
  } finally {
    await fixture.cleanup();
  }
}

async function runInvalidMetadataScenario(piVersion) {
  const fixture = await prepareFixture({
    sourceId: 'pi-invalid-source',
    sourceName: 'pi-invalid-source',
    setupHome: setupPiHome,
    populate: async ({ sourceRoot }) => {
      await writeSkill(join(sourceRoot, 'alpha'), 'alpha');
      await mkdir(join(sourceRoot, 'beta'), { recursive: true });
      await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '---\nname: beta\n---\n');
    }
  });
  try {
    const resolved = await resolveFixture(fixture);
    assert.equal(resolved.effectiveSkills.length, 2);
    const capturePath = join(fixture.bazframeHome, 'captures', 'invalid.jsonl');
    const configPath = join(fixture.bazframeHome, 'invalid-config.json');
    await writeFile(configPath, `${JSON.stringify({
      capturePath,
      scenario: 'invalid-metadata',
      sourceRoot: resolved.directMembership.sourceRoot,
      effectiveSkills: resolved.effectiveSkills
    }, null, 2)}\n`);
    const run = await runPi(
      fixture.destinationRoots[0],
      environmentFor(fixture, configPath),
      'source-unit invalid metadata probe'
    );
    assert.match(run.stdout, /probe-ok/u);
    const captures = await readJsonLines(capturePath);
    const discovery = captures.find((capture) => capture.type === 'resources-discover');
    const provider = captures.find((capture) => capture.type === 'provider');
    assert.ok(discovery);
    assert.ok(provider);
    assert.equal(discovery.piVersion, piVersion);
    assert.equal(discovery.compatible, false);
    assert.deepEqual(discovery.skillPaths, []);
    assert.equal(discovery.groupingRootRequested, false);
    assert.equal(
      discovery.loaded.some(({ diagnostics }) => diagnostics.length > 0),
      true,
      'Pi-specific invalid metadata produced no loader diagnostics.'
    );
    assert.equal(provider.definitionPathsInPrompt.every(({ present }) => !present), true);
    await assertImmutable(fixture);
    return { discovery, noDefinitionPathsInPrompt: true };
  } finally {
    await fixture.cleanup();
  }
}

export async function runRealPiProbe() {
  let piVersion;
  try {
    piVersion = (await execute(piExecutable, ['--version'], { encoding: 'utf8' })).stdout.trim();
  } catch (error) {
    throw new Error(
      `Real-Pi Stage 1 probe requires Pi 0.82.x but Pi was unavailable: ${error}`,
      { cause: error }
    );
  }
  if (!/^0\.82\./u.test(piVersion)) {
    throw new Error(`Real-Pi Stage 1 probe requires Pi 0.82.x; found ${piVersion}.`);
  }

  const positive = await runPositiveScenario(piVersion);
  const invalidMetadata = await runInvalidMetadataScenario(piVersion);
  return {
    schemaVersion: 1,
    experiment: 'provider-neutral-nested-source-unit-composition',
    piVersion,
    mechanicsResult: 'passed',
    mechanicsScope: 'pi-0.82-runtime-projection',
    projection: positive,
    invalidMetadata,
    claims: {
      groupingMembershipResolvedOnce: true,
      individualPiLoaderValidation: true,
      positiveProjectionNoLoaderDiagnostics: true,
      individualDefinitionPathsOnly: true,
      groupingRootNeverRequested: true,
      unrelatedGitWorkingDirectories: 2,
      originalBasesPreserved: true,
      sharedReferenceCanonicalTargetPreserved: true,
      compatibilityFailureReturnsNoSkillPaths: true,
      providerAndDestinationsUnchanged: true,
      destinationGitStatusUnchanged: true,
      isolatedWritableRoot: true
    }
  };
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  runRealPiProbe()
    .then((evidence) => process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
