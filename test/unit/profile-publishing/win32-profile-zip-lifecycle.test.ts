import { resolveProfileResourceMembershipSelection, mutateImportedProfileResourceMembership } from '../../../src/profile-publishing/profile-resource-membership.js';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { ensureWindowsPrivateDirectoryPath, admitWindowsPrivateDirectory } from '../../../src/state/win32-private-directory.js';
import { encodeProfileFavorites } from '../../../src/profiles/profile-favorites.js';
import { encodeWindowsExecutableMetadata, WINDOWS_EXECUTABLE_METADATA } from '../../../src/profile-publishing/win32-profile-executable.js';
import { encodeManagedProfileState } from '../../../src/profile-publishing/publication-state.js';
import { readWindowsTransactionJournal, scanWindowsTransactionJournals } from '../../../src/profile-publishing/win32-transaction-journal.js';
import { createWindowsProfileZipLifecycleDependencies, createWindowsImportedResourceMembershipDependencies } from '../../../src/profile-publishing/win32-profile-lifecycle.js';
import { createWindowsProfileActivationServicesForInternalTesting } from '../../../src/profile-publishing/win32-profile-activation.js';
import { createWindowsProfileStorage } from '../../../src/profile-publishing/win32-profile-storage.js';
import { createWindowsProfileDataReads } from '../../../src/profile-publishing/win32-profile-data-reads.js';
import { openWindowsProfileZipRangeSource } from '../../../src/profile-publishing/win32-profile-zip.js';
import { duplicateManagedProfile, useManagedProfile, renameManagedProfile, removeManagedProfile } from '../../../src/profile-publishing/profile-managed-lifecycle.js';
import { executeProfileCandidateSwap } from '../../../src/profile-publishing/profile-transaction.js';
import { materializeCapturedProfile, type CapturedBlobSource } from '../../../src/profile-publishing/profile-materialization.js';
import { recoverProfilePublishingTransactions } from '../../../src/profile-publishing/profile-recovery.js';
import { readProfileSystemView } from '../../../src/profile-publishing/profile-view.js';
import { exportManagedProfile, inspectProfileImport, importManagedProfile } from '../../../src/profile-publishing/profile-lifecycle.js';
import { createCanonicalProfileZip } from '../../../src/profile-publishing/profile-zip.js';
import { capturedProfileLimitPolicy } from '../../../src/profile-publishing/profile-publishing-policy.js';
import type { CandidatePhase } from '../../../src/profile-publishing/transaction-journal.js';
import type { CapturedProfileV1, CapturedResource } from '../../../src/profile-publishing/captured-profile.js';
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), readlink: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const HOME = 'C:\\boundary\\home';
const ZIP = 'C:\\boundary\\work.zip';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const definition = (name: string) => `---\nname: ${name}\ndescription: Ready.\n---\n`;
function bundle() {
  const blobs = new Map<string, CapturedBlobSource>();
  function file(path: string, contents: string | Buffer, executable = false) {
    const bytesValue = Buffer.from(contents); const sha256 = hash(bytesValue);
    blobs.set(sha256, { sha256, bytes: bytesValue.length, bytesValue });
    return { path, sha256, bytes: bytesValue.length, executable };
  }
  const resources: CapturedResource[] = [
    { id: '1'.repeat(64), key: { kind: 'skill', name: 'direct' }, payload: { kind: 'bundled', role: 'skill', files: [file('SKILL.md', definition('direct')), file('nested/data.bin', Buffer.from([0, 255, 42])), file('nested/run.sh', '#!/bin/sh\necho direct\n', true)] } },
    { id: '2'.repeat(64), key: { kind: 'skill', name: 'local' }, payload: { kind: 'bundled', role: 'skill', sourceForm: 'profile-local', files: [file('SKILL.md', definition('local')), file('deep/guide.md', 'local guide\n', true)] } },
    { id: '3'.repeat(64), key: { kind: 'library', name: 'library' }, payload: { kind: 'bundled', role: 'library', files: [file('nested/library-child/SKILL.md', definition('library-child')), file('nested/library-child/data.bin', Buffer.from([7, 0, 128]), true)] } },
    { id: '4'.repeat(64), key: { kind: 'package', name: 'package' }, payload: { kind: 'bundled', role: 'packageArtifacts', files: [file('out/package-child/SKILL.md', definition('package-child')), file('out/package-child/tool.txt', 'already built\n', true)] } }
  ];
  const instructions = file('AGENTS.md', '# Work\n', true);
  const profile: CapturedProfileV1 = { schemaVersion: 1, kind: 'bazframe-captured-profile', profile: { name: 'work', instructions }, resources, blobs: [...blobs.values()].map(({ sha256, bytes }) => ({ sha256, bytes })).sort((a, b) => a.sha256.localeCompare(b.sha256)) };
  return { profile, blobs: [...blobs.values()] };
}

async function fixture(homePresent = true) {
  const f = windowsProvisioningFixture();
  if (homePresent) for (const path of [HOME, `${HOME}\\profiles`, `${HOME}\\skills`, `${HOME}\\locks`]) ensureWindowsPrivateDirectoryPath(f.backend, path);
  const zipIo = {
    async *readInput(path: string, maximum: number) {
      const bytes = f.nodes.get(path)?.bytes; if (bytes === undefined) throw new Error('missing ZIP');
      if (bytes.length > maximum) throw new Error('copy bound');
      for (let offset = 0; offset < bytes.length; offset += 8192) yield bytes.subarray(offset, offset + 8192);
    },
    async writeExistingFile(path: string, chunks: AsyncIterable<Uint8Array>, maximum: number) {
      const parts: Buffer[] = []; let size = 0;
      for await (const chunk of chunks) { parts.push(Buffer.from(chunk)); size += chunk.length; if (size > maximum) throw new Error('copy bound'); }
      await f.io.writeExistingFile(path, Buffer.concat(parts));
    },
    rename: f.io.rename
  };
  const dependencies = createWindowsProfileZipLifecycleDependencies(f.backend, { storageIo: f.io, lockIo: f.io, stateIo: f.io, journal: { io: f.io }, zip: { io: zipIo, temporaryRoot: 'C:\\boundary' } });
  const source = bundle();
  f.file(ZIP, ''); f.nodes.get(ZIP)!.bytes = await createCanonicalProfileZip(source.profile, [...source.blobs].sort((a,b) => a.sha256.localeCompare(b.sha256)));
  const services = dependencies.services!;
  const activation = createWindowsProfileActivationServicesForInternalTesting(f.backend, { lockIo: f.io, selectionIo: f.io, journal: { io: f.io } });
  const importZip = (options: Partial<Parameters<typeof importManagedProfile>[0]> = {}) => importManagedProfile({ home: HOME, source: { kind: 'zip', path: ZIP }, ...options }, dependencies);
  return { ...f, dependencies, services, source, importZip, activation, zipIo };
}

describe('Windows shared candidate and real ZIP lifecycle (host native receipts only)', () => {
  it('runs resource export -> inspection -> absent-home fresh inactive import -> use/view -> byte-preserving re-export -> suffix -> active overwrite -> duplicate', async () => {
    const f = await fixture(false);
    const before = f.snapshot();
    const report = await inspectProfileImport(HOME, { kind: 'zip', path: ZIP }, f.dependencies);
    expect(report).toMatchObject({ collision: false, mutationPerformed: false });
    expect([...f.nodes.keys()].some((p) => p.startsWith(HOME))).toBe(false);
    expect(f.snapshot()).not.toBe(before); // Only private OS temporary input copy is allowed.
    const imported = await f.importZip(); expect(imported).toMatchObject({ action: 'imported', active: false, incomplete: false });
    expect(f.nodes.has(`${HOME}\\active-profile`)).toBe(false);
    expect((await useManagedProfile(HOME, 'work', f.activation)).active).toBe(true);
    const output = 'C:\\boundary\\export.zip';
    const exported = await exportManagedProfile({ home: HOME, outputPath: output }, f.dependencies);
    expect(exported.capturedProfile.resources).toHaveLength(4);
    expect(exported.capturedProfile.profile.instructions.executable).toBe(true);
    const secondHome = 'C:\\boundary\\destination';
    expect(await inspectProfileImport(secondHome, { kind: 'zip', path: output }, f.dependencies)).toMatchObject({ mutationPerformed: false, collision: false });
    expect(f.nodes.has(secondHome)).toBe(false);
    expect(await importManagedProfile({ home: secondHome, source: { kind: 'zip', path: output } }, f.dependencies)).toMatchObject({ active: false, incomplete: false });
    await useManagedProfile(secondHome, 'work', f.activation);
    const roundTrip = 'C:\\boundary\\roundtrip.zip';
    await exportManagedProfile({ home: secondHome, outputPath: roundTrip }, f.dependencies);
    expect(f.nodes.get(roundTrip)!.bytes).toEqual(f.nodes.get(output)!.bytes);
    const transported = await f.dependencies.readZip!(output);
    expect(transported.profile.resources.find((r) => r.key.name === 'local')?.payload).toMatchObject({ sourceForm: 'profile-local' });
    expect(transported.blobs.map((b) => [b.sha256, b.bytesValue])).toEqual([...f.source.blobs].sort((a,b) => a.sha256.localeCompare(b.sha256)).map((b) => [b.sha256, b.bytesValue]));
    await exportManagedProfile({ home: HOME, outputPath: 'C:\\boundary\\again.zip' }, f.dependencies);
    expect(f.nodes.get(output)!.bytes).toEqual(f.nodes.get('C:\\boundary\\again.zip')!.bytes);
    expect(await f.importZip({ yes: true })).toMatchObject({ profileName: 'work-1', active: false });
    const old = await f.services.readManagedState(HOME, 'work');
    expect(await f.importZip({ overwrite: true })).toMatchObject({ action: 'overwritten', profileName: 'work', active: true });
    const fresh = await f.services.readManagedState(HOME, 'work');
    expect(fresh!.state.profileInstanceId).not.toBe(old!.state.profileInstanceId);
    expect([...f.nodes.keys()].some((p) => /\\profiles\\\.bazframe-backup-/u.test(p))).toBe(true);
    f.file(`${HOME}\\profile-favorites.json`, encodeProfileFavorites(['work']));
    const storage = createWindowsProfileStorage(f.backend, f.io);
    expect(await duplicateManagedProfile(HOME, 'work', 'copy', {}, f.services, (authority) => storage.copyEffects(HOME, authority))).toMatchObject({ active: false, managed: true });
    const copy = await f.services.readManagedState(HOME, 'copy');
    expect(copy!.state.profileInstanceId).not.toBe(fresh!.state.profileInstanceId);
    expect(copy!.state.importedResources.map((r) => r.instanceId)).toEqual(fresh!.state.importedResources.map((r) => r.instanceId));
    expect(copy!.state.publication).toBeNull();
    expect((await f.services.readFavorites(HOME)).favorites).toEqual(['work']);
    await renameManagedProfile(HOME, 'copy', 'renamed', {}, f.services);
    expect(await removeManagedProfile(HOME, 'renamed', { expectedRemovalIdentity: await f.services.capture(HOME, 'renamed') }, f.services)).toMatchObject({ action: 'removed' });
    expect(copy!.state.capturedResourceIds.find((r) => r.identityKind === 'profileLocal')!.instanceId).not.toBe(fresh!.state.capturedResourceIds.find((r) => r.identityKind === 'profileLocal')!.instanceId);
    expect((await f.activation.readSystemView(HOME)).skills.map((s) => s.name)).toEqual(expect.arrayContaining(['direct', 'local', 'library-child', 'package-child']));
  });

  it.each(['PLANNED','MATERIALIZING','PACKAGES_LAST','CANDIDATE_READY','OLD_RENAME_INTENT','OLD_RENAME_PROVEN','CANDIDATE_RENAME_INTENT','CANDIDATE_RENAME_PROVEN','ACTIVE_SELECTION_PROVEN','COMMITTED'] as CandidatePhase[])('recovers actual rich overwrite interrupted at %s with retained private state', async (phase) => {
    const f = await fixture(); await f.importZip(); await useManagedProfile(HOME, 'work', f.activation);
    const expectedOld = await f.services.capture(HOME, 'work');
    await expect(executeProfileCandidateSwap({ home: HOME, profileName: 'work', operation: 'overwrite', services: f.services, expectedOld,
      materialize: (candidateDirectory, context) => materializeCapturedProfile({ home: HOME, candidateDirectory, authority: context.authority, captured: f.source.profile, blobs: f.source.blobs, allowIncomplete: false, effects: f.dependencies.materializationEffects!(HOME, context.authority), materializeRemote: async () => { throw new Error('no remote'); } }),
      hooks: { afterPhase(value) { if (value === phase) throw new Error('interrupted'); } }
    })).rejects.toThrow('interrupted');
    const results = await recoverProfilePublishingTransactions(HOME, undefined, f.services);
    expect(results.some((r) => r.action === 'ambiguous')).toBe(false);
    expect((await f.services.readSelection(HOME))?.profileId).toBe('work');
    expect((await f.activation.readSystemView(HOME)).profiles.find((p) => p.name === 'work')).toBeDefined();
  });

  it.each(['cloud-file', 'cloud-parent', 'foreign-parent'])('copies untrusted %s bytes privately without admitting source ownership or creating home', async (kind) => {
    const f = await fixture(false);
    const parent = 'C:\\boundary\\external'; f.directory(parent);
    const input = `${parent}\\source.zip`; f.file(input, ''); f.nodes.get(input)!.bytes = f.nodes.get(ZIP)!.bytes;
    if (kind === 'cloud-file') Object.assign(f.nodes.get(input)!, { attributes: 0x420, reparseTag: 0x9000001a });
    if (kind === 'cloud-parent') Object.assign(f.nodes.get(parent)!, { attributes: 0x410, reparseTag: 0x9000301a });
    if (kind === 'foreign-parent') f.nodes.get(parent)!.security = { ...f.backend.inspectPath(parent).security, ownerSid: 'S-1-5-21-999' };
    expect(() => admitWindowsPrivateDirectory(f.backend, kind === 'cloud-file' ? input : parent)).toThrow();
    const read = vi.spyOn(f.zipIo, 'readInput');
    expect(await inspectProfileImport(HOME, { kind: 'zip', path: input }, f.dependencies)).toMatchObject({ mutationPerformed: false });
    expect(read).toHaveBeenCalledWith(input, capturedProfileLimitPolicy().maxAggregateBytes);
    expect(f.nodes.has(HOME)).toBe(false);
    const staged = [...f.nodes.keys()].find((path) => /bazframe-zip-.*\\input.zip$/u.test(path));
    expect(staged).toBeDefined(); expect(f.nodes.get(staged!)!.bytes).toEqual(f.nodes.get(input)!.bytes);
    admitWindowsPrivateDirectory(f.backend, staged!.slice(0, staged!.lastIndexOf('\\')));
  });

  it('copies a classified unsupported/mapped-drive byte source without managed volume admission', async () => {
    const f = await fixture(false); f.directory('Z:\\'); const input = 'Z:\\input.zip'; f.file(input, ''); f.nodes.get(input)!.bytes = f.nodes.get(ZIP)!.bytes;
    const inspect = f.backend.inspectPath.bind(f.backend);
    vi.spyOn(f.backend, 'inspectPath').mockImplementation((path) => { if (path.startsWith('Z:')) throw Object.assign(new Error('mapped source is not managed storage'), { code: 'WINDOWS_NATIVE_VOLUME_REMOTE' }); return inspect(path); });
    expect(await inspectProfileImport(HOME, { kind: 'zip', path: input }, f.dependencies)).toMatchObject({ mutationPerformed: false });
    expect(f.nodes.has(HOME)).toBe(false);
  });

  it('refuses stale consent, cancellation, dangling fresh selection and candidate drift without replacing old content', async () => {
    const f = await fixture(); await f.importZip();
    const baseline = await f.services.capture(HOME, 'work');
    await expect(f.importZip({ chooseCollision: () => 'cancel' })).rejects.toThrow();
    expect((await f.services.capture(HOME, 'work'))!.identity).toBe(baseline!.identity);
    await expect(f.importZip({ chooseCollision: () => { f.nodes.get(`${HOME}\\profiles\\work\\AGENTS.md`)!.bytes = Buffer.from('after consent'); return 'overwrite'; } })).rejects.toThrow();
    expect(f.nodes.get(`${HOME}\\profiles\\work\\AGENTS.md`)!.bytes!.toString()).toBe('after consent');
    f.file(`${HOME}\\active-profile`, 'absent\n');
    await expect(f.importZip({ profileName: 'absent' })).rejects.toMatchObject({ code: 'PROFILE_IMPORT_DANGLING_ACTIVE' });
  });

  it('makes own live-journal cache reads authority-bound while unrelated/effect-free readers refuse', async () => {
    const f = await fixture(); await f.importZip();
    let retained: ReturnType<typeof createWindowsProfileDataReads> | undefined;
    await executeProfileCandidateSwap({ home: HOME, profileName: 'fresh', operation: 'fresh-import', services: f.services,
      async materialize(candidateDirectory, context) {
        retained = createWindowsProfileDataReads(f.backend, { home: HOME, authority: context.authority });
        expect((await readProfileSystemView(HOME, retained.viewReads)).profiles.length).toBe(1);
        await expect(f.activation.readSystemView(HOME)).rejects.toThrow('unresolved');
        await expect(inspectProfileImport(HOME, { kind: 'zip', path: ZIP }, f.dependencies)).rejects.toThrow('unresolved');
        return materializeCapturedProfile({ home: HOME, candidateDirectory, authority: context.authority, captured: f.source.profile, blobs: f.source.blobs, allowIncomplete: false, effects: f.dependencies.materializationEffects!(HOME, context.authority), materializeRemote: async () => { throw new Error('no remote'); } });
      }
    });
    await expect(readProfileSystemView(HOME, retained!.viewReads)).rejects.toThrow();
  });

  it('rejects an actual shared view started under locks when its read settles after authority expiry', async () => {
    const f = await fixture(); await f.importZip();
    let resume!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => { started = resolve; });
    const released = new Promise<void>((resolve) => { resume = resolve; });
    let pending!: Promise<unknown>;
    const original = f.backend.readStableFile.bind(f.backend);
    await expect(executeProfileCandidateSwap({ home: HOME, profileName: 'fresh', operation: 'fresh-import', services: f.services,
      async materialize(_directory, context) {
        const current = createWindowsProfileDataReads(f.backend, { home: HOME, authority: context.authority });
        vi.spyOn(f.backend, 'readStableFile').mockImplementation(async (path, max) => {
          if (path === `${HOME}\\profiles\\work\\AGENTS.md`) { started(); await released; }
          return original(path, max);
        });
        pending = readProfileSystemView(HOME, current.viewReads).catch((error: unknown) => error);
        await paused;
        throw new Error('release operation');
      }
    })).rejects.toThrow('release operation');
    resume();
    expect(await pending).toMatchObject({ code: 'PROFILE_OPERATION_AUTHORITY_INVALID' });
  });

  it('refuses output occupancy/alias and proves fresh no-replace and explicit overwrite reconciliation', async () => {
    const f = await fixture(); await f.importZip();
    const output = 'C:\\boundary\\output.zip';
    await exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output }, f.dependencies);
    const before = f.nodes.get(output)!.id;
    await expect(exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output }, f.dependencies)).rejects.toMatchObject({ code: 'PROFILE_ZIP_OUTPUT_OCCUPIED' });
    expect(f.nodes.get(output)!.id).toBe(before);
    expect((await exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output, overwrite: true }, f.dependencies)).overwritten).toBe(true);
    expect(f.nodes.get(output)!.id).not.toBe(before);
    const noReplace = vi.spyOn(f.backend, 'renameFileNoReplace').mockRejectedValue(new Error('sharing'));
    await expect(exportManagedProfile({ home: HOME, profileName: 'work', outputPath: 'C:\\boundary\\new.zip' }, f.dependencies)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ZIP_NO_EFFECT' });
    noReplace.mockRestore();
    await expect(f.dependencies.readZip!('C:\\boundary\\WORK.zip')).rejects.toThrow('aliased');
  });

  it('range reads admit archives beyond 64 MiB without a whole-file native allocation and reject bounds, truncation and drift', async () => {
    const f = await fixture(); const path = 'C:\\boundary\\large.zip';
    f.file(path, ''); f.nodes.get(path)!.bytes = Buffer.alloc(64 * 1024 * 1024 + 32);
    const whole = vi.spyOn(f.backend, 'readStableFile');
    const ranges = vi.spyOn(f.backend, 'readStableFileRange');
    const source = openWindowsProfileZipRangeSource(f.backend, path, capturedProfileLimitPolicy().maxAggregateBytes);
    expect((await source.readRange(64 * 1024 * 1024, 32)).length).toBe(32);
    expect(whole).not.toHaveBeenCalled(); expect(ranges).toHaveBeenCalledWith(path, 64 * 1024 * 1024, 32, 1536 * 1024 * 1024);
    await expect(source.readRange(Number.MAX_SAFE_INTEGER, 2)).rejects.toThrow();
    await expect(source.readRange(0, source.fileSize + 1)).rejects.toThrow();
    f.nodes.get(path)!.bytes = Buffer.alloc(1);
    await expect(source.validate()).rejects.toThrow('changed');
    ranges.mockRestore(); whole.mockRestore();
  });
  it.each(['afterOldRename', 'afterCandidateRename'] as const)('recovers the real directory effect before its journal proof at %s', async (hook) => {
    const f = await fixture(); await f.importZip();
    await expect(executeProfileCandidateSwap({ home: HOME, profileName: 'work', operation: 'overwrite', services: f.services,
      materialize: (candidateDirectory, context) => materializeCapturedProfile({ home: HOME, candidateDirectory, authority: context.authority, captured: f.source.profile, blobs: f.source.blobs, allowIncomplete: false, effects: f.dependencies.materializationEffects!(HOME, context.authority), materializeRemote: async () => { throw new Error('no remote'); } }),
      hooks: { [hook]: () => { throw new Error('effect interrupted'); } }
    })).rejects.toThrow('effect interrupted');
    expect(await recoverProfilePublishingTransactions(HOME, undefined, f.services)).toContainEqual(expect.objectContaining({ action: 'committed' }));
  });

  it('retries a proven no-effect old move but retains an independently changed ready candidate as ambiguous', async () => {
    const f = await fixture(); await f.importZip();
    const move = vi.spyOn(f.backend, 'renameDirectoryNoReplace').mockRejectedValueOnce(new Error('sharing'));
    const swap = () => executeProfileCandidateSwap({ home: HOME, profileName: 'work', operation: 'overwrite' as const, services: f.services,
      materialize: (candidateDirectory: string, context: { authority: Parameters<NonNullable<typeof f.dependencies.materializationEffects>>[1] }) => materializeCapturedProfile({ home: HOME, candidateDirectory, authority: context.authority, captured: f.source.profile, blobs: f.source.blobs, allowIncomplete: false, effects: f.dependencies.materializationEffects!(HOME, context.authority), materializeRemote: async () => { throw new Error('no remote'); } })
    });
    await expect(swap()).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_MOVE_NO_EFFECT' });
    move.mockRestore();
    expect(await recoverProfilePublishingTransactions(HOME, undefined, f.services)).toContainEqual(expect.objectContaining({ action: 'committed' }));
    await expect(executeProfileCandidateSwap({ home: HOME, profileName: 'work', operation: 'overwrite', services: f.services,
      materialize: (candidateDirectory, context) => materializeCapturedProfile({ home: HOME, candidateDirectory, authority: context.authority, captured: f.source.profile, blobs: f.source.blobs, allowIncomplete: false, effects: f.dependencies.materializationEffects!(HOME, context.authority), materializeRemote: async () => { throw new Error('no remote'); } }),
      hooks: { afterPhase(phase) { if (phase === 'CANDIDATE_READY') {
        const path = [...f.nodes.keys()].find((p) => /\\profiles\\\.bazframe-candidate-.*\\AGENTS.md$/u.test(p))!;
        f.nodes.get(path)!.bytes = Buffer.from('changed candidate'); throw new Error('candidate edited');
      } } }
    })).rejects.toThrow('candidate edited');
    expect(await recoverProfilePublishingTransactions(HOME, undefined, f.services)).toContainEqual(expect.objectContaining({ action: 'ambiguous' }));
    await expect(f.activation.readSystemView(HOME)).rejects.toThrow('unresolved');
  });

  it('refuses candidate drift before publication before old-profile movement', async () => {
    const f = await fixture(); await f.importZip(); const old = await f.services.capture(HOME, 'work');
    let candidate = '';
    await expect(executeProfileCandidateSwap({ home: HOME, profileName: 'work', operation: 'overwrite', services: f.services,
      materialize: (candidateDirectory, context) => { candidate = candidateDirectory; return materializeCapturedProfile({ home: HOME, candidateDirectory, authority: context.authority, captured: f.source.profile, blobs: f.source.blobs, allowIncomplete: false, effects: f.dependencies.materializationEffects!(HOME, context.authority), materializeRemote: async () => { throw new Error('no remote'); } }); },
      beforePublication() { f.nodes.get(`${candidate}\\AGENTS.md`)!.bytes = Buffer.from('changed candidate'); }
    })).rejects.toMatchObject({ code: 'PROFILE_TRANSACTION_CHANGED' });
    expect((await f.services.capture(HOME, 'work'))!.identity).toBe(old!.identity);
    expect(await recoverProfilePublishingTransactions(HOME, undefined, f.services)).toContainEqual(expect.objectContaining({ action: 'ambiguous' }));
  });

  it('treats owned executable metadata as generated-empty while retaining nonempty logical profiles', async () => {
    const f = await fixture(); f.directory(`${HOME}\\profiles\\empty`); f.file(`${HOME}\\profiles\\empty\\AGENTS.md`, '');
    f.file(`${HOME}\\profiles\\empty\\${WINDOWS_EXECUTABLE_METADATA}`, encodeWindowsExecutableMetadata({ schemaVersion: 1, files: [{ path: 'AGENTS.md', executable: true }, { path: 'skills/deleted/file', executable: false }] }).toString());
    expect(await removeManagedProfile(HOME, 'empty', { requireGeneratedEmpty: true }, f.services)).toMatchObject({ action: 'removed' });
  });

  it('uses namespace-safe external parents without imposing managed read privacy, while new output/staging files are protected', async () => {
    const f = await fixture(false);
    const before = f.backend.inspectPath('C:\\boundary').security;
    const ace = Buffer.from([0, 0, 20, 0, 0x89, 0, 0x12, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]); // Everyone: read only.
    const acl = Buffer.concat([before.daclBytes, ace]); acl.writeUInt16LE(acl.length, 2); acl.writeUInt16LE(before.daclBytes.readUInt16LE(4) + 1, 4);
    f.nodes.get('C:\\boundary')!.security = { ...before, daclBytes: acl };
    f.nodes.get(ZIP)!.security = { ...before, daclBytes: acl };
    expect(() => admitWindowsPrivateDirectory(f.backend, 'C:\\boundary')).toThrow();
    expect((await f.dependencies.readZip!(ZIP)).profile.resources).toHaveLength(4);
    await f.importZip();
    const output = 'C:\\boundary\\external.zip';
    await exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output }, f.dependencies);
    expect(f.backend.inspectPath(output).security.daclBytes).toEqual(before.daclBytes);
    expect(f.backend.inspectPath(output).security.descriptorControl & 0x1000).toBe(0x1000);
  });

  it('parses a canonical resource ZIP larger than 64 MiB using bounded native ranges and the original parser', async () => {
    const f = await fixture(false), source = bundle();
    const resource = source.profile.resources[0]!;
    if (resource.payload.kind !== 'bundled') throw new Error('fixture');
    for (let i = 0; i < 2; i++) {
      const bytesValue = Buffer.alloc(33 * 1024 * 1024, i), sha256 = hash(bytesValue);
      source.blobs.push({ sha256, bytes: bytesValue.length, bytesValue });
      source.profile.blobs.push({ sha256, bytes: bytesValue.length });
      resource.payload.files.push({ path: `large-${i}.bin`, sha256, bytes: bytesValue.length, executable: i === 1 });
    }
    resource.payload.files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); source.profile.blobs.sort((a,b) => a.sha256.localeCompare(b.sha256)); source.blobs.sort((a,b) => a.sha256.localeCompare(b.sha256));
    f.nodes.get(ZIP)!.bytes = await createCanonicalProfileZip(source.profile, source.blobs);
    const ranges = vi.spyOn(f.backend, 'readStableFileRange'), whole = vi.spyOn(f.backend, 'readStableFile');
    const parsed = await f.dependencies.readZip!(ZIP);
    expect(parsed.archiveBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(parsed.profile.resources).toEqual(source.profile.resources);
    expect(parsed.blobs.map((b) => hash(b.bytesValue))).toEqual(source.profile.blobs.map((b) => b.sha256));
    expect(Math.max(...ranges.mock.calls.map((call) => call[2]))).toBeLessThanOrEqual(1024 * 1024);
    expect(whole).not.toHaveBeenCalled();
    ranges.mockRestore(); whole.mockRestore();
  }, 30000);

  it.each(['malformed', 'reparse', 'hardlink', 'oversize-range-receipt', 'range-truncated', 'range-identity'])('retains private copied input on %s refusal and never bootstraps inspection home', async (kind) => {
    const f = await fixture(false);
    if (kind === 'malformed') f.nodes.get(ZIP)!.bytes = Buffer.from('not a ZIP');
    if (kind === 'reparse') f.reparse(ZIP);
    if (kind === 'hardlink') f.nodes.get(ZIP)!.numberOfLinks = 2;
    const original = f.backend.readStableFileRange;
    if (kind.startsWith('range-') || kind === 'oversize-range-receipt') f.backend.readStableFileRange = async (...args) => {
      const result = await original(...args);
      if (kind === 'range-identity') result.after.fileId = 'f'.repeat(32);
      else if (kind === 'range-truncated') { result.bytes = result.bytes.subarray(1); result.byteCount = result.bytes.length.toString(16).padStart(16, '0'); }
      else result.bytes = Buffer.concat([result.bytes, Buffer.from('extra')]);
      return result;
    };
    await expect(inspectProfileImport(HOME, { kind: 'zip', path: ZIP }, f.dependencies)).rejects.toThrow();
    expect(f.nodes.has(HOME)).toBe(false);
    expect(f.nodes.has(ZIP)).toBe(true);
  });

  it('drains rejected private archive writes and retains output ambiguity and no-effect without replacement claims', async () => {
    const f = await fixture(); await f.importZip(); const output = 'C:\\boundary\\replaced.zip';
    await exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output }, f.dependencies);
    const original = f.zipIo.rename;
    f.zipIo.rename = async () => { throw new Error('sharing'); };
    await expect(exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output, overwrite: true }, f.dependencies)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ZIP_NO_EFFECT' });
    f.zipIo.rename = async (from, to) => { await original(from, to); throw new Error('reported failure after effect'); };
    expect((await exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output, overwrite: true }, f.dependencies)).overwritten).toBe(true);
    f.zipIo.rename = async (from, to) => { await original(from, to); f.nodes.get(to)!.bytes = Buffer.from('substituted'); };
    await expect(exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output, overwrite: true }, f.dependencies)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ZIP_AMBIGUOUS' });
    const before = f.nodes.get(output)!.bytes;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    f.zipIo.writeExistingFile = async (path) => { await f.io.writeExistingFile(path, Buffer.from('partial')); await wait; throw new Error('drained write rejection'); };
    let settled = false;
    const writing = exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output, overwrite: true }, f.dependencies).finally(() => { settled = true; });
    await vi.waitFor(() => expect([...f.nodes.values()].some((node) => node.bytes?.toString() === 'partial')).toBe(true));
    expect(settled).toBe(false); release();
    await expect(writing).rejects.toThrow('drained write rejection');
    expect(f.nodes.get(output)!.bytes).toEqual(before);
    expect([...f.nodes.values()].some((node) => node.bytes?.toString() === 'partial')).toBe(true);
  });

  it('uses exact offline cache under its own live journal, preserves incomplete/package-effect policy, and rejects worsening swaps', async () => {
    const f = await fixture(); await f.importZip();
    const state = (await f.services.readManagedState(HOME, 'work'))!.state;
    const identity = { remote: 'github.com/owner/direct', fetchUrl: 'https://github.com/owner/direct.git', branch: 'main', revision: 'a'.repeat(40) };
    const direct = state.importedResources.find((r) => r.key.name === 'direct')!;
    if (direct.source.kind !== 'artifact') throw new Error('fixture');
    direct.source.origin = identity;
    f.nodes.get(`${HOME}\\profiles\\work\\.bazframe-profile-state.json`)!.bytes = Buffer.from(encodeManagedProfileState(state, capturedProfileLimitPolicy()));
    const blob = f.source.blobs.find((b) => b.sha256 === f.source.profile.profile.instructions.sha256)!;
    const captured: CapturedProfileV1 = { ...f.source.profile, resources: [{ id: '9'.repeat(64), key: { kind: 'skill', name: 'direct' }, payload: { kind: 'remoteGit', identity } }], blobs: [{ sha256: blob.sha256, bytes: blob.bytes }] };
    f.nodes.get(ZIP)!.bytes = await createCanonicalProfileZip(captured, [blob]);
    const unavailable = vi.fn(async () => ({ kind: 'acquisitionUnavailable' as const, diagnosticCode: 'OFFLINE', cacheWritten: false, buildExecuted: false }));
    f.dependencies.remote = { materialize: unavailable };
    expect(await f.importZip({ profileName: 'offline' })).toMatchObject({ incomplete: false, effects: { cacheWritten: false, buildExecuted: false } });
    expect(unavailable).not.toHaveBeenCalled();
    captured.resources = [{ id: '8'.repeat(64), key: { kind: 'package', name: 'missing' }, payload: { kind: 'remoteGit', identity: { ...identity, remote: 'github.com/owner/missing', fetchUrl: 'https://github.com/owner/missing.git' } } }];
    f.nodes.get(ZIP)!.bytes = await createCanonicalProfileZip(captured, [blob]);
    expect(await f.importZip({ profileName: 'incomplete', yes: true })).toMatchObject({ incomplete: true, missingResourceIds: ['8'.repeat(64)], effects: { buildExecuted: false } });
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(unavailable.mock.calls[0]).toEqual([expect.objectContaining({ key: { kind: 'package', name: 'missing' } }), expect.objectContaining({ packageBuildAuthorization: { mode: 'preauthorized' } })]);
    const journals = await scanWindowsTransactionJournals(f.backend, HOME);
    const recorded = await Promise.all(journals.map((name) => readWindowsTransactionJournal(f.backend, HOME, name.slice(0, -5))));
    expect(recorded).toContainEqual(expect.objectContaining({ profileName: 'incomplete', kind: 'candidate-swap', phase: 'COMMITTED', possiblePackageEffects: ['8'.repeat(64)] }));
    const old = (await f.services.capture(HOME, 'work'))!;
    await expect(executeProfileCandidateSwap({ home: HOME, profileName: 'work', operation: 'overwrite', expectedOld: old, services: f.services,
      materialize: (candidateDirectory, context) => materializeCapturedProfile({ home: HOME, candidateDirectory, authority: context.authority, captured, blobs: [blob], allowIncomplete: true, effects: f.dependencies.materializationEffects!(HOME, context.authority), materializeRemote: unavailable })
    })).rejects.toMatchObject({ code: 'PROFILE_MUTATION_WOULD_WORSEN' });
    expect((await f.services.capture(HOME, 'work'))!.identity).toBe(old.identity);
  });

  it('copies network input as bounded untrusted bytes to private local staging without admitting it as managed state', async () => {
    const f = await fixture(false), network = '\\\\server\\share\\work.zip';
    f.file(network, ''); f.nodes.get(network)!.bytes = f.nodes.get(ZIP)!.bytes;
    const inspected = await inspectProfileImport(HOME, { kind: 'zip', path: network }, f.dependencies);
    expect(inspected).toMatchObject({ mutationPerformed: false, collision: false });
    expect(f.nodes.has(HOME)).toBe(false);
    expect([...f.nodes.keys()].some((path) => /bazframe-zip-.*\\input.zip$/u.test(path))).toBe(true);
  });

  it.each(['old', 'candidate', 'parent'] as const)('refuses changed ZIP %s evidence immediately before output publication', async (kind) => {
    const f = await fixture(); await f.importZip(); const output = 'C:\\boundary\\stale.zip';
    await exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output }, f.dependencies);
    const original = f.zipIo.writeExistingFile;
    f.zipIo.writeExistingFile = async (path, chunks, max) => {
      await original(path, chunks, max);
      if (kind === 'old') f.file(output, 'replacement old');
      if (kind === 'candidate') f.nodes.get(path)!.bytes = Buffer.from('changed candidate');
      if (kind === 'parent') f.directory('C:\\boundary');
    };
    const rename = vi.spyOn(f.zipIo, 'rename');
    await expect(exportManagedProfile({ home: HOME, profileName: 'work', outputPath: output, overwrite: true }, f.dependencies)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_ZIP_REFUSED' });
    expect(rename).not.toHaveBeenCalled();
    expect(f.nodes.has(output)).toBe(true);
  });

  it('duplicates ordinary memberships and nested logical modes without touching external targets, then rich rename/removal remain usable', async () => {
    const f = await fixture(); await f.importZip(); const target = 'C:\\boundary\\ordinary';
    f.directory(target); f.file(`${target}\\SKILL.md`, definition('ordinary'));
    vi.mocked(fs.readlink).mockImplementation(async () => target);
    f.junction(`${HOME}\\skills\\ordinary`, target); f.junction(`${HOME}\\profiles\\work\\skills\\ordinary`, target);
    const external = JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(target)));
    const storage = createWindowsProfileStorage(f.backend, f.io);
    await duplicateManagedProfile(HOME, 'work', 'copy', {}, f.services, (authority) => storage.copyEffects(HOME, authority));
    expect(f.backend.inspectMembershipLink(`${HOME}\\profiles\\copy\\skills\\ordinary`).targetFileId).toBe(f.backend.inspectPath(target).object.fileId);
    expect((await f.services.capture(HOME, 'copy'))!.closure.entries).toContainEqual(expect.objectContaining({ path: 'skills/local/deep/guide.md', executable: true }));
    await renameManagedProfile(HOME, 'copy', 'renamed', {}, f.services);
    expect((await f.activation.readSystemView(HOME)).skills.map((entry) => entry.name)).toContain('ordinary');
    await removeManagedProfile(HOME, 'renamed', { expectedRemovalIdentity: await f.services.capture(HOME, 'renamed') }, f.services);
    expect(JSON.stringify([...f.nodes].filter(([path]) => path.startsWith(target)))).toBe(external);
  });
  it('uses shared imported membership selection/capture/copy/swap for immutable Skill/library/package instances', async () => {
    const f = await fixture(); await f.importZip();
    for (const path of [`${HOME}\\profiles\\target`, `${HOME}\\profiles\\target\\skills`]) ensureWindowsPrivateDirectoryPath(f.backend, path);
    f.file(`${HOME}\\profiles\\target\\AGENTS.md`, 'Target');
    const dependencies = createWindowsImportedResourceMembershipDependencies(f.backend, { storageIo: f.io, lockIo: f.io, stateIo: f.io, journal: { io: f.io } });
    for (const kind of ['skill', 'library', 'package'] as const) {
      const selection = await resolveProfileResourceMembershipSelection(HOME, kind, kind === 'skill' ? 'direct' : kind, dependencies);
      expect(await mutateImportedProfileResourceMembership(HOME, 'target', selection.stableIdentity, 'add', dependencies)).toMatchObject({ action: 'added', kind });
      expect(await mutateImportedProfileResourceMembership(HOME, 'target', selection.stableIdentity, 'add', dependencies)).toMatchObject({ action: 'current' });
      const view = await f.activation.readSystemView(HOME);
      expect(view.resources.find((resource) => resource.stableIdentity === selection.stableIdentity)!.ownerProfiles).toEqual(['target', 'work']);
      const output = `C:\\boundary\\membership-${kind}.zip`;
      const exported = await exportManagedProfile({ home: HOME, profileName: 'target', outputPath: output }, f.dependencies);
      expect(exported.capturedProfile.resources.some((resource) => resource.key.kind === kind)).toBe(true);
      expect(await mutateImportedProfileResourceMembership(HOME, 'target', selection.stableIdentity, 'remove', dependencies)).toMatchObject({ action: 'removed' });
      expect(await mutateImportedProfileResourceMembership(HOME, 'target', selection.stableIdentity, 'remove', dependencies)).toMatchObject({ action: 'absent' });
    }
    expect(f.nodes.get(`${HOME}\\profiles\\target\\AGENTS.md`)!.bytes!.toString()).toBe('Target');
    expect((await f.activation.readSystemView(HOME)).profiles.find((profile) => profile.name === 'work')!.resourceIdentities).toHaveLength(4);
  });

});
