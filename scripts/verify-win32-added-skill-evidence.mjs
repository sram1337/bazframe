import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

export function verifyProductPair(source, installed, binarySha256) {
  verifyProductReceipt(source, 'source-tree', binarySha256);
  verifyProductReceipt(installed, 'packed-install', binarySha256);
  if (JSON.stringify(source.observations) !== JSON.stringify(installed.observations)) {
    throw new Error('Windows added-Skill source and packed observations differ.');
  }
  return { source, installed };
}

export function verifyProductReceipt(value, packageRootKind, binarySha256) {
  if (!/^[a-f0-9]{64}$/u.test(binarySha256) || !['source-tree', 'packed-install'].includes(packageRootKind)) {
    throw new Error('Invalid expected product binding.');
  }
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
  if (value.schemaVersion !== 5
    || value.purpose !== 'Limited Windows product-slice evidence: internal managed profile activation, current selection, onboarding, healthy local added-Skill lifecycle and public CLI smoke only.'
    || value.packageRootKind !== packageRootKind
    || value.completion !== 'passed'
    || value.releaseAdmission !== 'not-authorized'
    || value.windowsSupportClaim !== false
    || value.publicWindowsGate !== 'open'
    || !Array.isArray(value.failures)
    || value.failures.length !== 0) {
    throw new Error('Windows added-Skill evidence changed its exact limited product contract.');
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
    'publicEntrypointMappings',
    'publicFreshProfileLifecycle',
    'publicActiveForceRemoveRefusedUnchanged',
    'publicAbsentHomeReadOnly',
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
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const required = (name) => {
      const index = args.indexOf(name), value = index === -1 ? undefined : args[index + 1];
      if (value === undefined || value.length === 0) throw new Error();
      return value;
    };
    const sourcePath = required('--source'), installedPath = required('--installed');
    const binarySha256 = required('--binary-sha256');
    verifyProductPair(JSON.parse(await readFile(resolve(sourcePath), 'utf8')),
      JSON.parse(await readFile(resolve(installedPath), 'utf8')), binarySha256);
  } catch {
    console.error('Windows added-Skill evidence refused.');
    process.exitCode = 1;
  }
}
