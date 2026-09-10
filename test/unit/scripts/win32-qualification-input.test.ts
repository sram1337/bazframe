import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZipFile } from 'yazl';
import { afterEach, describe, expect, it } from 'vitest';

const { sha256, qualificationInputName, verifyQualificationBinding, verifyQualificationMetadata, verifyQualificationArchive,
  verifyQualifiedFoundation, verifyRepackedTarball, stageQualifiedBinary, promoteQualificationInputs } = await import(pathToFileURL(resolve('scripts/win32-qualification-input.mjs')).href);
const { verifyWin32FoundationArchive } = await import(pathToFileURL(resolve('scripts/win32-native-release-admission.mjs')).href);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const commit = 'a'.repeat(40), version = '0.1.0-test.1', binary = Buffer.from('inert-qualified-native'), binarySha256 = sha256(binary);
const expected = { sourceCommit: commit, runId: '123', runAttempt: '2', repositoryId: '456', headRepositoryId: '456', headSha: commit };
const baseBinding = { artifact_id: '789', artifact_digest: 'b'.repeat(64), source_commit: commit, binary_sha256: binarySha256, tarball_sha256: 'c'.repeat(64), npm_version: '10.9.3' };
function metadata(binding = baseBinding, identity = expected, lane = 'foundation') {
  return { id: Number(binding.artifact_id), name: qualificationInputName(lane, identity), expired: false, digest: `sha256:${binding.artifact_digest}`,
    workflow_run: { id: Number(identity.runId), repository_id: Number(identity.repositoryId), head_repository_id: Number(identity.headRepositoryId), head_sha: identity.headSha } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bazframe-qualified-input-')); roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'bazframe', version }));
  const source = receipt('source-tree'), installed = receipt('packed-install');
  const rust = 'rustc 1.88.0 (test)\r\nhost: x86_64-pc-windows-msvc\r\n';
  const msvc = 'Path=C:\\VS\\VC\\Tools\\MSVC\\14.44.35207\\bin\\HostX64\\x64\\cl.exe\r\n';
  const aggregate = { schemaVersion: 6, purpose: 'Bazframe-owned native foundation evidence only; not release admission or a Windows support claim.',
    completion: 'passed', sourceCommit: commit, runnerImage: 'win22', runnerImageVersion: 'test-image', node: 'v22.19.0', rust,
    msvcToolsVersion: '14.44.35207', msvc, binarySha256, sourceConformance: source, installedConformance: installed,
    releaseAdmission: 'not-authorized', windowsSupportClaim: false };
  const foundation = new Map<string, Buffer>([
    ['artifacts/native/win32-x64-msvc/bazframe-win32.node', binary], ['native-binary.sha256', Buffer.from(`${binarySha256}\r\n`)],
    ['native-foundation-evidence.json', json(aggregate)], ['native-source-evidence.json', json(source)], ['native-installed-evidence.json', json(installed)],
    ['native-rust-version.txt', Buffer.from(rust)], ['native-msvc-version.txt', Buffer.from(msvc)]
  ]);
  const options = { repositoryRoot: root, releaseCommit: commit, packageVersion: version };
  const productSource = new Map([['source.json', json(productReceipt('source-tree'))]]), productInstalled = new Map([['installed.json', json(productReceipt('packed-install'))]]);
  return { root, foundation, options, source, installed, aggregate, productSource, productInstalled };
}
async function zip(entries: Map<string, Buffer>, extra?: 'duplicate' | 'link' | 'encrypted') {
  const writer = new ZipFile(), chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    writer.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk)); writer.outputStream.on('error', reject);
    writer.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, bytes] of entries) writer.addBuffer(bytes, name, { mode: extra === 'link' ? 0o120777 : 0o100644 });
  if (extra === 'duplicate') writer.addBuffer(entries.values().next().value!, entries.keys().next().value!);
  writer.end();
  const bytes = await done;
  if (extra === 'encrypted') {
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
  }
  return bytes;
}
function json(value: unknown) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }

describe('qualification-only transfer and promotion', () => {
  it.each(['push/tag', 'same-repository PR', 'fork PR'])('authenticates distinct trusted head and source identity for %s', async (event) => {
    const identity = { ...expected, headSha: event === 'push/tag' ? commit : 'd'.repeat(40), headRepositoryId: event === 'fork PR' ? '999' : expected.repositoryId };
    expect(() => verifyQualificationMetadata(metadata(baseBinding, identity), baseBinding, identity, 'foundation')).not.toThrow();
    const f = await fixture(), bytes = await zip(f.foundation), binding = { ...baseBinding, artifact_digest: sha256(bytes) };
    expect(await verifyQualificationArchive(bytes, metadata(binding, identity), binding, identity, 'foundation', f.options)).toEqual(f.foundation);
    for (const field of ['id', 'repository_id', 'head_repository_id', 'head_sha'] as const) {
      const wrong = metadata(baseBinding, identity);
      if (field === 'head_sha') wrong.workflow_run[field] = 'e'.repeat(40); else wrong.workflow_run[field] += 1;
      expect(() => verifyQualificationMetadata(wrong, baseBinding, identity, 'foundation')).toThrow('Windows qualification input refused.');
    }
  });
  it.each(['id', 'final-name', 'other-attempt', 'expired', 'digest', 'source', 'tarball', 'npm', 'missing'])('rejects substituted %s metadata/binding', (mode) => {
    const binding = { ...baseBinding }, meta = metadata();
    if (mode === 'id') meta.id++;
    if (mode === 'final-name') meta.name = `bazframe-win32-native-foundation-${commit}`;
    if (mode === 'other-attempt') meta.name = qualificationInputName('foundation', { ...expected, runAttempt: '1' });
    if (mode === 'expired') meta.expired = true;
    if (mode === 'digest') meta.digest = `sha256:${'f'.repeat(64)}`;
    if (mode === 'source') binding.source_commit = 'd'.repeat(40);
    if (mode === 'tarball') binding.tarball_sha256 = '';
    if (mode === 'npm') binding.npm_version = 'private';
    if (mode === 'missing') binding.artifact_id = '';
    expect(() => verifyQualificationMetadata(meta, binding, expected, 'foundation')).toThrow('Windows qualification input refused.');
  });

  it('read-only archive validation creates no binary/record and promotion preserves every original byte', async () => {
    const f = await fixture(), bytes = await zip(f.foundation), binding = { ...baseBinding, artifact_digest: sha256(bytes) };
    const archivePath = join(f.root, 'input.zip'); await writeFile(archivePath, bytes);
    const verified = await verifyWin32FoundationArchive({ ...f.options, archivePath, archiveDigest: binding.artifact_digest });
    expect(verified.binary).toEqual(binary);
    for (const name of ['artifacts', 'win32-native-release-admission.json']) await expect(readFile(join(f.root, name))).rejects.toThrow();
    const foundation = await verifyQualificationArchive(bytes, metadata(binding), binding, expected, 'foundation', f.options);
    const sourceBytes = await zip(f.productSource), installedBytes = await zip(f.productInstalled);
    const sourceBinding = { ...binding, artifact_id: '790', artifact_digest: sha256(sourceBytes) };
    const installedBinding = { ...binding, artifact_id: '791', artifact_digest: sha256(installedBytes) };
    const source = await verifyQualificationArchive(sourceBytes, metadata(sourceBinding, expected, 'product-source'), sourceBinding, expected, 'product-source', f.options);
    const installed = await verifyQualificationArchive(installedBytes, metadata(installedBinding, expected, 'product-installed'), installedBinding, expected, 'product-installed', f.options);
    const promoted = await promoteQualificationInputs({ foundation, source, installed, foundationBinding: binding, sourceBinding, installedBinding, expected, options: f.options });
    expect(promoted.foundation).toBe(foundation); expect([...promoted.product]).toEqual([...f.productSource, ...f.productInstalled]);
    expect(promoted.foundation).toEqual(f.foundation);
    await stageQualifiedBinary(f.root, binary, binarySha256);
    await expect(stageQualifiedBinary(f.root, Buffer.from('changed'), binarySha256)).rejects.toThrow();
    await expect(stageQualifiedBinary(f.root, binary, binarySha256)).rejects.toThrow();
    expect(await readFile(join(f.root, 'artifacts/native/win32-x64-msvc/bazframe-win32.node'))).toEqual(binary);
    await expect(readFile(join(f.root, 'win32-native-release-admission.json'))).rejects.toThrow();
    // Read-only validation is also harmless with occupied destinations.
    await verifyWin32FoundationArchive({ ...f.options, archivePath, archiveDigest: binding.artifact_digest });
    expect(await readFile(join(f.root, 'artifacts/native/win32-x64-msvc/bazframe-win32.node'))).toEqual(binary);
  });

  it.each(['binding-binary', 'bytes', 'binary', 'missing', 'extra', 'duplicate', 'link', 'encrypted', 'nested', 'kind', 'commit', 'pair', 'zero'])('refuses %s foundation input without leaking underlying details', async (mode) => {
    const f = await fixture();
    if (mode === 'binary') f.foundation.set('artifacts/native/win32-x64-msvc/bazframe-win32.node', Buffer.from('substituted'));
    if (mode === 'missing') f.foundation.delete('native-msvc-version.txt');
    if (mode === 'extra') f.foundation.set('PRIVATE-path-SID.txt', Buffer.from('private contents'));
    if (mode === 'nested') { f.aggregate.sourceConformance.completion = 'failed'; f.foundation.set('native-foundation-evidence.json', json(f.aggregate)); }
    if (mode === 'commit') { f.aggregate.sourceCommit = 'd'.repeat(40); f.foundation.set('native-foundation-evidence.json', json(f.aggregate)); }
    if (mode === 'kind') f.foundation.set('native-source-evidence.json', json(f.installed));
    if (mode === 'pair' || mode === 'zero') {
      f.installed.observations.stableByteCount = mode === 'zero' ? '0000000000000000' : '000000000000000e';
      f.foundation.set('native-installed-evidence.json', json(f.installed)); f.foundation.set('native-foundation-evidence.json', json(f.aggregate));
    }
    const bytes = await zip(f.foundation, ['duplicate', 'link', 'encrypted'].includes(mode) ? mode as 'duplicate' | 'link' | 'encrypted' : undefined);
    const binding = { ...baseBinding, artifact_digest: mode === 'bytes' ? '0'.repeat(64) : sha256(bytes) };
    if (mode === 'binding-binary') binding.binary_sha256 = 'd'.repeat(64);
    await expect(verifyQualificationArchive(bytes, metadata(binding), binding, expected, 'foundation', f.options)).rejects.toThrow(/^Windows qualification input refused\.$/u);
    await expect(readFile(join(f.root, 'win32-native-release-admission.json'))).rejects.toThrow();
  });

  it('requires every foundation boolean literally true before input transport', async () => {
    const f = await fixture();
    const names = Object.keys(f.source.observations).slice(3); expect(names).toHaveLength(62);
    for (const name of names) for (const value of [false, undefined, 'true']) {
      const changed = structuredClone(f.source);
      (changed.observations as Record<string, unknown>)[name] = value;
      const entries = new Map(f.foundation); entries.set('native-source-evidence.json', json(changed));
      await expect(verifyQualifiedFoundation(entries, f.options)).rejects.toThrow(/^Windows qualification input refused\.$/u);
    }
  });

  it('requires every product boolean and exact source/packed roots before promotion', async () => {
    const f = await fixture(), source = productReceipt('source-tree');
    const names = Object.keys(source.observations).slice(1); expect(names).toHaveLength(72);
    const promote = (receipt: unknown) => promoteQualificationInputs({ foundation: f.foundation, source: new Map([['source.json', json(receipt)]]),
      installed: f.productInstalled, foundationBinding: baseBinding, sourceBinding: baseBinding, installedBinding: baseBinding, expected, options: f.options });
    for (const name of names) for (const value of [false, undefined, 'true']) {
      const changed = structuredClone(source); (changed.observations as Record<string, unknown>)[name] = value;
      await expect(promote(changed)).rejects.toThrow(/^Windows qualification input refused\.$/u);
    }
    await expect(promote(productReceipt('packed-install'))).rejects.toThrow();
    await expect(promote({ ...source, schemaVersion: 2 })).rejects.toThrow();
    await expect(promote({ ...source, publicWindowsGate: 'open' })).rejects.toThrow();
    await expect(promote({ ...source, failures: ['private'] })).rejects.toThrow();
  });

  it('refuses staging into an assembly-admitted checkout without changing either destination', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'win32-native-release-admission.json'), 'occupied sentinel');
    await expect(stageQualifiedBinary(f.root, binary, binarySha256)).rejects.toThrow();
    expect(await readFile(join(f.root, 'win32-native-release-admission.json'), 'utf8')).toBe('occupied sentinel');
    await expect(readFile(join(f.root, 'artifacts/native/win32-x64-msvc/bazframe-win32.node'))).rejects.toThrow();
  });

  it.each(['source_commit', 'binary_sha256', 'tarball_sha256', 'npm_version'])('rejects product %s drift from trusted foundation outputs', (key) => {
    const binding = { ...baseBinding, [key]: key === 'npm_version' ? '10.0.0' : 'd'.repeat(key === 'source_commit' ? 40 : 64) };
    expect(() => verifyQualificationBinding(binding, expected, baseBinding)).toThrow();
  });

  it.each(['foundation', 'source', 'installed'])('refuses missing %s promotion inputs', async (missing) => {
    const f = await fixture();
    const input = { foundation: f.foundation, source: f.productSource, installed: f.productInstalled,
      foundationBinding: baseBinding, sourceBinding: baseBinding, installedBinding: baseBinding, expected, options: f.options, [missing]: undefined };
    await expect(promoteQualificationInputs(input)).rejects.toThrow(/^Windows qualification input refused\.$/u);
  });

  it.each(['valid', 'extra', 'missing'])('producer CLI checks the exact directory bundle before transfer: %s', async (mode) => {
    const f = await fixture(), temp = join(f.root, 'temp');
    const entries = new Map(f.foundation);
    if (mode === 'extra') entries.set('PRIVATE.txt', Buffer.from('private contents'));
    if (mode === 'missing') entries.delete('native-msvc-version.txt');
    for (const [name, bytes] of entries) {
      const path = join(temp, 'win32-qualification/foundation', name);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    }
    const result = spawnSync(process.execPath, [resolve('scripts/win32-qualification-input.mjs'), 'foundation'], {
      cwd: f.root, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: temp, GITHUB_SHA: commit }
    });
    expect(result.status).toBe(mode === 'valid' ? 0 : 1); expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(mode === 'valid' ? '' : 'Windows qualification input refused.');
    await expect(readFile(join(f.root, 'win32-native-release-admission.json'))).rejects.toThrow();
  });

  it('refuses malformed CLI input without paths or stacks', () => {
    const result = spawnSync(process.execPath, ['scripts/win32-qualification-input.mjs', 'PRIVATE-input'], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr.trim()).toBe('Windows qualification input refused.');
  });
});

describe('whole-tarball reconstruction', () => {
  it('builds independently in two temporary roots and compares real npm whole bytes, refusing drift before a product starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bazframe-repack-')); roots.push(root);
    // Include nonignored untracked inputs so independent builds reflect development work without staging.
    const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }); expect(files.status).toBe(0);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const run = (command: string, args: string[], cwd: string) => {
      const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, BAZFRAME_WIN32_NATIVE_PACK_MODE: 'foundation-evidence' } });
      expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
    };
    const npmVersion = run(npm, ['--version'], process.cwd()), tarballs: Buffer[] = [];
    for (const name of ['producer', 'consumer']) {
      const target = join(root, name); await mkdir(target);
      for (const file of files.stdout.split('\0').filter(Boolean)) {
        await mkdir(dirname(join(target, file)), { recursive: true }); await cp(file, join(target, file));
      }
      // Independent builds/dist, shared read-only locked compiler/dependency inputs on this host only.
      await symlink(resolve('node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await mkdir(join(target, 'artifacts/native/win32-x64-msvc'), { recursive: true });
      await writeFile(join(target, 'artifacts/native/win32-x64-msvc/bazframe-win32.node'), binary);
      run(process.execPath, ['scripts/build.mjs'], target);
      const pack = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--silent'], target));
      tarballs.push(await readFile(join(target, pack[0].filename)));
      await expect(readFile(join(target, 'win32-native-release-admission.json'))).rejects.toThrow();
    }
    const binding = { ...baseBinding, npm_version: npmVersion, tarball_sha256: sha256(tarballs[0]) };
    expect(() => verifyRepackedTarball(tarballs[1], binding, npmVersion)).not.toThrow();
    const consumer = join(root, 'consumer'); await writeFile(join(consumer, 'dist', 'unexpected-private.txt'), 'changed packaged bytes');
    const pack = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--silent'], consumer));
    let productStarted = false;
    expect(() => { verifyRepackedTarball(Buffer.from('different'), binding, npmVersion); productStarted = true; }).toThrow();
    expect(() => verifyRepackedTarball(tarballs[1], binding, '0.0.0')).toThrow();
    expect(() => verifyRepackedTarball(Buffer.from(''), { ...binding, tarball_sha256: '' }, npmVersion)).toThrow();
    const changedBytes = await readFile(join(consumer, pack[0].filename));
    expect(() => { verifyRepackedTarball(changedBytes, binding, npmVersion); productStarted = true; }).toThrow();
    expect(productStarted).toBe(false);
  }, 120_000);
});

function receipt(kind: 'source-tree' | 'packed-install') {
  return {
    schemaVersion: 6,
    purpose: 'Bazframe-owned native Windows foundation evidence only; not a Windows support claim.',
    environment: { platform: 'win32', arch: 'x64', node: '22.19.0' },
    packageRootKind: kind,
    completion: 'passed',
    releaseAdmission: 'not-authorized',
    windowsSupportClaim: false,
    observations: {
      binarySha256,
      packageVersion: version,
      stableByteCount: '000000000000000d',
      exactIdentityWidths: true,
      rootAndFileShareVolume: true,
      stableReadKeptIdentity: true,
      localFixedNtfs: true,
      uncAndDeviceNamespacesRefused: true,
      substitutedDriveRefused: true,
      finalReparseRefused: true,
      ancestorReparseRefused: true,
      boundedStableReads: true,
      junctionTargetPreserved: true,
      membershipJunctionDirectTarget: true,
      membershipJunctionNoReplace: true,
      membershipJunctionExactInspection: true,
      membershipJunctionImmediateRevalidation: true,
      membershipLinkSecurityAdmitted: true,
      membershipForeignReparseRefused: true,
      membershipLinkOnlyRemoval: true,
      membershipRemovalReconciled: true,
      privateDirectoryFirstVisibilityPrivate: true,
      privateDirectoryOwnerCurrentUser: true,
      privateDirectoryDaclPresentNonNullProtected: true,
      privateDirectoryTrustedFullControl: true,
      privateDirectoryNoReplace: true,
      privateDirectoryParentStable: true,
      privateDirectoryUnicodeName: true,
      privateDirectoryInvalidNameRefusedBeforeMutation: true,
      privateDirectoryReparseParentRefused: true,
      privateDirectoryDirectChildLocalNtfs: true,
      privateFileFirstVisibilityPrivate: true,
      privateFileNoReplace: true,
      stableDirectoryEnumerationEmptyAndBounded: true,
      stableDirectoryEnumerationDeterministic: true,
      stableDirectoryEnumerationMultiBufferComplete: true,
      stableDirectoryEnumerationKeptIdentity: true,
      directoryEnumerationIdentityReconciled: true,
      directoryReparseObservedAsLeaf: true,
      boundedDirectoryClosure: true,
      directoryClosureLimitsRefused: true,
      directoryClosureHardLinkRefused: true,
      directoryClosureForeignFileAclRefused: true,
      directoryClosureDriftRefused: true,
      directoryClosureReparseRefusedTargetPreserved: true,
      directoryPublicationFreshNoReplace: true,
      directoryPublicationMaterializerDrained: true,
      directoryPublicationMaterializerBounded: true,
      directoryPublicationReplacementBackupRetained: true,
      directoryPublicationAppendOnlyPrivateJournal: true,
      directoryPublicationRenameErrorPredicates: true,
      directoryPublicationOccupiedRacePreserved: true,
      directoryPublicationDependentDriftRetained: true,
      directoryPublicationCorruptJournalRefused: true,
      directoryPublicationRestartRecovery: true,
      operationLockPrivatePersistentNamespace: true,
      operationLockAuthorityExpires: true,
      operationLockAuthorizesPublication: true,
      operationLockContentionAnnounced: true,
      operationLockKilledOwnerRecovery: true,
      operationLockInterruptedAnnouncementRecovery: true,
      operationLockMalformedBusyRefused: true,
      operationLockWrongBindingRefused: true,
      operationLockPidReuseDistinguished: true,
      operationLockReleased: true
    },
    failures: []
  };
}

function productReceipt(packageRootKind: 'source-tree' | 'packed-install') {
  return {
    schemaVersion: 3,
    purpose: 'Internal managed profile activation, current selection, onboarding and healthy local added-Skill Windows product-slice evidence only.',
    packageRootKind,
    completion: 'passed',
    releaseAdmission: 'not-authorized',
    windowsSupportClaim: false,
    publicWindowsGate: 'closed',
    observations: {
      binarySha256,
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