import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClockObserver} from '../clock-observation.mjs';
import {readDevices,observeRuns} from '../devices.mjs';
import {sampleDevice} from '../watch-devices.mjs';

const bootId='11111111-1111-1111-1111-111111111111',base=Date.parse('2026-11-12T20:00:00Z');
const date=offset=>new Date(base+offset).toISOString();
const observer=(sequence,monotonicMs)=>({sessionId:'collector-session',sequence,monotonicMs});

test('clock: a matching Linux boot bridges a Windows collector without borrowing its wall clock',()=>{
 const clock=createClockObserver(),reference={observer:observer(1,1000),resources:{clock:{domain:'linux',bootId,uptimeMs:100000},ageAtReceiptMs:800}};
 const result=clock.pulse('remote',{checkedAt:date(9000),observer:observer(1,2000)},{mono:5,ttl:45000,receiver:{bootId,uptimeMs:102500},reference});
 assert.equal(result.verified,true);assert.equal(result.ageMs,1500);assert.equal(result.method,'local-linux-monotonic-bridge');
 assert.equal(clock.pulse('wrong-boot',{observer:observer(1,2000)},{mono:5,ttl:45000,receiver:{bootId:'other',uptimeMs:102500},reference}).verified,false);
});

test('clock: first contact is unknown and stale unchanged pulses never revive after wall time changes',()=>{
 const clock=createClockObserver(),first={checkedAt:date(9000),observer:observer(1,1000)};
 assert.equal(clock.pulse('remote',first,{mono:0,ttl:45000}).verified,false);
 const next={checkedAt:date(-3600000),observer:observer(2,2000)};
 assert.equal(clock.pulse('remote',next,{mono:1000,ttl:45000}).verified,true);
 assert.equal(clock.pulse('remote',next,{mono:47000,ttl:45000}).ageMs,47000);
 assert.equal(clock.pulse('remote',next,{mono:48000,ttl:45000}).ageMs,48000);
 assert.equal(clock.pulse('remote',{...next,observer:observer(1,500)},{mono:49000,ttl:45000}).verified,false);
});

test('clock: component receipt ages survive failed probes and normalize independently of Windows UTC',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-clock-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config={devicesRoot:root,runsRoot:join(root,'runs'),devices:[{id:'local',computerName:'A'},{id:'remote',computerName:'B'}]},range={totalBytes:100,availableBytes:80};
 const local={format:'wsl-device-v1',id:'local',connection:'reachable',checkedAt:date(9000),host:{computerName:'A'},observer:observer(1,1000),resources:{clock:{domain:'linux',bootId,uptimeMs:100000}}};
 const remote={format:'wsl-device-v1',id:'remote',connection:'reachable',checkedAt:date(10000),host:{computerName:'B'},observer:observer(1,2000),windowsClockOffsetMs:9000,linuxClockOffsetMs:20,linuxClockUncertaintyMs:1000,resources:{state:'running',platform:'linux',status:'available',sampledAt:date(0),windows:{...range,sampledAt:date(9000)},memory:range,lockBusy:false,clock:{domain:'linux',bootId:'22222222-2222-2222-2222-222222222222',uptimeMs:100000,sampledAt:date(0)},receipt:{sessionId:'collector-session',monotonicMs:2000},ageAtReceiptMs:100,windowsAgeAtReceiptMs:200,lockAgeAtReceiptMs:300}};
 await writeFile(join(root,'local.json'),JSON.stringify(local));await writeFile(join(root,'remote.json'),JSON.stringify(remote));
 const clockObserver=createClockObserver(),read=(now,uptimeMs,mono)=>readDevices(config,{viewerHost:{computerName:'A'},receiverClock:{bootId,uptimeMs},now,monotonicNow:mono,clockObserver});
 let result=await read(base+1500,102500,1),device=result.devices[1];assert.equal(device.onlineState,'online');assert.equal(device.windowsClockOffsetMs,9000);assert.equal(device.linuxClockOffsetMs,20);assert.equal(device.resources.sampledAt,date(0));assert.equal(device.resources.normalizedTimes.sampledAt,date(-100));assert.equal(device.resources.normalizedTimes.windowsSampledAt,date(-200));
 const failed={...remote,connection:'unknown',observer:observer(2,42000),error:'PROBE_TIMEOUT'};await writeFile(join(root,'remote.json'),JSON.stringify(failed));
 result=await read(base-3600000,142500,40001);device=result.devices[1];assert.equal(device.onlineState,'unknown');assert.equal(device.resources.freshness.ageMs,41600);assert.ok(device.resources.memory);
 result=await read(base-3600000,150500,48001);device=result.devices[1];assert.equal(device.resources.memory,null);assert.equal(device.resources.windows,null);assert.equal(device.resources.lockBusy,null);
});

test('clock: Linux task heartbeats use observed changes rather than the Windows offset',()=>{
 const clockObserver=createClockObserver(),run={id:'task',status:'running',updatedAt:date(0),executor:{computerName:'B'},steps:[{id:'step',status:'running',command:['node'],heartbeatAt:date(0)}]};
 const read=(now,mono,current=run)=>observeRuns([current],[{id:'b',computerName:'B',onlineState:'online',clockOffsetMs:9000,windowsClockOffsetMs:9000,resources:{state:'running'},runs:[]}],{now,monotonicNow:mono,clockObserver,scope:'fixture'}).runs[0];
 assert.equal(read(base,0).workState,'unconfirmed');
 const next={...run,steps:[{...run.steps[0],heartbeatAt:date(1000)}]};assert.equal(read(base+1000,1000,next).workState,'executing');
 const stale=read(base-3600000,92000,next);assert.equal(stale.workState,'unconfirmed');assert.equal(stale.observation.lastHeartbeatAt,date(1000));
});

test('clock: collector exports separate Linux and Windows clock calibration and preserves resource receipt',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-clock-sample-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const device={id:'local',computerName:'A',transport:'local'},raw=()=>JSON.stringify({computerName:'A',observedAt:new Date(Date.now()+9000).toISOString(),resources:{state:'running',status:'available',platform:'linux',sampledAt:new Date().toISOString(),clock:{domain:'linux',bootId,uptimeMs:1000,sampledAt:new Date().toISOString()},sampledAgeMs:0,lockAgeMs:0,windows:{totalBytes:100,availableBytes:80,sampledAt:new Date(Date.now()+9000).toISOString(),sampledAgeMs:0}}});
 const first=await sampleDevice(device,root,async()=>raw());assert.ok(first.windowsClockOffsetMs>8500);assert.ok(Math.abs(first.linuxClockOffsetMs)<1000);assert.ok(first.observer.monotonicMs>=0);
 const second=await sampleDevice(device,root,async()=>{throw Error('no details')});assert.deepEqual(second.resources.receipt,first.resources.receipt);assert.equal(second.resources.sampledAt,first.resources.sampledAt);assert.equal(second.linuxClockOffsetMs,undefined);
});
