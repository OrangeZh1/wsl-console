'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(root,'browsers');const requireTool=createRequire(path.join(root,'playwright','package.json')),{chromium}=requireTool('playwright');
if(process.platform!=='win32'||requireTool('playwright/package.json').version!=='1.64.1')throw Error('WINDOWS_PLAYWRIGHT_1_64_1_REQUIRED');
const session=process.argv[2];if(!/^D:[\\/]WSL[\\/]state[\\/]browser-sessions[\\/][a-z0-9-]{1,80}$/i.test(session||''))throw Error('ISOLATED_SESSION_PATH_REQUIRED');
fs.mkdirSync(session,{recursive:true});const temp=path.join(session,'temp');fs.mkdirSync(temp,{recursive:true});process.env.TEMP=temp;process.env.TMP=temp;
let server,socket,closing=false;
const emit=value=>process.stderr.write(JSON.stringify(value)+'\n');
async function close(reason){if(closing)return;closing=true;const timer=setTimeout(()=>{server?.kill().finally(()=>process.exit(1))},10000);timer.unref();try{socket?.destroy();if(server)await server.close();emit({kind:'windows-browser-closed',reason,pid:process.pid,browserPid:server?.process().pid});process.stdin.destroy();process.stdout.end()}catch(error){emit({kind:'windows-browser-close-error',error:String(error)});process.exitCode=1}finally{clearTimeout(timer)}}
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.once(signal,()=>close(signal));
process.stdin.once('end',()=>close('stdin-eof'));process.stdout.once('error',()=>close('stdout-error'));
(async()=>{
 server=await chromium.launchServer({channel:'chromium',host:'127.0.0.1',port:0,headless:true,timeout:30000,env:{...process.env,TEMP:temp,TMP:temp}});
 if(closing){await server.close();return;}
 const endpoint=new URL(server.wsEndpoint());if(endpoint.hostname!=='127.0.0.1')throw Error('LOOPBACK_SERVER_REQUIRED');
 const receipt={format:'windows-playwright-browser-server-v1',nodeVersion:process.version,playwrightVersion:'1.64.1',channel:'chromium',pid:process.pid,browserPid:server.process().pid,endpoint:server.wsEndpoint(),session,temp,loopbackOnly:true};fs.writeFileSync(path.join(session,'server.json'),JSON.stringify(receipt,null,2)+'\n');
 socket=net.connect({host:'127.0.0.1',port:Number(endpoint.port)});socket.once('connect',()=>{emit({kind:'windows-browser-ready',...receipt});process.stdin.pipe(socket);socket.pipe(process.stdout)});socket.once('error',error=>{emit({kind:'windows-browser-error',error:String(error)});close('socket-error')});socket.once('close',()=>close('client-disconnected'));
})().catch(error=>{emit({kind:'windows-browser-error',error:String(error.stack||error)});process.exitCode=1;close('launch-error')});
