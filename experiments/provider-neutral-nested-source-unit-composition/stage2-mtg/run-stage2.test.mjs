import assert from 'node:assert/strict';
import test from 'node:test';
import { runStage2Proof } from './run-stage2.mjs';

test('sanitized MTG source unit runs both children from both callers without mutation', async () => {
  const evidence = await runStage2Proof();
  assert.equal(evidence.result, 'passed');
  assert.equal(evidence.scope, 'source-tree-runtime-mechanics-not-bazframe-managed-gateway-or-lifecycle');
  assert.deepEqual(evidence.effectiveSkills.map(({ declaredName }) => declaredName), [
    'card-search',
    'deck-analysis'
  ]);
  assert.equal(evidence.sourceCommands.length, 4);
  assert.equal(new Set(evidence.sourceCommands.map(({ startCwd }) => startCwd)).size, 2);
  assert.equal(evidence.sourceCommands.every(({ startCwd, executionCwd }) => startCwd !== executionCwd), true);
  assert.equal(evidence.sourceCommands.every(({ payload }) => payload.references.length === 2), true);

  const searchPayload = evidence.sourceCommands.find(({ childName }) => childName === 'card-search').payload;
  assert.deepEqual(searchPayload.results.map(({ name }) => name), ['Harmonize']);
  assert.deepEqual(searchPayload.references, [
    {
      path: 'shared/references/card-evaluation-framework.md',
      sha256: 'a9d5e35e9dad86a2ed3761ae8f4dba3673fd551a933f90a2b1aa950ed97bef0a'
    },
    {
      path: 'shared/references/synergy-support-math.md',
      sha256: '1feb5d2749aab85225bfe58f6c86de624262ce9e1ce4f5144459383f5106ede7'
    }
  ]);

  const analysisPayload = evidence.sourceCommands.find(({ childName }) => childName === 'deck-analysis').payload;
  assert.equal(analysisPayload.deck, 'Synthetic Shared-Module Proof');
  assert.equal(analysisPayload.totalCards, 5);
  assert.deepEqual(analysisPayload.missingCards, []);
  assert.deepEqual(evidence.claims, {
    twoIndependentChildren: true,
    bothChildrenRunFromBothUnrelatedGitCallers: true,
    childRootCwdUsed: true,
    sharedPureModulesConsumed: true,
    exactApprovedReferencesConsumed: true,
    syntheticImmutableInputsConsumed: true,
    ancestorLockedTsxConsumed: true,
    preparationCompletedBeforeMutationWindow: true,
    measurementOfflineAndNoInstall: true,
    exactChildDefinitionsAndOriginalBasesProjected: true,
    groupingRootNeverScannedByPi: true,
    providerAndCallersUnchanged: true,
    bazframeProductBehaviorUsedForAcquireInstallExecute: false,
    managedGatewayOrLifecycleProved: false
  });
});
