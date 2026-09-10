import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirectory,type TempDirectory } from '../../helpers/temp-directory.js';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transactionJournalRequiredAuthorityKeys, validateTransactionJournalUpdate, type TransactionJournal, type TransactionJournalV1, type CandidateSwapJournalV2, type RenameProfileJournalV2, type RemoveProfileJournalV2, type PublicationJournalV2, decodeTransactionJournalBytes,encodeTransactionJournal,isTransactionJournalName,readTransactionJournal,transitionTransactionJournal,writeTransactionJournal,type CandidateSwapJournalV1,type PublicationJournalV1,type RemoveProfileJournalV1,type RenameProfileJournalV1 } from '../../../src/profile-publishing/transaction-journal.js';
import { recoverProfilePublishingTransactions } from '../../../src/profile-publishing/profile-recovery.js';
import type { OperationMutationAuthority } from '../../../src/profile-publishing/profile-operation-lock.js';
import { withProfileOperationLocks } from '../../../src/profile-publishing/profile-operation-lock.js';
const tx='0123456789abcdef0123456789abcdef',sha='a'.repeat(64),sha2='b'.repeat(64);let temporary:TempDirectory|undefined;afterEach(async()=>{await temporary?.cleanup();temporary=undefined;});
const candidate:CandidateSwapJournalV1={schemaVersion:1,kind:'candidate-swap',transactionId:tx,operation:'fresh-import',profileName:'work',expectedOld:{kind:'absent'},candidate:{token:`candidate:${tx}`,identity:null,sidecarSha256:null,profileClosureSha256:null},backup:null,activeProfileBefore:null,phase:'PLANNED',possiblePackageEffects:[]};
const rename:RenameProfileJournalV1={schemaVersion:1,kind:'rename-profile',transactionId:tx,oldName:'work',newName:'work-new',expectedOld:{identity:'1:2',sidecarSha256:null,profileClosureSha256:sha},expectedNew:{kind:'absent'},activeBefore:'work',activeAfter:'work-new',favoritesBeforeSha256:null,favoritesAfterCanonicalBytesSha256:sha2,phase:'INTENT'};
const remove:RemoveProfileJournalV1={schemaVersion:1,kind:'remove-profile',transactionId:tx,profileName:'work',expectedProfile:{identity:'1:2',sidecarSha256:null,profileClosureSha256:sha},quarantine:{token:`backup:${tx}`},activeBefore:'other',activeBeforeSha256:sha2,favoritesBeforeSha256:sha,favoritesAfterCanonicalBytesSha256:sha2,phase:'INTENT'};
const publication:PublicationJournalV1={schemaVersion:1,kind:'publication',transactionId:tx,profileName:'work',expectedProfile:{identity:'1:2',sidecarSha256:null,profileClosureSha256:sha},origin:'github.com/user-name/work',expectedBaseCommit:null,capturedManifestSha256:sha2,originalVisibility:'absent',desiredVisibility:'private',repositoryCreated:false,repositoryId:null,observedCommit:null,phase:'INTENT'};
describe('transaction journal',()=>{
 it.each([candidate,rename,remove,publication])('round trips canonical $kind bytes',(journal)=>{const bytes=Buffer.from(encodeTransactionJournal(journal));expect(decodeTransactionJournalBytes(bytes)).toEqual(journal);expect(()=>decodeTransactionJournalBytes(Buffer.from(bytes.toString().replace('  "kind"',' "kind"')))).toThrow();});
 it('enforces directed monotonic transitions',()=>{const materializing=transitionTransactionJournal(candidate,'MATERIALIZING');expect(materializing.phase).toBe('MATERIALIZING');expect(()=>transitionTransactionJournal(candidate,'CANDIDATE_READY')).toThrow();expect(()=>transitionTransactionJournal({...candidate,phase:'COMMITTED'},'AMBIGUOUS')).toThrow();expect(transitionTransactionJournal(candidate,'ABORTED').phase).toBe('ABORTED');expect(transitionTransactionJournal(publication,'AMBIGUOUS').phase).toBe('AMBIGUOUS');expect(transitionTransactionJournal(remove,'FAVORITES_MUTATION_INTENT').phase).toBe('FAVORITES_MUTATION_INTENT');expect(()=>transitionTransactionJournal(remove,'DIRECTORY_QUARANTINE_INTENT')).toThrow();});
 it('persists only initial creation and exact monotonic updates with live authority',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');await withProfileOperationLocks(temporary.root,['work','@store'],async(authority)=>{await expect(writeTransactionJournal(temporary!.root,authority,candidate)).resolves.toEqual(candidate);expect(await readTransactionJournal(temporary!.root,tx)).toEqual(candidate);await expect(writeTransactionJournal(temporary!.root,authority,{...candidate,phase:'CANDIDATE_READY'})).rejects.toBeDefined();const materializing={...candidate,phase:'MATERIALIZING' as const};await expect(writeTransactionJournal(temporary!.root,authority,materializing)).resolves.toEqual(materializing);await expect(writeTransactionJournal(temporary!.root,authority,{...materializing,profileName:'other',phase:'PACKAGES_LAST'})).rejects.toBeDefined();},tx);expect(isTransactionJournalName(`${tx}.json`)).toBe(true);expect(isTransactionJournalName(`x${tx}.json`)).toBe(false);});
 it('rejects wrong authority, cross-transaction tokens, and malformed values',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');await withProfileOperationLocks(temporary.root,['other','@store'],async(authority)=>{await expect(writeTransactionJournal(temporary!.root,authority,candidate)).rejects.toMatchObject({code:'PROFILE_OPERATION_AUTHORITY_INVALID'});},tx);expect(()=>encodeTransactionJournal({...candidate,transactionId:'bad'})).toThrow();expect(()=>encodeTransactionJournal({...candidate,candidate:{...candidate.candidate,token:`candidate:${'f'.repeat(32)}`}})).toThrow();expect(()=>encodeTransactionJournal({...candidate,expectedOld:{kind:'physical-directory',identity:'1:2',sidecarSha256:null,profileClosureSha256:sha},operation:'update',backup:{token:`backup:${'f'.repeat(32)}`,identity:'1:2',profileClosureSha256:sha}})).toThrow();expect(()=>encodeTransactionJournal({...publication,expectedBaseCommit:'bad'})).toThrow();expect(()=>encodeTransactionJournal({...remove,activeBefore:'work'})).toThrow();expect(()=>encodeTransactionJournal({...remove,quarantine:{token:'backup:bad'}})).toThrow();expect(()=>encodeTransactionJournal({...remove,favoritesBeforeSha256:null})).toThrow();});
 it('rejects a linked transaction namespace without writing through it',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');const outside=join(temporary.root,'outside');await mkdir(outside);await mkdir(join(temporary.root,'profile-publishing'));await symlink(outside,join(temporary.root,'profile-publishing','transactions'));await withProfileOperationLocks(temporary.root,['work','@store'],async(authority)=>{await expect(writeTransactionJournal(temporary!.root,authority,candidate)).rejects.toBeDefined();},tx);expect(await readdir(outside)).toEqual([]);});
 it('persists canonical generic GitHub profile repository names',()=>{const generic={...publication,origin:`github.com/user-name/profile_name-${'a'.repeat(70)}`};expect(decodeTransactionJournalBytes(Buffer.from(encodeTransactionJournal(generic)))).toEqual(generic);});
});

const windowsProof = { identity: 'win32-ntfs:ffffffffffffffff:00000000000000000000000000000001' as const, sidecarSha256: null, profileClosureSha256: sha };
function v1Fields<T extends TransactionJournalV1>(value: T): Omit<T, 'schemaVersion'> {
  const { schemaVersion, ...fields } = value;
  expect(schemaVersion).toBe(1);
  return fields;
}
const candidateFields = v1Fields(candidate), renameFields = v1Fields(rename), removeFields = v1Fields(remove), publicationFields = v1Fields(publication);
const candidateV2: CandidateSwapJournalV2 = { schemaVersion: 2, identityDomain: 'win32-ntfs', ...candidateFields, expectedOld: { kind: 'absent' }, backup: null, candidate: { ...candidate.candidate, identity: null } };
const renameV2: RenameProfileJournalV2 = { schemaVersion: 2, identityDomain: 'win32-ntfs', ...renameFields, expectedOld: windowsProof };
const removeV2: RemoveProfileJournalV2 = { schemaVersion: 2, identityDomain: 'win32-ntfs', ...removeFields, expectedProfile: windowsProof };
const publicationV2: PublicationJournalV2 = { schemaVersion: 2, identityDomain: 'win32-ntfs', ...publicationFields, expectedProfile: windowsProof };
const readyV2: CandidateSwapJournalV2 = { ...candidateV2, candidate: { token: candidate.candidate.token, ...windowsProof }, phase: 'CANDIDATE_READY' };
const replacementV2: CandidateSwapJournalV2 = { ...readyV2, operation: 'update', expectedOld: { kind: 'physical-directory', ...windowsProof }, backup: { token: `backup:${tx}`, ...windowsProof, sidecarSha256: sha2 }, phase: 'OLD_RENAME_PROVEN' };
function wire(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }

describe('versioned journals, one update policy and POSIX execution boundary', () => {
  it.each([
    { journal: candidate, keys: ['work', '@store'] },
    { journal: rename, keys: ['work', 'work-new', '@store'] },
    { journal: remove, keys: ['work', '@store'] },
    { journal: publication, keys: ['work', '@store'] },
    { journal: candidateV2, keys: ['work', '@store'] },
    { journal: renameV2, keys: ['work', 'work-new', '@store'] },
    { journal: removeV2, keys: ['work', '@store'] },
    { journal: publicationV2, keys: ['work', '@store'] }
  ])('requires exact ordered authority keys for V$journal.schemaVersion/$journal.kind', ({ journal, keys }) => {
    expect(transactionJournalRequiredAuthorityKeys(journal)).toEqual(keys);
  });
  it.each([candidateV2, renameV2, removeV2, publicationV2, readyV2, replacementV2])('round trips complete Windows $kind/$phase without changing evidence', (value) => {
    expect(decodeTransactionJournalBytes(wire(value))).toEqual(value);
    expect(encodeTransactionJournal(value)).toBe(wire(value).toString());
    expect(Object.keys(decodeTransactionJournalBytes(wire(value))).slice(0, 3)).toEqual(['schemaVersion', 'identityDomain', 'kind']);
  });
  it.each([
    { ...candidateV2, candidate: { ...candidateV2.candidate, observationIdentity: null } },
    { ...renameV2, expectedOld: { ...windowsProof, observationIdentity: sha2 } },
    { ...removeV2, expectedProfile: { ...windowsProof, observationIdentity: sha2 } },
    { ...publicationV2, expectedProfile: { ...windowsProof, observationIdentity: sha2 } },
    { ...replacementV2, expectedOld: { kind: 'physical-directory', ...windowsProof, observationIdentity: sha2 } },
    { ...replacementV2, backup: { ...replacementV2.backup, observationIdentity: sha2 } }
  ])('refuses old internal V2 fields without migration %#', (legacy) => {
    expect(() => decodeTransactionJournalBytes(wire(legacy))).toThrow();
    expect(() => encodeTransactionJournal(legacy as TransactionJournal)).toThrow();
  });
  it('retains POSIX all-digit identities without interpreting them as untagged Windows', () => {
    const identity = '1234567890123456:12345678901234567890123456789012';
    const v1 = { ...rename, expectedOld: { ...rename.expectedOld, identity } };
    expect(decodeTransactionJournalBytes(wire(v1))).toEqual(v1);
    expect(() => decodeTransactionJournalBytes(wire({ ...renameV2, expectedOld: { ...windowsProof, identity } }))).toThrow();
  });
  it.each([
    { ...candidateV2, schemaVersion: 3 }, { ...candidateV2, schemaVersion: '2' },
    { ...candidateV2, identityDomain: 'posix' }, { ...candidateV2, identityDomain: undefined },
    { ...candidateV2, kind: 'other' }, { ...candidateV2, extra: 1 },
    { ...renameV2, expectedOld: { ...windowsProof, observationIdentity: null } },
    { ...renameV2, expectedOld: { ...windowsProof, observationIdentity: sha2 } },
    { ...removeV2, expectedProfile: { ...windowsProof, observationIdentity: 'B'.repeat(64) } },
    { ...publicationV2, expectedProfile: rename.expectedOld },
    { ...rename, expectedOld: windowsProof },
    { ...candidateV2, candidate: { ...candidateV2.candidate, observationIdentity: sha } },
    { ...candidateV2, candidate: { ...candidateV2.candidate, sidecarSha256: sha }, phase: 'MATERIALIZING' },
    { ...readyV2, candidate: { ...readyV2.candidate, observationIdentity: null } },
    { ...readyV2, candidate: { ...readyV2.candidate, profileClosureSha256: null } },
    { ...replacementV2, backup: { ...replacementV2.backup, observationIdentity: sha2 } },
    { ...replacementV2, backup: { ...replacementV2.backup, sidecarSha256: undefined } },
    { ...replacementV2, backup: { ...replacementV2.backup, identity: '1:2' } }
  ])('rejects malformed version/domain/evidence %#', (value) => {
    expect(() => decodeTransactionJournalBytes(wire(value))).toThrow();
    expect(() => encodeTransactionJournal(value as TransactionJournal)).toThrow();
  });
  it('rejects reordered keys, invalid UTF-8, noncanonical bytes, non-data objects and limits', () => {
    const { identityDomain, ...rest } = candidateV2;
    expect(() => decodeTransactionJournalBytes(wire({ ...rest, identityDomain }))).toThrow();
    expect(() => decodeTransactionJournalBytes(Buffer.concat([wire(candidateV2), Buffer.from([0xff])]))).toThrow();
    expect(() => decodeTransactionJournalBytes(Buffer.from(JSON.stringify(candidateV2)))).toThrow();
    expect(() => decodeTransactionJournalBytes(wire(candidateV2), { maxManifestBytes: 1 })).toThrow();
    expect(() => encodeTransactionJournal(Object.create(candidateV2) as CandidateSwapJournalV2)).toThrow();
    const accessor = { ...candidateV2 }; Object.defineProperty(accessor, 'phase', { get: () => 'PLANNED', enumerable: true });
    expect(() => encodeTransactionJournal(accessor)).toThrow();
    expect(() => encodeTransactionJournal(new Proxy(candidateV2, {}))).toThrow();
  });
  it('freezes versions, known core proofs and package effects', () => {
    expect(() => validateTransactionJournalUpdate(candidate, { ...candidateV2, phase: 'MATERIALIZING' })).toThrow();
    expect(() => validateTransactionJournalUpdate(candidateV2, { ...candidate, phase: 'MATERIALIZING' })).toThrow();
    expect(() => validateTransactionJournalUpdate(candidateV2, { ...candidateV2, identityDomain: 'other', phase: 'MATERIALIZING' } as unknown as CandidateSwapJournalV2)).toThrow();
    expect(() => validateTransactionJournalUpdate(readyV2, { ...readyV2, candidate: { ...readyV2.candidate, profileClosureSha256: sha2 }, phase: 'CANDIDATE_RENAME_INTENT' })).toThrow();
    expect(() => validateTransactionJournalUpdate(readyV2, { ...readyV2, candidate: { ...readyV2.candidate, identity: windowsProof.identity.slice(0, -1) + '2' } as CandidateSwapJournalV2['candidate'], phase: 'CANDIDATE_RENAME_INTENT' })).toThrow();
    expect(() => validateTransactionJournalUpdate(readyV2, { ...readyV2, candidate: { ...readyV2.candidate, profileClosureSha256: null }, phase: 'AMBIGUOUS' })).toThrow();
    expect(() => validateTransactionJournalUpdate(renameV2, { ...renameV2, expectedOld: { ...windowsProof, sidecarSha256: sha }, phase: 'DIRECTORY_RENAME_INTENT' })).toThrow();
    expect(() => validateTransactionJournalUpdate(replacementV2, { ...replacementV2, backup: { token: `backup:${tx}`, ...windowsProof }, phase: 'CANDIDATE_RENAME_INTENT' })).toThrow();
    expect(() => validateTransactionJournalUpdate({ ...candidateV2, possiblePackageEffects: [sha] }, { ...candidateV2, phase: 'MATERIALIZING' })).toThrow();
    expect(() => validateTransactionJournalUpdate({ ...publicationV2, repositoryCreated: true }, { ...publicationV2, phase: 'REPOSITORY_CREATED' })).toThrow();
    expect(() => validateTransactionJournalUpdate({ ...publicationV2, repositoryId: 1 }, { ...publicationV2, repositoryId: 2, phase: 'REPOSITORY_CREATED' })).toThrow();
    expect(() => validateTransactionJournalUpdate({ ...publicationV2, observedCommit: 'a'.repeat(40) }, { ...publicationV2, observedCommit: 'b'.repeat(40), phase: 'REPOSITORY_CREATED' })).toThrow();
  });
  it('uses all existing normal routes and terminal/abort restrictions in both domains', () => {
    const routes: [TransactionJournal, TransactionJournal['phase'][]][] = [
      [readyV2, ['CANDIDATE_RENAME_INTENT', 'CANDIDATE_RENAME_PROVEN', 'ACTIVE_SELECTION_PROVEN', 'COMMITTED']],
      [{ ...replacementV2, phase: 'CANDIDATE_READY' }, ['OLD_RENAME_INTENT', 'OLD_RENAME_PROVEN', 'CANDIDATE_RENAME_INTENT', 'CANDIDATE_RENAME_PROVEN', 'ACTIVE_SELECTION_PROVEN', 'COMMITTED']],
      [renameV2, ['DIRECTORY_RENAME_INTENT', 'DIRECTORY_RENAME_PROVEN', 'ACTIVE_SELECTION_INTENT', 'ACTIVE_SELECTION_PROVEN', 'FAVORITES_INTENT', 'FAVORITES_PROVEN', 'COMMITTED']],
      [removeV2, ['FAVORITES_MUTATION_INTENT', 'FAVORITES_MUTATION_PROVEN', 'DIRECTORY_QUARANTINE_INTENT', 'DIRECTORY_QUARANTINE_PROVEN', 'COMMITTED']],
      [publicationV2, ['REPOSITORY_CREATED', 'PRIVATE_BEFORE_PUSH_INTENT', 'PRIVATE_BEFORE_PUSH_PROVEN', 'PUSH_INTENT', 'COMMIT_PUSH_PROVEN', 'PUBLIC_AFTER_PUSH_INTENT', 'PUBLIC_AFTER_PUSH_PROVEN', 'LOCAL_STATE_INTENT', 'LOCAL_STATE_PROVEN', 'COMMITTED']]
    ];
    for (const [start, phases] of routes) {
      let current = start;
      for (const phase of phases) current = transitionTransactionJournal(current, phase);
      expect(() => transitionTransactionJournal(current, 'AMBIGUOUS')).toThrow();
    }
    for (const start of [candidate, rename, remove, publication, candidateV2, renameV2, removeV2, publicationV2]) {
      expect(validateTransactionJournalUpdate(undefined, start)).toEqual(start);
      expect(() => validateTransactionJournalUpdate(undefined, { ...start, phase: 'AMBIGUOUS' })).toThrow();
      expect(transitionTransactionJournal(start, 'AMBIGUOUS').phase).toBe('AMBIGUOUS');
      if (start.kind === 'remove-profile' || start.kind === 'publication') expect(() => transitionTransactionJournal(start, 'ABORTED')).toThrow();
      else expect(transitionTransactionJournal(start, 'ABORTED').phase).toBe('ABORTED');
      for (const phase of ['COMMITTED', 'AMBIGUOUS'] as const) expect(() => transitionTransactionJournal({ ...start, phase }, 'AMBIGUOUS')).toThrow();
    }
    expect(() => transitionTransactionJournal({ ...replacementV2, phase: 'OLD_RENAME_INTENT' }, 'ABORTED')).toThrow();
    expect(() => transitionTransactionJournal({ ...renameV2, phase: 'DIRECTORY_RENAME_INTENT' }, 'ABORTED')).toThrow();
    expect(transitionTransactionJournal(transitionTransactionJournal(candidateV2, 'MATERIALIZING'), 'PACKAGES_LAST').phase).toBe('PACKAGES_LAST');
  });
  it('refuses supplied Windows journals before authority, namespace open or creation', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const missingHome = join(temporary.root, 'absent');
    // @ts-expect-error Windows codec records must not enter the statically V1-only storage API.
    await expect(writeTransactionJournal(missingHome, null as unknown as OperationMutationAuthority, candidateV2)).rejects.toMatchObject({ code: 'PROFILE_TRANSACTION_JOURNAL_STORAGE_UNSUPPORTED' });
    let getterCalls = 0;
    const malformed = { ...candidate }; Object.defineProperty(malformed, 'schemaVersion', { get() { getterCalls++; return 2; }, enumerable: true });
    await expect(writeTransactionJournal(missingHome, null as unknown as OperationMutationAuthority, malformed)).rejects.toMatchObject({ code: 'PROFILE_TRANSACTION_JOURNAL_INVALID' });
    expect(getterCalls).toBe(0);
    expect(await readdir(temporary.root)).toEqual([]);
  });
  it('blocks POSIX read/update/recovery of Windows bytes with no temp, operation locks or replay', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const home = temporary.root, root = join(home, 'profile-publishing', 'transactions');
    await mkdir(root, { recursive: true });
    const path = join(root, `${tx}.json`), bytes = wire(candidateV2);
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(readTransactionJournal(home, tx)).rejects.toMatchObject({ code: 'PROFILE_TRANSACTION_JOURNAL_STORAGE_UNSUPPORTED' });
    await expect(recoverProfilePublishingTransactions(home)).rejects.toMatchObject({ code: 'PROFILE_TRANSACTION_JOURNAL_STORAGE_UNSUPPORTED' });
    expect(await readdir(join(home, 'profile-publishing'))).toEqual(['transactions']);
    await withProfileOperationLocks(home, ['work', '@store'], async (authority) => {
      await expect(writeTransactionJournal(home, authority, candidate)).rejects.toMatchObject({ code: 'PROFILE_TRANSACTION_JOURNAL_STORAGE_UNSUPPORTED' });
    }, tx);
    expect(await readdir(root)).toEqual([`${tx}.json`]);
    expect(await readFile(path)).toEqual(bytes);
  });
});

// Literal historical V1 bytes, including leading-zero and beyond-number-range decimal spelling.
const v1GoldenBytes = [
`{
  "schemaVersion": 1,
  "kind": "candidate-swap",
  "transactionId": "0123456789abcdef0123456789abcdef",
  "operation": "update",
  "profileName": "work",
  "expectedOld": {
    "kind": "physical-directory",
    "identity": "0001234567890123456:00012345678901234567890123456789012",
    "sidecarSha256": null,
    "profileClosureSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "candidate": {
    "token": "candidate:0123456789abcdef0123456789abcdef",
    "identity": null,
    "sidecarSha256": null,
    "profileClosureSha256": null
  },
  "backup": null,
  "activeProfileBefore": null,
  "phase": "PLANNED",
  "possiblePackageEffects": []
}
`,
`{
  "schemaVersion": 1,
  "kind": "rename-profile",
  "transactionId": "0123456789abcdef0123456789abcdef",
  "oldName": "work",
  "newName": "work-new",
  "expectedOld": {
    "identity": "0001234567890123456:00012345678901234567890123456789012",
    "sidecarSha256": null,
    "profileClosureSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "expectedNew": {
    "kind": "absent"
  },
  "activeBefore": "work",
  "activeAfter": "work-new",
  "favoritesBeforeSha256": null,
  "favoritesAfterCanonicalBytesSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "phase": "INTENT"
}
`,
`{
  "schemaVersion": 1,
  "kind": "remove-profile",
  "transactionId": "0123456789abcdef0123456789abcdef",
  "profileName": "work",
  "expectedProfile": {
    "identity": "0001234567890123456:00012345678901234567890123456789012",
    "sidecarSha256": null,
    "profileClosureSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "quarantine": {
    "token": "backup:0123456789abcdef0123456789abcdef"
  },
  "activeBefore": "other",
  "activeBeforeSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "favoritesBeforeSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "favoritesAfterCanonicalBytesSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "phase": "INTENT"
}
`,
`{
  "schemaVersion": 1,
  "kind": "publication",
  "transactionId": "0123456789abcdef0123456789abcdef",
  "profileName": "work",
  "expectedProfile": {
    "identity": "0001234567890123456:00012345678901234567890123456789012",
    "sidecarSha256": null,
    "profileClosureSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "origin": "github.com/user-name/work",
  "expectedBaseCommit": null,
  "capturedManifestSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "originalVisibility": "absent",
  "desiredVisibility": "private",
  "repositoryCreated": false,
  "repositoryId": null,
  "observedCommit": null,
  "phase": "INTENT"
}
`
];
it.each(v1GoldenBytes)('preserves literal POSIX V1 bytes %#', (golden) => {
  const value = decodeTransactionJournalBytes(Buffer.from(golden));
  expect(value.schemaVersion).toBe(1);
  expect(encodeTransactionJournal(value)).toBe(golden);
  const parsed = JSON.parse(golden) as TransactionJournalV1;
  expect(encodeTransactionJournal(parsed)).toBe(golden);
});
