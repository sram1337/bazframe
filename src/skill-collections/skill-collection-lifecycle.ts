import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import type {
  BoundedPackageProcessOptions,
  BoundedPackageProcessResult,
  ChildOutputPolicy
} from '../core/child-process.js';
import type { PackageManifestSnapshot } from '../packages/package-manifest.js';
import type { PackageLimitPolicy } from '../profile-portability/profile-portability-policy.js';
import { captureProfileCollectionReferenceIndex, sameProfileCollectionReferenceIndex, type ProfileSkillCollectionReferenceIndex } from '../profiles/profile-skill-collection-reference.js';
import { discoverSkillDirectories, profileDirectory } from '../profiles/profile-store.js';
import { assertSafeSkillId, isSafeSkillId } from '../skills/skill-id.js';
import { ensureManagedDirectory, writeFileAtomic } from '../state/atomic-file.js';
import { withStateLock } from '../state/lock.js';
import {
  prepareLibrary,
  preparePackage,
  revalidatePreparedCollectionDeclaration,
  type BeforePackageBuildContext,
  type PreparedSkillCollection
} from './skill-collection-preparation.js';
import { loadFlatSkillIdentities, resolveGlobalSkillCollection, validateProspectiveSkillCollection, type DirectSkillCollection } from './skill-collection-resolver.js';
import {
  canonicalPhysicalCollectionRoot, encodeSkillCollection, globalCollectionDirectory, globalCollectionPath,
  idForRecord, kindForRecord, readCollectionSnapshot, sameCollectionSnapshot, skillsRootForRecord,
  type LibraryRecord, type PackageRecord, type SkillCollectionKey, type SkillCollectionKind,
  type SkillCollectionRecord, type SkillCollectionRecordSnapshot
} from './skill-collection-store.js';

export interface SkillCollectionLifecycleOptions { bazframeHome: string; environment?: NodeJS.ProcessEnv; childOutputPolicy?: ChildOutputPolicy }
export interface ExpectedCollectionRootIdentity {
  root: string;
  device: bigint;
  inode: bigint;
}
export interface SkillCollectionLifecycleDependencies {
  beforeReferenceIndexRevalidation?: () => Promise<void>;
  /** Internal exact source precondition for a caller that already inspected the physical root. */
  expectedRootIdentity?: ExpectedCollectionRootIdentity;
  /** Internal deterministic substitution seam immediately before the expected-root check. */
  beforeExpectedRootIdentityCheck?: () => Promise<void>;
  /** Internal deterministic substitution seam immediately before library snapshot input capture. */
  beforeLibrarySnapshotInputCapture?: () => Promise<void>;
  /** Internal seam for a managed-provider operation already holding the global state lock. */
  stateLockHeld?: boolean;
  /** Internal managed-package cleanup after snapshot publication and before record activation. */
  afterPackageSnapshot?: () => Promise<void>;
  /** Exact remote manifest whose build was authorized before this lifecycle began. */
  expectedPackageManifest?: PackageManifestSnapshot;
  /** Adjacent authorization/source revalidation immediately before a package spawn. */
  beforePackageBuild?: (context: BeforePackageBuildContext) => void | Promise<void>;
  /** Lower-only package input/process limits for deterministic tests. */
  packageLimitPolicy?: Partial<PackageLimitPolicy>;
  /** Internal deterministic package-process seam. */
  packageProcessRunner?: (
    executable: string,
    args: readonly string[],
    options: BoundedPackageProcessOptions
  ) => Promise<BoundedPackageProcessResult>;
}
export type SkillCollectionLifecycleAction = 'added' | 'updated' | 'built' | 'removed';
export type SkillCollectionLifecycleResult = SkillCollectionRecord & { action: SkillCollectionLifecycleAction; path: string };

export function addLibrary(options:SkillCollectionLifecycleOptions,root:string,deps:SkillCollectionLifecycleDependencies={}):Promise<SkillCollectionLifecycleResult>{return add(options,'library',root,deps);}
export function addPackage(options:SkillCollectionLifecycleOptions,root:string,deps:SkillCollectionLifecycleDependencies={}):Promise<SkillCollectionLifecycleResult>{return add(options,'package',root,deps);}
export function updateLibrary(options:SkillCollectionLifecycleOptions,id:string,deps:SkillCollectionLifecycleDependencies={}):Promise<SkillCollectionLifecycleResult>{return replace(options,{kind:'library',id},deps);}
export function buildPackage(options:SkillCollectionLifecycleOptions,id:string,deps:SkillCollectionLifecycleDependencies={}):Promise<SkillCollectionLifecycleResult>{return replace(options,{kind:'package',id},deps);}
export function removeLibrary(options:SkillCollectionLifecycleOptions,id:string,deps:SkillCollectionLifecycleDependencies={}):Promise<SkillCollectionLifecycleResult>{return remove(options,{kind:'library',id},deps);}
export function removePackage(options:SkillCollectionLifecycleOptions,id:string,deps:SkillCollectionLifecycleDependencies={}):Promise<SkillCollectionLifecycleResult>{return remove(options,{kind:'package',id},deps);}

async function add(options:SkillCollectionLifecycleOptions,kind:SkillCollectionKind,root:string,deps:SkillCollectionLifecycleDependencies):Promise<SkillCollectionLifecycleResult>{
  const canonical=await canonicalPhysicalCollectionRoot(root,kind);const id=basename(canonical);assertValidId(kind,id);const key={kind,id} as SkillCollectionKey;const path=globalCollectionPath(options.bazframeHome,kind,id);
  return withGlobalLock(options,`bazframe ${kind} add`,path,async()=>{
    await deps.beforeExpectedRootIdentityCheck?.();
    const rootIdentity=await lstat(canonical,{bigint:true});
    assertExpectedRootIdentity(kind,canonical,rootIdentity.dev,rootIdentity.ino,deps.expectedRootIdentity);
    if(await optionalSnapshot(options.bazframeHome,key)!==undefined)throw occupied(kind,path,`${kind} name is already registered`);
    const prepared=await prepare(options,kind,canonical,deps);const record=makeRecord(kind,id,canonical,prepared);await validateIndependent(options.bazframeHome,record);const index=await captureValidatedIndex(options.bazframeHome,key);await validateDependents(options.bazframeHome,record,path,index);await ensureManagedDirectory(options.bazframeHome,globalCollectionDirectory(options.bazframeHome,kind));await assertIndexUnchanged(options.bazframeHome,key,index,deps);await assertRootUnchanged(canonical,kind,id,rootIdentity.dev,rootIdentity.ino);await revalidatePreparedCollectionDeclaration(canonical,prepared);if(!await createExclusive(path,encodeSkillCollection(record),options.bazframeHome,kind))throw occupied(kind,path,'became occupied during add');return result(record,path,'added');
  },deps);
}
async function replace(options:SkillCollectionLifecycleOptions,key:SkillCollectionKey,deps:SkillCollectionLifecycleDependencies):Promise<SkillCollectionLifecycleResult>{
  assertSafeSkillId(key.id);const path=globalCollectionPath(options.bazframeHome,key.kind,key.id);const verb=key.kind==='library'?'update':'build';
  return withGlobalLock(options,`bazframe ${key.kind} ${verb}`,path,async()=>{
    const initial=await requiredSnapshot(options.bazframeHome,key);const canonical=await canonicalPhysicalCollectionRoot(initial.record.root,key.kind);if(canonical!==initial.record.root||basename(canonical)!==key.id)throw occupied(key.kind,path,`${key.kind} root no longer has its recorded canonical identity`);
    const rootIdentity=await lstat(canonical,{bigint:true});assertExpectedRootIdentity(key.kind,canonical,rootIdentity.dev,rootIdentity.ino,deps.expectedRootIdentity);const prepared=await prepare(options,key.kind,canonical,deps);const candidate=makeRecord(key.kind,key.id,canonical,prepared);await validateIndependent(options.bazframeHome,candidate);const index=await captureValidatedIndex(options.bazframeHome,key);await validateDependents(options.bazframeHome,candidate,path,index);const current=await requiredSnapshot(options.bazframeHome,key);if(!sameCollectionSnapshot(initial,current))throw occupied(key.kind,path,'changed during activation');await assertIndexUnchanged(options.bazframeHome,key,index,deps);await assertRootUnchanged(canonical,key.kind,key.id,rootIdentity.dev,rootIdentity.ino);await revalidatePreparedCollectionDeclaration(canonical,prepared);await writeFileAtomic(path,encodeSkillCollection(candidate),{managedRoot:options.bazframeHome,mode:0o600,commitOnRename:true});return result(candidate,path,key.kind==='library'?'updated':'built');
  },deps);
}
async function remove(options:SkillCollectionLifecycleOptions,key:SkillCollectionKey,deps:SkillCollectionLifecycleDependencies):Promise<SkillCollectionLifecycleResult>{
  assertSafeSkillId(key.id);const path=globalCollectionPath(options.bazframeHome,key.kind,key.id);
  return withGlobalLock(options,`bazframe ${key.kind} remove`,path,async()=>{const initial=await requiredSnapshot(options.bazframeHome,key);const index=await captureValidatedIndex(options.bazframeHome,key);if(index.profileIds.length>0)throw new BazframeError('SKILL_COLLECTION_REFERENCED',`Cannot remove ${key.kind} ${key.id}; referenced by profiles: ${index.profileIds.join(', ')}`);const current=await requiredSnapshot(options.bazframeHome,key);if(!sameCollectionSnapshot(initial,current))throw occupied(key.kind,path,'changed during remove');await assertIndexUnchanged(options.bazframeHome,key,index,deps);const before=await requiredSnapshot(options.bazframeHome,key);if(!sameCollectionSnapshot(initial,before))throw occupied(key.kind,path,'changed before remove commit');await unlink(path);return result(initial.record,path,'removed');},deps);
}
async function prepare(options:SkillCollectionLifecycleOptions,kind:SkillCollectionKind,root:string,deps:SkillCollectionLifecycleDependencies):Promise<PreparedSkillCollection>{return kind==='library'?prepareLibrary(options.bazframeHome,root,{
  ...(deps.expectedRootIdentity===undefined?{}:{expectedInputRootIdentity:{canonicalPath:deps.expectedRootIdentity.root,device:deps.expectedRootIdentity.device,inode:deps.expectedRootIdentity.inode}}),
  ...(deps.beforeLibrarySnapshotInputCapture===undefined?{}:{beforeInputRootIdentityCapture:deps.beforeLibrarySnapshotInputCapture})
}):preparePackage(
  options.bazframeHome,
  root,
  options.environment,
  deps.afterPackageSnapshot,
  deps.expectedPackageManifest,
  options.childOutputPolicy,
  {
    ...(deps.beforePackageBuild===undefined?{}:{beforePackageBuild:deps.beforePackageBuild}),
    ...(deps.expectedRootIdentity===undefined?{}:{expectedRootIdentity:deps.expectedRootIdentity}),
    ...(deps.packageLimitPolicy===undefined?{}:{limitPolicy:deps.packageLimitPolicy}),
    ...(deps.packageProcessRunner===undefined?{}:{packageProcessRunner:deps.packageProcessRunner})
  }
);}
function assertExpectedRootIdentity(kind:SkillCollectionKind,root:string,device:bigint,inode:bigint,expected:ExpectedCollectionRootIdentity|undefined):void{if(expected===undefined)return;if(expected.root!==root||expected.device!==device||expected.inode!==inode)throw new BazframeError('SKILL_COLLECTION_ROOT_CHANGED',`${kind==='library'?'Library':'Package'} root does not match the caller's expected physical identity: ${root}`);}
async function assertRootUnchanged(root:string,kind:SkillCollectionKind,id:string,device:bigint,inode:bigint):Promise<void>{const [current,metadata]=await Promise.all([canonicalPhysicalCollectionRoot(root,kind),lstat(root,{bigint:true})]);if(current!==root||basename(current)!==id||metadata.dev!==device||metadata.ino!==inode)throw new BazframeError('SKILL_COLLECTION_ROOT_CHANGED',`${kind==='library'?'Library':'Package'} root changed before activation: ${root}`);}
function makeRecord(kind:SkillCollectionKind,id:string,root:string,prepared:PreparedSkillCollection):SkillCollectionRecord{if(kind==='library'){return{schemaVersion:1,library:id,root,digest:prepared.snapshot.digest} as LibraryRecord;}if(prepared.kind!=='package')throw new Error('package preparation kind mismatch');return{schemaVersion:1,package:id,root,digest:prepared.snapshot.digest,artifactRoot:prepared.artifactRoot,skillsRoot:prepared.skillsRoot} as PackageRecord;}
function direct(record:SkillCollectionRecord,path:string):DirectSkillCollection{return{schemaVersion:1,collectionKind:kindForRecord(record),collectionId:idForRecord(record),collectionRoot:record.root,snapshotDigest:record.digest,skillsRoot:skillsRootForRecord(record),descriptorPath:path,relativeDescriptorPath:`${idForRecord(record)}.json`,preparationState:'ready',rebuildAvailability:'available'};}
async function validateIndependent(home:string,record:SkillCollectionRecord):Promise<void>{const skills=await resolveGlobalSkillCollection(home,record);const names=new Set<string>();for(const skill of skills){if(names.has(skill.name))throw new BazframeError('SKILL_COLLECTION_CANDIDATE_DUPLICATE',`Candidate ${kindForRecord(record)} contains duplicate Skill name: ${skill.name}`);names.add(skill.name);}}
async function captureValidatedIndex(home:string,key:SkillCollectionKey):Promise<ProfileSkillCollectionReferenceIndex>{const index=await captureProfileCollectionReferenceIndex(home,key);if(index.diagnostics.length>0){const details=index.diagnostics.map(item=>`${item.profileId}:${item.diagnostic.key.kind}:${item.diagnostic.path}`).join(', ');throw new BazframeError('SKILL_COLLECTION_REFERENCE_INDEX_INVALID',`Cannot prove complete library/package references: ${details}`);}return index;}
async function assertIndexUnchanged(home:string,key:SkillCollectionKey,initial:ProfileSkillCollectionReferenceIndex,deps:SkillCollectionLifecycleDependencies):Promise<void>{await deps.beforeReferenceIndexRevalidation?.();const current=await captureProfileCollectionReferenceIndex(home,key);if(current.diagnostics.length>0||!sameProfileCollectionReferenceIndex(initial,current))throw new BazframeError('SKILL_COLLECTION_REFERENCE_INDEX_CHANGED','Profile library/package reference index changed during the transaction.');}
async function validateDependents(home:string,record:SkillCollectionRecord,path:string,index:ProfileSkillCollectionReferenceIndex):Promise<void>{const failures:string[]=[];for(const profileId of index.profileIds){try{const directory=profileDirectory(home,profileId);const metadata=await lstat(directory);if(metadata.isSymbolicLink()||!metadata.isDirectory())throw new Error(`Profile must be a physical directory: ${directory}`);const flat=loadFlatSkillIdentities(await discoverSkillDirectories(join(directory,'skills')));await validateProspectiveSkillCollection(directory,flat,direct(record,path));}catch(error){failures.push(`${profileId}: ${error instanceof Error?error.message:String(error)}`);}}if(failures.length>0)throw new BazframeError('SKILL_COLLECTION_DEPENDENT_INVALID',`${kindForRecord(record)} activation would invalidate referencing profiles:\n${failures.join('\n')}`);}
async function optionalSnapshot(home:string,key:SkillCollectionKey):Promise<SkillCollectionRecordSnapshot|undefined>{const path=globalCollectionPath(home,key.kind,key.id);try{return await readCollectionSnapshot(home,key);}catch(error){if(error instanceof BazframeError&&error.code==='SKILL_COLLECTION_RECORD_READ_FAILED'&&error.cause!==undefined&&errorCode(error.cause)==='ENOENT')return undefined;throw occupied(key.kind,path,error instanceof Error?error.message:String(error));}}
async function requiredSnapshot(home:string,key:SkillCollectionKey):Promise<SkillCollectionRecordSnapshot>{const value=await optionalSnapshot(home,key);if(value===undefined)throw new BazframeError('SKILL_COLLECTION_NOT_FOUND',`Global ${key.kind} does not exist: ${globalCollectionPath(home,key.kind,key.id)}`);return value;}
async function createExclusive(path:string,contents:string,home:string,kind:SkillCollectionKind):Promise<boolean>{const temporaryDirectory=join(home,'tmp',kind==='library'?'libraries':'packages');await ensureManagedDirectory(home,temporaryDirectory);const temporaryPath=join(temporaryDirectory,`${process.pid}.${randomUUID()}.${basename(path)}.tmp`);let handle:FileHandle|undefined;try{handle=await open(temporaryPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await handle.writeFile(contents,'utf8');await handle.sync();await handle.close();handle=undefined;try{await link(temporaryPath,path);return true;}catch(error){if(errorCode(error)==='EEXIST')return false;throw error;}}finally{await handle?.close().catch(()=>undefined);await unlink(temporaryPath).catch(()=>undefined);}}
function withGlobalLock<T>(options:SkillCollectionLifecycleOptions,command:string,target:string,operation:()=>Promise<T>,deps:SkillCollectionLifecycleDependencies):Promise<T>{return deps.stateLockHeld===true?operation():withStateLock(join(options.bazframeHome,'locks','state.lock'),{command,target},operation,{managedRoot:options.bazframeHome});}
function assertValidId(kind:SkillCollectionKind,id:string):void{if(!isSafeSkillId(id))throw new BazframeError('SKILL_COLLECTION_NAME_INVALID',`${kind==='library'?'Library':'Package'} directory name ${JSON.stringify(id)} is invalid. Names must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`);}
function occupied(kind:SkillCollectionKind,path:string,detail:string):BazframeError{return new BazframeError('SKILL_COLLECTION_DESTINATION_OCCUPIED',`Refusing global ${kind} at ${path}: ${detail}.`);}function result(record:SkillCollectionRecord,path:string,action:SkillCollectionLifecycleAction):SkillCollectionLifecycleResult{return{...record,action,path};}
