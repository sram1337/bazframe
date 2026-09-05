import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const { trackProvisioningChild } = await import(pathToFileURL(
  join(process.cwd(), 'scripts', 'test-win32-profile-provisioning-child.mjs')
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
    'existingCrlfSelectionPreserved', 'existingFavoritesPreserved', 'editedProfileInstructionsPreserved'
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
    schemaVersion: 2,
    purpose: 'Internal inactive-profile onboarding and healthy local added-Skill Windows product-slice evidence only.',
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
      publicWindowsGateClosed: true
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
