import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReporter} from '../reporter.mjs';
import {createViewer} from '../server.mjs';

test('activity reports actual running work without resetting timing and API preserves task identity',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wsl-activity-'));t.after(()=>rm(directory,{recursive:true,force:true}));const runsRoot=join(directory,'runs');await mkdir(runsRoot);
 const reporter=await createReporter(runsRoot,{id:'run-1',taskKey:'app-build',name:'构建',steps:[{id:'build',label:'构建后台'}]});
 assert.equal(reporter.workDirectory,join(runsRoot,'run-1','work'));
 await assert.rejects(reporter.activity('build','尚未开始'),/REQUIRES_RUNNING/);
 const startedAt='2026-11-09T12:00:00.000Z';await reporter.step('build',{status:'running',startedAt,command:['node','build.mjs']});
 await Promise.all([reporter.activity('build','正在编译后台 3/6 页'),reporter.log('build','实际构建日志\n')]);
 const record=await reporter.snapshot();assert.equal(record.steps[0].startedAt,startedAt);assert.equal(record.steps[0].activity,'正在编译后台 3/6 页');assert.ok(Number.isFinite(Date.parse(record.steps[0].activityUpdatedAt)));
 await assert.rejects(reporter.activity('build',' '),/MESSAGE_INVALID/);
 const server=await createViewer({runsRoot});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));
 const run=await(await fetch('http://127.0.0.1:'+server.address().port+'/api/runs/run-1')).json();assert.equal(run.taskKey,'app-build');assert.equal(run.steps[0].activity,record.steps[0].activity);assert.equal(run.steps[0].activityUpdatedAt,record.steps[0].activityUpdatedAt);assert.equal(run.steps[0].startedAt,startedAt);
 await reporter.step('build',{status:'failed',exitCode:1});await reporter.step('build',{status:'running'});const retry=await reporter.snapshot();assert.equal(retry.steps[0].activity,undefined);assert.equal(retry.steps[0].activityUpdatedAt,undefined);
 await reporter.step('build',{status:'passed',exitCode:0});await reporter.finish();await assert.rejects(reporter.activity('build','过期活动'),/REQUIRES_RUNNING/);
});

test('invalid task identity fails before creating a directory',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-activity-invalid-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(createReporter(root,{id:'invalid',taskKey:'',steps:[{id:'a'}]}),/TASK_KEY_INVALID/);
 const {readdir}=await import('node:fs/promises');assert.deepEqual(await readdir(root),[]);
});

test('repeated running updates retain the phase start and progress while a real retry starts a new attempt',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-stable-timing-'));t.after(()=>rm(root,{recursive:true,force:true}));const reporter=await createReporter(root,{id:'same-run',steps:[{id:'work'}]});
 const initial='2026-11-10T12:00:00.000Z';await reporter.step('work',{status:'running',startedAt:initial,activity:'第一项',activityUpdatedAt:initial,tests:{pass:2,fail:0,skipped:0}});
 await reporter.step('work',{status:'running',detail:'仍在执行'});await reporter.step('work',{status:'running',startedAt:'2026-11-10T12:05:00.000Z',activity:'下一项',seconds:0,finishedAt:'2026-11-10T12:04:00.000Z',exitCode:1});
 const running=await reporter.snapshot();assert.equal(running.startedAt,initial);assert.equal(running.steps[0].startedAt,initial);assert.equal(running.steps[0].activity,'下一项');assert.equal(running.steps[0].activityUpdatedAt,initial);assert.equal(running.steps[0].tests.pass,2);for(const key of ['seconds','finishedAt','exitCode'])assert.equal(running.steps[0][key],undefined,key);
 await reporter.step('work',{status:'failed',exitCode:1,error:'真实失败'});const failure=(await reporter.snapshot()).steps[0];const retryStart='2026-11-10T12:10:00.000Z';await reporter.step('work',{status:'running',startedAt:retryStart});const retry=await reporter.snapshot();assert.equal(retry.steps[0].startedAt,retryStart);assert.equal(retry.startedAt,initial);assert.equal(retry.steps[0].activity,undefined);assert.equal(retry.steps[0].error,undefined);assert.equal(retry.steps[0].attempts.length,1);assert.equal(retry.steps[0].attempts[0].error,'真实失败');assert.equal(retry.steps[0].attempts[0].startedAt,initial);assert.equal(retry.steps[0].attempts[0].finishedAt,failure.finishedAt);assert.equal(retry.steps[0].attempts[0].seconds,failure.seconds);
 const second=await createReporter(root,{id:'new-run',taskKey:'same-task',steps:[{id:'work'}]});await second.step('work',{status:'running',startedAt:retryStart});assert.equal((await second.snapshot()).startedAt,retryStart);
});
