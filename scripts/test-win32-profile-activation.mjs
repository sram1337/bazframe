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
  const optionalCandidate = async (path) => {
    try { return await readCandidate(path); }
    catch (error) { if (error?.code === 'WINDOWS_NATIVE_PATH_NOT_FOUND') return undefined; throw error; }
  };
  const use = (name, options = {}, root = home, mark = () => {}) => observeActivationUse({
    candidateNames, readCandidate, read, optionalCandidate,
    useManagedProfile: (name, options) => lifecycle.useManagedProfile(root, name, make(options))
  }, name, options, root, mark);
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
  observations.postcommitFailureReported = await code(() => use('focused', { onCandidate(value) { postcommitCandidate = value; }, hooks: { async afterReplacement() { await writeFile(join(scenarioHome, 'profiles', 'focused', 'AGENTS.md'), '# drift\n'); } } }, scenarioHome), 'WINDOWS_PROFILE_ACTIVATION_COMMITTED_CHECK_FAILED', 'WINDOWS_PROFILE_ACTIVATION_CHANGED')
    && await current(scenarioHome) === 'focused'
    && selectionCandidateCommitted(postcommitCandidate.snapshot, await read(scenarioHome), await optionalCandidate(postcommitCandidate.path));
  mark('current-selected-missing');
  await writeFile(statePath, 'missing\r\n');
  const missingBefore = await read(scenarioHome);
  observations.currentSelectedMissingReadOnly = await current(scenarioHome) === 'missing' && same(missingBefore, await read(scenarioHome));
  mark('selection-reset-after-missing');
  await use('alpha', undefined, scenarioHome);
  mark('activation-interruption');
  let currentNoRecovery = true;
  for (const stage of ['BEFORE_REPLACEMENT', 'AFTER_REPLACEMENT', 'BEFORE_RETURN']) {
    const result = await observeActivationInterruption({ use, read, candidateNames, readCandidate,
      launch, captureClosure: (root) => closure.captureWindowsDirectoryClosure(backend, root),
      current, optionalCandidate }, stage, scenarioHome, (operation) => mark(`activation-${stage}-${operation}`), currentNoRecovery);
    currentNoRecovery &&= result.noRecovery;
    observations[stage === 'BEFORE_REPLACEMENT' ? 'interruptedBeforeReplacementRetained'
      : stage === 'AFTER_REPLACEMENT' ? 'interruptedAfterReplacementComplete' : 'interruptedBeforeReturnComplete'] = result.complete;
  }
  observations.currentPendingNoRecovery = currentNoRecovery;
  mark('activation-interruption-final-current');
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
async function observeNewCandidate(deps, root, previousNames, mark) {
  mark('candidate-enumerate');
  const name = newSelectionCandidateName(previousNames, await deps.candidateNames(root));
  const path = join(root, name);
  mark('candidate-read');
  return { path, snapshot: await deps.readCandidate(path) };
}

/** Independently prove every successful use, including a reconciled after-effect error.
 * Observations stay in this process; only existing booleans enter receipts. */
export async function observeActivationUse(deps, name, options, root, mark = () => {}) {
  const { onCandidate, ...activationOptions } = options;
  mark('temps-enumerate');
  const previousNames = await deps.candidateNames(root);
  let created, candidate;
  mark('lifecycle');
  const result = await deps.useManagedProfile(name, { ...activationOptions, hooks: {
    ...activationOptions.hooks,
    async afterPrivateCreation() {
      created = await observeNewCandidate(deps, root, previousNames, (operation) => mark(`created-${operation}`));
      mark('created-check');
      requireCondition(created.snapshot.bytes.length === 0 && (created.snapshot.inspection.security.descriptorControl & 0x1000) !== 0);
      mark('created-hook');
      await activationOptions.hooks?.afterPrivateCreation?.(created.snapshot);
      mark('lifecycle'); // Restore only after a successful hook, never in finally.
    },
    async beforeReplacement() {
      mark('written-read');
      candidate = { path: created.path, snapshot: await deps.readCandidate(created.path) };
      mark('written-check');
      requireCondition(sameSelectionCandidateObject(created.snapshot, candidate.snapshot)
        && candidate.snapshot.bytes.equals(Buffer.from(`${name}\n`)));
      mark('written-hook');
      await onCandidate?.(candidate);
      await activationOptions.hooks?.beforeReplacement?.();
      mark('lifecycle');
    }
  } });
  mark('returned-check');
  requireCondition(candidate !== undefined);
  const candidateSnapshot = candidate.snapshot; // Preserve argument capture before either awaited read.
  mark('destination-read');
  const destination = await deps.read(root);
  mark('temporary-read');
  const temporary = await deps.optionalCandidate(candidate.path);
  mark('commit-check');
  requireCondition(selectionCandidateCommitted(candidateSnapshot, destination, temporary));
  return result;
}

/** One real interruption iteration; exported only for host harness seam tests. */
export async function observeActivationInterruption(deps, stage, root, mark, currentNoRecovery = true) {
  mark('reset-use');
  await deps.use('alpha', undefined, root, (operation) => mark(`reset-use-${operation}`));
  mark('before-read');
  const before = await deps.read(root);
  mark('temps-enumerate');
  const previousTemps = await deps.candidateNames(root);
  mark('child-launch');
  const child = deps.launch(root, 'focused', stage);
  mark('child-ready');
  await child.next('ready');
  mark('child-start');
  child.process.send('start');
  const candidate = await observeActivationChildStop(child, stage, () => observeNewCandidate(deps, root, previousTemps, mark), mark);
  mark('candidate-check');
  requireCondition(candidate.snapshot.bytes.equals(Buffer.from('focused\n')));
  mark('child-kill');
  child.process.kill();
  mark('child-exit');
  await child.exited;
  mark('pending-closure');
  const pending = await deps.captureClosure(root);
  mark('current-read');
  const selected = await deps.current(root);
  mark('after-closure');
  const after = await deps.captureClosure(root);
  mark('closure-check');
  const noRecovery = currentNoRecovery && pending.closureSha256 === after.closureSha256 && pending.rootIdentity === after.rootIdentity;
  // Keep the original short circuits: do not observe or mark a suppressed read.
  const readSelection = () => { mark('selection-read'); return deps.read(root); };
  const readTemporary = () => { mark('candidate-retained-read'); return deps.optionalCandidate(candidate.path); };
  mark('selection-verify');
  const complete = stage === 'BEFORE_REPLACEMENT'
    ? selected === 'alpha' && same(before, await readSelection())
      && selectionCandidateRetained(candidate.snapshot, await readTemporary())
    : selected === 'focused' && selectionCandidateCommitted(candidate.snapshot, await readSelection(), await readTemporary());
  mark('explicit-use');
  requireCondition((await deps.use('focused', undefined, root, (operation) => mark(`explicit-use-${operation}`))).active);
  return { noRecovery, complete };
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
export async function observeActivationChildStop(child, stage, observeCandidate, mark = () => {}) {
  requireCondition(['BEFORE_REPLACEMENT', 'AFTER_REPLACEMENT', 'BEFORE_RETURN'].includes(stage));
  mark('child-before-pause');
  requireCondition((await child.next('paused')).phase === 'BEFORE_REPLACEMENT');
  const candidate = await observeCandidate();
  if (stage !== 'BEFORE_REPLACEMENT') {
    mark('child-continue');
    child.process.send('continue');
    mark('child-final-pause');
    requireCondition((await child.next('paused')).phase === stage);
  }
  return candidate;
}
function same(left, right) { return left.digest === right.digest && left.bytes.equals(right.bytes); }
/** Preserve the first unexpected refusal and its original causal chain for the existing sanitizer. */
export async function code(operation, expected, expectedCause) {
  try { await operation(); return false; }
  catch (error) {
    if (error?.code !== expected || (expectedCause !== undefined && error?.cause?.code !== expectedCause)) throw error;
    return true;
  }
}
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
