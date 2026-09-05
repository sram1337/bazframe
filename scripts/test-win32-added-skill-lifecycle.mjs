import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const packageRoot = resolve(argument('--package-root') ?? fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(argument('--output') ?? join(packageRoot, 'win32-added-skill-evidence.json'));
const report = {
  schemaVersion: 1,
  purpose: 'Internal healthy local added-Skill Windows product-slice evidence only.',
  packageRootKind: packageRoot.includes('node_modules') ? 'packed-install' : 'source-tree',
  completion: 'failed',
  releaseAdmission: 'not-authorized',
  windowsSupportClaim: false,
  publicWindowsGate: 'closed',
  observations: {},
  failures: []
};

let testRoot;
let cleanupAllowed = false;
try {
  requireCondition(process.platform === 'win32' && process.arch === 'x64', 'requires win32/x64');
  const nativeModule = await load('dist/core/win32-native.js');
  const privateDirectoryModule = await load('dist/state/win32-private-directory.js');
  const servicesModule = await load('dist/skills/added-skill-platform-services.js');
  const catalogModule = await load('dist/skills/default-skill-catalog.js');
  const membershipModule = await load('dist/profiles/profile-skill-membership.js');
  const indexModule = await load('dist/profiles/profile-skill-reference-index.js');
  const profileModule = await load('dist/profiles/profile-store.js');
  const backend = nativeModule.loadBazframeWin32Native();
  const binarySha256 = createHash('sha256')
    .update(await readFile(join(packageRoot, 'artifacts/native/win32-x64-msvc/bazframe-win32.node')))
    .digest('hex');
  const temporaryParent = resolve(process.env.BAZFRAME_WIN32_NATIVE_TEST_PARENT ?? tmpdir());
  const rootComponent = `bazframe-added-skill-${randomUUID()}`;
  testRoot = join(temporaryParent, rootComponent);
  backend.createPrivateDirectory(temporaryParent, rootComponent);
  privateDirectoryModule.admitWindowsPrivateDirectory(backend, testRoot);

  const createDirectory = (parent, component) => {
    privateDirectoryModule.createWindowsPrivateDirectory(backend, parent, component);
    return join(parent, component);
  };
  const createTextFile = async (parent, component, contents) => {
    backend.createPrivateFile(parent, component);
    const path = join(parent, component);
    await writeFile(path, contents);
    return path;
  };

  const home = createDirectory(testRoot, 'home');
  const locks = createDirectory(home, 'locks');
  createDirectory(locks, 'profiles');
  const profiles = createDirectory(home, 'profiles');
  const profile = createDirectory(profiles, 'focused');
  createDirectory(profile, 'skills');
  const profileBytes = '# Focused\n';
  await createTextFile(profile, 'AGENTS.md', profileBytes);
  const external = createDirectory(testRoot, 'external');
  const target = createDirectory(external, 'demo-skill');
  const skillBytes = '---\nname: demo-skill\n---\n# Demo\n';
  const skillFile = await createTextFile(target, 'SKILL.md', skillBytes);

  const services = servicesModule.createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
  const catalogOptions = { platformServices: services };
  const membershipOptions = { bazframeHome: home, platformServices: services };
  const firstCatalog = await catalogModule.addDefaultSkill(home, target, catalogOptions);
  const repeatedCatalog = await catalogModule.addDefaultSkill(home, target, catalogOptions);
  const firstProfile = await membershipModule.addProfileSkill(
    membershipOptions,
    'focused',
    'demo-skill'
  );
  const repeatedProfile = await membershipModule.addProfileSkill(
    membershipOptions,
    'focused',
    'demo-skill'
  );
  const catalog = await catalogModule.inspectDefaultSkillCatalog(home, catalogOptions);
  const loaded = await profileModule.loadProfile(home, 'focused', catalogOptions);
  const index = await indexModule.captureProfileSkillReferenceIndex(
    home,
    'demo-skill',
    target,
    catalogOptions
  );
  const referenceRefused = await expectCode(
    () => catalogModule.removeDefaultSkill(home, 'demo-skill', catalogOptions),
    'DEFAULT_SKILL_REFERENCED'
  );

  const catalogLink = backend.inspectMembershipLink(join(home, 'skills', 'demo-skill'));
  const profileLink = backend.inspectMembershipLink(join(profile, 'skills', 'demo-skill'));
  const targetInspection = backend.inspectPath(target);
  const directTargets = catalogLink.normalizedTarget === profileLink.normalizedTarget
    && catalogLink.normalizedTarget === targetInspection.canonicalPath
    && catalogLink.targetVolumeIdentity === profileLink.targetVolumeIdentity
    && catalogLink.targetVolumeIdentity === targetInspection.object.volumeIdentity
    && catalogLink.targetFileId === profileLink.targetFileId
    && catalogLink.targetFileId === targetInspection.object.fileId;

  const firstDetach = await membershipModule.removeProfileSkill(
    membershipOptions,
    'focused',
    'demo-skill'
  );
  const repeatedDetach = await membershipModule.removeProfileSkill(
    membershipOptions,
    'focused',
    'demo-skill'
  );
  const firstRemove = await catalogModule.removeDefaultSkill(home, 'demo-skill', catalogOptions);
  const repeatedRemove = await catalogModule.removeDefaultSkill(home, 'demo-skill', catalogOptions);
  const catalogAbsent = await expectCode(
    () => backend.inspectMembershipLink(join(home, 'skills', 'demo-skill')),
    'WINDOWS_NATIVE_PATH_NOT_FOUND'
  );
  const profileAbsent = await expectCode(
    () => backend.inspectMembershipLink(join(profile, 'skills', 'demo-skill')),
    'WINDOWS_NATIVE_PATH_NOT_FOUND'
  );
  const sourcePreserved = (await readFile(skillFile, 'utf8')) === skillBytes;
  const locksPersist = backend.inspectPath(join(locks, 'state.lock')).kind === 'directory'
    && backend.inspectPath(join(locks, 'profiles', 'focused.skills.lock')).kind === 'directory';

  const poisonHome = join(testRoot, 'public-gate-poison');
  let publicGateClosed = false;
  try {
    execFileSync(process.execPath, [join(packageRoot, 'dist/cli.js'), 'skill', 'list'], {
      env: { ...process.env, BAZFRAME_HOME: poisonHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    publicGateClosed = error?.status === 1
      && String(error.stderr).includes('WINDOWS_PLATFORM_UNSUPPORTED');
  }
  let poisonHomeAbsent = false;
  try { await readFile(poisonHome); }
  catch (error) { poisonHomeAbsent = error?.code === 'ENOENT'; }

  report.observations = {
    binarySha256,
    healthyCatalogAdded: firstCatalog.action === 'added',
    catalogIdempotent: repeatedCatalog.action === 'current',
    healthyProfileAttached: firstProfile.action === 'added',
    profileIdempotent: repeatedProfile.action === 'current',
    catalogListedExactlyOnce: catalog.skillIds.length === 1
      && catalog.skillIds[0] === 'demo-skill'
      && catalog.diagnostics.length === 0,
    profileDiscoveredExactlyOnce: loaded.skillDirectories.length === 1
      && loaded.skillDirectories[0].toLowerCase() === target.toLowerCase(),
    profileInstructionsStable: loaded.instructions === profileBytes,
    stableFileFinalInspectionProved: sourcePreserved
      && loaded.instructions === profileBytes,
    usableAndCanonicalTargetsBound: /^[A-Za-z]:\\/u.test(firstCatalog.target)
      && catalogLink.normalizedTarget === targetInspection.canonicalPath
      && firstCatalog.target.toLowerCase() === target.toLowerCase(),
    referenceIndexed: index.profileIds.length === 1
      && index.profileIds[0] === 'focused'
      && index.diagnostics.length === 0,
    referencedCatalogRemovalRefused: referenceRefused,
    catalogAndProfileDirectTargets: directTargets,
    profileDetached: firstDetach.action === 'removed',
    profileDetachIdempotent: repeatedDetach.action === 'absent',
    catalogRemoved: firstRemove.action === 'removed',
    catalogRemoveIdempotent: repeatedRemove.action === 'absent',
    linkLeavesAbsent: catalogAbsent && profileAbsent,
    sourcePreserved,
    nativeLockNamespacesPersist: locksPersist,
    publicWindowsGateClosed: publicGateClosed && poisonHomeAbsent
  };
  requireCondition(
    Object.entries(report.observations)
      .filter(([key]) => key !== 'binarySha256')
      .every(([, value]) => value === true),
    'one or more product observations failed'
  );
  report.completion = 'passed';
  cleanupAllowed = true;
} catch (error) {
  report.failures.push(sanitizeError(error));
} finally {
  if (cleanupAllowed && testRoot !== undefined) await rm(testRoot, { recursive: true, force: true });
  await mkdir(resolve(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}

if (report.completion !== 'passed') process.exitCode = 1;

async function load(relativePath) {
  return import(pathToFileURL(join(packageRoot, relativePath)).href);
}
function argument(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
async function expectCode(operation, code) {
  try { await operation(); }
  catch (error) { return error?.code === code; }
  return false;
}
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function sanitizeError(error, depth = 0) {
  if (!(error instanceof Error) || depth > 3) return { name: 'Error', message: 'sanitized product-slice failure' };
  const result = { name: error.name, message: 'sanitized product-slice failure' };
  if (typeof error.code === 'string') result.code = error.code;
  if (error.cause !== undefined) result.cause = sanitizeError(error.cause, depth + 1);
  return result;
}
