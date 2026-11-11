import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {normalizeRunRecord} from '../model.mjs';
import {aggregateRunStatus} from '../state.mjs';
import {createRecordCache} from '../record-cache.mjs';
import {observeRuns,readDevices} from '../devices.mjs';
import {createViewer,utf8ChunkLength,parseLogCursor} from '../server.mjs';
import {API_VERSION,ASSET_FILES,configVersion} from '../identity.mjs';
import {viewerCompatibility,shutdownBlocker} from '../start-wsl.mjs';
import {createReporter} from '../reporter.mjs';

const source={id:'job'},now=Date.parse('2026-11-12T04:00:00Z'),iso=offset=>new Date(now+offset).toISOString();
const record=patch=>({id:'job',format:'wsl-progress-v1',name:'job',projects:['fixture'],status:'running',updatedAt:iso(0),steps:[{id:'unit',status:'running',command:['node','check']}],...patch});

test('pure: concurrent cache misses count only the entry actually retained',async()=>{
 const text=JSON.stringify({id:'same',steps:[]}),size=Buffer.byteLength(text);let readers=0,release;const ready=new Promise(ok=>release=ok);
 const info={dev:1n,ino:2n,size:BigInt(size),mtimeNs:3n,ctimeNs:4n,isFile:()=>true};
 const cache=createRecordCache({maxBytes:size+1,maxEntries:2,openFile:async()=>({stat:async()=>info,readFile:async()=>{if(++readers===2)release();await ready;return text},close:async()=>{}})});
 await Promise.all([cache.read('same.json'),cache.read('same.json')]);assert.equal(cache.stats().entries,1);assert.equal(cache.stats().sourceBytes,size);
 await cache.read('same.json');assert.equal(cache.stats().hits,1);
});

test('pure: invalid producer fields are rejected before renderer fields escape',()=>{
 for(const patch of [{projects:{}},{projects:[{}]},{versions:{}},{startedAt:'yesterday'},{updatedAt:'2026-02-30T01:00:00Z'},{steps:[{id:'unit',status:'running',tests:{pass:'4'}}]},{steps:[{id:'unit',status:'running',command:[{}]}]}])assert.throws(()=>normalizeRunRecord(record(patch),source),/RUN_/);
 const normalized=normalizeRunRecord(record({versions:[{name:'snapshot',head:'frozen'}],executor:{computerName:'A',token:'hidden'},controller:{computerName:'C',password:'hidden'},sourceCi:{url:'https://github.com/example/repo/actions/runs/42?token=hidden',runId:42,headSha:'abcdef0123',status:'in_progress',token:'hidden'},recoveryRefs:[{runId:'old',stepId:'test',token:'hidden'}],steps:[{id:'unit',status:'running',executor:{computerName:'B',password:'hidden'},reusedFrom:{runId:'old',stepId:'test',secret:'hidden'},attempts:[{startedAt:iso(-1000),error:'previous failure'}]}]}),source,{manifestVersions:[{name:'now',head:'mutable'}]});
 assert.equal(normalized.versions[0].head,'frozen');assert.equal(normalized.controller.computerName,'C');assert.equal(normalized.steps[0].executor.computerName,'B');assert.deepEqual(normalized.steps[0].reusedFrom,{runId:'old',stepId:'test'});assert.equal(normalized.steps[0].attempts[0].error,'previous failure');assert.equal(normalized.sourceCi.runId,'42');assert.doesNotMatch(JSON.stringify(normalized),/hidden|password|token|secret/);
});

test('pure: shared terminal aggregation keeps cancellation and interruption distinct',()=>{
 for(const status of ['failed','blocked','cancelled','interrupted'])assert.equal(aggregateRunStatus({format:'wsl-progress-v1',finished:true,steps:[{status}]}),status);
 for(const status of ['failed','blocked','cancelled','interrupted'])assert.equal(aggregateRunStatus({format:'wsl-progress-v1',finished:true,status,steps:[{status:'passed',exitCode:0}]}),status);
 assert.equal(aggregateRunStatus({format:'wsl-progress-v1',finished:true,status:'passed',steps:[{status:'queued'}]}),'blocked');
 assert.equal(aggregateRunStatus({format:'wsl-progress-v1',finished:true,steps:[{status:'passed',exitCode:0,tests:{fail:1}}]}),'blocked');
 assert.equal(aggregateRunStatus({finished:true,steps:[{status:'passed'}]}),'passed');
});

test('pure: real step executors and fresh cloud observations drive work state',()=>{
 const a={id:'a',name:'A',computerName:'A',onlineState:'online',resources:{state:'running',lockBusy:false},runs:[]},b={id:'b',name:'B',computerName:'B',onlineState:'online',resources:{state:'running',lockBusy:false},runs:[]};
 const input=record({executor:{computerName:'A'},steps:[{id:'unit',status:'running',command:['node'],executor:{computerName:'B'},heartbeatAt:iso(0)}]});
 let result=observeRuns([input],[a,b],{now});assert.equal(result.runs[0].workState,'executing');assert.equal(a.runs.length,0);assert.equal(b.runs[0].stepIds[0],'unit');
 const stopped={...b,resources:{state:'stopped',sampledAt:iso(1)},runs:[]};result=observeRuns([input],[{...a,runs:[]},stopped],{now});assert.equal(result.runs[0].workState,'unconfirmed');assert.match(result.runs[0].observation.reason,/停止/);
 result=observeRuns([{...input,heartbeatAt:iso(-2400000),updatedAt:iso(-2400000),steps:[{...input.steps[0],heartbeatAt:iso(-2400000)}]}],[{...a,runs:[]},{...stopped,runs:[]}],{now});assert.match(result.runs[0].observation.reason,/停止.*过期/);
 result=observeRuns([input],[],{now});assert.equal(result.runs[0].workState,'unconfirmed');
 const cloud=record({executor:{platform:'github-actions',name:'GitHub Actions'},sourceCi:{url:'https://github.com/example/repo/actions/runs/42',runId:'42',status:'in_progress',observedAt:iso(0)}});result=observeRuns([cloud],[],{now});assert.equal(result.runs[0].workState,'executing');assert.deepEqual(result.unassignedRuns,[]);
 result=observeRuns([{...cloud,sourceCi:{...cloud.sourceCi,observedAt:iso(-100000)}}],[],{now});assert.equal(result.runs[0].workState,'unconfirmed');
 const locked={...a,runs:[],resources:{state:'running',lockBusy:true}};observeRuns([], [locked],{now});assert.equal(locked.workload,'unconfirmed');assert.match(locked.detail,/锁已占用/);
});

test('pure: UTF8 chunk boundaries never consume an unfinished code point',()=>{
 const bytes=Buffer.concat([Buffer.alloc(131071,97),Buffer.from('中文\n')]);assert.equal(utf8ChunkLength(bytes.subarray(0,131072)),131071);assert.equal(utf8ChunkLength(Buffer.from('中文')),6);
 const encoded=Buffer.from(JSON.stringify({fileId:'a'.repeat(24),offset:4,prefix:'b'.repeat(64),boundary:'c'.repeat(64)})).toString('base64url');assert.equal(parseLogCursor(encoded,4).offset,4);assert.equal(parseLogCursor(null,0),null);assert.throws(()=>parseLogCursor(encoded,5),/CURSOR/);assert.throws(()=>parseLogCursor('not-json',0),/CURSOR/);
});

test('pure: record cache detects same-size replacements and has bounded retention',async()=>{
 const files=new Map(),file=name=>resolve(name);let diskReads=0;
 const item=(ino,text,time=1n)=>({ino,text,time});files.set(file('a'),item(1n,'{"v":1}'));files.set(file('b'),item(2n,'{"v":2}'));
 const cache=createRecordCache({maxBytes:100,maxEntries:1,openFile:async path=>{const entry=files.get(path);return {stat:async()=>({dev:1n,ino:entry.ino,size:BigInt(Buffer.byteLength(entry.text)),mtimeNs:entry.time,ctimeNs:entry.time,isFile:()=>true}),readFile:async()=>{diskReads++;return entry.text},close:async()=>{}}}});
 assert.equal((await cache.read('a')).v,1);await cache.read('a');assert.equal(diskReads,1);
 files.set(file('a'),item(3n,'{"v":3}'));assert.equal((await cache.read('a')).v,3);
 files.get(file('a')).text='{"v":4}';files.get(file('a')).time=2n;assert.equal((await cache.read('a')).v,4);await cache.read('b');assert.equal(cache.stats().entries,1);assert.ok(cache.stats().evictions>=1);assert.ok(cache.stats().hits>=1);assert.doesNotMatch(JSON.stringify(cache.stats()),/path|audit|file:/i);
});

test('pure: shared service protection and version compatibility make no destructive guesses',()=>{
 const saved={backend:{owned:true,pid:1,instanceId:'core'},relays:[{owned:true,pid:2,instanceId:'lan'}]},current={application:'wsl-console',pid:1,instanceId:'core'};
 assert.equal(shutdownBlocker(saved,current,{runs:[{status:'running'}]}),'ACTIVE_OR_UNREADABLE_RUNS');assert.equal(shutdownBlocker(saved,null,{runs:[]}),'OWNED_BACKEND_IDENTITY_UNAVAILABLE');assert.equal(shutdownBlocker(saved,current,{runs:[]},[null]),'OWNED_RELAY_IDENTITY_UNAVAILABLE');assert.equal(shutdownBlocker(saved,current,{runs:[]},[{pid:2,instanceId:'lan'}]),null);
 assert.equal(shutdownBlocker(saved,current,{runs:[{status:'blocked',recordUnavailable:true,steps:[]}]}),'ACTIVE_OR_UNREADABLE_RUNS');assert.equal(shutdownBlocker({...saved,relays:[{owned:false,pid:2,instanceId:'lan'}]},current,{runs:[]}),'SHARED_RELAY_DEPENDENCY');
 const expected={apiVersion:API_VERSION,buildVersion:'a',assetsVersion:'b',configVersion:'c'};assert.deepEqual(viewerCompatibility(expected,expected),[]);assert.ok(viewerCompatibility({application:'wsl-console'},expected).includes('API_VERSION'));assert.ok(viewerCompatibility({...expected,assetsVersion:'old'},expected).includes('assetsVersion'));
 assert.equal(configVersion({a:1,b:{c:2}}),configVersion({b:{c:2},a:1}));
});

test('device component ages are independent of live viewer Linux and probe failures are not offline proof',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-component-age-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config={runsRoot:join(root,'runs'),devicesRoot:root,devices:[{id:'a',name:'A',computerName:'A'}]},range=(total,available)=>({totalBytes:total,availableBytes:available});
 const old={format:'wsl-device-v1',id:'a',connection:'reachable',checkedAt:iso(-600000),lastSeenAt:iso(-600000),host:{computerName:'A'},resources:{platform:'linux',state:'running',status:'available',sampledAt:iso(-600000),memory:range(6e9,5e9),swap:range(4e9,4e9),cpu:{logicalProcessors:4,load1:0},windows:{...range(16e9,8e9),sampledAt:iso(-600000)},lockBusy:false,lockSampledAt:iso(-600000)}};
 await writeFile(join(root,'a.json'),JSON.stringify(old));const viewerResources={platform:'linux',status:'available',sampledAt:iso(0),memory:range(6e9,1e9),swap:range(4e9,4e9),cpu:{logicalProcessors:4,load1:0}};let result=await readDevices(config,{viewerHost:{computerName:'A'},viewerResources,now});let device=result.devices[0];assert.equal(device.onlineState,'online');assert.equal(device.resources.memory.availableBytes,1e9);assert.equal(device.resources.windows,null);assert.equal(device.resources.lockBusy,null);assert.equal(device.resources.windowsSampledAt,iso(-600000));assert.equal(device.workload,'unconfirmed');
 const fresh={...old,checkedAt:iso(0),resources:{...old.resources,sampledAt:iso(0),lockBusy:true,lockSampledAt:iso(0)}};await writeFile(join(root,'a.json'),JSON.stringify(fresh));result=await readDevices(config,{viewerHost:{computerName:'A'},viewerResources,now});assert.equal(result.devices[0].resources.lockBusy,true);assert.equal(result.devices[0].workload,'unconfirmed');
 await writeFile(join(root,'a.json'),JSON.stringify({...old,connection:'unreachable',checkedAt:iso(0),error:'PROBE_CONNECTION_FAILED'}));result=await readDevices(config,{now});assert.equal(result.devices[0].onlineState,'unknown');
});

async function fixture(t,{assetsRoot}={}){
 const root=await mkdtemp(join(tmpdir(),'wsl-state-integrity-'));t.after(()=>rm(root,{recursive:true,force:true}));const runsRoot=join(root,'runs');await mkdir(runsRoot);const reporter=await createReporter(runsRoot,{id:'job',steps:[{id:'unit'}]});const server=await createViewer({runsRoot},{assetsRoot});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));return {root,runsRoot,reporter,origin:'http://127.0.0.1:'+server.address().port};
}

test('reporter retries clear old commands and both sides agree on terminal kinds',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-reporter-integrity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const reporter=await createReporter(root,{id:'retry',steps:[{id:'unit',command:['planned']} ]});assert.equal((await reporter.snapshot()).steps[0].command,undefined);await reporter.step('unit',{status:'running',command:['old']});await reporter.step('unit',{status:'failed',exitCode:1});await reporter.step('unit',{status:'running'});const step=(await reporter.snapshot()).steps[0];assert.equal(step.command,undefined);assert.deepEqual(step.attempts[0].command,['old']);await reporter.step('unit',{status:'interrupted',exitCode:130});await reporter.finish();assert.equal((await reporter.snapshot()).status,'interrupted');
});

test('viewer isolates a bad producer and exposes immutable run versions and read cache counters',async t=>{
 const f=await fixture(t);await mkdir(join(f.runsRoot,'bad'));await writeFile(join(f.runsRoot,'bad/run.json'),JSON.stringify(record({id:'bad',projects:{wrong:true}})));const first=await(await fetch(f.origin+'/api/runs')).json();assert.equal(first.runs.length,2);assert.equal(first.runs.find(run=>run.id==='bad').status,'blocked');await fetch(f.origin+'/api/runs');const diagnostics=await(await fetch(f.origin+'/api/diagnostics')).json();assert.ok(diagnostics.records.hits>=2);assert.doesNotMatch(JSON.stringify(diagnostics),/runsRoot|progressFile/);
});

test('viewer log availability and bounded cursors detect rewrites without inferring results',async t=>{
 const f=await fixture(t),url=f.origin+'/api/runs/job/steps/unit/log',file=join(f.runsRoot,'job/logs/unit.log');assert.equal((await(await fetch(url)).json()).availability,'not-started');await f.reporter.step('unit',{status:'running',command:['fixture']});assert.equal((await(await fetch(url)).json()).availability,'missing');await writeFile(file,'');assert.equal((await(await fetch(url)).json()).availability,'empty');
 await writeFile(file,'Exit status 0\n');const old=await(await fetch(url)).json();assert.equal(old.availability,'available');assert.ok(old.modifiedAt);assert.ok(old.fileId);await writeFile(file,'Exit status 1\n');const changed=await(await fetch(url+'?offset='+old.nextOffset+'&cursor='+encodeURIComponent(old.cursor))).json();assert.equal(changed.reset,true);assert.equal(changed.text,'Exit status 1\n');assert.equal((await(await fetch(f.origin+'/api/runs/job')).json()).status,'running');
 await writeFile(file+'.new','Exit status 2\n');await rename(file+'.new',file);const replaced=await(await fetch(url+'?offset='+changed.nextOffset+'&cursor='+encodeURIComponent(changed.cursor))).json();assert.equal(replaced.reset,true);assert.notEqual(replaced.fileId,changed.fileId);assert.equal(replaced.text,'Exit status 2\n');
 const long=Buffer.concat([Buffer.alloc(131071,97),Buffer.from('中文\n')]);await writeFile(file,long);const a=await(await fetch(url)).json(),b=await(await fetch(url+'?offset='+a.nextOffset+'&cursor='+encodeURIComponent(a.cursor))).json();assert.equal(a.text+b.text,long.toString('utf8'));assert.doesNotMatch(a.text+b.text,/�/);
});

test('viewer freezes a complete frontend snapshot until an explicit backend replacement',async t=>{
 const assets=await mkdtemp(join(tmpdir(),'wsl-frozen-assets-'));t.after(()=>rm(assets,{recursive:true,force:true}));await mkdir(join(assets,'public'));
 for(const [name]of Object.values(ASSET_FILES))await writeFile(join(assets,'public',name),name==='app.js'?'/* version one */':name);
 const f=await fixture(t,{assetsRoot:assets}),before=await(await fetch(f.origin+'/api/viewer')).json();await writeFile(join(assets,'public/app.js'),'/* version two */');assert.equal(await(await fetch(f.origin+'/app.js')).text(),'/* version one */');const after=await(await fetch(f.origin+'/api/viewer')).json();assert.equal(after.apiVersion,API_VERSION);assert.equal(after.assetsVersion,before.assetsVersion);assert.equal(after.buildVersion,before.buildVersion);
});

test('frozen run versions outrank mutable source manifests and legacy manifests revalidate',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-manifest-integrity-'));t.after(()=>rm(root,{recursive:true,force:true}));const runsRoot=join(root,'runs');await mkdir(runsRoot);const progress=join(root,'progress.json'),manifest=join(root,'manifest.json');
 const data=record({status:'passed',finished:true,finishedAt:new Date().toISOString(),versions:[{name:'lib',head:'frozen'}],steps:[{id:'unit',status:'passed',exitCode:0}]});await writeFile(progress,JSON.stringify(data));await writeFile(manifest,JSON.stringify({repositories:{lib:{head:'now1'}}}));
 const server=await createViewer({runsRoot,sources:[{id:'external',progressFile:progress,logsRoot:root,manifestFile:manifest}]});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));const url='http://127.0.0.1:'+server.address().port+'/api/runs/external';
 assert.equal((await(await fetch(url)).json()).versions[0].head,'frozen');delete data.versions;await writeFile(progress,JSON.stringify(data));assert.equal((await(await fetch(url)).json()).versions[0].head,'now1');await writeFile(manifest,JSON.stringify({repositories:{lib:{head:'now2'}}}));assert.equal((await(await fetch(url)).json()).versions[0].head,'now2');data.versions=[];await writeFile(progress,JSON.stringify(data));await writeFile(manifest,'not json');assert.deepEqual((await(await fetch(url)).json()).versions,[]);
});
