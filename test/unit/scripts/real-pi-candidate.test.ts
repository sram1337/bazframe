import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDirectory } from '../../helpers/temp-directory.js';

const modulePath = join(process.cwd(), 'scripts/test-real-pi-candidate.mjs');
const entry = join(process.cwd(), 'scripts/test-real-pi.mjs');
const setup = `
import assert from 'node:assert/strict';
import fs from 'node:fs';import {join,dirname} from 'node:path';
import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
const root=fs.realpathSync(process.argv[1]);
const child=new EventEmitter();child.pid=123;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
child.kill=()=>{throw Error('FORBIDDEN_KILL')};
let spawns=0;childProcess.spawn=()=>{spawns++;return child};syncBuiltinESMExports();
const h=await import(${JSON.stringify(modulePath)});
const owners=[],evidence=join(root,'rpc');
const start=(version)=>h.startRetainedRpc({invocation:{file:'/admitted/node',args:['/admitted/pi','--mode','rpc']},cwd:root,env:{HOME:root},evidence,owners,lifetime:{version,shutdown:'unit boundary only, not a runtime binding'}});
const emit=record=>child.stdout.write(Buffer.from(JSON.stringify(record)+'\\n'));
const response=(n,type,data={})=>emit({type:'response',id:'candidate-'+n,command:type,success:true,data});
const endStreams=async()=>{await Promise.all([child.stdout,child.stderr].map(stream=>stream.readableEnded?Promise.resolve():new Promise(done=>{stream.once('end',done);stream.end()})))};
const finish=async(code=0)=>{await endStreams();child.emit('exit',code,null);child.emit('close',code,null)};
const idle={isStreaming:false,isCompacting:false,pendingMessageCount:0};
`;
async function probe(code: string) {
  const dir = await createTempDirectory('pi candidate seam ');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', setup + code, dir.path()], { encoding: 'utf8', shell: false });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).toBe('');
  } finally { await dir.cleanup(); }
}

describe('retained exact-candidate Pi seams (no installed Pi execution)', () => {
  it('accepts actual deprecated usage refusals and retains diagnostic/state checks', () => probe(String.raw`
    const home=join(root,'home');fs.mkdirSync(home);fs.writeFileSync(join(home,'state'),'unchanged');
    let mode='correct',calls=[];
    const c={root,home,repository:root,cwd:root,imported:'alpha-1',executable:'/bound/bzf',env:{BAZFRAME_HOME:home,PI_CODING_AGENT_DIR:join(root,'pi')},revalidate:()=>{},run:async(label,invocation)=>{
      const args=invocation.args;calls.push(args);
      const refusal=args.includes('--session')||args.includes('--json');
      const code=refusal?2:0;
      if(mode==='state'&&args.includes('--session'))fs.writeFileSync(join(home,'state'),'changed');
      const text=args.includes('--dry-run')?'--- effective instructions ---\nALPHA_BODY\n\n--- end effective instructions ---\nWould launch executable: pi':args.includes('--session')?(mode==='diagnostic'?'wrong':'not supported'):args.includes('--json')?'CLI_JSON_UNSUPPORTED':'';
      return{evidence:join(root,label),stdout:Buffer.from(text),stderr:Buffer.alloc(0),code,signal:null,ioErrors:[],events:[{event:'exit',code,signal:null},{event:'close',code,signal:null}]};
    }};
    const step=h.piJourneySteps(c).find(s=>s.name==='deprecated-dry-run-and-forwarding-refusals');
    await step.run();assert.equal(calls.length,4);
    mode='diagnostic';await assert.rejects(step.run(),/Missing diagnostic/);
    mode='state';await assert.rejects(step.run(),/Read\/refusal changed state/);assert.equal(spawns,0);
  `));

  it.each(['win32', 'linux'])('requires actual deprecated positive and nonzero outcomes on %s, not a Windows not-run waiver', platform => probe(String.raw`
    Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
    const home=join(root,'home'),capture=join(root,'capture.jsonl'),tmp=join(root,'tmp'),repository=join(root,'repository');
    for(const path of [home,tmp,repository])fs.mkdirSync(path);let calls=0,cleanupError=false;
    const body=Buffer.from('ALPHA_BODY\nexact source path and trailing newline\n');
    const temporary=join(tmp,'bazframe-profile-dry-run-'+'a'.repeat(32),'.baz.agents.md');
    if(process.platform==='win32'){fs.mkdirSync(dirname(temporary));fs.writeFileSync(temporary,body);}
    const c={root,home,repository,cwd:root,imported:'alpha-1',executable:process.platform==='win32'?'C:\\bound\\bzf.cmd':'/bound/bzf',launch:{kind:'genuine-pi-shim',file:join(root,'pi.cmd')},env:{BAZFRAME_HOME:home,PI_CODING_AGENT_DIR:join(root,'pi'),BAZFRAME_PI_PROBE_CAPTURE:capture,TMPDIR:tmp,PATH:'/bound',ComSpec:'C:\\Windows\\System32\\cmd.exe'},revalidate:()=>{},run:async(label,invocation)=>{
      calls++;const args=invocation.args.join(' '),nonzero=args.includes('candidate-invalid'),refusal=args.includes('--session')||args.includes('--json'),launch=args.includes('--print'),code=refusal?2:nonzero?1:0;
      if(launch&&!nonzero)fs.appendFileSync(capture,JSON.stringify({systemPrompt:'ALPHA_BODY'})+String.fromCharCode(10));
      const stdout=args.includes('--dry-run')?Buffer.concat([Buffer.from('--- effective instructions ---\n'),body,Buffer.from('\n--- end effective instructions ---\nWould launch executable: pi')]):Buffer.from(refusal?(args.includes('--json')?'CLI_JSON_UNSUPPORTED':'not supported'):nonzero?'Invalid TUI mode':'probe-ok');
      return{evidence:join(root,label),stdout,stderr:Buffer.from('Effective instructions file: '+temporary+'\n'+(nonzero?'Error: Invalid TUI mode "candidate-invalid". Valid values: regular, fullscreen\n':'')+(cleanupError?'error: Windows private Git effects refused: retained directory identity changed.\n':'')),code,signal:null,ioErrors:[],events:[{event:'exit',code,signal:null},{event:'close',code,signal:null}]};
    }};
    const steps=h.piJourneySteps(c);
    await steps.find(s=>s.name==='deprecated-dry-run-and-forwarding-refusals').run();
    for(const name of ['deprecated-real-launch-and-natural-exit','deprecated-natural-nonzero-propagation']){
      const result=await steps.find(s=>s.name===name).run();assert.notEqual(result.status,'not-run');assert(result.evidence);
      assert.equal(result.cleanup.disposition,process.platform==='win32'?'retained':'removed');
      if(process.platform==='win32'){assert.equal(result.cleanup.bytes,body.length);assert.equal(result.cleanup.observedIdentity.length,3);assert.deepEqual(fs.readFileSync(temporary),body);}
    }
    assert.equal(calls,6);assert(!steps.some(s=>s.name==='deprecated-current-Windows-shim-refusal'));
    if(process.platform==='win32'){cleanupError=true;await assert.rejects(steps.find(s=>s.name==='deprecated-natural-nonzero-propagation').run(),/launcher\/disposal error/);}
    assert.equal(spawns,0);
  `));

  it.each(['bytes', 'newline', 'missing', 'outside-tmp', 'inside-repository', 'wrong-leaf', 'wrong-workspace', 'directory', 'hardlink', 'symlink', 'parent-symlink', 'changed-identity', 'no-dry-run'])('refuses unsafe or unproved Windows retained instructions: %s', fault => probe(String.raw`
    const fault=${JSON.stringify(fault)},tmp=join(root,'tmp'),repository=join(root,'repository');
    fs.mkdirSync(tmp);fs.mkdirSync(repository);
    let directory=join(tmp,'bazframe-profile-dry-run-'+'b'.repeat(32));
    if(fault==='outside-tmp')directory=join(root,'bazframe-profile-dry-run-'+'b'.repeat(32));
    if(fault==='wrong-workspace')directory=join(tmp,'other-owner');
    fs.mkdirSync(directory);
    const path=join(directory,fault==='wrong-leaf'?'other.md':'.baz.agents.md'),body=Buffer.from('ALPHA_BODY\n/source/AGENTS.md\n');
    if(fault==='directory')fs.mkdirSync(path);
    else if(fault!=='missing')fs.writeFileSync(path,fault==='bytes'?Buffer.from('ALPHA_BODY\n/forged/AGENTS.md\n'):fault==='newline'?body.subarray(0,body.length-1):body);
    if(fault==='hardlink')fs.linkSync(path,join(root,'extra-link'));
    if(fault==='symlink'){fs.renameSync(path,join(root,'target'));fs.symlinkSync(join(root,'target'),path);}
    if(fault==='parent-symlink'){fs.renameSync(directory,join(root,'target-dir'));fs.symlinkSync(join(root,'target-dir'),directory,'junction');}
    if(fault==='changed-identity'){
      const original=fs.lstatSync;let reads=0;
      fs.lstatSync=(entry,options)=>{const stat=original(entry,options);if(entry===path&&++reads===2)stat.ino+=1n;return stat};syncBuiltinESMExports();
    }
    assert.throws(()=>h.assertDeprecatedTemporaryDisposition(Buffer.from('Effective instructions file: '+path+'\n'),{
      temporaryRoot:tmp,repository:fault==='inside-repository'?root:repository,expectedBody:fault==='no-dry-run'?undefined:body
    },'win32'),/instruction|ENOENT/i);
    assert.equal(spawns,0);
  `));

  it('keeps POSIX removal mandatory and dry-run framing byte-exact', () => probe(String.raw`
    const path=join(root,'retained'),stderr=Buffer.from('Effective instructions file: '+path+'\r\n');
    fs.writeFileSync(path,'retained');assert.throws(()=>h.assertDeprecatedTemporaryDisposition(stderr,{},'linux'),/should remove/);
    fs.renameSync(path,join(root,'kept-elsewhere'));assert.equal(h.assertDeprecatedTemporaryDisposition(stderr,{},'linux').fileAbsent,true);
    const body=Buffer.from('ALPHA_BODY\n/source/AGENTS.md\r\n\n'),opening=Buffer.from('--- effective instructions ---\n'),closing=Buffer.from('\n--- end effective instructions ---\n');
    assert.deepEqual(h.deprecatedDryRunBody(Buffer.concat([opening,body,closing])),body);
    for(const invalid of [body,Buffer.concat([opening,body]),Buffer.concat([opening,body,closing,opening,body,closing])])assert.throws(()=>h.deprecatedDryRunBody(invalid),/body/);
    assert.throws(()=>h.assertDeprecatedTemporaryDisposition(Buffer.alloc(0),{},'linux'),/path/);
  `));

  it('decodes LF-only JSONL across UTF8 splits and preserves Unicode separators', () => probe(`
    const rows=[],decoder=h.jsonlDecoder(row=>rows.push(row));
    const value={body:'x\u2028y\u2029é'};const bytes=Buffer.from(JSON.stringify(value)+'\\r\\n');
    for(const byte of bytes)decoder.push(Buffer.from([byte]));decoder.end();assert.deepEqual(rows,[value]);
    const incomplete=h.jsonlDecoder(()=>{});incomplete.push(Buffer.from('{}'));assert.throws(()=>incomplete.end(),/Unterminated/);
    assert.throws(()=>h.jsonlDecoder(()=>{}).push(Buffer.from('not-json\\n')));
  `));

  it('uses one disposal promise through late output, close and receipt I/O; never kills', () => probe(`
    const rpc=start();const pending=rpc.request({type:'get_state'});response(1,'get_state',idle);await pending;
    const disposal=rpc.close();assert.equal(disposal,rpc.close());assert.equal(disposal,owners[0].disposal);assert(child.stdin.writableEnded);
    let settled=false;disposal.then(()=>{settled=true});child.emit('exit',0,null);await Promise.resolve();assert.equal(settled,false);
    child.stderr.write(Buffer.from([0,255,10]));emit({type:'extension_ui_request',method:'notify',message:'late\u2028output'});
    await endStreams();child.emit('close',0,null);await disposal;
    assert.equal(owners[0].child,child);assert.deepEqual(fs.readFileSync(evidence+'.stderr'),Buffer.from([0,255,10]));
    const receipt=JSON.parse(fs.readFileSync(evidence+'.result.json'));assert.equal(receipt.descendantSettlement,'not-established');assert.deepEqual(receipt.events.map(e=>e.event),['exit','close']);
  `));

  it('waits for provider settlement separately from prompt acceptance', () => probe(`
    const rpc=start();let done=false;const p=rpc.prompt('hello').then(()=>{done=true});
    response(1,'prompt');await Promise.resolve();await Promise.resolve();assert.equal(done,false);
    emit({type:'agent_start'});emit({type:'agent_settled'});await p;
    const state=rpc.request({type:'get_state'});response(2,'get_state',idle);await state;
    const closed=rpc.close();finish();await closed;
  `));

  it.each(['response-first', 'settlement-first'])('requires current started acceptance AND settlement: %s', order => probe(`
    const rpc=start('1.5.2');let complete=false;const work=rpc.prompt('offline model').then(()=>complete=true);
    if(${JSON.stringify(order)}==='response-first')response(1,'prompt',{disposition:'started'});else emit({type:'agent_settled'});
    await new Promise(setImmediate);assert(!complete);
    if(${JSON.stringify(order)}==='response-first')emit({type:'agent_settled'});else response(1,'prompt',{disposition:'started'});
    await work;assert(!child.stdin.writableEnded);
    const disposal=rpc.finish();response(2,'get_state',idle);await new Promise(setImmediate);assert(child.stdin.writableEnded);await finish();await disposal;
  `));
  it('accepts current handled commands without agent events but still requires fresh correlated idle', () => probe(`
    const rpc=start('1.5.2');const command=rpc.command('/bazframe reload');response(1,'prompt',{disposition:'handled'});await command;
    assert.equal(rpc.records.filter(row=>row.type==='agent_settled').length,0);assert(!child.stdin.writableEnded);
    const disposal=rpc.finish();await new Promise(setImmediate);assert(!child.stdin.writableEnded);
    response(2,'get_state',idle);await new Promise(setImmediate);assert(child.stdin.writableEnded);await finish();await disposal;
  `));
  it.each(['handled', 'queued', 'missing', 'unknown', 'refused'])('rejects current model prompt %s immediately without waiting for nonexistent settlement or sending EOF', disposition => probe(`
    const rpc=start('1.5.2');const rejected=assert.rejects(rpc.prompt('offline model'),/disposition|refusal/);
    const disposition=${JSON.stringify(disposition)};
    if(disposition==='refused')emit({type:'response',id:'candidate-1',command:'prompt',success:false,error:'no'});
    else response(1,'prompt',disposition==='missing'?{}:{disposition});
    await rejected;await assert.rejects(rpc.finish());assert(!child.stdin.writableEnded);assert.equal(owners[0].child,child);
    await finish();await assert.rejects(owners[0].disposal);
  `));
  it.each(['started', 'queued'])('rejects unexpected current command disposition %s and retains the owner', disposition => probe(`
    const rpc=start('1.5.2');const rejected=assert.rejects(rpc.command('/bazframe info'),/Unexpected prompt disposition/);
    response(1,'prompt',{disposition:${JSON.stringify(disposition)}});await rejected;await assert.rejects(rpc.finish());assert(!child.stdin.writableEnded);
    await finish();await assert.rejects(owners[0].disposal);
  `));

  it.each(['stdin', 'stdout', 'stderr', 'child'])('rejects requests on %s error and preserves uncertain ownership', stream => probe(`
    const rpc=start();const p=rpc.request({type:'get_commands'});const observed=assert.rejects(p,/broken/);
    ${stream === 'child' ? 'child' : `child.${stream}`}.emit('error',Error('broken'));
    await observed;const disposal=rpc.close();const rejected=assert.rejects(disposal,/broken/);
    assert.equal(child.stdin.writableEnded,false);assert.equal(owners[0].child,child);
    finish();await rejected;assert(fs.readFileSync(evidence+'.result.json','utf8').includes('uncertainty'));
  `));

  it('rejects unexpected dialogs without sending cancellation or EOF', () => probe(`
    const rpc=start();let input='';child.stdin.on('data',b=>input+=b);
    const p=rpc.request({type:'get_commands'});const rejection=assert.rejects(p,/Unexpected RPC/);
    emit({type:'extension_ui_request',id:'dialog',method:'confirm'});await rejection;
    assert(!input.includes('extension_ui_response'));const closed=rpc.close();const rejected=assert.rejects(closed,/Unexpected RPC/);assert(!child.stdin.writableEnded);finish();await rejected;
  `));

  it('rejects pending requests at natural close, not early exit before buffered response', () => probe(`
    const rpc=start();const p=rpc.request({type:'get_commands'});child.emit('exit',0,null);response(1,'get_commands',{commands:[]});await p;
    await endStreams();child.emit('close',0,null);await rpc.close();
    assert.equal(owners.length,1);
  `));

  it('retains unanswered request uncertainty and refuses new requests after close', () => probe(`
    const rpc=start();const p=rpc.request({type:'get_commands'});const rejected=assert.rejects(p,/pending requests/);finish();await rejected;
    await assert.rejects(rpc.close(),/pending requests/);await assert.rejects(rpc.request({type:'get_state'}));
  `));

  it('refuses unsafe disposal while a request is pending instead of fabricating completion', () => probe(`
    const rpc=start();const p=rpc.request({type:'get_commands'});const rejected=assert.rejects(p,/No safe idle/);
    const closed=rpc.close();const closeRejected=assert.rejects(closed,/No safe idle/);await rejected;assert(!child.stdin.writableEnded);
    finish();await closeRejected;
  `));

  it.each(['malformed', 'unterminated', 'unmatched', 'mismatch', 'refusal', 'provider-error', 'record-shape'])('retains protocol failure: %s', scenario => probe(`
    const rpc=start();const p=rpc.request({type:'get_commands'});const rejected=assert.rejects(p);
    const scenario=${JSON.stringify(scenario)};
    if(scenario==='malformed')child.stdout.write('invalid\\n');
    if(scenario==='record-shape')emit([]);
    if(scenario==='unterminated'){child.stdout.write('{}');child.stdout.end();}
    if(scenario==='unmatched')response(99,'get_commands');
    if(scenario==='mismatch')response(1,'get_state');
    if(scenario==='refusal')emit({type:'response',id:'candidate-1',command:'get_commands',success:false,error:'refused'});
    if(scenario==='provider-error')emit({type:'message_end',message:{role:'assistant',stopReason:'error'}});
    await rejected;const closed=rpc.close();const closeRejected=assert.rejects(closed);finish();await closeRejected;
  `));

  it.each(['output', 'receipt'])('keeps %s I/O failure visible through disposal', where => probe(`
    const rpc=start();const p=rpc.request({type:'get_state'});response(1,'get_state',idle);await p;
    const original=${where === 'output' ? 'fs.appendFileSync' : 'fs.writeFileSync'};
    ${where === 'output' ? "fs.appendFileSync=(path,...args)=>{if(path.endsWith('.stdout'))throw Error('disk full');return original(path,...args)}" : "fs.writeFileSync=(path,...args)=>{if(path.endsWith('.result.json'))throw Error('receipt disk full');return original(path,...args)}"};syncBuiltinESMExports();
    ${where === 'output' ? "emit({type:'extension_ui_request',method:'notify',message:'output'})" : ''};
    const closed=rpc.close();const rejected=assert.rejects(closed,/disk full/);finish();await rejected;
    assert(owners[0].receipt.errors.some(e=>e.includes('disk full')));assert(!child.stdin.writableEnded);
  `));

  it('preserves a check assertion and obtains fresh idle before normal RPC disposal', () => probe(`
    const rpc=start(),failure=new assert.AssertionError({actual:['inspect'],expected:['update'],operator:'deepStrictEqual'});
    let caught;const checked=h.checkRetainedRpc(rpc,evidence,async()=>{
      await rpc.request({type:'get_state'});await rpc.request({type:'prompt',message:'/bazframe info'});throw failure;
    }).catch(error=>{caught=error});
    response(1,'get_state',idle);await new Promise(setImmediate);
    response(2,'prompt');await new Promise(setImmediate);
    assert.deepEqual(owners[0].receipt.requests.map(row=>row.type),['get_state','prompt','get_state']);
    response(3,'get_state',idle);await new Promise(setImmediate);assert(child.stdin.writableEnded);
    await finish();await checked;assert.equal(caught,failure);
    const saved=JSON.parse(fs.readFileSync(evidence+'.check-error.json'));
    assert.equal(saved.code,'ERR_ASSERTION');assert.deepEqual(saved.actual,['inspect']);assert.deepEqual(saved.expected,['update']);assert.equal(saved.stack,failure.stack);
  `));

  it.each(['busy', 'refused'])('reports %s final idle proof without waiting on a live RPC disposal', mode => probe(`
    const rpc=start(),failure=Error('check failed');let caught,completed=false;
    const checked=h.checkRetainedRpc(rpc,evidence,async()=>{throw failure}).catch(error=>{caught=error;completed=true});
    await new Promise(setImmediate);
    assert.deepEqual(owners[0].receipt.requests.map(row=>row.type),['get_state']);
    if(${JSON.stringify(mode)}==='busy')response(1,'get_state',{...idle,isStreaming:true});
    else emit({type:'response',id:'candidate-1',command:'get_state',success:false,error:'refused'});
    await new Promise(setImmediate);assert(completed,'Uncertain finalization must return ownership, not wait for natural close');await checked;
    assert.equal(caught.name,'CandidateUncertainty');assert(!child.stdin.writableEnded);assert.equal(owners[0].child,child);
    assert.equal(JSON.parse(fs.readFileSync(evidence+'.check-error.json')).message,failure.message);
    let disposed=false;owners[0].disposal.catch(()=>{disposed=true});await Promise.resolve();assert(!disposed);
    await finish();await assert.rejects(owners[0].disposal);assert(disposed);
  `));

  it.each(['request', 'settlement'])('keeps pending %s ownership despite an idle response during finalization', kind => probe(`
    const rpc=start(),kind=${JSON.stringify(kind)};
    const work=kind==='settlement'?rpc.prompt('pending model'):rpc.request({type:'get_commands'});
    const workRejected=assert.rejects(work);if(kind==='settlement')response(1,'prompt');
    const checked=assert.rejects(h.checkRetainedRpc(rpc,evidence,async()=>{throw Error('local assertion')}),/No safe idle/);
    await new Promise(setImmediate);response(2,'get_state',idle);await checked;await workRejected;
    assert(!child.stdin.writableEnded);assert.equal(owners[0].child,child);
    await finish();await assert.rejects(owners[0].disposal);
  `));

  it('binds EOF to exact selected version and executed bundled bytes', () => probe(`
    const rootPi=${JSON.stringify(join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent'))};
    const manifest=join(rootPi,'package.json'),installed=JSON.parse(fs.readFileSync(manifest,'utf8'));
    const reviewed=[h.reviewedRpc,h.reviewedRpc087,h.reviewedRpc152].find(candidate=>candidate.version===installed.version);
    assert(reviewed,'Installed Pi needs its own reviewed EOF lifetime binding');
    const pi={version:installed.version,manifest,binPaths:{pi:join(rootPi,installed.bin.pi)}};
    const binding=h.bindRpcLifetime(pi);assert.equal(binding.version,installed.version);assert.equal(binding.files,reviewed.files);
    assert.throws(()=>h.bindRpcLifetime({...pi,version:'0.99.0'}),/own reviewed/);
    assert.throws(()=>h.bindRpcLifetime({...pi,binPaths:{pi:'/personal/pi'}}),/Unreviewed/);
    const fake=join(root,'changed-pi');fs.mkdirSync(fake);for(const [name]of Object.entries(reviewed.files)){fs.mkdirSync(dirname(join(fake,name)),{recursive:true});fs.copyFileSync(join(rootPi,name),join(fake,name));}
    fs.appendFileSync(join(fake,'dist/bundle/cli.js'),'changed');
    assert.throws(()=>h.bindRpcLifetime({...pi,manifest:join(fake,'package.json'),binPaths:{pi:join(fake,'dist/bundle/cli.js')}}),/Unreviewed RPC bytes/);assert.equal(spawns,0);
  `));

  it('keeps separate 0.87 graph pins and enforces every reviewed file (synthetic bytes only)', () => probe(`
    const {createHash}=await import('node:crypto');
    const pins=h.reviewedRpc087.files,names=Object.keys(pins),fake=join(root,'pi-087');
    assert.equal(names.length,70);assert.equal(names.filter(name=>name.startsWith('dist/bundle/')).length,56);
    for(const name of ['dist/bundle/cli-runtime.js','dist/bundle/chunks/virtual-modules-BNWPZYDH.js','dist/bundle/chunks/jiti-loader-C3NU2SDH.js','dist/bundle/chunks/chunk-4DKZACXI.js','dist/bundle/chunks/chunk-RCZIEVGO.js'])assert(names.includes(name));
    // Only this isolated fake child changes its in-memory expected hashes.
    for(const name of names){fs.mkdirSync(dirname(join(fake,name)),{recursive:true});fs.writeFileSync(join(fake,name),name);pins[name]=createHash('sha256').update(name).digest('hex');}
    const pi={version:'0.87.0',manifest:join(fake,'package.json'),binPaths:{pi:join(fake,'dist/bundle/cli.js')}};
    assert.equal(h.bindRpcLifetime(pi).files,pins);
    assert.throws(()=>h.bindRpcLifetime({...pi,version:'0.84.4'}),/Unreviewed RPC bytes/);
    assert.throws(()=>h.bindRpcLifetime({...pi,binPaths:{pi:join(fake,'dist/bundle/cli-runtime.js')}}),/Unreviewed Pi entrypoint/);
    for(const name of names){fs.appendFileSync(join(fake,name),'changed');assert.throws(()=>h.bindRpcLifetime(pi),/Unreviewed RPC bytes/);fs.writeFileSync(join(fake,name),name);}
    assert.equal(Object.keys(h.reviewedRpc.files).length,5);assert.equal(spawns,0);
  `));

  it('pins the current complete shipped bundle and narrow readable contract surface; every drift refuses (synthetic bytes)', () => probe(`
    const {createHash}=await import('node:crypto');const pins=h.reviewedRpc152.files,names=Object.keys(pins),fake=join(root,'pi-152');
    assert.equal(names.length,112);assert.equal(names.filter(name=>name.startsWith('dist/bundle/')).length,84);
    for(const name of ['dist/bundle/cli.js','dist/bundle/cli-runtime.js','dist/bundle/chunks/chunk-VEJDBY3O.js','dist/bundle/chunks/virtual-modules-KITQRTYM.js','dist/bundle/chunks/jiti-static-loader-2RCDI6B4.js','dist/core/extensions/types.d.ts','docs/rpc-commands.md'])assert(names.includes(name));
    for(const name of names){fs.mkdirSync(dirname(join(fake,name)),{recursive:true});fs.writeFileSync(join(fake,name),name);pins[name]=createHash('sha256').update(name).digest('hex');}
    const pi={version:'1.5.2',manifest:join(fake,'package.json'),binPaths:{pi:join(fake,'dist/bundle/cli.js')}};
    assert.equal(h.bindRpcLifetime(pi).files,pins);
    assert.throws(()=>h.bindRpcLifetime({...pi,version:'1.5.3'}),/own reviewed/);
    assert.throws(()=>h.bindRpcLifetime({...pi,binPaths:{pi:join(fake,'dist/cli.js')}}),/Unreviewed Pi entrypoint/);
    for(const name of names){fs.appendFileSync(join(fake,name),'changed');assert.throws(()=>h.bindRpcLifetime(pi),/Unreviewed RPC bytes/);fs.writeFileSync(join(fake,name),name);}
    assert.equal(Object.keys(h.reviewedRpc.files).length,5);assert.equal(Object.keys(h.reviewedRpc087.files).length,70);assert.equal(spawns,0);
  `));

  it.each(['0.84.4', '0.87.0'])('keeps legacy %s command acceptance without disposition separate from model settlement', version => probe(`
    const rpc=start(${JSON.stringify(version)});const command=rpc.command('/bazframe reload');response(1,'prompt');await command;
    let done=false;const work=rpc.prompt('model').then(()=>done=true);response(2,'prompt');await new Promise(setImmediate);assert(!done);
    emit({type:'agent_settled'});await work;const disposal=rpc.finish();response(3,'get_state',idle);await new Promise(setImmediate);assert(child.stdin.writableEnded);await finish();await disposal;
  `));

  it('distinguishes actual installed program from unavailable/global and genuine nested shim', () => probe(`
    const paths={bin:join(root,'prefix','bin'),packageRoot:join(root,'prefix','lib','node_modules','bazframe')};
    const pi={binPaths:{pi:join(paths.packageRoot,'node_modules','@earendil-works','pi-coding-agent','dist','bundle','cli.js')}};
    let routes=h.piLaunches(pi,paths,'both','linux');assert.equal(routes[0].kind,'direct-node-installed-program');assert.equal(routes[1].status,'not-run');
    fs.mkdirSync(dirname(pi.binPaths.pi),{recursive:true});fs.writeFileSync(pi.binPaths.pi,'admitted fixture, never executed');
    const shim=join(paths.packageRoot,'node_modules','.bin','pi');fs.mkdirSync(dirname(shim));fs.symlinkSync(pi.binPaths.pi,shim);
    routes=h.piLaunches(pi,paths,'both','linux');assert.equal(routes[1].file,shim);assert(!routes[1].status);
    fs.unlinkSync(shim);fs.symlinkSync('/bin/sh',shim);assert.throws(()=>h.piLaunches(pi,paths,'shim','linux'),/outside selected/);assert.equal(spawns,0);
  `));

  it('routes invalid candidate input before legacy packing, personal PI_BIN or root cleanup', () => probe(`
    childProcess.execFileSync=()=>{throw Error('FORBIDDEN_PACK_OR_PERSONAL_PI')};fs.mkdtempSync=()=>{throw Error('FORBIDDEN_LEGACY_FIXTURE')};fs.rmSync=()=>{throw Error('FORBIDDEN_CLEANUP')};syncBuiltinESMExports();
    process.env.PI_BIN='/personal/pi';process.argv=[process.execPath,${JSON.stringify(entry)},'--candidate'];
    await assert.rejects(import(${JSON.stringify(entry)}),/Unknown, duplicate or incomplete option/);assert.equal(spawns,0);
  `));

  it('requires explicit launch/Git inputs and prepares fixed ordinary/imported/reload cells without effects', () => probe(`
    const common=['--candidate',join(root,'c.tgz'),'--sha256','a'.repeat(64),'--native-sha256','b'.repeat(64),'--source','c'.repeat(40),'--root',join(root,'fresh'),'--install','global','--alias','both','--batch','all','--npm-cli',join(root,'npm.js'),'--ownership-record',join(root,'scope')];
    assert.throws(()=>h.parsePiOptions(common),/pi-launch/);assert.throws(()=>h.parsePiOptions([...common,'--pi-launch','direct']),/--git/);
    assert.equal(h.parsePiOptions([...common,'--pi-launch','both','--git','/usr/bin/git']).launch,'both');
    assert.throws(()=>h.parsePiOptions([...common,'--pi-launch','both','--git','/usr/bin/git','--pi-version','9.0.0']),/Unreviewed explicit/);
    const steps=h.piJourneySteps({root,home:join(root,'home'),env:{PI_CODING_AGENT_DIR:join(root,'pi')},revalidate:()=>{}});
    for(const name of ['ordinary-plain','ordinary-no-context','imported-plain','imported-no-context','same-process-reload-profile-policy-and-resources','occupied-alias-withholds-profile-projection','whole-collection-withholding-preserves-references','adapter-drift-refusal-force-repair','deprecated-real-launch-and-natural-exit'])assert(steps.some(s=>s.name===name),name);
    assert.equal(new Set(steps.map(s=>s.name)).size,steps.length);assert(!fs.existsSync(join(root,'home')));assert.equal(spawns,0);
  `));

  it('requires exact native/restored global and profile paths, bytes and order', () => probe(String.raw`
    const paths={globalPath:'/global/AGENTS.md',repositoryPath:'/repo/AGENTS.md',profilePath:'/profile/&alpha/AGENTS.md'};
    const global='<project_instructions path="/global/AGENTS.md">\nGLOBAL_BODY\n\n</project_instructions>';
    const repo='<project_instructions path="/repo/AGENTS.md">\nREPOSITORY_BODY\n\n</project_instructions>';
    const profile='<bazframe_profile_instructions path="/profile/&amp;alpha/AGENTS.md">\nALPHA_BODY\n\n</bazframe_profile_instructions>';
    const body=global+'\n'+repo+'\nDIRECT_MARKER LIBRARY_MARKER PACKAGE_MARKER\n\n'+profile;
    h.assertPrompt({systemPrompt:body},paths);
    for(const wrong of [body.replace('/profile/&amp;alpha','/wrong'),body.replace('GLOBAL_BODY\n\n','GLOBAL_BODY changed\n\n'),body.replace(global+'\n'+repo,repo+'\n'+global),body.replace('ALPHA_BODY\n\n','ALPHA_BODY\n'),body+'extra'])assert.throws(()=>h.assertPrompt({systemPrompt:wrong},paths));
    const restored='<bazframe_global_instructions path="/global/AGENTS.md">\nGLOBAL_BODY\n\n</bazframe_global_instructions>';
    const replacement='DIRECT_MARKER LIBRARY_MARKER PACKAGE_MARKER\n\n'+restored+'\n\n'+profile;
    h.assertPrompt({systemPrompt:replacement},{...paths,replacement:true});
    for(const wrong of [replacement.replace('/global/AGENTS.md','/wrong'),replacement.replace('GLOBAL_BODY\n\n','GLOBAL_BODY\n'),replacement.replace(restored+'\n\n'+profile,profile+'\n\n'+restored)])assert.throws(()=>h.assertPrompt({systemPrompt:wrong},{...paths,replacement:true}));
  `));
  it('checks physical/snapshot locations and state preservation at the actual ordinary print boundary', () => probe(String.raw`
    const home=join(root,'home'),agent=join(root,'pi'),repository=join(root,'repository'),source=join(root,'sources');
    const direct=join(source,'direct-skill');for(const path of [direct,repository,join(agent,'extensions'),join(home,'libraries'),join(home,'packages')])fs.mkdirSync(path,{recursive:true});
    const probeBytes=Buffer.from('unchanged task provider');fs.writeFileSync(join(agent,'extensions','99-probe-provider.ts'),probeBytes);
    for(const [directory,id,digest]of [['libraries','demo-library','a'.repeat(64)],['packages','demo-package','b'.repeat(64)]])fs.writeFileSync(join(home,directory,id+'.json'),JSON.stringify({digest}));
    const library=join(home,'skill-snapshots','sha256','a'.repeat(64),'artifact'),pkg=join(home,'skill-snapshots','sha256','b'.repeat(64),'artifact');
    fs.writeFileSync(join(home,'active-profile'),'alpha\n');
    const LF=String.fromCharCode(10),capturePath=join(root,'captures.jsonl');
    const body='<project_instructions path="'+join(agent,'AGENTS.md')+'">\nGLOBAL_BODY\n\n</project_instructions>\n<project_instructions path="'+join(repository,'AGENTS.md')+'">\nREPOSITORY_BODY\n\n</project_instructions>';
    const section='<bazframe_profile_instructions path="'+join(home,'profiles','alpha','AGENTS.md')+'">\nALPHA_BODY\n\n</bazframe_profile_instructions>';
    const projection=()=>[['direct-skill','DIRECT_MARKER',locations[0]+'/SKILL.md'],['library-skill','LIBRARY_MARKER',locations[1]+'/library-skill/SKILL.md'],['library-companion','LIBRARY_COMPANION',locations[1]+'/library-companion/SKILL.md'],['package-skill','PACKAGE_MARKER',locations[2]+'/skills/package-skill/SKILL.md'],['package-companion','PACKAGE_COMPANION',locations[2]+'/skills/package-companion/SKILL.md']].map(([name,desc,path])=>'<skill><name>'+name+'</name><description>'+desc+'</description><location>'+path+'</location></skill>').join(LF);
    const membership=join(home,'profiles','alpha','skills','direct-skill');fs.mkdirSync(dirname(membership),{recursive:true});fs.symlinkSync(direct,membership,'junction');
    let locations=[membership,library,pkg],mutate=()=>{};
    const c={root,home,env:{PI_CODING_AGENT_DIR:agent,BAZFRAME_PI_PROBE_CAPTURE:capturePath},repository,probe:probeBytes,launch:{kind:'direct-node-installed-program',file:'/bound/node',prefix:['/bound/pi']},revalidate:()=>{},run:async()=>{
      mutate();fs.appendFileSync(capturePath,JSON.stringify({cwd:repository,systemPrompt:body+LF+projection()+LF+LF+section})+LF);
      return{evidence:join(root,'print'),stdout:Buffer.from('probe-ok'),stderr:Buffer.alloc(0),code:0,signal:null,ioErrors:[],events:[{event:'exit',code:0,signal:null},{event:'close',code:0,signal:null}]};
    }};
    const step=h.piJourneySteps(c).find(s=>s.name==='ordinary-plain');await step.run();
    for(const missing of [membership,library,pkg]){locations=[membership,library,pkg].filter(x=>x!==missing);await assert.rejects(step.run(),/Exact Skill file provenance/);}
    locations=[membership,library,pkg];mutate=()=>fs.writeFileSync(join(source,'source-effect'),'unexpected');await assert.rejects(step.run(),/source-owned/);
    assert.equal(spawns,0);
  `));

  it('keeps a selected nested Windows Pi shim distinct and requires the exact generated shape', () => probe(String.raw`
    const {expectedCmdShim}=await import(${JSON.stringify(join(process.cwd(), 'scripts/installed-candidate.mjs'))});
    const {win32}=await import('node:path');
    const paths={bin:join(root,'global-bin'),packageRoot:join(root,'installed','bazframe')};
    const pi={binPaths:{pi:join(paths.packageRoot,'node_modules','@earendil-works','pi-coding-agent','dist','bundle','cli.js')}};
    const shim=join(paths.packageRoot,'node_modules','.bin','pi.cmd');fs.mkdirSync(dirname(shim),{recursive:true});fs.mkdirSync(dirname(pi.binPaths.pi),{recursive:true});fs.writeFileSync(pi.binPaths.pi,'not executed');
    const expected=expectedCmdShim(win32.relative(win32.dirname(shim),pi.binPaths.pi));fs.writeFileSync(shim,expected);
    assert.equal(h.piLaunches(pi,paths,'shim','win32')[0].file,shim);
    fs.appendFileSync(shim,String.fromCharCode(10)+'echo injected');assert.throws(()=>h.piLaunches(pi,paths,'shim','win32'),/Unreviewed npm CMD shape/);
    fs.writeFileSync(shim,expected);fs.writeFileSync(join(dirname(shim),'node.exe'),'shadow');assert.throws(()=>h.piLaunches(pi,paths,'shim','win32'),/shadows/);assert.equal(spawns,0);
  `));
  it.each(['record-shape', 'unterminated', 'premature-stdout', 'premature-stderr', 'state-shape', 'commands-shape'])('typed %s uncertainty blocks all subsequent shared-install cells and retains the RPC owner', mode => probe(String.raw`
    import workerThreads from 'node:worker_threads';
    const shared=await import(${JSON.stringify(join(process.cwd(), 'scripts/installed-candidate.mjs'))});
    let heldResolve;const held=new Promise(resolve=>heldResolve=resolve);workerThreads.MessageChannel=class{constructor(){this.port1=new EventEmitter();this.port2=new EventEmitter();this.port1.ref=()=>heldResolve()}};syncBuiltinESMExports();process.stderr.write=()=>true;
    const mode=${JSON.stringify(mode)},cells=[],rows=[];let caught,completed=false;
    async function execute(){try{for(const alias of ['bazframe','bzf']){cells.push(alias);await shared.runSteps([{name:'actual-rpc',run:async()=>{
      const rpc=start();let request;
      if(mode==='commands-shape'){request=rpc.request({type:'get_commands'});request.catch(()=>{});response(1,'get_commands',{commands:{}});}
      else {request=rpc.request({type:'get_state'});request.catch(()=>{});if(mode==='state-shape')response(1,'get_state',{});else if(mode==='record-shape')emit([]);else response(1,'get_state',idle);}
      if(mode==='unterminated')child.stdout.write('{"type":');
      if(mode==='premature-stdout'||mode==='premature-stderr'){
        const bad=mode==='premature-stdout'?'stdout':'stderr',good=bad==='stdout'?'stderr':'stdout';
        if(bad==='stdout')child.stdout.write('{"type":');child[bad].destroy();
        await new Promise(done=>{child[good].once('end',done);child[good].end()});
        child.emit('exit',0,null);child.emit('close',0,null);
      }else await finish();
      try{await request;}finally{await rpc.close();}
    }},{name:'next-operation',run:()=>assert.fail('later effect')}],rows,()=>{});}}catch(error){caught=error;return shared.holdCandidateUncertainty(error,owners,root);}}
    void execute().then(()=>completed=true);await held;assert(caught instanceof shared.CandidateUncertainty);assert.equal(completed,false);assert.deepEqual(cells,['bazframe']);assert.deepEqual(rows.map(r=>r.status),['uncertain','not-run']);
    const hold=shared.retainedCandidateHolds.at(-1);assert.equal(hold.owners[0].child,child);assert.equal(hold.error,caught);assert.equal(spawns,1);assert(fs.existsSync(evidence+'.stdout'));assert(fs.existsSync(evidence+'.stderr'));
    if(mode==='record-shape'||mode.endsWith('shape'))assert.equal(caught.cause.name,'AssertionError');
  `));

  it('uses short cell IDs and checks every derived socket before effects on both POSIX limits', () => probe(`
    for(const platform of ['darwin','linux']){const cells=h.piCellPaths('/private/tmp/w9',platform);assert.deepEqual(cells.map(c=>c.id),['0','1','2','3']);for(const cell of cells)for(const socket of cell.sockets)assert(Buffer.byteLength(socket)<=cell.maximumBytes);}
    assert.throws(()=>h.piCellPaths('/'+('x'.repeat(100)),'darwin'),/Derived operation socket/);
    assert.throws(()=>h.piCellPaths('/'+('é'.repeat(35)),'linux'),/Derived operation socket/);assert.equal(spawns,0);
  `));

  it('admits exact installer-produced Windows binding without rewriting artifact, and rejects every substituted input', () => probe(String.raw`
    const c={root,home:join(root,'home'),packageRoot:join(root,'package'),env:{PI_CODING_AGENT_DIR:join(root,'pi')}};
    const put=(p,b)=>{fs.mkdirSync(dirname(p),{recursive:true});fs.writeFileSync(p,b)};
    // Real tracked artifact, marker/layout and installer serialization, never executed.
    const template=fs.readFileSync(${JSON.stringify(join(process.cwd(), 'artifacts/pi/bazframe.ts'))});
    const shared=await import(${JSON.stringify(join(process.cwd(), 'scripts/installed-candidate.mjs'))});
    const packageBytes=Buffer.from(JSON.stringify({name:'bazframe',version:'fixture'}));
    const packagePath=join(c.packageRoot,'package.json'),runtimePath=join(c.packageRoot,'dist/application/win32-application-services.js'),nativePath=join(c.packageRoot,'artifacts/native/win32-x64-msvc/bazframe-win32.node');
    put(packagePath,packageBytes);put(runtimePath,'not executed runtime');put(nativePath,'not executed native');put(join(c.packageRoot,'artifacts/pi/bazframe.ts'),template);
    const binding={schemaVersion:1,bazframeVersion:'fixture',packageRoot:c.packageRoot,packageSha256:shared.sha256(packageBytes),runtimeSha256:shared.sha256(fs.readFileSync(runtimePath)),nativeSha256:shared.sha256(fs.readFileSync(nativePath))};
    const bindingPath=join(c.env.PI_CODING_AGENT_DIR,'bazframe/runtime.json'),extension=join(c.env.PI_CODING_AGENT_DIR,'extensions/bazframe.ts'),manifestPath=join(c.home,'adapters/pi.json');
    put(bindingPath,JSON.stringify(binding,null,2)+'\n');
    const installed=Buffer.from(template.toString().replace('const WINDOWS_INSTALL_REFERENCE = null;','const WINDOWS_INSTALL_REFERENCE = '+JSON.stringify({path:bindingPath,binding})+';'));put(extension,installed);
    put(manifestPath,JSON.stringify({schemaVersion:1,adapter:'pi',bazframeVersion:'fixture',installedPath:extension,artifactSha256:shared.sha256(installed),artifactBytes:installed.length},null,2)+'\n');
    const bound=h.verifyAdapter(c,'win32');assert.equal(bound.extension,shared.sha256(installed));assert.deepEqual(fs.readFileSync(extension),installed);
    for(const path of [packagePath,runtimePath,nativePath,bindingPath,extension,manifestPath]){const bytes=fs.readFileSync(path);fs.writeFileSync(path,path.endsWith('.json')?JSON.stringify({wrong:'identity'}):Buffer.concat([bytes,Buffer.from('changed')]));assert.throws(()=>h.verifyAdapter(c,'win32'));fs.writeFileSync(path,bytes);}
    put(extension,template);assert.throws(()=>h.verifyAdapter(c,'win32'),/installer-produced/);put(extension,installed);
    const artifact=join(c.packageRoot,'artifacts/pi/bazframe.ts');put(artifact,Buffer.concat([template,Buffer.from('\nconst WINDOWS_INSTALL_REFERENCE = null;')]));assert.throws(()=>h.verifyAdapter(c,'win32'),/Unique documented/);assert.equal(spawns,0);
  `));

  it('binds selected genuine Git to effective isolated bare-git resolution, rejecting mismatch and script wrappers', () => probe(String.raw`
    const git=fs.realpathSync('/usr/bin/git');const env={PATH:dirname(process.execPath)+':/usr/bin:/bin'};
    assert.equal(h.bindSelectedGit(git,env).effectiveBareGit,git);
    const fake=join(root,'git');fs.writeFileSync(fake,'#!/bin/sh\nexec /usr/bin/git "$@"\n',{mode:0o755});
    assert.throws(()=>h.bindSelectedGit(fake,{PATH:root+':/usr/bin:/bin'}),/native program/);
    assert.throws(()=>h.bindSelectedGit(git,{PATH:root+':/usr/bin:/bin'}),/differs from effective/);assert.equal(spawns,0);
  `));

  it('requires exact ordered info suppliers, sorted Skill names and live alias mappings', () => probe(String.raw`
    const expected={profileId:'alpha',profilePath:'/home/profiles/alpha/AGENTS.md',globalPath:'/pi/AGENTS.md',repositoryPath:'/repo/AGENTS.md',skills:['zeta','direct-skill-x-bazframe','direct-skill'],aliases:['direct-skill -> direct-skill-x-bazframe']};
    const body='Profile: alpha\nContext:\n  (pi) /pi/AGENTS.md\n  (pi) /repo/AGENTS.md\n  (bazframe) /home/profiles/alpha/AGENTS.md\nFlat direct skills: 1\nSkills: direct-skill, direct-skill-x-bazframe, zeta\nAliases: direct-skill -> direct-skill-x-bazframe';
    h.assertInfo(body,expected);
    for(const wrong of [body.replace('(pi) /repo','(bazframe) /repo'),body.replace('/home/profiles/alpha','/other'),body.replace('  (pi) /pi/AGENTS.md\n  (pi) /repo/AGENTS.md','  (pi) /repo/AGENTS.md\n  (pi) /pi/AGENTS.md'),body.replace('Skills: direct-skill, direct-skill-x-bazframe, zeta','Skills: zeta, direct-skill'),body.replace('Aliases: direct-skill -> direct-skill-x-bazframe','Aliases: other -> wrong')])assert.throws(()=>h.assertInfo(wrong,expected));
  `));
  it('requires collision-only collection diagnostics and the matching inspection action', () => probe(`
    const action='  - Inspect failures with '+String.fromCharCode(96)+'bazframe profile library list'+String.fromCharCode(96)+' and '+String.fromCharCode(96)+'bazframe profile package list'+String.fromCharCode(96)+'.';
    const body=['Profile library/package references: 2','Derived effective skills: 0','Library/package failures: 2',
      '  - library demo-library:library-skill/SKILL.md duplicate-name (library-skill)',
      '  - package demo-package:package-skill/SKILL.md duplicate-name (package-skill)',
      'Corrective actions:',action,'Skills: direct-skill, library-skill, package-skill'].join('\\n');
    h.assertCollectionConflictInfo(body);
    for(const wrong of [body.replace('references: 2','references: 1'),body.replace('effective skills: 0','effective skills: 1'),body.replace('failures: 2','failures: 1'),body.replace('duplicate-name','broken-snapshot'),body.replace('package demo-package:','package wrong:'),body.replace('Corrective actions:','Actions:'),body.replace(action,'  - bazframe library update demo-library\\n  - bazframe package build demo-package'),'Skills: earlier\\n'+body])assert.throws(()=>h.assertCollectionConflictInfo(wrong));
    assert.equal(spawns,0);
  `));

  it.each([undefined, '0.84.4', '0.87.0', '1.5.2'])('uses ordinary resolution or explicit reviewed Pi %s on the actual candidate entry route', version => probe(String.raw`
    const {registerHooks}=await import('node:module');const {gzipSync}=await import('node:zlib');const {sha256}=await import(${JSON.stringify(join(process.cwd(), 'scripts/installed-candidate.mjs'))});
    const entries={'package.json':Buffer.from(JSON.stringify({name:'bazframe',version:'fixture',bin:{bazframe:'dist/cli.js',bzf:'dist/cli.js'}})),'dist/cli.js':Buffer.from('not executed'),'artifacts/native/win32-x64-msvc/bazframe-win32.node':Buffer.from('not native')};
    const blocks=[];for(const[name,bytes]of Object.entries(entries)){const header=Buffer.alloc(512);header.write('package/'+name);const oct=(o,n,v)=>header.write(v.toString(8).padStart(n-1,'0')+String.fromCharCode(0),o,n);oct(100,8,0o644);oct(124,12,bytes.length);header[156]=48;header.fill(32,148,156);oct(148,8,[...header].reduce((a,b)=>a+b,0));blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));}
    const archive=join(root,'candidate.tgz'),bytes=gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));fs.writeFileSync(archive,bytes);
    let selected;globalThis.installBoundary=(args,selection)=>{selected={args,selection};throw Error('STOP_BEFORE_INSTALL')};
    const hooks=registerHooks({resolve(specifier,context,next){if(specifier==='./test-pack-candidate.mjs'&&context.parentURL.includes('?selection'))return{url:'data:text/javascript,export async function runCandidate(args,selection){return globalThis.installBoundary(args,selection)}',shortCircuit:true};return next(specifier,context)}});
    const actual=await import(${JSON.stringify(modulePath + '?selection')});
    const options=['--candidate',archive,'--sha256',sha256(bytes),'--native-sha256',sha256(entries['artifacts/native/win32-x64-msvc/bazframe-win32.node']),'--source','a'.repeat(40),'--root',join(root,'fresh'),'--install','global','--alias','both','--batch','all','--npm-cli',join(root,'npm'),'--ownership-record',join(root,'scope'),'--pi-launch','both','--git','/usr/bin/git'];
    const version=${JSON.stringify(version) ?? 'undefined'};if(version)options.push('--pi-version',version);
    await assert.rejects(actual.runPiCandidate(options),/STOP_BEFORE_INSTALL/);hooks.deregister();
    assert.deepEqual(selected.selection,version?{piVersion:version}:undefined);assert.equal(selected.args[selected.args.indexOf('--batch')+1],'dispatch');assert.equal(selected.args[selected.args.indexOf('--root')+1],join(root,'fresh','installation'));assert.equal(spawns,0);
  `));
  it('refuses an unknown default-resolved Pi at the actual candidate route before any Pi execution', () => probe(String.raw`
    const {registerHooks}=await import('node:module');const {gzipSync}=await import('node:zlib');const {sha256}=await import(${JSON.stringify(join(process.cwd(), 'scripts/installed-candidate.mjs'))});
    const entries={'package.json':Buffer.from(JSON.stringify({name:'bazframe',version:'fixture',bin:{bazframe:'dist/cli.js',bzf:'dist/cli.js'}})),'dist/cli.js':Buffer.from('not executed'),'artifacts/native/win32-x64-msvc/bazframe-win32.node':Buffer.from('not native')};
    const blocks=[];for(const[name,bytes]of Object.entries(entries)){const header=Buffer.alloc(512);header.write('package/'+name);const oct=(o,n,v)=>header.write(v.toString(8).padStart(n-1,'0')+String.fromCharCode(0),o,n);oct(100,8,0o644);oct(124,12,bytes.length);header[156]=48;header.fill(32,148,156);oct(148,8,[...header].reduce((a,b)=>a+b,0));blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));}
    const archive=join(root,'candidate.tgz'),bytes=gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));fs.writeFileSync(archive,bytes);
    const workerThreads=await import('node:worker_threads');let heldResolve;const held=new Promise(resolve=>heldResolve=resolve);
    workerThreads.default.MessageChannel=class{constructor(){this.port1=new EventEmitter();this.port2=new EventEmitter();this.port1.ref=()=>heldResolve()}};syncBuiltinESMExports();process.stderr.write=()=>true;
    let selected;globalThis.installBoundary=(args,selection)=>{selected={args,selection};const installRoot=args[args.indexOf('--root')+1];fs.mkdirSync(installRoot);fs.writeFileSync(join(installRoot,'installed-inventory.json'),'{}');return {candidate:{},installation:[{status:'passed'}],environment:{pi:{version:'1.5.3',manifest:join(root,'unknown/package.json'),binPaths:{pi:join(root,'unknown/dist/bundle/cli.js')}},piSelection:null}}};
    const hooks=registerHooks({resolve(specifier,context,next){if(specifier==='./test-pack-candidate.mjs'&&context.parentURL.includes('?selection'))return{url:'data:text/javascript,export async function runCandidate(args,selection){return globalThis.installBoundary(args,selection)}',shortCircuit:true};return next(specifier,context)}});
    const actual=await import(${JSON.stringify(modulePath + '?selection')});
    const options=['--candidate',archive,'--sha256',sha256(bytes),'--native-sha256',sha256(entries['artifacts/native/win32-x64-msvc/bazframe-win32.node']),'--source','a'.repeat(40),'--root',join(root,'fresh'),'--install','global','--alias','both','--batch','all','--npm-cli',join(root,'npm'),'--ownership-record',join(root,'scope'),'--pi-launch','both','--git','/usr/bin/git'];
    options[options.indexOf('--pi-launch')+1]='direct';let returned=false;void actual.runPiCandidate(options).then(()=>returned=true);await held;hooks.deregister();
    const shared=await import(${JSON.stringify(join(process.cwd(), 'scripts/installed-candidate.mjs'))}),hold=shared.retainedCandidateHolds.at(-1);
    assert.match(String(hold.error),/own reviewed EOF lifetime binding/);assert.equal(hold.owners.length,0);assert.equal(returned,false);assert.equal(selected.selection,undefined);assert.equal(spawns,0);
    const report=JSON.parse(fs.readFileSync(join(root,'fresh/pi-results.json')));assert.deepEqual(report.cells,[]);
  `));
  it('asserts complete repository/Git bytes, Git status and source preservation around actual policy steps', () => probe(String.raw`
    const home=join(root,'home'),repository=join(root,'repository'),agent=join(root,'pi');let mutation=()=>{},status='?? AGENTS.md'+String.fromCharCode(0);
    const c={root,home,repository,cwd:join(root,'non-git'),git:'/bound/git',executable:'/bound/bzf',probe:Buffer.from('unchanged provider'),env:{BAZFRAME_HOME:home,PI_CODING_AGENT_DIR:agent},revalidate:()=>{},run:async(label)=>{
      if(label==='git-init'){fs.mkdirSync(join(repository,'.git'));fs.writeFileSync(join(repository,'.git','HEAD'),'ref: refs/heads/main\n');}
      if(label.startsWith('cli-'))mutation();
      return {evidence:join(root,label),stdout:Buffer.from(label.startsWith('git-status')?status:label.startsWith('cli-')?'inherits global policy':''),stderr:Buffer.alloc(0),code:0,signal:null,ioErrors:[],events:[{event:'exit',code:0,signal:null},{event:'close',code:0,signal:null}]};
    }};
    const steps=h.piJourneySteps(c);await steps.find(s=>s.name==='prepare-offline-fixtures').run();const policy=steps.find(s=>s.name==='git-file-free-default');await policy.run();
    mutation=()=>fs.writeFileSync(join(repository,'.git','HEAD'),'changed');await assert.rejects(policy.run(),/Repository\/Git bytes changed/);fs.writeFileSync(join(repository,'.git','HEAD'),'ref: refs/heads/main\n');
    mutation=()=>fs.writeFileSync(join(root,'sources','foreign-effect'),'changed');await assert.rejects(policy.run(),/CLI mutated source-owned/);
    mutation=()=>{status='changed-status'};await assert.rejects(policy.run(),/Git status changed/);assert.equal(spawns,0);
  `));

  it('binds native scope Git override to the same selected executable without a shim', () => probe(String.raw`
    const git=join(root,'git.exe');fs.writeFileSync(git,Buffer.from('MZ synthetic native-header admission fixture'));
    const env={PATH:root,BAZFRAME_GIT_COMMAND:git};assert.equal(h.bindSelectedGit(git,env,'win32').nativeOverride,git);
    assert.throws(()=>h.bindSelectedGit(git,{...env,BAZFRAME_GIT_COMMAND:join(root,'other.exe')},'win32'),/Native policy discovery/);assert.equal(spawns,0);
  `));

});
