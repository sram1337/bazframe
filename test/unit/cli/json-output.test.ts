import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BazframeError } from '../../../src/core/errors.js';
import { errorDocument, successDocument } from '../../../src/cli/json-protocol.js';
import { runCli } from '../../../src/cli/run-cli.js';
import { ProfileExportError, type ProfileExportCommitState } from '../../../src/profile-portability/profile-export.js';
import type { ProfileImportPlan, ProfileImportPlanningResult } from '../../../src/profile-portability/profile-import-plan.js';
import {
  ProfileImportBlockedError,
  ProfileImportExecutionError,
  type ExecuteProfileImportOptions,
  type ProfileImportResult
} from '../../../src/profile-portability/profile-import.js';

const roots:string[]=[];const execFileAsync=promisify(execFile);
const importPlan:ProfileImportPlan={
 artifactPath:'/artifact',schemaVersion:1,exportedProfileId:'portable',destinationProfileId:'portable',instructions:{path:'profile/AGENTS.md',sha256:'a'.repeat(64)},
 skills:[],omittedLocalSkills:['local-only'],libraries:[],packages:[],resources:[],
 activeSelection:{state:'absent',willChange:false},composition:{status:'ready',deferredLibraries:[],knownCollectionSkillCount:0,knownCollectionSkillPreview:[]},
 exclusions:{activeSelectionWillChange:false,policyWillChange:false,collectionChildrenEnterDefault:false},profileAction:'publish',blockers:[]
};
const planning=(plan:ProfileImportPlan):ProfileImportPlanningResult=>({plan} as ProfileImportPlanningResult);
const imported=(plan:ProfileImportPlan=importPlan):ProfileImportResult=>({plan,resources:[],profileOutcome:'published',destinationPath:'/home/profiles/portable',activeSelectionChanged:false});
afterEach(async()=>{await Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true})));});
async function invoke(argv:string[], overrides:Record<string,unknown>={}){const root=await realpath(await mkdtemp(join(tmpdir(),'bazframe-json-')));roots.push(root);return invokeAt(root,argv,overrides);}
async function invokeAt(root:string,argv:string[],overrides:Record<string,unknown>={}){
 let stdout='',stderr='';
 const status=await runCli(argv,{environment:{...process.env,BAZFRAME_HOME:join(root,'home'),PI_CODING_AGENT_DIR:join(root,'pi'),NO_COLOR:'1'},userHome:root,writeStdout:(text)=>{stdout+=text;},writeStderr:(text)=>{stderr+=text;},...overrides});
 expect(stdout.endsWith('\n')).toBe(true);expect(stdout.trim().split('\n')).toHaveLength(1);
 return{status,stdout,stderr,root,document:JSON.parse(stdout) as Record<string,unknown>};
}
describe('CLI JSON protocol',()=>{
 it.each(['not-published','published','commit-ambiguous'] satisfies ProfileExportCommitState[])('preserves profile export %s commit semantics in failures',(commitState)=>{
  const outputPath=`/exports/${commitState}`;
  const error=new ProfileExportError(commitState,outputPath);
  expect(errorDocument('profile.export',error)).toEqual({
   schemaVersion:1,ok:false,command:'profile.export',
   error:{category:'operational',code:'PROFILE_EXPORT_FAILED',message:error.message,commitState,outputPath},
   diagnostics:[]
  });
 });
 it('escapes unsafe error and diagnostic characters after JSON decoding',()=>{
  const document=errorDocument('profile.export',new ProfileExportError('not-published','/exports/line\n\u001b\u0085\u202e'),[{level:'warning',code:'UNSAFE',message:'line\n\u001b\u0085\u202e'}]);
  expect(document.error.message).toContain('\\u000a\\u001b\\u0085\\u202e');
  expect(document.diagnostics[0]!.message).toBe('line\\u000a\\u001b\\u0085\\u202e');
  expect(document.error.outputPath).toBe('/exports/line\n\u001b\u0085\u202e');
  expect(successDocument('profile.export',{},[{level:'info',code:'UNSAFE',message:'a\tb'}]).diagnostics[0]!.message).toBe('a\\u0009b');
  const bounded=successDocument('profile.export',{},[{level:'warning',code:'LONG',message:'x'.repeat(2_000)}]).diagnostics[0]!.message;
  expect(Buffer.byteLength(bounded,'utf8')).toBeLessThan(1_024);
  expect(bounded).not.toContain('x'.repeat(1_000));
 });
 it('emits one schema-v1 success document',async()=>{const result=await invoke(['profile','list','--json']);expect(result).toMatchObject({status:0,stderr:'',document:{schemaVersion:1,ok:true,command:'profile.list',diagnostics:[]}});expect(result.document.result).toMatchObject({profiles:[],active:{state:'unselected'}});});
 it('projects every supported query family from structured state',async()=>{const created=await invoke(['profile','add','--json','focused']);const root=created.root;await invokeAt(root,['profile','use','--json','focused']);for(const [argv,command] of [[['profile','list','--json'],'profile.list'],[['profile','current','--json'],'profile.current'],[['skill','list','--json'],'skill.list'],[['library','list','--json'],'library.list'],[['package','list','--json'],'package.list'],[['profile','skill','list','--json'],'profile.skill.list'],[['profile','library','list','--json'],'profile.library.list'],[['profile','package','list','--json'],'profile.package.list'],[['project','list','--json'],'project.list'],[['global','show','--json'],'global.show'],[['adapter','list','--json'],'adapter.list']] as const){const result=await invokeAt(root,[...argv]);expect(result.document).toMatchObject({schemaVersion:1,ok:true,command});}const global=await invokeAt(root,['global','show','--json']);expect(global.document).toMatchObject({result:{policy:'enabled',statePath:null}});});
 it('exports a physical profile through the exact public DTO and diagnostics',async()=>{
  const created=await invoke(['profile','add','--json','portable']);const root=created.root;
  const instructions=Buffer.from('portable instructions\r\n','utf8');
  await writeFile(join(root,'home','profiles','portable','AGENTS.md'),instructions);
  const output=join(root,'exports','portable');await mkdir(join(root,'exports'));
  const result=await invokeAt(root,['profile','export','portable','--output',output,'--json']);
  expect(result).toEqual(expect.objectContaining({status:0,stderr:''}));
  expect(result.document).toEqual({
   schemaVersion:1,ok:true,command:'profile.export',result:{
    action:'published',exportedProfileId:'portable',outputPath:output,
    instructions:{path:'profile/AGENTS.md',digest:createHash('sha256').update(instructions).digest('hex')},
    skills:[],omittedLocalSkills:[],libraries:[],packages:[],resources:[]
   },
   diagnostics:[{level:'warning',code:'PROFILE_EXPORT_REVIEW_INSTRUCTIONS',message:`Review ${join(output,'profile','AGENTS.md')} before sharing the export.`}]
  });
  const text=JSON.stringify(result.document);
  for(const forbidden of ['checkout','staging','snapshot','transport','locks','environment','evidence','warnings'])expect(text).not.toContain(forbidden);
 });
 it('returns blocked dry-run plans as one successful document without streaming the plan',async()=>{
  const blocked:ProfileImportPlan={...importPlan,profileAction:'blocked',composition:{...importPlan.composition,status:'blocked'},blockers:[{code:'DESTINATION_OCCUPIED',key:'profile:portable',message:'destination is occupied'}]};
  const planProfileImport=vi.fn(async()=>planning(blocked));
  const executeProfileImport=vi.fn();
  const result=await invoke(['profile','import','artifact','--dry-run','--json'],{planProfileImport,executeProfileImport});
  expect(result).toMatchObject({status:0,stderr:'',document:{ok:true,command:'profile.import',result:{mode:'dry-run',plan:{profileAction:'blocked',blockers:[{code:'DESTINATION_OCCUPIED'}]}}}});
  expect(planProfileImport).toHaveBeenCalledOnce();expect(executeProfileImport).not.toHaveBeenCalled();
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
 });
 it('returns blocked execution plans and partial outcomes as structured import errors',async()=>{
  const blocked:ProfileImportPlan={...importPlan,profileAction:'blocked',blockers:[{code:'LATE_BLOCKER',key:'state',message:'blocked'}]};
  const blockedExecution=async(options:ExecuteProfileImportOptions):Promise<ProfileImportResult>=>{await options.reportPlan(blocked);throw new ProfileImportBlockedError(blocked);};
  const blockedResult=await invoke(['profile','import','artifact','--json'],{executeProfileImport:blockedExecution});
  expect(blockedResult).toMatchObject({status:1,stderr:'',document:{ok:false,command:'profile.import',error:{code:'PROFILE_IMPORT_BLOCKED',plan:{profileAction:'blocked',blockers:[{code:'LATE_BLOCKER'}]}},diagnostics:[]}});
  expect(blockedResult.stdout.trim().split('\n')).toHaveLength(1);

  const partial={plan:importPlan,resources:[{kind:'skill' as const,id:'review-tools',outcome:'created' as const},{kind:'library' as const,id:'toolkit',outcome:'commit-ambiguous' as const}],profileOutcome:'commit-ambiguous' as const,destinationPath:'/home/profiles/portable',activeSelectionChanged:false as const};
  const partialExecution=async(options:ExecuteProfileImportOptions):Promise<ProfileImportResult>=>{await options.reportPlan(importPlan);throw new ProfileImportExecutionError(partial,new BazframeError('MANAGED_GIT_CHANGED','resource changed\nwhile importing'));};
  const partialResult=await invoke(['profile','import','artifact','--json'],{executeProfileImport:partialExecution});
  expect(partialResult.document).toMatchObject({ok:false,command:'profile.import',error:{code:'PROFILE_IMPORT_FAILED',partialResult:{mode:'partial',resources:[{outcome:'created'},{outcome:'commit-ambiguous'}],profileOutcome:'commit-ambiguous'}},diagnostics:[{code:'PROFILE_IMPORT_PARTIAL_RESOURCES_RETAINED'},{code:'PROFILE_IMPORT_COMMIT_AMBIGUOUS'},{code:'PROFILE_IMPORT_INSPECT_DESTINATION'},{code:'PROFILE_IMPORT_FAILURE_DETAIL',message:'MANAGED_GIT_CHANGED: resource changed\\u000awhile importing'}]});
  const serialized=JSON.stringify(partialResult.document);for(const forbidden of ['cause','health','snapshot','device','inode','artifactSnapshot','resourceSnapshots'])expect(serialized).not.toContain(forbidden);
 });
 it('preserves the underlying import failure code below, at, and above the diagnostic boundary',async()=>{
  const code='MANAGED_GIT_CHANGED';const prefix=`${code}: `;const exactMessageBytes=768-Buffer.byteLength(prefix,'utf8');
  for(const delta of [-1,0,1]){
   const message='x'.repeat(exactMessageBytes+delta);
   const partial={plan:importPlan,resources:[],profileOutcome:'not-published' as const,destinationPath:'/home/profiles/portable',activeSelectionChanged:false as const};
   const executeProfileImport=async(options:ExecuteProfileImportOptions):Promise<ProfileImportResult>=>{await options.reportPlan(importPlan);throw new ProfileImportExecutionError(partial,new BazframeError(code,message));};
   const result=await invoke(['profile','import','artifact','--json'],{executeProfileImport});
   const diagnostics=(result.document.diagnostics as Array<{code:string;message:string}>);
   const detail=diagnostics.find((item)=>item.code==='PROFILE_IMPORT_FAILURE_DETAIL');
   expect(detail?.message.startsWith(prefix)).toBe(true);
   if(delta<=0){expect(detail?.message).toBe(`${prefix}${message}`);expect(Buffer.byteLength(detail!.message,'utf8')).toBe(768+delta);}
   else expect(detail?.message).toBe(`${prefix}[value omitted: escaped display exceeds 768 UTF-8 bytes]`);
  }
 });
 it('prints a blocked prose execution plan exactly once',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'bazframe-import-blocked-prose-')));roots.push(root);let stdout='',stderr='';
  const blocked:ProfileImportPlan={...importPlan,profileAction:'blocked',blockers:[{code:'BLOCKED',key:'state',message:'blocked'}]};
  const executeProfileImport=async(options:ExecuteProfileImportOptions):Promise<ProfileImportResult>=>{await options.reportPlan(blocked);throw new ProfileImportBlockedError(blocked);};
  const status=await runCli(['profile','import','artifact'],{environment:{...process.env,BAZFRAME_HOME:join(root,'home'),NO_COLOR:'1'},userHome:root,writeStdout:(text)=>{stdout+=text;},writeStderr:(text)=>{stderr+=text;},executeProfileImport});
  expect(status).toBe(1);expect(stdout.match(/Profile import plan/g)).toHaveLength(1);expect(stderr).toContain('already reported plan');expect(stderr).not.toContain('Artifact:');
 });
 it('prints the prose execution plan before lifecycle work and the final outcome afterward',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'bazframe-import-prose-')));roots.push(root);let stdout='',stderr='';let planObserved=false;
  const executeProfileImport=async(options:ExecuteProfileImportOptions):Promise<ProfileImportResult>=>{await options.reportPlan(importPlan);planObserved=stdout.includes('Profile import plan (execution inspection)');return imported();};
  const status=await runCli(['profile','import','artifact'],{environment:{...process.env,BAZFRAME_HOME:join(root,'home'),NO_COLOR:'1'},userHome:root,writeStdout:(text)=>{stdout+=text;},writeStderr:(text)=>{stderr+=text;},executeProfileImport});
  expect(status).toBe(0);expect(stderr).toBe('');expect(planObserved).toBe(true);expect(stdout.indexOf('Profile import plan')).toBeLessThan(stdout.indexOf('Profile import: completed'));
 });
 it('reports published import truth when post-execution result capture fails',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'bazframe-import-reporting-')));roots.push(root);let stdout='',stderr='';
  const executeProfileImport=async(options:ExecuteProfileImportOptions):Promise<ProfileImportResult>=>{await options.reportPlan(importPlan);return imported();};
  const status=await runCli(['profile','import','artifact'],{environment:{...process.env,BAZFRAME_HOME:join(root,'home'),NO_COLOR:'1'},userHome:root,writeStdout:(text)=>{stdout+=text;},writeStderr:(text)=>{stderr+=text;},executeProfileImport,captureResult:()=>{throw new Error('transport failure');}});
  expect(status).toBe(1);expect(stderr).toContain('Profile outcome: published');expect(stderr).toContain('Inspect the destination');expect(stdout).toContain('Profile import plan');
 });
 it('reports published when post-publication CLI result capture fails',async()=>{
  const created=await invoke(['profile','add','--json','portable']);const root=created.root;
  const output=join(root,'exports','published');await mkdir(join(root,'exports'));
  let stdout='',stderr='';
  const status=await runCli(['profile','export','portable','--output',output],{
   environment:{...process.env,BAZFRAME_HOME:join(root,'home'),PI_CODING_AGENT_DIR:join(root,'pi'),NO_COLOR:'1'},userHome:root,
   writeStdout:(text)=>{stdout+=text;},writeStderr:(text)=>{stderr+=text;},
   captureResult:()=>{throw new Error('post-publication transport failure');}
  });
  expect(status).toBe(1);expect(stdout).toBe('');
  expect(stderr).toBe(`error: The export output is published, but completion reporting failed. Output: ${output}\n`);
  await expect(stat(join(output,'bazframe-profile.json'))).resolves.toMatchObject({});
 });
 it('reports active and explicit nested mutation targets directly',async()=>{const created=await invoke(['profile','add','--json','focused']);const root=created.root;await invokeAt(root,['profile','add','--json','reviewer']);await invokeAt(root,['profile','use','--json','focused']);const source=join(root,'demo');await mkdir(source,{recursive:true});await writeFile(join(source,'SKILL.md'),'---\nname: demo\ndescription: Demo.\n---\n');await invokeAt(root,['skill','add','--json',source]);const active=await invokeAt(root,['profile','skill','add','--json','demo']);expect(active.document).toMatchObject({result:{profileTarget:{id:'focused',source:'active-selection'},skillId:'demo'}});const explicit=await invokeAt(root,['profile','skill','add','--profile=reviewer','--json','demo']);expect(explicit.document).toMatchObject({result:{profileTarget:{id:'reviewer',source:'explicit'},skillId:'demo'}});});
 it('uses stable operational codes for policy enable failures',async()=>{const global=await invoke(['global','enable','--json']);expect(global.document).toMatchObject({ok:false,error:{category:'operational',code:'PI_ADAPTER_NOT_READY'}});const root=global.root,repository=join(root,'repo');await mkdir(repository);await execFileAsync('git',['init','--quiet',repository]);const project=await invokeAt(root,['project','enable','--json'],{cwd:()=>repository});expect(project.document).toMatchObject({ok:false,error:{category:'operational',code:'PI_ADAPTER_NOT_READY'}});});
 it('maps status through the stable source DTO without internal provenance or loader fields',async()=>{const result=await invoke(['status','--json']);const text=JSON.stringify(result.document);expect(result.document).toMatchObject({result:{health:'attention',globalPolicy:{policy:'enabled',statePath:null},remoteGitSources:[],remoteGitSourceDiagnostics:[],correctiveActions:expect.any(Array)}});for(const forbidden of ['fetchUrl','transport','loaded','schemaVersion":1,"kind'])expect(text).not.toContain(forbidden);});
 it('emits usage and migration documents on stdout',async()=>{const usage=await invoke(['profile','remove','--json']);expect(usage).toMatchObject({status:2,stderr:'',document:{ok:false,error:{code:'CLI_USAGE',category:'usage'}}});const exportUsage=await invoke(['profile','export','portable','--json']);expect(exportUsage).toMatchObject({status:2,stderr:'',document:{ok:false,command:'profile.export',error:{code:'CLI_USAGE',category:'usage',topic:'profile-export'}}});const migration=await invoke(['--json','profiles']);expect(migration).toMatchObject({status:2,stderr:'',document:{ok:false,error:{code:'CLI_MIGRATION_REQUIRED',category:'migration'}}});});
 it('normalizes operational and unexpected errors',async()=>{const operational=await invoke(['profile','current','--json']);expect(operational.document).toMatchObject({ok:false,error:{category:'operational',code:'NO_ACTIVE_PROFILE'}});const cwd=vi.fn(()=>{throw new Error('secret stack detail');});const unexpected=await invoke(['project','list','--json'],{cwd});expect(unexpected.document).toMatchObject({ok:false,error:{category:'internal',code:'INTERNAL_ERROR',message:'Bazframe encountered an unexpected internal error.'}});expect(unexpected.stdout).not.toContain('secret');});
 it('keeps status attention ok with exit 3',async()=>{const result=await invoke(['status','--json']);expect(result).toMatchObject({status:3,stderr:'',document:{ok:true,command:'status',result:{health:'attention'}}});});
 it('rejects interactive JSON without launching side effects',async()=>{const launchTui=vi.fn();const result=await invoke(['tui','--json'],{launchTui});expect(result.document).toMatchObject({ok:false,error:{code:'CLI_JSON_UNSUPPORTED'}});expect(launchTui).not.toHaveBeenCalled();});
 it('requires --yes before remote Git package acquisition',async()=>{const confirmManagedGitPackageBuild=vi.fn();const result=await invoke(['package','add','git:owner/pkg','--json'],{confirmManagedGitPackageBuild});expect(result.document).toMatchObject({ok:false,error:{code:'MANAGED_GIT_BUILD_CONFIRMATION_REQUIRED'}});expect(confirmManagedGitPackageBuild).not.toHaveBeenCalled();await expect(stat(join(result.root,'home'))).rejects.toMatchObject({code:'ENOENT'});});
});
