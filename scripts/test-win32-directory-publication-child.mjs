import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const mode = argument('--mode');
const packageRoot = resolve(argument('--package-root'));
const parentPath = resolve(argument('--parent'));
const journalRootPath = resolve(argument('--journal-root'));
const destinationName = argument('--destination');
const transactionId = argument('--transaction');
const publicationMode = optionalArgument('--publication-mode') ?? 'replacement';
const crashPhase = optionalArgument('--crash-phase');
const crashPoint = optionalArgument('--crash-point');
const dependentStateSha256 = createHash('sha256').update('publication-dependent-state:none').digest('hex');

try {
  const nativeModule = await import(pathToFileURL(join(packageRoot, 'dist/core/win32-native.js')).href);
  const closureModule = await import(pathToFileURL(join(packageRoot, 'dist/state/win32-directory-closure.js')).href);
  const publicationModule = await import(pathToFileURL(join(packageRoot, 'dist/state/win32-directory-publication.js')).href);
  const backend = nativeModule.loadBazframeWin32Native();
  const authority = {
    transactionId,
    assertHeld() {
      // The parent conformance process serializes this isolated fixture. This
      // is not evidence for the later cooperating-writer lock milestone.
    }
  };
  const common = {
    backend,
    parentPath,
    journalRootPath,
    destinationName,
    dependentState: {
      expectedSha256: dependentStateSha256,
      observeSha256: () => dependentStateSha256
    },
    authority
  };

  if (mode === 'start') {
    const operation = publicationMode === 'fresh'
      ? { mode: 'fresh' }
      : await replacementOperation();
    await publicationModule.executeWindowsDirectoryPublication({
      ...common,
      operation,
      async materialize(candidate) {
        await candidate.createPrivateFile('new.txt', Buffer.from('new\n'));
      },
      hooks: {
        afterPhase(phase) {
          if (phase === crashPhase) process.exit(86);
        },
        afterOldRename() {
          if (crashPoint === 'after-old-rename') process.exit(86);
        },
        afterCandidateRename() {
          if (crashPoint === 'after-candidate-rename') process.exit(86);
        }
      }
    });
    process.stdout.write('{"action":"completed-without-requested-crash"}\n');
  } else if (mode === 'recover') {
    const result = await publicationModule.recoverWindowsDirectoryPublication({
      ...common,
      transactionId
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new Error('invalid child mode');
  }

  async function replacementOperation() {
    if (publicationMode !== 'replacement') throw new Error('invalid publication mode');
    const expectedOld = await closureModule.captureWindowsDirectoryClosure(
      backend,
      join(parentPath, destinationName)
    );
    return {
      mode: 'replacement',
      expectedOld: {
        rootIdentity: expectedOld.rootIdentity,
        closureSha256: expectedOld.closureSha256
      },
      overwriteAuthorization: 'explicit-overwrite'
    };
  }
} catch (error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : 'UNEXPECTED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

function argument(name) {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function optionalArgument(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}
