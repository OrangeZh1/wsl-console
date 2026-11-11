import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir,hostname,platform} from 'node:os';
import {join} from 'node:path';
import {captureHost,normalizeHost} from '../host.mjs';
import {createReporter} from '../reporter.mjs';
import {createViewer} from '../server.mjs';

test('host snapshots whitelist identity fields and validate text and observation dates',()=>{
 const host=normalizeHost({id:'pc-b',name:' 远程验收电脑 ',hostname:'qa-b',computerName:'Windows-B',platform:'linux',distro:'Ubuntu-24.04',source:'manual',observedAt:'2026-11-12T00:00:00+08:00',password:'private',token:'private',address:'private'});
 assert.deepEqual(host,{id:'pc-b',name:'远程验收电脑',hostname:'qa-b',computerName:'Windows-B',platform:'linux',distro:'Ubuntu-24.04',source:'manual',observedAt:'2026-11-11T16:00:00.000Z'});
 for(const value of [null,[],{},'pc',{name:'\nunsafe'},{hostname:'x'.repeat(161)}])assert.equal(normalizeHost(value),null);
 assert.deepEqual(normalizeHost({name:'pc',observedAt:'bad',source:'unrecognized'}),{name:'pc',source:'reported'});
 const sampled=captureHost({name:'工作台别名'});assert.equal(sampled.hostname,hostname());assert.equal(sampled.platform,platform());assert.equal(sampled.name,'工作台别名');assert.equal(sampled.source,'sampled');assert.ok(Number.isFinite(Date.parse(sampled.observedAt)));
});

test('reporter captures executor once and preserves an explicitly reported remote computer',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-host-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const local=await createReporter(root,{id:'local',steps:[{id:'check'}]});const first=(await local.snapshot()).executor;assert.equal(first.hostname,hostname());assert.equal(first.source,'sampled');await local.step('check',{status:'running'});assert.deepEqual((await local.snapshot()).executor,first);
 const remote=await createReporter(root,{id:'remote',executor:{id:'remote-b',name:'另一台电脑',hostname:'qa-b',source:'manual',observedAt:'2026-11-12T00:00:00Z',token:'must-not-escape'},steps:[{id:'check'}]});assert.equal((await remote.snapshot()).executor.hostname,'qa-b');assert.equal((await remote.snapshot()).executor.source,'manual');assert.doesNotMatch(JSON.stringify((await remote.snapshot()).executor),/token|must-not-escape/);
 await assert.rejects(createReporter(root,{id:'invalid',executor:{token:'invalid'},steps:[{id:'check'}]}),/EXECUTOR_INVALID/);
});

test('viewer keeps per-run computer identity distinct from its own host and leaves unknown history unknown',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-host-viewer-'));t.after(()=>rm(root,{recursive:true,force:true}));const runsRoot=join(root,'runs');await mkdir(runsRoot);
 const definition={steps:[{id:'check',status:'queued'}],status:'queued',finished:false};
 for(const [id,executor] of [['local',{name:'本机',hostname:'pc-a'}],['remote',{name:'远程',hostname:'pc-b',token:'hidden'}],['old',undefined],['invalid',{password:'hidden'}]]){await mkdir(join(runsRoot,id));await writeFile(join(runsRoot,id,'run.json'),JSON.stringify({...definition,id,executor}));}
 const legacyFile=join(root,'legacy.json');await writeFile(legacyFile,JSON.stringify(definition));
 const server=await createViewer({runsRoot,host:{name:'工作台主机'},sources:[{id:'legacy',progressFile:legacyFile,logsRoot:root,executor:{name:'明确配置的旧执行电脑',hostname:'legacy-pc'}}]});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));const origin='http://127.0.0.1:'+server.address().port;
 const response=await(await fetch(origin+'/api/runs')).json();assert.equal(response.viewerHost.name,'工作台主机');assert.equal(response.runs.find(run=>run.id==='local').executor.hostname,'pc-a');assert.equal(response.runs.find(run=>run.id==='remote').executor.hostname,'pc-b');assert.equal(response.runs.find(run=>run.id==='old').executor,null);assert.equal(response.runs.find(run=>run.id==='invalid').executor,null);assert.equal(response.runs.find(run=>run.id==='legacy').executor.source,'configured');assert.doesNotMatch(JSON.stringify(response),/token|password|hidden/);
 const viewer=await(await fetch(origin+'/api/viewer')).json();assert.deepEqual(viewer.host,response.viewerHost);const remote=await(await fetch(origin+'/api/runs/remote')).json();assert.equal(remote.executor.hostname,'pc-b');assert.equal(JSON.parse(await readFile(join(runsRoot,'old/run.json'),'utf8')).executor,undefined);
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await fetch(origin+'/api/viewer',{method})).status,405);
});
