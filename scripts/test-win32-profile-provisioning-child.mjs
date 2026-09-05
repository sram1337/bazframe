import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Failure receipts admit only fixed codes/reasons/field names. They never copy
// raw messages, stacks, paths, observed values, or arbitrary IPC properties.
const FAILURE_CODES = new Set([
  'NO_ACTIVE_PROFILE', 'INVALID_PROFILE_ID', 'INVALID_ACTIVE_PROFILE_STATE',
  'WINDOWS_PROFILE_ACTIVATION_CHANGED', 'WINDOWS_PROFILE_ACTIVATION_UNSUPPORTED_STATE',
  'WINDOWS_PROFILE_ACTIVATION_COMMITTED_CHECK_FAILED',
  'WINDOWS_SELECTION_REFUSED', 'WINDOWS_SELECTION_BEFORE_EFFECT', 'WINDOWS_SELECTION_NO_EFFECT', 'WINDOWS_SELECTION_AMBIGUOUS',
  'ERR_MODULE_NOT_FOUND', 'WINDOWS_PROFILE_PROVISIONING_REFUSED',
  ...[
    'CHANGED', 'COMPARISON', 'INVALID', 'LIMIT_EXCEEDED',
    'POLICY_INVALID',
  ].map((suffix) => `WINDOWS_DIRECTORY_CLOSURE_${suffix}`),
  ...[
    'AMBIGUOUS', 'AUTHORITY_INVALID', 'CHANGED', 'DESTINATION_OCCUPIED',
    'JOURNAL_INVALID', 'JOURNAL_WRITE_AMBIGUOUS', 'LIMIT_EXCEEDED', 'OVERWRITE_REQUIRED',
    'RETRY_REQUIRED', 'STAGING_INVALID', 'STAGING_OCCUPIED', 'STORAGE_INVALID',
  ].map((suffix) => `WINDOWS_DIRECTORY_PUBLICATION_${suffix}`),
  ...[
    'ACCESS_DENIED', 'ARCH_UNSUPPORTED', 'ARTIFACT_INCOMPATIBLE', 'ARTIFACT_LOAD_FAILED',
    'ARTIFACT_MISSING', 'CONTRACT_MISMATCH', 'CREATE_AMBIGUOUS', 'DIRECTORY_CHANGED',
    'DIRECTORY_OCCUPIED', 'ENUMERATION_INCOMPLETE', 'ENUMERATION_LIMIT_EXCEEDED', 'ENUMERATION_LIMIT_INVALID',
    'EXPORT_MISSING', 'FILESYSTEM_UNSUPPORTED', 'IO_FAILED', 'LOCK_GUARD_CHANGED',
    'LOCK_GUARD_INVALID', 'LOCK_NOT_HELD', 'LOCK_RELEASE_FAILED', 'LOCK_STATE_INVALID',
    'MEMBERSHIP_CHANGED', 'MEMBERSHIP_LINK_INVALID', 'MEMBERSHIP_TARGET_INVALID', 'METADATA_UNAVAILABLE',
    'NOT_DIRECTORY', 'NOT_REGULAR_FILE', 'OPERATION_FAILED', 'PACKAGE_METADATA_INVALID',
    'PATH_INVALID', 'PATH_NOT_FOUND', 'PLATFORM_UNSUPPORTED', 'PROCESS_INSTANCE_AMBIGUOUS',
    'PROCESS_INSTANCE_INVALID', 'READ_CHANGED', 'READ_INCOMPLETE', 'READ_LIMIT_EXCEEDED',
    'READ_LIMIT_INVALID', 'RECEIPT_INVALID', 'REPARSE_REFUSED', 'SHARING_VIOLATION',
    'TARGET_MISMATCH', 'TARGET_UNSUPPORTED', 'VERSION_MISMATCH', 'VOLUME_NOT_FIXED',
    'VOLUME_REMOTE',
  ].map((suffix) => `WINDOWS_NATIVE_${suffix}`),
  ...[
    'ANNOUNCEMENT_AMBIGUOUS', 'AUTHORITY_INVALID', 'BUSY', 'BUSY_AMBIGUOUS',
    'INVALID', 'REENTRANT', 'RELEASE_AMBIGUOUS',
  ].map((suffix) => `WINDOWS_OPERATION_LOCK_${suffix}`),
  ...[
    'CREATE_AMBIGUOUS', 'NAME_INVALID', 'OCCUPIED', 'PATH_INVALID',
    'PRIVACY_UNPROVED',
  ].map((suffix) => `WINDOWS_PRIVATE_DIRECTORY_${suffix}`),
  ...[
    'CREATE_AMBIGUOUS', 'NAME_INVALID', 'OCCUPIED', 'PRIVACY_UNPROVED',
  ].map((suffix) => `WINDOWS_PRIVATE_FILE_${suffix}`),
]);
const CLOSURE_REASONS = new Map([
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory contents changed between closure passes.', 'directory-contents-changed-between-closure-passes'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory root or private ancestry changed while capturing its closure.', 'directory-root-or-private-ancestry-changed-while-capturing-its-closure'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: listed directory could not be admitted after enumeration.', 'listed-directory-could-not-be-admitted-after-enumeration'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: listed file could not be admitted after enumeration.', 'listed-file-could-not-be-admitted-after-enumeration'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory closure file could not be read with its listed state.', 'directory-closure-file-could-not-be-read-with-its-listed-state'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory closure file identity or size changed while reading.', 'directory-closure-file-identity-or-size-changed-while-reading'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory closure file privacy or identity changed while reading.', 'directory-closure-file-privacy-or-identity-changed-while-reading'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory closure file security changed while reading.', 'directory-closure-file-security-changed-while-reading'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory entries changed after their closure was read.', 'directory-entries-changed-after-their-closure-was-read'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory identity or metadata changed.', 'directory-identity-or-metadata-changed'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: listed child no longer resolves to the enumerated direct child.', 'listed-child-no-longer-resolves-to-the-enumerated-direct-child'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: listed child identity or metadata changed before it was consumed.', 'listed-child-identity-or-metadata-changed-before-it-was-consumed'],
  ['WINDOWS_DIRECTORY_CLOSURE_CHANGED|Windows directory closure changed: directory changed while enumerating.', 'directory-changed-while-enumerating'],
  ['WINDOWS_DIRECTORY_CLOSURE_INVALID|Invalid Windows directory closure: directory closure contains an invalid or reserved Windows component.', 'directory-closure-contains-an-invalid-or-reserved-Windows-component'],
  ['WINDOWS_DIRECTORY_CLOSURE_INVALID|Invalid Windows directory closure: directory closure contains a Windows or portable path collision.', 'directory-closure-contains-a-Windows-or-portable-path-collision'],
  ['WINDOWS_DIRECTORY_CLOSURE_INVALID|Invalid Windows directory closure: directory closure contains an unsupported reparse entry.', 'directory-closure-contains-an-unsupported-reparse-entry'],
  ['WINDOWS_DIRECTORY_CLOSURE_INVALID|Invalid Windows directory closure: directory closure contains an unsupported special or offline entry.', 'directory-closure-contains-an-unsupported-special-or-offline-entry'],
  ['WINDOWS_DIRECTORY_CLOSURE_INVALID|Invalid Windows directory closure: listed directory is not owner-private.', 'listed-directory-is-not-owner-private'],
  ['WINDOWS_DIRECTORY_CLOSURE_INVALID|Invalid Windows directory closure: listed file is not an owner-private single-link regular file.', 'listed-file-is-not-an-owner-private-single-link-regular-file'],
  ['WINDOWS_DIRECTORY_CLOSURE_INVALID|Invalid Windows directory closure: directory could not be enumerated with admissible stable evidence.', 'directory-could-not-be-enumerated-with-admissible-stable-evidence'],
  ['WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED|Windows directory closure limit exceeded: directory closure exceeds its depth limit.', 'directory-closure-exceeds-its-depth-limit'],
  ['WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED|Windows directory closure limit exceeded: directory closure exceeds its entry limit.', 'directory-closure-exceeds-its-entry-limit'],
  ['WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED|Windows directory closure limit exceeded: directory closure path exceeds its byte limit.', 'directory-closure-path-exceeds-its-byte-limit'],
  ['WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED|Windows directory closure limit exceeded: directory closure file exceeds its byte limit.', 'directory-closure-file-exceeds-its-byte-limit'],
  ['WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED|Windows directory closure limit exceeded: directory closure exceeds its aggregate byte limit.', 'directory-closure-exceeds-its-aggregate-byte-limit'],
  ['WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED|Windows directory closure limit exceeded: directory closure size is not representable.', 'directory-closure-size-is-not-representable'],
]);
const COMPARISONS = new Set([
  'initial-vs-final-root', 'expected-vs-enumeration-before', 'enumeration-before-vs-after',
  'entry-vs-directory-open', 'entry-vs-file-open', 'entry-vs-file-read-before',
  'entry-vs-file-read-after', 'entry-vs-file-final-open', 'initial-vs-final-enumeration'
]);
const ENTRY_FIELDS = ['fileId', 'size', 'allocationSize', 'creationTime', 'lastWriteTime', 'changeTime', 'attributes', 'reparseTag', 'directory'];
const DIRECTORY_FIELDS = [
  'canonicalPath', 'kind', 'volume.identity',
  ...['volumeIdentity', ...ENTRY_FIELDS, 'numberOfLinks', 'deletePending'].map((field) => `object.${field}`),
  ...['descriptorControl', 'daclPresent', 'daclNull', 'daclDefaulted', 'ownerSid', 'ownerDefaulted',
    'groupSid', 'groupDefaulted', 'currentUserSid', 'daclBytes'].map((field) => `security.${field}`)
];
const DIFFERING_FIELDS = [
  ...ENTRY_FIELDS, 'deletePending', ...DIRECTORY_FIELDS,
  ...DIRECTORY_FIELDS.map((field) => `directoryBefore.${field}`),
  ...DIRECTORY_FIELDS.map((field) => `directoryAfter.${field}`),
  ...['name', ...ENTRY_FIELDS, 'length', 'serialization'].map((field) => `entries.${field}`)
];

export function sanitizeProductError(error, depth = 0) {
  const result = { name: 'Error', message: 'sanitized product-slice failure' };
  if (error === null || typeof error !== 'object' || depth > 3) return result;
  if (FAILURE_CODES.has(error.code)) result.code = error.code;
  const reason = typeof error.message === 'string'
    ? CLOSURE_REASONS.get(`${result.code}|${error.message}`)
    : undefined;
  if (reason !== undefined) result.closureReason = reason;
  // The same sanitizer validates already-sanitized child IPC, rather than
  // trusting the child to provide safe diagnostic properties.
  else if ([...CLOSURE_REASONS].some(([key, value]) => key.startsWith(`${result.code}|`) && value === error.closureReason)) {
    result.closureReason = error.closureReason;
  }
  if (result.code === 'WINDOWS_DIRECTORY_CLOSURE_COMPARISON') {
    const comparison = COMPARISONS.has(error.message) ? error.message : error.comparison;
    if (COMPARISONS.has(comparison)) result.comparison = comparison;
    if (error.objectKind === 'directory' || error.objectKind === 'file') result.objectKind = error.objectKind;
    if (Array.isArray(error.differingFields)) result.differingFields = DIFFERING_FIELDS.filter((field) => error.differingFields.includes(field));
  }
  if (['active-selection', 'favorites', 'instructions'].includes(error.snapshotRole)) result.snapshotRole = error.snapshotRole;
  if (PUBLICATION_PHASES.has(error.publicationPhase)) result.publicationPhase = error.publicationPhase;
  if (error.cause !== undefined) result.cause = sanitizeProductError(error.cause, depth + 1);
  return result;
}

const SCENARIOS = new Set([
  'activation', 'startup', 'boundary', 'onboarding', 'external-skill', 'skill-lifecycle', 'public-gate',
  'contention', 'existing-state', 'observations', 'refusal-occupied', 'refusal-drift',
  ...['PLANNED', 'CANDIDATE_READY', 'CANDIDATE_RENAME_INTENT', 'AFTER_RENAME',
    'CANDIDATE_RENAME_PROVEN', 'DEPENDENT_STATE_PROVEN', 'COMMITTED'].map((phase) => `crash-${phase}`)
]);
const SUBSTEPS = new Set([
  'activation-outcome-onboarding', 'activation-deferred-refusal', 'selection-malformed',
  'selection-profile-drift', 'selection-postcommit', 'current-selected-missing',
  'activation-modules', 'current-missing', 'managed-activation', 'active-switch', 'activation-contention',
  'selection-outcomes', 'selection-sharing', 'selection-ambiguity', 'activation-interruption',
  'activation-BEFORE_REPLACEMENT', 'activation-AFTER_REPLACEMENT', 'activation-BEFORE_RETURN',
  'binary-digest', 'absent-home-check', 'invoke-cli', 'poison-home-check',
  'start', 'nativeModule', 'privateDirectoryModule', 'servicesModule',
  'catalogModule', 'membershipModule', 'indexModule', 'profileModule',
  'provisioningModule', 'managementModule', 'closureModule', 'publicationModule',
  'favoritesModule', 'backend', 'create-boundary', 'boundary-acl',
  'ordinaryBoundary', 'absentListing', 'firstAdd', 'generated',
  'repeatedAdd', 'add-alpha', 'listedProfiles', 'bootstrapPrivate',
  'intermediatePrivate', 'external', 'target', 'skillFile',
  'firstCatalog', 'repeatedCatalog', 'firstProfile', 'repeatedProfile',
  'afterMembershipAdd', 'isolated', 'catalog', 'loaded',
  'index', 'referenceRefused', 'catalogLink', 'profileLink',
  'targetInspection', 'firstDetach', 'repeatedDetach', 'firstRemove',
  'repeatedRemove', 'catalogAbsent', 'profileAbsent', 'sourcePreserved',
  'locksPersist', 'contenders-ready', 'contentionEvents', 'winnerResult',
  'contentionExits', 'contentionRetry', 'child-ready', 'stopped',
  'child-exited', 'beforeLive', 'beforeRead', 'readOnly',
  'afterRead', 'retried', 'live', 'transactions',
  'planned', 'candidateBeforePerturbation', 'create-occupant', 'occupant-before',
  'before', 'perturb-candidate', 'changed', 'candidateBefore',
  'journalBefore', 'refused', 'candidateAfter', 'journalAfter',
  'ambiguous', 'refusedAgain', 'terminal', 'terminalCandidate',
  'add-focused', 'add-spare', 'activePath', 'favoritesPath',
  'edit-instructions', 'beforeCurrent', 'preservedCurrent', 'afterCurrent',
  'preservedNew', 'afterNew', 'project-observations', 'verify-observations',
]);
const PUBLICATION_PHASES = new Set([
  'STATE_LOCK', 'AFTER_RENAME', 'PLANNED', 'CANDIDATE_READY', 'CANDIDATE_RENAME_INTENT',
  'CANDIDATE_RENAME_PROVEN', 'DEPENDENT_STATE_PROVEN', 'COMMITTED', 'ABORTED', 'AMBIGUOUS'
]);

export function sanitizeProductFailure(error, context) {
  const result = {
    scenario: SCENARIOS.has(context?.scenario) ? context.scenario : 'unclassified',
    substep: SUBSTEPS.has(context?.substep) ? context.substep : 'unclassified',
    ...sanitizeProductError(error)
  };
  if (PUBLICATION_PHASES.has(context?.publicationPhase)) result.publicationPhase = context.publicationPhase;
  return result;
}

/** Harness-only IPC tracking. Runtime is bounded by the governing outer job,
 * not an invented per-message deadline. Close/error settles every waiter.
 */
export function trackProvisioningChild(childProcess) {
  const queue = [];
  const waiters = [];
  let ended;
  const stop = (message, discardQueued = false, cause) => {
    ended ??= new Error(message, cause === undefined ? undefined : { cause });
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
    if (event?.event === 'result' && event.action === 'refused') {
      stop('product child refused', true, sanitizeProductError(event.failure));
      return;
    }
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
  try { await runProvisioningChild(); }
  catch (error) {
    process.send?.({ event: 'result', action: 'refused', failure: sanitizeProductError(error) });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
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
  let publicationPhase;
  const pause = async (phase) => {
    publicationPhase = phase;
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
    process.send({ event: 'result', action: busy ? 'busy' : 'refused',
      ...(busy ? {} : { failure: { ...sanitizeProductError(error), ...(PUBLICATION_PHASES.has(publicationPhase) ? { publicationPhase } : {}) } }) });
    if (!busy) process.exitCode = 1;
  } finally {
    process.disconnect();
  }
}
