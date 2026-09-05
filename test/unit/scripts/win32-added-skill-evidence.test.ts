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
  newSelectionCandidateName, observeActivationChildStop, code: expectActivationCode } = await import(pathToFileURL(
  join(process.cwd(), 'scripts', 'test-win32-profile-activation.mjs')
).href);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Windows added-Skill product evidence verifier', () => {
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

    await writeFile(installed, JSON.stringify({ ...receipt('packed-install'), extra: true }));
    const rejected = run(source, installed);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('unexpected schema');
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
