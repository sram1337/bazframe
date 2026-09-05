import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const sourcePath = required('--source');
const installedPath = required('--installed');
const expectedBinarySha256 = required('--binary-sha256');
if (!/^[a-f0-9]{64}$/u.test(expectedBinarySha256)) throw new Error('Invalid expected binary digest.');
const source = await receipt(sourcePath, 'source-tree', expectedBinarySha256);
const installed = await receipt(installedPath, 'packed-install', expectedBinarySha256);
if (JSON.stringify(source.observations) !== JSON.stringify(installed.observations)) {
  throw new Error('Windows added-Skill source and packed observations differ.');
}

async function receipt(path, packageRootKind, binarySha256) {
  let value;
  try { value = JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch { throw new Error('Windows added-Skill evidence is not valid JSON.'); }
  exact(value, [
    'schemaVersion',
    'purpose',
    'packageRootKind',
    'completion',
    'releaseAdmission',
    'windowsSupportClaim',
    'publicWindowsGate',
    'observations',
    'failures'
  ]);
  if (value.schemaVersion !== 3
    || value.purpose !== 'Internal managed profile activation, current selection, onboarding and healthy local added-Skill Windows product-slice evidence only.'
    || value.packageRootKind !== packageRootKind
    || value.completion !== 'passed'
    || value.releaseAdmission !== 'not-authorized'
    || value.windowsSupportClaim !== false
    || value.publicWindowsGate !== 'closed'
    || !Array.isArray(value.failures)
    || value.failures.length !== 0) {
    throw new Error('Windows added-Skill evidence changed its exact closed contract.');
  }
  const names = [
    'binarySha256',
    'absentHomeReadOnly',
    'privateBootstrap',
    'missingIntermediateBootstrap',
    'emptyInactiveProfileAdded',
    'profileAddIdempotent',
    'profileAddAfterMembershipCurrent',
    'profilesListedLexically',
    'inactiveProfileIsolation',
    'selectionAndFavoritesAbsent',
    'bootstrapContentionSerialized',
    'bootstrapContentionRetryCurrent',
    'freshPublicationPlannedRetry',
    'freshPublicationCandidateReadyRetry',
    'freshPublicationRenameIntentRetry',
    'freshPublicationAfterRenameRetry',
    'freshPublicationRenameProvenRetry',
    'freshPublicationDependentStateRetry',
    'freshPublicationCommittedRetry',
    'readOnlyListingNoRecovery',
    'occupiedDestinationRefusedUnchanged',
    'candidateDriftAmbiguityRetained',
    'existingCrlfSelectionPreserved',
    'existingFavoritesPreserved',
    'editedProfileInstructionsPreserved',
    'healthyCatalogAdded',
    'catalogIdempotent',
    'healthyProfileAttached',
    'profileIdempotent',
    'catalogListedExactlyOnce',
    'profileDiscoveredExactlyOnce',
    'profileInstructionsStable',
    'stableFileFinalInspectionProved',
    'usableAndCanonicalTargetsBound',
    'referenceIndexed',
    'referencedCatalogRemovalRefused',
    'catalogAndProfileDirectTargets',
    'profileDetached',
    'profileDetachIdempotent',
    'catalogRemoved',
    'catalogRemoveIdempotent',
    'linkLeavesAbsent',
    'sourcePreserved',
    'nativeLockNamespacesPersist',
    'publicWindowsGateClosed',
    'currentMissingNoWrites',
    'activeMissingSelectionRefused',
    'selectionProtectedFirstVisibility',
    'managedActivationAndCurrent',
    'activationLockOrder',
    'actualJunctionClosureAndProjection',
    'repeatedSelectionReplacesIdentity',
    'activeMalformedExplicitIndependent',
    'activeTargetResolvedInsideStateLock',
    'activeExplicitIsolation',
    'activationPreservesProfiles',
    'activationAndMembershipContention',
    'killedActivationOwnerRetry',
    'occupiedOtherProfileRefused',
    'selectionExactNoEffect',
    'selectionAfterEffectErrorCommitted',
    'selectionMalformedRefused',
    'selectionSharingNoEffect',
    'selectionSubstitutionAmbiguous',
    'selectionDriftBeforeEffect',
    'profileDriftBeforeSelectionEffect',
    'postcommitFailureReported',
    'currentSelectedMissingReadOnly',
    'interruptedBeforeReplacementRetained',
    'interruptedAfterReplacementComplete',
    'interruptedBeforeReturnComplete',
    'currentPendingNoRecovery',
    'interruptedActivationExplicitRetry'
  ];
  exact(value.observations, names);
  if (value.observations.binarySha256 !== binarySha256
    || !names.slice(1).every((name) => value.observations[name] === true)) {
    throw new Error('Windows added-Skill evidence observations are incomplete.');
  }
  return value;
}

function exact(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) {
    throw new Error('Windows added-Skill evidence has an unexpected schema.');
  }
}
function required(name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}.`);
  return value;
}
