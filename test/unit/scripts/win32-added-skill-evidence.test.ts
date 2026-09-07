import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';

const { trackProvisioningChild, sanitizeProductError, sanitizeProductFailure } = await import(pathToFileURL(
  join(process.cwd(), 'scripts', 'test-win32-profile-provisioning-child.mjs')
).href);

const { sameSelectionCandidateObject, selectionCandidateCommitted, selectionCandidateRetained,
  newSelectionCandidateName, observeActivationChildStop, observeActivationUse, observeActivationInterruption, code: expectActivationCode } = await import(pathToFileURL(
  join(process.cwd(), 'scripts', 'test-win32-profile-activation.mjs')
).href);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const { verifyProductReceipt, verifyProductPair } = await import(pathToFileURL(
  join(process.cwd(), 'scripts', 'verify-win32-added-skill-evidence.mjs')
).href);

describe('Windows added-Skill product evidence verifier', () => {
  it('exports main-safe exact single and pair validators with fixed root kinds', () => {
    const source = receipt('source-tree'), installed = receipt('packed-install');
    expect(verifyProductReceipt(source, 'source-tree', 'a'.repeat(64))).toBe(source);
    expect(verifyProductPair(source, installed, 'a'.repeat(64))).toEqual({ source, installed });
    expect(() => verifyProductReceipt(source, 'packed-install', 'a'.repeat(64))).toThrow();
    expect(() => verifyProductReceipt(source, 'custom', 'a'.repeat(64))).toThrow();
    expect(() => verifyProductPair(installed, source, 'a'.repeat(64))).toThrow();
    expect(() => verifyProductPair(source, installed, '')).toThrow();
  });
  it.each(['version', 'support', 'admission', 'gate', 'missing', 'false', 'path', 'SID', 'identity', 'content', 'digest', 'failure'])(
    'rejects incomplete or identifying receipts: %s', async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'bazframe-win-product-evidence-'));
      roots.push(root);
      const source = join(root, 'source.json');
      const installed = join(root, 'installed.json');
      const value = receipt('packed-install');
      const unsafe = value as unknown as Record<string, unknown>;
      if (mode === 'version') unsafe.schemaVersion = 1;
      else if (mode === 'support') unsafe.windowsSupportClaim = true;
      else if (mode === 'admission') unsafe.releaseAdmission = 'authorized';
      else if (mode === 'gate') unsafe.publicWindowsGate = 'open';
      else if (mode === 'failure') unsafe.failures = ['failure'];
      else if (mode === 'digest') value.observations.binarySha256 = 'b'.repeat(64);
      else if (mode === 'false') value.observations.bootstrapContentionSerialized = false;
      else if (mode === 'missing') delete (value.observations as Partial<typeof value.observations>).privateBootstrap;
      else (value.observations as unknown as Record<string, unknown>)[mode] = 'forbidden';
      await writeFile(source, JSON.stringify(receipt('source-tree')));
      await writeFile(installed, JSON.stringify(value));
      expect(run(source, installed).status).toBe(1);
    }
  );

  it.each([
    'occupiedDestinationRefusedUnchanged', 'candidateDriftAmbiguityRetained',
    'existingCrlfSelectionPreserved', 'existingFavoritesPreserved', 'editedProfileInstructionsPreserved',
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
  ] as const)('requires native observation %s to be present and true', async (name) => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-win-product-evidence-'));
    roots.push(root);
    const source = join(root, 'source.json');
    const installed = join(root, 'installed.json');
    await writeFile(source, JSON.stringify(receipt('source-tree')));
    const value = receipt('packed-install');
    value.observations[name] = false;
    await writeFile(installed, JSON.stringify(value));
    expect(run(source, installed).status).toBe(1);
    delete (value.observations as Partial<typeof value.observations>)[name];
    await writeFile(installed, JSON.stringify(value));
    expect(run(source, installed).status).toBe(1);
  });

  it('accepts exact equal closed receipts and rejects extra fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-win-product-evidence-'));
    roots.push(root);
    const source = join(root, 'source.json');
    const installed = join(root, 'installed.json');
    await writeFile(source, JSON.stringify(receipt('source-tree')));
    await writeFile(installed, JSON.stringify(receipt('packed-install')));
    expect(run(source, installed).status).toBe(0);
    expect(spawnSync(process.execPath, ['scripts/verify-win32-added-skill-evidence.mjs',
      '--binary-sha256', 'a'.repeat(64), '--installed', installed, '--source', source]).status).toBe(0);

    await writeFile(installed, JSON.stringify({ ...receipt('packed-install'), extra: true }));
    const rejected = run(source, installed);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr.trim()).toBe('Windows added-Skill evidence refused.');
  });
});

function run(source: string, installed: string) {
  return spawnSync(process.execPath, [
    'scripts/verify-win32-added-skill-evidence.mjs',
    '--source', source,
    '--installed', installed,
    '--binary-sha256', 'a'.repeat(64)
  ], { cwd: process.cwd(), encoding: 'utf8' });
}

function receipt(packageRootKind: 'source-tree' | 'packed-install') {
  return {
    schemaVersion: 3,
    purpose: 'Internal managed profile activation, current selection, onboarding and healthy local added-Skill Windows product-slice evidence only.',
    packageRootKind,
    completion: 'passed',
    releaseAdmission: 'not-authorized',
    windowsSupportClaim: false,
    publicWindowsGate: 'closed',
    observations: {
      binarySha256: 'a'.repeat(64),
      absentHomeReadOnly: true,
      privateBootstrap: true,
      missingIntermediateBootstrap: true,
      emptyInactiveProfileAdded: true,
      profileAddIdempotent: true,
      profileAddAfterMembershipCurrent: true,
      profilesListedLexically: true,
      inactiveProfileIsolation: true,
      selectionAndFavoritesAbsent: true,
      bootstrapContentionSerialized: true,
      bootstrapContentionRetryCurrent: true,
      freshPublicationPlannedRetry: true,
      freshPublicationCandidateReadyRetry: true,
      freshPublicationRenameIntentRetry: true,
      freshPublicationAfterRenameRetry: true,
      freshPublicationRenameProvenRetry: true,
      freshPublicationDependentStateRetry: true,
      freshPublicationCommittedRetry: true,
      readOnlyListingNoRecovery: true,
      occupiedDestinationRefusedUnchanged: true,
      candidateDriftAmbiguityRetained: true,
      existingCrlfSelectionPreserved: true,
      existingFavoritesPreserved: true,
      editedProfileInstructionsPreserved: true,
      healthyCatalogAdded: true,
      catalogIdempotent: true,
      healthyProfileAttached: true,
      profileIdempotent: true,
      catalogListedExactlyOnce: true,
      profileDiscoveredExactlyOnce: true,
      profileInstructionsStable: true,
      stableFileFinalInspectionProved: true,
      usableAndCanonicalTargetsBound: true,
      referenceIndexed: true,
      referencedCatalogRemovalRefused: true,
      catalogAndProfileDirectTargets: true,
      profileDetached: true,
      profileDetachIdempotent: true,
      catalogRemoved: true,
      catalogRemoveIdempotent: true,
      linkLeavesAbsent: true,
      sourcePreserved: true,
      nativeLockNamespacesPersist: true,
      publicWindowsGateClosed: true,
      currentMissingNoWrites: true,
      activeMissingSelectionRefused: true,
      selectionProtectedFirstVisibility: true,
      managedActivationAndCurrent: true,
      activationLockOrder: true,
      actualJunctionClosureAndProjection: true,
      repeatedSelectionReplacesIdentity: true,
      activeMalformedExplicitIndependent: true,
      activeTargetResolvedInsideStateLock: true,
      activeExplicitIsolation: true,
      activationPreservesProfiles: true,
      activationAndMembershipContention: true,
      killedActivationOwnerRetry: true,
      occupiedOtherProfileRefused: true,
      selectionExactNoEffect: true,
      selectionAfterEffectErrorCommitted: true,
      selectionMalformedRefused: true,
      selectionSharingNoEffect: true,
      selectionSubstitutionAmbiguous: true,
      selectionDriftBeforeEffect: true,
      profileDriftBeforeSelectionEffect: true,
      postcommitFailureReported: true,
      currentSelectedMissingReadOnly: true,
      interruptedBeforeReplacementRetained: true,
      interruptedAfterReplacementComplete: true,
      interruptedBeforeReturnComplete: true,
      currentPendingNoRecovery: true,
      interruptedActivationExplicitRetry: true
    },
    failures: []
  };
}


describe('Windows product child IPC settlement', () => {
  it.each(['early-exit', 'spawn-error'] as const)('settles an actual child %s before readiness', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-win-product-child-'));
    roots.push(root);
    const process = fork(join('scripts', 'test-win32-profile-provisioning-child.mjs'),
      [root, join(root, 'absent-home'), 'focused', 'NONE'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        ...(mode === 'spawn-error' ? { execPath: join(root, 'missing-node') } : {})
      });
    const child = trackProvisioningChild(process);
    try {
      await expect(child.next('ready')).rejects.toThrow('product child');
      const exit = await child.exited;
      expect(exit.code).not.toBe(0);
      await expect(child.next('result')).rejects.toThrow('product child');
    } finally {
      process.kill();
      await child.exited;
    }
  });

  it.each(['close', 'error'] as const)('settles all pending and future waits on early %s without a deadline', async (event) => {
    const process = new EventEmitter();
    const child = trackProvisioningChild(process);
    const pending = Promise.allSettled([child.next('ready'), child.next('paused')]);
    if (event === 'close') process.emit('close', 1, null);
    else process.emit('error', new Error('sensitive child failure must not escape'));
    const results = await pending;
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    await expect(child.next('result')).rejects.toThrow(event === 'close' ? 'product child closed' : 'product child failed');
    if (event === 'error') process.emit('close', 1, null);
    expect(await child.exited).toEqual({ code: 1, signal: null });
  });

  it('preserves already received results on successful close, then refuses future waits', async () => {
    const process = new EventEmitter();
    const child = trackProvisioningChild(process);
    process.emit('message', { event: 'result', action: 'added' });
    process.emit('close', 0, null);
    await expect(child.next('result')).resolves.toEqual({ event: 'result', action: 'added' });
    await expect(child.next('ready')).rejects.toThrow('product child closed');
    expect(await child.exited).toEqual({ code: 0, signal: null });
  });

  it.each(['close', 'error'] as const)('discards queued successes after child %s failure', async (event) => {
    const process = new EventEmitter();
    const child = trackProvisioningChild(process);
    process.emit('message', { event: 'result', action: 'added' });
    if (event === 'error') process.emit('error', new Error('sensitive failure'));
    else process.emit('close', 1, null);
    await expect(child.next('result')).rejects.toThrow('product child');
    if (event === 'error') process.emit('close', 1, null);
    await child.exited;
  });

  it('delivers pending messages in order and refuses unexpected event kinds', async () => {
    const process = new EventEmitter();
    const child = trackProvisioningChild(process);
    const ready = child.next('ready');
    const paused = child.next('paused');
    process.emit('message', { event: 'ready' });
    process.emit('message', { event: 'paused' });
    await expect(ready).resolves.toEqual({ event: 'ready' });
    await expect(paused).resolves.toEqual({ event: 'paused' });
    process.emit('message', { event: 'unexpected' });
    await expect(child.next('result')).rejects.toThrow('unexpected product child event');
    process.emit('close', 0, null);
    await child.exited;
  });
});


describe('Windows failed-product diagnostic privacy', () => {
  it('persists fixed failure context without synthesizing passing observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-win-product-diagnostic-'));
    roots.push(root);
    const output = join(root, 'failed.json');
    const result = spawnSync(process.execPath, [
      'scripts/test-win32-added-skill-lifecycle.mjs', '--package-root', root, '--output', output
    ], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    const receipt = JSON.parse(await readFile(output, 'utf8'));
    expect(receipt).toMatchObject({ schemaVersion: 3, completion: 'failed', observations: {}, windowsSupportClaim: false });
    expect(receipt.failures).toHaveLength(1);
    expect(receipt.failures[0]).toMatchObject({ scenario: 'startup', substep: process.platform === 'win32' ? 'nativeModule' : 'start' });
    expect(JSON.stringify(receipt)).not.toContain(root);
  });

  it('retains only fixed scenario, substep, closure reason, comparison, kind, and differing fields', () => {
    const cause = Object.assign(new Error('entry-vs-directory-open'), {
      code: 'WINDOWS_DIRECTORY_CLOSURE_COMPARISON', objectKind: 'directory',
      differingFields: ['allocationSize', 'size', 'C:\\secret', 'S-1-5-21-99', 'private-content', 'f'.repeat(32)],
      path: 'C:\\secret', ownerSid: 'S-1-5-21-99', identity: 'f'.repeat(32)
    });
    const error = Object.assign(new Error('Windows directory closure changed: listed child identity or metadata changed before it was consumed.', { cause }), {
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
    });
    const result = sanitizeProductFailure(error, {
      scenario: 'onboarding', substep: 'firstAdd', publicationPhase: 'PLANNED'
    });
    expect(result).toEqual({
      scenario: 'onboarding', substep: 'firstAdd', name: 'Error', message: 'sanitized product-slice failure',
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED',
      closureReason: 'listed-child-identity-or-metadata-changed-before-it-was-consumed',
      cause: {
        name: 'Error', message: 'sanitized product-slice failure', code: 'WINDOWS_DIRECTORY_CLOSURE_COMPARISON',
        comparison: 'entry-vs-directory-open', objectKind: 'directory', differingFields: ['size', 'allocationSize']
      },
      publicationPhase: 'PLANNED'
    });
    for (const secret of ['C:\\secret', 'S-1-5-21-99', 'private-content', 'f'.repeat(32)]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('refuses raw message/stack/code/context and injected comparison values', () => {
    const error = {
      name: 'sensitive-name', code: 'SECRET_CODE', message: 'sensitive path', stack: 'sensitive stack',
      closureReason: 'sensitive reason', publicationPhase: 'sensitive phase', snapshotRole: 'sensitive role',
      cause: {
        code: 'WINDOWS_DIRECTORY_CLOSURE_COMPARISON', message: 'sensitive message',
        comparison: 'sensitive comparison', objectKind: 'sensitive kind', differingFields: ['sensitive field']
      }
    };
    const result = sanitizeProductFailure(error, { scenario: 'sensitive scenario', substep: 'sensitive step', publicationPhase: 'sensitive phase' });
    expect(result).toEqual({
      scenario: 'unclassified', substep: 'unclassified', name: 'Error', message: 'sanitized product-slice failure',
      cause: { name: 'Error', message: 'sanitized product-slice failure', code: 'WINDOWS_DIRECTORY_CLOSURE_COMPARISON', differingFields: [] }
    });
    expect(JSON.stringify(result)).not.toMatch(/sensitive|SECRET_CODE/u);
  });

  it('allowlists every static closure refusal reason without copying arbitrary messages', async () => {
    const source = await readFile('src/state/win32-directory-closure.ts', 'utf8');
    const categories = {
      changed: ['WINDOWS_DIRECTORY_CLOSURE_CHANGED', 'Windows directory closure changed: '],
      invalid: ['WINDOWS_DIRECTORY_CLOSURE_INVALID', 'Invalid Windows directory closure: '],
      limit: ['WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED', 'Windows directory closure limit exceeded: ']
    } as const;
    for (const match of source.matchAll(/(?:throw |return )(changed|invalid|limit)\('([^']+)'/gu)) {
      const [code, prefix] = categories[match[1] as keyof typeof categories];
      expect(sanitizeProductError({ code, message: `${prefix}${match[2]}.` }).closureReason).toBeDefined();
    }
  });

  it('does not convert an arbitrary closure error message into an admitted reason', () => {
    expect(sanitizeProductError({ code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED', message: 'Windows directory closure changed: secret-path.' }))
      .toEqual({ name: 'Error', message: 'sanitized product-slice failure', code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED' });
  });

  it('settles child failures with malformed non-string messages without coercion', async () => {
    const process = new EventEmitter();
    const child = trackProvisioningChild(process);
    const waiting = child.next('paused').catch((error: unknown) => error);
    const failure = {
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED',
      message: { toString: null, valueOf: null }
    };
    expect(sanitizeProductError(failure)).toEqual({
      name: 'Error', message: 'sanitized product-slice failure', code: failure.code
    });
    expect(() => process.emit('message', { event: 'result', action: 'refused', failure })).not.toThrow();
    const settled = sanitizeProductError(await waiting);
    expect(settled.cause).toEqual(sanitizeProductError(failure));
    expect(sanitizeProductError(await child.next('result').catch((error: unknown) => error))).toEqual(settled);
    process.emit('close', 1, null);
    await child.exited;
  });

  it('carries and revalidates child closure failure causes through close and future waits', async () => {
    const process = new EventEmitter();
    const child = trackProvisioningChild(process);
    const waiting = child.next('paused').catch((error: unknown) => error);
    process.emit('message', { event: 'result', action: 'refused', failure: {
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED', closureReason: 'listed-child-identity-or-metadata-changed-before-it-was-consumed',
      publicationPhase: 'CANDIDATE_READY', path: 'must-not-escape',
      cause: {
        code: 'WINDOWS_DIRECTORY_CLOSURE_COMPARISON', comparison: 'entry-vs-directory-open',
        objectKind: 'directory', differingFields: ['size', 'must-not-escape']
      }
    } });
    process.emit('close', 1, null);
    const failure = sanitizeProductError(await waiting);
    expect(failure.cause).toMatchObject({
      code: 'WINDOWS_DIRECTORY_CLOSURE_CHANGED', publicationPhase: 'CANDIDATE_READY',
      closureReason: 'listed-child-identity-or-metadata-changed-before-it-was-consumed',
      cause: { comparison: 'entry-vs-directory-open', objectKind: 'directory', differingFields: ['size'] }
    });
    expect(JSON.stringify(failure)).not.toContain('must-not-escape');
    expect(sanitizeProductError(await child.next('result').catch((error: unknown) => error))).toEqual(failure);
    await child.exited;
  });
});


describe('independent activation candidate tuple evidence', () => {
  function snapshot() {
    const fixture = windowsProvisioningFixture();
    const path = 'C:\\boundary\\selection-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp';
    fixture.file(path, 'focused\n');
    return { bytes: Buffer.from('focused\n'), inspection: fixture.backend.inspectPath(path) };
  }

  it('binds first visibility to the written candidate while permitting its expected byte growth', () => {
    const written = snapshot();
    const empty = { ...written, bytes: Buffer.alloc(0), inspection: { ...written.inspection,
      object: { ...written.inspection.object, size: '0000000000000000', allocationSize: '0000000000000000' } } };
    expect(sameSelectionCandidateObject(empty, written)).toBe(true);
    const substituted = { ...written, inspection: { ...written.inspection, object: { ...written.inspection.object, fileId: 'f'.repeat(32) } } };
    expect(sameSelectionCandidateObject(empty, substituted)).toBe(false);
  });

  it('proves rename by immutable identity/security and exact bytes, not the changed pathname or change time', () => {
    const candidate = snapshot();
    const destination = { ...candidate, inspection: { ...candidate.inspection,
      canonicalPath: 'final-private-selection', object: { ...candidate.inspection.object, changeTime: '0000000000000002' } } };
    expect(selectionCandidateCommitted(candidate, destination, undefined)).toBe(true);
    expect(selectionCandidateRetained(candidate, candidate)).toBe(true);
    expect(selectionCandidateRetained(candidate, destination)).toBe(false);
  });

  it.each(['identity', 'volume', 'security', 'bytes', 'retained-temp', 'missing-candidate', 'missing-destination'] as const)(
    'rejects a falsely claimed commit with %s mismatch', (kind) => {
      const candidate = snapshot();
      const destination = snapshot();
      if (kind === 'identity') destination.inspection.object.fileId = 'f'.repeat(32);
      if (kind === 'volume') destination.inspection.object.volumeIdentity = 'f'.repeat(16);
      if (kind === 'security') destination.inspection.security.daclBytes = Buffer.from('different');
      if (kind === 'bytes') destination.bytes = Buffer.from('other\n');
      expect(selectionCandidateCommitted(kind === 'missing-candidate' ? undefined : candidate,
        kind === 'missing-destination' ? undefined : destination,
        kind === 'retained-temp' ? candidate : undefined)).toBe(false);
    }
  );

  it.each(['missing', 'identity', 'security', 'bytes', 'metadata'] as const)('rejects %s retained-candidate mismatch after sharing denial or interruption', (kind) => {
    const candidate = snapshot();
    const retained = snapshot();
    if (kind === 'identity') retained.inspection.object.fileId = 'f'.repeat(32);
    if (kind === 'security') retained.inspection.security.ownerSid = 'different';
    if (kind === 'bytes') retained.bytes = Buffer.from('other\n');
    if (kind === 'metadata') retained.inspection.object.changeTime = '0000000000000002';
    expect(selectionCandidateRetained(candidate, kind === 'missing' ? undefined : retained)).toBe(false);
  });

  it('never mistakes an orphan for the new candidate and refuses missing/ambiguous new names', () => {
    const old = `selection-${'a'.repeat(32)}.tmp`;
    const fresh = `selection-${'b'.repeat(32)}.tmp`;
    expect(newSelectionCandidateName([old], [old, fresh, 'active-profile'])).toBe(fresh);
    expect(() => newSelectionCandidateName([old], [old])).toThrow('activation evidence condition failed');
    expect(() => newSelectionCandidateName([], [old, fresh])).toThrow('activation evidence condition failed');
  });

  it.each(['BEFORE_REPLACEMENT', 'AFTER_REPLACEMENT', 'BEFORE_RETURN'])('observes candidate before permitting %s, with token-only IPC', async (stage) => {
    const sent: string[] = [];
    const process = Object.assign(new EventEmitter(), { send(token: string) {
      sent.push(token);
      process.emit('message', { event: 'paused', phase: stage });
    } });
    const child = trackProvisioningChild(process);
    const candidate = { path: 'private-path', snapshot: snapshot() };
    const result = observeActivationChildStop(child, stage, async () => {
      expect(sent).toEqual([]);
      return candidate;
    });
    process.emit('message', { event: 'paused', phase: 'BEFORE_REPLACEMENT' });
    expect(await result).toBe(candidate);
    expect(sent).toEqual(stage === 'BEFORE_REPLACEMENT' ? [] : ['continue']);
    process.emit('close', 0, null);
    await child.exited;
  });

  it('refuses an after-rename pause without the prior independent candidate observation', async () => {
    const process = Object.assign(new EventEmitter(), { send() { throw new Error('must not continue'); } });
    const child = trackProvisioningChild(process);
    const result = observeActivationChildStop(child, 'AFTER_REPLACEMENT', async () => { throw new Error('must not observe late'); });
    process.emit('message', { event: 'paused', phase: 'AFTER_REPLACEMENT' });
    await expect(result).rejects.toThrow('activation evidence condition failed');
    process.emit('close', 0, null);
    await child.exited;
  });

  it('settles a child that closes between candidate observation and the final pause, without a new timer', async () => {
    const process = Object.assign(new EventEmitter(), { send() { process.emit('close', 1, null); } });
    const child = trackProvisioningChild(process);
    const result = observeActivationChildStop(child, 'BEFORE_RETURN', async () => snapshot());
    process.emit('message', { event: 'paused', phase: 'BEFORE_REPLACEMENT' });
    await expect(result).rejects.toThrow('product child closed');
    await child.exited;
  });
});


describe('activation first-refusal diagnostics', () => {
  const physicalCode = 'WINDOWS_PROFILE_ACTIVATION_CHANGED';
  const committedCode = 'WINDOWS_PROFILE_ACTIVATION_COMMITTED_CHECK_FAILED';
  const failure = (code: string, cause?: unknown) => Object.assign(new Error('PRIVATE-DIAGNOSTIC-CONTENT', { cause }), { code });

  it('accepts the expected refusal and retains the existing false verdict for unexpected success', async () => {
    expect(await expectActivationCode(async () => { throw failure('NO_ACTIVE_PROFILE'); }, 'NO_ACTIVE_PROFILE')).toBe(true);
    expect(await expectActivationCode(async () => undefined, 'NO_ACTIVE_PROFILE')).toBe(false);
  });

  it.each(['WINDOWS_OPERATION_LOCK_ANNOUNCEMENT_AMBIGUOUS', 'WINDOWS_OPERATION_LOCK_RELEASE_AMBIGUOUS', 'WINDOWS_NATIVE_READ_CHANGED'])(
    'propagates the first unexpected %s with its original cause and prevents later steps', async (code) => {
      const original = failure(code, failure('WINDOWS_NATIVE_READ_CHANGED'));
      let proceeded = false;
      const operation = async () => {
        await expectActivationCode(async () => { throw original; }, 'WINDOWS_SELECTION_NO_EFFECT');
        proceeded = true;
      };
      await expect(operation()).rejects.toBe(original);
      expect(proceeded).toBe(false);
      const sanitized = sanitizeProductFailure(original, { scenario: 'activation', substep: 'selection-sharing' });
      expect(sanitized).toMatchObject({ scenario: 'activation', substep: 'selection-sharing', code,
        cause: { code: 'WINDOWS_NATIVE_READ_CHANGED' } });
      expect(JSON.stringify(sanitized)).not.toContain('PRIVATE-DIAGNOSTIC-CONTENT');
    }
  );

  it('requires the intended immediate physical-change cause for induced postcommit drift', async () => {
    const original = failure(committedCode, failure(physicalCode));
    expect(await expectActivationCode(async () => { throw original; }, committedCode, physicalCode)).toBe(true);
  });

  it.each(['missing-cause', 'lock-release', 'nested-physical', 'wrong-top'] as const)('does not accept postcommit %s as the expected physical drift', async (kind) => {
    const cause = kind === 'missing-cause' ? undefined
      : kind === 'nested-physical' ? failure('WINDOWS_OPERATION_LOCK_RELEASE_AMBIGUOUS', failure(physicalCode))
        : failure('WINDOWS_OPERATION_LOCK_RELEASE_AMBIGUOUS');
    const original = failure(kind === 'wrong-top' ? physicalCode : committedCode, cause);
    await expect(expectActivationCode(async () => { throw original; }, committedCode, physicalCode)).rejects.toBe(original);
    expect(JSON.stringify(sanitizeProductError(original))).not.toContain('PRIVATE-DIAGNOSTIC-CONTENT');
  });

  it.each([undefined, null, 'PRIVATE-NON-ERROR'])('does not swallow unexpected non-Error rejection %j', async (original) => {
    await expect(expectActivationCode(async () => { throw original; }, 'NO_ACTIVE_PROFILE')).rejects.toBe(original);
  });

  it('attributes the reset activation after selected-missing current to a separate fixed stage', async () => {
    const source = await readFile('scripts/test-win32-profile-activation.mjs', 'utf8');
    const start = source.indexOf('observations.currentSelectedMissingReadOnly =');
    const stage = source.indexOf("mark('selection-reset-after-missing')", start);
    expect(stage).toBeGreaterThan(start);
    expect(stage).toBeLessThan(source.indexOf("await use('alpha', undefined, scenarioHome)", start));
    expect(source).toContain("'WINDOWS_PROFILE_ACTIVATION_COMMITTED_CHECK_FAILED', 'WINDOWS_PROFILE_ACTIVATION_CHANGED')");
    expect(sanitizeProductFailure(failure('WINDOWS_OPERATION_LOCK_ANNOUNCEMENT_AMBIGUOUS'), {
      scenario: 'activation', substep: 'selection-reset-after-missing'
    })).toMatchObject({ scenario: 'activation', substep: 'selection-reset-after-missing', code: 'WINDOWS_OPERATION_LOCK_ANNOUNCEMENT_AMBIGUOUS' });
  });
});

describe('marked actual activation harness seams', () => {
  const stages = ['BEFORE_REPLACEMENT', 'AFTER_REPLACEMENT', 'BEFORE_RETURN'];
  const candidateName = `selection-${'a'.repeat(32)}.tmp`;
  const originalCause = new Error('PRIVATE-CAUSE');
  const sentinel = Object.assign(new Error('PRIVATE', { cause: originalCause }), { code: 'WINDOWS_NATIVE_READ_CHANGED' });
  function snapshots() {
    const fixture = windowsProvisioningFixture();
    const path = `C:\\boundary\\${candidateName}`;
    fixture.file(path, 'focused\n');
    const inspection = fixture.backend.inspectPath(path);
    return {
      written: { bytes: Buffer.from('focused\n'), digest: 'focused', inspection },
      empty: { bytes: Buffer.alloc(0), inspection },
      before: { bytes: Buffer.from('alpha\n'), digest: 'alpha', inspection }
    };
  }
  function recorder(failAt?: string) {
    let label = '';
    const marks: string[] = [], events: { event: string; label: string }[] = [];
    return { marks, events, mark(value: string) { label = value; marks.push(value); },
      step<T>(event: string, value: T): T {
        events.push({ event, label });
        if (event === failAt) throw sentinel;
        return value;
      } };
  }
  function useFixture(failAt?: string) {
    const trace = recorder(failAt), { written, empty } = snapshots();
    let enumerations = 0, reads = 0;
    const deps = {
      candidateNames() { return trace.step(++enumerations === 1 ? 'pre-enumerate' : 'created-enumerate', enumerations === 1 ? [] : [candidateName]); },
      readCandidate() { return ++reads === 1 ? trace.step('created-read', empty) : trace.step('written-read', written); },
      read() { return trace.step('destination-read', written); },
      optionalCandidate() { return trace.step('temporary-read', undefined); },
      async useManagedProfile(_name: string, options: { hooks: { afterPrivateCreation(): Promise<void>; beforeReplacement(): Promise<void> } }) {
        expect(Object.keys(options)).toEqual(['hooks']); // No harness diagnostic callback or onCandidate in lifecycle options.
        trace.step('product-start', undefined);
        await options.hooks.afterPrivateCreation();
        trace.step('product-after-created', undefined);
        await options.hooks.beforeReplacement();
        trace.step('product-after-written', undefined);
        return { active: true };
      }
    };
    const options = { onCandidate() { trace.step('on-candidate', undefined); }, hooks: { afterPrivateCreation() { trace.step('created-hook', undefined); },
      beforeReplacement() { trace.step('written-hook', undefined); } } };
    return { ...trace, run: (scope = '') => observeActivationUse(deps, 'focused', options, 'private-root',
      (operation: string) => trace.mark(`${scope}${operation}`)) };
  }
  const useSeams = [
    ['pre-enumerate', 'temps-enumerate'], ['product-start', 'lifecycle'],
    ['created-enumerate', 'created-candidate-enumerate'], ['created-read', 'created-candidate-read'],
    ['created-hook', 'created-hook'], ['product-after-created', 'lifecycle'], ['written-read', 'written-read'],
    ['on-candidate', 'written-hook'], ['written-hook', 'written-hook'], ['product-after-written', 'lifecycle'],
    ['destination-read', 'destination-read'], ['temporary-read', 'temporary-read']
  ];
  it.each(useSeams)('retains the same %s rejection/cause, correct mark and no later operation', async (event, label) => {
    const successful = useFixture();
    await successful.run();
    for (const scope of ['reset-use-', 'explicit-use-']) {
      const failed = useFixture(event);
      await expect(failed.run(scope)).rejects.toBe(sentinel);
      expect(sentinel.cause).toBe(originalCause);
      expect(failed.marks.at(-1)).toBe(`${scope}${label}`);
      expect(failed.events.map((value) => value.event)).toEqual(successful.events.map((value) => value.event).slice(0,
        successful.events.findIndex((value) => value.event === event) + 1));
    }
  });
  it('restores lifecycle only after successful hooks and keeps both post-return reads', async () => {
    const fixture = useFixture();
    await expect(fixture.run()).resolves.toEqual({ active: true });
    expect(fixture.events.filter(({ event }) => event.startsWith('product-')).map(({ label }) => label)).toEqual(['lifecycle', 'lifecycle', 'lifecycle']);
    expect(fixture.marks.slice(-4)).toEqual(['returned-check', 'destination-read', 'temporary-read', 'commit-check']);
    expect(fixture.events.map(({ event }) => event)).toEqual([
      'pre-enumerate', 'product-start', 'created-enumerate', 'created-read', 'created-hook', 'product-after-created',
      'written-read', 'on-candidate', 'written-hook', 'product-after-written', 'destination-read', 'temporary-read'
    ]);
  });
  function interruptionFixture(stage: string, failAt?: string, selectedOverride?: string, changedSelection = false) {
    const trace = recorder(failAt), { written, before } = snapshots();
    let enumerations = 0, reads = 0, closures = 0, pauses = 0;
    const deps = {
      use(name: string) { return trace.step(name === 'alpha' ? 'reset-use' : 'explicit-use', { active: true }); },
      read() { return trace.step(++reads === 1 ? 'before-read' : 'selection-read', reads === 1 || (stage === 'BEFORE_REPLACEMENT' && !changedSelection) ? before : written); },
      candidateNames() { return trace.step(++enumerations === 1 ? 'temps-enumerate' : 'candidate-enumerate', enumerations === 1 ? [] : [candidateName]); },
      readCandidate() { return trace.step('candidate-read', written); },
      optionalCandidate() { return trace.step('candidate-retained-read', stage === 'BEFORE_REPLACEMENT' ? written : undefined); },
      captureClosure() { return trace.step(++closures === 1 ? 'pending-closure' : 'after-closure', { closureSha256: 'same', rootIdentity: 'same' }); },
      current() { return trace.step('current-read', selectedOverride ?? (stage === 'BEFORE_REPLACEMENT' ? 'alpha' : 'focused')); },
      launch() {
        trace.step('child-launch', undefined);
        return { next(event: string) { return trace.step(event === 'ready' ? 'child-ready' : ++pauses === 1 ? 'child-before-pause' : 'child-final-pause',
          { phase: pauses === 1 ? 'BEFORE_REPLACEMENT' : stage }); },
        process: { send(token: string) { trace.step(`child-${token}`, undefined); }, kill() { trace.step('child-kill', undefined); } },
        get exited() { return trace.step('child-exit', Promise.resolve()); } };
      }
    };
    return { ...trace, deps, run: (prior = true) => observeActivationInterruption(deps, stage, 'private-root', trace.mark, prior) };
  }
  it.each(stages)('attributes every actual interruption read/closure/use/child seam at %s', async (stage) => {
    const successful = interruptionFixture(stage);
    await expect(successful.run()).resolves.toEqual({ noRecovery: true, complete: true });
    expect(successful.events.map(({ event }) => event)).toEqual([
      'reset-use', 'before-read', 'temps-enumerate', 'child-launch', 'child-ready', 'child-start', 'child-before-pause',
      'candidate-enumerate', 'candidate-read', ...(stage === 'BEFORE_REPLACEMENT' ? [] : ['child-continue', 'child-final-pause']),
      'child-kill', 'child-exit', 'pending-closure', 'current-read', 'after-closure', 'selection-read', 'candidate-retained-read', 'explicit-use'
    ]);
    for (const [index, { event, label }] of successful.events.entries()) {
      const failed = interruptionFixture(stage, event);
      await expect(failed.run()).rejects.toBe(sentinel);
      expect(failed.marks.at(-1)).toBe(label);
      expect(failed.events).toEqual(successful.events.slice(0, index + 1));
      const sanitized = sanitizeProductFailure(sentinel, { scenario: 'activation', substep: `activation-${stage}-${label}` });
      expect(sanitized.substep).toBe(`activation-${stage}-${label}`);
      expect(sanitized.cause).toEqual({ name: 'Error', message: 'sanitized product-slice failure' });
    }
    expect(successful.events.filter(({ event }) => event === 'child-continue')).toHaveLength(stage === 'BEFORE_REPLACEMENT' ? 0 : 1);
  });
  it.each(stages)('keeps selection short-circuit reads and marks suppressed at %s', async (stage) => {
    const fixture = interruptionFixture(stage, undefined, 'other');
    await expect(fixture.run()).resolves.toEqual({ noRecovery: true, complete: false });
    expect(fixture.marks).not.toContain('selection-read');
    expect(fixture.marks).not.toContain('candidate-retained-read');
    expect(fixture.marks.at(-1)).toBe('explicit-use');
  });
  it('does not read retained candidate after a changed prior selection or compare closures after an earlier false verdict', async () => {
    const fixture = interruptionFixture('BEFORE_REPLACEMENT', undefined, undefined, true);
    fixture.deps.captureClosure = () => ({ get closureSha256(): string { throw new Error('suppressed'); }, rootIdentity: 'same' });
    await expect(fixture.run(false)).resolves.toEqual({ noRecovery: false, complete: false });
    expect(fixture.marks).toContain('selection-read');
    expect(fixture.marks).not.toContain('candidate-retained-read');
  });
  it.each(stages)('admits every fixed nested mark for %s but no identifying/dynamic labels', async (stage) => {
    const interruption = interruptionFixture(stage);
    await interruption.run();
    const use = useFixture();
    await use.run();
    const labels = [...interruption.marks, ...['reset-use', 'explicit-use'].flatMap((scope) => use.marks.map((operation) => `${scope}-${operation}`))];
    for (const label of labels) {
      const substep = `activation-${stage}-${label}`;
      expect(sanitizeProductFailure(sentinel, { scenario: 'activation', substep }).substep).toBe(substep);
    }
    for (const label of ['C:\\PRIVATE', `${stage}-private`, 'activation-OTHER-before-read']) {
      expect(sanitizeProductFailure(sentinel, { scenario: 'activation', substep: label }).substep).toBe('unclassified');
    }
  });
});

describe('native read-change receipt sanitization and IPC', () => {
  const diagnostic = { site: 'reopened-prefix', objectKind: 'directory', prefixRole: 'ancestor', differingFields: ['object.changeTime', 'canonicalPath'] };
  const error = (nativeReadChange: unknown = diagnostic) => ({ code: 'WINDOWS_NATIVE_READ_CHANGED', nativeReadChange,
    message: { toString() { throw new Error('must not coerce PRIVATE'); } }, path: 'PRIVATE', ownerSid: 'PRIVATE', stack: 'PRIVATE' });
  it('re-sanitizes the exact fixed diagnosis repeatedly without values or raw/private error fields', () => {
    let sanitized = sanitizeProductError(error());
    expect(sanitized.nativeReadChange).toEqual(diagnostic);
    expect(sanitized.nativeReadChange).not.toBe(diagnostic);
    for (let index = 0; index < 5; index++) {
      const next = sanitizeProductError(JSON.parse(JSON.stringify(sanitized)));
      expect(next).toEqual(sanitized);
      sanitized = next;
    }
    expect(JSON.stringify(sanitized)).not.toContain('PRIVATE');
  });
  it.each([
    null, 'PRIVATE', { ...diagnostic, extra: 'PRIVATE' }, { ...diagnostic, differingFields: ['object.changeTime', 'PRIVATE'] },
    { ...diagnostic, differingFields: ['object.changeTime', 'object.changeTime'] }, { ...diagnostic, differingFields: [] },
    { ...diagnostic, site: 'PRIVATE' }, { ...diagnostic, prefixRole: 'PRIVATE' }, { ...diagnostic, objectKind: 'PRIVATE' },
    { ...diagnostic, differingFields: [{ toString() { throw new Error('must not coerce'); } }] },
    { ...diagnostic, get site() { throw new Error('PRIVATE accessor'); } }
  ])('drops malformed/extra diagnostic fields without relaxing the original code', (nativeReadChange) => {
    expect(sanitizeProductError(error(nativeReadChange))).toEqual({ name: 'Error', message: 'sanitized product-slice failure', code: 'WINDOWS_NATIVE_READ_CHANGED' });
  });
  it.each(['iterator-private', 'iterator-throws', 'methods-valid', 'methods-invalid', 'changing-index', 'invalid-changing-index', 'sparse', 'duplicate', 'over-count', 'non-string'])(
    'sanitizes an owned, single-read field snapshot without caller array behavior: %s', (mode) => {
      const fields: unknown[] = mode === 'sparse' ? new Array(1) : mode === 'over-count' ? new Array(14)
        : mode === 'duplicate' ? ['object.changeTime', 'object.changeTime']
          : [mode === 'methods-invalid' ? 'PRIVATE' : mode === 'non-string' ? { toString() { throw new Error('PRIVATE coercion'); } } : 'object.changeTime'];
      let iteratorCalls = 0, indexReads = 0;
      Object.defineProperty(fields, Symbol.iterator, { value: function* () {
        iteratorCalls++;
        if (mode === 'iterator-throws') throw new Error('PRIVATE iterator');
        yield 'PRIVATE';
      } });
      Object.defineProperty(fields, 'some', { value: () => false, configurable: true });
      Object.defineProperty(fields, 'toJSON', { get() { throw new Error('PRIVATE serialization'); } });
      if (mode === 'methods-valid') for (const method of ['some', 'includes', 'map', 'filter', 'slice']) {
        Object.defineProperty(fields, method, { get() { throw new Error('PRIVATE method'); } });
      }
      if (['changing-index', 'invalid-changing-index', 'over-count'].includes(mode)) Object.defineProperty(fields, '0', { get() {
        indexReads++;
        return (indexReads === 1) === (mode !== 'invalid-changing-index') ? 'object.changeTime' : 'PRIVATE';
      } });
      const sanitized = sanitizeProductError(error({ ...diagnostic, differingFields: fields }));
      expect(sanitized.code).toBe('WINDOWS_NATIVE_READ_CHANGED');
      expect(iteratorCalls).toBe(0);
      expect(indexReads).toBe(mode.includes('changing-index') ? 1 : 0);
      if (['iterator-private', 'iterator-throws', 'methods-valid', 'changing-index'].includes(mode)) {
        expect(sanitized.nativeReadChange.differingFields).toEqual(['object.changeTime']);
        expect(sanitized.nativeReadChange.differingFields).not.toBe(fields);
      } else expect(sanitized).not.toHaveProperty('nativeReadChange');
      expect(JSON.stringify(sanitized)).not.toContain('PRIVATE');
      expect(sanitizeProductError(JSON.parse(JSON.stringify(sanitized)))).toEqual(sanitized);
    }
  );
  it('also ignores a private-yielding field iterator at the actual refusal IPC sanitizer', async () => {
    const fields = ['object.changeTime'];
    Object.defineProperty(fields, Symbol.iterator, { value: function* () { yield 'PRIVATE'; } });
    const process = new EventEmitter();
    const child = trackProvisioningChild(process);
    const waiting = child.next('paused').catch((error: unknown) => error);
    process.emit('message', { event: 'result', action: 'refused', failure: error({ ...diagnostic, differingFields: fields }) });
    const first = await waiting;
    process.emit('close', 1, null);
    const sanitized = sanitizeProductError(first);
    expect(sanitized.cause.nativeReadChange.differingFields).toEqual(['object.changeTime']);
    expect(JSON.stringify(sanitized)).not.toContain('PRIVATE');
    expect(sanitizeProductError(sanitized)).toEqual(sanitized);
    expect(await child.next('paused').catch((error: unknown) => error)).toBe(first);
    await child.exited;
  });
  it('never trusts a diagnosis attached to another refusal code', () => {
    expect(sanitizeProductError({ ...error(), code: 'WINDOWS_NATIVE_IO_FAILED' })).not.toHaveProperty('nativeReadChange');
  });
  it('retains the first uncoded tracker error / native coded cause through refusal, close and future waits', async () => {
    const process = Object.assign(new EventEmitter(), { send() {} });
    const child = trackProvisioningChild(process);
    const waiting = child.next('paused').catch((error: unknown) => error);
    process.emit('message', { event: 'result', action: 'refused', failure: sanitizeProductError(error()) });
    const first = await waiting;
    process.emit('message', { event: 'result', action: 'refused', failure: { code: 'WINDOWS_NATIVE_IO_FAILED' } });
    process.emit('close', 1, null);
    expect(await child.next('paused').catch((error: unknown) => error)).toBe(first);
    expect(first).not.toHaveProperty('code');
    expect(sanitizeProductError(first)).toMatchObject({ cause: { code: 'WINDOWS_NATIVE_READ_CHANGED', nativeReadChange: diagnostic } });
    expect(JSON.stringify(sanitizeProductError(first))).not.toContain('PRIVATE');
    await child.exited;
  });
});
