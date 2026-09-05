import { fork, spawn } from 'node:child_process';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackProvisioningChild } from './test-win32-profile-provisioning-child.mjs';

/** Same harness function runs against source-built and installed dist modules. */
export async function runWindowsProfileActivationEvidence(context) {
  const { backend, load, home, testRoot, packageRoot, services, membershipOptions, target, children, mark } = context;
  mark('activation-modules');
  const { PROFILE_PORTABILITY_PRODUCTION_LIMITS } = await load('dist/profile-portability/profile-portability-policy.js');
  const { MAX_ACTIVE_PROFILE_STATE_BYTES } = await load('dist/profiles/profile-store.js');
  const activationModule = await load('dist/profile-publishing/win32-profile-activation.js');
  const lifecycle = await load('dist/profile-publishing/profile-managed-lifecycle.js');
  const selectionModule = await load('dist/profiles/win32-profile-selection.js');
  const management = await load('dist/profiles/profile-management.js');
  const membership = await load('dist/profiles/profile-skill-membership.js');
  const provisioning = await load('dist/profiles/win32-profile-provisioning.js');
  const privateState = await load('dist/state/win32-private-directory.js');
  const closure = await load('dist/state/win32-directory-closure.js');
  const selectionReadServices = selectionModule.createWindowsProfileSelectionReadServicesForInternalTesting(backend);
  const activeOptions = { ...membershipOptions, selectionReadServices };
  const make = (options = {}) => activationModule.createWindowsProfileActivationServicesForInternalTesting(backend, options);
  const read = (root = home) => selectionModule.readWindowsSelectionSnapshot(backend, root);
  const current = (root = home) => management.currentProfile(root, selectionReadServices);
  const readCandidate = (path) => selectionModule.readWindowsPrivateFileSnapshot(backend, path, MAX_ACTIVE_PROFILE_STATE_BYTES);
  const candidateNames = async (root) => (await backend.enumerateStableDirectory(root, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries)).entries.map((entry) => entry.name);
  const newCandidate = async (root, previousNames) => {
    const name = newSelectionCandidateName(previousNames, await candidateNames(root));
    const path = join(root, name);
    return { path, snapshot: await readCandidate(path) };
  };
  const optionalCandidate = async (path) => {
    try { return await readCandidate(path); }
    catch (error) { if (error?.code === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return undefined; throw error; }
  };
  // Independently prove every successful use, including a reconciled after-effect error.
  // These observations stay in this process; only the existing booleans enter receipts.
  const use = async (name, options = {}, root = home) => {
    const { onCandidate, ...activationOptions } = options;
    const previousNames = await candidateNames(root);
    let created, candidate;
    const result = await lifecycle.useManagedProfile(root, name, make({ ...activationOptions, hooks: {
      ...activationOptions.hooks,
      async afterPrivateCreation() {
        created = await newCandidate(root, previousNames);
        requireCondition(created.snapshot.bytes.length === 0 && (created.snapshot.inspection.security.descriptorControl & 0x1000) !== 0);
        await activationOptions.hooks?.afterPrivateCreation?.(created.snapshot);
      },
      async beforeReplacement() {
        candidate = { path: created.path, snapshot: await readCandidate(created.path) };
        requireCondition(sameSelectionCandidateObject(created.snapshot, candidate.snapshot)
          && candidate.snapshot.bytes.equals(Buffer.from(`${name}\n`)));
        await onCandidate?.(candidate);
        await activationOptions.hooks?.beforeReplacement?.();
      }
    } }));
    requireCondition(candidate !== undefined);
    requireCondition(selectionCandidateCommitted(candidate.snapshot, await read(root), await optionalCandidate(candidate.path)));
    return result;
  };
  const observations = {};
  mark('current-missing');
  observations.currentMissingNoWrites = await code(() => current(join(testRoot, 'never-created-current')), 'NO_ACTIVE_PROFILE')
    && await code(() => backend.inspectPath(join(testRoot, 'never-created-current')), 'WINDOWS_NATIVE_PATH_NOT_FOUND')
    && await code(() => current(), 'NO_ACTIVE_PROFILE');
  observations.activeMissingSelectionRefused = await code(() => membership.addActiveProfileSkill(activeOptions, 'demo-skill'), 'NO_ACTIVE_PROFILE');
  const profileBefore = await readFile(join(home, 'profiles', 'focused', 'AGENTS.md'));
  const alphaBefore = await readFile(join(home, 'profiles', 'alpha', 'AGENTS.md'));
  mark('managed-activation');
  let firstVisibility = false;
  const order = [];
  const activated = await use('focused', { hooks: {
    afterOperationLock(key) { order.push(key); }, afterStateLock() { order.push('state'); },
    async afterPrivateCreation(snapshot) {
      firstVisibility = snapshot.bytes.length === 0 && (snapshot.inspection.security.descriptorControl & 0x1000) !== 0;
    }
  } });
  observations.selectionProtectedFirstVisibility = firstVisibility;
  observations.managedActivationAndCurrent = activated.active && await current() === 'focused'
    && (await read()).bytes.equals(Buffer.from('focused\n'));
  observations.activationLockOrder = JSON.stringify(order) === JSON.stringify(['@store', 'focused', 'state']);
  const inspection = await lifecycle.inspectManagedProfileActivation(home, 'focused', make());
  const view = await make().readSystemView(home);
  observations.actualJunctionClosureAndProjection = inspection.expectation.closure.entries.some((entry) => entry.kind === 'membership-link' && entry.path === 'skills/demo-skill' && entry.targetIdentity === 'catalog:skill:demo-skill')
    && inspection.profile.resourceIdentities.includes('catalog:skill:demo-skill')
    && view.resources.some((resource) => resource.stableIdentity === 'catalog:skill:demo-skill' && resource.ownerProfiles.includes('focused'))
    && view.skills.some((skill) => skill.stableIdentity === 'catalog:skill:demo-skill' && skill.selectors.includes('focused/demo-skill') && skill.directory.toLowerCase() === target.toLowerCase());
  const first = await read();
  await use('focused');
  const repeated = await read();
  observations.repeatedSelectionReplacesIdentity = first.bytes.equals(repeated.bytes) && first.inspection.object.fileId !== repeated.inspection.object.fileId;
  const activeRepeat = await membership.addActiveProfileSkill(activeOptions, 'demo-skill');
  await writeFile(join(home, 'active-profile'), 'bad\n\n');
  const malformedIdentity = backend.inspectPath(join(home, 'active-profile')).object.fileId;
  observations.activeMalformedExplicitIndependent = await code(() => membership.addActiveProfileSkill(activeOptions, 'demo-skill'), 'INVALID_PROFILE_ID')
    && (await membership.addProfileSkill(activeOptions, 'focused', 'demo-skill')).action === 'current'
    && (await readFile(join(home, 'active-profile'), 'utf8')) === 'bad\n\n'
    && backend.inspectPath(join(home, 'active-profile')).object.fileId === malformedIdentity;
  await writeFile(join(home, 'active-profile'), repeated.bytes);
  mark('active-switch');
  // Change selection before acquiring membership's state lock. A premature read would attach focused.
  let heldState = false;
  let resolvedInside = false;
  const redirectServices = { ...services, async withLock(path, details, operation) {
    if (path === join(home, 'locks', 'state.lock')) {
      await use('alpha');
      return services.withLock(path, details, async (authority) => {
        heldState = true;
        try { return await operation(authority); } finally { heldState = false; }
      });
    }
    return services.withLock(path, details, operation);
  } };
  const redirected = await membership.addActiveProfileSkill({ ...activeOptions, platformServices: redirectServices,
    selectionReadServices: { async readSelectedProfileId(root) { resolvedInside = heldState; return selectionReadServices.readSelectedProfileId(root); } } }, 'demo-skill');
  observations.activeTargetResolvedInsideStateLock = resolvedInside && redirected.profileId === 'alpha' && redirected.action === 'added';
  const alphaLink = backend.inspectMembershipLink(join(home, 'profiles', 'alpha', 'skills', 'demo-skill'));
  const explicit = await membership.addProfileSkill({ ...activeOptions, selectionReadServices: { async readSelectedProfileId() { throw new Error('explicit read selection'); } } }, 'focused', 'demo-skill');
  const detached = await membership.removeActiveProfileSkill(activeOptions, 'demo-skill');
  const detachedAgain = await membership.removeActiveProfileSkill(activeOptions, 'demo-skill');
  observations.activeExplicitIsolation = activeRepeat.action === 'current' && explicit.action === 'current'
    && detached.profileId === 'alpha' && detached.action === 'removed' && detachedAgain.action === 'absent'
    && alphaLink.targetFileId === backend.inspectPath(target).object.fileId && await current() === 'alpha';
  await use('focused');
  observations.activationPreservesProfiles = (await readFile(join(home, 'profiles', 'focused', 'AGENTS.md'))).equals(profileBefore)
    && (await readFile(join(home, 'profiles', 'alpha', 'AGENTS.md'))).equals(alphaBefore);

  mark('activation-contention');
  const owner = launch(home, 'focused', 'STATE_LOCK');
  await owner.next('ready'); owner.process.send('start'); await owner.next('paused');
  const contenders = [launch(home, 'alpha'), launch(home, 'focused', 'NONE', 'membership')];
  await Promise.all(contenders.map((child) => child.next('ready'))); contenders.forEach((child) => child.process.send('start'));
  const busy = await Promise.all(contenders.map(async (child) => { const result = await child.next('result'); const exit = await child.exited; return result.action === 'busy' && exit.code === 0; }));
  owner.process.kill(); await owner.exited;
  observations.activationAndMembershipContention = busy.every(Boolean);
  observations.killedActivationOwnerRetry = (await use('focused')).active === true;

  mark('activation-outcome-onboarding');
  const scenarioHome = join(testRoot, 'activation-outcomes', 'home');
  const provisioningServices = provisioning.createWindowsProfileProvisioningServicesForInternalTesting(backend);
  await management.addProfile(scenarioHome, 'alpha', { provisioningServices });
  await management.addProfile(scenarioHome, 'focused', { provisioningServices });
  await use('alpha', undefined, scenarioHome);
  mark('activation-deferred-refusal');
  const deferredHome = join(testRoot, 'activation-deferred', 'home');
  await management.addProfile(deferredHome, 'alpha', { provisioningServices });
  await management.addProfile(deferredHome, 'focused', { provisioningServices });
  await use('alpha', undefined, deferredHome);
  const deferredOld = await read(deferredHome);
  const deferredProfile = join(deferredHome, 'profiles', 'focused');
  const { publicationSidecarName } = await load('dist/profile-publishing/publication-state.js');
  privateState.createWindowsPrivateFile(backend, deferredProfile, publicationSidecarName());
  await writeFile(join(deferredProfile, publicationSidecarName()), '{}');
  observations.occupiedOtherProfileRefused = await code(() => use('alpha', undefined, deferredHome), 'WINDOWS_PROFILE_ACTIVATION_UNSUPPORTED_STATE')
    && same(deferredOld, await read(deferredHome)) && (await readFile(join(deferredProfile, publicationSidecarName()), 'utf8')) === '{}';
  const statePath = join(scenarioHome, 'active-profile');
  const io = { async writeExistingFile(path, bytes) { const file = await open(path, 'r+'); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }, rename };
  mark('selection-outcomes');
  let old = await read(scenarioHome);
  let retainedCandidate;
  observations.selectionExactNoEffect = await code(() => use('focused', { selectionIo: { ...io, async rename(source) {
    retainedCandidate = { path: source, snapshot: await selectionModule.readWindowsPrivateFileSnapshot(backend, source, MAX_ACTIVE_PROFILE_STATE_BYTES) };
    throw new Error('before effect');
  } } }, scenarioHome), 'WINDOWS_SELECTION_NO_EFFECT')
    && same(old, await read(scenarioHome)) && retainedCandidate.snapshot.bytes.equals(Buffer.from('focused\n'))
    && selectionCandidateRetained(retainedCandidate.snapshot, await optionalCandidate(retainedCandidate.path));
  observations.selectionAfterEffectErrorCommitted = (await use('focused', { selectionIo: { ...io, async rename(source, destination) { await rename(source, destination); throw new Error('after effect'); } } }, scenarioHome)).active
    && await current(scenarioHome) === 'focused';
  old = await read(scenarioHome);
  mark('selection-malformed');
  observations.selectionMalformedRefused = await malformedRefusal();
  // A sharing-denied real Windows handle, not a fabricated rename return.
  mark('selection-sharing');
  observations.selectionSharingNoEffect = await withSharingDenied(statePath, async () => {
    const prior = await read(scenarioHome);
    let candidate;
    return await code(() => use('alpha', { onCandidate(value) { candidate = value; } }, scenarioHome), 'WINDOWS_SELECTION_NO_EFFECT')
      && same(prior, await read(scenarioHome)) && candidate.snapshot.bytes.equals(Buffer.from('alpha\n'))
      && selectionCandidateRetained(candidate.snapshot, await optionalCandidate(candidate.path));
  });
  mark('selection-ambiguity');
  observations.selectionSubstitutionAmbiguous = await code(() => use('alpha', { selectionIo: { ...io, async rename(source, destination) {
    await rename(source, destination);
    const other = privateState.createWindowsPrivateFile(backend, scenarioHome, 'substitute.tmp');
    requireCondition(other.kind === 'regular-file');
    await io.writeExistingFile(join(scenarioHome, 'substitute.tmp'), Buffer.from('alpha\n'));
    await rename(join(scenarioHome, 'substitute.tmp'), destination);
  } } }, scenarioHome), 'WINDOWS_SELECTION_AMBIGUOUS') && await current(scenarioHome) === 'alpha';
  observations.selectionDriftBeforeEffect = await code(() => use('focused', { hooks: { async beforeReplacement() { await writeFile(statePath, 'alpha\r\n'); } } }, scenarioHome), 'WINDOWS_SELECTION_BEFORE_EFFECT')
    && (await read(scenarioHome)).bytes.equals(Buffer.from('alpha\r\n'));
  mark('selection-profile-drift');
  const beforeProfileDrift = await read(scenarioHome);
  observations.profileDriftBeforeSelectionEffect = await code(() => use('focused', { hooks: { async beforeReplacement() { await writeFile(join(scenarioHome, 'profiles', 'focused', 'AGENTS.md'), '# before drift\n'); } } }, scenarioHome), 'WINDOWS_SELECTION_BEFORE_EFFECT')
    && same(beforeProfileDrift, await read(scenarioHome));
  mark('selection-postcommit');
  let postcommitCandidate;
  observations.postcommitFailureReported = await code(() => use('focused', { onCandidate(value) { postcommitCandidate = value; }, hooks: { async afterReplacement() { await writeFile(join(scenarioHome, 'profiles', 'focused', 'AGENTS.md'), '# drift\n'); } } }, scenarioHome), 'WINDOWS_PROFILE_ACTIVATION_COMMITTED_CHECK_FAILED')
    && await current(scenarioHome) === 'focused'
    && selectionCandidateCommitted(postcommitCandidate.snapshot, await read(scenarioHome), await optionalCandidate(postcommitCandidate.path));
  mark('current-selected-missing');
  await writeFile(statePath, 'missing\r\n');
  const missingBefore = await read(scenarioHome);
  observations.currentSelectedMissingReadOnly = await current(scenarioHome) === 'missing' && same(missingBefore, await read(scenarioHome));
  await use('alpha', undefined, scenarioHome);
  mark('activation-interruption');
  let currentNoRecovery = true;
  for (const stage of ['BEFORE_REPLACEMENT', 'AFTER_REPLACEMENT', 'BEFORE_RETURN']) {
    mark(`activation-${stage}`);
    await use('alpha', undefined, scenarioHome);
    const before = await read(scenarioHome);
    const previousTemps = await candidateNames(scenarioHome);
    const child = launch(scenarioHome, 'focused', stage);
    await child.next('ready'); child.process.send('start');
    const candidate = await observeActivationChildStop(child, stage, () => newCandidate(scenarioHome, previousTemps));
    requireCondition(candidate.snapshot.bytes.equals(Buffer.from('focused\n')));
    child.process.kill(); await child.exited;
    const pending = await closure.captureWindowsDirectoryClosure(backend, scenarioHome);
    const selected = await current(scenarioHome);
    const after = await closure.captureWindowsDirectoryClosure(backend, scenarioHome);
    currentNoRecovery &&= pending.closureSha256 === after.closureSha256 && pending.rootIdentity === after.rootIdentity;
    if (stage === 'BEFORE_REPLACEMENT') {
      observations.interruptedBeforeReplacementRetained = selected === 'alpha' && same(before, await read(scenarioHome))
        && selectionCandidateRetained(candidate.snapshot, await optionalCandidate(candidate.path));
    } else observations[stage === 'AFTER_REPLACEMENT' ? 'interruptedAfterReplacementComplete' : 'interruptedBeforeReturnComplete'] = selected === 'focused'
      && selectionCandidateCommitted(candidate.snapshot, await read(scenarioHome), await optionalCandidate(candidate.path));
    requireCondition((await use('focused', undefined, scenarioHome)).active);
  }
  observations.currentPendingNoRecovery = currentNoRecovery;
  observations.interruptedActivationExplicitRetry = await current(scenarioHome) === 'focused';
  return observations;

  async function malformedRefusal() {
    await writeFile(statePath, 'malformed\n\n');
    const before = await readFile(statePath);
    const identity = backend.inspectPath(statePath).object.fileId;
    const refused = await code(() => use('alpha', undefined, scenarioHome), 'INVALID_PROFILE_ID');
    const unchanged = identity === backend.inspectPath(statePath).object.fileId && before.equals(await readFile(statePath));
    await writeFile(statePath, old.bytes);
    return refused && unchanged;
  }
  function launch(root, name, stop = 'NONE', mode = 'activate') {
    const process = fork(fileURLToPath(new URL('./test-win32-profile-activation-child.mjs', import.meta.url)), [packageRoot, root, name, stop, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const child = trackProvisioningChild(process); children.add(child); void child.exited.then(() => children.delete(child)); return child;
  }
}
/** Harness-only predicates: native snapshots are never serialized into IPC or receipts. */
export function sameSelectionCandidateObject(left, right) {
  if (left?.inspection === undefined || right?.inspection === undefined) return false;
  const a = left.inspection, b = right.inspection;
  return a.kind === 'regular-file' && b.kind === 'regular-file'
    && ['volumeIdentity', 'fileId', 'creationTime', 'numberOfLinks', 'attributes', 'directory', 'reparseTag', 'deletePending']
      .every((field) => a.object[field] !== undefined && a.object[field] === b.object[field])
    && a.security !== undefined && b.security !== undefined && JSON.stringify(a.security) === JSON.stringify(b.security);
}
export function selectionCandidateCommitted(candidate, destination, temporary) {
  return temporary === undefined && sameSelectionCandidateObject(candidate, destination)
    && Buffer.isBuffer(candidate.bytes) && Buffer.isBuffer(destination.bytes) && candidate.bytes.equals(destination.bytes)
    && ['size', 'allocationSize', 'lastWriteTime'].every((field) => candidate.inspection.object[field] === destination.inspection.object[field]);
}
export function selectionCandidateRetained(candidate, temporary) {
  return sameSelectionCandidateObject(candidate, temporary)
    && Buffer.isBuffer(candidate.bytes) && Buffer.isBuffer(temporary.bytes) && candidate.bytes.equals(temporary.bytes)
    && JSON.stringify(candidate.inspection) === JSON.stringify(temporary.inspection);
}
export function newSelectionCandidateName(previousNames, currentNames) {
  const previous = new Set(previousNames);
  const names = currentNames.filter((name) => typeof name === 'string' && !previous.has(name) && /^selection-[a-f0-9]{32}\.tmp$/u.test(name));
  requireCondition(names.length === 1);
  return names[0];
}
/** Parent observes the exact candidate before allowing a child to rename it.
 * IPC contains only fixed phase/continue tokens, never candidate observations. */
export async function observeActivationChildStop(child, stage, observeCandidate) {
  requireCondition(['BEFORE_REPLACEMENT', 'AFTER_REPLACEMENT', 'BEFORE_RETURN'].includes(stage));
  requireCondition((await child.next('paused')).phase === 'BEFORE_REPLACEMENT');
  const candidate = await observeCandidate();
  if (stage !== 'BEFORE_REPLACEMENT') {
    child.process.send('continue');
    requireCondition((await child.next('paused')).phase === stage);
  }
  return candidate;
}
function same(left, right) { return left.digest === right.digest && left.bytes.equals(right.bytes); }
async function code(operation, expected) { try { await operation(); return false; } catch (error) { return error?.code === expected; } }
function requireCondition(condition) { if (!condition) throw new Error('activation evidence condition failed'); }
async function withSharingDenied(path, operation) {
  const command = `$f=[System.IO.File]::Open('${path.replaceAll("'", "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $f.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: ['pipe', 'pipe', 'ignore'] });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output = (output + bytes.toString()).slice(0, 'ready\r\n'.length);
    if (output.startsWith('ready\n') || output === 'ready\r\n') readyResolve();
  });
  child.stdin.on('error', () => readyReject(new Error('sharing child input failed')));
  child.on('error', () => readyReject(new Error('sharing child failed')));
  const closed = new Promise((resolve) => child.once('close', (code) => { readyReject(new Error('sharing child closed')); resolve(code); }));
  try { await ready; return await operation(); }
  finally { child.stdin.end('\n'); requireCondition(await closed === 0); }
}
