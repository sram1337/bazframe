import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync as rawLstatSync, mkdirSync, readFileSync as rawReadFileSync, readdirSync as rawReaddirSync, realpathSync as rawRealpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { admitCandidate, aliasInvocation, assertNaturalResult, containedLink, createFreshRoot, installationPaths, inventory as rawInventory, isolatedEnvironment, jsonFile as rawJsonFile, parseCandidateOptions, retainedRunner, runSteps, saveJson, sha256, verifyInstalled, CandidateUncertainty, uncertainty, holdCandidateUncertainty, verifyCmdShim, verifyRegistryOrigins, installedPi } from './installed-candidate.mjs';

// ENOENT is an observed domain fact; unavailable metadata is uncertainty.
function observedMetadata(read, path) {
  return requiredEvidence(() => { try { return read(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }, 'Required metadata observation');
}
function presentMetadata(read, path) {
  const value = observedMetadata(read, path);
  assert.notEqual(value, undefined, `Expected existing metadata: ${path}`);
  return value;
}
const lstatSync = path => presentMetadata(rawLstatSync, path);
const realpathSync = path => presentMetadata(rawRealpathSync, path);
const readFileSync = (...args) => requiredEvidence(() => rawReadFileSync(...args), 'Required file read');
const readdirSync = (...args) => requiredEvidence(() => rawReaddirSync(...args), 'Required directory read');
const inventory = (...args) => requiredEvidence(() => rawInventory(...args), 'Required inventory');
const jsonFile = (...args) => requiredEvidence(() => rawJsonFile(...args), 'Required JSON file');
const skill = name => `---\nname: ${name}\ndescription: Task-owned installed acceptance fixture.\n---\n# ${name}\n`;
const instructions = 'Task-only portable instructions.\r\n';
const support = Buffer.from([0, 255, 13, 10, 65, 0]);
function put(path, bytes) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
function absent(path) { assert.equal(observedMetadata(rawLstatSync, path), undefined, `Expected absent: ${path}`); }
function sameBytes(path, bytes) { assert.deepEqual(readFileSync(path), Buffer.from(bytes), `Bytes differ: ${path}`); }
function snapshotPath(home, kind, id) { return join(home, 'skill-snapshots', 'sha256', jsonFile(join(home, `${kind === 'library' ? 'libraries' : 'packages'}`, `${id}.json`)).digest, 'artifact'); }
function state(home, id) { return jsonFile(join(home, 'profiles', id, '.bazframe-profile-state.json')); }

export async function runCandidate(argv, { piVersion } = {}) {
  assert(piVersion === undefined || ['0.84.4', '0.87.0', '1.5.2'].includes(piVersion), 'Only the reviewed Pi selection is admitted');
  const owners = [];
  try { return await runCandidateOwned(argv, owners, piVersion); }
  catch (error) {
    if (!(error instanceof CandidateUncertainty) && owners.length === 0) throw error;
    const root = argv[argv.indexOf('--root') + 1];
    return holdCandidateUncertainty(uncertainty(error, 'Candidate execution/evidence'), owners, root);
  }
}
function requiredEvidence(run, label) { try { const result = run(); return result?.then ? result.catch(error => { throw uncertainty(error, label); }) : result; } catch (error) { throw uncertainty(error, label); } }
async function runCandidateOwned(argv, owners, piVersion) {
  const options = parseCandidateOptions(argv);
  const candidate = admitCandidate(options.candidate, options.sha256, options['native-sha256']);
  // This is the operator's externally reviewed scope record, NOT an automatic
  // grant or a process containment proof. No native work is authorized by code.
  assert(lstatSync(options['ownership-record']).isFile(), 'Missing ownership scope record');
  const ownershipBytes = readFileSync(options['ownership-record']);
  if (options.zip) {
    assert(lstatSync(options.zip).isFile() && !lstatSync(options.zip).isSymbolicLink(), 'Reviewed ZIP must be physical');
    assert.equal(sha256(readFileSync(options.zip)), options['zip-sha256'], 'Reviewed ZIP digest mismatch');
  }
  assert.equal(realpathSync(join(dirname(process.execPath), process.platform === 'win32' ? 'node.exe' : 'node')), realpathSync(process.execPath), 'Alias PATH must resolve the selected Node');
  const npmCli = realpathSync(options['npm-cli']);
  let npmRoot = dirname(npmCli);
  while (!existsSync(join(npmRoot, 'package.json'))) { const parent = dirname(npmRoot); assert.notEqual(parent, npmRoot, 'npm package root not found'); npmRoot = parent; }
  assert.equal(jsonFile(join(npmRoot, 'package.json')).name, 'npm');
  if (process.platform === 'win32') {
    assert.equal(basename(process.execPath).toLowerCase(), 'node.exe', 'npm aliases must resolve the selected node.exe');
    const cmd = join(process.env.SystemRoot ?? process.env.SYSTEMROOT, 'System32', 'cmd.exe');
    aliasInvocation(join(options.root, 'prefix', 'bzf.cmd'), [options.root, options.candidate, npmCli, process.execPath, ...(options.zip ? [options.zip] : [])], 'win32', cmd);
  }
  createFreshRoot(options.root);
  const report = { candidate: { path: options.candidate, sha256: candidate.sha256, nativeSha256: candidate.nativeSha256, source: options.source, sourceBinding: 'operator-supplied; tarball digest is verified', version: candidate.manifest.version }, environment: { platform: process.platform, arch: process.arch, node: process.version, executable: process.execPath, nodeSha256: sha256(readFileSync(process.execPath)), npmCli, npmVersion: jsonFile(join(npmRoot, 'package.json')).version }, install: options.install, ownership: { path: options['ownership-record'], sha256: sha256(ownershipBytes), descendantSettlement: 'not-established', requirement: 'External ownership/admission must cover npm, CMD/CLI and package Node build; Git/Pi/editor are not exercised.' }, installation: [], cells: [], retainedRoot: options.root };
  const persist = () => requiredEvidence(() => saveJson(join(options.root, 'results.json'), report), 'Required candidate report');
  persist();
  put(join(options.root, 'ownership-record'), ownershipBytes);
  saveJson(join(options.root, 'candidate-members.json'), Object.fromEntries([...candidate.members].map(([name, entry]) => [name, { sha256: entry.sha256, bytes: entry.bytes, mode: entry.mode }])));
  // Bind harness and complete npm bytes before installation; dependencies are
  // captured after npm resolution, not guessed from an older installation.
  const npmInventory = inventory(npmRoot);
  saveJson(join(options.root, 'npm-inventory.json'), npmInventory);
  for (const [key, entry] of Object.entries(npmInventory)) if (entry.kind === 'link') containedLink(join(npmRoot, key), npmRoot);
  for (const name of ['test-pack.mjs', 'test-pack-candidate.mjs', 'installed-candidate.mjs']) put(join(options.root, 'harness', name), readFileSync(fileURLToPath(new URL(name, import.meta.url))));
  const prefix = join(options.root, 'prefix'); mkdirSync(prefix);
  const env = isolatedEnvironment(join(options.root, 'install-environment'), prefix);
  env.npm_config_registry = 'https://registry.npmjs.org/';
  env.npm_config_git = join(options.root, 'disabled-git-acquisition');
  absent(env.npm_config_git);
  const paths = installationPaths(prefix, options.install);
  if (process.platform === 'win32') report.environment.cmd = { path: env.ComSpec, sha256: sha256(readFileSync(env.ComSpec)) };
  const run = retainedRunner(join(options.root, 'install-evidence'), owners);
  let binding;
  const installOK = await runSteps([
    { name: 'npm-version', run: async () => { const result = await run('npm-version', { file: process.execPath, args: [npmCli, '--version'] }, prefix, env); assertNaturalResult(result); assert.equal(result.stdout.toString().trim(), report.environment.npmVersion); return { evidence: result.evidence }; } },
    { name: 'install-exact-candidate', run: async () => {
      requiredEvidence(() => {
        admitCandidate(options.candidate, options.sha256, options['native-sha256']);
        assert.deepEqual(inventory(npmRoot), npmInventory, 'npm changed before installation');
        assert.equal(sha256(readFileSync(process.execPath)), report.environment.nodeSha256, 'Node changed before installation'); absent(env.npm_config_git);
      }, 'Preinstall input admission');
      put(join(prefix, 'package.json'), JSON.stringify({ name: 'candidate-acceptance-fixture', private: true, version: '1.0.0' }));
      const result = await run('install', { file: process.execPath, args: [npmCli, 'install', ...(options.install === 'global' ? ['--global'] : []), '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=true', ...(piVersion ? ['--prefer-dedupe', `@earendil-works/pi-coding-agent@${piVersion}`] : []), options.candidate] }, prefix, env);
      assertNaturalResult(result); return { evidence: result.evidence };
    } },
    { name: 'admit-installed-members-and-dependencies', run: async () => {
      try {
      verifyInstalled(paths.packageRoot, candidate);
      const tree = inventory(paths.modules);
      requiredEvidence(() => saveJson(join(options.root, 'installed-inventory.json'), tree), 'Required installed inventory receipt');
      for (const [key, item] of Object.entries(tree)) if (item.kind === 'link') containedLink(join(paths.modules, key), paths.modules);
      const launchers = {}, generatedLaunchers = {};
      for (const alias of ['bazframe', 'bzf']) {
        const path = join(paths.bin, alias + (process.platform === 'win32' ? '.cmd' : ''));
        assert.equal(realpathSync(join(paths.packageRoot, candidate.manifest.bin[alias])), join(paths.packageRoot, 'dist', 'cli.js'));
        if (process.platform !== 'win32') assert.equal(realpathSync(path), join(paths.packageRoot, 'dist', 'cli.js'));
        else { verifyCmdShim(path, join(paths.packageRoot, 'dist', 'cli.js')); absent(join(paths.bin, 'node.exe')); }
        launchers[alias] = { path, sha256: sha256(readFileSync(path)) };
        for (const suffix of process.platform === 'win32' ? ['', '.cmd', '.ps1'] : ['']) {
          const generated = join(paths.bin, alias + suffix);
          const bytes = readFileSync(generated);
          generatedLaunchers[generated] = sha256(bytes);
          put(join(options.root, 'launchers', alias + suffix), bytes);
        }
      }
      const pi = installedPi(paths);
      if (piVersion) assert.equal(pi.version, piVersion, 'Explicit Pi selection did not resolve at candidate dependency position');
      report.environment.piSelection = piVersion ? { spec: `@earendil-works/pi-coding-agent@${piVersion}`, preferDedupe: true, scope: 'Pi-only explicit additional install selection; ordinary pack installation unchanged' } : null;
      assert.deepEqual(inventory(npmRoot), npmInventory, 'npm changed before dependency listing');
      assert.equal(sha256(readFileSync(process.execPath)), report.environment.nodeSha256, 'Node changed before dependency listing');
      const result = await run('npm-query', { file: process.execPath, args: [npmCli, 'query', '*', '--json', ...(options.install === 'global' ? ['--global'] : []), '--prefix', prefix] }, prefix, env);
      assertNaturalResult(result);
      const lockPath = [join(prefix, 'package-lock.json'), join(paths.modules, '.package-lock.json')].find(existsSync);
      // Retain the actual admission inputs before parsing/asserting origins.
      // npm-query's raw streams already belong to the retained runner evidence.
      const lockBytes = lockPath ? readFileSync(lockPath) : undefined;
      requiredEvidence(() => {
        if (lockBytes) put(join(options.root, 'resolved-package-lock.json'), lockBytes);
        saveJson(join(options.root, 'origin-inputs.json'), { candidate: options.candidate, originRoot: dirname(paths.modules), modules: paths.modules, queryEvidence: result.evidence, lock: lockPath ?? null });
      }, 'Required origin input receipt');
      const origins = verifyRegistryOrigins(JSON.parse(result.stdout.toString()), options.candidate, lockBytes ? JSON.parse(lockBytes.toString()) : undefined, dirname(paths.modules), { modules: paths.modules, allowUnreported: options.install === 'global' });
      report.environment.acquisition = { registry: env.npm_config_registry, gitExecutable: env.npm_config_git, origins, lock: lockPath ?? 'Global npm supplies no lock; missing origins explicitly unreported, not inferred' };
      binding = { tree, launchers, generatedLaunchers };
      report.environment.pi = pi;
      assert.deepEqual(inventory(npmRoot), npmInventory, 'npm changed during installation');
      return { evidence: result.evidence, packageRoot: paths.packageRoot, launchers, generatedLaunchers, memberCount: candidate.members.size, inventoryEntries: Object.keys(tree).length };
      } catch (error) { throw uncertainty(error, 'Installed closure/launcher/origin admission'); }
    } }
  ], report.installation, persist);

  const aliases = options.alias === 'both' ? ['bazframe', 'bzf'] : [options.alias];
  const batches = options.batch === 'all' ? ['dispatch', 'resources', 'zip'] : [options.batch];
  for (const alias of aliases) for (const batch of batches) {
    const cell = { alias, batch, install: options.install, node: process.version, operations: [] }; report.cells.push(cell); persist();
    if (!installOK) {
      const root = join(options.root, `${alias}-${batch}`);
      const context = { root, home: join(root, 'home'), zip: options.zip, environment: { PI_CODING_AGENT_DIR: join(root, 'pi') } };
      const steps = batch === 'dispatch' ? dispatchSteps(context) : batch === 'resources' ? resourceSteps(context) : zipSteps(context);
      for (const step of steps) cell.operations.push({ operation: step.name, ...step.metadata, status: 'not-run', reason: 'Installation/admission failed' });
      persist(); continue;
    }
    const root = join(options.root, `${alias}-${batch}`); mkdirSync(root);
    const environment = isolatedEnvironment(root, prefix);
    const cwd = join(root, 'cwd'); mkdirSync(cwd);
    const context = { root, home: environment.BAZFRAME_HOME, environment, cwd, alias, zip: options.zip, zipSha256: options['zip-sha256'], executable: binding.launchers[alias].path, version: candidate.manifest.version, run: retainedRunner(join(root, 'evidence'), owners), packageRoot: paths.packageRoot };
    const revalidate = () => requiredEvidence(() => {
      admitCandidate(options.candidate, options.sha256, options['native-sha256']);
      verifyInstalled(paths.packageRoot, candidate);
      assert.deepEqual(inventory(paths.modules), binding.tree, 'Installed dependency bytes changed');
      for (const [path, digest] of Object.entries(binding.generatedLaunchers)) assert.equal(sha256(readFileSync(path)), digest, 'Launcher changed');
      assert.equal(sha256(readFileSync(process.execPath)), report.environment.nodeSha256, 'Node changed');
      if (report.environment.cmd) {
        assert.equal(sha256(readFileSync(report.environment.cmd.path)), report.environment.cmd.sha256, 'CMD changed');
        absent(join(paths.bin, 'node.exe'));
      }
    }, 'Installed bytes changed or admission evidence unavailable');
    await runSteps([{ name: 'revalidate-installation', run: revalidate }, ...(batch === 'dispatch' ? dispatchSteps(context) : batch === 'resources' ? resourceSteps(context) : zipSteps(context)), { name: 'revalidate-after-batch', run: revalidate }], cell.operations, persist);
  }
  report.ownerCount = owners.length;
  report.ownerDisposition = 'Original ChildProcess objects retained through final evidence I/O; natural direct-child exit/close only. No descendant or PID-absence claim.';
  persist();
  const failed = [...report.installation, ...report.cells.flatMap(cell => cell.operations)].some(operation => operation.status === 'failed');
  console.log(`Candidate ${failed ? 'FAILED' : 'checked'}; retained evidence: ${options.root}`);
  if (failed) process.exitCode = 1;
  return report;
}

// Every command captures raw bytes, parsed result and before/after disk manifests.
// A failed assertion leaves the original result and possible effects untouched.
// Domain-only equality is deliberately opt-in for five mutating refusals.
// Raw manifests still include every lock byte; this is not lock certification.
function domainManifest(manifest) {
  if (manifest === null) return null;
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => !['locks', 'profile-publishing/operation-locks'].some(root => key === root || key.startsWith(`${root}/`))));
}
// Ordinary import may refresh its existing recovery owners before collision consent.
// Keep namespace shape, guards and domain bytes exact. PID width can change owner size;
// neither this comparison nor the broader domain comparison certifies lock correctness.
function recoveryOwnerManifest(manifest, keys) {
  const result = { ...manifest };
  for (const key of keys) {
    const path = `profile-publishing/operation-locks/${sha256('bazframe-profile-operation-key-v1\0' + key)}/owner`;
    assert.equal(result[path]?.kind, 'file', 'Expected pre-existing physical recovery owner');
    result[path] = { ...result[path], sha256: '<refreshed-owner>', bytes: 0 };
  }
  return result;
}
function command(c, name, args, { code = 0, prose, errorCode, unchanged = false, domainUnchanged = false, recoveryOwnerKeys, check = () => {}, home = c.home, stderr = '' } = {}) {
  return { name, metadata: { argv: args, expectedExit: code, home }, run: async () => {
    const before = requiredEvidence(() => inventory(home), 'Before-state evidence');
    const sourcesBefore = requiredEvidence(() => c.sources ? inventory(c.sources) : null, 'Before-source evidence');
    const result = await c.run(name, aliasInvocation(c.executable, args, process.platform, c.environment.ComSpec), c.cwd, { ...c.environment, BAZFRAME_HOME: home });
    const after = requiredEvidence(() => inventory(home), 'After-state evidence');
    const sourcesAfter = requiredEvidence(() => c.sources ? inventory(c.sources) : null, 'After-source evidence');
    requiredEvidence(() => saveJson(`${result.evidence}.disk.json`, { home, before, after, sourcesBefore, sourcesAfter }), 'Required disk receipt');
    assertNaturalResult(result, result.code);
    if (stderr !== null) assert.equal(result.stderr.toString(), stderr);
    let document;
    if (args.includes('--json')) {
      document = requiredEvidence(() => JSON.parse(result.stdout.toString()), 'Required JSON response');
      requiredEvidence(() => saveJson(`${result.evidence}.parsed.json`, document), 'Required parsed receipt');
      if (/UNCERTAIN|INTERRUPTED/u.test(document.error?.code ?? '') || (document.error?.code === 'PACKAGE_BUILD_FAILED' && document.error.message !== 'Package build exited with status 7.')) throw new CandidateUncertainty(`Product child-work uncertainty: ${JSON.stringify(document.error)}`);
      const portable = args[0] === 'profile' && ['export', 'import'].includes(args[1]);
      assert.equal(document.schemaVersion, portable ? 2 : 1);
      if (code === 0 || !errorCode?.startsWith('CLI_')) {
        const expectedCommand = args[0] === 'profile' && ['skill', 'library', 'package'].includes(args[1]) ? args.slice(0, 3).join('.') : args.slice(0, 2).join('.');
        assert.equal(document.command, expectedCommand);
      }
      if (document.schemaVersion === 1) assert.equal(document.ok, code === 0);
      else assert.equal(document.outcome, code === 0 ? 'success' : code === 2 ? 'refusal' : 'error');
      if (errorCode) assert.equal((document.error ?? document.refusal)?.code, errorCode);
    }
    assertNaturalResult(result, code);
    if (prose) assert(result.stdout.toString().includes(prose), `Missing output: ${prose}`);
    if (unchanged) assert.deepEqual(after, before, 'Read/refusal mutated managed state');
    if (domainUnchanged) assert.deepEqual(process.platform === 'win32' ? domainManifest(after) : after, process.platform === 'win32' ? domainManifest(before) : before, 'Refusal mutated domain state');
    if (recoveryOwnerKeys) assert.deepEqual(process.platform === 'win32' ? recoveryOwnerManifest(after, recoveryOwnerKeys) : after, process.platform === 'win32' ? recoveryOwnerManifest(before, recoveryOwnerKeys) : before, 'Refusal mutated managed state outside expected recovery owners');
    if (!(args[0] === 'package' && ['add', 'build'].includes(args[1]))) assert.deepEqual(sourcesAfter, sourcesBefore, 'Unexpected source-owned mutation');
    await check(document, result);
    return { argv: args, expectedExit: code, outcome: code === 0 ? 'success' : 'expected-refusal', evidence: result.evidence, assertions: 'result/prose and disk predicates verified' };
  } };
}
function fixture(name, run) { return { name, run }; }

export function dispatchSteps(c) {
  const neutral = [
    command(c, 'version', ['--version'], { unchanged: true, check: (_, r) => assert.equal(r.stdout.toString(), `Bazframe ${c.version}\n`) }),
    command(c, 'help', ['help', 'profile', 'import'], { unchanged: true, prose: '<zip|git:user/repository>' }),
    command(c, 'malformed', ['not-a-command', '--json'], { code: 2, errorCode: 'CLI_USAGE', unchanged: true }),
    command(c, 'migration', ['profiles', '--json'], { code: 2, errorCode: 'CLI_MIGRATION_REQUIRED', unchanged: true, check: d => assert.equal(d.error.message, 'This command was removed. Use `bazframe profile list` instead.') })
  ];
  for (const [name, args] of [['help', ['help']], ['version', ['--version']], ['profile-edit', ['profile', 'edit', 'missing']], ['skill-edit', ['skill', 'edit', 'missing']], ['tui', ['tui']], ['pi', ['pi', '--dry-run']]]) neutral.push(command(c, `json-unsupported-${name}`, [...args, '--json'], { code: 2, errorCode: 'CLI_JSON_UNSUPPORTED', unchanged: true }));
  neutral.push(fixture('no-managed-bootstrap', () => { absent(c.home); absent(c.environment.PI_CODING_AGENT_DIR); }));
  return neutral;
}

function prepareResources(c) {
  const source = join(c.root, 'sources'); const added = join(source, 'added-skill'); const library = join(source, 'local-library'); const pkg = join(source, 'local-package');
  c.sources = source; c.added = added; c.library = library; c.pkg = pkg;
  const profile = id => join(c.home, 'profiles', id);
  const selected = () => sameBytes(join(c.home, 'active-profile'), 'rich\n');
  const parallel = id => { const link = join(profile(id), 'skills', 'added-skill'); assert(lstatSync(link).isSymbolicLink(), 'Membership must be a link, not a copy'); assert.equal(realpathSync(link), realpathSync(added)); assert.equal(realpathSync(join(c.home, 'skills', 'added-skill')), realpathSync(added)); };
  const steps = [fixture('prepare-local-fixtures', () => {
    absent(c.home);
    put(join(added, 'SKILL.md'), skill('added-skill')); put(join(added, 'support.bin'), support); put(join(added, 'crlf.txt'), 'first\r\nsecond\r\n');
    put(join(library, 'library-skill', 'SKILL.md'), skill('library-skill')); mkdirSync(join(source, 'empty-library'));
    put(join(pkg, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    put(join(pkg, 'build.mjs'), `import{mkdirSync,writeFileSync,appendFileSync,existsSync}from'node:fs';appendFileSync('build-count','build\\n');if(existsSync('fail-build')){writeFileSync('failed-source-effect','retained');process.exit(7)}mkdirSync('dist/skills/package-skill',{recursive:true});mkdirSync('dist/shared',{recursive:true});writeFileSync('dist/skills/package-skill/SKILL.md',${JSON.stringify(skill('package-skill'))});writeFileSync('dist/shared/support.bin',Buffer.from([0,255,13,10,65,0]));\n`);
  }),
  command(c, 'skill-first-add', ['skill', 'add', added], { prose: 'Default skill registration: added', check: () => { assert(lstatSync(join(c.home, 'skills', 'added-skill')).isSymbolicLink()); assert.equal(realpathSync(join(c.home, 'skills', 'added-skill')), realpathSync(added)); absent(join(c.home, 'active-profile')); } }),
  command(c, 'skill-idempotent', ['skill', 'add', added], { prose: 'Default skill registration: current' }),
  command(c, 'skill-list', ['skill', 'list'], { unchanged: true, prose: 'added-skill' }),
  command(c, 'profile-add', ['profile', 'add', 'rich', '--json'], { check: d => { assert.equal(d.command, 'profile.add'); sameBytes(join(profile('rich'), 'AGENTS.md'), ''); absent(join(c.home, 'active-profile')); } }),
  command(c, 'profile-add-second', ['profile', 'add', 'other'], { prose: 'Profile lifecycle: added' }),
  command(c, 'profile-use', ['profile', 'use', 'rich'], { prose: 'Active profile: rich', check: selected }),
  fixture('author-rich-profile', () => { put(join(profile('rich'), 'AGENTS.md'), instructions); put(join(profile('rich'), 'skills', 'physical-skill', 'SKILL.md'), skill('physical-skill')); put(join(profile('rich'), 'skills', 'physical-skill', 'support.bin'), support); put(join(profile('rich'), 'skills', 'physical-skill', 'run.sh'), '#!/bin/sh\nprintf fixture\\n\n'); if (process.platform !== 'win32') chmodSync(join(profile('rich'), 'skills', 'physical-skill', 'run.sh'), 0o755); }),
  command(c, 'library-add', ['library', 'add', library, '--json'], { check: d => { assert.equal(d.command, 'library.add'); sameBytes(join(snapshotPath(c.home, 'library', 'local-library'), 'library-skill', 'SKILL.md'), skill('library-skill')); } }),
  command(c, 'empty-library-add', ['library', 'add', join(source, 'empty-library')], { prose: 'Global library: added' }),
  command(c, 'empty-library-list', ['library', 'list'], { unchanged: true, prose: 'Skills:0' }),
  command(c, 'package-add-build', ['package', 'add', pkg, '--json'], { check: d => { assert.equal(d.command, 'package.add'); sameBytes(join(pkg, 'build-count'), 'build\n'); sameBytes(join(snapshotPath(c.home, 'package', 'local-package'), 'shared', 'support.bin'), support); } })];
  for (const [kind, id] of [['skill', 'added-skill'], ['library', 'local-library'], ['package', 'local-package']]) {
    for (const target of ['rich', 'other']) steps.push(command(c, `${kind}-reference-${target}`, ['profile', kind, 'add', id, ...(target === 'other' ? ['--profile', target] : []), '--json'], { check: d => {
      assert.equal(d.command, `profile.${kind}.add`); selected();
      if (kind === 'skill') parallel(target);
      else { assert.equal(jsonFile(join(profile(target), `${kind === 'library' ? 'libraries' : 'packages'}`, `${id}.json`))[kind], id); assert.equal(d.result.profileTarget.id, target); }
      sameBytes(join(pkg, 'build-count'), 'build\n');
    } }));
    steps.push(command(c, `${kind}-reference-idempotent`, ['profile', kind, 'add', id, '--json'], { check: d => assert.equal(d.command, `profile.${kind}.add`) }));
    steps.push(command(c, `${kind}-profile-list`, ['profile', kind, 'list'], { unchanged: true, prose: kind === 'skill' ? 'added-skill' : kind === 'library' ? 'library-skill' : 'package-skill', check: () => sameBytes(join(pkg, 'build-count'), 'build\n') }));
    steps.push(command(c, `${kind}-referenced-remove-refusal`, [kind, 'remove', id, '--json'], { code: 1, domainUnchanged: true, check: d => { assert.equal(d.command, `${kind}.remove`); assert.match(d.error.message, /referenc|profile|use/iu); } }));
  }
  steps.push(command(c, 'package-list', ['package', 'list', '--json'], { unchanged: true, check: d => {
    const item = d.result.collections.find(item => item.id === 'local-package');
    assert.equal(item.health, 'ready'); assert.equal(item.referenceCount, 2); assert.equal(item.digest, jsonFile(join(c.home, 'packages', 'local-package.json')).digest);
    sameBytes(join(pkg, 'build-count'), 'build\n');
  } }));
  return steps;
}

export function resourceSteps(c) {
  const steps = prepareResources(c);
  let libraryRecord, packageRecord, oldSnapshot, sourceBeforeRemoval, renamedBefore;
  const record = kind => join(c.home, kind === 'library' ? 'libraries' : 'packages', `local-${kind}.json`);
  steps.push(
    fixture('prepare-library-update', () => { libraryRecord = readFileSync(record('library')); oldSnapshot = inventory(snapshotPath(c.home, 'library', 'local-library')); put(join(c.library, 'revision.txt'), 'revision two\r\n'); }),
    command(c, 'library-update', ['library', 'update', 'local-library', '--json'], { check: () => { assert.notDeepEqual(readFileSync(record('library')), libraryRecord); sameBytes(join(snapshotPath(c.home, 'library', 'local-library'), 'revision.txt'), 'revision two\r\n'); assert.deepEqual(inventory(join(c.home, 'skill-snapshots', 'sha256', JSON.parse(libraryRecord).digest, 'artifact')), oldSnapshot); } }),
    fixture('prepare-dependent-collision', () => { libraryRecord = readFileSync(record('library')); oldSnapshot = inventory(snapshotPath(c.home, 'library', 'local-library')); put(join(c.home, 'profiles', 'other', 'skills', 'collision-skill', 'SKILL.md'), skill('collision-skill')); put(join(c.library, 'collision-skill', 'SKILL.md'), skill('collision-skill')); }),
    command(c, 'library-all-profiles-collision-refusal', ['library', 'update', 'local-library', '--json'], { code: 1, check: d => { assert.match(d.error.message, /other/u); sameBytes(record('library'), libraryRecord); assert.deepEqual(inventory(snapshotPath(c.home, 'library', 'local-library')), oldSnapshot); } }),
    command(c, 'package-explicit-build', ['package', 'build', 'local-package', '--json'], { check: () => sameBytes(join(c.pkg, 'build-count'), 'build\nbuild\n') }),
    fixture('prepare-failed-build', () => { packageRecord = readFileSync(record('package')); oldSnapshot = inventory(snapshotPath(c.home, 'package', 'local-package')); put(join(c.pkg, 'fail-build'), 'fail next explicit build'); }),
    command(c, 'package-build-refusal', ['package', 'build', 'local-package', '--json'], { code: 1, errorCode: 'PACKAGE_BUILD_FAILED', stderr: null, check: d => { assert.equal(d.error.message, 'Package build exited with status 7.'); sameBytes(record('package'), packageRecord); assert.deepEqual(inventory(snapshotPath(c.home, 'package', 'local-package')), oldSnapshot); sameBytes(join(c.pkg, 'failed-source-effect'), 'retained'); sameBytes(join(c.pkg, 'build-count'), 'build\nbuild\nbuild\n'); } }),
    fixture('seed-rich-favorite', () => put(join(c.home, 'profile-favorites.json'), `${JSON.stringify({ schemaVersion: 1, favorites: ['rich'] }, null, 2)}\n`)),
    command(c, 'rich-duplicate', ['profile', 'duplicate', 'rich', 'rich-copy', '--json'], { check: d => { assert.equal(d.command, 'profile.duplicate'); assert.deepEqual(jsonFile(join(c.home, 'profile-favorites.json')).favorites, ['rich']); sameBytes(join(c.home, 'profiles', 'rich-copy', 'AGENTS.md'), instructions); assert.equal(realpathSync(join(c.home, 'profiles', 'rich-copy', 'skills', 'added-skill')), realpathSync(c.added)); assert.deepEqual(inventory(join(c.home, 'profiles', 'rich-copy', 'skills', 'physical-skill')), inventory(join(c.home, 'profiles', 'rich', 'skills', 'physical-skill')), 'Complete physical Skill payload must survive duplicate'); for (const [directory, id] of [['libraries', 'local-library'], ['packages', 'local-package']]) sameBytes(join(c.home, 'profiles', 'rich-copy', directory, `${id}.json`), readFileSync(join(c.home, 'profiles', 'rich', directory, `${id}.json`))); sameBytes(join(c.home, 'active-profile'), 'rich\n'); } }),
    fixture('capture-rich-before-rename', () => { renamedBefore = inventory(join(c.home, 'profiles', 'rich')); }),
    command(c, 'active-rename', ['profile', 'rename', 'rich', 'renamed', '--json'], { check: () => { absent(join(c.home, 'profiles', 'rich')); assert.deepEqual(inventory(join(c.home, 'profiles', 'renamed')), renamedBefore); sameBytes(join(c.home, 'active-profile'), 'renamed\n'); assert.deepEqual(jsonFile(join(c.home, 'profile-favorites.json')).favorites, ['renamed']); } }),
    command(c, 'profile-current', ['profile', 'current'], { unchanged: true, check: (_, r) => assert.equal(r.stdout.toString(), 'renamed\n') }),
    command(c, 'profile-list', ['profile', 'list'], { unchanged: true, prose: 'renamed (active)' }),
    command(c, 'active-force-remove-refusal', ['profile', 'remove', 'renamed', '--force', '--json'], { code: 1, domainUnchanged: true, check: d => assert.match(d.error.message, /active profile/iu) }),
    command(c, 'select-other', ['profile', 'use', 'other'], { check: () => sameBytes(join(c.home, 'active-profile'), 'other\n'), prose: 'Active profile: other' }),
    command(c, 'rich-remove-guard-refusal', ['profile', 'remove', 'renamed', '--json'], { code: 1, domainUnchanged: true, errorCode: 'PROFILE_NOT_EMPTY', check: d => assert.match(d.error.message, /not generated-empty.*cannot be removed/u) }),
    fixture('capture-sources-before-removal', () => { sourceBeforeRemoval = inventory(c.sources); }),
    command(c, 'rich-force-remove', ['profile', 'remove', 'renamed', '--force', '--json'], { check: () => {
      absent(join(c.home, 'profiles', 'renamed')); assert.deepEqual(inventory(c.sources), sourceBeforeRemoval);
      assert.deepEqual(jsonFile(join(c.home, 'profile-favorites.json')).favorites, []);
      const retained = readdirSync(join(c.home, 'profiles')).filter(name => name.startsWith('.bazframe-backup-'));
      assert(retained.some(name => JSON.stringify(inventory(join(c.home, 'profiles', name))) === JSON.stringify(renamedBefore)), 'Exact removed profile must remain retained');
    } })
  );
  for (const [kind, id] of [['skill', 'added-skill'], ['library', 'local-library'], ['package', 'local-package']]) {
    for (const target of ['other', 'rich-copy']) steps.push(command(c, `detach-${kind}-${target}`, ['profile', kind, 'remove', id, ...(target === 'other' ? [] : ['--profile', target]), '--json'], { check: d => { assert.equal(d.result.action, 'removed', 'Detach must remove an existing membership'); absent(join(c.home, 'profiles', target, kind === 'skill' ? 'skills' : kind === 'library' ? 'libraries' : 'packages', kind === 'skill' ? id : `${id}.json`)); sameBytes(join(c.home, 'active-profile'), 'other\n'); } }));
    steps.push(command(c, `remove-${kind}`, [kind, 'remove', id, '--json'], { check: () => { absent(join(c.home, kind === 'skill' ? 'skills' : kind === 'library' ? 'libraries' : 'packages', kind === 'skill' ? id : `${id}.json`)); assert.deepEqual(inventory(c.sources), sourceBeforeRemoval); } }));
  }
  steps.push(command(c, 'remove-empty-library', ['library', 'remove', 'empty-library', '--json'], { check: () => absent(join(c.home, 'libraries', 'empty-library.json')) }));
  return steps;
}

// ZIP parsing uses the admitted installed dependency, never source/dist product
// imports. Keep exact file bytes and metadata in the evidence without extraction.
async function zipContents(c, archive) {
  const yauzl = createRequire(join(c.packageRoot, 'package.json'))('yauzl');
  return requiredEvidence(() => new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
    if (error) { reject(error); return; }
    const entries = {};
    let failure, ended = false;
    const failed = error => { failure ??= error; zip.close(); };
    zip.on('error', failed);
    zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
      if (error) { failed(error); return; }
      let streamEnded = false;
      stream.on('close', () => { if (!streamEnded) failed(new Error('ZIP entry stream closed before end')); });
      const chunks = []; stream.on('data', bytes => chunks.push(bytes)); stream.on('error', failed);
      stream.on('end', () => { streamEnded = true; if (failure) return; const bytes = Buffer.concat(chunks); entries[entry.fileName] = { sha256: sha256(bytes), bytes: bytes.length, unixMode: entry.externalFileAttributes >>> 16, content: bytes.toString('base64') }; zip.readEntry(); });
    }));
    zip.on('end', () => { ended = true; });
    zip.on('close', () => { if (failure) reject(failure); else if (!ended) reject(new Error('ZIP closed before end')); else resolve(entries); });
    zip.readEntry();
  })), 'Required ZIP open/read/completion');
}

export function zipSteps(c) {
  const steps = c.zip ? [] : prepareResources(c);
  const archive = c.zip ?? join(c.root, 'mixed profile.zip'); const targetHome = join(c.root, 'import-home'); const out = join(c.root, 'roundtrip.zip');
  let archiveHash, entries, importedState, preOverwrite, sourceSnapshot;
  const target = (name, args, options = {}) => command(c, name, args, { ...options, home: targetHome });
  const validateArchive = async () => {
      archiveHash = sha256(readFileSync(archive));
      if (c.zip) requiredEvidence(() => assert.equal(archiveHash, c.zipSha256, 'Reviewed ZIP changed'), 'External ZIP re-admission');
      entries = await zipContents(c, archive);
      const digests = Object.values(entries).map(entry => entry.sha256);
      for (const bytes of [instructions, skill('physical-skill'), skill('added-skill'), skill('library-skill'), skill('package-skill'), support, 'first\r\nsecond\r\n']) assert(digests.includes(sha256(bytes)), 'Missing mixed ZIP payload');
      for (const entry of Object.values(entries)) { const text = Buffer.from(entry.content, 'base64').toString(); assert(!text.includes(c.root), 'ZIP leaked source machine path'); assert(!text.includes('profileInstanceId'), 'ZIP leaked profile identity'); }
      const manifest = JSON.parse(Buffer.from(entries['bazframe-profile.json'].content, 'base64').toString());
      assert.equal(manifest.kind, 'bazframe-captured-profile');
      assert.deepEqual(manifest.resources.map(resource => `${resource.key.kind}:${resource.key.name}`).sort(), ['library:local-library', 'package:local-package', 'skill:added-skill', 'skill:physical-skill']);
      const physical = manifest.resources.find(resource => resource.key.name === 'physical-skill');
      assert.equal(physical.payload.sourceForm, 'profile-local');
      if (c.zip || process.platform !== 'win32') assert(physical.payload.files.some(file => file.path === 'run.sh' && file.executable === true), 'Missing logical executable metadata');
      requiredEvidence(() => saveJson(join(c.root, 'zip-contents.json'), { archive, archiveHash, entries, inspectionHost: process.platform, source: c.zip ? 'reviewed-external-input' : 'public-export-in-this-cell' }), 'Required ZIP receipt');
      if (c.sources) assert.deepEqual(inventory(c.sources), sourceSnapshot);
  };
  if (c.zip) steps.push(fixture('admit-reviewed-zip', validateArchive));
  else steps.push(
    fixture('capture-build-free-export-inputs', () => { sourceSnapshot = inventory(c.sources); }),
    command(c, 'mixed-export', ['profile', 'export', '--profile', 'rich', '--output', archive, '--json'], { check: async d => {
      assert.equal(d.schemaVersion, 2); assert.equal(d.command, 'profile.export'); assert.equal(d.result.profile.name, 'rich'); assert.equal(d.result.overwritten, false);
      await validateArchive();
    } })
  );
  steps.push(
    target('zip-dry-run', ['profile', 'import', archive, '--dry-run', '--json'], { unchanged: true, check: d => { assert.equal(d.result.mode, 'dry-run'); assert.equal(d.result.profile, null); assert(Object.values(d.result.effects).every(value => value === false)); absent(targetHome); assert.equal(sha256(readFileSync(archive)), archiveHash); } }),
    target('zip-fresh-import', ['profile', 'import', archive, '--json'], { check: d => { assert.equal(d.result.profile.name, 'rich'); assert.equal(d.result.profile.active, false); assert.equal(d.result.profile.publication, null); sameBytes(join(targetHome, 'profiles', 'rich', 'AGENTS.md'), instructions); sameBytes(join(targetHome, 'profiles', 'rich', 'skills', 'physical-skill', 'support.bin'), support); absent(join(targetHome, 'active-profile')); importedState = state(targetHome, 'rich'); assert(importedState.importedResources.length >= 3); } }),
    target('zip-activate', ['profile', 'use', 'rich'], { prose: 'Active profile: rich', check: () => sameBytes(join(targetHome, 'active-profile'), 'rich\n') }),
    target('zip-collision-refusal', ['profile', 'import', archive, '--json'], { code: 2, errorCode: 'PROFILE_IMPORT_COLLISION_DECISION_REQUIRED', recoveryOwnerKeys: ['@store', 'rich'], check: () => assert.equal(sha256(readFileSync(archive)), archiveHash ?? c.zipSha256, 'ZIP changed during collision refusal') }),
    target('zip-safe-suffix', ['profile', 'import', archive, '--yes', '--json'], { check: d => { assert.equal(d.result.resolvedName, 'rich-1'); assert.equal(d.result.collisionResolution, 'safe-suffix'); sameBytes(join(targetHome, 'profiles', 'rich-1', 'AGENTS.md'), instructions); assert.deepEqual(state(targetHome, 'rich'), importedState); sameBytes(join(targetHome, 'active-profile'), 'rich\n'); } }),
    fixture('seed-managed-favorite', () => put(join(targetHome, 'profile-favorites.json'), `${JSON.stringify({ schemaVersion: 1, favorites: ['rich'] }, null, 2)}\n`)),
    target('managed-rich-duplicate', ['profile', 'duplicate', 'rich', 'copy', '--json'], { check: () => {
      const copy = state(targetHome, 'copy'); assert.notEqual(copy.profileInstanceId, importedState.profileInstanceId); assert.equal(copy.publication, null);
      assert.deepEqual(copy.importedResources, importedState.importedResources);
      const old = importedState.capturedResourceIds.filter(item => item.identityKind === 'profileLocal').map(item => item.instanceId);
      const fresh = copy.capturedResourceIds.filter(item => item.identityKind === 'profileLocal').map(item => item.instanceId);
      assert(old.length > 0 && fresh.length === old.length && fresh.every(id => !old.includes(id)), 'Profile-local identities must change');
      assert.deepEqual(jsonFile(join(targetHome, 'profile-favorites.json')).favorites, ['rich']);
    } }),
    target('managed-active-rename', ['profile', 'rename', 'rich', 'renamed', '--json'], { check: () => { assert.deepEqual(state(targetHome, 'renamed'), importedState); sameBytes(join(targetHome, 'active-profile'), 'renamed\n'); } }),
    target('managed-rename-back', ['profile', 'rename', 'renamed', 'rich', '--json'], { check: () => { assert.deepEqual(state(targetHome, 'rich'), importedState); sameBytes(join(targetHome, 'active-profile'), 'rich\n'); } }),
    fixture('author-before-overwrite', () => { put(join(targetHome, 'profiles', 'rich', 'AGENTS.md'), 'local change retained\n'); preOverwrite = inventory(join(targetHome, 'profiles', 'rich')); }),
    target('zip-active-overwrite', ['profile', 'import', archive, '--overwrite', '--json'], { check: d => {
      assert.equal(d.result.collisionResolution, 'overwrite'); assert.equal(d.result.profile.active, true); sameBytes(join(targetHome, 'active-profile'), 'rich\n'); sameBytes(join(targetHome, 'profiles', 'rich', 'AGENTS.md'), instructions);
      assert(readdirSync(join(targetHome, 'profiles')).filter(name => name.startsWith('.bazframe-backup-')).some(name => JSON.stringify(inventory(join(targetHome, 'profiles', name))) === JSON.stringify(preOverwrite)), 'Missing exact retained overwrite state');
    } }),
    target('zip-reexport', ['profile', 'export', '--profile', 'rich', '--output', out, '--json'], { check: async () => {
      const roundtrip = await zipContents(c, out); requiredEvidence(() => saveJson(join(c.root, 'roundtrip-contents.json'), roundtrip), 'Required roundtrip receipt');
      assert.deepEqual(roundtrip, entries, 'Canonical ZIP payload or executable metadata changed'); assert.equal(sha256(readFileSync(out)), archiveHash, 'Deterministic re-export differs');
    } }),
    target('zip-occupied-output-refusal', ['profile', 'export', '--profile', 'rich', '--output', out, '--json'], { code: 2, errorCode: 'PROFILE_ZIP_OUTPUT_OCCUPIED', unchanged: true, check: () => assert.equal(sha256(readFileSync(out)), archiveHash) }),
    target('zip-explicit-output-replacement', ['profile', 'export', '--profile', 'rich', '--output', out, '--overwrite', '--json'], { check: d => { assert.equal(d.result.overwritten, true); assert.equal(sha256(readFileSync(out)), archiveHash); assert.equal(sha256(readFileSync(archive)), archiveHash); if (c.sources) assert.deepEqual(inventory(c.sources), sourceSnapshot); } })
  );
  return steps;
}
