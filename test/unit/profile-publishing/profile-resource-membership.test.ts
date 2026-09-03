import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { publishArtifactTree, type ArtifactTreeManifestV1 } from '../../../src/profile-publishing/artifact-tree.js';
import { publishStoredBlob } from '../../../src/profile-publishing/blob-store.js';
import { importedResourceIdentity, resourceIdentityDigest } from '../../../src/profile-publishing/captured-profile.js';
import { readOptionalManagedProfileState } from '../../../src/profile-publishing/managed-profile-state.js';
import { withProfileOperationLocks } from '../../../src/profile-publishing/profile-operation-lock.js';
import { mutateImportedProfileResourceMembership } from '../../../src/profile-publishing/profile-resource-membership.js';
import { projectManagedProfileRuntime } from '../../../src/profile-publishing/profile-runtime-projection.js';
import { readProfileSystemView } from '../../../src/profile-publishing/profile-view.js';
import { encodeManagedProfileState, type ImportedResourceState, type ManagedProfileStateV1 } from '../../../src/profile-publishing/publication-state.js';

let temporary:TempDirectory|undefined;
afterEach(async()=>{await temporary?.cleanup();temporary=undefined;});

async function fixture(){temporary=await createTempDirectory('/tmp/bzf-membership-');const home=temporary.path('home');await mkdir(join(home,'profiles','source'),{recursive:true});await mkdir(join(home,'profiles','target'),{recursive:true});await writeFile(join(home,'profiles','source','AGENTS.md'),'source\n');await writeFile(join(home,'profiles','target','AGENTS.md'),'target\n');return home;}
async function tree(home:string,role:'skill'|'library'|'packageArtifacts',skills:readonly string[]){
 const files:ArtifactTreeManifestV1['files']=[];const blobs:Array<{bytes:Buffer;sha:string}>=[];
 for(const name of skills){const bytes=Buffer.from(`---\nname: ${name}\ndescription: ${name}.\n---\n`);const sha=createHash('sha256').update(bytes).digest('hex');files.push({path:role==='skill'?'SKILL.md':`${name}/SKILL.md`,sha256:sha,bytes:bytes.byteLength,executable:false});blobs.push({bytes,sha});}
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return withProfileOperationLocks(home,['@store'],async(authority)=>{for(const blob of blobs)await publishStoredBlob(home,authority,blob.bytes,blob.sha);return(await publishArtifactTree(home,authority,{schemaVersion:1,kind:'bazframe-artifact-tree',role,files})).treeId;});
}
function managed(resources:ImportedResourceState[]):ManagedProfileStateV1{return{schemaVersion:1,profileInstanceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',publication:null,capturedResourceIds:resources.map((resource)=>({resourceIdentityDigest:resourceIdentityDigest(importedResourceIdentity(resource.instanceId)),capturedResourceId:resource.capturedResourceId,identityKind:'imported' as const,instanceId:resource.instanceId})).sort((a,b)=>a.resourceIdentityDigest<b.resourceIdentityDigest?-1:a.resourceIdentityDigest>b.resourceIdentityDigest?1:0),importedResources:[...resources].sort((a,b)=>a.instanceId<b.instanceId?-1:1)};}
async function seed(home:string,resources:ImportedResourceState[]){await writeFile(join(home,'profiles','source','.bazframe-profile-state.json'),encodeManagedProfileState(managed(resources),{maxManifestBytes:1024*1024,maxProfileEntries:1024,maxResources:256,maxEntries:32768,maxDepth:64,maxPathBytes:8192,maxBlobBytes:64*1024*1024,maxAggregateBytes:1536*1024*1024}));}

describe('imported profile resource membership',()=>{
 it('transactionally attaches and detaches the exact imported Skill instance while retaining its transported binding',async()=>{
  const home=await fixture();const treeId=await tree(home,'skill',['review']);const resource:ImportedResourceState={instanceId:'11111111-1111-4111-8111-111111111111',capturedResourceId:'1'.repeat(64),key:{kind:'skill',name:'review'},source:{kind:'artifact',treeId}};await seed(home,[resource]);const identity=importedResourceIdentity(resource.instanceId);
  await expect(mutateImportedProfileResourceMembership(home,'target',identity,'add')).resolves.toMatchObject({action:'added',stableIdentity:identity});
  const attached=await readOptionalManagedProfileState(home,'target');expect(attached?.state.importedResources).toEqual([resource]);expect((await projectManagedProfileRuntime(home,'target')).skills.map((skill)=>skill.name)).toEqual(['review']);
  await expect(mutateImportedProfileResourceMembership(home,'target',identity,'remove')).resolves.toMatchObject({action:'removed'});
  const detached=await readOptionalManagedProfileState(home,'target');expect(detached?.state.importedResources).toEqual([]);expect(detached?.state.capturedResourceIds).toEqual(attached?.state.capturedResourceIds);expect((await projectManagedProfileRuntime(home,'target')).skills).toEqual([]);
 });
 it('shares imported library and package instances and projects each child Skill at runtime',async()=>{
  const home=await fixture();const libraryTree=await tree(home,'library',['library-child']);const packageTree=await tree(home,'packageArtifacts',['package-child']);const resources:ImportedResourceState[]=[
   {instanceId:'11111111-1111-4111-8111-111111111111',capturedResourceId:'1'.repeat(64),key:{kind:'library',name:'shared'},source:{kind:'artifact',treeId:libraryTree}},
   {instanceId:'22222222-2222-4222-8222-222222222222',capturedResourceId:'2'.repeat(64),key:{kind:'package',name:'tools'},source:{kind:'artifact',treeId:packageTree}}
  ];await seed(home,resources);
  for(const resource of resources)await mutateImportedProfileResourceMembership(home,'target',importedResourceIdentity(resource.instanceId),'add');
  expect((await projectManagedProfileRuntime(home,'target')).skills.map((skill)=>skill.name).sort()).toEqual(['library-child','package-child']);
  expect((await readProfileSystemView(home)).skills.filter((skill)=>skill.ownerProfiles.includes('target')).map((skill)=>({name:skill.name,kind:skill.sourceKind,direct:skill.directlyAttachable})).sort((a,b)=>a.name<b.name?-1:1)).toEqual([{name:'library-child',kind:'library',direct:false},{name:'package-child',kind:'package',direct:false}]);
  const state=await readOptionalManagedProfileState(home,'target');expect(state?.state.importedResources.map((resource)=>resource.instanceId)).toEqual(resources.map((resource)=>resource.instanceId));
 });
});
