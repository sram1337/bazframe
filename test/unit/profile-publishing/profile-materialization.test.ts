import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readlink, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { materializeCapturedProfile, type CapturedBlobSource } from '../../../src/profile-publishing/profile-materialization.js';
import { withProfileOperationLocks } from '../../../src/profile-publishing/profile-operation-lock.js';
import { capturedResourceId, ordinaryResourceIdentity, profileLocalResourceIdentity, profileLocalResourceInstanceId, resourceIdentityDigest, type CapturedProfileV1 } from '../../../src/profile-publishing/captured-profile.js';
import type { ManagedProfileStateV1 } from '../../../src/profile-publishing/publication-state.js';
import { writeCandidateManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';

let temporary: TempDirectory | undefined;
afterEach(async () => { await temporary?.cleanup(); temporary = undefined; });
const transactionId = '0123456789abcdef0123456789abcdef';

function blob(value: string): CapturedBlobSource {
  const bytesValue = Buffer.from(value);
  return { sha256: createHash('sha256').update(bytesValue).digest('hex'), bytes: bytesValue.byteLength, bytesValue };
}

function capture(resources: CapturedProfileV1['resources'], sources: CapturedBlobSource[]): CapturedProfileV1 {
  const instructions = sources[0]!;
  return {
    schemaVersion: 1,
    kind: 'bazframe-captured-profile',
    profile: { name: 'work', instructions: { path: 'AGENTS.md', sha256: instructions.sha256, bytes: instructions.bytes, executable: false } },
    resources,
    blobs: sources.map(({ sha256, bytes }) => ({ sha256, bytes })).sort((left, right) => left.sha256.localeCompare(right.sha256))
  };
}

async function candidate(home: string, id = transactionId): Promise<string> {
  const path = `${home}/profiles/.bazframe-candidate-${id}`;
  await mkdir(path, { recursive: true });
  return path;
}

describe('captured profile materialization', () => {
  it('materializes explicitly marked bundled direct Skills as physical profile-local state keyed by the transported ID', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const skill = blob('---\nname: review\ndescription: Review.\n---\n');
    const resourceId = 'b'.repeat(64);
    const captured = capture([{ id: resourceId, key: { kind: 'skill', name: 'review' }, payload: { kind: 'bundled', role: 'skill', sourceForm: 'profile-local', files: [{ path: 'SKILL.md', sha256: skill.sha256, bytes: skill.bytes, executable: false }] } }], [instructions, skill]);
    const path = await candidate(temporary.root);
    let remoteCalls = 0;
    const result = await withProfileOperationLocks(temporary.root, ['work', '@store'], (authority) => materializeCapturedProfile({
      home: temporary!.root,
      candidateDirectory: path,
      authority,
      captured,
      blobs: [instructions, skill],
      allowIncomplete: false,
      materializeRemote: async () => { remoteCalls += 1; return { kind: 'acquisitionUnavailable', diagnosticCode: 'NO_REMOTE', cacheWritten: false, buildExecuted: false }; }
    }), transactionId);
    expect(remoteCalls).toBe(0);
    expect(await temporary.readText(`profiles/.bazframe-candidate-${transactionId}/AGENTS.md`)).toBe('instructions\n');
    expect(result.missingResourceIds).toEqual([]);
    expect(result.state.importedResources).toHaveLength(0);
    expect(result.state.capturedResourceIds).toMatchObject([{ capturedResourceId: resourceId, identityKind: 'profileLocal' }]);
    expect(await temporary.readText(`profiles/.bazframe-candidate-${transactionId}/skills/review/SKILL.md`)).toContain('name: review');
    expect(result.treeIds).toEqual([]);
  });

  it('keeps an unmarked legacy origin-free bundled Skill as an imported immutable artifact', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const skill = blob('---\nname: review\ndescription: Review.\n---\n');
    const resourceId = 'c'.repeat(64);
    const resource: CapturedProfileV1['resources'][number] = { id: resourceId, key: { kind: 'skill', name: 'review' }, payload: { kind: 'bundled', role: 'skill', files: [{ path: 'SKILL.md', sha256: skill.sha256, bytes: skill.bytes, executable: false }] } };
    const path = await candidate(temporary.root);
    const result = await withProfileOperationLocks(temporary.root, ['work', '@store'], (authority) => materializeCapturedProfile({
      home: temporary!.root, candidateDirectory: path, authority, captured: capture([resource], [instructions, skill]), blobs: [instructions, skill], allowIncomplete: false,
      materializeRemote: async () => { throw new Error('unexpected remote materialization'); }
    }), transactionId);
    expect(result.state.capturedResourceIds).toMatchObject([{ capturedResourceId: resourceId, identityKind: 'imported' }]);
    expect(result.state.importedResources).toMatchObject([{ capturedResourceId: resourceId, key: { kind: 'skill', name: 'review' }, source: { kind: 'artifact' } }]);
    await expect(readFile(`${path}/skills/review/SKILL.md`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.treeIds).toHaveLength(1);
  });

  it('reintroduces retained ordinary skill/library/package identities as physical memberships and revalidates them', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const content = blob('ready\n');
    const enteredSkillRoot = `${temporary.root}/catalog/review`;
    await mkdir(enteredSkillRoot, { recursive: true });
    const skillRoot = await realpath(enteredSkillRoot);
    await writeFile(`${skillRoot}/SKILL.md`, 'ready\n');
    await mkdir(`${temporary.root}/skills`, { recursive: true });
    await symlink(skillRoot, `${temporary.root}/skills/review`);
    const cases = [
      { kind: 'skill' as const, name: 'review', role: 'skill' as const, id: '1'.repeat(64), transaction: '1123456789abcdef0123456789abcdef' },
      { kind: 'library' as const, name: 'shared', role: 'library' as const, id: '2'.repeat(64), transaction: '2123456789abcdef0123456789abcdef' },
      { kind: 'package' as const, name: 'builder', role: 'packageArtifacts' as const, id: '3'.repeat(64), transaction: '3123456789abcdef0123456789abcdef' }
    ];
    for (const item of cases) {
      const resource: CapturedProfileV1['resources'][number] = { id: item.id, key: { kind: item.kind, name: item.name }, payload: { kind: 'bundled', role: item.role, files: [{ path: item.kind === 'skill' ? 'SKILL.md' : 'artifact.txt', sha256: content.sha256, bytes: content.bytes, executable: false }] } };
      const previousState: ManagedProfileStateV1 = {
        schemaVersion: 1, profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publication: null,
        capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(ordinaryResourceIdentity(item.kind, item.name)), capturedResourceId: item.id, identityKind: 'catalog', instanceId: null }], importedResources: []
      };
      const path = await candidate(temporary.root, item.transaction);
      let captures = 0;
      const result = await withProfileOperationLocks(temporary.root, ['work', '@store'], async (authority) => {
        const materialized = await materializeCapturedProfile({
          home: temporary!.root, candidateDirectory: path, authority, captured: capture([resource], [instructions, content]), blobs: [instructions, content], previousState,
          preserveCapturedResourceBindings: true, allowIncomplete: false,
          captureOrdinary: async () => { captures += 1; return { resource, blobs: [content] }; },
          materializeRemote: async () => { throw new Error('unexpected remote materialization'); }
        });
        await materialized.revalidateOrdinary();
        return materialized;
      }, item.transaction);
      expect(captures).toBe(2);
      expect(result.state.importedResources).toEqual([]);
      expect(result.state.capturedResourceIds).toEqual(previousState.capturedResourceIds);
      if (item.kind === 'skill') expect(await readlink(`${path}/skills/review`)).toBe(skillRoot);
      else expect(JSON.parse(await readFile(`${path}/${item.kind === 'library' ? 'libraries' : 'packages'}/${item.name}.json`, 'utf8'))).toEqual(item.kind === 'library' ? { schemaVersion: 1, library: item.name } : { schemaVersion: 1, package: item.name });
    }
  });

  it('materializes a retained profile-local Skill physically without creating an imported artifact instance', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const definition = blob('---\nname: local\ndescription: Local.\n---\n');
    const guide = blob('guide\n');
    const profileInstanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const instanceId = profileLocalResourceInstanceId(profileInstanceId, 'local');
    const identity = profileLocalResourceIdentity(instanceId);
    const id = capturedResourceId('skill', identity);
    const resource: CapturedProfileV1['resources'][number] = { id, key: { kind: 'skill', name: 'local' }, payload: { kind: 'bundled', role: 'skill', sourceForm: 'profile-local', files: [
      { path: 'SKILL.md', sha256: definition.sha256, bytes: definition.bytes, executable: false },
      { path: 'references/guide.md', sha256: guide.sha256, bytes: guide.bytes, executable: false }
    ] } };
    const previousState: ManagedProfileStateV1 = {
      schemaVersion: 1, profileInstanceId, publication: null,
      capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(identity), capturedResourceId: id, identityKind: 'profileLocal', instanceId }],
      importedResources: []
    };
    const transaction = '5123456789abcdef0123456789abcdef';
    const path = await candidate(temporary.root, transaction);

    const result = await withProfileOperationLocks(temporary.root, ['work', '@store'], (authority) => materializeCapturedProfile({
      home: temporary!.root, candidateDirectory: path, authority,
      captured: capture([resource], [instructions, definition, guide]), blobs: [instructions, definition, guide], previousState,
      preserveCapturedResourceBindings: true, allowIncomplete: false,
      materializeRemote: async () => { throw new Error('unexpected remote materialization'); }
    }), transaction);

    expect(await readFile(`${path}/skills/local/SKILL.md`, 'utf8')).toContain('name: local');
    expect(await readFile(`${path}/skills/local/references/guide.md`, 'utf8')).toBe('guide\n');
    expect(result.state.importedResources).toEqual([]);
    expect(result.state.capturedResourceIds).toEqual(previousState.capturedResourceIds);
    expect(result.treeIds).toEqual([]);
  });

  it('fails retained ordinary revalidation on exact payload drift', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n'); const content = blob('ready\n'); const changed = blob('changed\n');
    const id = '4'.repeat(64); const transaction = '4123456789abcdef0123456789abcdef';
    const resource: CapturedProfileV1['resources'][number] = { id, key: { kind: 'library', name: 'shared' }, payload: { kind: 'bundled', role: 'library', files: [{ path: 'artifact.txt', sha256: content.sha256, bytes: content.bytes, executable: false }] } };
    const drifted = { ...resource, payload: { kind: 'bundled' as const, role: 'library' as const, files: [{ path: 'artifact.txt', sha256: changed.sha256, bytes: changed.bytes, executable: false }] } };
    const previousState: ManagedProfileStateV1 = { schemaVersion: 1, profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publication: null, capturedResourceIds: [{ resourceIdentityDigest: resourceIdentityDigest(ordinaryResourceIdentity('library', 'shared')), capturedResourceId: id, identityKind: 'catalog', instanceId: null }], importedResources: [] };
    const path = await candidate(temporary.root, transaction); let calls = 0;
    await withProfileOperationLocks(temporary.root, ['work', '@store'], async (authority) => {
      const result = await materializeCapturedProfile({ home: temporary!.root, candidateDirectory: path, authority, captured: capture([resource], [instructions, content]), blobs: [instructions, content], previousState, preserveCapturedResourceBindings: true, allowIncomplete: false,
        captureOrdinary: async () => { calls += 1; return calls === 1 ? { resource, blobs: [content] } : { resource: drifted, blobs: [changed] }; }, materializeRemote: async () => { throw new Error('unexpected'); } });
      await expect(result.revalidateOrdinary()).rejects.toMatchObject({ code: 'PROFILE_MATERIALIZATION_CHANGED' });
    }, transaction);
  });

  it('reuses one exact cached remote artifact without network, build, report, or consent', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const content = blob('ready\n');
    const resourceId = '9'.repeat(64);
    const identity = { remote: 'github.com/owner/shared', fetchUrl: 'https://github.com/owner/shared.git', branch: 'main', revision: 'a'.repeat(40) };
    const bundled: CapturedProfileV1['resources'][number] = { id: resourceId, key: { kind: 'library', name: 'shared' }, payload: { kind: 'bundled', role: 'library', files: [{ path: 'ready.txt', sha256: content.sha256, bytes: content.bytes, executable: false }], origin: identity } };
    const firstTransaction = '9123456789abcdef0123456789abcdef';
    const firstPath = await candidate(temporary.root, firstTransaction);
    await withProfileOperationLocks(temporary.root, ['source', '@store'], async (authority) => {
      const first = await materializeCapturedProfile({ home: temporary!.root, candidateDirectory: firstPath, authority, captured: capture([bundled], [instructions, content]), blobs: [instructions, content], allowIncomplete: false, materializeRemote: async () => { throw new Error('unexpected'); } });
      expect(first.effects).toEqual({ cacheWritten: true, buildExecuted: false });
      await writeCandidateManagedProfileState(temporary!.root, firstPath, first.state);
    }, firstTransaction);
    await rename(firstPath, `${temporary.root}/profiles/source`);

    const remote: CapturedProfileV1['resources'][number] = { id: resourceId, key: { kind: 'library', name: 'shared' }, payload: { kind: 'remoteGit', identity } };
    const secondTransaction = 'a123456789abcdef0123456789abcdef';
    const secondPath = await candidate(temporary.root, secondTransaction);
    let remoteCalls = 0;
    const second = await withProfileOperationLocks(temporary.root, ['work', '@store'], (authority) => materializeCapturedProfile({
      home: temporary!.root, candidateDirectory: secondPath, authority, captured: capture([remote], [instructions]), blobs: [instructions], allowIncomplete: false,
      materializeRemote: async () => { remoteCalls += 1; throw new Error('network/build/report must not run'); }
    }), secondTransaction);
    expect(remoteCalls).toBe(0);
    expect(second.effects).toEqual({ cacheWritten: false, buildExecuted: false });
    expect(second.state.importedResources[0]!.source).toMatchObject({ kind: 'remoteGit', identity });
  });

  it('records unavailable unbundled remotes only for permitted initial incompleteness', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const resourceId = 'c'.repeat(64);
    const captured = capture([{ id: resourceId, key: { kind: 'skill', name: 'review' }, payload: { kind: 'remoteGit', identity: { remote: 'github.com/user-name/review', fetchUrl: 'https://github.com/user-name/review.git', branch: 'main', revision: 'a'.repeat(40) } } }], [instructions]);
    const refusedPath = await candidate(temporary.root);
    await withProfileOperationLocks(temporary.root, ['work', '@store'], async (authority) => {
      await expect(materializeCapturedProfile({ home: temporary!.root, candidateDirectory: refusedPath, authority, captured, blobs: [instructions], allowIncomplete: false, materializeRemote: async () => ({ kind: 'acquisitionUnavailable', diagnosticCode: 'REMOTE_UNAVAILABLE', cacheWritten: false, buildExecuted: false }) })).rejects.toMatchObject({ code: 'PROFILE_REMOTE_RESOURCE_UNAVAILABLE' });
    }, transactionId);
    const allowedTransaction = '1123456789abcdef0123456789abcdef';
    const allowedPath = await candidate(temporary.root, allowedTransaction);
    await withProfileOperationLocks(temporary.root, ['work', '@store'], async (authority) => {
      const result = await materializeCapturedProfile({ home: temporary!.root, candidateDirectory: allowedPath, authority, captured, blobs: [instructions], allowIncomplete: true, materializeRemote: async () => ({ kind: 'acquisitionUnavailable', diagnosticCode: 'REMOTE_UNAVAILABLE', cacheWritten: false, buildExecuted: false }) });
      expect(result.missingResourceIds).toEqual([resourceId]);
      expect(result.state.importedResources[0]!.source.kind).toBe('missingRemoteGit');
    }, allowedTransaction);
  });

  it('retains imported identity bindings through version removal, duplication, and reintroduction', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const skill = blob('---\nname: review\ndescription: Review.\n---\n');
    const resourceId = 'd'.repeat(64);
    const resource: CapturedProfileV1['resources'][number] = { id: resourceId, key: { kind: 'skill', name: 'review' }, payload: { kind: 'bundled', role: 'skill', origin:{remote:'github.com/owner/review',fetchUrl:'https://github.com/owner/review.git',branch:'main',revision:'a'.repeat(40)}, files: [{ path: 'SKILL.md', sha256: skill.sha256, bytes: skill.bytes, executable: false }] } };
    const run = async (id: string, resources: CapturedProfileV1['resources'], previousState?: Awaited<ReturnType<typeof materializeCapturedProfile>>['state']) => {
      const path = await candidate(temporary!.root, id);
      return withProfileOperationLocks(temporary!.root, ['work', '@store'], (authority) => materializeCapturedProfile({
        home: temporary!.root, candidateDirectory: path, authority, captured: capture(resources, resources.length === 0 ? [instructions] : [instructions, skill]),
        blobs: resources.length === 0 ? [instructions] : [instructions, skill], allowIncomplete: false,
        ...(previousState === undefined ? {} : { previousState, preserveCapturedResourceBindings: true }),
        materializeRemote: async () => { throw new Error('unexpected remote materialization'); }
      }), id);
    };
    const first = await run('1123456789abcdef0123456789abcdef', [resource]);
    const removed = await run('2123456789abcdef0123456789abcdef', [], first.state);
    expect(removed.state.importedResources).toEqual([]);
    expect(removed.state.capturedResourceIds).toEqual(first.state.capturedResourceIds);
    const duplicatedRemoved = { ...removed.state, profileInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const restored = await run('3123456789abcdef0123456789abcdef', [resource], duplicatedRemoved);
    expect(restored.state.importedResources[0]!.instanceId).toBe(first.state.importedResources[0]!.instanceId);
  });

  it('rejects malformed remote adapter results before later package work', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const identity = (name: string) => ({ remote: `github.com/owner/${name}`, fetchUrl: `https://github.com/owner/${name}.git`, branch: 'main', revision: 'a'.repeat(40) });
    const resources: CapturedProfileV1['resources'] = [
      { id: 'c'.repeat(64), key: { kind: 'skill', name: 'review' }, payload: { kind: 'remoteGit', identity: identity('review') } },
      { id: 'd'.repeat(64), key: { kind: 'package', name: 'builder' }, payload: { kind: 'remoteGit', identity: identity('builder') } }
    ];
    const path = await candidate(temporary.root);
    let calls = 0;
    await withProfileOperationLocks(temporary.root, ['work', '@store'], async (authority) => {
      await expect(materializeCapturedProfile({
        home: temporary!.root, candidateDirectory: path, authority, captured: capture(resources, [instructions]), blobs: [instructions], allowIncomplete: true,
        materializeRemote: async () => { calls += 1; return { kind: 'unexpected' } as never; }
      })).rejects.toMatchObject({ code: 'PROFILE_MATERIALIZATION_INVALID' });
    }, transactionId);
    expect(calls).toBe(1);
  });

  it('rejects missing or corrupt supplied blob closure before candidate writes', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const instructions = blob('instructions\n');
    const captured = capture([], [instructions]);
    const path = await candidate(temporary.root);
    await withProfileOperationLocks(temporary.root, ['work', '@store'], async (authority) => {
      await expect(materializeCapturedProfile({ home: temporary!.root, candidateDirectory: path, authority, captured, blobs: [], allowIncomplete: false, materializeRemote: async () => ({ kind: 'acquisitionUnavailable', diagnosticCode: 'NO', cacheWritten: false, buildExecuted: false }) })).rejects.toMatchObject({ code: 'PROFILE_MATERIALIZATION_INVALID' });
    }, transactionId);
    await expect(temporary.readText(`profiles/.bazframe-candidate-${transactionId}/AGENTS.md`)).rejects.toBeDefined();
  });
});
