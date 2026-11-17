import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDirectory } from '../../helpers/temp-directory.js';

const helper = join(process.cwd(), 'scripts', 'installed-candidate.mjs');
const batches = join(process.cwd(), 'scripts', 'test-pack-candidate.mjs');
const entrypoint = join(process.cwd(), 'scripts', 'test-pack.mjs');

// Test unchanged ESM script bytes in Node, without building, installing or
// launching Bazframe. Synthetic tar members exercise admission only.
const fixture = `
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import * as h from ${JSON.stringify(helper)};
import * as batches from ${JSON.stringify(batches)};
const root = fs.realpathSync(process.argv[1]);
const native = Buffer.from('synthetic native admission bytes');
const members = {
  'package.json': Buffer.from(JSON.stringify({name:'bazframe',version:'fixture',bin:{bazframe:'dist/cli.js',bzf:'dist/cli.js'}})),
  'dist/cli.js': Buffer.from('fixture CLI bytes, never executed'),
  'artifacts/native/win32-x64-msvc/bazframe-win32.node': native
};
function tar(entries=members) {
  const blocks=[];
  for(const [name, bytes] of Object.entries(entries)) {
    const header=Buffer.alloc(512); header.write('package/'+name);
    const octal=(offset,size,value)=>header.write(value.toString(8).padStart(size-1,'0')+'\\0',offset,size);
    octal(100,8,0o644);octal(124,12,bytes.length);header[156]=48;header.write('ustar\\0',257);
    header.fill(32,148,156);octal(148,8,[...header].reduce((a,b)=>a+b,0));
    blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
const archive=join(root,'candidate.tgz');fs.writeFileSync(archive,tar());
const digest=h.sha256(fs.readFileSync(archive));
const nativeDigest=h.sha256(native);
const options=['--candidate',archive,'--sha256',digest,'--native-sha256',nativeDigest,'--source','a'.repeat(40),'--root',join(root,'new-root'),'--install','local','--alias','both','--batch','all','--npm-cli',join(root,'npm-cli.js'),'--ownership-record',join(root,'scope.json')];
`;

async function probe(code: string) {
  const directory = await createTempDirectory('candidate seams ');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', fixture + code, directory.path()], { encoding: 'utf8', shell: false });
    expect(result.stderr, result.stdout).toBe('');
    expect(result.status, result.stderr).toBe(0);
  } finally { await directory.cleanup(); }
}

describe('exact installed candidate seams', () => {
  it('admits exact tar/native bytes and rejects changed digest, native and metadata', async () => probe(`
    const candidate=h.admitCandidate(archive,digest,nativeDigest);assert.equal(candidate.members.size,3);
    assert.throws(()=>h.admitCandidate(archive,'0'.repeat(64),nativeDigest),/digest mismatch/);
    assert.throws(()=>h.admitCandidate(archive,digest,'0'.repeat(64)),/Native candidate/);
    const wrong=tar({...members,'package.json':Buffer.from(JSON.stringify({name:'not-bazframe'}))});fs.writeFileSync(archive,wrong);
    assert.throws(()=>h.admitCandidate(archive,h.sha256(wrong),nativeDigest));
  `));

  it('rejects unsafe tar paths and corrupt checksums without extracting', async () => probe(`
    const wrong=tar({...members,'../escape':Buffer.from('bad')});fs.writeFileSync(archive,wrong);
    assert.throws(()=>h.admitCandidate(archive,h.sha256(wrong),nativeDigest),/Unsafe package member/);
    assert(!fs.existsSync(join(root,'escape')));
    const corrupt=gunzipSync(tar());corrupt[10]^=1;const corruptZip=gzipSync(corrupt);fs.writeFileSync(archive,corruptZip);
    assert.throws(()=>h.admitCandidate(archive,h.sha256(corruptZip),nativeDigest),/Tar checksum mismatch/);
  `));

  it('requires exact physical installed file set and bytes, not source or dist substitution', async () => probe(`
    const candidate=h.admitCandidate(archive,digest,nativeDigest), installed=join(root,'installed');
    for(const [name,bytes] of Object.entries(members)){const p=join(installed,name);fs.mkdirSync(dirname(p),{recursive:true});fs.writeFileSync(p,bytes)}
    h.verifyInstalled(installed,candidate);
    fs.writeFileSync(join(installed,'dist/cli.js'),'wrong');assert.throws(()=>h.verifyInstalled(installed,candidate),/Installed bytes differ/);
    fs.writeFileSync(join(installed,'dist/cli.js'),members['dist/cli.js']);fs.writeFileSync(join(installed,'unexpected'),'extra');
    assert.throws(()=>h.verifyInstalled(installed,candidate),/member set differs/);
  `));

  it('requires an unoccupied canonical root and never reclaims existing evidence', async () => probe(`
    const fresh=join(root,'fresh');h.createFreshRoot(fresh);fs.writeFileSync(join(fresh,'retained'),'original');
    assert.throws(()=>h.createFreshRoot(fresh),/EEXIST/);assert.equal(fs.readFileSync(join(fresh,'retained'),'utf8'),'original');
  `));

  it('validates complete explicit options and refuses unknown, repeated and unsafe selectors', async () => probe(`
    assert.equal(h.parseCandidateOptions(options).alias,'both');
    assert.throws(()=>h.parseCandidateOptions([...options,'--pack','yes']));
    assert.throws(()=>h.parseCandidateOptions([...options,'--alias','bzf']));
    assert.throws(()=>h.parseCandidateOptions(options.map(x=>x==='all'?'arbitrary-command':x)));
    assert.throws(()=>h.parseCandidateOptions(options.slice(0,-2)));
    assert.throws(()=>h.parseCandidateOptions([...options,'--zip',join(root,'input.zip')]));
    assert.equal(h.parseCandidateOptions([...options,'--zip',join(root,'input.zip'),'--zip-sha256',digest]).zip,join(root,'input.zip'));
  `));

  it('constructs separate local/global npm paths and both genuine Windows aliases with spaces', async () => probe(`
    const prefix=${JSON.stringify('C:\\task root\\prefix')}, cmd=${JSON.stringify('C:\\Windows\\System32\\cmd.exe')};
    for(const mode of ['local','global'])for(const alias of ['bazframe','bzf']){
      const paths=h.installationPaths(prefix,mode,'win32');
      const exe=paths.bin+'\\\\'+alias+'.cmd';
      const source=${JSON.stringify('C:\\source root\\demo')};
      const invocation=h.aliasInvocation(exe,['skill','add',source],'win32',cmd);
      assert.equal(invocation.file,cmd);assert.deepEqual(invocation.args.slice(0,4),['/d','/s','/v:off','/c']);
      assert.equal(invocation.args[4], '""'+exe+'" "skill" "add" "'+source+'""');
      assert.equal(invocation.options.windowsVerbatimArguments,true);assert.equal(invocation.options.shell,false);
      assert.equal(paths.bin,mode==='local'?prefix+${JSON.stringify('\\node_modules\\.bin')}:prefix);
    }
    assert.equal(h.installationPaths('/task root/prefix','global','linux').packageRoot,'/task root/prefix/lib/node_modules/bazframe');
    assert.equal(h.installationPaths('/task root/prefix','local','linux').bin,'/task root/prefix/node_modules/.bin');
  `));

  it.each(['%', '!', '"', '&', '|', '<', '>', '^', '\n', '\r', '\0', 'ends\\'])('rejects unsupported CMD token %j before dispatch', async token => probe(`
    assert.throws(()=>h.aliasInvocation(${JSON.stringify('C:\\task\\bzf.cmd')},[${JSON.stringify(token)}],'win32',${JSON.stringify('C:\\Windows\\System32\\cmd.exe')}),/Unsupported CMD argument/);
  `));

  it('isolates credentials, configuration, build hooks and personal PATH', async () => probe(`
    const env=h.isolatedEnvironment(join(root,'env'),join(root,'prefix'),process.execPath,{...process.env,NODE_OPTIONS:'--require personal',npm_config_registry:'personal',GIT_CONFIG_COUNT:'1',BAZFRAME_GIT_COMMAND:'personal',PI_CODING_AGENT_DIR:'personal',VISUAL:'personal',OPENAI_API_KEY:'private'});
    for(const key of ['NODE_OPTIONS','npm_config_registry','GIT_CONFIG_COUNT','BAZFRAME_GIT_COMMAND','VISUAL','OPENAI_API_KEY'])assert.equal(env[key],undefined);
    for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','npm_config_cache','npm_config_userconfig','npm_config_globalconfig','GIT_CONFIG_GLOBAL','BAZFRAME_HOME','PI_CODING_AGENT_DIR'])assert(env[key].startsWith(root));
    assert(!fs.existsSync(env.BAZFRAME_HOME));assert(!fs.existsSync(env.PI_CODING_AGENT_DIR));
  `));

  it('retains original raw bytes and owners through natural exit, close and receipt I/O', async () => probe(`
    const owners=[],run=h.retainedRunner(join(root,'evidence'),owners);
    const result=await run('bytes',{file:process.execPath,args:['-e',"process.stdout.write(Buffer.from([0,255,13,10]));process.stderr.write('original stderr');process.exitCode=2"]},root,process.env);
    h.assertNaturalResult(result,2);assert.equal(owners.length,1);assert.equal(owners[0].exitCode,2);
    assert.deepEqual(result.stdout,Buffer.from([0,255,13,10]));assert.equal(result.stderr.toString(),'original stderr');
    assert.deepEqual(result.events.map(e=>e.event),['exit','close']);assert.equal(result.descendantSettlement,'not-established');
    assert.deepEqual(fs.readFileSync(result.evidence+'.stdout'),result.stdout);
    assert.equal(h.jsonFile(result.evidence+'.result.json').code,2);
  `));

  it('retains spawn errors and stops dependent operations while expected refusals continue', async () => probe(`
    const run=h.retainedRunner(join(root,'evidence')), rows=[], calls=[];
    let caught;try{await h.runSteps([
      {name:'expected-refusal',run:async()=>{const r=await run('refusal',{file:process.execPath,args:['-e','process.exitCode=2']},root,process.env);h.assertNaturalResult(r,2);calls.push('refusal')}},
      {name:'first-failure',run:async()=>{const r=await run('missing',{file:join(root,'missing'),args:[]},root,process.env);h.assertNaturalResult(r)}},
      {name:'dependent',run:()=>calls.push('must-not-run')}
    ],rows,()=>h.saveJson(join(root,'rows.json'),rows));}catch(error){caught=error}
    assert(caught instanceof h.CandidateUncertainty);assert.deepEqual(calls,['refusal']);assert.deepEqual(rows.map(r=>r.status),['passed','uncertain','not-run']);
    assert(rows[1].error.includes('Child process error'));assert(rows[2].reason.includes('first-failure'));
    const evidence=fs.readdirSync(join(root,'evidence')).find(x=>x.endsWith('missing.result.json'));
    const receipt=h.jsonFile(join(root,'evidence',evidence));assert(receipt.events.some(e=>e.event==='error'));assert(receipt.events.some(e=>e.event==='close'));
  `));

  it('routes exact candidate rejection before packing, regression fixtures or cleanup', async () => probe(`
    import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    import filesystem from 'node:fs';
    childProcess.execFileSync=()=>{throw Error('FORBIDDEN_PACK')};childProcess.spawn=()=>{throw Error('FORBIDDEN_CHILD')};
    filesystem.mkdtempSync=()=>{throw Error('FORBIDDEN_REGRESSION_FIXTURE')};
    filesystem.rmSync=()=>{throw Error('FORBIDDEN_RECLAMATION')};filesystem.unlinkSync=()=>{throw Error('FORBIDDEN_UNLINK')};
    syncBuiltinESMExports();
    process.argv=[process.execPath,${JSON.stringify(entrypoint)},...options.map(x=>x===digest?'0'.repeat(64):x)];
    await assert.rejects(import(${JSON.stringify(entrypoint)}),/Candidate digest mismatch/);
    assert.equal(h.sha256(fs.readFileSync(archive)),digest);assert(!fs.existsSync(join(root,'new-root')));
  `));

  it('preserves the default regression pack route without actually packing', async () => probe(`
    import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    childProcess.execFileSync=(_file,args)=>{assert.equal(args[1],'pack');throw Error('EXPECTED_DEFAULT_PACK_BOUNDARY')};
    syncBuiltinESMExports();process.env.npm_execpath='test-npm-boundary';process.argv=[process.execPath,${JSON.stringify(entrypoint)}];
    await assert.rejects(import(${JSON.stringify(entrypoint)}),/EXPECTED_DEFAULT_PACK_BOUNDARY/);
    assert.equal(h.sha256(fs.readFileSync(archive)),digest);
  `));

  it('prepares fixed dispatch/resources/ZIP operation sets without running product or child work', async () => probe(`
    const c={root:join(root,'cell'),home:join(root,'cell','home'),environment:{PI_CODING_AGENT_DIR:join(root,'pi')}};
    const dispatch=batches.dispatchSteps({...c}),resources=batches.resourceSteps({...c}),zip=batches.zipSteps({...c});
    for(const steps of [dispatch,resources,zip])assert.equal(new Set(steps.map(s=>s.name)).size,steps.length);
    for(const name of ['skill-first-add','package-add-build','library-all-profiles-collision-refusal','package-build-refusal','rich-duplicate','active-rename','rich-remove-guard-refusal','active-force-remove-refusal','rich-force-remove','detach-package-rich-copy','remove-package'])assert(resources.some(s=>s.name===name),name);
    for(const name of ['mixed-export','zip-dry-run','zip-fresh-import','zip-activate','zip-collision-refusal','zip-safe-suffix','managed-rich-duplicate','managed-active-rename','zip-active-overwrite','zip-reexport','zip-occupied-output-refusal','zip-explicit-output-replacement'])assert(zip.some(s=>s.name===name),name);
    const external=batches.zipSteps({...c,zip:join(root,'reviewed.zip')});
    assert.equal(external[0].name,'admit-reviewed-zip');assert(!external.some(s=>s.name==='package-add-build'||s.name==='mixed-export'));
    assert(!fs.existsSync(c.root));
  `));

  it('does not accept exit zero, a success banner or correct JSON when state assertions fail', async () => probe(`
    const c={root,home:join(root,'home'),cwd:root,environment:{},executable:'/unused',version:'fixture'};
    let index=0;
    c.run=async()=>({evidence:join(root,'mock-'+(++index)),stdout:Buffer.from('Bazframe wrong-version\\n'),stderr:Buffer.alloc(0),code:0,signal:null,ioErrors:[],events:[{event:'exit',code:0,signal:null},{event:'close',code:0,signal:null}]});
    await assert.rejects(batches.dispatchSteps(c)[0].run(),/wrong-version/);
    c.run=async()=>{fs.mkdirSync(c.home);return {evidence:join(root,'mock-'+(++index)),stdout:Buffer.from('Bazframe fixture\\n'),stderr:Buffer.alloc(0),code:0,signal:null,ioErrors:[],events:[{event:'exit',code:0,signal:null},{event:'close',code:0,signal:null}]}};
    await assert.rejects(batches.dispatchSteps(c)[0].run(),/mutated managed state/);
    assert(fs.existsSync(c.home));
    c.run=async()=>({evidence:join(root,'mock-'+(++index)),stdout:Buffer.from(JSON.stringify({schemaVersion:1,ok:false,error:{code:'WRONG_ERROR'}})),stderr:Buffer.alloc(0),code:2,signal:null,ioErrors:[],events:[{event:'exit',code:2,signal:null},{event:'close',code:2,signal:null}]});
    await assert.rejects(batches.dispatchSteps(c)[2].run(),/WRONG_ERROR/);
  `));

  it('uses real migration spelling and requires the actual replacement guidance', async () => probe(`
    const c={root,home:join(root,'home'),cwd:root,environment:{},executable:'/unused'};
    const step=batches.dispatchSteps(c).find(s=>s.name==='migration');
    assert.deepEqual(step.metadata.argv,['profiles','--json']);
    let message='This command was removed. Use \`bazframe profile list\` instead.';
    c.run=async()=>({evidence:join(root,'migration'),stdout:Buffer.from(JSON.stringify({schemaVersion:1,ok:false,error:{code:'CLI_MIGRATION_REQUIRED',message}})),stderr:Buffer.alloc(0),code:2,signal:null,ioErrors:[],events:[{event:'exit',code:2,signal:null},{event:'close',code:2,signal:null}]});
    await step.run();message='wrong guidance';await assert.rejects(step.run(),/wrong guidance/);
  `));

  it('rejects duplicate payload or reference loss and idempotent absent detaches', async () => probe(`
    const c={root,home:join(root,'home'),cwd:root,environment:{},executable:'/unused'};
    const steps=batches.resourceSteps(c);
    await steps.find(s=>s.name==='prepare-local-fixtures').run();
    await steps.find(s=>s.name==='author-rich-profile').run();
    const source=join(c.home,'profiles','rich'),copy=join(c.home,'profiles','rich-copy');
    fs.symlinkSync(c.added,join(source,'skills','added-skill'),'junction');
    for(const [dir,id] of [['libraries','local-library'],['packages','local-package']]){fs.mkdirSync(join(source,dir));fs.writeFileSync(join(source,dir,id+'.json'),JSON.stringify({[dir]:id}));}
    fs.cpSync(source,copy,{recursive:true});
    fs.writeFileSync(join(c.home,'profile-favorites.json'),JSON.stringify({favorites:['rich']}));
    fs.writeFileSync(join(c.home,'active-profile'),'rich\\n');
    let document={schemaVersion:1,ok:true,command:'profile.duplicate'};
    c.run=async()=>({evidence:join(root,'mock-duplicate'),stdout:Buffer.from(JSON.stringify(document)),stderr:Buffer.alloc(0),code:0,signal:null,ioErrors:[],events:[{event:'exit',code:0,signal:null},{event:'close',code:0,signal:null}]});
    const step=steps.find(s=>s.name==='rich-duplicate');await step.run();
    for(const name of ['skills/physical-skill/SKILL.md','skills/physical-skill/support.bin','skills/physical-skill/run.sh','libraries/local-library.json','packages/local-package.json']){
      const path=join(copy,name),bytes=fs.readFileSync(path),mode=fs.statSync(path).mode;
      fs.unlinkSync(path);await assert.rejects(step.run());fs.writeFileSync(path,bytes,{mode});
    }
    fs.writeFileSync(join(c.home,'active-profile'),'other\\n');
    for(const kind of ['skill','library','package']){
      document={schemaVersion:1,ok:true,command:'profile.'+kind+'.remove',result:{action:'absent'}};
      await assert.rejects(steps.find(s=>s.name==='detach-'+kind+'-other').run(),/Detach must remove/);
    }
  `));

  it('limits Windows domain equality to the five mutating refusals, preserving full raw lock evidence', async () => probe(`
    Object.defineProperty(process,'platform',{value:'win32'});
    const c={root,home:join(root,'home'),cwd:root,environment:{ComSpec:${JSON.stringify('C:\\Windows\\System32\\cmd.exe')}},executable:${JSON.stringify('C:\\task\\bzf.cmd')}};
    const steps=batches.resourceSteps(c);fs.mkdirSync(join(c.home,'profile-publishing'),{recursive:true});fs.mkdirSync(c.sources,{recursive:true});
    const cases=[['skill-referenced-remove-refusal','skill.remove','DEFAULT_SKILL_REFERENCED','referenced by profiles'],['library-referenced-remove-refusal','library.remove','SKILL_COLLECTION_REFERENCED','referenced by profiles'],['package-referenced-remove-refusal','package.remove','SKILL_COLLECTION_REFERENCED','referenced by profiles'],['active-force-remove-refusal','profile.remove','PROFILE_ACTIVE','active profile'],['rich-remove-guard-refusal','profile.remove','PROFILE_NOT_EMPTY','Profile is not generated-empty and cannot be removed without recursive confirmation: renamed']];
    let n=0,mutate=()=>{};
    for(const [name,command,code,message]of cases){
      c.run=async()=>{mutate();return {evidence:join(root,'mock-'+(++n)),stdout:Buffer.from(JSON.stringify({schemaVersion:1,ok:false,command,error:{code,message}})),stderr:Buffer.alloc(0),code:1,signal:null,ioErrors:[],events:[{event:'exit',code:1,signal:null},{event:'close',code:1,signal:null}]}};
      const step=steps.find(s=>s.name===name);await step.run();
      for(const namespace of ['locks/state.lock','profile-publishing/operation-locks/hash']){
        mutate=()=>{fs.mkdirSync(join(c.home,namespace),{recursive:true});fs.writeFileSync(join(c.home,namespace,'owner'),'acquisition '+n)};await step.run();
        const raw=h.jsonFile(join(root,'mock-'+n+'.disk.json'));assert(raw.after[namespace+'/owner']);assert.notDeepEqual(raw.after,raw.before);
      }
      for(const path of ['active-profile','profile-favorites.json','profiles/alpha/AGENTS.md','skills/record','skill-snapshots/store','profile-publishing/journals/entry']){
        mutate=()=>{fs.mkdirSync(dirname(join(c.home,path)),{recursive:true});fs.writeFileSync(join(c.home,path),'changed '+n)};
        await assert.rejects(step.run(),/mutated domain state/);
      }
      mutate=()=>fs.writeFileSync(join(c.sources,'external'),'changed '+n);await assert.rejects(step.run(),/source-owned mutation/);mutate=()=>{};
    }
  `));

  it('allows only expected existing Windows recovery owners to refresh on ZIP collision refusal', async () => probe(`
    Object.defineProperty(process,'platform',{value:'win32'});
    const home=join(root,'import-home'),zipInput=join(root,'reviewed.zip'),sources=join(root,'sources');
    fs.mkdirSync(home);fs.mkdirSync(sources);fs.writeFileSync(zipInput,'reviewed input');
    const owners=['@store','rich'].map(key=>'profile-publishing/operation-locks/'+h.sha256('bazframe-profile-operation-key-v1\\0'+key)+'/owner');
    for(const path of owners){fs.mkdirSync(dirname(join(home,path)),{recursive:true});fs.writeFileSync(join(home,path),'old');fs.writeFileSync(join(dirname(join(home,path)),'guard'),'guard');}
    let n=0,mutate=()=>{},code='PROFILE_IMPORT_COLLISION_DECISION_REQUIRED';
    const c={root,home,cwd:root,sources,environment:{ComSpec:${JSON.stringify('C:\\Windows\\System32\\cmd.exe')}},executable:${JSON.stringify('C:\\task\\bzf.cmd')},zip:zipInput,zipSha256:h.sha256(fs.readFileSync(zipInput)),run:async()=>{mutate();return{evidence:join(root,'collision-'+(++n)),stdout:Buffer.from(JSON.stringify({schemaVersion:2,command:'profile.import',outcome:'refusal',refusal:{code}})),stderr:Buffer.alloc(0),code:2,signal:null,ioErrors:[],events:[{event:'exit',code:2,signal:null},{event:'close',code:2,signal:null}]}}};
    const step=batches.zipSteps(c).find(s=>s.name==='zip-collision-refusal');await step.run();
    for(const path of owners){mutate=()=>fs.writeFileSync(join(home,path),'new acquisition with different PID width '+n);await step.run();const raw=h.jsonFile(join(root,'collision-'+n+'.disk.json'));assert.notDeepEqual(raw.before[path],raw.after[path]);assert.equal(raw.after[path].kind,'file');}
    Object.defineProperty(process,'platform',{value:'linux'});mutate=()=>fs.writeFileSync(join(home,owners[0]),'POSIX owner mutation');await assert.rejects(step.run(),/mutated managed state/);Object.defineProperty(process,'platform',{value:'win32'});
    const unknown='profile-publishing/operation-locks/'+h.sha256('unexpected')+'/owner';fs.mkdirSync(dirname(join(home,unknown)),{recursive:true});fs.writeFileSync(join(home,unknown),'unchanged');
    for(const path of [unknown,owners[0].replace(/owner$/,'guard'),'active-profile','profile-favorites.json','profiles/rich/AGENTS.md','skill-snapshots/store','profile-publishing/transactions/entry']){
      const target=join(home,path);fs.mkdirSync(dirname(target),{recursive:true});const before=fs.existsSync(target)?fs.readFileSync(target):undefined;
      mutate=()=>fs.writeFileSync(target,'unexpected '+n);await assert.rejects(step.run());if(before)fs.writeFileSync(target,before);else fs.unlinkSync(target);
    }
    const owner=join(home,owners[0]),saved=fs.readFileSync(owner);mutate=()=>fs.unlinkSync(owner);await assert.rejects(step.run());fs.writeFileSync(owner,saved);
    fs.unlinkSync(owner);mutate=()=>fs.writeFileSync(owner,saved);await assert.rejects(step.run());
    mutate=()=>{fs.unlinkSync(owner);fs.symlinkSync(zipInput,owner)};await assert.rejects(step.run());fs.unlinkSync(owner);fs.writeFileSync(owner,saved);
    const mode=fs.statSync(owner).mode;mutate=()=>fs.chmodSync(owner,mode|0o111);await assert.rejects(step.run());fs.chmodSync(owner,mode);
    mutate=()=>fs.writeFileSync(join(sources,'external'),'changed');await assert.rejects(step.run(),/source-owned mutation/);
    mutate=()=>fs.writeFileSync(zipInput,'changed archive');await assert.rejects(step.run(),/ZIP changed/);fs.writeFileSync(zipInput,'reviewed input');
    mutate=()=>{};code='WRONG_REFUSAL';await assert.rejects(step.run(),/WRONG_REFUSAL/);
  `));

  it('keeps POSIX refusals and neutral/ZIP effect-free modes strict even for owner-only changes', async () => probe(`
    const c={root,home:join(root,'home'),cwd:root,environment:{},executable:'/unused'};fs.mkdirSync(c.home);
    const resources=batches.resourceSteps(c);let n=0,document={schemaVersion:1,ok:false,command:'skill.remove',error:{code:'DEFAULT_SKILL_REFERENCED',message:'referenced by profiles'}},exit=1;
    c.run=async(_name,_inv,_cwd,env)=>{fs.mkdirSync(join(env.BAZFRAME_HOME,'locks'),{recursive:true});fs.writeFileSync(join(env.BAZFRAME_HOME,'locks','owner'),'new '+n);return {evidence:join(root,'strict-'+(++n)),stdout:Buffer.from(JSON.stringify(document)),stderr:Buffer.alloc(0),code:exit,signal:null,ioErrors:[],events:[{event:'exit',code:exit,signal:null},{event:'close',code:exit,signal:null}]}};
    Object.defineProperty(process,'platform',{value:'linux'});
    await assert.rejects(resources.find(s=>s.name==='skill-referenced-remove-refusal').run(),/mutated domain state/);
    Object.defineProperty(process,'platform',{value:'win32'});c.executable=${JSON.stringify('C:\\task\\bzf.cmd')};c.environment.ComSpec=${JSON.stringify('C:\\Windows\\System32\\cmd.exe')};
    document={schemaVersion:1,ok:false,error:{code:'CLI_USAGE'}};exit=2;
    await assert.rejects(batches.dispatchSteps(c).find(s=>s.name==='malformed').run(),/mutated managed state/);
    const zip=batches.zipSteps({...c,zip:join(root,'reviewed.zip')});
    for(const [name,command,code]of [['zip-dry-run','profile.import',null],['zip-collision-refusal','profile.import','PROFILE_IMPORT_COLLISION_DECISION_REQUIRED'],['zip-occupied-output-refusal','profile.export','PROFILE_ZIP_OUTPUT_OCCUPIED']]){
      Object.defineProperty(process,'platform',{value:name==='zip-collision-refusal'?'linux':'win32'});
      exit=code?2:0;document={schemaVersion:2,command,outcome:code?'refusal':'success',refusal:{code}};
      await assert.rejects(zip.find(s=>s.name===name).run(),/mutated managed state/);
    }
  `));

  it('accepts shared PROFILE_NOT_EMPTY meaning on both routes but rejects wrong code or meaning', async () => probe(`
    const c={root,home:join(root,'home'),cwd:root,environment:{},executable:'/unused'};const step=batches.resourceSteps(c).find(s=>s.name==='rich-remove-guard-refusal');
    let code='PROFILE_NOT_EMPTY',message='';let n=0;
    c.run=async()=>({evidence:join(root,'guard-'+(++n)),stdout:Buffer.from(JSON.stringify({schemaVersion:1,ok:false,command:'profile.remove',error:{code,message}})),stderr:Buffer.alloc(0),code:1,signal:null,ioErrors:[],events:[{event:'exit',code:1,signal:null},{event:'close',code:1,signal:null}]});
    for(const suffix of ['without --force: renamed','without recursive confirmation: renamed']){message='Profile is not generated-empty and cannot be removed '+suffix;await step.run();}
    code='WRONG_ERROR';await assert.rejects(step.run(),/WRONG_ERROR/);code='PROFILE_NOT_EMPTY';message='unexpected problem';await assert.rejects(step.run());
  `));

  it('admits only exact synchronous npm CMD shapes, never a target substring', async () => probe(String.raw`
    for(const target of [${JSON.stringify('..\\bazframe\\dist\\cli.js')},${JSON.stringify('node_modules\\bazframe\\dist\\cli.js')}]){
      const expected=h.expectedCmdShim(target);assert(expected.includes('endLocal & goto #_undefined_#'));assert(expected.endsWith(' %*'));
      const path=join(root,'bzf.cmd');fs.writeFileSync(path,expected.replaceAll('\n','\r\n')+'\r\n');
      // Platform-neutral physical file with Windows lexical target makes the
      // real byte comparator run on this host, without spawning CMD.
      const lexicalTarget=path.slice(0,path.lastIndexOf('/'))+'/'+target.replaceAll('\\','/');
      h.verifyCmdShim(path,lexicalTarget);
      for(const bytes of [expected+'\necho injected',expected.replace('"%_prog%"  ','start "" "%_prog%"  '),expected.replace('SET "_prog=node"','SET "_prog=personal"')]){
        fs.writeFileSync(path,bytes);assert.throws(()=>h.verifyCmdShim(path,lexicalTarget),/Unreviewed npm CMD shape/);
      }
    }
  `));

  it('reconciles physical query paths, deduplicated edges and absent optional lock nodes in local/global bases', async () => probe(`
    // Shape observed from selected npm 11.11 query '*' (retained raw metadata):
    // path/realpath/location and to/from physical edges, one diff node despite
    // npm ls emitting repeated {version:'8.0.4'} logical references.
    for(const mode of ['local','global']) {
      const base=join(root,mode,mode==='global'?'lib':'project'),modules=join(base,'node_modules');
      const specs=[['bazframe','1.0.0'],['diff','8.0.4'],['parent','1.0.0']];
      const nodes=specs.map(([name,version])=>{const path=join(modules,name);fs.mkdirSync(path,{recursive:true});fs.writeFileSync(join(path,'package.json'),JSON.stringify({name,version}));return {name,version,location:'node_modules/'+name,path,realpath:path,resolved:name==='bazframe'?'file:'+archive:'https://registry.npmjs.org/'+name+'/-/'+name+'-'+version+'.tgz',from:[],to:[]}});
      nodes[0].to=['node_modules/diff','node_modules/parent'];nodes[2].to=['node_modules/diff'];nodes[1].from=['node_modules/bazframe','node_modules/parent'];
      const lock={lockfileVersion:3,packages:Object.fromEntries(nodes.map(n=>[n.location,{version:n.version,resolved:n.resolved}]))};
      lock.packages['node_modules/absent-platform']={version:'1',optional:true,resolved:'https://registry.npmjs.org/absent-platform/-/absent-platform-1.tgz'};
      const rootNode={location:'',path:base,realpath:base,resolved:null};
      assert.equal(h.verifyRegistryOrigins([rootNode,...nodes],archive,lock,base).packages.length,3);
      assert.deepEqual(h.verifyRegistryOrigins(nodes,archive,lock,base).absentOptional,['node_modules/absent-platform']);
      assert.throws(()=>h.verifyRegistryOrigins(nodes.slice(0,2),archive,lock,base),/omitted physical/);
      const original=nodes[1].resolved;nodes[1].resolved=null;
      assert.equal(h.verifyRegistryOrigins(nodes,archive,lock,base).packages[1].resolved,original);
      assert.throws(()=>h.verifyRegistryOrigins(nodes,archive,undefined,base),/Missing resolved/);
      assert.equal(h.verifyRegistryOrigins(nodes,archive,undefined,base,{allowUnreported:true}).packages[1].originEvidence,'not reported by npm');
      for(const bad of ['git+https://github.com/example/repo.git','https://github.com/example/archive.tgz','http://registry.npmjs.org/diff/-/diff.tgz','https://secret@registry.npmjs.org/diff/-/diff.tgz','file:personal.tgz']){nodes[1].resolved=bad;assert.throws(()=>h.verifyRegistryOrigins(nodes,archive,undefined,base,{allowUnreported:true}));}
      nodes[1].resolved=original;nodes[1].path=join(modules,'same-name-elsewhere');assert.throws(()=>h.verifyRegistryOrigins(nodes,archive,lock,base),/location mismatch/);nodes[1].path=join(modules,'diff');
      lock.packages['node_modules/absent-platform'].optional=false;assert.throws(()=>h.verifyRegistryOrigins(nodes,archive,lock,base),/Missing nonoptional/);
    }
  `));

  it('compares only nominated file origins semantically while retaining raw spellings and strict closure', async () => probe(String.raw`
    const base=join(root,'w9hl62','prefix'),modules=join(base,'node_modules'),owner=join(root,'w9ho62');fs.mkdirSync(owner);
    const candidate=join(owner,'candidate.tgz');fs.copyFileSync(archive,candidate);
    const path=join(modules,'bazframe');fs.mkdirSync(path,{recursive:true});fs.writeFileSync(join(path,'package.json'),JSON.stringify({name:'bazframe',version:'fixture'}));
    const node={path,realpath:path,location:'node_modules/bazframe',name:'bazframe',version:'fixture',resolved:'file:'+candidate};
    const item={version:'fixture',resolved:'file:../../w9ho62/candidate.tgz'},lock={lockfileVersion:3,packages:{[node.location]:item}};
    // Exact retained suffixes/layout: w9hl62/prefix -> ../../w9ho62/candidate.tgz.
    let result=h.verifyRegistryOrigins([node],candidate,lock,base).packages[0];
    assert.equal(result.queryResolved,node.resolved);assert.equal(result.lockResolved,item.resolved);
    const {pathToFileURL}=await import('node:url');
    const spaced=join(owner,'candidate with spaces.tgz');fs.copyFileSync(archive,spaced);
    const spellings=['file:'+spaced,pathToFileURL(spaced).href,'file:../../w9ho62/candidate with spaces.tgz','file:../../w9ho62/candidate%20with%20spaces.tgz'];
    for(const query of spellings)for(const locked of spellings){node.resolved=query;item.resolved=locked;result=h.verifyRegistryOrigins([node],spaced,lock,base).packages[0];assert.equal(result.queryResolved,query);assert.equal(result.lockResolved,locked);}
    for(const which of ['query','lock']){node.resolved='file:'+spaced;item.resolved=spellings[2];if(which==='query')node.resolved='file:'+candidate;else item.resolved='file:../../w9ho62/candidate.tgz';assert.throws(()=>h.verifyRegistryOrigins([node],spaced,lock,base),/Candidate origin differs/);}
    node.resolved=item.resolved='file:'+candidate;
    const other=join(modules,'dep');fs.mkdirSync(other);fs.writeFileSync(join(other,'package.json'),JSON.stringify({name:'dep',version:'1'}));
    const dep={path:other,realpath:other,location:'node_modules/dep',name:'dep',version:'1',resolved:'https://registry.npmjs.org/dep/-/dep-1.tgz'};
    lock.packages[dep.location]={version:'1',resolved:dep.resolved+'?different'};
    assert.throws(()=>h.verifyRegistryOrigins([node,dep],candidate,lock,base),/query\/lock origin mismatch/);
    assert.throws(()=>h.verifyRegistryOrigins([node],candidate,lock,base),/omitted physical/);
    dep.resolved=lock.packages[dep.location].resolved='file:'+candidate;
    assert.throws(()=>h.verifyRegistryOrigins([node,dep],candidate,lock,base),/Non-registry acquisition/);
  `));

  it('uses actual origin admission with source-backed Windows drive, slash and space semantics', async () => probe(String.raw`
    import filesystem from 'node:fs';import pathModule from 'node:path';import urlModule from 'node:url';import{syncBuiltinESMExports}from'node:module';
    const w=pathModule.win32,base='C:\\task root\\prefix',modules=w.join(base,'node_modules'),path=w.join(modules,'bazframe'),candidate='C:\\owner root\\candidate.tgz';
    const manifest=JSON.stringify({name:'bazframe',version:'fixture'}),realpaths=[];
    filesystem.readdirSync=p=>{assert.equal(p,modules);return ['bazframe']};
    filesystem.lstatSync=p=>{if(p===w.join(path,'node_modules'))throw Object.assign(Error('absent nested modules'),{code:'ENOENT'});assert.equal(p,path);return {isDirectory:()=>true,isSymbolicLink:()=>false}};
    filesystem.readFileSync=p=>{assert.equal(p,w.join(path,'package.json'));return manifest};
    filesystem.realpathSync=p=>{assert([path,candidate,'C:\\owner root\\wrong.tgz'].includes(p),p);realpaths.push(p);return p};
    const to=urlModule.pathToFileURL,from=urlModule.fileURLToPath;
    urlModule.pathToFileURL=p=>to(p,{windows:true});urlModule.fileURLToPath=u=>from(u,{windows:true});
    pathModule.join=w.join;pathModule.resolve=w.resolve;syncBuiltinESMExports();
    const node={path,realpath:path,location:'node_modules/bazframe',name:'bazframe',version:'fixture'},item={version:'fixture'},lock={lockfileVersion:3,packages:{[node.location]:item}};
    const spellings=['file:C:/owner root/candidate.tgz','file:///C:/owner%20root/candidate.tgz','file:../../owner root/candidate.tgz','file:C:\\owner root\\candidate.tgz'];
    for(const query of spellings)for(const locked of spellings){node.resolved=query;item.resolved=locked;const result=h.verifyRegistryOrigins([node],candidate,lock,base);assert.equal(result.packages[0].queryResolved,query);assert.equal(result.packages[0].lockResolved,locked);}
    node.resolved=spellings[0];item.resolved='file:../../owner root/wrong.tgz';assert.throws(()=>h.verifyRegistryOrigins([node],candidate,lock,base),/Candidate origin differs/);
    assert(realpaths.includes(candidate));
  `));

  it.each(['local','hidden-lock','global','minimum','reviewed087','current','wrong-query','wrong-lock','inventory-io','lock-io','origin-inputs-io'])('actual runCandidate preserves pre-admission evidence and hold boundaries: %s', async mode => probe(String.raw`
    import filesystem from 'node:fs';import childProcess from 'node:child_process';import workerThreads from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';import{PassThrough}from'node:stream';import{relative}from'node:path';
    const mode=${JSON.stringify(mode)},execution=join(root,'new-root'),prefix=join(execution,'prefix'),install=mode==='global'?'global':'local',paths=h.installationPaths(prefix,install),base=dirname(paths.modules);
    const piVersion=({minimum:'0.84.4',reviewed087:'0.87.0',current:'1.5.2'})[mode],resolvedPi=piVersion??'1.5.2';
    options[options.indexOf('--install')+1]=install;options[options.indexOf('--batch')+1]='dispatch';
    const npm=join(root,'npm','npm-cli.js');fs.mkdirSync(dirname(npm));fs.writeFileSync(npm,'npm boundary');fs.writeFileSync(join(dirname(npm),'package.json'),JSON.stringify({name:'npm',version:'fixture'}));options[options.indexOf('--npm-cli')+1]=npm;fs.writeFileSync(join(root,'scope.json'),'external scope');
    const wrong=join(root,'wrong.tgz');fs.copyFileSync(archive,wrong);
    let heldResolve,cliCount=0,queryCount=0,lockBytes,queryBytes;const held=new Promise(resolve=>heldResolve=resolve),children=[];
    workerThreads.MessageChannel=class{constructor(){this.port1=new EventEmitter();this.port2=new EventEmitter();this.port1.ref=()=>heldResolve();}};
    const originalWrite=fs.writeFileSync,ioFailure=Error('original required observation write failure');
    filesystem.writeFileSync=(path,...args)=>{if((mode==='inventory-io'&&path===join(execution,'installed-inventory.json'))||(mode==='lock-io'&&path===join(execution,'resolved-package-lock.json'))||(mode==='origin-inputs-io'&&path===join(execution,'origin-inputs.json')))throw ioFailure;return originalWrite(path,...args);};
    const queryOrigin='file:'+(mode==='wrong-query'?wrong:archive),lockOrigin='file:'+relative(base,mode==='wrong-lock'?wrong:archive).replaceAll('\\','/');
    const lockPath=mode==='hidden-lock'||mode==='global'?join(paths.modules,'.package-lock.json'):join(prefix,'package-lock.json');
    childProcess.spawn=(_file,args)=>{const child=new EventEmitter();children.push(child);child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=42;
      queueMicrotask(()=>{let output='';if(args[1]==='--version')output='fixture\n';else if(args[1]==='install'){
        assert.equal(args.includes('--prefer-dedupe'),!!piVersion);assert.deepEqual(args.filter(arg=>arg.startsWith('@earendil-works/pi-coding-agent@')),piVersion?['@earendil-works/pi-coding-agent@'+piVersion]:[]);
        for(const [name,bytes]of Object.entries(members)){const path=join(paths.packageRoot,name);fs.mkdirSync(dirname(path),{recursive:true});fs.writeFileSync(path,bytes);}
        const piRoot=join(paths.modules,'@earendil-works/pi-coding-agent');fs.mkdirSync(join(piRoot,'dist/bundle'),{recursive:true});fs.writeFileSync(join(piRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:resolvedPi,bin:{pi:'dist/bundle/cli.js'}}));fs.writeFileSync(join(piRoot,'dist/bundle/cli.js'),'not executed');
        fs.mkdirSync(paths.bin,{recursive:true});for(const alias of ['bazframe','bzf'])fs.symlinkSync(join(paths.packageRoot,'dist/cli.js'),join(paths.bin,alias));
        const nodes=[...h.installedPackages(paths.modules)].map(([path,m])=>({path,realpath:path,location:relative(base,path),name:m.name,version:m.version,resolved:m.name==='bazframe'?queryOrigin:'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-'+resolvedPi+'.tgz'}));
        queryBytes=Buffer.from(JSON.stringify(nodes));lockBytes=Buffer.from(JSON.stringify({lockfileVersion:3,packages:Object.fromEntries(nodes.map(n=>[n.location,{version:n.version,resolved:n.name==='bazframe'?lockOrigin:n.resolved}]))})+'\n');fs.writeFileSync(lockPath,lockBytes);
      }else if(args[1]==='query'){queryCount++;output=queryBytes;assert(fs.existsSync(join(execution,'installed-inventory.json')));}
      else {cliCount++;child.emit('error',Error('synthetic post-admission stop'));}
      child.stdout.end(typeof output==='string'?output.replaceAll('\\n','\n'):output);child.stderr.end();child.emit('exit',0,null);child.emit('close',0,null);});return child;};
    syncBuiltinESMExports();process.stderr.write=()=>true;
    let settled=false;const done=batches.runCandidate(options,piVersion?{piVersion}:undefined).then(()=>settled=true);await Promise.race([held,done]);assert.equal(settled,false);
    const hold=h.retainedCandidateHolds.at(-1);assert(hold.error instanceof h.CandidateUncertainty);assert.deepEqual(hold.owners,children);
    const accepted=['local','hidden-lock','global','minimum','reviewed087','current'].includes(mode),report=h.jsonFile(join(execution,'results.json'));
    assert.equal(cliCount,accepted?1:0);assert.equal(queryCount,mode==='inventory-io'?0:1);
    assert.equal(report.installation.at(-1).status,accepted?'passed':'uncertain');
    if(mode.endsWith('-io'))assert.equal(hold.error.cause,ioFailure);
    if(mode!=='inventory-io')assert.deepEqual(h.jsonFile(join(execution,'installed-inventory.json')),h.inventory(paths.modules));
    if(!['inventory-io','lock-io'].includes(mode))assert.deepEqual(fs.readFileSync(join(execution,'resolved-package-lock.json')),lockBytes);
    if(queryCount)assert.deepEqual(fs.readFileSync(join(execution,'install-evidence','003-npm-query.stdout')),queryBytes);
    if(!mode.endsWith('-io')){const inputs=h.jsonFile(join(execution,'origin-inputs.json'));assert.equal(inputs.originRoot,base);assert.equal(inputs.lock,lockPath);}
    if(mode.startsWith('wrong-')){assert.match(String(hold.error),/Candidate origin differs/);assert.equal(report.cells.length,0);assert.equal(children.length,3);}
    if(accepted){assert.equal(report.environment.pi.version,resolvedPi);assert.deepEqual(report.environment.piSelection,piVersion?{spec:'@earendil-works/pi-coding-agent@'+piVersion,preferDedupe:true,scope:'Pi-only explicit additional install selection; ordinary pack installation unchanged'}:null);const item=report.environment.acquisition.origins.packages.find(p=>p.name==='bazframe');assert.equal(item.queryResolved,queryOrigin);assert.equal(item.lockResolved,lockOrigin);assert.match(String(hold.error),/Child process error/);}
    assert(!fs.existsSync(join(execution,'bzf-dispatch')));
  `));

  it('discovers only physical installed Pi bin despite its actual import-only root export', async () => probe(`
    const paths=h.installationPaths(join(root,'prefix'),'local');fs.mkdirSync(paths.packageRoot,{recursive:true});
    const piRoot=join(paths.modules,'@earendil-works/pi-coding-agent');fs.mkdirSync(join(piRoot,'dist/bundle'),{recursive:true});
    fs.writeFileSync(join(piRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'0.84.4',type:'module',main:'./dist/index.js',exports:{'.':{types:'./dist/index.d.ts',import:'./dist/index.js'}},bin:{pi:'dist/bundle/cli.js'}}));
    fs.writeFileSync(join(piRoot,'dist/bundle/cli.js'),'not executed');
    const {createRequire}=await import('node:module');assert.throws(()=>createRequire(join(paths.packageRoot,'package.json')).resolve('@earendil-works/pi-coding-agent'),/exports/);
    assert.equal(h.installedPi(paths).entry,join(piRoot,'dist/bundle/cli.js'));
    fs.renameSync(piRoot,piRoot+'-retained');assert.throws(()=>h.installedPi(paths),/missing from selected installation/);
  `));

  it.each(['process-error','output-io','receipt-io','admission','first-failure-persistence'])('holds original owners and prevents later shared installation dispatch on %s', async failure => probe(String.raw`
    import filesystem from 'node:fs';import childProcess from 'node:child_process';import workerThreads from 'node:worker_threads';import {syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';import{PassThrough}from'node:stream';
    const npm=join(root,'npm','npm-cli.js');fs.mkdirSync(dirname(npm));fs.writeFileSync(npm,'task npm boundary');fs.writeFileSync(join(dirname(npm),'package.json'),JSON.stringify({name:'npm',version:'fixture'}));options[options.indexOf('--npm-cli')+1]=npm;fs.writeFileSync(join(root,'scope.json'),'external input, not a grant');
    let spawnCount=0,heldResolve;const held=new Promise(resolve=>heldResolve=resolve),children=[];
    workerThreads.MessageChannel=class {constructor(){this.port1=new EventEmitter();this.port2=new EventEmitter();this.port1.ref=()=>heldResolve();}};
    const originalWrite=fs.writeFileSync,originalAppend=fs.writeSync;
    const mode=${JSON.stringify(failure)};
    filesystem.writeFileSync=(path,...args)=>{if(spawnCount && ((mode==='receipt-io'&&String(path).endsWith('.result.json'))||(mode==='first-failure-persistence'&&String(path).endsWith('results.json'))))throw Error('required receipt failure');return originalWrite(path,...args)};
    filesystem.writeSync=(...args)=>{if(spawnCount&&mode==='output-io')throw Error('output evidence failure');return originalAppend(...args)};
    childProcess.spawn=()=>{spawnCount++;const child=new EventEmitter();children.push(child);child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=42;
      queueMicrotask(()=>{if(mode==='process-error'||mode==='first-failure-persistence')child.emit('error',Error('process uncertainty'));else child.stdout.write('fixture\n');child.stdout.end();child.stderr.end();child.emit('exit',0,null);child.emit('close',0,null)});return child};
    syncBuiltinESMExports();process.stderr.write=()=>true;
    let done=false;const result=batches.runCandidate(options).then(()=>{done=true});void result;
    await held;await Promise.resolve();assert.equal(done,false);
    const hold=h.retainedCandidateHolds.at(-1);assert(hold.error instanceof h.CandidateUncertainty);assert(hold.owners.includes(children[0]));
    // Admission case reaches install but never a CLI. Other failures stop at
    // the first npm version child, before even install-exact-candidate.
    assert.equal(spawnCount,mode==='admission'?2:1);assert.equal(hold.root,join(root,'new-root'));
    assert(fs.existsSync(archive));assert(!fs.existsSync(join(root,'new-root','bazframe-dispatch')));
    if(mode==='first-failure-persistence')assert(hold.error.persistenceError.includes('required receipt failure'));
  `));

  it.each(['zip-open','zip-read','zip-stream','zip-premature','zip-close','zip-receipt','zip-admission'])('actual runCandidate stops both aliases and retains owners on %s', async failure => probe(String.raw`
    import filesystem from 'node:fs';import childProcess from 'node:child_process';import workerThreads from 'node:worker_threads';import Module,{syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';import{PassThrough}from'node:stream';
    const mode=${JSON.stringify(failure)},execution=join(root,'new-root'),prefix=join(execution,'prefix'),paths=h.installationPaths(prefix,'local');
    const zipInput=join(root,'reviewed.zip');fs.writeFileSync(zipInput,'external retained ZIP boundary');options.push('--zip',zipInput,'--zip-sha256',h.sha256(fs.readFileSync(zipInput)));options[options.indexOf('--batch')+1]='zip';
    const npm=join(root,'npm','npm-cli.js');fs.mkdirSync(dirname(npm));fs.writeFileSync(npm,'npm boundary');fs.writeFileSync(join(dirname(npm),'package.json'),JSON.stringify({name:'npm',version:'fixture'}));options[options.indexOf('--npm-cli')+1]=npm;fs.writeFileSync(join(root,'scope.json'),'external scope');
    const skill=name=>'---\nname: '+name+'\ndescription: Task-owned installed acceptance fixture.\n---\n# '+name+'\n';
    const payloads={'AGENTS.md':'Task-only portable instructions.\r\n','support.bin':Buffer.from([0,255,13,10,65,0]),'crlf.txt':'first\r\nsecond\r\n'};
    // Raw outer test string deliberately encodes fixture line separators here.
    for(const name of ['physical-skill','added-skill','library-skill','package-skill'])payloads[name+'/SKILL.md']=skill(name).replaceAll('\\n','\n');
    for(const key of ['AGENTS.md','crlf.txt'])payloads[key]=payloads[key].replaceAll('\\r','\r').replaceAll('\\n','\n');
    payloads['bazframe-profile.json']=JSON.stringify({kind:'bazframe-captured-profile',resources:[['library','local-library'],['package','local-package'],['skill','added-skill'],['skill','physical-skill']].map(([kind,name])=>({key:{kind,name},payload:{sourceForm:'profile-local',files:[{path:'run.sh',executable:true}]}}))});
    const originalLoad=Module._load;
    Module._load=function(name,...rest){if(name!=='yauzl')return originalLoad.call(this,name,...rest);return {open(_path,_opts,callback){if(mode==='zip-open'){queueMicrotask(()=>callback(Error('ZIP open EIO')));return;}const zip=new EventEmitter();let index=0,closed=false;zip.close=()=>{if(!closed){closed=true;queueMicrotask(()=>zip.emit('close'));}};zip.readEntry=()=>queueMicrotask(()=>{if(mode==='zip-close'){zip.close();return;}const fileName=Object.keys(payloads)[index++];if(fileName)zip.emit('entry',{fileName,externalFileAttributes:0});else {zip.emit('end');zip.close();}});zip.openReadStream=(entry,cb)=>{if(mode==='zip-read'){cb(Error('ZIP read EIO'));return;}const stream=new PassThrough();cb(null,stream);queueMicrotask(()=>{if(mode==='zip-stream')stream.destroy(Error('ZIP stream EIO'));else if(mode==='zip-premature')stream.destroy();else stream.end(Buffer.from(payloads[entry.fileName]));});};queueMicrotask(()=>callback(null,zip));}}};
    let heldResolve,spawnCount=0,cliCount=0;const held=new Promise(resolve=>heldResolve=resolve),children=[];
    workerThreads.MessageChannel=class{constructor(){this.port1=new EventEmitter();this.port2=new EventEmitter();this.port1.ref=()=>heldResolve();}};
    const originalWrite=fs.writeFileSync;
    filesystem.writeFileSync=(path,...args)=>{if(mode==='zip-receipt'&&String(path).endsWith('zip-contents.json'))throw Error('ZIP required receipt EIO');return originalWrite(path,...args)};
    childProcess.spawn=(_file,args)=>{spawnCount++;const child=new EventEmitter();children.push(child);child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=42;
      queueMicrotask(()=>{let output='';if(args[1]==='--version')output='fixture\n';else if(args[1]==='install'){
        for(const [name,bytes]of Object.entries(members)){const path=join(paths.packageRoot,name);fs.mkdirSync(dirname(path),{recursive:true});fs.writeFileSync(path,bytes);}
        const piRoot=join(paths.modules,'@earendil-works/pi-coding-agent');fs.mkdirSync(join(piRoot,'dist/bundle'),{recursive:true});fs.writeFileSync(join(piRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'0.84.4',exports:{'.':{import:'./dist/index.js'}},bin:{pi:'dist/bundle/cli.js'}}));fs.writeFileSync(join(piRoot,'dist/bundle/cli.js'),'not executed');
        fs.mkdirSync(paths.bin);for(const alias of ['bazframe','bzf'])fs.symlinkSync(join(paths.packageRoot,'dist/cli.js'),join(paths.bin,alias));
      }else if(args[1]==='query'){
        output=JSON.stringify([...h.installedPackages(paths.modules)].map(([path,m])=>({path,realpath:path,location:path.slice(prefix.length+1),name:m.name,version:m.version,from:[],to:[],resolved:m.name==='bazframe'?'file:'+archive:'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.4.tgz'})));
        if(mode==='zip-admission')fs.writeFileSync(zipInput,'changed external input');
      }else {cliCount++;throw Error('Unexpected CLI effect');}
      child.stdout.end(output);child.stderr.end();child.emit('exit',0,null);child.emit('close',0,null);});return child;};
    syncBuiltinESMExports();process.stderr.write=()=>true;
    let settled=false;void batches.runCandidate(options).then(()=>settled=true);await held;await Promise.resolve();
    const hold=h.retainedCandidateHolds.at(-1);assert(hold.error instanceof h.CandidateUncertainty);assert(hold.owners.includes(children[0]));assert.equal(settled,false);assert.equal(cliCount,0);assert.equal(spawnCount,3);
    const report=h.jsonFile(join(execution,'results.json'));assert.equal(report.cells.length,1);assert.equal(report.cells[0].operations.find(x=>x.operation==='admit-reviewed-zip').status,'uncertain');assert(!fs.existsSync(join(execution,'bzf-zip')));
  `));

  it.each(['callback-lstat', 'callback-realpath', 'absence-EIO'])('actual runCandidate retains original owners and stops later cells on %s', async failure => probe(String.raw`
    import filesystem from 'node:fs';import childProcess from 'node:child_process';import workerThreads from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';import{PassThrough}from'node:stream';
    const mode=${JSON.stringify(failure)},execution=join(root,'new-root'),prefix=join(execution,'prefix'),paths=h.installationPaths(prefix,'local');
    const batch=mode==='absence-EIO'?'dispatch':'resources',cell=join(execution,'bazframe-'+batch);
    options[options.indexOf('--batch')+1]=batch;
    const npm=join(root,'npm','npm-cli.js');fs.mkdirSync(dirname(npm));fs.writeFileSync(npm,'npm boundary');fs.writeFileSync(join(dirname(npm),'package.json'),JSON.stringify({name:'npm',version:'fixture'}));options[options.indexOf('--npm-cli')+1]=npm;fs.writeFileSync(join(root,'scope.json'),'external scope');
    let heldResolve,cliCount=0,callbackReached=false;const held=new Promise(resolve=>heldResolve=resolve),children=[];
    workerThreads.MessageChannel=class{constructor(){this.port1=new EventEmitter();this.port2=new EventEmitter();this.port1.ref=()=>heldResolve();}};
    const failure=Object.assign(Error('callback metadata EIO'),{code:'EIO'}),originalStat=fs.lstatSync,originalRealpath=fs.realpathSync,originalWrite=fs.writeFileSync;
    filesystem.writeFileSync=(path,...args)=>{const result=originalWrite(path,...args);if(String(path).endsWith('-skill-first-add.disk.json'))callbackReached=true;return result;};
    filesystem.lstatSync=(path,...args)=>{if((mode==='callback-lstat'&&callbackReached&&path===join(cell,'home','skills','added-skill'))||(mode==='absence-EIO'&&cliCount===10&&path===join(cell,'pi')))throw failure;return originalStat(path,...args);};
    filesystem.realpathSync=(path,...args)=>{if(mode==='callback-realpath'&&callbackReached&&path===join(cell,'home','skills','added-skill'))throw failure;return originalRealpath(path,...args);};
    childProcess.spawn=(_file,args,opts)=>{const child=new EventEmitter();children.push(child);child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=42;
      queueMicrotask(()=>{let output='',code=0;if(args[1]==='--version')output='fixture\n';else if(args[1]==='install'){
        for(const [name,bytes]of Object.entries(members)){const path=join(paths.packageRoot,name);fs.mkdirSync(dirname(path),{recursive:true});fs.writeFileSync(path,bytes);}
        const piRoot=join(paths.modules,'@earendil-works/pi-coding-agent');fs.mkdirSync(join(piRoot,'dist/bundle'),{recursive:true});fs.writeFileSync(join(piRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'0.84.4',exports:{'.':{import:'./dist/index.js'}},bin:{pi:'dist/bundle/cli.js'}}));fs.writeFileSync(join(piRoot,'dist/bundle/cli.js'),'not executed');
        fs.mkdirSync(paths.bin);for(const alias of ['bazframe','bzf'])fs.symlinkSync(join(paths.packageRoot,'dist/cli.js'),join(paths.bin,alias));
      }else if(args[1]==='query'){
        output=JSON.stringify([...h.installedPackages(paths.modules)].map(([path,m])=>({path,realpath:path,location:path.slice(prefix.length+1),name:m.name,version:m.version,from:[],to:[],resolved:m.name==='bazframe'?'file:'+archive:'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.4.tgz'})));
      }else {cliCount++;
        if(batch==='resources'){
          assert.deepEqual(args,['skill','add',join(cell,'sources','added-skill')]);fs.mkdirSync(join(opts.env.BAZFRAME_HOME,'skills'),{recursive:true});fs.symlinkSync(args[2],join(opts.env.BAZFRAME_HOME,'skills','added-skill'),'junction');output='Default skill registration: added';
        }else if(!args.includes('--json'))output=args[0]==='--version'?'Bazframe fixture\n':'<zip|git:user/repository>';
        else {code=2;output=JSON.stringify({schemaVersion:1,ok:false,error:{code:args[0]==='profiles'?'CLI_MIGRATION_REQUIRED':args[0]==='not-a-command'?'CLI_USAGE':'CLI_JSON_UNSUPPORTED',message:args[0]==='profiles'?'This command was removed. Use \`bazframe profile list\` instead.':'expected refusal'}});}
      }
      child.stdout.end(output);child.stderr.end();child.emit('exit',code,null);child.emit('close',code,null);});return child;};
    syncBuiltinESMExports();process.stderr.write=()=>true;
    let settled=false;const done=batches.runCandidate(options).then(()=>settled=true);await Promise.race([held,done]);await Promise.resolve();assert.equal(settled,false);
    const hold=h.retainedCandidateHolds.at(-1);assert(hold.error instanceof h.CandidateUncertainty);assert.equal(hold.error.cause,failure);assert.deepEqual(hold.owners,children);assert.equal(children.length,mode==='absence-EIO'?13:4);
    const report=h.jsonFile(join(execution,'results.json'));assert.equal(report.cells.length,1);
    const operation=mode==='absence-EIO'?'no-managed-bootstrap':'skill-first-add',rows=report.cells[0].operations,index=rows.findIndex(r=>r.operation===operation);assert.equal(rows[index].status,'uncertain');assert(rows.slice(index+1).every(r=>r.status==='not-run'));assert(!fs.existsSync(join(execution,'bzf-'+batch)));assert(fs.existsSync(archive));
  `));

  it('keeps observed metadata absence, presence and wrong targets as ordinary domain assertions', async () => probe(String.raw`
    import filesystem from 'node:fs';import{syncBuiltinESMExports}from'node:module';
    const c={root,home:join(root,'home'),cwd:root,environment:{PI_CODING_AGENT_DIR:join(root,'pi')},executable:'/unused'};
    const absent=batches.dispatchSteps(c).find(s=>s.name==='no-managed-bootstrap');await absent.run();
    fs.mkdirSync(c.environment.PI_CODING_AGENT_DIR);let rows=[];assert.equal(await h.runSteps([absent],rows,()=>{}),false);assert.equal(rows[0].status,'failed');assert.match(rows[0].error,/Expected absent/);
    const steps=batches.resourceSteps(c),step=steps.find(s=>s.name==='skill-first-add');await steps[0].run();
    c.run=async()=>({evidence:join(root,'metadata-domain'),stdout:Buffer.from('Default skill registration: added'),stderr:Buffer.alloc(0),code:0,signal:null,ioErrors:[],events:[{event:'exit',code:0,signal:null},{event:'close',code:0,signal:null}]});
    rows=[];assert.equal(await h.runSteps([step],rows,()=>{}),false);assert.equal(rows[0].status,'failed');assert.match(rows[0].error,/Expected existing metadata/);
    fs.mkdirSync(join(c.home,'skills'),{recursive:true});fs.symlinkSync(c.library,join(c.home,'skills','added-skill'),'junction');
    rows=[];assert.equal(await h.runSteps([step],rows,()=>{}),false);assert.equal(rows[0].status,'failed');assert.match(rows[0].error,/AssertionError/);
    const original=fs.realpathSync;filesystem.realpathSync=(path,...args)=>{if(path===join(c.home,'skills','added-skill'))throw Object.assign(Error('Observed missing link target'),{code:'ENOENT'});return original(path,...args);};syncBuiltinESMExports();
    rows=[];assert.equal(await h.runSteps([step],rows,()=>{}),false);assert.equal(rows[0].status,'failed');assert.match(rows[0].error,/Expected existing metadata/);
  `));

  it('types asynchronous roundtrip receipt failures but not fully observed payload mismatch', async () => probe(String.raw`
    import filesystem from 'node:fs';import Module,{syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';
    const original=Module._load;Module._load=function(name,...rest){if(name!=='yauzl')return original.call(this,name,...rest);return {open(_a,_b,cb){const zip=new EventEmitter();zip.readEntry=()=>queueMicrotask(()=>{zip.emit('end');zip.emit('close')});cb(null,zip);}}};
    const c={root,home:join(root,'home'),cwd:root,environment:{},executable:'/unused',packageRoot:root,zip:join(root,'external.zip')};
    c.run=async()=>({evidence:join(root,'reexport'),stdout:Buffer.from(JSON.stringify({schemaVersion:2,command:'profile.export',outcome:'success'})),stderr:Buffer.alloc(0),code:0,signal:null,ioErrors:[],events:[{event:'exit',code:0,signal:null},{event:'close',code:0,signal:null}]});
    const step=batches.zipSteps(c).find(s=>s.name==='zip-reexport');
    const write=fs.writeFileSync;filesystem.writeFileSync=(path,...args)=>{if(String(path).endsWith('roundtrip-contents.json'))throw Error('roundtrip EIO');return write(path,...args)};syncBuiltinESMExports();
    await assert.rejects(step.run(),h.CandidateUncertainty);
    filesystem.writeFileSync=write;syncBuiltinESMExports();const rows=[];assert.equal(await h.runSteps([step,{name:'dependent',run:()=>assert.fail('continued')}],rows,()=>{}),false);assert.equal(rows[0].status,'failed');assert.match(rows[0].error,/Canonical ZIP payload/);
  `));

  it('preserves ordinary settled branch failure and exact natural exit7 rather than treating all failures as uncertainty', async () => probe(`
    const rows=[],calls=[];assert.equal(await h.runSteps([{name:'domain',run:()=>{throw Error('state assertion')}},{name:'dependent',run:()=>calls.push('bad')}],rows,()=>{}),false);
    assert.deepEqual(rows.map(x=>x.status),['failed','not-run']);assert.deepEqual(calls,[]);
    const c={root,home:join(root,'home'),cwd:root,environment:{},executable:'/unused'};const step=batches.resourceSteps(c).find(s=>s.name==='package-build-refusal');
    c.run=async()=>({evidence:join(root,'uncertain-build'),stdout:Buffer.from(JSON.stringify({schemaVersion:1,ok:false,command:'package.build',error:{code:'PACKAGE_BUILD_FAILED',message:'Package build timed out.'}})),stderr:Buffer.alloc(0),code:1,signal:null,ioErrors:[],events:[{event:'exit',code:1,signal:null},{event:'close',code:1,signal:null}]});
    await assert.rejects(step.run(),h.CandidateUncertainty);
  `));

  it('inventories dangling links as retained entries rather than absence', async () => probe(`
    const link=join(root,'dangling');fs.symlinkSync(join(root,'missing-target'),link,'junction');
    assert.equal(h.inventory(link)[''].kind,'link');
    const candidate=h.admitCandidate(archive,digest,nativeDigest);
    assert.throws(()=>h.verifyInstalled(link,candidate),/member set differs/);
  `));
});
