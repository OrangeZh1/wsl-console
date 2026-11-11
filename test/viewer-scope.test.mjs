import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createViewer} from '../server.mjs';
import {isCloudOnlyRun} from '../model.mjs';

test('WSL scope distinguishes a physical run with CI provenance from a cloud-only run',()=>{
 const cloud={platform:'github-actions'},physical={platform:'linux',computerName:'fixture-device'};
 assert.equal(isCloudOnlyRun({executor:cloud,steps:[]}),true);
 assert.equal(isCloudOnlyRun({executor:physical,steps:[{command:['verify'],executor:cloud}]}),true);
 assert.equal(isCloudOnlyRun({executor:physical,sourceCi:{runId:'1'},steps:[]}),false);
 assert.equal(isCloudOnlyRun({executor:cloud,plannedDeviceId:'remote',steps:[]}),false);
 assert.equal(isCloudOnlyRun({executor:cloud,steps:[{command:['verify'],executor:physical}]}),false);
 assert.equal(isCloudOnlyRun({steps:[]}),false);
});

test('cloud-only records stay on disk and are absent from WSL list, devices and direct endpoints',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wsl-scope-')),runsRoot=join(directory,'runs');await mkdir(runsRoot);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const stamp=new Date().toISOString(),cloud={platform:'github-actions',name:'GitHub Actions'},physical={platform:'linux',computerName:'fixture-device'};
 const records=[{id:'cloud-queued',status:'queued',executor:cloud,finished:false,steps:[{id:'test',status:'queued'}]}, {id:'physical',status:'passed',finished:true,finishedAt:stamp,executor:physical,sourceCi:{url:'https://github.com/example/repository/actions/runs/1'},steps:[{id:'test',status:'passed',command:['verify'],exitCode:0}]}];
 for(const record of records){const root=join(runsRoot,record.id);await mkdir(join(root,'logs'),{recursive:true});await writeFile(join(root,'run.json'),JSON.stringify({format:'wsl-progress-v1',name:record.id,updatedAt:stamp,...record}));}
 const before=await readFile(join(runsRoot,'cloud-queued/run.json'),'utf8'),server=await createViewer({runsRoot});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));const url='http://127.0.0.1:'+server.address().port;
 const data=await(await fetch(url+'/api/runs')).json();assert.deepEqual(data.runs.map(run=>run.id),['physical']);assert.equal(data.runs[0].sourceCi.runId,'1');assert.doesNotMatch(JSON.stringify(await(await fetch(url+'/api/devices')).json()),/cloud-queued/);
 for(const suffix of ['', '/failure','/steps/test/log'])assert.equal((await fetch(url+'/api/runs/cloud-queued'+suffix)).status,404);
 assert.equal(await readFile(join(runsRoot,'cloud-queued/run.json'),'utf8'),before);
});
