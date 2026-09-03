import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorDocument, successDocument } from '../../../src/cli/json-protocol.js';
import { BazframeError } from '../../../src/core/errors.js';
import { runCli } from '../../../src/cli/run-cli.js';
import { ProfileExportError, type ProfileExportCommitState } from '../../../src/profile-portability/profile-export.js';
const roots:string[]=[];const execFileAsync=promisify(execFile);
afterEach(async()=>{await Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true})));});
async function invoke(argv:string[], overrides:Record<string,unknown>={}){const root=await realpath(await mkdtemp(process.platform==='darwin'?'/tmp/bzfj-':join(tmpdir(),'bazframe-json-')));roots.push(root);return invokeAt(root,argv,overrides);}
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
 it('fails closed instead of projecting malformed managed profile state as healthy legacy output',async()=>{const created=await invoke(['profile','add','--json','focused']);const root=created.root;await invokeAt(root,['profile','use','focused','--json']);await writeFile(join(root,'home','profiles','focused','.bazframe-profile-state.json'),'{}\n');const listed=await invokeAt(root,['profile','list','--json']);expect(listed).toMatchObject({status:1,document:{ok:false,error:{code:'PROFILE_PUBLICATION_STATE_INVALID'}}});const status=await invokeAt(root,['status','--json']);expect(status).toMatchObject({status:1,document:{ok:false,error:{code:'PROFILE_PUBLICATION_STATE_INVALID'}}});});
 it('projects every supported query family from structured state',async()=>{const created=await invoke(['profile','add','--json','focused']);const root=created.root;await invokeAt(root,['profile','use','--json','focused']);for(const [argv,command] of [[['profile','list','--json'],'profile.list'],[['profile','current','--json'],'profile.current'],[['skill','list','--json'],'skill.list'],[['library','list','--json'],'library.list'],[['package','list','--json'],'package.list'],[['profile','skill','list','--json'],'profile.skill.list'],[['profile','library','list','--json'],'profile.library.list'],[['profile','package','list','--json'],'profile.package.list'],[['project','list','--json'],'project.list'],[['global','show','--json'],'global.show'],[['adapter','list','--json'],'adapter.list']] as const){const result=await invokeAt(root,[...argv]);expect(result.document).toMatchObject({schemaVersion:1,ok:true,command});}const global=await invokeAt(root,['global','show','--json']);expect(global.document).toMatchObject({result:{policy:'enabled',statePath:null}});});
 it('exports a physical profile through schema v2 without publication ownership leakage',async()=>{
  const created=await invoke(['profile','add','--json','portable']);const root=created.root;
  await writeFile(join(root,'home','profiles','portable','AGENTS.md'),'portable instructions\n');
  const output=join(root,'portable.zip');
  const result=await invokeAt(root,['profile','export','--profile','portable','--output',output,'--json'],{profileLifecycle:{}});
  expect(result).toMatchObject({status:0,stderr:'',document:{schemaVersion:2,command:'profile.export',outcome:'success',result:{profile:{name:'portable'},output,captureSha256:expect.stringMatching(/^[a-f0-9]{64}$/),overwritten:false}}});
  expect(await stat(output)).toMatchObject({});
  const serialized=JSON.stringify(result.document);expect(serialized).not.toContain('profileInstanceId');expect(serialized).not.toContain('publicationState');
 });
 it('imports the replacement ZIP through schema v2 and reports authoritative effects',async()=>{
  const created=await invoke(['profile','add','--json','portable']);const root=created.root;const output=join(root,'portable.zip');
  await invokeAt(root,['profile','export','--profile','portable','--output',output,'--json'],{profileLifecycle:{}});
  const result=await invokeAt(root,['profile','import',output,'--yes','--json'],{profileLifecycle:{}});
  expect(result).toMatchObject({status:0,stderr:'',document:{schemaVersion:2,command:'profile.import',outcome:'success',result:{mode:'executed',source:{kind:'zip'},requestedName:'portable',resolvedName:'portable-1',collisionResolution:'safe-suffix',profile:{name:'portable-1'},effects:{profilePublished:true,loginStarted:false,repositoryCreated:false,refUpdated:false}}}});
  expect(JSON.stringify(result.document)).not.toContain(output);
 });
 it('returns a mutation-free schema-v2 dry-run document',async()=>{
  const created=await invoke(['profile','add','--json','portable']);const root=created.root;const output=join(root,'portable.zip');
  await invokeAt(root,['profile','export','--profile','portable','--output',output,'--json'],{profileLifecycle:{}});
  const result=await invokeAt(root,['profile','import',output,'--dry-run','--json'],{profileLifecycle:{}});
  expect(result).toMatchObject({status:0,stderr:'',document:{schemaVersion:2,command:'profile.import',outcome:'success',result:{mode:'dry-run',requestedName:'portable',resolvedName:'portable',collisionResolution:'none',profile:null,effects:{profilePublished:false,cacheWritten:false,buildExecuted:false,loginStarted:false,repositoryCreated:false,refUpdated:false}}}});
 });
 it('returns a bounded schema-v2 collision refusal with an actionable plan',async()=>{
  const created=await invoke(['profile','add','--json','portable']);const root=created.root;const output=join(root,'portable.zip');
  await invokeAt(root,['profile','export','--profile','portable','--output',output,'--json'],{profileLifecycle:{}});
  const result=await invokeAt(root,['profile','import',output,'--json'],{profileLifecycle:{}});
  expect(result).toMatchObject({status:2,stderr:'',document:{schemaVersion:2,command:'profile.import',outcome:'refusal',refusal:{code:'PROFILE_IMPORT_COLLISION_DECISION_REQUIRED',interaction:{kind:'collision-choice-required',suggestedName:'portable-1',safeDefaultAcceptedBy:'--yes',replacementAcceptedBy:'--overwrite'}}}});
 });
 it('treats interactive import cancellation as a bounded exit-2 refusal in human and JSON modes',async()=>{
  const created=await invoke(['profile','add','--json','portable']);const root=created.root;const output=join(root,'portable.zip');
  await invokeAt(root,['profile','export','--profile','portable','--output',output,'--json'],{profileLifecycle:{}});
  let stdout='',stderr='';
  const status=await runCli(['profile','import',output],{
   environment:{...process.env,BAZFRAME_HOME:join(root,'home'),PI_CODING_AGENT_DIR:join(root,'pi'),NO_COLOR:'1'},userHome:root,
   stdinIsTty:true,stdoutIsTty:true,profileLifecycle:{},chooseProfileImportCollision:async()=> 'cancel' as const,
   writeStdout:(text)=>{stdout+=text;},writeStderr:(text)=>{stderr+=text;}
  });
  expect(status).toBe(2);expect(stdout).toBe('');expect(stderr).toBe('error: Profile import was cancelled.\n');expect(Buffer.byteLength(stderr,'utf8')).toBeLessThan(1_024);
  const json=await invokeAt(root,['profile','import',output,'--json'],{profileLifecycle:{},chooseProfileImportCollision:async()=> 'cancel' as const});
  expect(json).toMatchObject({status:2,stderr:'',document:{schemaVersion:2,command:'profile.import',outcome:'refusal',refusal:{code:'PROFILE_IMPORT_CANCELLED',message:'Profile import was cancelled.',interaction:{kind:'none'}},diagnostics:[]}});
  expect(Buffer.byteLength(json.stdout,'utf8')).toBeLessThan(1_024);await expect(stat(join(root,'home','profiles','portable-1'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it.each([
  [['profile','export','portable','--json'],'profile.export'],
  [['profile','publish','extra','--json'],'profile.publish'],
  [['profile','import','archive.zip','--commit','abc','--json'],'profile.import'],
  [['profile','update','portable','--json'],'profile.update'],
  [['profile','version','list','extra','--json'],'profile.version.list'],
  [['profile','version','use','not-hex','--json'],'profile.version.use']
 ] as const)('emits schema-v2 usage for %j',async(argv,command)=>{const result=await invoke([...argv]);expect(result).toMatchObject({status:2,stderr:'',document:{schemaVersion:2,command,outcome:'error',error:{category:'usage',code:'CLI_USAGE'},diagnostics:[]}});});
 it('refuses JSON publication without --yes before runtime, login, or home mutation',async()=>{const profileRuntime=vi.fn();const result=await invoke(['profile','publish','--public','--json'],{profileRuntime});expect(result).toMatchObject({status:2,stderr:'',document:{schemaVersion:2,command:'profile.publish',outcome:'refusal',refusal:{code:'PROFILE_PUBLISH_CONFIRMATION_REQUIRED',interaction:{confirmations:['publish-preview','public-visibility'],acceptedBy:'--yes'}}}});expect(profileRuntime).not.toHaveBeenCalled();await expect(stat(join(result.root,'home'))).rejects.toMatchObject({code:'ENOENT'});});
 it('keeps unrelated commands on schema v1',async()=>{
  const created=await invoke(['profile','add','--json','focused']);const root=created.root;
  const result=await invokeAt(root,['profile','use','--json','focused']);expect(result.document).toMatchObject({schemaVersion:1,ok:true,command:'profile.use'});
  const listing=await invokeAt(root,['profile','list','--json']);expect(listing.document).toMatchObject({schemaVersion:1,ok:true,command:'profile.list',result:{profiles:[{id:'focused',active:true}]}});
 });
 it('reports active and explicit nested mutation targets directly',async()=>{const created=await invoke(['profile','add','--json','focused']);const root=created.root;await invokeAt(root,['profile','add','--json','reviewer']);await invokeAt(root,['profile','use','--json','focused']);const source=join(root,'demo');await mkdir(source,{recursive:true});await writeFile(join(source,'SKILL.md'),'---\nname: demo\ndescription: Demo.\n---\n');await invokeAt(root,['skill','add','--json',source]);const active=await invokeAt(root,['profile','skill','add','--json','demo']);expect(active.document).toMatchObject({result:{profileTarget:{id:'focused',source:'active-selection'},skillId:'demo'}});const explicit=await invokeAt(root,['profile','skill','add','--profile=reviewer','--json','demo']);expect(explicit.document).toMatchObject({result:{profileTarget:{id:'reviewer',source:'explicit'},skillId:'demo'}});});
 it('uses stable operational codes for policy enable failures',async()=>{const global=await invoke(['global','enable','--json']);expect(global.document).toMatchObject({ok:false,error:{category:'operational',code:'PI_ADAPTER_NOT_READY'}});const root=global.root,repository=join(root,'repo');await mkdir(repository);await execFileAsync('git',['init','--quiet',repository]);const project=await invokeAt(root,['project','enable','--json'],{cwd:()=>repository});expect(project.document).toMatchObject({ok:false,error:{category:'operational',code:'PI_ADAPTER_NOT_READY'}});});
 it('maps status through the stable source DTO without internal provenance or loader fields',async()=>{const result=await invoke(['status','--json']);const text=JSON.stringify(result.document);expect(result.document).toMatchObject({result:{health:'attention',globalPolicy:{policy:'enabled',statePath:null},remoteGitSources:[],remoteGitSourceDiagnostics:[],correctiveActions:expect.any(Array)}});for(const forbidden of ['fetchUrl','transport','loaded','schemaVersion":1,"kind'])expect(text).not.toContain(forbidden);});
 it.each([
  ['PROFILE_OPERATION_LOCK_BUSY','PROFILE_OPERATION_LOCK_BUSY','operational'],
  ['PROFILE_TRANSACTION_CROSS_DEVICE','PROFILE_TRANSACTION_CROSS_DEVICE','operational'],
  ['PROFILE_GITHUB_CREATION_PROOF_REQUIRED','PROFILE_GITHUB_CREATION_PROOF_REQUIRED','integrity'],
  ['UNREVIEWED_PRIVATE_CODE','PROFILE_INTERNAL_ERROR','internal']
 ] as const)('always emits one safe schema-v2 document for lifecycle failure %s',async(rawCode,publicCode,category)=>{
  const result=await invoke(['profile','import','missing.zip','--json'],{profileLifecycle:{readZip:async()=>{throw new BazframeError(rawCode,`failure at /private/tmp/HIGH_RISK_HOME token=HIGH_RISK_TOKEN\u001b[31m`);}}});
  expect(result.status).toBe(1);expect(result.stdout.trim().split('\n')).toHaveLength(1);expect(result.document).toMatchObject({schemaVersion:2,outcome:'error',error:{code:publicCode,category}});expect(result.stdout).not.toMatch(/HIGH_RISK_HOME|HIGH_RISK_TOKEN/u);expect(result.stdout).not.toContain('\u001b[31m');
 });
 it('redacts private managed paths and controls from human lifecycle errors',async()=>{
  const root=await realpath(await mkdtemp(process.platform==='darwin'?'/tmp/bzfh-':join(tmpdir(),'bzfh-')));roots.push(root);const secretHome=join(root,'secret-home-HIGH_RISK');let stdout='',stderr='';
  const status=await runCli(['profile','export','--profile','absent'],{environment:{...process.env,BAZFRAME_HOME:secretHome,NO_COLOR:'1'},userHome:root,writeStdout:(text)=>stdout+=text,writeStderr:(text)=>stderr+=text});
  expect(status).toBe(1);expect(stdout).toBe('');expect(stderr).not.toContain(secretHome);expect(stderr).not.toContain('HIGH_RISK');expect(stderr).not.toContain('\u001b');
 });
 it('emits usage and migration documents on stdout',async()=>{const usage=await invoke(['profile','remove','--json']);expect(usage).toMatchObject({status:2,stderr:'',document:{ok:false,error:{code:'CLI_USAGE',category:'usage'}}});const exportUsage=await invoke(['profile','export','portable','--json']);expect(exportUsage).toMatchObject({status:2,stderr:'',document:{schemaVersion:2,command:'profile.export',outcome:'error',error:{code:'CLI_USAGE',category:'usage'}}});const migration=await invoke(['--json','profiles']);expect(migration).toMatchObject({status:2,stderr:'',document:{ok:false,error:{code:'CLI_MIGRATION_REQUIRED',category:'migration'}}});});
 it('normalizes operational and unexpected errors',async()=>{const operational=await invoke(['profile','current','--json']);expect(operational.document).toMatchObject({ok:false,error:{category:'operational',code:'NO_ACTIVE_PROFILE'}});const cwd=vi.fn(()=>{throw new Error('secret stack detail');});const unexpected=await invoke(['project','list','--json'],{cwd});expect(unexpected.document).toMatchObject({ok:false,error:{category:'internal',code:'INTERNAL_ERROR',message:'Bazframe encountered an unexpected internal error.'}});expect(unexpected.stdout).not.toContain('secret');});
 it('keeps status attention ok with exit 3',async()=>{const result=await invoke(['status','--json']);expect(result).toMatchObject({status:3,stderr:'',document:{ok:true,command:'status',result:{health:'attention'}}});});
 it('rejects interactive JSON without launching side effects',async()=>{const launchTui=vi.fn();const result=await invoke(['tui','--json'],{launchTui});expect(result.document).toMatchObject({ok:false,error:{code:'CLI_JSON_UNSUPPORTED'}});expect(launchTui).not.toHaveBeenCalled();});
 it('requires --yes before remote Git package acquisition',async()=>{const confirmManagedGitPackageBuild=vi.fn();const result=await invoke(['package','add','git:owner/pkg','--json'],{confirmManagedGitPackageBuild});expect(result.document).toMatchObject({ok:false,error:{code:'MANAGED_GIT_BUILD_CONFIRMATION_REQUIRED'}});expect(confirmManagedGitPackageBuild).not.toHaveBeenCalled();await expect(stat(join(result.root,'home'))).rejects.toMatchObject({code:'ENOENT'});});
});
