import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Windows added-Skill product evidence verifier', () => {
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
    schemaVersion: 1,
    purpose: 'Internal healthy local added-Skill Windows product-slice evidence only.',
    packageRootKind,
    completion: 'passed',
    releaseAdmission: 'not-authorized',
    windowsSupportClaim: false,
    publicWindowsGate: 'closed',
    observations: {
      binarySha256: 'a'.repeat(64),
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
