import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sameDevice,deviceRunState,readDevices,normalizeDeviceResources} from '../devices.mjs';
import {probeArguments,sampleDevice} from '../watch-devices.mjs';

test('device identities reject generic hostnames and contradictory physical computer names',()=>{
 assert.equal(sameDevice({hostname:'localhost'},{hostname:'localhost'}),false);
 assert.equal(sameDevice({computerName:'A',hostname:'same'},{computerName:'B',hostname:'same'}),false);
 assert.equal(sameDevice({computerName:'A'},{computerName:'a'}),true);
 assert.equal(sameDevice({id:'a'},{id:'A'}),true);
 assert.equal(sameDevice({name:'A'},{name:'A'}),false);
});

test('device work separates waiting, actual commands, stale records and history',()=>{
 const now=Date.parse('2026-11-12T01:00:00Z'),base={status:'running',updatedAt:new Date(now).toISOString(),steps:[{status:'running',command:['python3','task.py']}]};
 assert.equal(deviceRunState(base,now),'executing');
 assert.equal(deviceRunState({...base,steps:[],queueReason:'等待内存'},now),'waiting');
 assert.equal(deviceRunState({...base,steps:[]},now),'workflow');
 assert.equal(deviceRunState({...base,updatedAt:'2026-11-11T01:00:00Z'},now),'unconfirmed');
 assert.equal(deviceRunState({...base,status:'passed'},now),'history');
 assert.equal(deviceRunState({...base,heartbeatAt:new Date(now+10000).toISOString()},now,90000,10000),'executing');
});

test('per-device resources whitelist data and compute used memory without exposing payload extras',()=>{
 const result=normalizeDeviceResources({state:'running',status:'available',platform:'linux',memory:{totalBytes:100,availableBytes:75,usedBytes:99},swap:{totalBytes:40,availableBytes:40},windows:{totalBytes:200,availableBytes:80},cpu:{logicalProcessors:4,load1:.1},lockBusy:false,secret:'hidden'});
 assert.equal(result.memory.usedBytes,25);assert.equal(result.windows.availableBytes,80);assert.equal(result.swap.usedBytes,0);assert.doesNotMatch(JSON.stringify(result),/secret|hidden/);
 assert.equal(normalizeDeviceResources({state:'unknown',memory:{totalBytes:1,availableBytes:2}}).memory,null);
});

test('fresh online probes and failed/stale probes keep assignment distinct from activity',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-devices-data-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const now=Date.now(),date=offset=>new Date(now+offset).toISOString(),devices=[{id:'a',name:'本机',computerName:'A',transport:'local'},{id:'b',name:'远程',computerName:'B',transport:'ssh'}],runs=[{id:'work',name:'远程任务',executor:{computerName:'B'},status:'running',updatedAt:date(0),steps:[{status:'running',command:['python3']}]},{id:'old',name:'旧任务',status:'running',updatedAt:date(0),steps:[]}];
 await writeFile(join(root,'b.json'),JSON.stringify({format:'wsl-device-v1',id:'b',connection:'reachable',checkedAt:date(0),lastSeenAt:date(0),host:{computerName:'B',token:'secret'}}));
 const config={runsRoot:join(root,'runs'),devicesRoot:root,devices};let result=await readDevices(config,{runs,viewerHost:{computerName:'A'},now});
 assert.equal(result.devices.length,2);assert.equal(result.devices[0].onlineState,'online');assert.equal(result.devices[1].onlineState,'online');assert.equal(result.devices[1].workload,'executing');assert.deepEqual(result.unassignedRuns,['old']);assert.doesNotMatch(JSON.stringify(result),/secret|token/);
 result=await readDevices(config,{runs,now:now+60000});assert.equal(result.devices[1].onlineState,'stale');assert.equal(result.devices[1].runs[0].workState,'unconfirmed');
 await writeFile(join(root,'b.json'),JSON.stringify({format:'wsl-device-v1',id:'b',connection:'unreachable',checkedAt:date(0),lastSeenAt:date(-10000),password:'secret'}));
 result=await readDevices(config,{runs,now});assert.equal(result.devices[1].onlineState,'unreachable');assert.equal(result.devices[1].workload,'unconfirmed');assert.equal(result.devices[1].lastSeenAt,date(-10000));
});

test('SSH prober uses pinned keys, ignores secrets and preserves last successful observation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-devices-probe-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const device={id:'remote',name:'远程',computerName:'B',transport:'ssh',ssh:{host:'192.0.2.10',user:'qa',identityFile:join(root,'key'),knownHostsFile:join(root,'known_hosts')}};
 const {args}=probeArguments(device);for(const value of ['StrictHostKeyChecking=yes','BatchMode=yes','IdentitiesOnly=yes','ConnectionAttempts=1'])assert.ok(args.includes(value));
 const first=await sampleDevice(device,root,async()=>JSON.stringify({computerName:'B',token:'never-export'}));assert.equal(first.connection,'reachable');
 const second=await sampleDevice(device,root,async()=>{throw Error('private credential details')});assert.equal(second.connection,'unknown');assert.equal(second.lastSeenAt,first.lastSeenAt);assert.doesNotMatch(await readFile(join(root,'remote.json'),'utf8'),/private|credential|token|never-export/);
 const wrong=await sampleDevice(device,root,async()=>JSON.stringify({computerName:'C'}));assert.equal(wrong.error,'DEVICE_IDENTITY_MISMATCH');assert.equal(wrong.connection,'unknown');
});
