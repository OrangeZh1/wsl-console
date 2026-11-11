import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {windowsProbeScript} from './probe-windows.mjs';
import {normalizeDeviceResources} from './devices.mjs';

const validId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);

export function classifyProbeFailure({ssh=false,stderr='',exitCode,timedOut=false,spawnFailed=false,outputLimit=false}={}){
 if(spawnFailed)return {connection:'unknown',diagnostic:{kind:'configuration',code:'PROBE_START_FAILED'}};
 if(outputLimit)return {connection:'unknown',diagnostic:{kind:'protocol',code:'PROBE_OUTPUT_LIMIT'}};
 if(ssh&&exitCode===255&&/ssh:\s*connect to host [^\r\n]+ port \d+:\s*(?:Connection refused|Connection timed out|Operation timed out|No route to host|Network is unreachable)\b/i.test(stderr))return {connection:'unreachable',diagnostic:{kind:'connection',code:'PROBE_CONNECTION_UNREACHABLE'}};
 if(ssh&&/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No \S+ host key is known/i.test(stderr))return {connection:'unknown',diagnostic:{kind:'host-key',code:'PROBE_HOST_KEY_FAILED'}};
 if(ssh&&/Permission denied|Authentication failed|Too many authentication failures/i.test(stderr))return {connection:'unknown',diagnostic:{kind:'authentication',code:'PROBE_AUTHENTICATION_FAILED'}};
 if(timedOut)return {connection:'unknown',diagnostic:{kind:'timeout',code:'PROBE_TIMEOUT'}};
 return {connection:'unknown',diagnostic:{kind:'protocol',code:exitCode===255?'PROBE_SSH_PROTOCOL_FAILED':'PROBE_REMOTE_FAILED'}};
}
function failure(detail){const error=Error(detail.diagnostic.code);Object.assign(error,detail);return error;}

export function probeArguments(device){
 const script=windowsProbeScript(device.wsl),options=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand'];
 if(device.transport==='local')return {file:'powershell.exe',args:[...options,Buffer.from(script,'utf16le').toString('base64')]};
 const ssh=device.ssh;
 if(device.transport!=='ssh'||!ssh||typeof ssh.host!=='string'||ssh.host.length>255||!/^[a-z0-9][a-z0-9.-]*$/i.test(ssh.host)||typeof ssh.user!=='string'||ssh.user.length>64||!/^[a-z0-9_][a-z0-9_.-]*$/i.test(ssh.user)||!ssh.identityFile||!ssh.knownHostsFile)throw Error('DEVICE_SSH_CONFIGURATION_INVALID');
 if(ssh.port!==undefined&&(!Number.isInteger(ssh.port)||ssh.port<1||ssh.port>65535))throw Error('DEVICE_SSH_PORT_INVALID');
 // Keep the Windows SSH command line below its 8191-character limit. The static
 // read-only probe travels on stdin, never as a saved remote script or secret.
 const bootstrap="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))";
 return {file:process.env.SystemRoot?join(process.env.SystemRoot,'System32/OpenSSH/ssh.exe'):'ssh',args:['-F','NUL','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+resolve(ssh.knownHostsFile),'-o','GlobalKnownHostsFile=NUL','-o','ConnectTimeout=5','-o','ConnectionAttempts=1','-i',resolve(ssh.identityFile),'-p',String(ssh.port||22),'-l',ssh.user,ssh.host,'powershell.exe',...options,Buffer.from(bootstrap,'utf16le').toString('base64')],input:script};
}

async function command(file,args,input){
 return new Promise((ok,reject)=>{
  const child=spawn(file,args,{windowsHide:true,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']}),output=[],ssh=/^ssh(?:\.exe)?$/i.test(basename(file));let size=0,done=false,stderr='';
  if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
  const timer=setTimeout(()=>{child.kill();finish(failure(classifyProbeFailure({ssh,stderr,timedOut:true})))},18000);
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(error):ok(value)}
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32768){child.kill();finish(failure(classifyProbeFailure({ssh,stderr,outputLimit:true})))}else output.push(chunk)});
  // Only return a bounded result; never reflect arbitrary SSH stderr or local configuration.
  child.stderr.on('data',chunk=>{if(stderr.length<8192)stderr=(stderr+chunk.toString('utf8')).slice(0,8192)});child.on('error',()=>finish(failure(classifyProbeFailure({ssh,spawnFailed:true}))));child.on('close',code=>code===0?finish(null,Buffer.concat(output).toString('utf8')):finish(failure(classifyProbeFailure({ssh,stderr,exitCode:code}))));
 });
}

export async function sampleDevice(device,root,probe=command){
 if(!validId(device?.id)||typeof device.computerName!=='string'||!device.computerName.trim())throw Error('DEVICE_DEFINITION_INVALID');
 const file=join(resolve(root),device.id+'.json');let previous;
 try{previous=JSON.parse(await readFile(file,'utf8'))}catch{}
 let heartbeat;
 try{
  const {file:program,args,input}=probeArguments(device);let observed;try{observed=JSON.parse((await probe(program,args,input)).trim())}catch(error){if(error.connection)throw error;throw failure({connection:'unknown',diagnostic:{kind:'protocol',code:'PROBE_PROTOCOL_INVALID'}})}
  if(typeof observed?.computerName!=='string'||observed.computerName.toLowerCase()!==device.computerName.toLowerCase())throw failure({connection:'unknown',diagnostic:{kind:'identity',code:'DEVICE_IDENTITY_MISMATCH'}});
  const checkedAt=new Date().toISOString(),resources=normalizeDeviceResources(observed.resources),sourceTime=Date.parse(observed.observedAt),clockOffsetMs=Number.isFinite(sourceTime)?sourceTime-Date.parse(checkedAt):0;
  const rawDiagnostic=observed.resources?.diagnostic,diagnostic=['WSL_PROBE_TIMEOUT','WSL_PROBE_FAILED'].includes(rawDiagnostic?.code)?{kind:'linux-state',code:rawDiagnostic.code}:undefined;
  heartbeat={format:'wsl-device-v1',id:device.id,connection:'reachable',checkedAt,lastSeenAt:checkedAt,clockOffsetMs,host:{id:device.id,name:device.name||observed.computerName,computerName:observed.computerName,platform:'win32',source:'sampled',observedAt:checkedAt},resources,...(diagnostic?{diagnostic}:{})};
 }catch(error){const checkedAt=new Date().toISOString(),diagnostic=error.diagnostic||{kind:'configuration',code:'DEVICE_PROBE_CONFIGURATION_INVALID'};heartbeat={format:'wsl-device-v1',id:device.id,connection:error.connection==='unreachable'?'unreachable':'unknown',checkedAt,...(previous?.lastSeenAt?{lastSeenAt:previous.lastSeenAt}:{}),...(Number.isFinite(previous?.clockOffsetMs)?{clockOffsetMs:previous.clockOffsetMs}:{}),resources:normalizeDeviceResources(previous?.resources),error:diagnostic.code,diagnostic};}
 const temporary=file+'.'+randomUUID()+'.tmp';await mkdir(resolve(root),{recursive:true});await writeFile(temporary,JSON.stringify(heartbeat,null,2)+'\n',{mode:0o600});await rename(temporary,file);return heartbeat;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.platform!=='win32')throw Error('WINDOWS_DEVICE_PROBER_REQUIRED');
 const args=process.argv.slice(2),once=args.includes('--once'),configPath=args.find(arg=>!arg.startsWith('--'));
 if(!configPath||args.some(arg=>arg.startsWith('--')&&arg!=='--once'))throw Error('Use: node watch-devices.mjs private-config.json [--once]');
 const config=JSON.parse(await readFile(resolve(configPath),'utf8'));
 if(!Array.isArray(config.devices)||!config.devices.length||config.devices.length>64||!config.devicesRoot)throw Error('DEVICE_WATCH_CONFIG_INVALID');
 const seen=new Set();for(const device of config.devices){if(!validId(device?.id)||seen.has(device.id))throw Error('DUPLICATE_OR_INVALID_DEVICE_ID');seen.add(device.id);probeArguments(device);}
 let stopped=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true});
 const interval=Math.max(5000,Math.min(Number(config.intervalMs)||15000,60000));
 do{const samples=await Promise.all(config.devices.map(device=>sampleDevice(device,config.devicesRoot)));console.log(JSON.stringify({checkedAt:new Date().toISOString(),devices:samples.map(({id,connection,checkedAt,lastSeenAt,error})=>({id,connection,checkedAt,lastSeenAt,error}))}));if(once||stopped)break;await new Promise(ok=>setTimeout(ok,interval));}while(!stopped);
}
