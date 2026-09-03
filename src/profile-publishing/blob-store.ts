import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { ensureManagedDirectory } from '../state/atomic-file.js';
import { profilePublishingBlobRoot, profilePublishingStagingRoot } from '../state/paths.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { assertOperationMutationAuthority, operationAuthorityTransactionId, type OperationMutationAuthority } from './profile-operation-lock.js';
import { assertStablePhysicalDirectory, openStablePhysicalDirectory, readStablePhysicalFile, stableReadChildPath } from './profile-filesystem.js';

const SHA = /^[a-f0-9]{64}$/u;
export function blobPath(home:string,sha256:string):string{if(!SHA.test(sha256))throw invalid('blob digest is invalid');return join(profilePublishingBlobRoot(home),sha256);}

export async function publishStoredBlob(home:string,authority:OperationMutationAuthority,bytes:Uint8Array,expectedSha256:string,lower:Partial<CapturedProfileLimitPolicy>={}):Promise<{sha256:string;bytes:number;reused:boolean}>{const policy=capturedProfileLimitPolicy(lower);if(!SHA.test(expectedSha256)||bytes.byteLength>policy.maxBlobBytes||digest(bytes)!==expectedSha256)throw invalid('blob bytes do not match the expected bounded digest');const transactionId=operationAuthorityTransactionId(authority);assertOperationMutationAuthority(authority,home,['@store'],transactionId);const root=profilePublishingBlobRoot(home);const staging=join(profilePublishingStagingRoot(home),transactionId);await ensureManagedDirectory(home,root);await ensureManagedDirectory(home,staging);const temporary=join(staging,`.blob-${randomBytes(16).toString('hex')}`);const handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}assertOperationMutationAuthority(authority,home,['@store'],transactionId);let reused=false;try{await link(temporary,blobPath(home,expectedSha256));await syncDirectory(root);}catch(error){if(errorCode(error)!=='EEXIST')throw error;await assertStoredBlob(home,expectedSha256,bytes.byteLength,policy);reused=true;}return{sha256:expectedSha256,bytes:bytes.byteLength,reused};}

export async function readStoredBlob(home:string,sha256:string,lower:Partial<CapturedProfileLimitPolicy>={}):Promise<Buffer>{if(!SHA.test(sha256))throw invalid('blob digest is invalid');const policy=capturedProfileLimitPolicy(lower);const rootPath=profilePublishingBlobRoot(home);let root;try{root=await openStablePhysicalDirectory(rootPath,home);}catch(error){if(error instanceof BazframeError&&error.cause!==undefined&&errorCode(error.cause)==='ENOENT')throw new BazframeError('PROFILE_BLOB_ABSENT','Profile blob is absent.');throw error;}try{let file;try{file=await readStablePhysicalFile(stableReadChildPath(root,sha256),policy.maxBlobBytes);}catch(error){if(error instanceof BazframeError&&error.cause!==undefined&&errorCode(error.cause)==='ENOENT')throw new BazframeError('PROFILE_BLOB_ABSENT','Profile blob is absent.');throw error;}await assertStablePhysicalDirectory(root);if(digest(file.bytes)!==sha256)throw invalid('stored blob digest is invalid');return file.bytes;}finally{await root.handle.close().catch(()=>undefined);}}
export async function assertStoredBlob(home:string,sha256:string,expectedBytes:number,lower:Partial<CapturedProfileLimitPolicy>={}):Promise<void>{const bytes=await readStoredBlob(home,sha256,lower);if(bytes.byteLength!==expectedBytes)throw invalid('stored blob size is invalid');}
async function syncDirectory(path:string):Promise<void>{const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
function digest(bytes:Uint8Array):string{return createHash('sha256').update(bytes).digest('hex');}
function invalid(detail:string):BazframeError{return new BazframeError('PROFILE_BLOB_INVALID',`Invalid profile blob: ${detail}.`);}
