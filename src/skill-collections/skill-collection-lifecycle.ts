import { sameResourceIdentity, type ResourceRootIdentity } from './resource-identity.js';
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
import { discoverSkillDirectories } from '../profiles/profile-store.js';
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
  canonicalPhysicalCollectionRoot, encodeSkillCollection, globalCollectionPath,
  idForRecord, kindForRecord, readCollectionSnapshot, sameCollectionSnapshot, skillsRootForRecord,
  type LibraryRecord, type PackageRecord, type SkillCollectionKey, type SkillCollectionKind,
  type SkillCollectionRecord, type SkillCollectionRecordSnapshot
} from './skill-collection-store.js';

export interface SkillCollectionLifecycleOptions { bazframeHome: string; environment?: NodeJS.ProcessEnv; childOutputPolicy?: ChildOutputPolicy }
export type ExpectedCollectionRootIdentity = ResourceRootIdentity;
export interface SkillCollectionLifecycleServices {
  selectionReadServices: import('../profiles/profile-store.js').ActiveProfileReadServices;
  joinPath: typeof join;
  basename: typeof basename;
  canonicalRoot: typeof canonicalPhysicalCollectionRoot;
  rootIdentity(root: string): Promise<ResourceRootIdentity>;
  assertAuthority(): void;
  withLock<T>(home: string, command: string, target: string, operation: (services: SkillCollectionLifecycleServices) => Promise<T>): Promise<T>;
  optionalSnapshot(home: string, key: SkillCollectionKey): Promise<SkillCollectionRecordSnapshot | undefined>;
  ensureDirectory(home: string, path: string): Promise<void>;
  createExclusive(path: string, contents: string, home: string, kind: SkillCollectionKind): Promise<boolean>;
  replace(path: string, contents: string, home: string, expected: SkillCollectionRecordSnapshot): Promise<void>;
  detach(path: string, home: string, expected: import('./resource-identity.js').ResourceIdentity & { contentSha256: string }): Promise<void>;
  preparation: import('./skill-collection-preparation.js').SkillCollectionPreparationEffects;
  resolver: import('./skill-collection-resolver.js').SkillCollectionResolverEffects;
  references: import('../profiles/profile-skill-collection-reference.js').ProfileCollectionReferenceEffects;
  admitProfile(home: string, profileId: string): Promise<ResourceRootIdentity>;
  flatSkills(home: string, profileId: string): Promise<import('./skill-collection-resolver.js').FlatSkillIdentity[]>;
}
export interface SkillCollectionLifecycleDependencies {
  services?: SkillCollectionLifecycleServices;
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
  const canonical=await (deps.services?.canonicalRoot ?? canonicalPhysicalCollectionRoot)(root,kind);const id=(deps.services?.basename ?? basename)(canonical);assertValidId(kind,id);const key={kind,id} as SkillCollectionKey;const path=(deps.services?.joinPath ?? join)(options.bazframeHome,kind==='library'?'libraries':'packages',`${id}.json`);
  return withGlobalLock(options,`bazframe ${kind} add`,path,async(deps)=>{
    await deps.beforeExpectedRootIdentityCheck?.();
    const rootIdentity=await lifecycleRootIdentity(canonical,deps);
    assertExpectedRootIdentity(kind,rootIdentity,deps.expectedRootIdentity);
    if(await optionalSnapshot(options.bazframeHome,key,deps)!==undefined)throw occupied(kind,path,`${kind} name is already registered`);
    const prepared=await prepare(options,kind,canonical,{...deps,expectedRootIdentity:deps.expectedRootIdentity??rootIdentity});const record=makeRecord(kind,id,canonical,prepared);await validateIndependent(options.bazframeHome,record,deps);const index=await captureValidatedIndex(options.bazframeHome,key,deps);await validateDependents(options.bazframeHome,record,path,index,deps);await (deps.services?.ensureDirectory ?? ensureManagedDirectory)(options.bazframeHome,(deps.services?.joinPath ?? join)(options.bazframeHome,kind==='library'?'libraries':'packages'));await assertIndexUnchanged(options.bazframeHome,key,index,deps);await assertRootUnchanged(canonical,kind,id,rootIdentity,deps);await revalidatePreparedCollectionDeclaration(canonical,prepared,deps.services?.preparation);deps.services?.assertAuthority();if(!await (deps.services?.createExclusive ?? createExclusive)(path,encodeSkillCollection(record),options.bazframeHome,kind))throw occupied(kind,path,'became occupied during add');deps.services?.assertAuthority();return result(record,path,'added');
  },deps);
}
async function replace(options:SkillCollectionLifecycleOptions,key:SkillCollectionKey,deps:SkillCollectionLifecycleDependencies):Promise<SkillCollectionLifecycleResult>{
  assertSafeSkillId(key.id);const path=(deps.services?.joinPath ?? join)(options.bazframeHome,key.kind==='library'?'libraries':'packages',`${key.id}.json`);const verb=key.kind==='library'?'update':'build';
  return withGlobalLock(options,`bazframe ${key.kind} ${verb}`,path,async(deps)=>{
    const initial=await requiredSnapshot(options.bazframeHome,key,deps);const canonical=await (deps.services?.canonicalRoot ?? canonicalPhysicalCollectionRoot)(initial.record.root,key.kind);if(canonical!==initial.record.root||(deps.services?.basename ?? basename)(canonical)!==key.id)throw occupied(key.kind,path,`${key.kind} root no longer has its recorded canonical identity`);
    const rootIdentity=await lifecycleRootIdentity(canonical,deps);assertExpectedRootIdentity(key.kind,rootIdentity,deps.expectedRootIdentity);const prepared=await prepare(options,key.kind,canonical,{...deps,expectedRootIdentity:deps.expectedRootIdentity??rootIdentity});const candidate=makeRecord(key.kind,key.id,canonical,prepared);await validateIndependent(options.bazframeHome,candidate,deps);const index=await captureValidatedIndex(options.bazframeHome,key,deps);await validateDependents(options.bazframeHome,candidate,path,index,deps);const current=await requiredSnapshot(options.bazframeHome,key,deps);if(!sameCollectionSnapshot(initial,current))throw occupied(key.kind,path,'changed during activation');await assertIndexUnchanged(options.bazframeHome,key,index,deps);await assertRootUnchanged(canonical,key.kind,key.id,rootIdentity,deps);await revalidatePreparedCollectionDeclaration(canonical,prepared,deps.services?.preparation);deps.services?.assertAuthority();if(deps.services!==undefined)await deps.services.replace(path,encodeSkillCollection(candidate),options.bazframeHome,initial);else await writeFileAtomic(path,encodeSkillCollection(candidate),{managedRoot:options.bazframeHome,mode:0o600,commitOnRename:true});deps.services?.assertAuthority();return result(candidate,path,key.kind==='library'?'updated':'built');
  },deps);
}
async function remove(options:SkillCollectionLifecycleOptions,key:SkillCollectionKey,deps:SkillCollectionLifecycleDependencies):Promise<SkillCollectionLifecycleResult>{
  assertSafeSkillId(key.id);const path=(deps.services?.joinPath ?? join)(options.bazframeHome,key.kind==='library'?'libraries':'packages',`${key.id}.json`);
  return withGlobalLock(options,`bazframe ${key.kind} remove`,path,async(deps)=>{const initial=await requiredSnapshot(options.bazframeHome,key,deps);const index=await captureValidatedIndex(options.bazframeHome,key,deps);if(index.profileIds.length>0)throw new BazframeError('SKILL_COLLECTION_REFERENCED',`Cannot remove ${key.kind} ${key.id}; referenced by profiles: ${index.profileIds.join(', ')}`);const current=await requiredSnapshot(options.bazframeHome,key,deps);if(!sameCollectionSnapshot(initial,current))throw occupied(key.kind,path,'changed during remove');await assertIndexUnchanged(options.bazframeHome,key,index,deps);const before=await requiredSnapshot(options.bazframeHome,key,deps);if(!sameCollectionSnapshot(initial,before))throw occupied(key.kind,path,'changed before remove commit');deps.services?.assertAuthority();if(deps.services!==undefined)await deps.services.detach(path,options.bazframeHome,initial);else await unlink(path);deps.services?.assertAuthority();return result(initial.record,path,'removed');},deps);
}
async function prepare(options:SkillCollectionLifecycleOptions,kind:SkillCollectionKind,root:string,deps:SkillCollectionLifecycleDependencies):Promise<PreparedSkillCollection>{return kind==='library'?prepareLibrary(options.bazframeHome,root,{
  ...(deps.expectedRootIdentity?.domain==='windows'?{expectedInputResourceIdentity:deps.expectedRootIdentity}:{}),
  ...(deps.expectedRootIdentity===undefined||deps.expectedRootIdentity.domain==='windows'?{}:{expectedInputRootIdentity:{canonicalPath:deps.expectedRootIdentity.root,device:deps.expectedRootIdentity.device,inode:deps.expectedRootIdentity.inode}}),
  ...(deps.beforeLibrarySnapshotInputCapture===undefined?{}:{beforeInputRootIdentityCapture:deps.beforeLibrarySnapshotInputCapture})
},deps.services?.preparation):preparePackage(
  options.bazframeHome,
  root,
  options.environment,
  deps.afterPackageSnapshot,
  deps.expectedPackageManifest,
  options.childOutputPolicy,
  {
    ...(deps.services===undefined?{}:{effects:deps.services.preparation}),
    ...(deps.beforePackageBuild===undefined?{}:{beforePackageBuild:deps.beforePackageBuild}),
    ...(deps.expectedRootIdentity===undefined?{}:{expectedRootIdentity:deps.expectedRootIdentity}),
    ...(deps.packageLimitPolicy===undefined?{}:{limitPolicy:deps.packageLimitPolicy}),
    ...(deps.packageProcessRunner===undefined?{}:{packageProcessRunner:deps.packageProcessRunner})
  }
);}
async function lifecycleRootIdentity(root:string,deps:SkillCollectionLifecycleDependencies):Promise<ResourceRootIdentity>{if(deps.services!==undefined)return deps.services.rootIdentity(root);const stat=await lstat(root,{bigint:true});return{root,device:stat.dev,inode:stat.ino};}
function assertExpectedRootIdentity(kind:SkillCollectionKind,current:ResourceRootIdentity,expected:ExpectedCollectionRootIdentity|undefined):void{if(expected!==undefined&&(expected.root!==current.root||!sameResourceIdentity(current,expected)))throw new BazframeError('SKILL_COLLECTION_ROOT_CHANGED',`${kind} root does not match the caller's expected physical identity: ${current.root}`);}
async function assertRootUnchanged(root:string,kind:SkillCollectionKind,id:string,expected:ResourceRootIdentity,deps:SkillCollectionLifecycleDependencies):Promise<void>{const current=await (deps.services?.canonicalRoot??canonicalPhysicalCollectionRoot)(root,kind);const identity=await lifecycleRootIdentity(root,deps);if(current!==root||(deps.services?.basename??basename)(current)!==id||!sameResourceIdentity(expected,identity))throw new BazframeError('SKILL_COLLECTION_ROOT_CHANGED',`${kind} root changed before activation: ${root}`);}
function makeRecord(kind:SkillCollectionKind,id:string,root:string,prepared:PreparedSkillCollection):SkillCollectionRecord{if(kind==='library'){return{schemaVersion:1,library:id,root,digest:prepared.snapshot.digest} as LibraryRecord;}if(prepared.kind!=='package')throw new Error('package preparation kind mismatch');return{schemaVersion:1,package:id,root,digest:prepared.snapshot.digest,artifactRoot:prepared.artifactRoot,skillsRoot:prepared.skillsRoot} as PackageRecord;}
function direct(record:SkillCollectionRecord,path:string):DirectSkillCollection{return{schemaVersion:1,collectionKind:kindForRecord(record),collectionId:idForRecord(record),collectionRoot:record.root,snapshotDigest:record.digest,skillsRoot:skillsRootForRecord(record),descriptorPath:path,relativeDescriptorPath:`${idForRecord(record)}.json`,preparationState:'ready',rebuildAvailability:'available'};}
async function validateIndependent(home:string,record:SkillCollectionRecord,deps:SkillCollectionLifecycleDependencies):Promise<void>{const skills=await resolveGlobalSkillCollection(home,record,undefined,deps.services?.resolver);const names=new Set<string>();for(const skill of skills){if(names.has(skill.name))throw new BazframeError('SKILL_COLLECTION_CANDIDATE_DUPLICATE',`Candidate ${kindForRecord(record)} contains duplicate Skill name: ${skill.name}`);names.add(skill.name);}}
async function captureValidatedIndex(home:string,key:SkillCollectionKey,deps:SkillCollectionLifecycleDependencies):Promise<ProfileSkillCollectionReferenceIndex>{const index=await captureProfileCollectionReferenceIndex(home,key,deps.services?.references);if(index.diagnostics.length>0){const details=index.diagnostics.map(item=>`${item.profileId}:${item.diagnostic.key.kind}:${item.diagnostic.path}`).join(', ');throw new BazframeError('SKILL_COLLECTION_REFERENCE_INDEX_INVALID',`Cannot prove complete library/package references: ${details}`);}return index;}
async function assertIndexUnchanged(home:string,key:SkillCollectionKey,initial:ProfileSkillCollectionReferenceIndex,deps:SkillCollectionLifecycleDependencies):Promise<void>{await deps.beforeReferenceIndexRevalidation?.();const current=await captureProfileCollectionReferenceIndex(home,key,deps.services?.references);if(current.diagnostics.length>0||!sameProfileCollectionReferenceIndex(initial,current))throw new BazframeError('SKILL_COLLECTION_REFERENCE_INDEX_CHANGED','Profile library/package reference index changed during the transaction.');}
async function validateDependents(home:string,record:SkillCollectionRecord,path:string,index:ProfileSkillCollectionReferenceIndex,deps:SkillCollectionLifecycleDependencies):Promise<void>{const failures:string[]=[];for(const profileId of index.profileIds){try{const directory=(deps.services?.joinPath??join)(home,'profiles',profileId);let flat;if(deps.services!==undefined)flat=await deps.services.flatSkills(home,profileId);else{const metadata=await lstat(directory);if(metadata.isSymbolicLink()||!metadata.isDirectory())throw new Error(`Profile must be a physical directory: ${directory}`);flat=loadFlatSkillIdentities(await discoverSkillDirectories(join(directory,'skills')));}await validateProspectiveSkillCollection(directory,flat,direct(record,path),undefined,deps.services?.resolver);}catch(error){failures.push(`${profileId}: ${error instanceof Error?error.message:String(error)}`);}}if(failures.length>0)throw new BazframeError('SKILL_COLLECTION_DEPENDENT_INVALID',`${kindForRecord(record)} activation would invalidate referencing profiles:\n${failures.join('\n')}`);}
async function optionalSnapshot(home:string,key:SkillCollectionKey,deps:SkillCollectionLifecycleDependencies):Promise<SkillCollectionRecordSnapshot|undefined>{const path=(deps.services?.joinPath??join)(home,key.kind==='library'?'libraries':'packages',`${key.id}.json`);try{return deps.services===undefined?await readCollectionSnapshot(home,key):await deps.services.optionalSnapshot(home,key);}catch(error){if(error instanceof BazframeError&&error.code==='SKILL_COLLECTION_RECORD_READ_FAILED'&&error.cause!==undefined&&errorCode(error.cause)==='ENOENT')return undefined;throw occupied(key.kind,path,error instanceof Error?error.message:String(error));}}
async function requiredSnapshot(home:string,key:SkillCollectionKey,deps:SkillCollectionLifecycleDependencies):Promise<SkillCollectionRecordSnapshot>{const value=await optionalSnapshot(home,key,deps);if(value===undefined)throw new BazframeError('SKILL_COLLECTION_NOT_FOUND',`Global ${key.kind} does not exist: ${globalCollectionPath(home,key.kind,key.id)}`);return value;}
async function createExclusive(path:string,contents:string,home:string,kind:SkillCollectionKind):Promise<boolean>{const temporaryDirectory=join(home,'tmp',kind==='library'?'libraries':'packages');await ensureManagedDirectory(home,temporaryDirectory);const temporaryPath=join(temporaryDirectory,`${process.pid}.${randomUUID()}.${basename(path)}.tmp`);let handle:FileHandle|undefined;try{handle=await open(temporaryPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await handle.writeFile(contents,'utf8');await handle.sync();await handle.close();handle=undefined;try{await link(temporaryPath,path);return true;}catch(error){if(errorCode(error)==='EEXIST')return false;throw error;}}finally{await handle?.close().catch(()=>undefined);await unlink(temporaryPath).catch(()=>undefined);}}
function withGlobalLock<T>(options:SkillCollectionLifecycleOptions,command:string,target:string,operation:(deps:SkillCollectionLifecycleDependencies)=>Promise<T>,deps:SkillCollectionLifecycleDependencies):Promise<T>{if(deps.services!==undefined)return deps.services.withLock(options.bazframeHome,command,target,(services)=>operation({...deps,services}));return deps.stateLockHeld===true?operation(deps):withStateLock(join(options.bazframeHome,'locks','state.lock'),{command,target},()=>operation(deps),{managedRoot:options.bazframeHome});}
function assertValidId(kind:SkillCollectionKind,id:string):void{if(!isSafeSkillId(id))throw new BazframeError('SKILL_COLLECTION_NAME_INVALID',`${kind==='library'?'Library':'Package'} directory name ${JSON.stringify(id)} is invalid. Names must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`);}
function occupied(kind:SkillCollectionKind,path:string,detail:string):BazframeError{return new BazframeError('SKILL_COLLECTION_DESTINATION_OCCUPIED',`Refusing global ${kind} at ${path}: ${detail}.`);}function result(record:SkillCollectionRecord,path:string,action:SkillCollectionLifecycleAction):SkillCollectionLifecycleResult{return{...record,action,path};}
