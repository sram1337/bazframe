import { randomBytes } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { constants } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { canonicalProfileGitHubOrigin } from '../providers/managed-git-source.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { profilePublishingTransactionRoot } from '../state/paths.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { assertOperationMutationAuthority, type OperationMutationAuthority } from './profile-operation-lock.js';
import { assertPhysicalDirectoryIdentity, openStablePhysicalDirectory, readStablePhysicalFile, stableMutationChildPath, syncStableDirectory, type StableDirectory } from './profile-filesystem.js';

export interface PersistedPhysicalProfileExpectation { identity: string; sidecarSha256: string | null; profileClosureSha256: string }
export type CandidateToken = `candidate:${string}`;
export type BackupToken = `backup:${string}`;
export type CandidatePhase = 'PLANNED'|'MATERIALIZING'|'PACKAGES_LAST'|'CANDIDATE_READY'|'OLD_RENAME_INTENT'|'OLD_RENAME_PROVEN'|'CANDIDATE_RENAME_INTENT'|'CANDIDATE_RENAME_PROVEN'|'ACTIVE_SELECTION_PROVEN'|'COMMITTED'|'ABORTED'|'AMBIGUOUS';
export interface CandidateSwapJournalV1 { schemaVersion:1; kind:'candidate-swap'; transactionId:string; operation:'fresh-import'|'overwrite'|'update'|'repair'|'version-use'; profileName:string; expectedOld:{kind:'absent'}|({kind:'physical-directory'}&PersistedPhysicalProfileExpectation); candidate:{token:CandidateToken;identity:string|null;sidecarSha256:string|null;profileClosureSha256:string|null}; backup:null|{token:BackupToken;identity:string;profileClosureSha256:string}; activeProfileBefore:string|null; phase:CandidatePhase; possiblePackageEffects:string[] }
export type RenamePhase='INTENT'|'DIRECTORY_RENAME_INTENT'|'DIRECTORY_RENAME_PROVEN'|'ACTIVE_SELECTION_INTENT'|'ACTIVE_SELECTION_PROVEN'|'FAVORITES_INTENT'|'FAVORITES_PROVEN'|'COMMITTED'|'ABORTED'|'AMBIGUOUS';
export interface RenameProfileJournalV1 { schemaVersion:1; kind:'rename-profile'; transactionId:string; oldName:string; newName:string; expectedOld:PersistedPhysicalProfileExpectation; expectedNew:{kind:'absent'}; activeBefore:string|null; activeAfter:string|null; favoritesBeforeSha256:string|null; favoritesAfterCanonicalBytesSha256:string|null; phase:RenamePhase }
export type RemovePhase='INTENT'|'FAVORITES_MUTATION_INTENT'|'FAVORITES_MUTATION_PROVEN'|'DIRECTORY_QUARANTINE_INTENT'|'DIRECTORY_QUARANTINE_PROVEN'|'COMMITTED'|'AMBIGUOUS';
export interface RemoveProfileJournalV1 { schemaVersion:1; kind:'remove-profile'; transactionId:string; profileName:string; expectedProfile:PersistedPhysicalProfileExpectation; quarantine:{token:BackupToken}; activeBefore:string|null; activeBeforeSha256:string|null; favoritesBeforeSha256:string|null; favoritesAfterCanonicalBytesSha256:string|null; phase:RemovePhase }
export type PublicationPhase='INTENT'|'REPOSITORY_CREATED'|'PRIVATE_BEFORE_PUSH_INTENT'|'PRIVATE_BEFORE_PUSH_PROVEN'|'PUSH_INTENT'|'COMMIT_PUSH_PROVEN'|'PUBLIC_AFTER_PUSH_INTENT'|'PUBLIC_AFTER_PUSH_PROVEN'|'LOCAL_STATE_INTENT'|'LOCAL_STATE_PROVEN'|'COMMITTED'|'AMBIGUOUS';
export interface PublicationJournalV1 { schemaVersion:1; kind:'publication'; transactionId:string; profileName:string; expectedProfile:PersistedPhysicalProfileExpectation; origin:string; expectedBaseCommit:string|null; capturedManifestSha256:string; originalVisibility:'absent'|'private'|'public'; desiredVisibility:'preserve'|'private'|'public'; repositoryCreated:boolean; repositoryId:number|null; observedCommit:string|null; phase:PublicationPhase }
export type TransactionJournalV1=CandidateSwapJournalV1|RenameProfileJournalV1|RemoveProfileJournalV1|PublicationJournalV1;
const TX=/^[a-f0-9]{32}$/u, SHA=/^[a-f0-9]{64}$/u, COMMIT=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, IDENTITY=/^[0-9]+:[0-9]+$/u;
const candidateExisting:CandidatePhase[]=['PLANNED','MATERIALIZING','PACKAGES_LAST','CANDIDATE_READY','OLD_RENAME_INTENT','OLD_RENAME_PROVEN','CANDIDATE_RENAME_INTENT','CANDIDATE_RENAME_PROVEN','ACTIVE_SELECTION_PROVEN','COMMITTED'];
const candidateFresh:CandidatePhase[]=['PLANNED','MATERIALIZING','PACKAGES_LAST','CANDIDATE_READY','CANDIDATE_RENAME_INTENT','CANDIDATE_RENAME_PROVEN','ACTIVE_SELECTION_PROVEN','COMMITTED'];
const renamePhases:RenamePhase[]=['INTENT','DIRECTORY_RENAME_INTENT','DIRECTORY_RENAME_PROVEN','ACTIVE_SELECTION_INTENT','ACTIVE_SELECTION_PROVEN','FAVORITES_INTENT','FAVORITES_PROVEN','COMMITTED'];
const removePhases:RemovePhase[]=['INTENT','FAVORITES_MUTATION_INTENT','FAVORITES_MUTATION_PROVEN','DIRECTORY_QUARANTINE_INTENT','DIRECTORY_QUARANTINE_PROVEN','COMMITTED'];
const publicationPhases:PublicationPhase[]=['INTENT','REPOSITORY_CREATED','PRIVATE_BEFORE_PUSH_INTENT','PRIVATE_BEFORE_PUSH_PROVEN','PUSH_INTENT','COMMIT_PUSH_PROVEN','PUBLIC_AFTER_PUSH_INTENT','PUBLIC_AFTER_PUSH_PROVEN','LOCAL_STATE_INTENT','LOCAL_STATE_PROVEN','COMMITTED'];

export function newTransactionId():string{return randomBytes(16).toString('hex');}
export function candidateTransactionToken(transactionId:string):CandidateToken{tx(transactionId);return `candidate:${transactionId}`;}
export function backupTransactionToken(transactionId:string):BackupToken{tx(transactionId);return `backup:${transactionId}`;}
export function physicalProfileSiblingForTransactionToken(token:CandidateToken|BackupToken):string{const match=/^(candidate|backup):([a-f0-9]{32})$/u.exec(token);if(match===null)throw invalid('path token is invalid');return `.bazframe-${match[1]}-${match[2]}`;}
export function encodeTransactionJournal(value:TransactionJournalV1,lower:Partial<CapturedProfileLimitPolicy>={}):string{return `${JSON.stringify(validate(value,lower),null,2)}\n`;}
export function decodeTransactionJournalBytes(bytes:Uint8Array,lower:Partial<CapturedProfileLimitPolicy>={}):TransactionJournalV1{const policy=capturedProfileLimitPolicy(lower);if(bytes.byteLength>policy.maxManifestBytes)throw invalid('journal exceeds byte limit');let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(error){throw new BazframeError('PROFILE_TRANSACTION_JOURNAL_INVALID','Invalid profile transaction journal.',{cause:error});}const journal=validate(value,policy);if(!Buffer.from(encodeTransactionJournal(journal,policy)).equals(Buffer.from(bytes)))throw invalid('journal bytes are not canonical');return journal;}
export function transitionTransactionJournal<T extends TransactionJournalV1>(journal:T,phase:CandidatePhase|RenamePhase|RemovePhase|PublicationPhase):T{assertNextPhase(journal,phase);return validate({...journal,phase}) as T;}
export function transactionJournalPath(home:string,transactionId:string):string{if(!TX.test(transactionId))throw invalid('transaction ID is invalid');return join(profilePublishingTransactionRoot(home),`${transactionId}.json`);}
export async function writeTransactionJournal<T extends TransactionJournalV1>(home:string,authority:OperationMutationAuthority,journal:T,lower:Partial<CapturedProfileLimitPolicy>={}):Promise<T>{
  const validated=validate(journal,lower) as T;
  const required=validated.kind==='rename-profile'?[validated.oldName,validated.newName,'@store']:[validated.profileName,'@store'];
  assertOperationMutationAuthority(authority,home,required,validated.transactionId);
  const root=profilePublishingTransactionRoot(home);await ensureManagedDirectory(home,root);
  const directory=await openStablePhysicalDirectory(root,home);
  try{
    const path=stableMutationChildPath(directory,`${validated.transactionId}.json`);
    let previous:TransactionJournalV1|undefined;
    try{previous=await readJournalChild(directory,validated.transactionId,lower);}catch(error){const missing=errorCode(error)==='ENOENT'||(error instanceof BazframeError&&error.cause!==undefined&&errorCode(error.cause)==='ENOENT');if(!missing)throw error;}
    if(previous===undefined){assertInitialPhase(validated);}else{assertJournalUpdate(previous,validated);}
    const temporary=stableMutationChildPath(directory,`.tmp-${randomBytes(16).toString('hex')}`);const bytes=Buffer.from(encodeTransactionJournal(validated,lower));
    await assertPhysicalDirectoryIdentity(directory);
    const handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    assertOperationMutationAuthority(authority,home,required,validated.transactionId);
    await assertPhysicalDirectoryIdentity(directory);
    if(previous===undefined){await link(temporary,path);await unlink(temporary);}else{await rename(temporary,path);}
    await syncStableDirectory(directory);const persisted=await readJournalChild(directory,validated.transactionId,lower);if(persisted.kind!==validated.kind)throw invalid('persisted journal kind changed');return persisted as T;
  }finally{await directory.handle.close().catch(()=>undefined);}
}
export async function readTransactionJournal(home:string,transactionId:string,lower:Partial<CapturedProfileLimitPolicy>={}):Promise<TransactionJournalV1>{
  tx(transactionId);const root=profilePublishingTransactionRoot(home);const directory=await openStablePhysicalDirectory(root,home);
  try{return await readJournalChild(directory,transactionId,lower);}finally{await directory.handle.close().catch(()=>undefined);}
}
async function readJournalChild(directory:StableDirectory,transactionId:string,lower:Partial<CapturedProfileLimitPolicy>):Promise<TransactionJournalV1>{const policy=capturedProfileLimitPolicy(lower);await assertPhysicalDirectoryIdentity(directory);const file=await readStablePhysicalFile(stableMutationChildPath(directory,`${transactionId}.json`),policy.maxManifestBytes);await assertPhysicalDirectoryIdentity(directory);return decodeTransactionJournalBytes(file.bytes,policy);}
export function isTransactionJournalName(name:string):boolean{return TX.test(basename(name,'.json'))&&name.endsWith('.json')&&name.length===37;}

function assertInitialPhase(journal:TransactionJournalV1):void{
  const expected=journal.kind==='candidate-swap'?'PLANNED':'INTENT';
  if(journal.phase!==expected)throw invalid('new journal must begin at its initial phase');
}
function assertJournalUpdate(previous:TransactionJournalV1,next:TransactionJournalV1):void{
  if(previous.kind!==next.kind||previous.transactionId!==next.transactionId)throw invalid('journal identity changed during update');
  assertNextPhase(previous,next.phase);
  if(previous.kind==='candidate-swap'&&next.kind==='candidate-swap'){
    if(!same({operation:previous.operation,profileName:previous.profileName,expectedOld:previous.expectedOld,token:previous.candidate.token,activeProfileBefore:previous.activeProfileBefore},{operation:next.operation,profileName:next.profileName,expectedOld:next.expectedOld,token:next.candidate.token,activeProfileBefore:next.activeProfileBefore}))throw invalid('candidate journal immutable fields changed');
    for(const field of ['identity','sidecarSha256','profileClosureSha256'] as const)if(previous.candidate[field]!==null&&previous.candidate[field]!==next.candidate[field])throw invalid('candidate proof changed');
    if(previous.backup!==null&&!same(previous.backup,next.backup))throw invalid('backup proof changed');
    if(previous.possiblePackageEffects.some((effect,index)=>next.possiblePackageEffects[index]!==effect))throw invalid('package effects are not append-only');
  }else if(previous.kind==='rename-profile'&&next.kind==='rename-profile'){
    if(!same({...previous,phase:next.phase},next))throw invalid('rename journal immutable fields changed');
  }else if(previous.kind==='remove-profile'&&next.kind==='remove-profile'){
    if(!same({...previous,phase:next.phase},next))throw invalid('remove journal immutable fields changed');
  }else if(previous.kind==='publication'&&next.kind==='publication'){
    if(!same({...previous,phase:next.phase,repositoryCreated:next.repositoryCreated,repositoryId:next.repositoryId,observedCommit:next.observedCommit},next))throw invalid('publication journal immutable fields changed');
    if(previous.repositoryCreated&&!next.repositoryCreated)throw invalid('repository creation proof regressed');
    if(previous.repositoryId!==null&&previous.repositoryId!==next.repositoryId)throw invalid('repository identity changed');
    if(previous.observedCommit!==null&&previous.observedCommit!==next.observedCommit)throw invalid('observed commit changed');
  }else throw invalid('journal kind changed during update');
}
function assertNextPhase(journal:TransactionJournalV1,phase:CandidatePhase|RenamePhase|RemovePhase|PublicationPhase):void{
  const current=journal.phase;
  if(current==='COMMITTED'||current==='ABORTED'||current==='AMBIGUOUS')throw invalid('terminal journal cannot transition');
  if(phase==='AMBIGUOUS')return;
  if(phase==='ABORTED'){
    if(journal.kind==='publication'||journal.kind==='remove-profile'||(journal.kind==='candidate-swap'&&['OLD_RENAME_INTENT','OLD_RENAME_PROVEN','CANDIDATE_RENAME_INTENT','CANDIDATE_RENAME_PROVEN','ACTIVE_SELECTION_PROVEN'].includes(current))||(journal.kind==='rename-profile'&&current!=='INTENT'))throw invalid('journal cannot abort after mutation intent');
    return;
  }
  const phases=journal.kind==='candidate-swap'?(journal.expectedOld.kind==='absent'?candidateFresh:candidateExisting):journal.kind==='rename-profile'?renamePhases:journal.kind==='remove-profile'?removePhases:publicationPhases;
  const index=phases.indexOf(current as never);if(index<0||phases[index+1]!==phase)throw invalid('journal transition is not monotonic');
}
function same(left:unknown,right:unknown):boolean{return JSON.stringify(left)===JSON.stringify(right);}

function validate(value:unknown,lower:Partial<CapturedProfileLimitPolicy>={}):TransactionJournalV1{const policy=capturedProfileLimitPolicy(lower);const root=record(value,'journal');if(root.schemaVersion!==1||typeof root.kind!=='string')throw invalid('journal identity is invalid');if(root.kind==='candidate-swap')return candidate(root,policy);if(root.kind==='rename-profile')return renameJournal(root);if(root.kind==='remove-profile')return removeJournal(root);if(root.kind==='publication')return publication(root);throw invalid('journal kind is invalid');}
function candidate(root:Record<string,unknown>,policy:CapturedProfileLimitPolicy):CandidateSwapJournalV1{keys(root,['schemaVersion','kind','transactionId','operation','profileName','expectedOld','candidate','backup','activeProfileBefore','phase','possiblePackageEffects']);const transactionId=tx(root.transactionId),profileName=profile(root.profileName);if(!['fresh-import','overwrite','update','repair','version-use'].includes(String(root.operation)))throw invalid('candidate operation is invalid');const old=record(root.expectedOld,'expectedOld');let expectedOld:CandidateSwapJournalV1['expectedOld'];if(old.kind==='absent'){keys(old,['kind']);expectedOld={kind:'absent'};}else{keys(old,['kind','identity','sidecarSha256','profileClosureSha256']);if(old.kind!=='physical-directory')throw invalid('expectedOld kind is invalid');expectedOld={kind:'physical-directory',identity:identity(old.identity),sidecarSha256:nullableSha(old.sidecarSha256),profileClosureSha256:sha(old.profileClosureSha256)};}if((root.operation==='fresh-import')!==(expectedOld.kind==='absent'))throw invalid('candidate operation and expectedOld disagree');const c=record(root.candidate,'candidate');keys(c,['token','identity','sidecarSha256','profileClosureSha256']);if(typeof c.token!=='string'||c.token!==candidateTransactionToken(transactionId))throw invalid('candidate token is invalid');const candidateValue={token:c.token as CandidateToken,identity:nullableIdentity(c.identity),sidecarSha256:nullableSha(c.sidecarSha256),profileClosureSha256:nullableSha(c.profileClosureSha256)};let backup:CandidateSwapJournalV1['backup']=null;if(root.backup!==null){const b=record(root.backup,'backup');keys(b,['token','identity','profileClosureSha256']);if(typeof b.token!=='string'||b.token!==backupTransactionToken(transactionId))throw invalid('backup token is invalid');backup={token:b.token as BackupToken,identity:identity(b.identity),profileClosureSha256:sha(b.profileClosureSha256)};}if(expectedOld.kind==='absent'&&backup!==null)throw invalid('fresh candidate cannot have backup');const effects=array(root.possiblePackageEffects,'possiblePackageEffects',policy.maxResources).map((entry)=>sha(entry));for(let i=1;i<effects.length;i++)if(effects[i-1]!>=effects[i]!)throw invalid('package effects must be unique and sorted');const active=nullableProfile(root.activeProfileBefore);const phase=candidatePhase(root.phase,expectedOld.kind==='absent');
  const route=expectedOld.kind==='absent'?candidateFresh:candidateExisting;const phaseIndex=route.indexOf(phase);
  if(phase==='PLANNED'&&(candidateValue.identity!==null||candidateValue.sidecarSha256!==null||candidateValue.profileClosureSha256!==null))throw invalid('planned candidate proofs must be null');
  if(phaseIndex>=route.indexOf('CANDIDATE_READY')&&(candidateValue.identity===null||candidateValue.profileClosureSha256===null))throw invalid('ready candidate proofs are required');
  if(expectedOld.kind==='physical-directory'&&phaseIndex>=route.indexOf('OLD_RENAME_PROVEN')&&backup===null)throw invalid('proved old rename requires backup proof');
  return{schemaVersion:1,kind:'candidate-swap',transactionId,operation:root.operation as CandidateSwapJournalV1['operation'],profileName,expectedOld,candidate:candidateValue,backup,activeProfileBefore:active,phase,possiblePackageEffects:effects};}
function renameJournal(root:Record<string,unknown>):RenameProfileJournalV1{keys(root,['schemaVersion','kind','transactionId','oldName','newName','expectedOld','expectedNew','activeBefore','activeAfter','favoritesBeforeSha256','favoritesAfterCanonicalBytesSha256','phase']);const oldName=profile(root.oldName),newName=profile(root.newName);if(oldName===newName)throw invalid('rename names must differ');const expectedNew=record(root.expectedNew,'expectedNew');keys(expectedNew,['kind']);if(expectedNew.kind!=='absent')throw invalid('expectedNew must be absent');const phase=enumValue(root.phase,[...renamePhases,'ABORTED','AMBIGUOUS'] as const,'rename phase');return{schemaVersion:1,kind:'rename-profile',transactionId:tx(root.transactionId),oldName,newName,expectedOld:expectation(record(root.expectedOld,'expectedOld')),expectedNew:{kind:'absent'},activeBefore:nullableProfile(root.activeBefore),activeAfter:nullableProfile(root.activeAfter),favoritesBeforeSha256:nullableSha(root.favoritesBeforeSha256),favoritesAfterCanonicalBytesSha256:nullableSha(root.favoritesAfterCanonicalBytesSha256),phase};}
function removeJournal(root:Record<string,unknown>):RemoveProfileJournalV1{keys(root,['schemaVersion','kind','transactionId','profileName','expectedProfile','quarantine','activeBefore','activeBeforeSha256','favoritesBeforeSha256','favoritesAfterCanonicalBytesSha256','phase']);const transactionId=tx(root.transactionId),profileName=profile(root.profileName);const quarantine=record(root.quarantine,'quarantine');keys(quarantine,['token']);if(quarantine.token!==backupTransactionToken(transactionId))throw invalid('remove quarantine token is invalid');const activeBefore=nullableProfile(root.activeBefore),activeBeforeSha256=nullableSha(root.activeBeforeSha256);if((activeBefore===null)!==(activeBeforeSha256===null)||activeBefore===profileName)throw invalid('remove active-profile baseline is invalid');const favoritesBeforeSha256=nullableSha(root.favoritesBeforeSha256),favoritesAfterCanonicalBytesSha256=nullableSha(root.favoritesAfterCanonicalBytesSha256);if(favoritesBeforeSha256===null&&favoritesAfterCanonicalBytesSha256!==null)throw invalid('remove favorites baseline is invalid');return{schemaVersion:1,kind:'remove-profile',transactionId,profileName,expectedProfile:expectation(record(root.expectedProfile,'expectedProfile')),quarantine:{token:quarantine.token as BackupToken},activeBefore,activeBeforeSha256,favoritesBeforeSha256,favoritesAfterCanonicalBytesSha256,phase:enumValue(root.phase,[...removePhases,'AMBIGUOUS'] as const,'remove phase')};}
function publication(root:Record<string,unknown>):PublicationJournalV1{keys(root,['schemaVersion','kind','transactionId','profileName','expectedProfile','origin','expectedBaseCommit','capturedManifestSha256','originalVisibility','desiredVisibility','repositoryCreated','repositoryId','observedCommit','phase']);if(typeof root.origin!=='string')throw invalid('origin is invalid');let origin:string;try{origin=canonicalProfileGitHubOrigin(root.origin);}catch(error){throw new BazframeError('PROFILE_TRANSACTION_JOURNAL_INVALID','Invalid profile transaction journal: origin is invalid.',{cause:error});}if(typeof root.repositoryCreated!=='boolean')throw invalid('repositoryCreated is invalid');const repositoryId=root.repositoryId===null?null:positiveInteger(root.repositoryId,'repositoryId');return{schemaVersion:1,kind:'publication',transactionId:tx(root.transactionId),profileName:profile(root.profileName),expectedProfile:expectation(record(root.expectedProfile,'expectedProfile')),origin,expectedBaseCommit:nullableCommit(root.expectedBaseCommit),capturedManifestSha256:sha(root.capturedManifestSha256),originalVisibility:enumValue(root.originalVisibility,['absent','private','public'] as const,'original visibility'),desiredVisibility:enumValue(root.desiredVisibility,['preserve','private','public'] as const,'desired visibility'),repositoryCreated:root.repositoryCreated,repositoryId,observedCommit:nullableCommit(root.observedCommit),phase:enumValue(root.phase,[...publicationPhases,'AMBIGUOUS'] as const,'publication phase')};}
function expectation(value:Record<string,unknown>):PersistedPhysicalProfileExpectation{keys(value,['identity','sidecarSha256','profileClosureSha256']);return{identity:identity(value.identity),sidecarSha256:nullableSha(value.sidecarSha256),profileClosureSha256:sha(value.profileClosureSha256)};}
function record(value:unknown,label:string):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value)||utilTypes.isProxy(value))throw invalid(`${label} must be a plain object`);const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw invalid(`${label} must be a plain object`);for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))if(!('value' in descriptor))throw invalid(`${label} must contain data properties only`);return value as Record<string,unknown>;}
function keys(value:Record<string,unknown>,expected:string[]):void{const actual=Object.keys(value);if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index]))throw invalid('journal fields or key order are invalid');}
function array(value:unknown,label:string,max:number):unknown[]{if(!Array.isArray(value)||value.length>max)throw invalid(`${label} is invalid`);return value;}
function tx(value:unknown):string{if(typeof value!=='string'||!TX.test(value))throw invalid('transaction ID is invalid');return value;}
function sha(value:unknown):string{if(typeof value!=='string'||!SHA.test(value))throw invalid('SHA-256 value is invalid');return value;}
function nullableSha(value:unknown):string|null{return value===null?null:sha(value);}
function identity(value:unknown):string{if(typeof value!=='string'||!IDENTITY.test(value))throw invalid('physical identity is invalid');return value;}
function nullableIdentity(value:unknown):string|null{return value===null?null:identity(value);}
function profile(value:unknown):string{if(typeof value!=='string'||!isSafeProfileId(value))throw invalid('profile name is invalid');return value;}
function nullableProfile(value:unknown):string|null{return value===null?null:profile(value);}
function positiveInteger(value:unknown,label:string):number{if(!Number.isSafeInteger(value)||Number(value)<=0)throw invalid(`${label} is invalid`);return Number(value);}
function nullableCommit(value:unknown):string|null{if(value===null)return null;if(typeof value!=='string'||!COMMIT.test(value))throw invalid('commit ID is invalid');return value;}
function enumValue<T extends string>(value:unknown,values:readonly T[],label:string):T{if(typeof value!=='string'||!values.includes(value as T))throw invalid(`${label} is invalid`);return value as T;}
function candidatePhase(value:unknown,fresh:boolean):CandidatePhase{return enumValue(value,[...(fresh?candidateFresh:candidateExisting),'ABORTED','AMBIGUOUS'] as CandidatePhase[],'candidate phase');}
function invalid(detail:string):BazframeError{return new BazframeError('PROFILE_TRANSACTION_JOURNAL_INVALID',`Invalid profile transaction journal: ${detail}.`);}
