import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  schemaVersion: 1,
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

let root;
let outside;
let temporaryParent;
let substDrive;
try {
  requireCondition(process.platform === 'win32' && process.arch === 'x64', 'requires win32/x64');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const module = await import(pathToFileURL(join(packageRoot, 'dist/core/win32-native.js')).href);
  const backend = module.loadBazframeWin32Native();
  const nativePath = join(
    packageRoot,
    'artifacts/native/win32-x64-msvc/bazframe-win32.node'
  );
  const nativeBytes = await readFile(nativePath);

  temporaryParent = resolve(process.env.RUNNER_TEMP ?? tmpdir());
  root = await mkdtemp(join(temporaryParent, 'bazframe-native-foundation-'));
  outside = await mkdtemp(join(temporaryParent, 'bazframe-native-outside-'));
  const file = join(root, 'stable.txt');
  const empty = join(root, 'empty.txt');
  await writeFile(file, 'stable bytes\n');
  await writeFile(empty, '');

  const rootInspection = backend.inspectPath(root);
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
  execFileSync('subst.exe', [substDrive, root], { stdio: 'pipe' });
  await expectCode(
    () => backend.inspectPath(`${substDrive}\\stable.txt`),
    'WINDOWS_NATIVE_VOLUME_NOT_FIXED'
  );

  await writeFile(join(outside, 'child.txt'), 'outside\n');
  const junction = join(root, 'outside-junction');
  await symlink(outside, junction, 'junction');
  await expectCode(() => backend.inspectPath(junction), 'WINDOWS_NATIVE_REPARSE_REFUSED');
  await expectCode(
    () => backend.inspectPath(join(junction, 'child.txt')),
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
    junctionTargetPreserved: true
  };
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
  await Promise.all([root, outside].filter(Boolean).map(async (path) => {
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

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const [path, label] of [
    [packageRoot, '[package-root]'],
    [root, '[test-root]'],
    [outside, '[outside-root]'],
    [temporaryParent, '[temporary-root]']
  ]) {
    if (typeof path === 'string' && path.length > 0) message = message.replaceAll(path, label);
  }
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    code: error !== null && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : null,
    message
  };
}
