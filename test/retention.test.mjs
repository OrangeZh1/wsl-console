import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,symlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {isExpiredHistory,pruneHistory,startHistoryMaintenance,HISTORY_CHECK_INTERVAL} from '../retention.mjs';
import {createViewer} from '../server.mjs';

const day=86400000,now=Date.parse('2026-11-09T14:00:00Z'),iso=offset=>new Date(now-offset*day).toISOString();
const exists=path=>access(path).then(()=>true,()=>false);
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'wsl-retention-test-')),runsRoot=join(root,'runs');await mkdir(runsRoot);t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true})});return {root,runsRoot};}
async function run(f,id,patch={}){const directory=join(f.runsRoot,id);await mkdir(join(directory,'logs'),{recursive:true});const record={format:'wsl-progress-v1',id,name:id,status:'passed',finished:true,finishedAt:iso(31),steps:[{id:'unit',status:'passed',exitCode:0}],...patch};await writeFile(join(directory,'run.json'),JSON.stringify(record));await writeFile(join(directory,'logs/unit.log'),'task-owned test log');return {directory,record};}

test('retention deletes only completed history strictly older than 30 days',async t=>{
 const f=await fixture(t);for(const [id,age] of [['old',31],['boundary',30],['recent',29],['future',-1]])await run(f,id,{finishedAt:iso(age)});
 await run(f,'invalid',{finishedAt:'not a date'});await run(f,'invalid-calendar',{finishedAt:'2026-02-30T00:00:00.123456+00:00'});await run(f,'invalid-start',{startedAt:'2026-09-31T00:00:00.123456+00:00'});await run(f,'missing',{finishedAt:undefined});await run(f,'micro',{finishedAt:'2026-10-08T14:00:00.123456+00:00'});await run(f,'nano',{finishedAt:'2026-10-08T14:00:00.123456789Z'});await run(f,'invalid-fraction',{finishedAt:'2026-10-08T14:00:00.1234567890Z'});await run(f,'future-micro',{finishedAt:'2026-11-10T14:00:00.123456+00:00'});await run(f,'inverted-micro',{startedAt:'2026-11-08T14:00:00.123456+00:00',finishedAt:'2026-10-08T14:00:00.123456+00:00'});
 const dry=await pruneHistory(f,{now,dryRun:true});assert.deepEqual(dry.wouldRemove.sort(),['micro','nano','old']);assert.equal(await exists(join(f.runsRoot,'old/logs/unit.log')),true);
 const result=await pruneHistory(f,{now});assert.deepEqual(result.removed.sort(),['micro','nano','old']);assert.equal(result.status,'completed');assert.equal(await exists(join(f.runsRoot,'old')),false);
 for(const id of ['boundary','recent','future','invalid','invalid-calendar','invalid-start','missing','invalid-fraction','future-micro','inverted-micro'])assert.equal(await exists(join(f.runsRoot,id)),true,id);
});

test('active, waiting, unfinished, protected, referenced and configured-source runs survive',async t=>{
 const f=await fixture(t);
 await run(f,'active',{status:'running'});await run(f,'queued',{status:'queued'});await run(f,'unfinished',{finished:false});await run(f,'active-step',{steps:[{id:'unit',status:'running'}]});
 await run(f,'retain',{retain:true});await run(f,'protected',{protected:true});await run(f,'retention-keep',{retention:{keep:true}});await run(f,'referenced');await run(f,'reference-owner',{recoveryRefs:[{runId:'referenced'}]});await run(f,'configured');
 const alias=join(f.root,'configured-alias');await symlink(join(f.runsRoot,'configured'),alias,process.platform==='win32'?'junction':'dir');
 const result=await pruneHistory({...f,sources:[{progressFile:join(alias,'run.json')}]},{now});assert.deepEqual(result.removed,[]);assert.equal(result.retained.find(item=>item.id==='referenced').reason,'RECOVERY_REFERENCE');assert.equal(result.retained.find(item=>item.id==='configured').reason,'CONFIGURED_SOURCE');
});

test('unknown content, unfinished metadata writes and malformed records are preserved',async t=>{
 const f=await fixture(t);
 for(const id of ['extra','nested','unknown-log','writing','bad-json','wrong-id','wrong-format'])await run(f,id);
 await writeFile(join(f.runsRoot,'extra/report.json'),'formal evidence');await mkdir(join(f.runsRoot,'nested/logs/artifacts'));await writeFile(join(f.runsRoot,'unknown-log/logs/foreign.log'),'other log');await writeFile(join(f.runsRoot,'writing/run.json.tmp'),'unfinished recovery');
 await writeFile(join(f.runsRoot,'bad-json/run.json'),'{');await run(f,'wrong-id',{id:'someone-else'});await run(f,'wrong-format',{format:'other-tool'});
 const result=await pruneHistory(f,{now});assert.deepEqual(result.removed,[]);assert.equal(result.status,'partial');assert.ok(result.errors.some(item=>item.id==='bad-json'));assert.equal((await readFile(join(f.runsRoot,'extra/report.json'),'utf8')),'formal evidence');
});

test('retention refuses symbolic links and cannot escape its exact run root',async t=>{
 const f=await fixture(t),outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'private.txt'),'must survive');
 await symlink(outside,join(f.runsRoot,'directory-link'),process.platform==='win32'?'junction':'dir');
 await run(f,'metadata-link');await rm(join(f.runsRoot,'metadata-link/run.json'));await symlink(process.platform==='win32'?outside:join(outside,'private.txt'),join(f.runsRoot,'metadata-link/run.json'),process.platform==='win32'?'junction':'file');
 await run(f,'log-link');await rm(join(f.runsRoot,'log-link/logs'),{recursive:true});await symlink(outside,join(f.runsRoot,'log-link/logs'),process.platform==='win32'?'junction':'dir');
 const result=await pruneHistory(f,{now});assert.deepEqual(result.removed,[]);assert.equal(await readFile(join(outside,'private.txt'),'utf8'),'must survive');
 const alias=join(f.root,'root-link');await symlink(f.runsRoot,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(pruneHistory({runsRoot:alias},{now}),/ROOT_NOT_CANONICAL/);
});

test('expired configured history disappears from list, detail and logs while formal files remain',async t=>{
 const f=await fixture(t),old={finished:true,finishedAt:new Date(Date.now()-31*day).toISOString(),steps:[{id:'unit',status:'passed',exitCode:0}]},legacy=join(f.root,'formal-progress.json'),logs=join(f.root,'formal-logs');await mkdir(logs);await writeFile(legacy,JSON.stringify(old));await writeFile(join(logs,'unit.log'),'formal retained log');
 await run(f,'new',{finishedAt:new Date().toISOString()});await run(f,'still-running',{status:'running',finished:false,finishedAt:undefined});
 const server=await createViewer({...f,sources:[{id:'formal',progressFile:legacy,logsRoot:logs}]});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));const url='http://127.0.0.1:'+server.address().port;
 const data=await(await fetch(url+'/api/runs')).json();assert.deepEqual(data.runs.map(item=>item.id).sort(),['new','still-running']);for(const path of ['/api/runs/formal','/api/runs/formal/steps/unit/log'])assert.equal((await fetch(url+path)).status,404);
 assert.equal(await readFile(join(logs,'unit.log'),'utf8'),'formal retained log');assert.deepEqual(JSON.parse(await readFile(legacy,'utf8')),old);
});

test('manual service maintenance checks at startup, repeats, and keeps one latest receipt',async t=>{
 const f=await fixture(t),oldDate=new Date(Date.now()-31*day).toISOString();await run(f,'startup',{finishedAt:oldDate});
 const errors=[],maintenance=startHistoryMaintenance(f,{intervalMs:30,onError:error=>errors.push(error.message)});t.after(()=>maintenance.stop());
 const first=await maintenance.ready;assert.deepEqual(first.removed,['startup']);assert.equal(HISTORY_CHECK_INTERVAL,3600000);
 await run(f,'periodic',{finishedAt:oldDate});for(let i=0;i<100&&await exists(join(f.runsRoot,'periodic'));i++)await new Promise(ok=>setTimeout(ok,20));
 assert.equal(await exists(join(f.runsRoot,'periodic')),false);await maintenance.stop();const receipt=JSON.parse(await readFile(join(f.root,'retention-last.json'),'utf8'));assert.equal(receipt.retentionDays,30);assert.equal(receipt.status,'completed');assert.deepEqual(errors,[]);
});

test('an unexplained receipt is preserved and prevents automatic deletion',async t=>{
 const f=await fixture(t);await run(f,'old',{finishedAt:new Date(Date.now()-31*day).toISOString()});const path=join(f.root,'retention-last.json');await writeFile(path,'unexplained formal evidence');
 const errors=[],maintenance=startHistoryMaintenance(f,{intervalMs:10000,onError:error=>errors.push(error.message)});t.after(()=>maintenance.stop());const result=await maintenance.ready;assert.equal(result.status,'failed');await maintenance.stop();assert.equal(await exists(join(f.runsRoot,'old')),true);assert.equal(await readFile(path,'utf8'),'unexplained formal evidence');assert.match(errors[0],/RECEIPT_UNRECOGNIZED/);
});

test('successful managed work is reclaimed at the next check while history and logs remain',async t=>{
 const f=await fixture(t),task=await run(f,'success',{finishedAt:iso(1)}),work=join(task.directory,'work');await mkdir(join(work,'nested'),{recursive:true});await writeFile(join(work,'nested/generated.tmp'),'temporary output');const metadata=await readFile(join(task.directory,'run.json'),'utf8');
 const dry=await pruneHistory(f,{now,dryRun:true});assert.deepEqual(dry.wouldCleanWork,['success']);assert.equal(await exists(work),true);
 const result=await pruneHistory(f,{now});assert.deepEqual(result.cleanedWork,['success']);assert.deepEqual(result.removed,[]);assert.equal(await exists(work),false);assert.equal(await readFile(join(task.directory,'run.json'),'utf8'),metadata);assert.equal(await readFile(join(task.directory,'logs/unit.log'),'utf8'),'task-owned test log');
});

test('failed work waits for 30-day expiry and active, queued or unreliable completion never loses work',async t=>{
 const f=await fixture(t),patches={failed:{status:'failed',finishedAt:iso(1)},old:{status:'failed',finishedAt:iso(31)},active:{status:'running'},queued:{status:'queued'},unfinished:{finished:false},future:{finishedAt:iso(-1)},badtime:{startedAt:iso(-1),finishedAt:iso(1)}};
 for(const [id,patch] of Object.entries(patches)){await run(f,id,patch);await mkdir(join(f.runsRoot,id,'work'));await writeFile(join(f.runsRoot,id,'work/debug.tmp'),'task debug');}
 const result=await pruneHistory(f,{now});assert.deepEqual(result.removed,['old']);assert.deepEqual(result.cleanedWork,[]);for(const id of Object.keys(patches).filter(id=>id!=='old'))assert.equal(await exists(join(f.runsRoot,id,'work/debug.tmp')),true,id);
});

test('managed work refuses external links, unknown files, protected runs and arbitrary external paths',async t=>{
 const f=await fixture(t),outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'keep.txt'),'protected external file');
 for(const [id,patch] of [['retain',{retain:true}],['protected',{protected:true}],['reference-owner',{recoveryRefs:['referenced']}],['referenced',{}],['unknown',{}],['linked',{}],['external',{temporaryPaths:[outside]}]]){
  await run(f,id,{finishedAt:iso(1),...patch});if(id!=='external'&&id!=='linked'){await mkdir(join(f.runsRoot,id,'work'));await writeFile(join(f.runsRoot,id,'work/temp.txt'),'temporary');}
 }
 await writeFile(join(f.runsRoot,'unknown/formal-report.json'),'must keep');await symlink(outside,join(f.runsRoot,'linked/work'),process.platform==='win32'?'junction':'dir');
 const result=await pruneHistory(f,{now});assert.deepEqual(result.cleanedWork,[]);assert.deepEqual(result.removed,[]);for(const id of ['retain','protected','reference-owner','referenced','unknown'])assert.equal(await exists(join(f.runsRoot,id,'work/temp.txt')),true,id);assert.equal(await readFile(join(outside,'keep.txt'),'utf8'),'protected external file');assert.equal(await exists(join(f.runsRoot,'linked')),true);
});
