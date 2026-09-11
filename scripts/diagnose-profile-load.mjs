// Read-only probe: print the errors hidden by profile listing.
import { loadProfile, resolveBazframeHome } from '../dist/profiles/profile-store.js';
import { loadBazframeWin32Native } from '../dist/core/win32-native.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting } from '../dist/skills/added-skill-platform-services.js';

const home = resolveBazframeHome(process.env);
const platformServices = createWindowsAddedSkillPlatformServicesForInternalTesting(loadBazframeWin32Native());
const names = process.argv.length > 2 ? process.argv.slice(2) : ['foo-profile', 'sampc-tester'];

for (const name of names) {
  console.log(name);
  try {
    await loadProfile(home, name, { platformServices });
    console.log('OK');
  } catch (error) {
    for (let cause = error; cause; cause = cause.cause) {
      console.log(JSON.stringify({ code: cause.code, message: cause.message }));
    }
  }
}
