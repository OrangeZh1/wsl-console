import {test} from 'node:test';
import assert from 'node:assert/strict';
import {platform} from 'node:os';
import {memoryFromProc,readResources} from '../resources.mjs';

test('Linux memory pressure uses MemAvailable and validates missing or inconsistent readings',()=>{
 const value=memoryFromProc('MemTotal:       6000000 kB\nMemFree:         100000 kB\nMemAvailable:   4500000 kB\nSwapTotal:      4000000 kB\nSwapFree:       3500000 kB\n');
 assert.equal(value.memory.usedBytes,1500000*1024);assert.equal(value.memory.availableBytes,4500000*1024);assert.equal(value.swap.usedBytes,500000*1024);
 assert.equal(memoryFromProc('MemTotal: 1 kB\nMemAvailable: 2 kB\n').memory,null);assert.equal(memoryFromProc('MemTotal: 6000000 kB\nMemFree: 100000 kB\n').memory,null);assert.equal(memoryFromProc('').swap,null);
 assert.deepEqual(memoryFromProc('SwapTotal: 0 kB\nSwapFree: 0 kB\n').swap,{totalBytes:0,availableBytes:0,usedBytes:0});
});

test('resource sampler returns only aggregate status and a real sample time',async()=>{
 const data=await readResources();assert.ok(Number.isFinite(Date.parse(data.sampledAt)));assert.equal(data.platform,platform());assert.deepEqual(Object.keys(data).sort(),['cpu','memory','platform','sampledAt','status','swap']);
 if(platform()==='linux'){assert.equal(data.status,'available');assert.ok(data.memory.totalBytes>0);assert.ok(data.memory.availableBytes<=data.memory.totalBytes);assert.ok(data.cpu.logicalProcessors>0);assert.ok(data.cpu.load1>=0)}else assert.equal(data.status,'unavailable');
 assert.doesNotMatch(JSON.stringify(data),/command|password|secret|token|pid|hostname/i);
});
