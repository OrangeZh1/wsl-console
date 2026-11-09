import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createViewer} from '../server.mjs';
import {createReporter} from '../reporter.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'wsl-progress-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const runsRoot=join(root,'runs');await mkdir(runsRoot);const reporter=await createReporter(runsRoot,{id:'example',name:'真实测试记录',projects:['example-project'],steps:[{id:'unit',label:'单元测试'},{id:'build',label:'构建'}]});const server=await createViewer({runsRoot});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));return {root,runsRoot,reporter,url:'http://127.0.0.1:'+server.address().port};}
test('viewer reads live progress, history, commands and incremental UTF-8 logs',async t=>{const f=await fixture(t);await f.reporter.step('unit',{status:'running',command:['node','--test']});await f.reporter.log('unit','开始测试\n');let runs=await(await fetch(f.url+'/api/runs')).json();assert.equal(runs.readOnly,true);assert.equal(runs.runs[0].status,'running');assert.equal(runs.runs[0].projects[0],'example-project');const first=await(await fetch(f.url+'/api/runs/example/steps/unit/log')).json();assert.equal(first.text,'开始测试\n');await f.reporter.log('unit','检查通过\n');const second=await(await fetch(f.url+'/api/runs/example/steps/unit/log?offset='+first.nextOffset)).json();assert.equal(second.text,'检查通过\n');await f.reporter.step('unit',{status:'passed',exitCode:0,tests:{pass:3,fail:0,skipped:0}});runs=await(await fetch(f.url+'/api/runs')).json();assert.equal(runs.runs[0].steps[0].tests.pass,3);});
test('viewer exposes no mutation or task-control methods',async t=>{const f=await fixture(t),before=await f.reporter.snapshot();for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await fetch(f.url+'/api/runs/example',{method,body:'{"command":"touch /tmp/should-not-execute"}'})).status,405);assert.deepEqual(await f.reporter.snapshot(),before);});
test('viewer blocks unknown paths, negative cursors and log symlink escapes',async t=>{
 const f=await fixture(t);await f.reporter.step('unit',{status:'running'});
 assert.equal((await fetch(f.url+'/api/runs/example/steps/missing/log')).status,404);assert.equal((await fetch(f.url+'/api/runs/example/steps/unit/log?offset=-1')).status,400);
 const privateDirectory=join(f.root,'private');await mkdir(privateDirectory);const privateFile=join(privateDirectory,'private.txt');await writeFile(privateFile,'private');
 await symlink(process.platform==='win32'?privateDirectory:privateFile,join(f.runsRoot,'example/logs/unit.log'),process.platform==='win32'?'junction':'file');
 assert.equal((await fetch(f.url+'/api/runs/example/steps/unit/log')).status,403);assert.equal((await fetch(f.url+'/config.json')).status,404);
});

test('queued tasks expose only supplied queue metadata and cannot inherit stale execution results',async t=>{
 const f=await fixture(t);await f.reporter.queue({queuePosition:3});let run=await(await fetch(f.url+'/api/runs/example')).json();assert.equal(run.status,'queued');assert.ok(run.enqueuedAt);assert.equal(run.queuePosition,3);assert.equal(run.startedAt,undefined);
 const path=join(f.runsRoot,'example/run.json'),record=JSON.parse(await readFile(path,'utf8'));Object.assign(record.steps[0],{status:'queued',startedAt:'2026-11-09T12:00:00Z',seconds:99,exitCode:1,tests:{pass:2,fail:1,skipped:0}});await writeFile(path,JSON.stringify(record));await writeFile(join(f.runsRoot,'example/logs/unit.log'),'OLD EXECUTION');
 run=await(await fetch(f.url+'/api/runs/example')).json();for(const key of ['startedAt','finishedAt','seconds','exitCode','tests'])assert.equal(run.steps[0][key],undefined,key);assert.deepEqual(await(await fetch(f.url+'/api/runs/example/steps/unit/log?offset=4')).json(),{text:'',nextOffset:0,total:0,reset:true});
 await f.reporter.queue();run=await(await fetch(f.url+'/api/runs/example')).json();assert.equal(run.queuePosition,undefined);await assert.rejects(f.reporter.finish(),/QUEUED/);
 await f.reporter.step('unit',{status:'running'});run=await(await fetch(f.url+'/api/runs/example')).json();assert.equal(run.status,'running');assert.ok(run.startedAt);assert.equal(run.queuePosition,undefined);await assert.rejects(f.reporter.queue({queuePosition:1}),/ALREADY_STARTED/);
});

test('multiple projects may run concurrently while another task waits independently',async t=>{
 const f=await fixture(t),other=await createReporter(f.runsRoot,{id:'other',name:'另一个项目',projects:['other-project'],steps:[{id:'build'}]}),waiting=await createReporter(f.runsRoot,{id:'waiting',name:'排队任务',projects:['third-project'],steps:[{id:'build'}]});
 await Promise.all([f.reporter.step('unit',{status:'running'}),other.step('build',{status:'running'})]);await waiting.queue({queuePosition:2});const data=await(await fetch(f.url+'/api/runs')).json();assert.equal(data.runs.filter(item=>item.status==='running').length,2);assert.equal(data.runs.filter(item=>item.status==='queued').length,1);assert.equal(data.runs.find(item=>item.id==='waiting').startedAt,undefined);assert.equal(data.runs.find(item=>item.id==='waiting').queuePosition,2);
 await f.reporter.step('unit',{status:'passed',exitCode:0});assert.equal((await(await fetch(f.url+'/api/runs/example')).json()).status,'running','a running task can be between stages');
});

test('invalid queue definitions create no task directory and inconsistent success records cannot pass',async t=>{
 const f=await fixture(t);await assert.rejects(createReporter(f.runsRoot,{id:'invalid',queuePosition:0,steps:[{id:'unit'}]}),/QUEUE_POSITION_INVALID/);assert.deepEqual(await readdir(f.runsRoot),['example']);
 const path=join(f.runsRoot,'example/run.json'),original=JSON.parse(await readFile(path,'utf8'));
 for(const patch of [
  {finished:false,steps:[{id:'unit',status:'passed',exitCode:0}]},
  {finished:true,steps:[{id:'unit',status:'queued'}]},
  {finished:true,steps:[{id:'unit',status:'failed',exitCode:1}]},
  {finished:true,steps:[{id:'unit',status:'passed',exitCode:1}]},
  {finished:true,steps:[{id:'unit',status:'passed',exitCode:0,tests:{pass:1,fail:1,skipped:0}}]},
  {finished:true,steps:[{id:'unit',status:'passed'}]}
 ]){await writeFile(path,JSON.stringify({...original,status:'passed',...patch}));assert.notEqual((await(await fetch(f.url+'/api/runs/example')).json()).status,'passed');}
 await writeFile(path,JSON.stringify({...original,status:'passed',finished:true,steps:[{id:'unit',status:'passed',exitCode:0,tests:{pass:1,fail:0,skipped:0}}]}));assert.equal((await(await fetch(f.url+'/api/runs/example')).json()).status,'passed');
 // The pre-reporter environment-only record has no command or exit code.
 await writeFile(path,JSON.stringify({finished:true,steps:[{id:'environment',status:'passed'}]}));assert.equal((await(await fetch(f.url+'/api/runs/example')).json()).status,'passed');
});
test('viewer rejects foreign Host headers and serves final initial title',async t=>{const f=await fixture(t);const status=await new Promise((ok,fail)=>{const req=request(f.url,{headers:{host:'attacker.example'}},res=>{res.resume();ok(res.statusCode)});req.on('error',fail);req.end()});assert.equal(status,403);const html=await(await fetch(f.url)).text();assert.match(html,/<title>WSL 验收进度<\/title>/);assert.doesNotMatch(html,/只读查看器|class="readonly"/);assert.match(html,/<header class="topbar">.*id="refresh"/);});
test('reporter preserves parallel stage updates and rejects false success',async t=>{const f=await fixture(t);await Promise.all(['unit','build'].map(id=>f.reporter.step(id,{status:'running'})));await assert.rejects(f.reporter.step('unit',{status:'passed',exitCode:1}),/REQUIRES_SUCCESS/);await assert.rejects(f.reporter.finish(),/STILL_RUNNING/);await f.reporter.step('unit',{status:'passed',exitCode:0});await f.reporter.step('build',{status:'failed',exitCode:2});await f.reporter.finish();const run=await(await fetch(f.url+'/api/runs/example')).json();assert.equal(run.finished,true);assert.equal(run.status,'failed');assert.equal(run.steps[0].status,'passed');});
test('legacy retry records do not show prior exit codes or frozen durations as current results',async t=>{const f=await fixture(t);const path=join(f.runsRoot,'example/run.json');const record=JSON.parse(await readFile(path,'utf8'));delete record.startedAt;Object.assign(record.steps[0],{status:'running',startedAt:'2026-11-09T12:10:00Z',seconds:320,exitCode:1,finishedAt:'2026-11-09T12:05:00Z',attempts:[{startedAt:'2026-11-09T12:00:00Z'}]});await writeFile(path,JSON.stringify(record));const run=await(await fetch(f.url+'/api/runs/example')).json();assert.equal(run.startedAt,'2026-11-09T12:00:00Z');assert.equal(run.steps[0].seconds,undefined);assert.equal(run.steps[0].exitCode,undefined);assert.equal(run.steps[0].finishedAt,undefined);});
