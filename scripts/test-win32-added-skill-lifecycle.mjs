import { execFileSync, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trackProvisioningChild, sanitizeProductFailure } from './test-win32-profile-provisioning-child.mjs';

const args = process.argv.slice(2);
const packageRoot = resolve(argument('--package-root') ?? fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(argument('--output') ?? join(packageRoot, 'win32-added-skill-evidence.json'));
const report = {
  schemaVersion: 2,
  purpose: 'Internal inactive-profile onboarding and healthy local added-Skill Windows product-slice evidence only.',
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
const children = new Set();
let diagnosticScenario = 'startup';
let diagnosticSubstep = 'start';
let diagnosticPhase;
try {
  requireCondition(process.platform === 'win32' && process.arch === 'x64', 'requires win32/x64');
  markStep('nativeModule');
  const nativeModule = await load('dist/core/win32-native.js');
  markStep('privateDirectoryModule');
  const privateDirectoryModule = await load('dist/state/win32-private-directory.js');
  markStep('servicesModule');
  const servicesModule = await load('dist/skills/added-skill-platform-services.js');
  markStep('catalogModule');
  const catalogModule = await load('dist/skills/default-skill-catalog.js');
  markStep('membershipModule');
  const membershipModule = await load('dist/profiles/profile-skill-membership.js');
  markStep('indexModule');
  const indexModule = await load('dist/profiles/profile-skill-reference-index.js');
  markStep('profileModule');
  const profileModule = await load('dist/profiles/profile-store.js');
  markStep('provisioningModule');
  const provisioningModule = await load('dist/profiles/win32-profile-provisioning.js');
  markStep('managementModule');
  const managementModule = await load('dist/profiles/profile-management.js');
  markStep('closureModule');
  const closureModule = await load('dist/state/win32-directory-closure.js');
  markStep('publicationModule');
  const publicationModule = await load('dist/state/win32-directory-publication.js');
  markStep('favoritesModule');
  const favoritesModule = await load('dist/profiles/profile-favorites.js');
  markStep('backend');
  const backend = nativeModule.loadBazframeWin32Native();
  markStep('binary-digest');
  const binarySha256 = createHash('sha256')
    .update(await readFile(join(packageRoot, 'artifacts/native/win32-x64-msvc/bazframe-win32.node')))
    .digest('hex');
  diagnosticScenario = 'boundary';
  markStep('start');
  const temporaryParent = resolve(process.env.BAZFRAME_WIN32_NATIVE_TEST_PARENT ?? tmpdir());
  const rootComponent = `bazframe-added-skill-${randomUUID()}`;
  testRoot = join(temporaryParent, rootComponent);
  markStep('create-boundary');
  backend.createPrivateDirectory(temporaryParent, rootComponent);
  // Only the disposable boundary is fixture-prepared. It is deliberately
  // namespace-safe but not owner-private, exercising actual bootstrap policy.
  markStep('boundary-acl');
  execFileSync('icacls.exe', [testRoot, '/grant', '*S-1-5-32-545:(RX)'], { stdio: 'pipe' });
  markStep('ordinaryBoundary');
  const ordinaryBoundary = await expectCode(
    () => privateDirectoryModule.admitWindowsPrivateDirectory(backend, testRoot),
    'WINDOWS_PRIVATE_DIRECTORY_PRIVACY_UNPROVED'
  );

  const createDirectory = (parent, component) => {
    backend.createPrivateDirectory(parent, component);
    privateDirectoryModule.admitWindowsPrivateDirectory(backend, join(parent, component));
    return join(parent, component);
  };
  const createTextFile = async (parent, component, contents) => {
    backend.createPrivateFile(parent, component);
    const path = join(parent, component);
    await writeFile(path, contents);
    return path;
  };

  diagnosticScenario = 'onboarding';
  markStep('start');
  const home = join(testRoot, 'missing-intermediate', 'home');
  const locks = join(home, 'locks');
  const profile = join(home, 'profiles', 'focused');
  const profileBytes = '';
  const provisioningServices = provisioningModule.createWindowsProfileProvisioningServicesForInternalTesting(backend, {
    hooks: {
      afterStateLock() { diagnosticPhase = 'STATE_LOCK'; },
      afterPhase(phase) { diagnosticPhase = phase; },
      afterCandidateRename() { diagnosticPhase = 'AFTER_RENAME'; }
    }
  });
  const provisioningOptions = { provisioningServices };
  markStep('absentListing');
  const absentListing = await managementModule.listProfiles(home, provisioningOptions);
  markStep('absent-home-check');
  const absentHomeReadOnly = absentListing.profileIds.length === 0
    && await expectCode(() => backend.inspectPath(home), 'WINDOWS_NATIVE_PATH_NOT_FOUND');
  markStep('firstAdd');
  const firstAdd = await managementModule.addProfile(home, 'focused', provisioningOptions);
  markStep('generated');
  const generated = await closureModule.captureWindowsDirectoryClosure(backend, profile);
  const emptyGenerated = generated.closure.entries.length === 2
    && generated.closure.entries[0].path === 'AGENTS.md'
    && generated.closure.entries[0].kind === 'file'
    && generated.closure.entries[0].bytes === 0
    && generated.closure.entries[1].path === 'skills'
    && generated.closure.entries[1].kind === 'directory';
  markStep('repeatedAdd');
  const repeatedAdd = await managementModule.addProfile(home, 'focused', provisioningOptions);
  markStep('add-alpha');
  await managementModule.addProfile(home, 'alpha', provisioningOptions);
  markStep('listedProfiles');
  const listedProfiles = await managementModule.listProfiles(home, provisioningOptions);
  markStep('bootstrapPrivate');
  const bootstrapPrivate = privateDirectoryModule.admitWindowsPrivateDirectory(backend, home);
  markStep('intermediatePrivate');
  const intermediatePrivate = privateDirectoryModule.admitWindowsPrivateDirectory(backend, join(testRoot, 'missing-intermediate'));
  diagnosticScenario = 'external-skill';
  markStep('start');
  markStep('external');
  const external = createDirectory(testRoot, 'external');
  markStep('target');
  const target = createDirectory(external, 'demo-skill');
  const skillBytes = '---\nname: demo-skill\n---\n# Demo\n';
  markStep('skillFile');
  const skillFile = await createTextFile(target, 'SKILL.md', skillBytes);

  diagnosticScenario = 'skill-lifecycle';
  markStep('start');
  const services = servicesModule.createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
  const catalogOptions = { platformServices: services };
  const membershipOptions = { bazframeHome: home, platformServices: services };
  markStep('firstCatalog');
  const firstCatalog = await catalogModule.addDefaultSkill(home, target, catalogOptions);
  markStep('repeatedCatalog');
  const repeatedCatalog = await catalogModule.addDefaultSkill(home, target, catalogOptions);
  markStep('firstProfile');
  const firstProfile = await membershipModule.addProfileSkill(
    membershipOptions,
    'focused',
    'demo-skill'
  );
  markStep('repeatedProfile');
  const repeatedProfile = await membershipModule.addProfileSkill(
    membershipOptions,
    'focused',
    'demo-skill'
  );
  markStep('afterMembershipAdd');
  const afterMembershipAdd = await managementModule.addProfile(home, 'focused', provisioningOptions);
  markStep('isolated');
  const isolated = await profileModule.loadProfile(home, 'alpha', catalogOptions);
  markStep('catalog');
  const catalog = await catalogModule.inspectDefaultSkillCatalog(home, catalogOptions);
  markStep('loaded');
  const loaded = await profileModule.loadProfile(home, 'focused', catalogOptions);
  markStep('index');
  const index = await indexModule.captureProfileSkillReferenceIndex(
    home,
    'demo-skill',
    target,
    catalogOptions
  );
  markStep('referenceRefused');
  const referenceRefused = await expectCode(
    () => catalogModule.removeDefaultSkill(home, 'demo-skill', catalogOptions),
    'DEFAULT_SKILL_REFERENCED'
  );

  markStep('catalogLink');
  const catalogLink = backend.inspectMembershipLink(join(home, 'skills', 'demo-skill'));
  markStep('profileLink');
  const profileLink = backend.inspectMembershipLink(join(profile, 'skills', 'demo-skill'));
  markStep('targetInspection');
  const targetInspection = backend.inspectPath(target);
  const directTargets = catalogLink.normalizedTarget === profileLink.normalizedTarget
    && catalogLink.normalizedTarget === targetInspection.canonicalPath
    && catalogLink.targetVolumeIdentity === profileLink.targetVolumeIdentity
    && catalogLink.targetVolumeIdentity === targetInspection.object.volumeIdentity
    && catalogLink.targetFileId === profileLink.targetFileId
    && catalogLink.targetFileId === targetInspection.object.fileId;

  markStep('firstDetach');
  const firstDetach = await membershipModule.removeProfileSkill(
    membershipOptions,
    'focused',
    'demo-skill'
  );
  markStep('repeatedDetach');
  const repeatedDetach = await membershipModule.removeProfileSkill(
    membershipOptions,
    'focused',
    'demo-skill'
  );
  markStep('firstRemove');
  const firstRemove = await catalogModule.removeDefaultSkill(home, 'demo-skill', catalogOptions);
  markStep('repeatedRemove');
  const repeatedRemove = await catalogModule.removeDefaultSkill(home, 'demo-skill', catalogOptions);
  markStep('catalogAbsent');
  const catalogAbsent = await expectCode(
    () => backend.inspectMembershipLink(join(home, 'skills', 'demo-skill')),
    'WINDOWS_NATIVE_PATH_NOT_FOUND'
  );
  markStep('profileAbsent');
  const profileAbsent = await expectCode(
    () => backend.inspectMembershipLink(join(profile, 'skills', 'demo-skill')),
    'WINDOWS_NATIVE_PATH_NOT_FOUND'
  );
  markStep('sourcePreserved');
  const sourcePreserved = (await readFile(skillFile, 'utf8')) === skillBytes;
  markStep('locksPersist');
  const locksPersist = backend.inspectPath(join(locks, 'state.lock')).kind === 'directory'
    && backend.inspectPath(join(locks, 'profiles', 'focused.skills.lock')).kind === 'directory';

  diagnosticScenario = 'public-gate';
  markStep('start');
  const poisonHome = join(testRoot, 'public-gate-poison');
  let publicGateClosed = false;
  markStep('invoke-cli');
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
  markStep('poison-home-check');
  let poisonHomeAbsent = false;
  try { await readFile(poisonHome); }
  catch (error) { poisonHomeAbsent = error?.code === 'ENOENT'; }

  diagnosticScenario = 'contention';
  markStep('start');
  const contentionHome = join(testRoot, 'contention', 'home');
  const contenders = [launchChild(contentionHome, 'STATE_LOCK'), launchChild(contentionHome, 'STATE_LOCK')];
  markStep('contenders-ready');
  await Promise.all(contenders.map((child) => child.next('ready')));
  contenders.forEach((child) => child.process.send('start'));
  markStep('contentionEvents');
  const contentionEvents = await Promise.all(contenders.map((child) => child.next()));
  const winnerIndex = contentionEvents.findIndex((event) => event.event === 'paused' && event.phase === 'STATE_LOCK');
  requireCondition(winnerIndex !== -1, 'bootstrap contention did not acquire one state lock');
  requireCondition(contentionEvents[1 - winnerIndex].action === 'busy', 'bootstrap contention did not refuse the second authority');
  contenders[winnerIndex].process.send('continue');
  markStep('winnerResult');
  const winnerResult = await contenders[winnerIndex].next('result');
  markStep('contentionExits');
  const contentionExits = await Promise.all(contenders.map((child) => child.exited));
  requireCondition(contentionExits.every((exit) => exit.code === 0 && exit.signal === null), 'bootstrap contender failed');
  markStep('contentionRetry');
  const contentionRetry = await runChild(contentionHome);

  const crashObservations = {};
  let readOnlyListingNoRecovery = true;
  const crashPhases = [
    ['PLANNED', 'freshPublicationPlannedRetry'],
    ['CANDIDATE_READY', 'freshPublicationCandidateReadyRetry'],
    ['CANDIDATE_RENAME_INTENT', 'freshPublicationRenameIntentRetry'],
    ['AFTER_RENAME', 'freshPublicationAfterRenameRetry'],
    ['CANDIDATE_RENAME_PROVEN', 'freshPublicationRenameProvenRetry'],
    ['DEPENDENT_STATE_PROVEN', 'freshPublicationDependentStateRetry'],
    ['COMMITTED', 'freshPublicationCommittedRetry']
  ];
  for (const [phase, observation] of crashPhases) {
    diagnosticScenario = `crash-${phase}`;
    markStep('start');
    const crashHome = join(testRoot, `crash-${phase.toLowerCase().replaceAll('_', '-')}`, 'home');
    const child = launchChild(crashHome, phase);
    markStep('child-ready');
    await child.next('ready');
    child.process.send('start');
    markStep('stopped');
    const stopped = await child.next('paused');
    requireCondition(stopped.phase === phase, 'wrong interruption phase');
    child.process.kill();
    markStep('child-exited');
    await child.exited;
    const livePath = join(crashHome, 'profiles', 'focused');
    const beforeRename = ['PLANNED', 'CANDIDATE_READY', 'CANDIDATE_RENAME_INTENT'].includes(phase);
    markStep('beforeLive');
    const beforeLive = beforeRename ? undefined : await closureModule.captureWindowsDirectoryClosure(backend, livePath);
    if (beforeRename) requireCondition(await expectCode(() => backend.inspectPath(livePath), 'WINDOWS_NATIVE_PATH_NOT_FOUND'), 'partial live profile appeared');
    markStep('beforeRead');
    const beforeRead = await closureModule.captureWindowsDirectoryClosure(backend, crashHome);
    markStep('readOnly');
    const readOnly = await managementModule.listProfiles(crashHome, provisioningOptions);
    markStep('afterRead');
    const afterRead = await closureModule.captureWindowsDirectoryClosure(backend, crashHome);
    readOnlyListingNoRecovery &&= beforeRead.closureSha256 === afterRead.closureSha256
      && readOnly.profileIds.length === (beforeRename ? 0 : 1);
    markStep('retried');
    const retried = await runChild(crashHome);
    markStep('live');
    const live = await closureModule.captureWindowsDirectoryClosure(backend, livePath);
    crashObservations[observation] = retried.action === (['PLANNED', 'CANDIDATE_READY'].includes(phase) ? 'added' : 'current')
      && live.closure.entries.length === 2
      && live.closure.entries[0].kind === 'file' && live.closure.entries[0].path === 'AGENTS.md'
      && live.closure.entries[0].bytes === 0
      && live.closure.entries[1].kind === 'directory' && live.closure.entries[1].path === 'skills'
      && (beforeLive === undefined || beforeLive.rootIdentity === live.rootIdentity);
  }

  // Adversarial perturbations happen only after real fixture-free onboarding
  // reaches a persisted rename intent and its child has terminated.
  const refusalObservations = {};
  for (const mode of ['occupied', 'drift']) {
    diagnosticScenario = `refusal-${mode}`;
    markStep('start');
    const refusalHome = join(testRoot, `refusal-${mode}`, 'home');
    const child = launchChild(refusalHome, 'CANDIDATE_RENAME_INTENT');
    markStep('child-ready');
    await child.next('ready');
    child.process.send('start');
    markStep('stopped');
    const stopped = await child.next('paused');
    requireCondition(stopped.phase === 'CANDIDATE_RENAME_INTENT', 'wrong refusal setup phase');
    child.process.kill();
    markStep('child-exited');
    await child.exited;
    const parentPath = join(refusalHome, 'profiles');
    const journalRootPath = join(refusalHome, 'windows-transactions', 'profile-add', 'focused');
    markStep('transactions');
    const transactions = await services.enumeratePrivateDirectory(journalRootPath, servicesModule.ADDED_SKILL_NAMESPACE_ENTRY_LIMIT);
    requireCondition(transactions.names.length === 1 && /^[a-f0-9]{32}$/u.test(transactions.names[0]), 'unexpected refusal transaction namespace');
    const transactionId = transactions.names[0];
    const journalPath = join(journalRootPath, transactionId);
    const readJournal = () => publicationModule.readWindowsDirectoryPublicationJournal(
      backend, parentPath, journalRootPath, journalPath, transactionId
    );
    markStep('planned');
    const planned = await readJournal();
    requireCondition(planned.phase === 'CANDIDATE_RENAME_INTENT' && planned.mode === 'fresh'
      && planned.destinationName === 'focused', 'unexpected refusal journal');
    const candidatePath = join(parentPath, planned.candidateName);
    const destinationPath = join(parentPath, 'focused');
    markStep('candidateBeforePerturbation');
    const candidateBeforePerturbation = await closureModule.captureWindowsDirectoryClosure(backend, candidatePath);
    requireCondition(candidateBeforePerturbation.rootIdentity === planned.candidate.rootIdentity
      && candidateBeforePerturbation.closureSha256 === planned.candidate.closureSha256, 'candidate did not match its original journal proof');
    let occupantBefore;
    const occupantBytes = Buffer.from('occupied destination must survive\n');
    if (mode === 'occupied') {
      markStep('create-occupant');
      await createTextFile(parentPath, 'focused', occupantBytes);
      markStep('occupant-before');
      occupantBefore = await privateFileSnapshot(destinationPath, occupantBytes);
    } else {
      // Edit only the known, admitted zero-byte candidate instruction file.
      const instructionPath = join(candidatePath, 'AGENTS.md');
      markStep('before');
      const before = await privateFileSnapshot(instructionPath, Buffer.alloc(0));
      const changedBytes = Buffer.from('candidate drift must remain private\n');
      markStep('perturb-candidate');
      await writeFile(instructionPath, changedBytes, { flag: 'r+' });
      markStep('changed');
      const changed = await privateFileSnapshot(instructionPath, changedBytes);
      requireCondition(before.identity === changed.identity, 'candidate perturbation replaced the file');
    }
    markStep('candidateBefore');
    const candidateBefore = await closureModule.captureWindowsDirectoryClosure(backend, candidatePath);
    requireCondition(candidateBefore.rootIdentity === candidateBeforePerturbation.rootIdentity, 'candidate root changed during perturbation');
    if (mode === 'drift') requireCondition(candidateBefore.closureSha256 !== candidateBeforePerturbation.closureSha256, 'candidate perturbation had no effect');
    markStep('journalBefore');
    const journalBefore = await closureModule.captureWindowsDirectoryClosure(backend, journalPath);
    markStep('refused');
    const refused = await expectCode(
      () => managementModule.addProfile(refusalHome, 'focused', provisioningOptions),
      'WINDOWS_PROFILE_PROVISIONING_REFUSED'
    );
    markStep('candidateAfter');
    const candidateAfter = await closureModule.captureWindowsDirectoryClosure(backend, candidatePath);
    markStep('journalAfter');
    const journalAfter = await closureModule.captureWindowsDirectoryClosure(backend, journalPath);
    markStep('ambiguous');
    const ambiguous = await readJournal();
    const retained = candidateAfter.rootIdentity === candidateBefore.rootIdentity
      && candidateAfter.closureSha256 === candidateBefore.closureSha256
      && journalAfter.rootIdentity === journalBefore.rootIdentity
      && journalAfter.closure.entries.length === journalBefore.closure.entries.length + 1
      && journalBefore.closure.entries.every((entry, index) => JSON.stringify(entry) === JSON.stringify(journalAfter.closure.entries[index]))
      && ambiguous.phase === 'AMBIGUOUS';
    // A terminal ambiguous retry must refuse again without rewriting its evidence.
    markStep('refusedAgain');
    const refusedAgain = await expectCode(
      () => managementModule.addProfile(refusalHome, 'focused', provisioningOptions),
      'WINDOWS_PROFILE_PROVISIONING_REFUSED'
    );
    markStep('terminal');
    const terminal = await closureModule.captureWindowsDirectoryClosure(backend, journalPath);
    markStep('terminalCandidate');
    const terminalCandidate = await closureModule.captureWindowsDirectoryClosure(backend, candidatePath);
    const stableTerminal = terminal.rootIdentity === journalAfter.rootIdentity && terminal.closureSha256 === journalAfter.closureSha256
      && terminalCandidate.rootIdentity === candidateBefore.rootIdentity && terminalCandidate.closureSha256 === candidateBefore.closureSha256;
    refusalObservations[mode === 'occupied' ? 'occupiedDestinationRefusedUnchanged' : 'candidateDriftAmbiguityRetained'] = refused && refusedAgain && retained && stableTerminal
      && (mode === 'occupied'
        ? samePrivateFile(occupantBefore, await privateFileSnapshot(destinationPath, occupantBytes))
        : await expectCode(() => backend.inspectPath(destinationPath), 'WINDOWS_NATIVE_PATH_NOT_FOUND'));
  }

  // Separate existing-state scenario: initial onboarding above remains absent
  // and unselected. Only after product creation do bounded fixture edits model
  // existing selection/preferences/instructions; activation itself is not wired.
  diagnosticScenario = 'existing-state';
  markStep('start');
  const preservedHome = join(testRoot, 'existing-state', 'home');
  markStep('add-focused');
  await managementModule.addProfile(preservedHome, 'focused', provisioningOptions);
  markStep('add-spare');
  await managementModule.addProfile(preservedHome, 'spare', provisioningOptions);
  const activeBytes = Buffer.from('focused\r\n');
  const favoritesBytes = Buffer.from(favoritesModule.encodeProfileFavorites(['spare']));
  const editedBytes = Buffer.from('# Existing personal instructions\r\n');
  markStep('activePath');
  const activePath = await createTextFile(preservedHome, 'active-profile', activeBytes);
  markStep('favoritesPath');
  const favoritesPath = await createTextFile(preservedHome, 'profile-favorites.json', favoritesBytes);
  const instructionsPath = join(preservedHome, 'profiles', 'focused', 'AGENTS.md');
  privateDirectoryModule.admitWindowsPrivateFile(backend, instructionsPath);
  markStep('edit-instructions');
  await writeFile(instructionsPath, editedBytes, { flag: 'r+' });
  const preservedFiles = [[activePath, activeBytes], [favoritesPath, favoritesBytes], [instructionsPath, editedBytes]];
  markStep('beforeCurrent');
  const beforeCurrent = await Promise.all(preservedFiles.map(async ([path, bytes], index) => {
    try { return await privateFileSnapshot(path, bytes); }
    catch (cause) {
      throw Object.assign(new Error('private fixture snapshot failed', { cause }), {
        snapshotRole: ['active-selection', 'favorites', 'instructions'][index]
      });
    }
  }));
  markStep('preservedCurrent');
  const preservedCurrent = await managementModule.addProfile(preservedHome, 'focused', provisioningOptions);
  markStep('afterCurrent');
  const afterCurrent = await Promise.all(preservedFiles.map(async ([path, bytes], index) => {
    try { return await privateFileSnapshot(path, bytes); }
    catch (cause) {
      throw Object.assign(new Error('private fixture snapshot failed', { cause }), {
        snapshotRole: ['active-selection', 'favorites', 'instructions'][index]
      });
    }
  }));
  markStep('preservedNew');
  const preservedNew = await managementModule.addProfile(preservedHome, 'new-profile', provisioningOptions);
  markStep('afterNew');
  const afterNew = await Promise.all(preservedFiles.map(async ([path, bytes], index) => {
    try { return await privateFileSnapshot(path, bytes); }
    catch (cause) {
      throw Object.assign(new Error('private fixture snapshot failed', { cause }), {
        snapshotRole: ['active-selection', 'favorites', 'instructions'][index]
      });
    }
  }));
  const preserved = beforeCurrent.map((before, index) => preservedCurrent.action === 'current' && preservedNew.action === 'added'
    && samePrivateFile(before, afterCurrent[index]) && samePrivateFile(before, afterNew[index]));

  async function privateFileSnapshot(path, expectedBytes) {
    const before = privateDirectoryModule.admitWindowsPrivateFile(backend, path);
    // Exact fixture length is a derived read bound, not a new production cap.
    const receipt = await backend.readStableFile(path, expectedBytes.byteLength);
    const after = privateDirectoryModule.admitWindowsPrivateFile(backend, path);
    const identity = (object) => `${object.volumeIdentity}:${object.fileId}`;
    requireCondition(identity(before.object) === identity(receipt.before)
      && identity(receipt.before) === identity(receipt.after)
      && identity(receipt.after) === identity(after.object)
      && receipt.bytes.equals(expectedBytes), 'private fixture identity or bytes changed');
    return { identity: identity(after.object), bytes: Buffer.from(receipt.bytes) };
  }
  function samePrivateFile(before, after) {
    return before.identity === after.identity && before.bytes.equals(after.bytes);
  }

  diagnosticScenario = 'observations';
  markStep('start');
  markStep('project-observations');
  report.observations = {
    binarySha256,
    absentHomeReadOnly,
    privateBootstrap: ordinaryBoundary && bootstrapPrivate.kind === 'directory' && (bootstrapPrivate.security.descriptorControl & 0x1000) !== 0,
    missingIntermediateBootstrap: intermediatePrivate.kind === 'directory' && (intermediatePrivate.security.descriptorControl & 0x1000) !== 0,
    emptyInactiveProfileAdded: firstAdd.action === 'added' && emptyGenerated,
    profileAddIdempotent: repeatedAdd.action === 'current',
    profileAddAfterMembershipCurrent: afterMembershipAdd.action === 'current' && directTargets,
    profilesListedLexically: JSON.stringify(listedProfiles.profileIds) === JSON.stringify(['alpha', 'focused'])
      && listedProfiles.diagnostics.length === 0,
    inactiveProfileIsolation: isolated.instructions === '' && isolated.skillDirectories.length === 0,
    selectionAndFavoritesAbsent: await expectCode(() => backend.inspectPath(join(home, 'active-profile')), 'WINDOWS_NATIVE_PATH_NOT_FOUND')
      && await expectCode(() => backend.inspectPath(join(home, 'profile-favorites.json')), 'WINDOWS_NATIVE_PATH_NOT_FOUND'),
    bootstrapContentionSerialized: winnerResult.action === 'added',
    bootstrapContentionRetryCurrent: contentionRetry.action === 'current',
    ...crashObservations,
    readOnlyListingNoRecovery,
    ...refusalObservations,
    existingCrlfSelectionPreserved: preserved[0],
    existingFavoritesPreserved: preserved[1],
    editedProfileInstructionsPreserved: preserved[2],
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
  markStep('verify-observations');
  requireCondition(
    Object.entries(report.observations)
      .filter(([key]) => key !== 'binarySha256')
      .every(([, value]) => value === true),
    'one or more product observations failed'
  );
  report.completion = 'passed';
  cleanupAllowed = true;
} catch (error) {
  report.failures.push(sanitizeProductFailure(error, {
    scenario: diagnosticScenario, substep: diagnosticSubstep, publicationPhase: diagnosticPhase
  }));
} finally {
  for (const child of children) child.process.kill();
  await Promise.all([...children].map((child) => child.exited));
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
  catch (error) {
    if (error?.code === code) return true;
    throw error;
  }
  return false;
}
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function markStep(step) {
  diagnosticSubstep = step;
  diagnosticPhase = undefined;
}

function launchChild(home, phase = 'NONE') {
  const process = fork(fileURLToPath(new URL('./test-win32-profile-provisioning-child.mjs', import.meta.url)),
    [packageRoot, home, 'focused', phase], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const child = trackProvisioningChild(process);
  void child.exited.then(() => children.delete(child));
  children.add(child);
  return child;
}
async function runChild(home) {
  const child = launchChild(home);
  await child.next('ready');
  child.process.send('start');
  const result = await child.next('result');
  const exit = await child.exited;
  requireCondition(exit.code === 0 && exit.signal === null, 'product child did not exit successfully');
  requireCondition(result.action === 'added' || result.action === 'current', 'product retry refused');
  return result;
}
