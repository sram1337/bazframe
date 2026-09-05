import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeProductError } from './test-win32-profile-provisioning-child.mjs';

try {
  const [packageRoot, home, profileName, stop = 'NONE', mode = 'activate'] = process.argv.slice(2);
  const load = (path) => import(pathToFileURL(join(packageRoot, path)).href);
  const { loadBazframeWin32Native } = await load('dist/core/win32-native.js');
  const { createWindowsProfileActivationServicesForInternalTesting } = await load('dist/profile-publishing/win32-profile-activation.js');
  const { useManagedProfile } = await load('dist/profile-publishing/profile-managed-lifecycle.js');
  const wait = () => new Promise((resolve) => process.once('message', resolve));
  const pause = async (phase, required = false) => {
    if (!required && stop !== phase) return;
    process.send({ event: 'paused', phase });
    await wait();
  };
  const backend = loadBazframeWin32Native();
  const services = createWindowsProfileActivationServicesForInternalTesting(backend, { hooks: {
    afterOperationLock: (key) => key === '@store' ? pause('OPERATION_LOCK') : undefined,
    afterStateLock: () => pause('STATE_LOCK'),
    beforeReplacement: () => pause('BEFORE_REPLACEMENT', ['AFTER_REPLACEMENT', 'BEFORE_RETURN'].includes(stop)),
    afterReplacement: () => pause('AFTER_REPLACEMENT'),
    beforeReturn: () => pause('BEFORE_RETURN')
  } });
  process.send({ event: 'ready' });
  await wait();
  try {
    if (mode === 'membership') {
      const { createWindowsAddedSkillPlatformServicesForInternalTesting } = await load('dist/skills/added-skill-platform-services.js');
      const { createWindowsProfileSelectionReadServicesForInternalTesting } = await load('dist/profiles/win32-profile-selection.js');
      const { addActiveProfileSkill } = await load('dist/profiles/profile-skill-membership.js');
      await addActiveProfileSkill({ bazframeHome: home,
        platformServices: createWindowsAddedSkillPlatformServicesForInternalTesting(backend),
        selectionReadServices: createWindowsProfileSelectionReadServicesForInternalTesting(backend) }, 'demo-skill');
    } else await useManagedProfile(home, profileName, services);
    process.send({ event: 'result', action: 'committed' });
  } catch (error) {
    const busy = ['WINDOWS_OPERATION_LOCK_BUSY', 'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS'].includes(error?.code);
    process.send({ event: 'result', action: busy ? 'busy' : 'refused', ...(busy ? {} : { failure: sanitizeProductError(error) }) });
    if (!busy) process.exitCode = 1;
  } finally { process.disconnect(); }
} catch (error) {
  process.send?.({ event: 'result', action: 'refused', failure: sanitizeProductError(error) });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
