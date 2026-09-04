import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateAdmissionRecord,
  WIN32_NATIVE_ADMISSION_PATH,
  WIN32_NATIVE_BINARY_PATH
} from './win32-native-release-admission.mjs';

const PACKAGED_BINARY = `package/${WIN32_NATIVE_BINARY_PATH}`;
const PACKAGED_MANIFEST = 'package/package.json';
const PACKAGED_ADMISSION = `package/${WIN32_NATIVE_ADMISSION_PATH}`;

export async function verifyWin32NativeReleaseTarball({
  tarballPath,
  admissionPath,
  releaseCommit,
  producerRepository,
  producerRepositoryId,
  producerRunId
}) {
  const tarball = resolve(requiredString(tarballPath, 'tarballPath'));
  const admission = resolve(requiredString(admissionPath, 'admissionPath'));
  const metadata = await lstat(tarball);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('tarball must be one physical regular file');
  const admissionMetadata = await lstat(admission);
  if (!admissionMetadata.isFile() || admissionMetadata.isSymbolicLink()) fail('admission record must be one physical regular file');
  const record = validateAdmissionRecord(parseJson(await readFile(admission), 'admission record'), {
    releaseCommit: requiredString(releaseCommit, 'releaseCommit'),
    producerRepository: requiredString(producerRepository, 'producerRepository'),
    producerRepositoryId: requiredPositiveId(producerRepositoryId, 'producerRepositoryId'),
    producerRunId: requiredPositiveId(producerRunId, 'producerRunId')
  });

  const listing = runTar(['-tzf', tarball], 'list release tarball');
  const entries = listing.trimEnd().split(/\r?\n/u).filter((entry) => entry.length > 0);
  const nativeEntries = entries.filter((entry) => /\.node$/iu.test(entry));
  if (nativeEntries.length !== 1 || nativeEntries[0] !== PACKAGED_BINARY) {
    fail('tarball must contain only the one fixed Win32 native binary member');
  }
  if (entries.filter((entry) => entry === PACKAGED_MANIFEST).length !== 1) {
    fail('tarball must contain exactly one package manifest');
  }
  if (entries.includes(PACKAGED_ADMISSION)) fail('ephemeral admission record leaked into the tarball');

  for (const member of [PACKAGED_BINARY, PACKAGED_MANIFEST]) {
    const verbose = runTar(['-tvzf', tarball, member], `inspect regular tarball member ${member}`);
    const lines = verbose.trimEnd().split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length !== 1 || lines[0][0] !== '-') fail(`tarball member is not exactly one regular file: ${member}`);
  }

  const extractionRoot = await mkdtemp(join(tmpdir(), 'bazframe-win32-release-tarball-'));
  try {
    runTar(['-xzf', tarball, '-C', extractionRoot, PACKAGED_BINARY, PACKAGED_MANIFEST], 'extract fixed release tarball members');
    const packagedManifest = parseJson(await readFile(join(extractionRoot, PACKAGED_MANIFEST)), 'package manifest');
    if (packagedManifest?.name !== 'bazframe' || packagedManifest?.version !== record.packageVersion) {
      fail('tarball package manifest does not match the admitted package version');
    }
    const extracted = join(extractionRoot, PACKAGED_BINARY);
    const extractedMetadata = await lstat(extracted);
    if (!extractedMetadata.isFile() || extractedMetadata.isSymbolicLink()) {
      fail('extracted Win32 native member is not a physical regular file');
    }
    const digest = createHash('sha256').update(await readFile(extracted)).digest('hex');
    if (digest !== record.binarySha256) fail('tarball Win32 native member digest does not match admission');
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
  return record;
}

function runTar(args, operation) {
  const result = spawnSync('tar', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) fail(`${operation} failed`);
  return result.stdout;
}

function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`Win32 native release tarball verification failed: ${label} is invalid JSON.`, { cause: error }); }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}

function requiredPositiveId(value, label) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]*$/u.test(text)) fail(`${label} must be a positive numeric ID`);
  return text;
}

function fail(message) {
  throw new Error(`Win32 native release tarball verification failed: ${message}.`);
}

function parseArguments(argv, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    const name = typeof key === 'string' && key.startsWith('--') ? key.slice(2) : null;
    if (name === null || !allowed.has(name) || Object.hasOwn(values, name) || value === undefined) {
      fail('invalid command arguments');
    }
    values[name] = value;
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2), new Set([
    'tarball', 'admission', 'release-commit', 'producer-repository', 'producer-repository-id', 'producer-run-id'
  ]));
  const record = await verifyWin32NativeReleaseTarball({
    tarballPath: args.tarball,
    admissionPath: args.admission,
    releaseCommit: args['release-commit'],
    producerRepository: args['producer-repository'],
    producerRepositoryId: args['producer-repository-id'],
    producerRunId: args['producer-run-id']
  });
  process.stdout.write(`${JSON.stringify({
    completion: 'passed',
    binaryPath: record.binaryPath,
    binarySha256: record.binarySha256,
    releaseAdmission: record.releaseAdmission,
    windowsSupportClaim: record.windowsSupportClaim
  })}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
