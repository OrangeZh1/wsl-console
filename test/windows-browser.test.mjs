import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough,Duplex} from 'node:stream';
import path from 'node:path';
import vm from 'node:vm';

const linuxSource=await readFile(new URL('../scripts/windows-browser.mjs',import.meta.url),'utf8'),windowsBytes=await readFile(new URL('../scripts/windows-browser-server.cjs',import.meta.url)),tick=()=>new Promise(ok=>setImmediate(ok));
const wire=received=>new Duplex({read(){},write(bytes,_encoding,done){received.push(Buffer.from(bytes));done()}});

// Exercise the installed source unchanged: replace only its import bindings,
// then provide in-memory process/socket boundaries instead of starting an OS.
function linuxHarness({readyPatch={},sourceBytes=windowsBytes,connectError}={}){
 const calls={spawn:[],listen:[],connect:[],toWindows:[],fromWindows:[],browserClose:0,serverClose:0},child=new EventEmitter();let accept,socket;
 child.pid=100;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.on('data',bytes=>calls.toWindows.push(Buffer.from(bytes)));child.stdin.once('end',()=>queueMicrotask(()=>child.emit('close',0)));
 const ready={kind:'windows-browser-ready',endpoint:'ws://127.0.0.1:55555/random-path',playwrightVersion:'1.64.1',pid:200,browserPid:201,channel:'chromium',session:'D:/WSL/state/browser-sessions/pw-unit',...readyPatch};
 const browser={close:async()=>{calls.browserClose++},version:()=>'156.0.8078.4'};
 const net={createServer(handler){accept=handler;const server=new EventEmitter();server.listen=(port,host,done)=>{calls.listen.push({port,host});queueMicrotask(done)};server.address=()=>({port:44444});server.close=done=>{calls.serverClose++;done()};return server}};
 const playwright={chromium:{connect:async(endpoint,options)=>{calls.connect.push({endpoint,options});if(connectError)throw Error(connectError);socket=wire(calls.fromWindows);accept(socket);return browser}}};
 const sandbox={net,spawn:(...args)=>{calls.spawn.push(args);queueMicrotask(()=>child.stderr.write(JSON.stringify(ready)+'\n'));return child},randomUUID:()=>'unit',createHash,readFile:async()=>sourceBytes,process:{platform:'linux',env:{}},URL,Buffer,setTimeout,clearTimeout};
 vm.runInNewContext(linuxSource.split('\n').filter(line=>!line.startsWith('import ')).join('\n').replace('export async function connectWindowsBrowser','async function connectWindowsBrowser')+'\nglobalThis.entry=connectWindowsBrowser;',sandbox);
 return {entry:sandbox.entry,playwright,calls,child,get socket(){return socket}};
}

test('Windows browser rejects unsupported launch options and changed source before interop',async()=>{
 const h=linuxHarness();await assert.rejects(h.entry({playwright:h.playwright,launchOptions:{headless:false}}),/UNSUPPORTED_WINDOWS_BROWSER_OPTION/);assert.equal(h.calls.spawn.length,0);
 const changed=linuxHarness({sourceBytes:Buffer.from('changed')});await assert.rejects(changed.entry({playwright:changed.playwright}),/WINDOWS_BROWSER_SOURCE_CHANGED/);assert.equal(changed.calls.spawn.length,0);
});

test('Windows browser validates loopback and protocol version before opening a Linux listener',async()=>{
 for(const readyPatch of [{endpoint:'ws://192.0.2.10:55555/random-path'},{playwrightVersion:'1.65.0'}]){
  const h=linuxHarness({readyPatch});await assert.rejects(h.entry({playwright:h.playwright}),/WINDOWS_BROWSER_READY_INVALID/);assert.equal(h.calls.listen.length,0);assert.equal(h.child.stdin.writableEnded,true);
 }
 const mismatch=linuxHarness({connectError:'Playwright version mismatch'});await assert.rejects(mismatch.entry({playwright:mismatch.playwright}),/Playwright version mismatch/);assert.equal(mismatch.calls.serverClose,1);assert.equal(mismatch.child.stdin.writableEnded,true);
});

test('Windows browser binds Linux loopback, forwards binary bytes and closes its whole bridge',async()=>{
 const h=linuxHarness(),handle=await h.entry({playwright:h.playwright});assert.deepEqual(h.calls.listen,[{port:0,host:'127.0.0.1'}]);assert.equal(h.calls.spawn.length,1);assert.match(h.calls.spawn[0][0],/^\/mnt\/d\/WSL\/tools\/windows-browser-1\.64\.1\/.*node\.exe$/);assert.equal(h.calls.spawn[0][1][0],'--max-old-space-size=512');assert.equal(h.calls.connect[0].endpoint,'ws://127.0.0.1:44444/random-path');assert.equal(h.calls.connect[0].options.exposeNetwork,'<loopback>');
 const request=Buffer.from([0,255,13,10,128,1]),response=Buffer.from([137,80,78,71,0,255]);h.socket.push(request);h.child.stdout.write(response);await tick();assert.deepEqual(Buffer.concat(h.calls.toWindows),request);assert.deepEqual(Buffer.concat(h.calls.fromWindows),response);
 const closed=await handle.close();assert.equal(closed.exitCode,0);assert.equal(h.calls.browserClose,1);assert.equal(h.calls.serverClose,1);assert.equal(h.socket.destroyed,true);await handle.close();assert.equal(h.calls.browserClose,1);
});

function windowsHarness({version='1.64.1',endpoint='ws://127.0.0.1:55555/random-path'}={}){
 const calls={launch:[],toServer:[],fromServer:[],events:[],close:0,connect:0,writes:[]},process=new EventEmitter();Object.assign(process,{platform:'win32',version:'v24.18.0',argv:['node','server','D:/WSL/state/browser-sessions/pw-unit'],env:{},stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exit:code=>calls.exit=code});process.stdout.on('data',bytes=>calls.fromServer.push(Buffer.from(bytes)));process.stderr.on('data',bytes=>calls.events.push(JSON.parse(bytes.toString('utf8'))));
 const socket=wire(calls.toServer),server={wsEndpoint:()=>endpoint,process:()=>({pid:201}),close:async()=>{calls.close++},kill:async()=>{calls.kill=true}};
 const playwright={chromium:{launchServer:async options=>{calls.launch.push(options);return server}}},requireTool=name=>name==='playwright'?playwright:{version};
 const modules={'node:fs':{mkdirSync(){},writeFileSync(file,text){calls.writes.push({file,text})}},'node:path':path,'node:net':{connect:()=>{calls.connect++;queueMicrotask(()=>socket.emit('connect'));return socket}},'node:module':{createRequire:()=>requireTool}};
 const run=()=>vm.runInNewContext(windowsBytes.toString('utf8'),{require:name=>modules[name],__dirname:'/isolated/tools/src',process,URL,setTimeout,clearTimeout});return {run,process,socket,calls};
}

test('Windows server enforces the tested version and requests only an isolated loopback browser',async()=>{
 const wrong=windowsHarness({version:'1.65.0'});assert.throws(wrong.run,/WINDOWS_PLAYWRIGHT_1_64_1_REQUIRED/);assert.equal(wrong.calls.launch.length,0);
 const h=windowsHarness();h.run();await tick();assert.equal(h.calls.launch[0].host,'127.0.0.1');assert.equal(h.calls.launch[0].port,0);assert.equal(h.calls.launch[0].channel,'chromium');assert.equal(h.calls.launch[0].headless,true);assert.match(h.process.env.TEMP.replaceAll('\\','/'),/^D:\/WSL\/state\/browser-sessions\/pw-unit\/temp$/);assert.equal(h.calls.events[0].kind,'windows-browser-ready');
 const inbound=Buffer.from([0,255,13,10]),outbound=Buffer.from([128,0,1,255]);h.process.stdin.write(inbound);h.socket.push(outbound);await tick();assert.deepEqual(Buffer.concat(h.calls.toServer),inbound);assert.deepEqual(Buffer.concat(h.calls.fromServer),outbound);h.process.stdin.end();await tick();assert.equal(h.calls.close,1);assert.equal(h.socket.destroyed,true);assert.equal(h.calls.events.at(-1).kind,'windows-browser-closed');
});

test('Windows server refuses an unexpected non-loopback endpoint and closes its owned browser',async()=>{
 const h=windowsHarness({endpoint:'ws://0.0.0.0:55555/random-path'});h.run();await tick();assert.equal(h.calls.connect,0);assert.equal(h.calls.close,1);assert.ok(h.calls.events.some(event=>event.kind==='windows-browser-error'&&event.error.includes('LOOPBACK_SERVER_REQUIRED')));
});
