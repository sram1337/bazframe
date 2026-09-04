import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, lstat, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIN32_NATIVE_BINARY_PATH = 'artifacts/native/win32-x64-msvc/bazframe-win32.node';
export const WIN32_NATIVE_ADMISSION_PATH = 'win32-native-release-admission.json';
export const WIN32_NATIVE_TARGET = 'win32-x64-msvc';
export const WIN32_NATIVE_FOUNDATION_WORKFLOW = '.github/workflows/win32-native-foundation.yml';
export const WIN32_NATIVE_NODE_VERSION = '22.19.0';
export const WIN32_NATIVE_RUST_VERSION = '1.88.0';
export const WIN32_NATIVE_MSVC_VERSION = '14.44.35207';

const FOUNDATION_PURPOSE = 'Bazframe-owned native Windows foundation evidence only; not a Windows support claim.';
const AGGREGATE_PURPOSE = 'Bazframe-owned native foundation evidence only; not release admission or a Windows support claim.';
const ADMISSION_PURPOSE = 'Authorizes only the evidenced Win32 binary for this package assembly; not a Windows support claim.';
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const POSITIVE_ID = /^[1-9][0-9]*$/u;
const STABLE_BYTE_COUNT = /^[a-f0-9]{16}$/u;
const REQUIRED_FILES = Object.freeze([
  WIN32_NATIVE_BINARY_PATH,
  'native-binary.sha256',
  'native-foundation-evidence.json',
  'native-source-evidence.json',
  'native-installed-evidence.json',
  'native-rust-version.txt',
  'native-msvc-version.txt'
]);
const OBSERVATION_BOOLEANS = Object.freeze([
  'exactIdentityWidths',
  'rootAndFileShareVolume',
  'stableReadKeptIdentity',
  'localFixedNtfs',
  'uncAndDeviceNamespacesRefused',
  'substitutedDriveRefused',
  'finalReparseRefused',
  'ancestorReparseRefused',
  'boundedStableReads',
  'junctionTargetPreserved',
  'privateDirectoryFirstVisibilityPrivate',
  'privateDirectoryOwnerCurrentUser',
  'privateDirectoryDaclPresentNonNullProtected',
  'privateDirectoryTrustedFullControl',
  'privateDirectoryNoReplace',
  'privateDirectoryParentStable',
  'privateDirectoryUnicodeName',
  'privateDirectoryInvalidNameRefusedBeforeMutation',
  'privateDirectoryReparseParentRefused',
  'privateDirectoryDirectChildLocalNtfs'
]);

export async function admitWin32NativeRelease(options) {
  const repositoryRoot = resolve(requiredString(options.repositoryRoot, 'repositoryRoot'));
  const archivePath = resolve(requiredString(options.archivePath, 'archivePath'));
  const releaseCommit = requiredMatch(options.releaseCommit, COMMIT, 'releaseCommit');
  const packageVersion = requiredString(options.packageVersion, 'packageVersion');
  const producerRepository = requiredString(options.producerRepository, 'producerRepository');
  const producerRepositoryId = requiredMatch(String(options.producerRepositoryId), POSITIVE_ID, 'producerRepositoryId');
  const producerRunId = requiredMatch(String(options.producerRunId), POSITIVE_ID, 'producerRunId');
  const artifactId = requiredMatch(String(options.artifactId), POSITIVE_ID, 'artifactId');
  const archiveDigest = normalizeArchiveDigest(options.archiveDigest);
  const expectedArchiveDigest = archiveDigest.slice('sha256:'.length);
  const archiveBytes = await readPhysicalFile(archivePath, 'native evidence archive');
  const actualArchiveDigest = sha256Bytes(archiveBytes);
  if (actualArchiveDigest !== expectedArchiveDigest) fail('artifact archive digest does not match the trusted metadata');

  const entries = await readExactArtifactArchive(archiveBytes);
  const binary = entries.get(WIN32_NATIVE_BINARY_PATH);
  const checksumText = decodeUtf8(entries.get('native-binary.sha256'), 'native-binary.sha256');
  if (!/^[a-f0-9]{64}\r?\n$/u.test(checksumText)) fail('native-binary.sha256 has an invalid shape');
  const checksum = checksumText.trim();
  const binarySha256 = sha256Bytes(binary);
  if (checksum !== binarySha256) fail('native binary does not match native-binary.sha256');

  const sourceReceipt = parseJson(entries.get('native-source-evidence.json'), 'native-source-evidence.json');
  const installedReceipt = parseJson(entries.get('native-installed-evidence.json'), 'native-installed-evidence.json');
  validateConformanceReceipt(sourceReceipt, 'source-tree', packageVersion, binarySha256);
  validateConformanceReceipt(installedReceipt, 'packed-install', packageVersion, binarySha256);

  const rustText = decodeUtf8(entries.get('native-rust-version.txt'), 'native-rust-version.txt');
  const msvcText = decodeUtf8(entries.get('native-msvc-version.txt'), 'native-msvc-version.txt');
  const aggregate = parseJson(entries.get('native-foundation-evidence.json'), 'native-foundation-evidence.json');
  validateAggregateEvidence({
    aggregate,
    releaseCommit,
    binarySha256,
    sourceReceipt,
    installedReceipt,
    rustText,
    msvcText
  });

  const manifest = parseJson(await readFile(join(repositoryRoot, 'package.json')), 'package.json');
  if (!isObject(manifest) || manifest.name !== 'bazframe' || manifest.version !== packageVersion) {
    fail('release package version does not match the repository manifest');
  }

  const artifactName = `bazframe-win32-native-foundation-${releaseCommit}`;
  const record = {
    schemaVersion: 1,
    purpose: ADMISSION_PURPOSE,
    sourceCommit: releaseCommit,
    packageVersion,
    target: WIN32_NATIVE_TARGET,
    binaryPath: WIN32_NATIVE_BINARY_PATH,
    binarySha256,
    producer: {
      repository: producerRepository,
      repositoryId: producerRepositoryId,
      workflow: WIN32_NATIVE_FOUNDATION_WORKFLOW,
      runId: producerRunId,
      artifactId,
      artifactName,
      archiveDigest
    },
    toolchain: {
      node: WIN32_NATIVE_NODE_VERSION,
      rust: WIN32_NATIVE_RUST_VERSION,
      msvcToolsVersion: WIN32_NATIVE_MSVC_VERSION
    },
    releaseAdmission: 'authorized-for-package-assembly',
    windowsSupportClaim: false
  };
  validateAdmissionRecord(record, { releaseCommit, packageVersion });

  const destination = join(repositoryRoot, WIN32_NATIVE_BINARY_PATH);
  const admissionPath = join(repositoryRoot, WIN32_NATIVE_ADMISSION_PATH);
  await requireAbsent(destination, 'native package destination');
  await requireAbsent(admissionPath, 'native admission record');
  let binaryWritten = false;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, binary, { flag: 'wx', mode: 0o644 });
    binaryWritten = true;
    await writeFile(admissionPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (binaryWritten) await rm(destination, { force: true });
    await rm(admissionPath, { force: true });
    throw error;
  }
  return record;
}

export function validateAdmissionRecord(record, expected = {}) {
  exactObject(record, [
    'schemaVersion', 'purpose', 'sourceCommit', 'packageVersion', 'target', 'binaryPath',
    'binarySha256', 'producer', 'toolchain', 'releaseAdmission', 'windowsSupportClaim'
  ], 'admission record');
  equal(record.schemaVersion, 1, 'admission schemaVersion');
  equal(record.purpose, ADMISSION_PURPOSE, 'admission purpose');
  requiredMatch(record.sourceCommit, COMMIT, 'admission sourceCommit');
  requiredString(record.packageVersion, 'admission packageVersion');
  equal(record.target, WIN32_NATIVE_TARGET, 'admission target');
  equal(record.binaryPath, WIN32_NATIVE_BINARY_PATH, 'admission binaryPath');
  requiredMatch(record.binarySha256, SHA256, 'admission binarySha256');
  exactObject(record.producer, [
    'repository', 'repositoryId', 'workflow', 'runId', 'artifactId', 'artifactName', 'archiveDigest'
  ], 'admission producer');
  requiredString(record.producer.repository, 'admission producer repository');
  requiredMatch(record.producer.repositoryId, POSITIVE_ID, 'admission producer repositoryId');
  equal(record.producer.workflow, WIN32_NATIVE_FOUNDATION_WORKFLOW, 'admission producer workflow');
  requiredMatch(record.producer.runId, POSITIVE_ID, 'admission producer runId');
  requiredMatch(record.producer.artifactId, POSITIVE_ID, 'admission producer artifactId');
  equal(record.producer.artifactName, `bazframe-win32-native-foundation-${record.sourceCommit}`, 'admission artifactName');
  normalizeArchiveDigest(record.producer.archiveDigest);
  exactObject(record.toolchain, ['node', 'rust', 'msvcToolsVersion'], 'admission toolchain');
  equal(record.toolchain.node, WIN32_NATIVE_NODE_VERSION, 'admission Node version');
  equal(record.toolchain.rust, WIN32_NATIVE_RUST_VERSION, 'admission Rust version');
  equal(record.toolchain.msvcToolsVersion, WIN32_NATIVE_MSVC_VERSION, 'admission MSVC version');
  equal(record.releaseAdmission, 'authorized-for-package-assembly', 'admission release boundary');
  equal(record.windowsSupportClaim, false, 'admission support boundary');
  if (expected.releaseCommit !== undefined) equal(record.sourceCommit, expected.releaseCommit, 'release commit');
  if (expected.packageVersion !== undefined) equal(record.packageVersion, expected.packageVersion, 'release package version');
  if (expected.producerRepository !== undefined) {
    equal(record.producer.repository, expected.producerRepository, 'producer repository');
  }
  if (expected.producerRepositoryId !== undefined) {
    equal(record.producer.repositoryId, String(expected.producerRepositoryId), 'producer repository ID');
  }
  if (expected.producerRunId !== undefined) {
    equal(record.producer.runId, String(expected.producerRunId), 'producer run ID');
  }
  return record;
}

export async function validateNativeBuildInput({ repositoryRoot, mode, releaseCommit }) {
  const root = resolve(requiredString(repositoryRoot, 'repositoryRoot'));
  const binaryPath = join(root, WIN32_NATIVE_BINARY_PATH);
  const recordPath = join(root, WIN32_NATIVE_ADMISSION_PATH);
  const binaryPresent = await physicalFileState(binaryPath, 'Windows native pack input');
  const recordPresent = await physicalFileState(recordPath, 'Windows native admission record');
  if (mode === undefined) {
    if (binaryPresent || recordPresent) fail('unadmitted Windows native pack input is present');
    return null;
  }
  if (mode === 'foundation-evidence') {
    if (!binaryPresent || recordPresent) fail('foundation evidence mode requires only the physical native binary');
    return null;
  }
  if (mode === 'release-admission') {
    if (!binaryPresent || !recordPresent) fail('release-admission mode requires the physical binary and admission record');
    return validateReleasePackInput({ repositoryRoot: root, releaseCommit });
  }
  fail(`unknown Windows native pack mode: ${String(mode)}`);
}

export async function validateReleasePackInput({ repositoryRoot, releaseCommit }) {
  const root = resolve(requiredString(repositoryRoot, 'repositoryRoot'));
  const expectedCommit = requiredMatch(releaseCommit, COMMIT, 'releaseCommit');
  const manifest = parseJson(await readFile(join(root, 'package.json')), 'package.json');
  if (!isObject(manifest) || typeof manifest.version !== 'string') fail('repository package.json is invalid');
  const binaryPath = join(root, WIN32_NATIVE_BINARY_PATH);
  const recordPath = join(root, WIN32_NATIVE_ADMISSION_PATH);
  await requirePhysicalFile(binaryPath, 'release native binary');
  await requirePhysicalFile(recordPath, 'release admission record');
  const record = parseJson(await readFile(recordPath), WIN32_NATIVE_ADMISSION_PATH);
  validateAdmissionRecord(record, { releaseCommit: expectedCommit, packageVersion: manifest.version });
  const actualDigest = await sha256File(binaryPath);
  if (actualDigest !== record.binarySha256) fail('release native binary drifted after admission');
  return record;
}

async function readExactArtifactArchive(archiveBytes) {
  const { fromBufferPromise } = await import('yauzl');
  const zip = await fromBufferPromise(archiveBytes, {
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true
  });
  return new Promise((resolveEntries, reject) => {
    const values = new Map();
    let settled = false;
    const rejectOnce = (error) => {
      if (!settled) { settled = true; reject(error); }
    };
    zip.on('error', rejectOnce);
    zip.on('entry', (entry) => {
      void (async () => {
        if (!REQUIRED_FILES.includes(entry.fileName)) fail(`unexpected native evidence entry: ${entry.fileName}`);
        if (values.has(entry.fileName)) fail(`duplicate native evidence entry: ${entry.fileName}`);
        const creatorSystem = entry.versionMadeBy >>> 8;
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if (creatorSystem !== 3 || (unixMode & 0o170000) !== 0o100000) {
          fail(`native evidence entry is not a regular file: ${entry.fileName}`);
        }
        if ((entry.generalPurposeBitFlag & 1) !== 0) fail(`encrypted native evidence entry: ${entry.fileName}`);
        const stream = await new Promise((resolveStream, rejectStream) => {
          zip.openReadStream(entry, (error, value) => {
            if (error) rejectStream(error);
            else resolveStream(value);
          });
        });
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        values.set(entry.fileName, Buffer.concat(chunks));
        zip.readEntry();
      })().catch(rejectOnce);
    });
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      const names = [...values.keys()].sort();
      const expected = [...REQUIRED_FILES].sort();
      if (!isDeepStrictEqual(names, expected)) {
        reject(new Error('Win32 native release admission failed: native evidence archive inventory is incomplete.'));
        return;
      }
      resolveEntries(values);
    });
    zip.readEntry();
  });
}

function validateAggregateEvidence({ aggregate, releaseCommit, binarySha256, sourceReceipt, installedReceipt, rustText, msvcText }) {
  exactObject(aggregate, [
    'schemaVersion', 'purpose', 'completion', 'sourceCommit', 'runnerImage', 'runnerImageVersion',
    'node', 'rust', 'msvcToolsVersion', 'msvc', 'binarySha256', 'sourceConformance',
    'installedConformance', 'releaseAdmission', 'windowsSupportClaim'
  ], 'aggregate evidence');
  equal(aggregate.schemaVersion, 2, 'aggregate schemaVersion');
  equal(aggregate.purpose, AGGREGATE_PURPOSE, 'aggregate purpose');
  equal(aggregate.completion, 'passed', 'aggregate completion');
  equal(aggregate.sourceCommit, releaseCommit, 'aggregate source commit');
  equal(aggregate.runnerImage, 'win22', 'aggregate runner image');
  requiredString(aggregate.runnerImageVersion, 'aggregate runner image version');
  equal(aggregate.node, `v${WIN32_NATIVE_NODE_VERSION}`, 'aggregate Node version');
  if (typeof aggregate.rust !== 'string' || !aggregate.rust.startsWith(`rustc ${WIN32_NATIVE_RUST_VERSION} `)
      || !aggregate.rust.includes('host: x86_64-pc-windows-msvc')) {
    fail('aggregate Rust evidence does not match the pinned Windows toolchain');
  }
  equal(aggregate.rust, rustText, 'external Rust evidence');
  equal(aggregate.msvcToolsVersion, WIN32_NATIVE_MSVC_VERSION, 'aggregate MSVC tools version');
  if (typeof aggregate.msvc !== 'string'
      || !aggregate.msvc.includes(`\\MSVC\\${WIN32_NATIVE_MSVC_VERSION}\\`)
      || !aggregate.msvc.includes('\\HostX64\\x64\\cl.exe')) {
    fail('aggregate MSVC evidence does not match the pinned x64 toolchain');
  }
  equal(aggregate.msvc, msvcText, 'external MSVC evidence');
  equal(aggregate.binarySha256, binarySha256, 'aggregate binary digest');
  if (!isDeepStrictEqual(aggregate.sourceConformance, sourceReceipt)) fail('nested source receipt differs from external receipt');
  if (!isDeepStrictEqual(aggregate.installedConformance, installedReceipt)) fail('nested installed receipt differs from external receipt');
  equal(aggregate.releaseAdmission, 'not-authorized', 'aggregate release boundary');
  equal(aggregate.windowsSupportClaim, false, 'aggregate support boundary');
}

function validateConformanceReceipt(receipt, expectedKind, packageVersion, binarySha256) {
  exactObject(receipt, [
    'schemaVersion', 'purpose', 'environment', 'packageRootKind', 'completion',
    'releaseAdmission', 'windowsSupportClaim', 'observations', 'failures'
  ], `${expectedKind} receipt`);
  equal(receipt.schemaVersion, 2, `${expectedKind} schemaVersion`);
  equal(receipt.purpose, FOUNDATION_PURPOSE, `${expectedKind} purpose`);
  exactObject(receipt.environment, ['platform', 'arch', 'node'], `${expectedKind} environment`);
  equal(receipt.environment.platform, 'win32', `${expectedKind} platform`);
  equal(receipt.environment.arch, 'x64', `${expectedKind} architecture`);
  equal(receipt.environment.node, WIN32_NATIVE_NODE_VERSION, `${expectedKind} Node version`);
  equal(receipt.packageRootKind, expectedKind, `${expectedKind} packageRootKind`);
  equal(receipt.completion, 'passed', `${expectedKind} completion`);
  equal(receipt.releaseAdmission, 'not-authorized', `${expectedKind} release boundary`);
  equal(receipt.windowsSupportClaim, false, `${expectedKind} support boundary`);
  if (!Array.isArray(receipt.failures) || receipt.failures.length !== 0) fail(`${expectedKind} failures must be empty`);
  exactObject(receipt.observations, [
    'binarySha256', 'packageVersion', 'stableByteCount', ...OBSERVATION_BOOLEANS
  ], `${expectedKind} observations`);
  equal(receipt.observations.binarySha256, binarySha256, `${expectedKind} binary digest`);
  equal(receipt.observations.packageVersion, packageVersion, `${expectedKind} package version`);
  requiredMatch(receipt.observations.stableByteCount, STABLE_BYTE_COUNT, `${expectedKind} stable byte count`);
  if (receipt.observations.stableByteCount === '0000000000000000') fail(`${expectedKind} stable byte count must be nonzero`);
  for (const name of OBSERVATION_BOOLEANS) equal(receipt.observations[name], true, `${expectedKind} ${name}`);
}

function parseJson(bytes, label) {
  try { return JSON.parse(decodeUtf8(bytes, label)); }
  catch (error) { fail(`${label} is not valid JSON`, error); }
}

function decodeUtf8(bytes, label) {
  if (!Buffer.isBuffer(bytes)) fail(`${label} is missing`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0) fail(`${label} is not canonical UTF-8`);
  return text;
}

function exactObject(value, keys, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} has missing or extra fields`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function equal(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not match the release policy`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}

function requiredMatch(value, pattern, label) {
  requiredString(value, label);
  if (!pattern.test(value)) fail(`${label} has an invalid shape`);
  return value;
}

function normalizeArchiveDigest(value) {
  requiredString(value, 'artifact archive digest');
  const normalized = value.startsWith('sha256:') ? value : `sha256:${value}`;
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) fail('artifact archive digest has an invalid shape');
  return normalized;
}

async function requireAbsent(path, label) {
  try {
    await lstat(path);
    fail(`${label} is already occupied`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function requirePhysicalFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be one physical regular file`);
}

async function physicalFileState(path, label) {
  try {
    await requirePhysicalFile(path, label);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

async function readPhysicalFile(path, label) {
  await requirePhysicalFile(path, label);
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) fail(`${label} handle must refer to one physical regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message, cause) {
  throw new Error(`Win32 native release admission failed: ${message}.`, cause === undefined ? undefined : { cause });
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
    'repository-root', 'archive', 'release-commit', 'package-version', 'producer-repository',
    'producer-repository-id', 'producer-run-id', 'artifact-id', 'archive-digest'
  ]));
  const record = await admitWin32NativeRelease({
    repositoryRoot: args['repository-root'],
    archivePath: args.archive,
    releaseCommit: args['release-commit'],
    packageVersion: args['package-version'],
    producerRepository: args['producer-repository'],
    producerRepositoryId: args['producer-repository-id'],
    producerRunId: args['producer-run-id'],
    artifactId: args['artifact-id'],
    archiveDigest: args['archive-digest']
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
