import assert from 'node:assert/strict';
import test from 'node:test';
import { runRealPiProbe } from './run-real-pi.mjs';

test('real Pi 0.82 projects only individually validated effective skills without mutation', async () => {
  const evidence = await runRealPiProbe();
  assert.match(evidence.piVersion, /^0\.82\./u);
  assert.equal(evidence.mechanicsResult, 'passed');
  assert.equal(evidence.mechanicsScope, 'pi-0.82-runtime-projection');
  assert.deepEqual(
    evidence.projection.effectiveSkills.map(({ declaredName }) => declaredName),
    ['alpha', 'beta']
  );
  assert.equal(evidence.projection.discoveries.length, 2);
  assert.equal(evidence.projection.discoveries.every(({ compatible }) => compatible), true);
  assert.deepEqual(evidence.invalidMetadata.discovery.skillPaths, []);
  assert.deepEqual(evidence.claims, {
    groupingMembershipResolvedOnce: true,
    individualPiLoaderValidation: true,
    positiveProjectionNoLoaderDiagnostics: true,
    individualDefinitionPathsOnly: true,
    groupingRootNeverRequested: true,
    unrelatedGitWorkingDirectories: 2,
    originalBasesPreserved: true,
    sharedReferenceCanonicalTargetPreserved: true,
    compatibilityFailureReturnsNoSkillPaths: true,
    providerAndDestinationsUnchanged: true,
    destinationGitStatusUnchanged: true,
    isolatedWritableRoot: true
  });
});
