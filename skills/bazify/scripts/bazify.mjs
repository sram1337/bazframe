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
  rm,
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
  if (parsed.command === 'validate') return validateCommand(parsed, environment);
  if (parsed.command === 'publish') return publishPackage(parsed, environment);
  throw new BazifyError('Expected a command: create, validate, or publish. Run with --help.', 2);
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
  if (!new Set(['create', 'validate', 'publish']).has(command)) {
    throw new BazifyError(`Unknown command: ${String(command)}. Run with --help.`, 2);
  }
  if (parsed.positionals.length !== 1) {
    throw new BazifyError(`${command} requires exactly one path argument. Run with --help.`, 2);
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
  node <bazify-skill-root>/scripts/bazify.mjs create <source-skill> [--name <package-name>] [--destination <path>] [--dry-run]
  node <bazify-skill-root>/scripts/bazify.mjs validate <package-root>
  node <bazify-skill-root>/scripts/bazify.mjs publish <package-root> --dry-run
  node <bazify-skill-root>/scripts/bazify.mjs publish <package-root> (-y | --yes) --approval <preview-token>

Options:
  --name <id>                 Package/repository name; defaults to the Skill name
  --destination <path>        New package root outside ./bazframe/; defaults to ~/<package-name>
  --bazframe-command <path>   Bazframe executable; defaults to bazframe
  --dry-run                   Inspect and report without filesystem/network mutation
  --approval <token>          Bind publication to the exact dry-run preview
  -y, --yes                   Confirm private GitHub publication
  -h, --help                  Show this help

Create and validate never use the user's BAZFRAME_HOME. Publish is always private.
`;
}

async function createPackage(options, environment) {
  const source = await canonicalSkillRoot(options.positionals[0]);
  const sourceInventory = await inspectSkillTree(source, { allowProviderMetadata: true });
  const skillName = declaredSkillName(sourceInventory.skillDefinition);
  if (basename(source) !== skillName) {
    throw new BazifyError(`Source directory basename ${JSON.stringify(basename(source))} must match Skill name ${JSON.stringify(skillName)}.`);
  }
  const packageName = options.name ?? skillName;
  assertSafeId(packageName, 'Package name');
  const destination = await destinationPath(options.destination, packageName);
  await assertOutsideBazframeWorkspace(destination);
  assertNoOverlap(source, destination);
  await assertDestinationAbsent(destination);
  const sourceDigest = digestInventory(sourceInventory.entries);
  const plan = {
    command: 'create',
    dryRun: options.dryRun,
    source,
    skillName,
    packageName,
    destination,
    sourceDigest: `sha256:${sourceDigest}`,
    excluded: sourceInventory.excluded
  };
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
    const copiedSkill = join(destination, 'src', 'skills', skillName);
    await mkdir(copiedSkill, { recursive: true, mode: 0o755 });
    await copyPhysicalTree(source, copiedSkill, { allowProviderMetadata: true });
    const copiedInventory = await inspectSkillTree(copiedSkill, { allowProviderMetadata: false });
    const currentSource = await inspectSkillTree(source, { allowProviderMetadata: true });
    if (digestInventory(copiedInventory.entries) !== sourceDigest
      || digestInventory(currentSource.entries) !== sourceDigest) {
      throw new BazifyError('Source Skill changed while it was being copied; no package was created.');
    }
    await writeScaffold(destination, packageName, skillName, sourceDigest, sourceInventory.excluded);
    const validation = await validatePackage(destination, options.bazframeCommand, environment);
    complete = true;
    return { ...plan, dryRun: false, status: 'created', validation };
  } finally {
    if (!complete) await removeOwnedDirectory(destination, ownedIdentity);
  }
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
  const inspected = await inspectPackage(options.positionals[0]);
  await assertNoGitRepository(inspected.packageRoot);
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
  const refreshed = await inspectPackage(inspected.packageRoot);
  if (refreshed.publishDigest !== inspected.publishDigest) {
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
      ['packages', 'add', inspected.packageRoot],
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
  const manifestPath = join(packageRoot, 'bazframe-package.json');
  const manifest = await readExactJson(manifestPath, 'bazframe-package.json');
  const expectedManifest = {
    schemaVersion: 1,
    build: ['node', 'scripts/build.mjs'],
    artifactRoot: 'dist',
    skillsRoot: 'skills'
  };
  if (Object.keys(manifest).sort(compare).join(',') !== Object.keys(expectedManifest).sort(compare).join(',')
    || manifest.schemaVersion !== expectedManifest.schemaVersion
    || JSON.stringify(manifest.build) !== JSON.stringify(expectedManifest.build)
    || manifest.artifactRoot !== expectedManifest.artifactRoot
    || manifest.skillsRoot !== expectedManifest.skillsRoot) {
    throw new BazifyError('bazframe-package.json does not match the exact Bazify package contract.');
  }
  const packageManifest = await readExactJson(join(packageRoot, 'package.json'), 'package.json');
  if (packageManifest.name !== packageName || packageManifest.private !== true) {
    throw new BazifyError('package.json name must match the package directory and private must be true.');
  }
  const skillsRoot = join(packageRoot, 'src', 'skills');
  const skillDirectories = [];
  for (const name of (await readdir(skillsRoot)).sort(compare)) {
    const path = join(skillsRoot, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new BazifyError(`src/skills must contain exactly one physical Skill directory: ${path}`);
    }
    skillDirectories.push(path);
  }
  if (skillDirectories.length !== 1) throw new BazifyError('src/skills must contain exactly one Skill directory.');
  const inventory = await inspectSkillTree(skillDirectories[0], { allowProviderMetadata: false });
  const skillName = declaredSkillName(inventory.skillDefinition);
  if (basename(skillDirectories[0]) !== skillName) {
    throw new BazifyError('Copied Skill directory basename does not match its declared name.');
  }
  const publishEntries = await inspectPublishTree(packageRoot);
  await readUtf8File(join(packageRoot, 'README.md'), 'README.md');
  return {
    packageRoot,
    packageName,
    skillName,
    sourceDigest: `sha256:${digestInventory(inventory.entries)}`,
    publishDigest: `sha256:${digestInventory(publishEntries)}`
  };
}

async function canonicalSkillRoot(input) {
  const source = await canonicalDirectory(expandHome(input), 'Source Skill root');
  const definitionPath = join(source, 'SKILL.md');
  const metadata = await lstat(definitionPath).catch((error) => {
    throw new BazifyError(`Source Skill requires a physical SKILL.md: ${formatFsError(error)}`);
  });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new BazifyError(`Source Skill requires a physical regular SKILL.md: ${definitionPath}`);
  }
  return source;
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
    for (const name of names) {
      const path = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      const absolute = join(directory, name);
      const metadata = await lstat(absolute, { bigint: true });
      if (SKIPPED_SOURCE_NAMES.has(name)) {
        if (!options.allowProviderMetadata) throw new BazifyError(`Package source contains excluded provider state: ${path}`);
        excluded.push(path);
        continue;
      }
      if (metadata.isSymbolicLink()) throw new BazifyError(`Skill contains a symbolic link: ${path}`);
      const canonical = await realpath(absolute);
      if (canonical !== resolve(absolute) || !within(canonicalRoot, canonical)) {
        throw new BazifyError(`Skill entry escapes its root: ${path}`);
      }
      if (metadata.isDirectory()) {
        entries.push({ path, type: 'directory' });
        await visit(absolute, path);
      } else if (metadata.isFile()) {
        assertNotSecretName(name, path);
        const file = await readStableFile(absolute);
        assertNoPrivateKey(file.bytes, path);
        entries.push({ path, type: 'file', executable: executable(file.mode), sha256: sha256(file.bytes) });
        if (name === 'SKILL.md') {
          if (path !== 'SKILL.md') throw new BazifyError(`A single Skill must not contain a descendant SKILL.md: ${path}`);
          skillDefinition = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
        }
      } else {
        throw new BazifyError(`Skill contains an unsupported filesystem entry: ${path}`);
      }
    }
    await assertIdentity(directory, before, 'Skill directory changed during inspection');
  };
  await visit(canonicalRoot, '');
  if (skillDefinition === undefined) throw new BazifyError(`Skill root does not contain a physical SKILL.md: ${canonicalRoot}`);
  return { entries, excluded, skillDefinition };
}

async function inspectPublishTree(root) {
  const entries = [];
  const visit = async (directory, relativeDirectory) => {
    for (const name of (await readdir(directory)).sort(compare)) {
      const path = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      if (relativeDirectory === '' && name === 'dist') continue;
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
        if (!options.allowProviderMetadata) throw new BazifyError(`Package source contains excluded provider state: ${from}`);
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

async function writeScaffold(root, packageName, skillName, sourceDigest, excluded) {
  await mkdir(join(root, 'scripts'), { mode: 0o755 });
  const files = new Map([
    ['.gitignore', '/dist/\n/.bazify-dist-*/\n'],
    ['bazframe-package.json', `${JSON.stringify({ schemaVersion: 1, build: ['node', 'scripts/build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' })}\n`],
    ['package.json', `${JSON.stringify({
      name: packageName,
      version: '0.1.0',
      private: true,
      description: `Provider-owned Bazframe-compatible Skill package for ${skillName}.`,
      type: 'module',
      scripts: { build: 'node scripts/build.mjs' },
      engines: { node: '>=22.19.0' }
    }, null, 2)}\n`],
    ['README.md', readmeTemplate(packageName, skillName, sourceDigest, excluded)],
    ['AGENTS.md', agentsTemplate(packageName, skillName)],
    ['scripts/build.mjs', buildScriptTemplate()]
  ]);
  for (const [relativePath, contents] of files) {
    const path = join(root, relativePath);
    await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: relativePath.endsWith('.mjs') ? 0o755 : 0o644 });
  }
}

function readmeTemplate(packageName, skillName, sourceDigest, excluded) {
  const excludedText = excluded.length === 0 ? '(none)' : excluded.map((path) => JSON.stringify(path)).join(', ');
  return `# ${packageName}

A provider-owned Agent Skill package containing \`${skillName}\`, with a Bazframe-compatible build manifest.

## Contents

- Provider source: \`src/skills/${skillName}/\`
- Generated artifact: \`dist/skills/${skillName}/\`
- Source digest at conversion: \`sha256:${sourceDigest}\`
- Excluded provider metadata/dependencies: ${excludedText}

## Requirements and installation

The package scaffold requires Node.js 22.19 or newer and Bazframe 2. Source-specific runtime behavior and setup are documented by the copied \`src/skills/${skillName}/SKILL.md\` and its supporting files.

## Build

\`\`\`bash
npm run build
\`\`\`

Do not edit \`dist/\`; edit provider source under \`src/skills/${skillName}/\` and rebuild.

## Optional Bazframe lifecycle

Initial build, validation, and activation:

\`\`\`bash
bazframe packages add "$PWD"
bazframe profile packages add ${packageName}
\`\`\`

After provider-source changes:

\`\`\`bash
bazframe packages build ${packageName}
\`\`\`

Run \`/bazframe reload\` in an existing Pi session after activation. Remove the profile reference before removing the package:

\`\`\`bash
bazframe profile packages remove ${packageName}
bazframe packages remove ${packageName}
\`\`\`

Bazframe builds are explicit and unsandboxed. Review \`bazframe-package.json\`, \`scripts/build.mjs\`, and the copied Skill before activation.

## Source provenance

This package was created from a local Agent Skill. Its conversion-time source digest is recorded above.

## License and publication rights

Use and redistribution follow the license and notice terms preserved in the copied source.
`;
}

function agentsTemplate(packageName, skillName) {
  return `# ${packageName} provider instructions

- Treat \`src/skills/${skillName}/\` as provider-owned source and \`dist/\` as generated output.
- Preserve Agent Skills compatibility: the Skill directory and frontmatter name remain \`${skillName}\`.
- Keep \`bazframe-package.json\` exact. Its build command is a literal unsandboxed argv.
- After source edits, run \`npm run build\`, then validate through \`bazframe packages build ${packageName}\` when this provider root is registered.
- Keep README requirements, setup, provenance, and license status synchronized with source behavior.
- Do not commit secrets, provider \`.git\` state, \`node_modules\`, or generated \`dist/\`.
`;
}

function buildScriptTemplate() {
  return `#!/usr/bin/env node

import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(packageRoot, 'src', 'skills');
const distRoot = join(packageRoot, 'dist');
const stagingRoot = await mkdtemp(join(packageRoot, '.bazify-dist-'));

try {
  const skills = (await readdir(sourceRoot)).sort(compare);
  if (skills.length !== 1) throw new Error('src/skills must contain exactly one Skill directory');
  const skillRoot = join(sourceRoot, skills[0]);
  const skillMetadata = await lstat(skillRoot);
  if (skillMetadata.isSymbolicLink() || !skillMetadata.isDirectory()) throw new Error('Skill root must be a physical directory');
  const definition = await lstat(join(skillRoot, 'SKILL.md'));
  if (definition.isSymbolicLink() || !definition.isFile()) throw new Error('Skill root must contain a physical SKILL.md');
  await mkdir(join(stagingRoot, 'skills'), { mode: 0o755 });
  await copyTree(sourceRoot, join(stagingRoot, 'skills'), sourceRoot);
  await rm(distRoot, { recursive: true, force: true });
  await rename(stagingRoot, distRoot);
} catch (error) {
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}

async function copyTree(source, destination, root) {
  const before = await identity(source);
  for (const name of (await readdir(source)).sort(compare)) {
    if (name === '.git' || name === 'node_modules') throw new Error(\`Provider source contains excluded state: \${name}\`);
    const from = join(source, name); const to = join(destination, name);
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink()) throw new Error(\`Provider source contains a symbolic link: \${from}\`);
    const canonical = await realpath(from);
    if (canonical !== resolve(from) || !within(root, canonical)) throw new Error(\`Provider source escapes its root: \${from}\`);
    if (metadata.isDirectory()) {
      await mkdir(to, { mode: 0o755 });
      await copyTree(from, to, root);
    } else if (metadata.isFile()) await copyStableFile(from, to);
    else throw new Error(\`Provider source contains an unsupported entry: \${from}\`);
  }
  const after = await identity(source);
  if (before.device !== after.device || before.inode !== after.inode) throw new Error(\`Provider directory changed during build: \${source}\`);
}

async function copyStableFile(source, destination) {
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
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error(\`Provider file changed during build: \${source}\`);
    const mode = (Number(before.mode) & 0o111) !== 0 ? 0o755 : 0o644;
    await writeFile(destination, bytes, { flag: 'wx', mode });
    await chmod(destination, mode);
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
    return { bytes, mode: Number(before.mode) };
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
    GIT_CONFIG_GLOBAL: '/dev/null'
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
