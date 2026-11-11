import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {executePreparedJob,validateExecutionReceipt,preparedInputDigest,reserveDevice,releaseDevice} from '../run-queue.mjs';

const now=Date.parse('2026-11-12T04:00:00Z'),stamp=offset=>new Date(now+offset).toISOString(),digest='a'.repeat(64);
const binding={jobId:'job',attemptId:'attempt-a',deviceId:'remote',inputDigest:digest,started:now,receivedAt:now+2000};
const receipt=patch=>({format:'wsl-job-result-v2',dispatchJobId:'job',attemptId:'attempt-a',deviceId:'remote',inputDigest:digest,id:'actual-run',status:'passed',finished:true,commandStarted:true,startedAt:stamp(0),finishedAt:stamp(1000),...patch});

test('receipt validation binds this attempt, device and frozen inputs and rejects invalid time',()=>{
 assert.equal(validateExecutionReceipt(receipt(),binding,0).status,'passed');
 for(const patch of [{format:undefined},{attemptId:'previous-attempt'},{deviceId:'local'},{inputDigest:'b'.repeat(64)},{dispatchJobId:'another'},{startedAt:'not-a-date'},{startedAt:stamp(-30000)},{startedAt:stamp(1000),finishedAt:stamp(0)},{finishedAt:stamp(60000)},{tests:{fail:1}},{steps:[{status:'failed',exitCode:1}]}])assert.throws(()=>validateExecutionReceipt(receipt(patch),binding,0));
 assert.throws(()=>validateExecutionReceipt(receipt(),binding,1),/CONFLICT/);
 const source=receipt({startedAt:stamp(10000),finishedAt:stamp(11000)}),adjusted=validateExecutionReceipt(source,{...binding,clockOffsetMs:10000},0);assert.equal(adjusted.startedAt,stamp(0));assert.equal(adjusted.finishedAt,stamp(1000));
});

test('a bound no-start admission refusal becomes a queued wait, never a false completed execution',()=>{
 const blocked=receipt({status:'blocked',commandStarted:false,reportedAt:stamp(500),admission:{decision:'wait',reason:'统一flock占用'}});delete blocked.startedAt;delete blocked.finishedAt;
 const result=validateExecutionReceipt(blocked,binding,75);assert.equal(result.status,'queued');assert.equal(result.commandStarted,false);assert.equal(result.admissionEvidence.exitCode,75);assert.equal(Object.hasOwn(result,'startedAt'),false);assert.equal(Object.hasOwn(result,'receiptFile'),false);
 for(const patch of [{attemptId:'old'},{startedAt:null},{admission:{decision:'wait'}},{reportedAt:'invalid'}])assert.throws(()=>validateExecutionReceipt({...blocked,...patch},binding,75));
 assert.throws(()=>validateExecutionReceipt(blocked,binding,255));
});

test('bound live progress keeps actual start and advancing heartbeat separate from launch',()=>{
 const live=receipt({status:'running',finished:false,heartbeatAt:stamp(1500)});delete live.finishedAt;
 const progress=validateExecutionReceipt(live,binding,undefined,{terminal:false});assert.equal(progress.status,'running');assert.equal(progress.heartbeatAt,stamp(1500));
 assert.throws(()=>validateExecutionReceipt({...live,heartbeatAt:stamp(60000)},binding,undefined,{terminal:false}));
 assert.throws(()=>validateExecutionReceipt({...live,finished:true},binding,undefined,{terminal:false}));
});

test('only the owner releases an in-flight device reservation',()=>{
 const reservations=new Map(),a=reserveDevice(reservations,'remote','a');assert.ok(a);assert.equal(reserveDevice(reservations,'remote','c'),null);
 assert.equal(releaseDevice(reservations,null),false);assert.equal(reservations.get('remote'),a);assert.equal(releaseDevice(reservations,{deviceId:'remote',owner:'b'}),false);assert.equal(reservations.get('remote'),a);
 assert.equal(releaseDevice(reservations,a),true);const next=reserveDevice(reservations,'remote','next');assert.equal(releaseDevice(reservations,a),false);assert.equal(reservations.get('remote'),next);
});

test('input digests have deterministic ordering and reject missing or duplicate declared bindings',()=>{
 const a={path:'does-not-need-to-exist/a',sha256:'a'.repeat(64)},b={path:'b',sha256:'b'.repeat(64)};assert.equal(preparedInputDigest([a,b]),preparedInputDigest([b,a]));
 for(const inputs of [undefined,[],[a,a],[{path:'a',sha256:'bad'}]])assert.throws(()=>preparedInputDigest(inputs),/PREPARED_INPUT_INVALID/);
});

async function fixture(t,mode='pass'){
 const root=await mkdtemp(join(tmpdir(),'wsl-queue-adapter-v2-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'worker.mjs'),receiptFile=join(root,'receipt.json');
 const source=[
 "import{writeFile,rename,readFile,stat}from'node:fs/promises';",
 "const [file,mode]=process.argv.slice(2),base={format:'wsl-job-result-v2',dispatchJobId:process.env.WSL_CONSOLE_JOB_ID,attemptId:process.env.WSL_CONSOLE_ATTEMPT_ID,deviceId:process.env.WSL_CONSOLE_DEVICE_ID,inputDigest:process.env.WSL_CONSOLE_INPUT_DIGEST,id:'actual-run'};",
 "async function save(value){await writeFile(file+'.tmp',JSON.stringify(value));await rename(file+'.tmp',file)}",
 "if(mode==='silent')process.exit(0);",
 "if(mode==='wait'){await save({...base,status:'blocked',finished:true,commandStarted:false,reportedAt:new Date().toISOString(),admission:{decision:'wait',reason:'resource admission'}});process.exit(75)}",
 "const startedAt=new Date().toISOString();await save({...base,status:'running',finished:false,commandStarted:true,startedAt,heartbeatAt:startedAt});if(mode==='pass'){const deadline=Date.now()+5000;for(;;){try{await stat(file+'.ack');break}catch{}if(Date.now()>deadline)throw Error('no progress acknowledgement');await new Promise(ok=>setTimeout(ok,25));}}",
 "if(mode==='changed')await writeFile(new URL(import.meta.url),(await readFile(new URL(import.meta.url),'utf8'))+'\\n// changed');",
 "await save({...base,status:'passed',finished:true,commandStarted:true,startedAt,finishedAt:new Date().toISOString()});"
 ].join('\n');
 await writeFile(file,source);const inputs=[{path:file,sha256:createHash('sha256').update(source).digest('hex')}];
 const job={id:'job',dispatchLease:{token:'attempt-a'},inputs,executors:{remote:{file:process.execPath,args:[file,receiptFile,mode],receiptFile,admissionEnforced:true,lockEnforced:true,receiptProtocol:'wsl-job-result-v2'}}};return {root,file,receiptFile,job};
}

test('prepared v2 adapter reports actual live start and a matching terminal receipt',async t=>{
 const f=await fixture(t),progress=[];const result=await executePreparedJob(f.job,{id:'remote'},f.root,async item=>{progress.push(item);await writeFile(f.receiptFile+'.ack','ack')});assert.equal(result.status,'passed');assert.equal(result.attemptId,'attempt-a');assert.equal(result.inputDigest,preparedInputDigest(f.job.inputs));assert.ok(progress.some(item=>item.commandStarted&&item.status==='running'));await stat(join(f.root,'executor.log'));
 await writeFile(f.file,'changed');assert.equal((await executePreparedJob(f.job,{id:'remote'},f.root)).status,'queued');
});

test('adapter rejects legacy setup before spawn and preserves no-start admission waits',async t=>{
 const f=await fixture(t,'wait'),legacy=structuredClone(f.job);delete legacy.executors.remote.receiptProtocol;assert.equal((await executePreparedJob(legacy,{id:'remote'},f.root)).status,'queued');
 await assert.rejects(stat(f.receiptFile),{code:'ENOENT'});const waiting=await executePreparedJob(f.job,{id:'remote'},f.root);assert.equal(waiting.status,'queued');assert.equal(waiting.waitKind,'admission');assert.equal(waiting.admissionEvidence.exitCode,75);
});

test('a missing local log destination is a pre-start preparation wait',async t=>{
 const f=await fixture(t);const result=await executePreparedJob(f.job,{id:'remote'},join(f.root,'not-created'));assert.equal(result.status,'queued');assert.equal(result.commandStarted,false);await assert.rejects(stat(f.receiptFile),{code:'ENOENT'});
});

test('missing old-attempt or changed-input receipts never report a successful execution',async t=>{
 const missing=await fixture(t,'silent');await assert.rejects(executePreparedJob(missing.job,{id:'remote'},missing.root),/EXECUTION_RESULT_UNKNOWN/);
 await writeFile(missing.receiptFile,JSON.stringify(receipt({attemptId:'previous-attempt',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()})));await assert.rejects(executePreparedJob(missing.job,{id:'remote'},missing.root),/BINDING_MISMATCH/);
 const changed=await fixture(t,'changed');await assert.rejects(executePreparedJob(changed.job,{id:'remote'},changed.root),/EXECUTION_INPUTS_CHANGED/);
});
