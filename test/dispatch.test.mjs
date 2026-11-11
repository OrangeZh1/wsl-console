import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chooseExecutionDevice,dispatchQueuedJob} from '../dispatch.mjs';

const GiB=1024**3,now=Date.parse('2026-11-12T04:00:00Z'),stamp=offset=>new Date(now+offset).toISOString();
const task=patch=>({id:'job',approved:true,status:'queued',visibility:'none',portable:true,inputsReady:true,peakBytes:GiB/4,plannedDeviceId:'local',...patch});
const device=(id,transport='ssh',patch={})=>({id,transport,onlineState:'online',checkedAt:stamp(0),workload:'idle',resources:{state:'running',sampledAt:stamp(0),lockBusy:false,windows:{availableBytes:8*GiB},memory:{availableBytes:6*GiB},cpu:{logicalProcessors:4,load1:.5}},...patch});
const choices=()=>[device('local','local'),device('remote')];
const receipt=(status='passed')=>({status,runId:'actual-run',receiptFile:'prepared-terminal-receipt.json',exitCode:status==='passed'?0:1,finishedAt:stamp(1000)});
async function fixture(t,job=task()){
 const root=await mkdtemp(join(tmpdir(),'wsl-dispatch-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'job');await mkdir(directory);const file=join(directory,'job.json');await writeFile(file,JSON.stringify(job));return {root,directory,file,read:async()=>JSON.parse(await readFile(file,'utf8'))};
}

test('dispatch policy keeps public CI on Actions and never relocates started work',()=>{
 for(const patch of [{visibility:'public'},{repositoryVisibility:'public'},{sourcePublic:true}])assert.equal(chooseExecutionDevice(task(patch),choices(),{now}).route,'github-actions');
 for(const startedAt of [null,'',undefined,stamp(-1000)])assert.equal(chooseExecutionDevice(task({sourcePublic:true,startedAt}),choices(),{now}).route,'unchanged');
 for(const patch of [{status:'running'},{status:'failed'},{recoveryRequired:true},{dispatchLease:{token:'existing'}}])assert.equal(chooseExecutionDevice(task(patch),choices(),{now}).route,'unchanged');
 assert.equal(chooseExecutionDevice(task({approved:false}),choices(),{now}).route,'queued');assert.equal(chooseExecutionDevice(task({inputsReady:false}),choices(),{now}).route,'queued');assert.equal(chooseExecutionDevice(task({peakBytes:undefined}),choices(),{now}).route,'queued');
});

test('online remote capacity locks the location even while busy or below admission',()=>{
 assert.equal(chooseExecutionDevice(task(),choices(),{now}).deviceId,'remote');
 for(const change of [d=>d.resources.sampledAt=stamp(-46000),d=>d.resources=null,d=>d.workload='executing',d=>d.workload='unconfirmed',d=>d.leaseBusy=true,d=>d.resources.lockBusy=true,d=>d.resources.lockBusy=null,d=>d.resources.cpu.load1=4,d=>d.resources.windows.availableBytes=2*GiB,d=>d.resources.memory.availableBytes=GiB]){const devices=choices();change(devices[1]);const result=chooseExecutionDevice(task(),devices,{now});assert.equal(result.route,'queued');assert.match(result.reason,/远程在线，本机不接收项目/);}
 const low=choices();low.forEach(d=>d.resources.windows.availableBytes=2*GiB);assert.equal(chooseExecutionDevice(task(),low,{now}).route,'queued');
 const peak=choices();peak.forEach(d=>{d.resources.windows.availableBytes=3*GiB;d.resources.memory.availableBytes=3*GiB});assert.equal(chooseExecutionDevice(task({peakBytes:3*GiB}),peak,{now}).route,'queued');
 const stopped=choices();stopped[1].resources={state:'stopped',sampledAt:stamp(0),lockBusy:null,windows:{availableBytes:8*GiB},memory:null,cpu:null};const warm=chooseExecutionDevice(task(),stopped,{now});assert.equal(warm.deviceId,'remote');assert.equal(warm.needsWarmup,true);assert.match(warm.reason,/尚未通过 Linux 准入/);
 assert.equal(chooseExecutionDevice(task({portable:false}),choices(),{now}).route,'queued');assert.equal(chooseExecutionDevice(task({portable:false,plannedDeviceId:'remote'}),choices(),{now}).deviceId,'remote');
});

test('stale unknown or absent remote probes never authorize local fallback',()=>{
 for(const change of [d=>d.onlineState='unknown',d=>d.onlineState='stale',d=>d.checkedAt=stamp(-46000),d=>delete d.checkedAt,d=>d.checkedAt=stamp(6000),d=>{d.onlineState='unreachable';d.checkedAt=stamp(-46000)}]){const devices=choices();change(devices[1]);assert.equal(chooseExecutionDevice(task(),devices,{now}).route,'queued');}
 assert.equal(chooseExecutionDevice(task(),[device('local','local')],{now}).route,'queued');
 const mixed=[device('local','local'),device('remote','ssh',{onlineState:'unreachable'}),device('other','ssh',{onlineState:'unknown'})];assert.equal(chooseExecutionDevice(task(),mixed,{now}).route,'queued');
 const duplicate=[device('local','local'),device('remote','ssh',{onlineState:'unreachable'}),device('remote','ssh',{onlineState:'unreachable'})];assert.equal(chooseExecutionDevice(task(),duplicate,{now}).route,'queued');
});

test('only every configured remote being freshly unreachable permits local admission',()=>{
 const offline=()=>[device('local','local'),device('remote','ssh',{onlineState:'unreachable'}),device('other','ssh',{onlineState:'unreachable'})];
 const local=chooseExecutionDevice(task(),offline(),{now});assert.equal(local.deviceId,'local');assert.match(local.reason,/所有远程均已确认不可达/);
 for(const change of [d=>d.workload='executing',d=>d.resources.lockBusy=true,d=>d.resources.lockBusy=null,d=>d.resources.windows.availableBytes=2*GiB,d=>d.resources.memory.availableBytes=GiB,d=>d.resources.cpu.load1=4,d=>d.resources.sampledAt=stamp(-46000)]){const devices=offline();change(devices[0]);assert.equal(chooseExecutionDevice(task(),devices,{now}).route,'queued');}
 assert.equal(chooseExecutionDevice(task({portable:false}),offline(),{now}).deviceId,'local');assert.equal(chooseExecutionDevice(task({portable:false,plannedDeviceId:'remote'}),offline(),{now}).route,'queued');
 const mixed=offline();mixed[2].onlineState='online';mixed[2].workload='executing';assert.equal(chooseExecutionDevice(task(),mixed,{now}).route,'queued');
});

test('one atomic task lease covers callback lifetime and preserves assignment and failed attempts',async t=>{
 const f=await fixture(t,task({revision:3,attemptHistory:[{result:{status:'failed',exitCode:7}}]}));let release,entered;const started=new Promise(ok=>entered=ok);let calls=0;
 const running=dispatchQueuedJob(f.root,'job',choices(),async(job,d)=>{calls++;assert.equal(job.plannedDeviceId,'remote');assert.equal(d.id,'remote');assert.equal(own(job,'startedAt'),false);assert.equal((await f.read()).revision,4);assert.ok((await stat(join(f.directory,'lease'))).isDirectory());entered();await new Promise(ok=>release=ok);return receipt('failed')},{now});
 await started;const duplicate=await dispatchQueuedJob(f.root,'job',choices(),()=>{calls++;throw Error('duplicate')},{now});assert.equal(duplicate.route,'unchanged');assert.equal(calls,1);release();const result=await running;assert.equal(result.status,'failed');const saved=await f.read();assert.equal(saved.status,'failed');assert.equal(saved.assignmentHistory[0].fromDeviceId,'local');assert.equal(saved.assignmentHistory[0].toDeviceId,'remote');assert.equal(saved.attemptHistory.length,2);assert.equal(saved.attemptHistory[0].result.exitCode,7);assert.equal(saved.result.runId,'actual-run');assert.equal(saved.revision,5);await assert.rejects(stat(join(f.directory,'lease')),{code:'ENOENT'});
});
const own=(object,key)=>Object.hasOwn(object,key);

test('simultaneous dispatchers elect one lease owner before either callback can finish',{timeout:2000},async t=>{
 const f=await fixture(t);let release,entered,calls=0;const active=new Promise(ok=>entered=ok),completed=new Promise(ok=>release=ok),execute=async()=>{calls++;entered();await completed;return receipt()};
 const runs=[dispatchQueuedJob(f.root,'job',choices(),execute,{now}),dispatchQueuedJob(f.root,'job',choices(),execute,{now})];await active;const loser=await Promise.race(runs);assert.ok(['queued','unchanged'].includes(loser.route));assert.equal(calls,1);release();const results=await Promise.all(runs);assert.equal(results.filter(result=>result.status==='passed').length,1);assert.equal((await f.read()).attemptHistory.length,1);
});

test('pre-existing leases are retained without stale-time reclaim and public planning never executes a device',async t=>{
 const f=await fixture(t);await mkdir(join(f.directory,'lease'));await writeFile(join(f.directory,'lease','other.json'),'keep');let called=false;const blocked=await dispatchQueuedJob(f.root,'job',choices(),()=>{called=true},{now});assert.equal(blocked.route,'queued');assert.equal(called,false);assert.equal(await readFile(join(f.directory,'lease','other.json'),'utf8'),'keep');assert.equal((await f.read()).plannedDeviceId,'local');
 const g=await fixture(t,task({sourcePublic:true}));const routed=await dispatchQueuedJob(g.root,'job',[],()=>{called=true},{now});assert.equal(routed.route,'github-actions');assert.equal(called,false);const saved=await g.read();assert.equal(saved.executionRoute,'github-actions');assert.equal(own(saved,'plannedDeviceId'),false);assert.equal(own(saved,'startedAt'),false);await assert.rejects(stat(join(g.directory,'lease')),{code:'ENOENT'});
});

test('only a command-free queued result releases a lease for another attempt',async t=>{
 const f=await fixture(t),called=[];const queued=await dispatchQueuedJob(f.root,'job',choices(),(_job,d)=>{called.push(d.id);return {status:'queued',reason:'prepared adapter not ready'}},{now});assert.equal(queued.route,'queued');assert.equal(queued.leaseRetained,false);let saved=await f.read();assert.equal(saved.status,'queued');assert.equal(saved.plannedDeviceId,'remote');assert.equal(own(saved,'startedAt'),false);assert.equal(own(saved,'dispatchLease'),false);const passed=await dispatchQueuedJob(f.root,'job',choices(),(_job,d)=>{called.push(d.id);return receipt()},{now});assert.equal(passed.status,'passed');assert.deepEqual(called,['remote','remote']);saved=await f.read();assert.equal(saved.attemptHistory.length,2);
 const g=await fixture(t);const ambiguous=await dispatchQueuedJob(g.root,'job',choices(),()=>({status:'queued',exitCode:0}),{now});assert.equal(ambiguous.recoveryRequired,true);assert.ok((await stat(join(g.directory,'lease'))).isDirectory());
});

test('exceptions, timeouts and missing terminal receipts retain recovery leases and never rerun',async t=>{
 for(const execute of [()=>{throw Error('SSH result unknown')},()=>({status:'timeout'}),()=>({status:'passed',exitCode:0}),()=>({...receipt(),timedOut:true})]){
  const f=await fixture(t);const result=await dispatchQueuedJob(f.root,'job',choices(),execute,{now});assert.equal(result.recoveryRequired,true);const saved=await f.read();assert.equal(saved.recoveryRequired,true);assert.equal(saved.status,'blocked');assert.equal(saved.dispatchLease.state,'recovery-required');const owner=JSON.parse(await readFile(join(f.directory,'lease','owner.json'),'utf8'));assert.equal(owner.recoveryRequired,true);let reran=false;assert.equal((await dispatchQueuedJob(f.root,'job',choices(),()=>{reran=true},{now})).route,'unchanged');assert.equal(reran,false);
 }
});

test('conflicting manifest writes and extra recovery files cannot be overwritten or cleared',async t=>{
 const f=await fixture(t);const result=await dispatchQueuedJob(f.root,'job',choices(),async()=>{const changed=await f.read();changed.revision++;changed.external='new writer evidence';await writeFile(f.file,JSON.stringify(changed));return receipt()},{now});assert.equal(result.recoveryRequired,true);assert.equal((await f.read()).external,'new writer evidence');assert.equal(JSON.parse(await readFile(join(f.directory,'lease','owner.json'),'utf8')).recoveryRequired,true);
 const g=await fixture(t);const retained=await dispatchQueuedJob(g.root,'job',choices(),async()=>{await writeFile(join(g.directory,'lease','recovery.txt'),'keep');return receipt()},{now});assert.equal(retained.recoveryRequired,true);assert.equal(await readFile(join(g.directory,'lease','recovery.txt'),'utf8'),'keep');await assert.rejects(dispatchQueuedJob(g.root,'../job',choices(),()=>receipt(),{now}),/QUEUE_JOB_ID_INVALID/);
});
