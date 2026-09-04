import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const packageRoot = resolve(argument('--package-root') ?? fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(argument('--output') ?? join(packageRoot, 'win32-native-evidence.json'));
const report = {
  schemaVersion: 2,
  purpose: 'Bazframe-owned native Windows foundation evidence only; not a Windows support claim.',
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node
  },
  packageRootKind: packageRoot.includes('node_modules') ? 'packed-install' : 'source-tree',
  completion: 'failed',
  releaseAdmission: 'not-authorized',
  windowsSupportClaim: false,
  observations: {},
  failures: []
};

let testRoot;
let privateRoot;
let outside;
let temporaryParent;
let substDrive;
try {
  requireCondition(process.platform === 'win32' && process.arch === 'x64', 'requires win32/x64');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const nativeModule = await import(pathToFileURL(join(packageRoot, 'dist/core/win32-native.js')).href);
  const privateDirectoryModule = await import(
    pathToFileURL(join(packageRoot, 'dist/state/win32-private-directory.js')).href
  );
  const backend = nativeModule.loadBazframeWin32Native();
  const nativePath = join(
    packageRoot,
    'artifacts/native/win32-x64-msvc/bazframe-win32.node'
  );
  const nativeBytes = await readFile(nativePath);

  temporaryParent = resolve(process.env.RUNNER_TEMP ?? tmpdir());
  const testRootComponent = `bazframe-native-foundation-${randomUUID()}`;
  testRoot = join(temporaryParent, testRootComponent);
  const bootstrapReceipt = backend.createPrivateDirectory(temporaryParent, testRootComponent);
  const rootInspection = privateDirectoryModule.admitWindowsPrivateDirectory(backend, testRoot);
  const privateComponent = 'private-数据';
  privateRoot = join(testRoot, privateComponent);
  const privateInspection = privateDirectoryModule.createWindowsPrivateDirectory(
    backend,
    testRoot,
    privateComponent
  );
  const parentAfterPrivateCreation = backend.inspectPath(testRoot);
  const occupiedBefore = backend.inspectPath(privateRoot);
  await expectCode(
    () => privateDirectoryModule.createWindowsPrivateDirectory(backend, testRoot, privateComponent),
    'WINDOWS_PRIVATE_DIRECTORY_OCCUPIED'
  );
  const occupiedAfter = backend.inspectPath(privateRoot);
  const occupiedChildUnchanged = sameDirectoryIdentityVolumeAndSecurity(
    occupiedBefore,
    occupiedAfter
  );
  const invalidComponent = 'invalid:name';
  let invalidCreationInvoked = false;
  const invalidGuardBackend = {
    ...backend,
    createPrivateDirectory(parentPath, finalComponent) {
      invalidCreationInvoked = true;
      return backend.createPrivateDirectory(parentPath, finalComponent);
    }
  };
  await expectCode(
    () => privateDirectoryModule.createWindowsPrivateDirectory(
      invalidGuardBackend,
      testRoot,
      invalidComponent
    ),
    'WINDOWS_PRIVATE_DIRECTORY_NAME_INVALID'
  );
  requireCondition(!invalidCreationInvoked, 'invalid component refused before native mutation');

  outside = await mkdtemp(join(temporaryParent, 'bazframe-native-outside-'));
  const file = join(testRoot, 'stable.txt');
  const empty = join(testRoot, 'empty.txt');
  await writeFile(file, 'stable bytes\n');
  await writeFile(empty, '');

  const fileInspection = backend.inspectPath(file);
  requireCondition(rootInspection.kind === 'directory', 'root inspection kind');
  requireCondition(fileInspection.kind === 'regular-file', 'file inspection kind');
  requireCondition(
    rootInspection.volume.identity === fileInspection.volume.identity,
    'root and file volume identity'
  );
  requireCondition(rootInspection.volume.filesystemName === 'NTFS', 'filesystem admission');
  requireCondition(rootInspection.volume.driveType === 'fixed', 'fixed-drive admission');
  requireCondition(rootInspection.volume.remoteDevice === false, 'remote-device refusal');

  const stable = await backend.readStableFile(file, Buffer.byteLength('stable bytes\n'));
  requireCondition(stable.bytes.toString('utf8') === 'stable bytes\n', 'stable bytes');
  const emptyReceipt = await backend.readStableFile(empty, 0);
  requireCondition(emptyReceipt.bytes.byteLength === 0, 'empty stable bytes');

  await expectCode(
    () => backend.readStableFile(file, 1),
    'WINDOWS_NATIVE_READ_LIMIT_EXCEEDED'
  );
  await expectCode(
    () => backend.inspectPath('\\\\localhost\\bazframe-nonexistent\\state'),
    'WINDOWS_NATIVE_TARGET_UNSUPPORTED'
  );
  await expectCode(
    () => backend.inspectPath('\\\\?\\C:\\bazframe-nonexistent'),
    'WINDOWS_NATIVE_TARGET_UNSUPPORTED'
  );

  substDrive = unusedDriveLetter();
  execFileSync('subst.exe', [substDrive, testRoot], { stdio: 'pipe' });
  await expectCode(
    () => backend.inspectPath(`${substDrive}\\stable.txt`),
    'WINDOWS_NATIVE_VOLUME_NOT_FIXED'
  );

  await writeFile(join(outside, 'child.txt'), 'outside\n');
  const junction = join(testRoot, 'outside-junction');
  await symlink(outside, junction, 'junction');
  await expectCode(() => backend.inspectPath(junction), 'WINDOWS_NATIVE_REPARSE_REFUSED');
  await expectCode(
    () => backend.inspectPath(join(junction, 'child.txt')),
    'WINDOWS_NATIVE_REPARSE_REFUSED'
  );
  await expectCode(
    () => privateDirectoryModule.createWindowsPrivateDirectory(backend, junction, 'child'),
    'WINDOWS_NATIVE_REPARSE_REFUSED'
  );
  await unlink(junction);
  requireCondition(await readFile(join(outside, 'child.txt'), 'utf8') === 'outside\n', 'junction target preserved');

  report.observations = {
    binarySha256: createHash('sha256').update(nativeBytes).digest('hex'),
    packageVersion: manifest.version,
    stableByteCount: stable.byteCount,
    exactIdentityWidths: /^[0-9a-f]{16}$/u.test(rootInspection.volume.identity)
      && /^[0-9a-f]{32}$/u.test(rootInspection.object.fileId)
      && /^[0-9a-f]{32}$/u.test(stable.before.fileId),
    rootAndFileShareVolume: rootInspection.volume.identity === fileInspection.volume.identity,
    stableReadKeptIdentity: stable.before.volumeIdentity === stable.after.volumeIdentity
      && stable.before.fileId === stable.after.fileId,
    localFixedNtfs: true,
    uncAndDeviceNamespacesRefused: true,
    substitutedDriveRefused: true,
    finalReparseRefused: true,
    ancestorReparseRefused: true,
    boundedStableReads: true,
    junctionTargetPreserved: true,
    privateDirectoryFirstVisibilityPrivate: bootstrapReceipt.created.object.fileId
      === rootInspection.object.fileId
      && bootstrapReceipt.created.security.ownerSid
        === bootstrapReceipt.created.security.currentUserSid
      && bootstrapReceipt.created.security.daclPresent
      && !bootstrapReceipt.created.security.daclNull
      && (bootstrapReceipt.created.security.descriptorControl & 0x1000) !== 0
      && bootstrapReceipt.created.security.daclBytes.equals(rootInspection.security.daclBytes),
    privateDirectoryOwnerCurrentUser: rootInspection.security.ownerSid
      === rootInspection.security.currentUserSid,
    privateDirectoryDaclPresentNonNullProtected: rootInspection.security.daclPresent
      && !rootInspection.security.daclNull
      && (rootInspection.security.descriptorControl & 0x1000) !== 0,
    privateDirectoryTrustedFullControl: true,
    privateDirectoryNoReplace: occupiedChildUnchanged,
    privateDirectoryParentStable: bootstrapReceipt.parentBefore.object.fileId
      === bootstrapReceipt.parentAfter.object.fileId
      && bootstrapReceipt.parentBefore.volume.identity
        === bootstrapReceipt.parentAfter.volume.identity
      && rootInspection.object.fileId === parentAfterPrivateCreation.object.fileId
      && rootInspection.volume.identity === parentAfterPrivateCreation.volume.identity
      && rootInspection.security.daclBytes.equals(parentAfterPrivateCreation.security.daclBytes),
    privateDirectoryUnicodeName: privateInspection.canonicalPath.toLowerCase()
      === `${rootInspection.canonicalPath}\\${privateComponent}`.toLowerCase(),
    privateDirectoryInvalidNameRefusedBeforeMutation: !invalidCreationInvoked,
    privateDirectoryReparseParentRefused: true,
    privateDirectoryDirectChildLocalNtfs: privateInspection.volume.identity
      === rootInspection.volume.identity
      && privateInspection.volume.filesystemName === 'NTFS'
  };
  for (const [name, value] of Object.entries(report.observations)) {
    if (typeof value === 'boolean') requireCondition(value, name);
  }
  report.completion = 'passed';
} catch (error) {
  report.failures.push(safeError(error));
  process.exitCode = 1;
} finally {
  if (substDrive !== undefined) {
    try { execFileSync('subst.exe', [substDrive, '/D'], { stdio: 'pipe' }); }
    catch (error) {
      report.failures.push({ stage: 'subst-cleanup', ...safeError(error) });
      report.completion = 'failed';
      process.exitCode = 1;
    }
  }
  await Promise.all([testRoot, outside].filter(Boolean).map(async (path) => {
    try { await rm(path, { recursive: true, force: true }); }
    catch (error) {
      report.failures.push({ stage: 'cleanup', ...safeError(error) });
      report.completion = 'failed';
      process.exitCode = 1;
    }
  }));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Bazframe native Windows foundation: ${report.completion}`);
  console.log(`Evidence: ${outputPath}`);
}

function unusedDriveLetter() {
  for (let code = 'Z'.charCodeAt(0); code >= 'D'.charCodeAt(0); code -= 1) {
    const drive = `${String.fromCharCode(code)}:`;
    try {
      execFileSync('cmd.exe', ['/d', '/s', '/c', `if exist ${drive}\\ exit /b 1`], { stdio: 'pipe' });
      return drive;
    } catch {
      // Occupied drive; continue toward D:.
    }
  }
  throw new Error('No unused drive letter is available for substituted-drive conformance.');
}

function argument(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function expectCode(operation, expected) {
  try {
    await operation();
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === expected) return;
    throw new Error(
      `Expected ${expected}, received ${safeError(error).code ?? safeError(error).message}`,
      { cause: error }
    );
  }
  throw new Error(`Expected ${expected}, but the operation succeeded`);
}

function requireCondition(condition, name) {
  if (!condition) throw new Error(`Native conformance failed: ${name}`);
}

function sameDirectoryIdentityVolumeAndSecurity(before, after) {
  return before.canonicalPath.toLowerCase() === after.canonicalPath.toLowerCase()
    && before.kind === 'directory'
    && after.kind === 'directory'
    && before.ancestryReparseFree === true
    && after.ancestryReparseFree === true
    && before.volume.identity === after.volume.identity
    && before.volume.filesystemName === after.volume.filesystemName
    && before.volume.driveType === after.volume.driveType
    && before.volume.canonicalVolumeGuidPath.toLowerCase()
      === after.volume.canonicalVolumeGuidPath.toLowerCase()
    && before.volume.remoteDevice === after.volume.remoteDevice
    && before.object.volumeIdentity === after.object.volumeIdentity
    && before.object.fileId === after.object.fileId
    && before.object.reparseTag === null
    && after.object.reparseTag === null
    && before.object.deletePending === false
    && after.object.deletePending === false
    && before.object.directory === true
    && after.object.directory === true
    && before.security.descriptorControl === after.security.descriptorControl
    && before.security.daclPresent === after.security.daclPresent
    && before.security.daclNull === after.security.daclNull
    && before.security.daclDefaulted === after.security.daclDefaulted
    && before.security.daclBytes.equals(after.security.daclBytes)
    && before.security.ownerSid === after.security.ownerSid
    && before.security.ownerDefaulted === after.security.ownerDefaulted
    && before.security.groupSid === after.security.groupSid
    && before.security.groupDefaulted === after.security.groupDefaulted
    && before.security.currentUserSid === after.security.currentUserSid;
}

function replaceCaseInsensitive(value, search, replacement) {
  const foldedValue = value.toLowerCase();
  const foldedSearch = search.toLowerCase();
  let cursor = 0;
  let result = '';
  while (true) {
    const index = foldedValue.indexOf(foldedSearch, cursor);
    if (index === -1) return result + value.slice(cursor);
    result += value.slice(cursor, index) + replacement;
    cursor = index + search.length;
  }
}

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const [path, label] of [
    [privateRoot, '[private-root]'],
    [testRoot, '[test-root]'],
    [outside, '[outside-root]'],
    [packageRoot, '[package-root]'],
    [temporaryParent, '[temporary-root]']
  ]) {
    if (typeof path === 'string' && path.length > 0) message = replaceCaseInsensitive(message, path, label);
  }
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    code: error !== null && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : null,
    message
  };
}
