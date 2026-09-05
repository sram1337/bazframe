import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Harness-only IPC tracking. Runtime is bounded by the governing outer job,
 * not an invented per-message deadline. Close/error settles every waiter.
 */
export function trackProvisioningChild(childProcess) {
  const queue = [];
  const waiters = [];
  let ended;
  const stop = (message, discardQueued = false) => {
    ended = new Error(message);
    if (discardQueued) queue.length = 0;
    for (const waiter of waiters.splice(0)) waiter.reject(ended);
  };
  childProcess.on('error', () => stop('product child failed', true));
  const exited = new Promise((resolve) => {
    childProcess.once('close', (code, signal) => {
      stop('product child closed', code !== 0 || signal !== null);
      resolve({ code, signal });
    });
  });
  childProcess.on('message', (event) => {
    if (ended !== undefined) return;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(event);
    else queue.push(event);
  });
  return {
    process: childProcess,
    exited,
    async next(expected) {
      const event = queue.length > 0 ? queue.shift() : await new Promise((resolve, reject) => {
        if (ended !== undefined) reject(ended);
        else waiters.push({ resolve, reject });
      });
      if (expected !== undefined && event.event !== expected) throw new Error('unexpected product child event');
      return event;
    }
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runProvisioningChild();
}

async function runProvisioningChild() {
  // IPC carries only fixed phase/result tokens. Parent owns disposable boundaries.
  const [packageRoot, home, profileId, stop] = process.argv.slice(2);
  const load = (path) => import(pathToFileURL(join(packageRoot, path)).href);
  const { loadBazframeWin32Native } = await load('dist/core/win32-native.js');
  const { createWindowsProfileProvisioningServicesForInternalTesting } = await load('dist/profiles/win32-profile-provisioning.js');
  const { addProfile } = await load('dist/profiles/profile-management.js');
  const backend = loadBazframeWin32Native();
  const wait = () => new Promise((resolve) => process.once('message', resolve));
  const pause = async (phase) => {
    if (stop !== phase) return;
    process.send({ event: 'paused', phase });
    await wait();
  };
  const provisioningServices = createWindowsProfileProvisioningServicesForInternalTesting(backend, {
    hooks: {
      afterStateLock: () => pause('STATE_LOCK'),
      afterPhase: pause,
      afterCandidateRename: () => pause('AFTER_RENAME')
    }
  });
  process.send({ event: 'ready' });
  await wait();
  try {
    const result = await addProfile(home, profileId, { provisioningServices });
    process.send({ event: 'result', action: result.action });
  } catch (error) {
    const busy = error?.code === 'WINDOWS_OPERATION_LOCK_BUSY'
      || error?.code === 'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS';
    process.send({ event: 'result', action: busy ? 'busy' : 'refused' });
    if (!busy) process.exitCode = 1;
  } finally {
    process.disconnect();
  }
}
