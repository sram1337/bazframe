import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_FILES, WIN32_NATIVE_BINARY_PATH, readExactArtifactArchive,
  verifyWin32FoundationEntries } from './win32-native-release-admission.mjs';
import { verifyProductReceipt, verifyProductPair } from './verify-win32-added-skill-evidence.mjs';

const SHA = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, ID = /^[1-9][0-9]*$/u;
const LANES = ['foundation', 'product-source', 'product-installed'];
const refused = () => new Error('Windows qualification input refused.');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function requireMatch(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) throw refused(); }

export function qualificationInputName(lane, expected) {
  if (!LANES.includes(lane)) throw refused();
  requireMatch(expected.sourceCommit, COMMIT);
  requireMatch(expected.runId, ID);
  requireMatch(expected.runAttempt, ID);
  return `bazframe-win32-qualification-input-${lane}-${expected.sourceCommit}-${expected.runId}-${expected.runAttempt}`;
}

export function verifyQualificationBinding(binding, expected, foundation) {
  for (const key of ['artifact_id']) requireMatch(binding[key], ID);
  for (const key of ['artifact_digest', 'binary_sha256', 'tarball_sha256']) requireMatch(binding[key], SHA);
  requireMatch(binding.source_commit, COMMIT);
  requireMatch(binding.npm_version, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
  if (binding.source_commit !== expected.sourceCommit) throw refused();
  if (foundation && ['source_commit', 'binary_sha256', 'tarball_sha256', 'npm_version'].some((key) => binding[key] !== foundation[key])) throw refused();
}

/** Metadata expectations come from trusted event context and job outputs, never from the archive. */
export function verifyQualificationMetadata(metadata, binding, expected, lane) {
  verifyQualificationBinding(binding, expected);
  requireMatch(expected.repositoryId, ID);
  requireMatch(expected.headRepositoryId, ID);
  requireMatch(expected.headSha, COMMIT);
  if (String(metadata.id) !== binding.artifact_id || metadata.name !== qualificationInputName(lane, expected)
    || metadata.expired !== false || metadata.digest !== `sha256:${binding.artifact_digest}`
    || String(metadata.workflow_run?.id) !== expected.runId
    || String(metadata.workflow_run?.repository_id) !== expected.repositoryId
    || String(metadata.workflow_run?.head_repository_id) !== expected.headRepositoryId
    || metadata.workflow_run?.head_sha !== expected.headSha) throw refused();
}

export function verifyRepackedTarball(bytes, binding, npmVersion) {
  requireMatch(binding.tarball_sha256, SHA);
  if (npmVersion !== binding.npm_version || sha256(bytes) !== binding.tarball_sha256) throw refused();
}

export async function verifyQualifiedFoundation(entries, options, binding) {
  try {
    const result = await verifyWin32FoundationEntries(entries, options);
    if (!isDeepStrictEqual(result.sourceReceipt.observations, result.installedReceipt.observations)
      || (binding && result.binarySha256 !== binding.binary_sha256)) throw refused();
    return result;
  } catch { throw refused(); }
}

export async function verifyQualificationArchive(bytes, metadata, binding, expected, lane, options) {
  try {
    verifyQualificationMetadata(metadata, binding, expected, lane);
    if (sha256(bytes) !== binding.artifact_digest) throw refused();
    const entries = await readExactArtifactArchive(bytes, lane === 'foundation' ? REQUIRED_FILES : [lane === 'product-source' ? 'source.json' : 'installed.json']);
    if (lane === 'foundation') await verifyQualifiedFoundation(entries, options, binding);
    else verifyProductReceipt(JSON.parse(entries.values().next().value.toString('utf8')),
      lane === 'product-source' ? 'source-tree' : 'packed-install', binding.binary_sha256);
    return entries;
  } catch { throw refused(); }
}

/** Separate exclusive staging: the read-only verifier never writes or authorizes assembly. */
export async function stageQualifiedBinary(repositoryRoot, bytes, expectedSha) {
  requireMatch(expectedSha, SHA);
  if (sha256(bytes) !== expectedSha) throw refused();
  try {
    await lstat(join(repositoryRoot, 'win32-native-release-admission.json'));
    throw refused();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw refused();
  }
  const destination = join(repositoryRoot, WIN32_NATIVE_BINARY_PATH);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
}

async function physicalBytes(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw refused();
  return readFile(path);
}

async function directoryEntries(root, prefix = '') {
  const entries = new Map();
  for (const name of await readdir(join(root, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(root, relative), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw refused();
    if (stat.isDirectory()) {
      const children = await directoryEntries(root, relative);
      if (children.size === 0) throw refused();
      for (const [key, bytes] of children) entries.set(key, bytes);
    } else entries.set(relative, await physicalBytes(path));
  }
  return entries;
}

export async function promoteQualificationInputs({ foundation, source, installed, foundationBinding, sourceBinding, installedBinding, expected, options }) {
  try {
    for (const binding of [foundationBinding, sourceBinding, installedBinding]) verifyQualificationBinding(binding, expected, foundationBinding);
    await verifyQualifiedFoundation(foundation, options, foundationBinding);
    if (!isDeepStrictEqual([...source.keys()], ['source.json']) || !isDeepStrictEqual([...installed.keys()], ['installed.json'])) throw refused();
    verifyProductPair(JSON.parse(source.get('source.json').toString('utf8')),
      JSON.parse(installed.get('installed.json').toString('utf8')), foundationBinding.binary_sha256);
    // Return original verified bytes, including the producer's toolchain and nested receipts.
    return { foundation, product: new Map([...source, ...installed]) };
  } catch { throw refused(); }
}

async function writeEntries(root, entries) {
  await mkdir(root); // Exclusive output root; never merge with previous output.
  for (const [name, bytes] of entries) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
  }
}

async function main(mode) {
  const env = process.env, repositoryRoot = process.cwd();
  const expected = { sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    repositoryId: env.QUALIFICATION_REPOSITORY_ID, headRepositoryId: env.QUALIFICATION_HEAD_REPOSITORY_ID, headSha: env.QUALIFICATION_HEAD_SHA };
  const options = { repositoryRoot, releaseCommit: expected.sourceCommit,
    packageVersion: JSON.parse(await readFile('package.json', 'utf8')).version };
  const foundationBinding = env.FOUNDATION_BINDING ? JSON.parse(env.FOUNDATION_BINDING) : undefined;
  const outputRoot = join(env.RUNNER_TEMP, 'win32-qualification');
  const fetchInput = async (lane, binding) => {
    verifyQualificationBinding(binding, expected, foundationBinding);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY)) throw refused();
    const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${binding.artifact_id}`;
    const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const response = await fetch(url, { headers });
    if (!response.ok) throw refused();
    const metadata = await response.json();
    verifyQualificationMetadata(metadata, binding, expected, lane);
    const archive = await fetch(`${url}/zip`, { headers });
    if (!archive.ok) throw refused();
    return verifyQualificationArchive(Buffer.from(await archive.arrayBuffer()), metadata, binding, expected, lane, options);
  };
  if (mode === 'foundation') {
    const entries = await directoryEntries(join(outputRoot, 'foundation'));
    await verifyQualifiedFoundation(entries, options);
  } else if (mode === 'consume') {
    const entries = await fetchInput('foundation', foundationBinding);
    await stageQualifiedBinary(repositoryRoot, entries.get(WIN32_NATIVE_BINARY_PATH), foundationBinding.binary_sha256);
  } else if (mode === 'repack') {
    verifyQualificationBinding(foundationBinding, expected);
    verifyRepackedTarball(await physicalBytes(env.QUALIFICATION_TARBALL), foundationBinding, env.QUALIFICATION_NPM_VERSION);
  } else if (mode === 'product-source' || mode === 'product-installed') {
    verifyQualificationBinding(foundationBinding, expected);
    const source = mode === 'product-source';
    verifyProductReceipt(JSON.parse(await physicalBytes(join(outputRoot, 'product', source ? 'source.json' : 'installed.json'))),
      source ? 'source-tree' : 'packed-install', foundationBinding.binary_sha256);
  } else if (mode === 'promote') {
    const sourceBinding = JSON.parse(env.SOURCE_BINDING), installedBinding = JSON.parse(env.INSTALLED_BINDING);
    const foundation = await fetchInput('foundation', foundationBinding);
    const source = await fetchInput('product-source', sourceBinding);
    const installed = await fetchInput('product-installed', installedBinding);
    const result = await promoteQualificationInputs({ foundation, source, installed, foundationBinding, sourceBinding, installedBinding, expected, options });
    await mkdir(outputRoot, { recursive: true });
    await writeEntries(join(outputRoot, 'foundation'), result.foundation);
    await writeEntries(join(outputRoot, 'product'), result.product);
  } else throw refused();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw refused();
    await main(process.argv[2]);
  } catch {
    // No raw metadata, paths, contents, SIDs, or underlying exception stacks in logs/receipts.
    console.error('Windows qualification input refused.');
    process.exitCode = 1;
  }
}
