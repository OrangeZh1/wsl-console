import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createViewer} from '../server.mjs';
import {createReporter} from '../reporter.mjs';

test('workflow stays active while its next stage waits; completed logs and truthful queued stages remain available',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-workflow-wait-')),reporter=await createReporter(root,{id:'workflow',taskKey:'workflow',name:'流程等待测试数据',projects:['test'],steps:[{id:'first',label:'首个阶段'},{id:'flow',label:'验收流程'},{id:'next',label:'后续阶段'}]}),server=await createViewer({runsRoot:root});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})});
 const origin='http://127.0.0.1:'+server.address().port,read=async()=>(await(await fetch(origin+'/api/runs')).json()).runs[0];
 assert.equal((await read()).status,'queued');
 await reporter.step('first',{status:'running',command:['node','first.mjs']});await reporter.log('first','FIRST PASSED\n');await reporter.step('first',{status:'passed',exitCode:0});
 const reason='等待Windows可用内存达到准入线';await reporter.step('flow',{status:'running',activity:'阶段等待资源：'+reason+'；本阶段命令尚未启动'});await reporter.step('next',{status:'queued',detail:reason});
 const recordFile=join(root,'workflow/run.json'),record=JSON.parse(await readFile(recordFile,'utf8'));record.queueReason=reason;await writeFile(recordFile,JSON.stringify(record));
 const waiting=await read();assert.equal(waiting.status,'running');assert.equal(waiting.queueReason,reason);assert.ok(waiting.startedAt);assert.match(waiting.steps.find(s=>s.id==='flow').activity,/阶段等待资源/);const next=waiting.steps.find(s=>s.id==='next');assert.equal(next.status,'queued');assert.equal(next.startedAt,undefined);assert.equal(next.exitCode,undefined);assert.equal(next.tests,undefined);assert.deepEqual(next.command,[]);
 assert.equal((await(await fetch(origin+'/api/runs/workflow/steps/first/log')).json()).text,'FIRST PASSED\n');assert.equal((await(await fetch(origin+'/api/runs/workflow/steps/next/log')).json()).text,'');
 await reporter.step('next',{status:'running',command:['node','next.mjs']});assert.equal((await read()).status,'running');await reporter.step('next',{status:'passed',exitCode:0});await reporter.step('flow',{status:'passed',exitCode:0});await reporter.finish();assert.equal((await read()).status,'passed');
});

test('queue reasons are exposed only as executor text and never stringify objects',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-queue-reason-')),reporter=await createReporter(root,{id:'reason',steps:[{id:'flow'}]}),server=await createViewer({runsRoot:root});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})});
 await reporter.step('flow',{status:'running'});const file=join(root,'reason/run.json'),record=JSON.parse(await readFile(file,'utf8')),url='http://127.0.0.1:'+server.address().port+'/api/runs/reason';
 for(const value of [{message:'do not stringify'},42,null,'   ']){record.queueReason=value;await writeFile(file,JSON.stringify(record));assert.equal((await(await fetch(url)).json()).queueReason,undefined)}
 record.queueReason='  等待明确锁 <tag>  ';await writeFile(file,JSON.stringify(record));assert.equal((await(await fetch(url)).json()).queueReason,'等待明确锁 <tag>');
});
