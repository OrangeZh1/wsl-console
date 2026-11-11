import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
async function launch(directory){
 const moduleUrl=pathToFileURL(join(directory,'start-wsl.mjs')).href;
 const script='const {startWslConsole}=await import('+JSON.stringify(moduleUrl)+'); console.log(JSON.stringify(await startWslConsole()));';
 return JSON.parse((await execFileAsync(process.execPath,['--input-type=module','-e',script],{windowsHide:true})).stdout);
}

test('manual launcher is platform-gated, idempotent and never stops a reused backend',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wsl-console-launcher-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const name of ['start-wsl.mjs','lan-relay.mjs'])await copyFile(new URL('../'+name,import.meta.url),join(directory,name));await writeFile(join(directory,'config.json'),'{}');
 const {startWslConsole,stopWslConsole}=await import(pathToFileURL(join(directory,'start-wsl.mjs')));
 if(process.platform!=='win32'){await assert.rejects(startWslConsole(),/WINDOWS_LAUNCHER_REQUIRED/);await assert.rejects(stopWslConsole(),/WINDOWS_LAUNCHER_REQUIRED/);return;}
 const instanceId=randomUUID(),backend=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/viewer'?{application:'wsl-console',pid:process.pid,instanceId}:{runs:[],readOnly:true}));});
 await new Promise(ok=>backend.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>backend.close(ok)));t.after(()=>stopWslConsole());const port=backend.address().port;
 await writeFile(join(directory,'config.json'),JSON.stringify({port}));
 const first=await launch(directory);assert.equal(first.localUrl,'http://127.0.0.1:'+port);assert.ok(first.lanUrls.length);assert.equal(first.firewallChanged,false);assert.equal(first.automaticStartup,false);
 const statePath=join(directory,'.local/lan-session.json'),before=JSON.parse(await readFile(statePath,'utf8'));assert.equal(before.backend.owned,false);
 await startWslConsole({port});const after=JSON.parse(await readFile(statePath,'utf8'));assert.deepEqual(after.relays.map(relay=>relay.pid),before.relays.map(relay=>relay.pid));
 for(const url of first.lanUrls){const response=await fetch(url+'/api/runs');assert.equal(response.status,200);assert.equal((await response.json()).readOnly,true);}
 const stopped=await stopWslConsole();assert.equal(stopped.stopped.length,before.relays.length);assert.ok(!stopped.stopped.includes(process.pid));assert.equal((await fetch(first.localUrl+'/api/runs')).status,200);
 await writeFile(statePath,'{"format":"other-session"}');await assert.rejects(startWslConsole({port}),/SESSION_UNRECOGNIZED/);assert.equal(await readFile(statePath,'utf8'),'{"format":"other-session"}');await rm(statePath);
});

test('hidden WSL core survives its launcher and stops only its own temporary instance',{skip:process.platform!=='win32'},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wsl-console-hidden-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const name of ['start-wsl.mjs','lan-relay.mjs','server.mjs','retention.mjs','failure.mjs','resources.mjs'])await copyFile(new URL('../'+name,import.meta.url),join(directory,name));
 const socket=http.createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));const port=socket.address().port;await new Promise(ok=>socket.close(ok));
 const match=directory.match(/^([a-z]):[\\/](.*)$/i),runsRoot='/mnt/'+match[1].toLowerCase()+'/'+match[2].replaceAll('\\','/')+'/runs';
 await mkdir(join(directory,'runs'));await writeFile(join(directory,'config.json'),JSON.stringify({port,runsRoot}));
 const {stopWslConsole}=await import(pathToFileURL(join(directory,'start-wsl.mjs')));t.after(()=>stopWslConsole());
 const started=await launch(directory),state=JSON.parse(await readFile(join(directory,'.local/lan-session.json'),'utf8'));
 assert.equal(state.backend.owned,true);assert.equal(started.automaticStartup,false);
 // launch() has exited: both Linux core and Windows relay must still serve requests.
 const backend=await (await fetch(started.localUrl+'/api/viewer')).json();assert.equal(backend.pid,state.backend.pid);assert.equal(backend.instanceId,state.backend.instanceId);
 for(const url of started.lanUrls)assert.equal((await fetch(url+'/api/runs')).status,200);
 const stopped=await stopWslConsole();assert.ok(stopped.stopped.includes(state.backend.pid));
 await assert.rejects(fetch(started.localUrl+'/api/viewer'));
});
