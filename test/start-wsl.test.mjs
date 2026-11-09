import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
import {randomUUID} from 'node:crypto';

test('manual launcher is platform-gated, idempotent and never stops a reused backend',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wsl-console-launcher-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const name of ['start-wsl.mjs','lan-relay.mjs'])await copyFile(new URL('../'+name,import.meta.url),join(directory,name));await writeFile(join(directory,'config.json'),'{}');
 const {startWslConsole,stopWslConsole}=await import(pathToFileURL(join(directory,'start-wsl.mjs')));
 if(process.platform!=='win32'){await assert.rejects(startWslConsole(),/WINDOWS_LAUNCHER_REQUIRED/);await assert.rejects(stopWslConsole(),/WINDOWS_LAUNCHER_REQUIRED/);return;}
 const instanceId=randomUUID(),backend=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/viewer'?{application:'wsl-console',pid:process.pid,instanceId}:{runs:[],readOnly:true}));});
 await new Promise(ok=>backend.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>backend.close(ok)));t.after(()=>stopWslConsole());const port=backend.address().port;
 const first=await startWslConsole({port});assert.equal(first.localUrl,'http://127.0.0.1:'+port);assert.ok(first.lanUrls.length);assert.equal(first.firewallChanged,false);assert.equal(first.automaticStartup,false);
 const statePath=join(directory,'.local/lan-session.json'),before=JSON.parse(await readFile(statePath,'utf8'));assert.equal(before.backend.owned,false);
 await startWslConsole({port});const after=JSON.parse(await readFile(statePath,'utf8'));assert.deepEqual(after.relays.map(relay=>relay.pid),before.relays.map(relay=>relay.pid));
 for(const url of first.lanUrls){const response=await fetch(url+'/api/runs');assert.equal(response.status,200);assert.equal((await response.json()).readOnly,true);}
 const stopped=await stopWslConsole();assert.equal(stopped.stopped.length,before.relays.length);assert.ok(!stopped.stopped.includes(process.pid));assert.equal((await fetch(first.localUrl+'/api/runs')).status,200);
 await writeFile(statePath,'{"format":"other-session"}');await assert.rejects(startWslConsole({port}),/SESSION_UNRECOGNIZED/);assert.equal(await readFile(statePath,'utf8'),'{"format":"other-session"}');await rm(statePath);
});
