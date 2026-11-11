import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyProbeFailure,probeArguments,sampleDevice} from '../watch-devices.mjs';
import {windowsProbeScript} from '../probe-windows.mjs';

test('only explicit SSH dial failures establish unreachable; authentication and protocol failures remain unknown',()=>{
 for(const reason of ['Connection refused','Connection timed out','No route to host','Network is unreachable'])assert.equal(classifyProbeFailure({ssh:true,exitCode:255,stderr:'ssh: connect to host example.test port 22: '+reason}).connection,'unreachable');
 for(const failure of [{ssh:true,exitCode:255,stderr:'Permission denied (publickey)'},{ssh:true,exitCode:255,stderr:'Host key verification failed.'},{ssh:true,exitCode:1,stderr:'PowerShell error'},{ssh:true,timedOut:true},{spawnFailed:true},{outputLimit:true},{ssh:true,exitCode:1,stderr:'ssh: connect to host example.test port 22: Connection refused'}])assert.equal(classifyProbeFailure(failure).connection,'unknown');
});

test('remote probe uses a bounded pinned bootstrap and sends static read-only source on stdin',()=>{
 const device={transport:'ssh',ssh:{host:'192.0.2.10',user:'qa',identityFile:'identity',knownHostsFile:'known-hosts'}},call=probeArguments(device);
 assert.ok(call.args.join(' ').length<2000);assert.match(call.input,/Get-CimInstance/);assert.match(Buffer.from(call.args.at(-1),'base64').toString('utf16le'),/In\.ReadToEnd/);
 for(const value of ['StrictHostKeyChecking=yes','BatchMode=yes','IdentitiesOnly=yes'])assert.ok(call.args.includes(value));
 for(const ssh of [{...device.ssh,host:'-V'},{...device.ssh,host:'a'.repeat(256)},{...device.ssh,user:'-user'}])assert.throws(()=>probeArguments({...device,ssh}),/CONFIGURATION_INVALID/);
 const script=windowsProbeScript();assert.match(script,/WSL_PROBE_TIMEOUT/);assert.match(script,/windowsStamp/);assert.match(script,/observedAt=/);
});

test('successful SSH with malformed identity is unknown and a Windows-only response remains reachable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-probe-classify-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const device={id:'remote',computerName:'EXPECTED',transport:'ssh',ssh:{host:'192.0.2.10',user:'qa',identityFile:'identity',knownHostsFile:'known-hosts'}};
 const first=await sampleDevice(device,root,async()=>JSON.stringify({computerName:'EXPECTED',observedAt:new Date().toISOString(),resources:{state:'unknown',status:'unavailable',diagnostic:{code:'WSL_PROBE_TIMEOUT'}}}));assert.equal(first.connection,'reachable');assert.equal(first.diagnostic.code,'WSL_PROBE_TIMEOUT');
 const wrong=await sampleDevice(device,root,async()=>JSON.stringify({computerName:'OTHER'}));assert.equal(wrong.connection,'unknown');assert.equal(wrong.error,'DEVICE_IDENTITY_MISMATCH');assert.equal(wrong.lastSeenAt,first.lastSeenAt);
 const bad=await sampleDevice(device,root,async()=>'{not-json');assert.equal(bad.connection,'unknown');assert.equal(bad.diagnostic.kind,'protocol');assert.doesNotMatch(await readFile(join(root,'remote.json'),'utf8'),/not-json/);
});

test('overlapping read-only probe completions do not share a temporary heartbeat filename',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-probe-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));const device={id:'local',computerName:'LOCAL',transport:'local'},probe=async()=>JSON.stringify({computerName:'LOCAL',observedAt:new Date().toISOString()});
 const results=await Promise.all([sampleDevice(device,root,probe),sampleDevice(device,root,probe)]);assert.equal(results.length,2);assert.equal(JSON.parse(await readFile(join(root,'local.json'),'utf8')).connection,'reachable');
});
