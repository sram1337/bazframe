import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const packageRoot = resolve(argument('--package-root'));
const lockRootPath = resolve(argument('--lock-root'));
const lockComponent = argument('--lock-component');
const mode = argument('--mode');

try {
  const nativeModule = await import(pathToFileURL(join(packageRoot, 'dist/core/win32-native.js')).href);
  const lockModule = await import(pathToFileURL(join(packageRoot, 'dist/state/win32-operation-lock.js')).href);
  const backend = nativeModule.loadBazframeWin32Native();
  if (mode === 'hold-native') {
    const acquisition = backend.acquireFileLock(join(lockRootPath, lockComponent, 'guard'));
    if (acquisition.state !== 'acquired') throw new Error('native guard was not acquired');
    acquisition.capability.assertHeld();
    process.stdout.write('{"state":"held"}\n');
    await new Promise(() => { setInterval(() => {}, 60_000); });
  }
  const options = {
    backend,
    lockRootPath,
    lockComponent,
    details: { command: 'native-lock-child', target: 'evidence-state' },
    hooks: mode === 'crash-unannounced'
      ? { afterKernelLockAcquired() { process.exit(86); } }
      : undefined
  };
  await lockModule.withWindowsOperationLock(options, async (authority) => {
    authority.assertHeld();
    process.stdout.write(`${JSON.stringify({ state: 'held', recovery: authority.recovery })}\n`);
    if (mode === 'hold') await new Promise(() => { setInterval(() => {}, 60_000); });
    if (mode !== 'acquire-once') throw new Error('invalid child mode');
  });
  if (mode === 'crash-unannounced') throw new Error('requested crash did not occur');
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
