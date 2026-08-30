#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_ID_LENGTH = 64;
const GITHUB_HOST = 'github.com';
const SKIPPED_SOURCE_NAMES = new Set(['.git', 'node_modules']);
const SECRET_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa'
]);
const PRIVATE_KEY_MARKERS = [
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----'
].map((value) => Buffer.from(value, 'utf8'));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] !== undefined
  && await realpath(resolve(process.argv[1])).catch(() => resolve(process.argv[1]))
    === await realpath(SCRIPT_PATH).catch(() => SCRIPT_PATH);

class BazifyError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

if (IS_MAIN) {
  try {
    const result = await runCli(process.argv.slice(2));
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`bazify: ${message}\n`);
    process.exitCode = error instanceof BazifyError ? error.exitCode : 1;
  }
}

export async function runCli(argv, environment = process.env) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(helpText());
    return undefined;
  }
  if (parsed.command === 'create') return createPackage(parsed, environment);
  if (parsed.command === 'adapt') return adaptPackage(parsed, environment);
  if (parsed.command === 'validate') return validateCommand(parsed, environment);
  if (parsed.command === 'publish') return publishPackage(parsed, environment);
  throw new BazifyError('Expected a command: create, adapt, validate, or publish. Run with --help.', 2);
}

function parseArguments(argv) {
  const values = [...argv];
  if (values.length === 0 || values[0] === '--help' || values[0] === '-h') return { help: true };
  const command = values.shift();
  const parsed = {
    command,
    positionals: [],
    dryRun: false,
    yes: false,
    name: undefined,
    destination: undefined,
    bazframeCommand: 'bazframe',
    approval: undefined
  };
  while (values.length > 0) {
    const value = values.shift();
    if (value === '--help' || value === '-h') return { help: true };
    if (value === '--dry-run') { parsed.dryRun = true; continue; }
    if (value === '--yes' || value === '-y') { parsed.yes = true; continue; }
    if (value === '--name') { parsed.name = requiredValue(values, value); continue; }
    if (value === '--destination') { parsed.destination = requiredValue(values, value); continue; }
    if (value === '--bazframe-command') { parsed.bazframeCommand = requiredValue(values, value); continue; }
    if (value === '--approval') { parsed.approval = requiredValue(values, value); continue; }
    if (value?.startsWith('-')) throw new BazifyError(`Unknown option: ${value}`, 2);
    parsed.positionals.push(value);
  }
  if (!new Set(['create', 'adapt', 'validate', 'publish']).has(command)) {
    throw new BazifyError(`Unknown command: ${String(command)}. Run with --help.`, 2);
  }
  if ((command === 'create' && parsed.positionals.length < 1)
    || (command !== 'create' && parsed.positionals.length !== 1)) {
    throw new BazifyError(`${command} requires ${command === 'create' ? 'one or more Skill paths' : 'exactly one path argument'}. Run with --help.`, 2);
  }
  if (command !== 'create' && (parsed.name !== undefined || parsed.destination !== undefined)) {
    throw new BazifyError('--name and --destination are valid only with create.', 2);
  }
  if (command !== 'publish' && (parsed.yes || parsed.approval !== undefined)) {
    throw new BazifyError('--yes and --approval are valid only with publish.', 2);
  }
  return parsed;
}

function requiredValue(values, option) {
  const value = values.shift();
  if (value === undefined || value.startsWith('-')) throw new BazifyError(`${option} requires a value.`, 2);
  return value;
}

function helpText() {
  return `Usage:
  node <bazify-skill-root>/scripts/bazify.mjs create <source-skill-or-collection> [<source-skill> ...] [--name <package-name>] [--destination <path>] [--dry-run]
  node <bazify-skill-root>/scripts/bazify.mjs adapt <skill-repository> [--dry-run]
  node <bazify-skill-root>/scripts/bazify.mjs validate <package-root> [--dry-run]
  node <bazify-skill-root>/scripts/bazify.mjs publish <package-root> --dry-run
  node <bazify-skill-root>/scripts/bazify.mjs publish <package-root> (-y | --yes) --approval <preview-token>

Options:
  --name <id>                 Create only; defaults to one Skill name or the collection-root name
  --destination <path>        Create only; defaults to ~/<package-name> outside ./bazframe/
  --bazframe-command <path>   Bazframe executable; defaults to bazframe
  --dry-run                   Inspect and report without filesystem/network mutation
  --approval <token>          Bind publication to the exact dry-run preview
  -y, --yes                   Confirm private GitHub publication
  -h, --help                  Show this help

Create, adapt, and validate use disposable Bazframe state. Publish is always private.
`;
}

async function createPackage(options, environment) {
  const selection = await resolveCreateSelection(options.positionals);
  const packageName = options.name ?? selection.defaultPackageName;
  if (packageName === undefined) throw new BazifyError('Multiple explicit Skill roots require --name.', 2);
  assertSafeId(packageName, 'Package name');
  const destination = await destinationPath(options.destination, packageName);
  await assertOutsideBazframeWorkspace(destination);
  for (const source of selection.skills) assertNoOverlap(source.root, destination);
  await assertDestinationAbsent(destination);
  const sourceDigest = digestSkillSet(selection.skills);
  const excluded = selection.skills.flatMap((skill) => skill.inventory.excluded.map((path) => `${skill.name}/${path}`)).sort(compare);
  const plan = {
    command: 'create',
    dryRun: options.dryRun,
    sources: selection.skills.map((skill) => skill.root),
    skillNames: selection.skills.map((skill) => skill.name),
    packageName,
    destination,
    sourceDigest: `sha256:${sourceDigest}`,
    excluded
  };
  if (selection.skills.length === 1) plan.skillName = selection.skills[0].name;
  if (options.dryRun) return { ...plan, status: 'planned' };

  const parent = dirname(destination);
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new BazifyError(`Destination parent must be a physical directory: ${parent}`);
  }
  const canonicalParent = await realpath(parent);
  if (join(canonicalParent, packageName) !== destination) {
    throw new BazifyError(`Destination parent changed during creation: ${parent}`);
  }

  await mkdir(destination, { mode: 0o700 });
  const ownedIdentity = await fileIdentity(destination);
  let complete = false;
  try {
    const skillsRoot = join(destination, 'skills');
    await mkdir(skillsRoot, { mode: 0o755 });
    for (const source of selection.skills) {
      const copiedSkill = join(skillsRoot, source.name);
      await mkdir(copiedSkill, { mode: 0o755 });
      await copyPhysicalTree(source.root, copiedSkill, { allowProviderMetadata: true });
      const copiedInventory = await inspectSkillTree(copiedSkill, { allowProviderMetadata: false });
      const currentSource = await inspectSkillTree(source.root, { allowProviderMetadata: true });
      if (digestInventory(copiedInventory.entries) !== digestInventory(source.inventory.entries)
        || digestInventory(currentSource.entries) !== digestInventory(source.inventory.entries)) {
        throw new BazifyError(`Source Skill changed while it was being copied: ${source.name}`);
      }
    }
    await writeScaffold(destination, packageName, selection.skills, sourceDigest, excluded);
    const validation = await validatePackage(destination, options.bazframeCommand, environment);
    complete = true;
    return { ...plan, dryRun: false, status: 'created', validation };
  } finally {
    if (!complete) await removeOwnedDirectory(destination, ownedIdentity);
  }
}

async function resolveCreateSelection(inputs) {
  if (inputs.length === 1) {
    const source = await canonicalDirectory(expandHome(inputs[0]), 'Source root');
    const rootSkill = await optionalSkill(source, true);
    if (rootSkill !== undefined) return { skills: [rootSkill], defaultPackageName: rootSkill.name };
    const skills = await discoverSkillCollection(source, true);
    return { skills, defaultPackageName: basename(source) };
  }
  const skills = [];
  for (const input of inputs) skills.push(await requiredSkill(await canonicalDirectory(expandHome(input), 'Source Skill root'), true));
  assertDistinctSkills(skills);
  return { skills: skills.sort((left, right) => compare(left.name, right.name)), defaultPackageName: undefined };
}

async function adaptPackage(options, environment) {
  const packageRoot = await canonicalDirectory(expandHome(options.positionals[0]), 'Skill repository root');
  await assertOutsideBazframeWorkspace(packageRoot);
  const packageName = basename(packageRoot);
  assertSafeId(packageName, 'Package directory basename');
  const skills = await discoverRepositorySkills(packageRoot, true);
  const selectedDigest = digestSkillSet(skills);
  const mappings = sourceMappings(packageRoot, skills);
  const manifestText = manifestTemplate();
  const buildText = buildScriptTemplate(mappings);
  const manifestPath = join(packageRoot, 'bazframe-package.json');
  const buildPath = join(packageRoot, 'scripts', 'bazify-build.mjs');
  const ignorePath = join(packageRoot, '.gitignore');
  const scriptsPath = join(packageRoot, 'scripts');
  const manifestState = await optionalFileState(manifestPath);
  const buildState = await optionalFileState(buildPath);
  const ignoreState = await optionalFileState(ignorePath);
  const scriptsState = await optionalDirectoryState(scriptsPath);
  if ((manifestState !== undefined && manifestState.text !== manifestText)
    || (buildState !== undefined && buildState.text !== buildText)
    || ((manifestState === undefined) !== (buildState === undefined))) {
    throw new BazifyError('Existing Bazframe compatibility files do not match the exact Bazify scaffold.');
  }
  const current = manifestState !== undefined;
  const ignoreText = appendIgnoreEntries(ignoreState?.text ?? '');
  const ignoreCurrent = ignoreState?.text === ignoreText;
  await assertCleanRepository(
    packageRoot,
    environment,
    current && ignoreCurrent ? new Set(['.gitignore', 'bazframe-package.json', 'scripts/bazify-build.mjs']) : new Set()
  );
  const plan = {
    command: 'adapt',
    dryRun: options.dryRun,
    packageRoot,
    packageName,
    skillNames: skills.map((skill) => skill.name),
    status: current && ignoreCurrent ? 'current' : 'planned'
  };
  if (options.dryRun) return plan;

  const lock = await acquireAdaptLock(packageRoot);
  let createdScriptsIdentity;
  let createdManifestState;
  let createdBuildState;
  let writtenIgnoreState;
  let artifactBackup = { kind: 'unprepared' };
  let trustedArtifactState;
  let complete = false;
  let result;
  let failure;
  try {
    await assertOptionalFileState(manifestPath, manifestState, 'Bazframe manifest changed before adaptation');
    await assertOptionalFileState(buildPath, buildState, 'Bazify build script changed before adaptation');
    await assertOptionalFileState(ignorePath, ignoreState, '.gitignore changed before adaptation');
    await assertOptionalDirectoryState(scriptsPath, scriptsState, 'scripts directory changed before adaptation');
    if (!current) {
      if (scriptsState === undefined) {
        await mkdir(scriptsPath, { mode: 0o755 });
        createdScriptsIdentity = await fileIdentity(scriptsPath);
      }
      await writeFile(manifestPath, manifestText, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
      createdManifestState = await optionalFileState(manifestPath);
      await writeFile(buildPath, buildText, { encoding: 'utf8', flag: 'wx', mode: 0o755 });
      await chmod(buildPath, 0o755);
      createdBuildState = await optionalFileState(buildPath);
    }
    if (!ignoreCurrent) {
      await replacePhysicalFile(ignorePath, ignoreText, ignoreState?.mode ?? 0o644, ignoreState);
      writtenIgnoreState = await optionalFileState(ignorePath);
    }
    const refreshedSkills = await discoverRepositorySkills(packageRoot, true);
    if (digestSkillSet(refreshedSkills) !== selectedDigest) {
      throw new BazifyError('Selected Skill source changed during adaptation.');
    }
    artifactBackup = await backupArtifact(packageRoot);
    const validation = await validatePackage(packageRoot, options.bazframeCommand, environment);
    trustedArtifactState = await captureGeneratedArtifactState(packageRoot, selectedDigest);
    const finalSkills = await discoverRepositorySkills(packageRoot, true);
    if (digestSkillSet(finalSkills) !== selectedDigest) {
      throw new BazifyError('Selected Skill source changed while adaptation was validated.');
    }
    await discardArtifactBackup(artifactBackup);
    artifactBackup = { kind: 'discarded' };
    complete = true;
    result = { ...plan, dryRun: false, status: current && ignoreCurrent ? 'current' : 'adapted', validation };
  } catch (error) {
    failure = error;
  }
  const recoveryErrors = [];
  if (!complete) {
    await attemptRecovery(recoveryErrors, () => restoreArtifact(packageRoot, artifactBackup, trustedArtifactState));
    if (createdBuildState !== undefined) {
      await attemptRecovery(recoveryErrors, () => removeOwnedFile(buildPath, createdBuildState, 'Bazify build script'));
    }
    if (createdManifestState !== undefined) {
      await attemptRecovery(recoveryErrors, () => removeOwnedFile(manifestPath, createdManifestState, 'Bazframe manifest'));
    }
    if (writtenIgnoreState !== undefined) {
      await attemptRecovery(recoveryErrors, async () => {
        await assertOptionalFileState(ignorePath, writtenIgnoreState, '.gitignore changed during rollback');
        if (ignoreState === undefined) await rm(ignorePath, { force: true });
        else await replacePhysicalFile(ignorePath, ignoreState.text, ignoreState.mode, writtenIgnoreState);
      });
    }
    if (createdScriptsIdentity !== undefined) {
      await attemptRecovery(recoveryErrors, () => removeOwnedEmptyDirectory(scriptsPath, createdScriptsIdentity, 'scripts directory'));
    }
  }
  await attemptRecovery(recoveryErrors, () => releaseAdaptLock(lock));
  if (recoveryErrors.length > 0) {
    throw new AggregateError(
      failure === undefined ? recoveryErrors : [failure, ...recoveryErrors],
      `Bazify stopped because safe recovery could not be proven. Inspect ${packageRoot} and any .bazify-* recovery state before continuing.`
    );
  }
  if (failure !== undefined) throw failure;
  return result;
}

async function validateCommand(options, environment) {
  if (options.dryRun) {
    const inspected = await inspectPackage(options.positionals[0]);
    return { command: 'validate', dryRun: true, status: 'planned', ...inspected };
  }
  const validation = await validatePackage(options.positionals[0], options.bazframeCommand, environment);
  return { command: 'validate', dryRun: false, status: 'valid', ...validation };
}

async function publishPackage(options, environment) {
  if (!options.dryRun && !options.yes) {
    throw new BazifyError('Private GitHub publication requires explicit confirmation with --yes.', 2);
  }
  const inspectedPackage = await inspectPackage(options.positionals[0]);
  await assertNoGitRepository(inspectedPackage.packageRoot);
  const publishDigest = `sha256:${digestInventory(await inspectPublishTree(inspectedPackage.packageRoot))}`;
  const inspected = { ...inspectedPackage, publishDigest };
  const ghCommand = environment.BAZIFY_GH_COMMAND || 'gh';
  const gitCommand = environment.BAZIFY_GIT_COMMAND || 'git';
  const ghEnvironment = { ...gitRoutingFreeEnvironment(environment), GH_HOST: GITHUB_HOST };
  const owner = authenticatedGitHubOwner(ghCommand, ghEnvironment);
  const repository = `${owner}/${inspected.packageName}`;
  const approvalData = {
    schemaVersion: 1,
    host: GITHUB_HOST,
    owner,
    repository,
    packageRoot: inspected.packageRoot,
    publishDigest: inspected.publishDigest
  };
  const approval = encodeApproval(approvalData);
  const publication = {
    command: 'publish',
    dryRun: options.dryRun,
    host: GITHUB_HOST,
    visibility: 'private',
    repository,
    url: `https://${GITHUB_HOST}/${repository}`,
    approval,
    ...inspected
  };
  if (options.dryRun) return { ...publication, status: 'planned' };
  if (options.approval === undefined) {
    throw new BazifyError('Publication requires --approval with the exact token from publish --dry-run.', 2);
  }
  if (options.approval !== approval || JSON.stringify(decodeApproval(options.approval)) !== JSON.stringify(approvalData)) {
    throw new BazifyError('Publication approval does not match the current GitHub target, package path, or publishable bytes. Run publish --dry-run and confirm again.', 2);
  }

  const existing = runProcess(ghCommand, ['api', '--hostname', GITHUB_HOST, `repos/${repository}`, '--silent'], {
    environment: ghEnvironment,
    allowFailure: true
  });
  if (existing.status === 0) throw new BazifyError(`GitHub repository already exists: ${repository}`);
  if (!existing.stderr.includes('HTTP 404')) {
    throw new BazifyError(`Could not prove that GitHub repository ${repository} is absent: ${cleanDiagnostic(existing.stderr)}`);
  }

  await validatePackage(inspected.packageRoot, options.bazframeCommand, environment);
  const refreshedDigest = `sha256:${digestInventory(await inspectPublishTree(inspected.packageRoot))}`;
  if (refreshedDigest !== inspected.publishDigest) {
    throw new BazifyError('Publishable package bytes changed after approval; run publish --dry-run and confirm again.');
  }

  const gitEnvironment = isolatedGitEnvironment(environment);
  runRequired(gitCommand, ['init', '-b', 'main', '--template='], inspected.packageRoot, gitEnvironment, 'Git initialization');
  runRequired(gitCommand, ['config', 'user.name', owner], inspected.packageRoot, gitEnvironment, 'Git author configuration');
  runRequired(gitCommand, ['config', 'user.email', `${owner}@users.noreply.github.com`], inspected.packageRoot, gitEnvironment, 'Git author configuration');
  const rootEntries = (await readdir(inspected.packageRoot)).filter((name) => name !== '.git' && name !== 'dist').sort(compare);
  runRequired(gitCommand, ['add', '--force', '--', ...rootEntries], inspected.packageRoot, gitEnvironment, 'Git staging');
  const stagedDigest = gitIndexDigest(gitCommand, inspected.packageRoot, gitEnvironment);
  if (stagedDigest !== inspected.publishDigest) {
    throw new BazifyError('Git index does not match the approved publishable bytes; publication stopped before commit.');
  }
  const changed = runProcess(gitCommand, ['diff', '--quiet', '--no-ext-diff'], {
    cwd: inspected.packageRoot,
    environment: gitEnvironment,
    allowFailure: true
  });
  const untracked = runProcess(gitCommand, ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: inspected.packageRoot,
    environment: gitEnvironment,
    allowFailure: true
  });
  if (changed.status !== 0 || untracked.status !== 0 || untracked.stdout !== '') {
    throw new BazifyError('Package changed while preparing the Git commit; publication stopped before commit.');
  }
  runRequired(
    gitCommand,
    ['-c', 'commit.gpgSign=false', 'commit', '--no-verify', '--no-gpg-sign', '-m', `Create ${inspected.packageName} Skill package`],
    inspected.packageRoot,
    gitEnvironment,
    'Git commit'
  );
  const ghPushEnvironment = { ...isolatedGitEnvironment(environment), GH_HOST: GITHUB_HOST };
  const created = runProcess(
    ghCommand,
    ['repo', 'create', repository, '--private', '--source', inspected.packageRoot, '--remote', 'origin', '--push'],
    { environment: ghPushEnvironment, allowFailure: true }
  );
  if (created.status !== 0) {
    throw new BazifyError(
      `GitHub publication failed after local Git initialization. Inspect ${join(inspected.packageRoot, '.git')} and ${repository}; do not rerun blindly. ${cleanDiagnostic(created.stderr)}`
    );
  }
  return { ...publication, dryRun: false, status: 'published' };
}

async function validatePackage(packagePath, bazframeCommand, environment) {
  const inspected = await inspectPackage(packagePath);
  const temporaryHome = await mkdtemp(join(tmpdir(), 'bazify-validation-'));
  try {
    const result = runProcess(
      bazframeCommand,
      ['package', 'add', inspected.packageRoot],
      {
        environment: {
          ...environment,
          BAZFRAME_HOME: temporaryHome,
          NO_COLOR: '1'
        },
        allowFailure: true
      }
    );
    if (result.status !== 0) {
      throw new BazifyError(`Bazframe package validation failed: ${cleanDiagnostic(result.stderr || result.stdout)}`);
    }
    return inspected;
  } finally {
    await removeWritableTree(temporaryHome);
  }
}

async function inspectPackage(packagePath) {
  const packageRoot = await canonicalDirectory(expandHome(packagePath), 'Package root');
  const packageName = basename(packageRoot);
  assertSafeId(packageName, 'Package directory basename');
  const manifest = await readExactJson(join(packageRoot, 'bazframe-package.json'), 'bazframe-package.json');
  const expectedManifest = JSON.parse(manifestTemplate());
  if (Object.keys(manifest).sort(compare).join(',') !== Object.keys(expectedManifest).sort(compare).join(',')
    || manifest.schemaVersion !== expectedManifest.schemaVersion
    || JSON.stringify(manifest.build) !== JSON.stringify(expectedManifest.build)
    || manifest.artifactRoot !== expectedManifest.artifactRoot
    || manifest.skillsRoot !== expectedManifest.skillsRoot) {
    throw new BazifyError('bazframe-package.json does not match the exact Bazify package contract.');
  }
  const skills = await discoverRepositorySkills(packageRoot, true);
  const mappings = sourceMappings(packageRoot, skills);
  const buildText = await readUtf8File(join(packageRoot, 'scripts', 'bazify-build.mjs'), 'Bazify build script');
  if (buildText !== buildScriptTemplate(mappings)) throw new BazifyError('Bazify build script does not match the selected Skill layout.');
  const result = {
    packageRoot,
    packageName,
    skillNames: skills.map((skill) => skill.name),
    sourceDigest: `sha256:${digestSkillSet(skills)}`
  };
  if (skills.length === 1) result.skillName = skills[0].name;
  return result;
}

function manifestTemplate() {
  return `${JSON.stringify({
    schemaVersion: 1,
    build: ['node', 'scripts/bazify-build.mjs'],
    artifactRoot: 'dist',
    skillsRoot: 'skills'
  })}\n`;
}

async function discoverRepositorySkills(root, allowProviderMetadata) {
  const rootSkill = await optionalSkill(root, allowProviderMetadata, true);
  if (rootSkill !== undefined) return [rootSkill];
  return discoverSkillCollection(root, allowProviderMetadata);
}

async function discoverSkillCollection(root, allowProviderMetadata) {
  const lexicalSkillsRoot = join(root, 'skills');
  const lexicalMetadata = await lstat(lexicalSkillsRoot).catch((error) => {
    throw new BazifyError(`Skills collection root is unavailable: ${formatFsError(error)}`);
  });
  if (lexicalMetadata.isSymbolicLink() || !lexicalMetadata.isDirectory()) {
    throw new BazifyError(`Skills collection root must be a physical directory: ${lexicalSkillsRoot}`);
  }
  const skillsRoot = await realpath(lexicalSkillsRoot);
  if (skillsRoot !== resolve(lexicalSkillsRoot) || !within(root, skillsRoot)) {
    throw new BazifyError(`Skills collection root escapes its repository: ${lexicalSkillsRoot}`);
  }
  const skills = [];
  for (const name of (await readdir(skillsRoot)).sort(compare)) {
    const path = join(skillsRoot, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new BazifyError(`Skills collection contains a non-physical directory entry: ${path}`);
    }
    skills.push(await requiredSkill(path, allowProviderMetadata));
  }
  if (skills.length === 0) throw new BazifyError(`Skills collection is empty: ${skillsRoot}`);
  assertDistinctSkills(skills);
  return skills.sort((left, right) => compare(left.name, right.name));
}

async function optionalSkill(root, allowProviderMetadata, excludePackageState = false) {
  const definitionPath = join(root, 'SKILL.md');
  let metadata;
  try { metadata = await lstat(definitionPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new BazifyError(`Could not inspect Skill definition: ${formatFsError(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new BazifyError(`Skill requires a physical SKILL.md: ${definitionPath}`);
  return requiredSkill(root, allowProviderMetadata, excludePackageState);
}

async function requiredSkill(root, allowProviderMetadata, excludePackageState = false) {
  const canonicalRoot = await canonicalDirectory(root, 'Skill root');
  const inventory = await inspectSkillTree(canonicalRoot, { allowProviderMetadata, excludePackageState });
  const name = declaredSkillName(inventory.skillDefinition);
  if (basename(canonicalRoot) !== name) {
    throw new BazifyError(`Skill directory basename ${JSON.stringify(basename(canonicalRoot))} must match declared name ${JSON.stringify(name)}.`);
  }
  return { root: canonicalRoot, name, inventory };
}

function isReservedBazifyName(name) {
  return /^\.bazify-(?:dist|backup|adapt|recovery)(?:-|$)/u.test(name);
}

function isRootPackageState(path) {
  return path === '.gitignore' || path === 'dist' || path === 'bazframe-package.json'
    || path === 'scripts/bazify-build.mjs' || isReservedBazifyName(path.split('/')[0]);
}

function assertDistinctSkills(skills) {
  const names = new Set();
  for (let index = 0; index < skills.length; index += 1) {
    const skill = skills[index];
    if (names.has(skill.name)) throw new BazifyError(`Duplicate selected Skill name: ${skill.name}`);
    names.add(skill.name);
    for (let other = 0; other < index; other += 1) {
      if (within(skill.root, skills[other].root) || within(skills[other].root, skill.root)) {
        throw new BazifyError(`Selected Skill roots overlap: ${skill.root} <> ${skills[other].root}`);
      }
    }
  }
}

function sourceMappings(packageRoot, skills) {
  return skills.map((skill) => ({ name: skill.name, source: relative(packageRoot, skill.root).split(sep).join('/') || '.' }));
}

function digestSkillSet(skills) {
  const entries = skills.flatMap((skill) => skill.inventory.entries.map((entry) => ({ ...entry, path: `${skill.name}/${entry.path}` })))
    .sort((left, right) => compare(left.path, right.path));
  return digestInventory(entries);
}

async function canonicalDirectory(input, label) {
  const absolute = resolve(input);
  const canonical = await realpath(absolute).catch((error) => {
    throw new BazifyError(`${label} is unavailable: ${formatFsError(error)}`);
  });
  const metadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazifyError(`${label} must be a physical directory: ${canonical}`);
  return canonical;
}

async function destinationPath(input, packageName) {
  const requested = resolve(input === undefined ? join(homedir(), packageName) : expandHome(input));
  if (basename(requested) !== packageName) {
    throw new BazifyError(`Destination basename must equal package name ${JSON.stringify(packageName)}: ${requested}`);
  }
  const parent = dirname(requested);
  const canonicalParent = await canonicalDirectory(parent, 'Destination parent');
  return join(canonicalParent, packageName);
}

async function assertOutsideBazframeWorkspace(destination) {
  const requestedWorkspace = resolve('bazframe');
  let workspace;
  try {
    workspace = await realpath(requestedWorkspace);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new BazifyError(`Could not inspect Bazframe working area ${requestedWorkspace}: ${formatFsError(error)}`);
    }
    const canonicalParent = await canonicalDirectory(dirname(requestedWorkspace), 'Bazframe working-area parent');
    workspace = join(canonicalParent, basename(requestedWorkspace));
  }
  if (within(workspace, destination)) {
    throw new BazifyError(`Generated package must remain outside Bazframe working area ${workspace}: ${destination}`, 2);
  }
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith(`~${sep}`)) return join(homedir(), value.slice(2));
  return value;
}

function assertSafeId(value, label) {
  if (value.length < 1 || value.length > MAX_ID_LENGTH || !SAFE_ID.test(value)) {
    throw new BazifyError(`${label} must be 1-64 lowercase letters, digits, or single hyphens, with no leading, trailing, or consecutive hyphen: ${JSON.stringify(value)}`);
  }
}

function assertNoOverlap(source, destination) {
  if (within(source, destination) || within(destination, source)) {
    throw new BazifyError(`Source and destination must not overlap: ${source} <> ${destination}`);
  }
}

async function assertDestinationAbsent(destination) {
  try {
    await lstat(destination);
    throw new BazifyError(`Destination is already occupied; choose another package name or parent: ${destination}`, 4);
  } catch (error) {
    if (error instanceof BazifyError) throw error;
    if (error?.code !== 'ENOENT') throw new BazifyError(`Could not inspect destination: ${formatFsError(error)}`);
  }
}

async function inspectSkillTree(root, options) {
  const canonicalRoot = await canonicalDirectory(root, 'Skill root');
  const entries = [];
  const excluded = [];
  let skillDefinition;
  const visit = async (directory, relativeDirectory) => {
    const before = await fileIdentity(directory);
    const names = (await readdir(directory)).sort(compare);
    let included = false;
    for (const name of names) {
      const path = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      const absolute = join(directory, name);
      const metadata = await lstat(absolute, { bigint: true });
      if (options.excludePackageState && isRootPackageState(path)) continue;
      if (SKIPPED_SOURCE_NAMES.has(name)) {
        if (!options.allowProviderMetadata) throw new BazifyError(`Package source contains excluded source state: ${path}`);
        excluded.push(path);
        continue;
      }
      if (metadata.isSymbolicLink()) throw new BazifyError(`Skill contains a symbolic link: ${path}`);
      const canonical = await realpath(absolute);
      if (canonical !== resolve(absolute) || !within(canonicalRoot, canonical)) {
        throw new BazifyError(`Skill entry escapes its root: ${path}`);
      }
      if (metadata.isDirectory()) {
        const childIncluded = await visit(absolute, path);
        if (!options.excludePackageState || childIncluded || (await readdir(absolute)).length === 0) {
          entries.push({ path, type: 'directory' });
          included = true;
        }
      } else if (metadata.isFile()) {
        assertNotSecretName(name, path);
        const file = await readStableFile(absolute);
        assertNoPrivateKey(file.bytes, path);
        entries.push({ path, type: 'file', executable: executable(file.mode), sha256: sha256(file.bytes) });
        included = true;
        if (name === 'SKILL.md') {
          if (path !== 'SKILL.md') throw new BazifyError(`A single Skill must not contain a descendant SKILL.md: ${path}`);
          skillDefinition = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
        }
      } else {
        throw new BazifyError(`Skill contains an unsupported filesystem entry: ${path}`);
      }
    }
    await assertIdentity(directory, before, 'Skill directory changed during inspection');
    return included;
  };
  await visit(canonicalRoot, '');
  if (skillDefinition === undefined) throw new BazifyError(`Skill root does not contain a physical SKILL.md: ${canonicalRoot}`);
  entries.sort((left, right) => compare(left.path, right.path));
  return { entries, excluded, skillDefinition };
}

async function inspectPublishTree(root) {
  const entries = [];
  const visit = async (directory, relativeDirectory) => {
    for (const name of (await readdir(directory)).sort(compare)) {
      const path = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      if (relativeDirectory === '' && name === 'dist') continue;
      if (relativeDirectory === '' && isReservedBazifyName(name)) {
        throw new BazifyError(`Package contains unfinished Bazify staging or recovery state: ${path}`);
      }
      if (name === '.git' || name === 'node_modules') {
        throw new BazifyError(`Package contains excluded repository or dependency state: ${path}`);
      }
      const absolute = join(directory, name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new BazifyError(`Package contains a symbolic link: ${path}`);
      if (metadata.isDirectory()) await visit(absolute, path);
      else if (metadata.isFile()) {
        assertNotSecretName(name, path);
        const file = await readStableFile(absolute);
        assertNoPrivateKey(file.bytes, path);
        entries.push({ path, type: 'file', executable: executable(file.mode), sha256: sha256(file.bytes) });
      } else throw new BazifyError(`Package contains an unsupported filesystem entry: ${path}`);
    }
  };
  await visit(root, '');
  return entries.sort((left, right) => compare(left.path, right.path));
}

function assertNotSecretName(name, path) {
  const normalized = name.toLowerCase();
  if (SECRET_FILE_NAMES.has(normalized)) {
    throw new BazifyError(`Refusing obvious credential file in package input: ${path}`);
  }
}

function assertNoPrivateKey(bytes, path) {
  if (PRIVATE_KEY_MARKERS.some((marker) => bytes.includes(marker))) {
    throw new BazifyError(`Refusing private-key material in package input: ${path}`);
  }
}

function declaredSkillName(definition) {
  const lines = definition.replace(/\r\n?/gu, '\n').split('\n');
  if (lines[0] !== '---') throw new BazifyError('SKILL.md must begin with YAML frontmatter.');
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new BazifyError('SKILL.md frontmatter is not closed.');
  const nameLines = lines.slice(1, end).filter((line) => /^name\s*:/u.test(line));
  if (nameLines.length !== 1) throw new BazifyError('SKILL.md frontmatter must contain exactly one top-level name field.');
  const name = parseScalarName(nameLines[0].replace(/^name\s*:\s*/u, '').trim());
  assertSafeId(name, 'Skill name');
  return name;
}

function parseScalarName(raw) {
  if (raw.length === 0) throw new BazifyError('SKILL.md name must be a scalar string.');
  if (raw.startsWith("'")) return parseSingleQuotedName(raw);
  if (raw.startsWith('"')) return parseDoubleQuotedName(raw);
  const value = stripPlainScalarComment(raw).trimEnd();
  if (value.length === 0 || new Set(['[', ']', '{', '&', '*', '!', '|', '>', '@', '`']).has(value[0] ?? '') || value.startsWith('- ')) {
    throw new BazifyError('SKILL.md name must be a plain scalar string.');
  }
  return value;
}

function parseSingleQuotedName(raw) {
  let value = '';
  for (let index = 1; index < raw.length; index += 1) {
    if (raw[index] !== "'") { value += raw[index]; continue; }
    if (raw[index + 1] === "'") { value += "'"; index += 1; continue; }
    assertOnlyTrailingComment(raw.slice(index + 1));
    return value;
  }
  throw new BazifyError('SKILL.md name has an invalid quoted scalar.');
}

function parseDoubleQuotedName(raw) {
  let escaped = false;
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character !== '"') continue;
    assertOnlyTrailingComment(raw.slice(index + 1));
    try {
      const parsed = JSON.parse(raw.slice(0, index + 1));
      if (typeof parsed === 'string') return parsed;
    } catch { /* Report the stable error below. */ }
    break;
  }
  throw new BazifyError('SKILL.md name has an invalid quoted scalar.');
}

function assertOnlyTrailingComment(remainder) {
  if (/^(?:\s*|\s+#.*)$/u.test(remainder)) return;
  throw new BazifyError('SKILL.md name has an invalid quoted scalar.');
}

function stripPlainScalarComment(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/u.test(value[index - 1] ?? ''))) return value.slice(0, index);
  }
  return value;
}

async function copyPhysicalTree(source, destination, options) {
  const visit = async (fromDirectory, toDirectory) => {
    const before = await fileIdentity(fromDirectory);
    for (const name of (await readdir(fromDirectory)).sort(compare)) {
      const from = join(fromDirectory, name);
      const to = join(toDirectory, name);
      const metadata = await lstat(from);
      if (SKIPPED_SOURCE_NAMES.has(name)) {
        if (!options.allowProviderMetadata) throw new BazifyError(`Package source contains excluded source state: ${from}`);
        continue;
      }
      if (metadata.isSymbolicLink()) throw new BazifyError(`Skill contains a symbolic link: ${from}`);
      if (metadata.isDirectory()) {
        await mkdir(to, { mode: 0o755 });
        await visit(from, to);
      } else if (metadata.isFile()) {
        const file = await readStableFile(from);
        await writeFile(to, file.bytes, { flag: 'wx', mode: executable(file.mode) ? 0o755 : 0o644 });
        await chmod(to, executable(file.mode) ? 0o755 : 0o644);
      } else throw new BazifyError(`Skill contains an unsupported filesystem entry: ${from}`);
    }
    await assertIdentity(fromDirectory, before, 'Skill directory changed during copy');
  };
  await visit(source, destination);
}

async function writeScaffold(root, packageName, skills, sourceDigest, excluded) {
  await mkdir(join(root, 'scripts'), { mode: 0o755 });
  const mappings = sourceMappings(root, skills.map((skill) => ({ ...skill, root: join(root, 'skills', skill.name) })));
  const files = new Map([
    ['.gitignore', appendIgnoreEntries('')],
    ['bazframe-package.json', manifestTemplate()],
    ['package.json', `${JSON.stringify({
      name: packageName,
      version: '0.1.0',
      private: true,
      description: `Source-owned Bazframe-compatible Skill package containing ${skills.length} Skill${skills.length === 1 ? '' : 's'}.`,
      type: 'module',
      scripts: { build: 'node scripts/bazify-build.mjs' },
      engines: { node: '>=22.19.0' }
    }, null, 2)}\n`],
    ['README.md', readmeTemplate(packageName, skills.map((skill) => skill.name), sourceDigest, excluded)],
    ['AGENTS.md', agentsTemplate(packageName, skills.map((skill) => skill.name))],
    ['scripts/bazify-build.mjs', buildScriptTemplate(mappings)]
  ]);
  for (const [relativePath, contents] of files) {
    const path = join(root, relativePath);
    await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: relativePath.endsWith('.mjs') ? 0o755 : 0o644 });
  }
}

function readmeTemplate(packageName, skillNames, sourceDigest, excluded) {
  const excludedText = excluded.length === 0 ? '(none)' : excluded.map((path) => JSON.stringify(path)).join(', ');
  const contents = skillNames.map((name) => `- \`skills/${name}/\` → \`dist/skills/${name}/\``).join('\n');
  return `# ${packageName}

A source-owned Agent Skill package with a Bazframe-compatible build manifest.

## Skills

${contents}

- Source digest at conversion: \`sha256:${sourceDigest}\`
- Excluded source metadata/dependencies: ${excludedText}

## Requirements

The package scaffold requires Node.js 22.19 or newer and Bazframe. Each copied \`SKILL.md\` and its supporting files define source-specific runtime and setup requirements.

## Build and use

\`\`\`bash
npm run build
bazframe package add "$PWD"
bazframe profile package add ${packageName}
\`\`\`

Edit source content under \`skills/\`, rebuild with \`bazframe package build ${packageName}\`, and run \`/bazframe reload\` in an existing Pi session.

Bazframe builds are explicit and unsandboxed. Review \`bazframe-package.json\`, \`scripts/bazify-build.mjs\`, and the copied Skills before activation.

## Provenance and rights

This package was extracted from local Agent Skill source. Its conversion-time digest is recorded above. Use and redistribution follow the source's license, notice, privacy, and publication terms.
`;
}

function agentsTemplate(packageName, skillNames) {
  return `# ${packageName} source instructions

- Treat \`skills/\` as source-owned content and \`dist/\` as generated output.
- Preserve these Agent Skill names and directory basenames: ${skillNames.map((name) => `\`${name}\``).join(', ')}.
- Keep \`bazframe-package.json\` and \`scripts/bazify-build.mjs\` synchronized with the selected Skills.
- After source edits, run \`npm run build\`, then validate through \`bazframe package build ${packageName}\` when registered.
- Keep requirements, setup, provenance, and license status synchronized with source behavior.
- Keep secrets, source \`.git\` state, \`node_modules\`, and generated \`dist/\` out of commits.
`;
}

function buildScriptTemplate(mappings) {
  return `#!/usr/bin/env node

import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mappings = ${JSON.stringify(mappings)};
const distRoot = join(packageRoot, 'dist');
const stagingRoot = await mkdtemp(join(packageRoot, '.bazify-dist-'));
const backupRoot = await mkdtemp(join(packageRoot, '.bazify-backup-'));
let oldMoved = false;
let newPublished = false;

try {
  await mkdir(join(stagingRoot, 'skills'), { mode: 0o755 });
  const selected = [];
  for (const mapping of mappings) {
    const sourceRoot = resolve(packageRoot, mapping.source);
    if (!within(packageRoot, sourceRoot)) throw new Error(\`Skill source escapes package root: \${mapping.source}\`);
    const metadata = await lstat(sourceRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(\`Skill root must be a physical directory: \${mapping.source}\`);
    const definition = await lstat(join(sourceRoot, 'SKILL.md'));
    if (definition.isSymbolicLink() || !definition.isFile()) throw new Error(\`Skill root must contain a physical SKILL.md: \${mapping.source}\`);
    const packageRootSkill = sourceRoot === packageRoot;
    const beforeInventory = await inventoryTree(sourceRoot, packageRootSkill);
    const destination = join(stagingRoot, 'skills', mapping.name);
    await mkdir(destination, { mode: 0o755 });
    await copyTree(sourceRoot, destination, sourceRoot, '', packageRootSkill);
    const stagedInventory = await inventoryTree(destination, false);
    if (digest(beforeInventory) !== digest(stagedInventory)) {
      throw new Error(\`Skill source changed while it was copied: \${mapping.source}\`);
    }
    selected.push({ mapping, sourceRoot, packageRootSkill, digest: digest(beforeInventory) });
  }
  for (const item of selected) {
    const afterInventory = await inventoryTree(item.sourceRoot, item.packageRootSkill);
    if (digest(afterInventory) !== item.digest) throw new Error(\`Skill source changed while it was built: \${item.mapping.source}\`);
  }
  const existing = await lstat(distRoot).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('dist must be a physical directory');
    await rename(distRoot, join(backupRoot, 'dist'));
    oldMoved = true;
  }
  await rename(stagingRoot, distRoot);
  newPublished = true;
  await rm(backupRoot, { recursive: true, force: true });
} catch (error) {
  if (newPublished) await rm(distRoot, { recursive: true, force: true }).catch(() => undefined);
  let restorationError;
  if (oldMoved) {
    try { await rename(join(backupRoot, 'dist'), distRoot); }
    catch (cause) { restorationError = cause; }
  }
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  if (restorationError === undefined) await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  if (restorationError !== undefined) throw new AggregateError([error, restorationError], \`Build failed and prior dist could not be restored from \${backupRoot}\`);
  throw error;
}

async function inventoryTree(root, packageRootSkill) {
  const entries = [];
  const visit = async (directory, relativeDirectory) => {
    const before = await identity(directory);
    for (const name of (await readdir(directory)).sort(compare)) {
      const relativePath = relativeDirectory === '' ? name : \`\${relativeDirectory}/\${name}\`;
      if (skipEntry(name, relativePath, packageRootSkill)) continue;
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(\`Package source contains a symbolic link: \${path}\`);
      const canonical = await realpath(path);
      if (canonical !== resolve(path) || !within(root, canonical)) throw new Error(\`Package source escapes its root: \${path}\`);
      if (metadata.isDirectory()) {
        if (await omitControlOnlyDirectory(path, relativePath, packageRootSkill)) continue;
        entries.push({ path: relativePath, type: 'directory' });
        await visit(path, relativePath);
      } else if (metadata.isFile()) {
        const file = await readStableSource(path);
        entries.push({
          path: relativePath,
          type: 'file',
          executable: process.platform !== 'win32' && (file.mode & 0o111) !== 0,
          sha256: createHash('sha256').update(file.bytes).digest('hex')
        });
      } else throw new Error(\`Package source contains an unsupported entry: \${path}\`);
    }
    const after = await identity(directory);
    if (before.device !== after.device || before.inode !== after.inode) throw new Error(\`Package source directory changed during build: \${directory}\`);
  };
  await visit(root, '');
  entries.sort((left, right) => compare(left.path, right.path));
  return entries;
}

function digest(entries) { return createHash('sha256').update(\`\${JSON.stringify(entries)}\\n\`, 'utf8').digest('hex'); }
async function omitControlOnlyDirectory(path, relativePath, packageRootSkill) {
  return packageRootSkill && relativePath === 'scripts'
    && (await readdir(path)).every((name) => name === 'bazify-build.mjs');
}
function skipEntry(name, relativePath, packageRootSkill) {
  return name === '.git' || name === 'node_modules'
    || (packageRootSkill && (relativePath === '.gitignore' || relativePath === 'dist' || relativePath === 'bazframe-package.json'
      || relativePath === 'scripts/bazify-build.mjs' || /^\\.bazify-(?:dist|backup|adapt|recovery)(?:-|$)/u.test(relativePath)));
}

async function copyTree(source, destination, root, relativeDirectory, packageRootSkill) {
  const before = await identity(source);
  for (const name of (await readdir(source)).sort(compare)) {
    const relativePath = relativeDirectory === '' ? name : \`\${relativeDirectory}/\${name}\`;
    if (skipEntry(name, relativePath, packageRootSkill)) continue;
    const from = join(source, name); const to = join(destination, name);
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink()) throw new Error(\`Package source contains a symbolic link: \${from}\`);
    const canonical = await realpath(from);
    if (canonical !== resolve(from) || !within(root, canonical)) throw new Error(\`Package source escapes its root: \${from}\`);
    if (metadata.isDirectory()) {
      if (await omitControlOnlyDirectory(from, relativePath, packageRootSkill)) continue;
      await mkdir(to, { mode: 0o755 });
      await copyTree(from, to, root, relativePath, packageRootSkill);
    } else if (metadata.isFile()) await copyStableFile(from, to);
    else throw new Error(\`Package source contains an unsupported entry: \${from}\`);
  }
  const after = await identity(source);
  if (before.device !== after.device || before.inode !== after.inode) throw new Error(\`Package source directory changed during build: \${source}\`);
}

async function copyStableFile(source, destination) {
  const file = await readStableSource(source);
  const mode = (file.mode & 0o111) !== 0 ? 0o755 : 0o644;
  await writeFile(destination, file.bytes, { flag: 'wx', mode });
  await chmod(destination, mode);
}

async function readStableSource(source) {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(\`Expected physical file: \${source}\`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(source, { bigint: true });
    if (!after.isFile() || current.isSymbolicLink() || !current.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== current.dev || after.ino !== current.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error(\`Package source file changed during build: \${source}\`);
    return { bytes, mode: Number(before.mode) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function identity(path) {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory()) throw new Error(\`Expected physical directory: \${path}\`);
  return { device: metadata.dev, inode: metadata.ino };
}

function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(\`..\${sep}\`) && value !== '..');
}
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
`;
}

async function assertCleanRepository(packageRoot, environment, allowedChanges) {
  const gitCommand = environment.BAZIFY_GIT_COMMAND || 'git';
  const gitEnvironment = isolatedGitEnvironment(environment);
  const top = runProcess(gitCommand, ['rev-parse', '--show-toplevel'], {
    cwd: packageRoot,
    environment: gitEnvironment,
    allowFailure: true
  });
  if (top.status !== 0) {
    const gitEntry = await lstat(join(packageRoot, '.git')).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (gitEntry !== undefined) throw new BazifyError(`Could not inspect repository state: ${cleanDiagnostic(top.stderr)}`);
    return;
  }
  const canonicalTop = await realpath(top.stdout.trim());
  if (canonicalTop !== packageRoot) throw new BazifyError(`Adapt path must be the Git repository top-level: ${canonicalTop}`);
  const trackedArtifact = runProcess(gitCommand, ['ls-files', '-z', '--', 'dist'], {
    cwd: packageRoot,
    environment: gitEnvironment,
    allowFailure: true
  });
  if (trackedArtifact.status !== 0) throw new BazifyError('Could not inspect tracked dist state.');
  if (trackedArtifact.stdout !== '') throw new BazifyError('In-place adaptation requires dist to be generated, ignored, and untracked.');
  const status = runProcess(gitCommand, ['status', '--porcelain', '--untracked-files=all'], {
    cwd: packageRoot,
    environment: gitEnvironment,
    allowFailure: true
  });
  if (status.status !== 0) throw new BazifyError('Could not inspect Git worktree status.');
  const changes = status.stdout.split('\n').filter(Boolean);
  for (const line of changes) {
    const path = line.slice(3);
    if (!allowedChanges.has(path) || line.includes(' -> ')) {
      throw new BazifyError('In-place adaptation requires a clean Git worktree.');
    }
    if (path === '.gitignore') {
      const indexed = runProcess(gitCommand, ['show', ':.gitignore'], {
        cwd: packageRoot,
        environment: gitEnvironment,
        allowFailure: true
      });
      const expected = appendIgnoreEntries(indexed.status === 0 ? indexed.stdout : '');
      const working = await optionalFileState(join(packageRoot, '.gitignore'));
      if (working?.text !== expected) throw new BazifyError('In-place adaptation requires a clean Git worktree.');
    }
  }
}

async function optionalFileState(path) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new BazifyError(`Could not inspect ${path}: ${formatFsError(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new BazifyError(`Expected a physical regular file: ${path}`);
  const file = await readStableFile(path);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
  catch { throw new BazifyError(`File is not valid UTF-8: ${path}`); }
  return {
    text,
    bytes: file.bytes,
    mode: file.mode & 0o777,
    device: file.device,
    inode: file.inode
  };
}

async function optionalDirectoryState(path) {
  let metadata;
  try { metadata = await lstat(path, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new BazifyError(`Could not inspect ${path}: ${formatFsError(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazifyError(`Expected a physical directory: ${path}`);
  return { device: metadata.dev, inode: metadata.ino };
}

function sameFileState(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.device === right.device && left.inode === right.inode
    && left.mode === right.mode && left.bytes.equals(right.bytes);
}

async function assertOptionalFileState(path, expected, message) {
  const current = await optionalFileState(path);
  if (!sameFileState(current, expected)) throw new BazifyError(`${message}: ${path}`);
}

async function assertOptionalDirectoryState(path, expected, message) {
  const current = await optionalDirectoryState(path);
  if (current === undefined || expected === undefined) {
    if (current !== expected) throw new BazifyError(`${message}: ${path}`);
    return;
  }
  if (current.device !== expected.device || current.inode !== expected.inode) throw new BazifyError(`${message}: ${path}`);
}

async function acquireAdaptLock(packageRoot) {
  const path = join(packageRoot, '.bazify-adapt-lock');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new BazifyError(`Another Bazify adaptation or recovery owns ${path}.`);
    throw error;
  }
  return { path, identity: await fileIdentity(path) };
}

async function releaseAdaptLock(lock) {
  await assertIdentity(lock.path, lock.identity, 'Bazify adaptation lock ownership changed');
  if ((await readdir(lock.path)).length !== 0) throw new BazifyError(`Bazify adaptation lock contains unexpected recovery state: ${lock.path}`);
  await rmdir(lock.path);
}

async function removeOwnedFile(path, expected, label) {
  await assertOptionalFileState(path, expected, `${label} ownership changed during rollback`);
  await rm(path, { force: true });
}

async function removeOwnedEmptyDirectory(path, expected, label) {
  await assertIdentity(path, expected, `${label} ownership changed during rollback`);
  if ((await readdir(path)).length !== 0) throw new BazifyError(`${label} is not empty during rollback: ${path}`);
  await rmdir(path);
}

async function attemptRecovery(errors, operation) {
  try { await operation(); }
  catch (error) { errors.push(error); }
}

function appendIgnoreEntries(text) {
  let result = text;
  if (result.length > 0 && !result.endsWith('\n')) result += '\n';
  for (const entry of ['/dist/', '/.bazify-dist-*/', '/.bazify-backup-*/', '/.bazify-adapt-*/', '/.bazify-recovery-*/']) {
    if (!result.split(/\r?\n/u).includes(entry)) result += `${entry}\n`;
  }
  return result;
}

async function replacePhysicalFile(path, text, mode, expected) {
  await assertOptionalFileState(path, expected, 'File changed before replacement');
  if (expected === undefined) {
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode });
    await chmod(path, mode);
    return;
  }
  const staging = await mkdtemp(join(dirname(path), '.bazify-adapt-write-'));
  const temporary = join(staging, 'file');
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode });
    await chmod(temporary, mode);
    await assertOptionalFileState(path, expected, 'File changed before atomic replacement');
    await rename(temporary, path);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function backupArtifact(packageRoot) {
  const dist = join(packageRoot, 'dist');
  const metadata = await lstat(dist, { bigint: true }).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (metadata === undefined) return { kind: 'absent' };
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new BazifyError(`dist must be a physical directory: ${dist}`);
  const container = await mkdtemp(join(packageRoot, '.bazify-adapt-'));
  const containerIdentity = await fileIdentity(container);
  try {
    await rename(dist, join(container, 'dist'));
    return {
      kind: 'moved',
      container,
      containerIdentity,
      distIdentity: { device: metadata.dev, inode: metadata.ino }
    };
  } catch (error) {
    await removeOwnedDirectory(container, containerIdentity).catch(() => undefined);
    throw error;
  }
}

async function discardArtifactBackup(backup) {
  if (backup.kind === 'moved') {
    await assertIdentity(backup.container, backup.containerIdentity, 'Artifact backup ownership changed');
    await removeWritableTree(backup.container);
  }
}

async function captureGeneratedArtifactState(packageRoot, expectedDigest) {
  const dist = join(packageRoot, 'dist');
  const before = await lstat(dist, { bigint: true }).catch((error) => {
    throw new BazifyError(`Validated package did not produce a physical dist directory: ${formatFsError(error)}`);
  });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new BazifyError(`Validated package did not produce a physical dist directory: ${dist}`);
  }
  if (JSON.stringify((await readdir(dist)).sort(compare)) !== JSON.stringify(['skills'])) {
    throw new BazifyError('Validated package artifact must contain exactly the generated skills directory.');
  }
  const skills = await discoverSkillCollection(dist, false);
  if (digestSkillSet(skills) !== expectedDigest) {
    throw new BazifyError('Validated package artifact does not match the selected Skill source.');
  }
  const after = await lstat(dist, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new BazifyError(`Validated package artifact changed during inspection: ${dist}`);
  }
  return { device: before.dev, inode: before.ino, digest: expectedDigest };
}

async function artifactMatchesState(packageRoot, expected) {
  if (expected === undefined) return false;
  try {
    const dist = join(packageRoot, 'dist');
    const before = await lstat(dist, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()
      || before.dev !== expected.device || before.ino !== expected.inode) return false;
    if (JSON.stringify((await readdir(dist)).sort(compare)) !== JSON.stringify(['skills'])) return false;
    const skills = await discoverSkillCollection(dist, false);
    if (digestSkillSet(skills) !== expected.digest) return false;
    const after = await lstat(dist, { bigint: true });
    return after.isDirectory() && !after.isSymbolicLink()
      && before.dev === after.dev && before.ino === after.ino
      && after.dev === expected.device && after.ino === expected.inode;
  } catch {
    return false;
  }
}

async function restoreArtifact(packageRoot, backup, trustedArtifactState) {
  if (backup.kind === 'unprepared' || backup.kind === 'discarded') return;
  const dist = join(packageRoot, 'dist');
  const current = await lstat(dist).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (current !== undefined) {
    if (!await artifactMatchesState(packageRoot, trustedArtifactState)) {
      throw new BazifyError(`Generated dist ownership changed; recovery state was preserved at ${backup.container ?? packageRoot}.`);
    }
    await removeWritableTree(dist);
  }
  if (backup.kind === 'absent') return;
  await assertIdentity(backup.container, backup.containerIdentity, 'Artifact backup ownership changed');
  await assertIdentity(join(backup.container, 'dist'), backup.distIdentity, 'Backed-up dist ownership changed');
  await rename(join(backup.container, 'dist'), dist);
  await removeOwnedEmptyDirectory(backup.container, backup.containerIdentity, 'Artifact backup container');
}

async function readExactJson(path, label) {
  const text = await readUtf8File(path, label);
  let value;
  try { value = JSON.parse(text); } catch { throw new BazifyError(`${label} is not valid JSON.`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BazifyError(`${label} must contain a JSON object.`);
  return value;
}

async function readUtf8File(path, label) {
  const metadata = await lstat(path).catch((error) => { throw new BazifyError(`${label} is unavailable: ${formatFsError(error)}`); });
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new BazifyError(`${label} must be a physical regular file.`);
  const bytes = (await readStableFile(path)).bytes;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new BazifyError(`${label} is not valid UTF-8.`); }
}

async function readStableFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new BazifyError(`Expected a physical regular file: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!after.isFile() || current.isSymbolicLink() || !current.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== current.dev || after.ino !== current.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new BazifyError(`File changed while it was read: ${path}`);
    }
    return { bytes, mode: Number(before.mode), device: before.dev, inode: before.ino };
  } catch (error) {
    if (error instanceof BazifyError) throw error;
    throw new BazifyError(`Could not read a stable physical file ${path}: ${formatFsError(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new BazifyError(`Expected a physical directory: ${path}`);
  return { device: metadata.dev, inode: metadata.ino };
}

async function assertIdentity(path, expected, message) {
  const current = await fileIdentity(path);
  if (current.device !== expected.device || current.inode !== expected.inode) throw new BazifyError(`${message}: ${path}`);
}

async function removeOwnedDirectory(path, expected) {
  try {
    await assertIdentity(path, expected, 'Destination ownership changed during cleanup');
    await removeWritableTree(path);
  } catch (error) {
    throw new BazifyError(`Creation failed and safe cleanup could not be proven for ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function removeWritableTree(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink() && metadata.isDirectory()) {
      await chmod(path, 0o700).catch(() => undefined);
      for (const name of await readdir(path)) await removeWritableTree(join(path, name));
    } else if (!metadata.isSymbolicLink()) await chmod(path, 0o600).catch(() => undefined);
    await rm(path, { recursive: metadata.isDirectory() && !metadata.isSymbolicLink(), force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertNoGitRepository(packageRoot) {
  let current = packageRoot;
  while (true) {
    try {
      const metadata = await lstat(join(current, '.git'));
      if (metadata) throw new BazifyError(`Refusing to publish from inside an existing Git worktree: ${current}`);
    } catch (error) {
      if (error instanceof BazifyError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function authenticatedGitHubOwner(ghCommand, environment) {
  const result = runProcess(ghCommand, ['api', '--hostname', GITHUB_HOST, 'user', '--jq', '.login'], { environment, allowFailure: true });
  const owner = result.stdout.trim();
  if (result.status !== 0 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)) {
    throw new BazifyError(`GitHub CLI is not authenticated with a usable account: ${cleanDiagnostic(result.stderr)}`);
  }
  return owner;
}

function encodeApproval(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8').toString('base64url');
}

function decodeApproval(token) {
  try {
    const text = Buffer.from(token, 'base64url').toString('utf8');
    const value = JSON.parse(text);
    if (encodeApproval(value) !== token) throw new Error('approval token is not canonical');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('approval token is not an object');
    return value;
  } catch {
    throw new BazifyError('Publication approval token is invalid. Run publish --dry-run again.', 2);
  }
}

function gitIndexDigest(gitCommand, packageRoot, environment) {
  const listed = spawnSync(gitCommand, ['ls-files', '--stage', '-z'], {
    cwd: packageRoot,
    env: environment,
    encoding: 'buffer',
    shell: false
  });
  if (listed.error || listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) {
    throw new BazifyError(`Could not inspect the Git index: ${listed.error?.message ?? cleanDiagnostic(String(listed.stderr ?? ''))}`);
  }
  const entries = [];
  for (const record of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const header = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    if (separator === -1 || header.length !== 3 || header[2] !== '0' || !new Set(['100644', '100755']).has(header[0])) {
      throw new BazifyError(`Git index contains an unsupported entry: ${JSON.stringify(record)}`);
    }
    const blob = spawnSync(gitCommand, ['cat-file', 'blob', header[1]], {
      cwd: packageRoot,
      env: environment,
      encoding: 'buffer',
      shell: false
    });
    if (blob.error || blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
      throw new BazifyError(`Could not read staged Git object for ${JSON.stringify(path)}.`);
    }
    entries.push({ path, type: 'file', executable: header[0] === '100755', sha256: sha256(blob.stdout) });
  }
  entries.sort((left, right) => compare(left.path, right.path));
  return `sha256:${digestInventory(entries)}`;
}

function gitRoutingFreeEnvironment(environment) {
  const result = { ...environment };
  for (const key of Object.keys(result)) if (key.startsWith('GIT_')) delete result[key];
  return result;
}

function isolatedGitEnvironment(environment) {
  return {
    ...gitRoutingFreeEnvironment(environment),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0'
  };
}

function runRequired(command, arguments_, cwd, environment, label) {
  const result = runProcess(command, arguments_, { cwd, environment, allowFailure: true });
  if (result.status !== 0) throw new BazifyError(`${label} failed: ${cleanDiagnostic(result.stderr || result.stdout)}`);
}

function runProcess(command, arguments_, options) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    env: options.environment,
    encoding: 'utf8',
    shell: false
  });
  if (result.error) throw new BazifyError(`Could not start ${command}: ${result.error.message}`, 5);
  const status = typeof result.status === 'number' ? result.status : 1;
  if (!options.allowFailure && status !== 0) throw new BazifyError(`${command} failed with status ${status}.`, 5);
  return { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', signal: result.signal };
}

function digestInventory(entries) {
  return createHash('sha256').update(`${JSON.stringify(entries)}\n`, 'utf8').digest('hex');
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function executable(mode) { return process.platform !== 'win32' && (mode & 0o111) !== 0; }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}
function formatFsError(error) { return error instanceof Error ? error.message : String(error); }
function cleanDiagnostic(value) { return value.trim().replaceAll(/gho_[A-Za-z0-9_]+/gu, '<redacted>') || '(no diagnostic)'; }
