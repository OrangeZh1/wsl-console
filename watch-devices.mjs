import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {windowsProbeScript} from './probe-windows.mjs';
import {normalizeDeviceResources} from './devices.mjs';

const validId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);

export function probeArguments(device){
 const command=['powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsProbeScript(device.wsl),'utf16le').toString('base64')];
 if(device.transport==='local')return {file:'powershell.exe',args:command.slice(1)};
 const ssh=device.ssh;
 if(device.transport!=='ssh'||!ssh||typeof ssh.host!=='string'||!/^[-a-z0-9.]+$/i.test(ssh.host)||!/^[-a-z0-9_.]+$/i.test(ssh.user||'')||!ssh.identityFile||!ssh.knownHostsFile)throw Error('DEVICE_SSH_CONFIGURATION_INVALID');
 if(ssh.port!==undefined&&(!Number.isInteger(ssh.port)||ssh.port<1||ssh.port>65535))throw Error('DEVICE_SSH_PORT_INVALID');
 return {file:process.env.SystemRoot?join(process.env.SystemRoot,'System32/OpenSSH/ssh.exe'):'ssh',args:['-F','NUL','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+resolve(ssh.knownHostsFile),'-o','GlobalKnownHostsFile=NUL','-o','ConnectTimeout=5','-o','ConnectionAttempts=1','-i',resolve(ssh.identityFile),'-p',String(ssh.port||22),'-l',ssh.user,ssh.host,...command]};
}

async function command(file,args){
 return new Promise((ok,reject)=>{
  const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']}),output=[];let size=0,done=false;
  const timer=setTimeout(()=>{child.kill();finish(Error('PROBE_TIMEOUT'))},18000);
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(error):ok(value)}
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32768){child.kill();finish(Error('PROBE_OUTPUT_LIMIT'))}else output.push(chunk)});
  // Only return a bounded result; never reflect arbitrary SSH stderr or local configuration.
  child.stderr.resume();child.on('error',()=>finish(Error('PROBE_START_FAILED')));child.on('close',code=>code===0?finish(null,Buffer.concat(output).toString('utf8')):finish(Error('PROBE_CONNECTION_FAILED')));
 });
}

export async function sampleDevice(device,root,probe=command){
 if(!validId(device?.id)||typeof device.computerName!=='string'||!device.computerName.trim())throw Error('DEVICE_DEFINITION_INVALID');
 const file=join(resolve(root),device.id+'.json');let previous;
 try{previous=JSON.parse(await readFile(file,'utf8'))}catch{}
 let heartbeat;
 try{
  const {file:program,args}=probeArguments(device),observed=JSON.parse((await probe(program,args)).trim());
  if(typeof observed.computerName!=='string'||observed.computerName.toLowerCase()!==device.computerName.toLowerCase())throw Error('DEVICE_IDENTITY_MISMATCH');
  const checkedAt=new Date().toISOString(),resources=normalizeDeviceResources(observed.resources),sourceTime=Date.parse(resources?.sampledAt),clockOffsetMs=Number.isFinite(sourceTime)?sourceTime-Date.parse(checkedAt):0;
  heartbeat={format:'wsl-device-v1',id:device.id,connection:'reachable',checkedAt,lastSeenAt:checkedAt,clockOffsetMs,host:{id:device.id,name:device.name||observed.computerName,computerName:observed.computerName,platform:'win32',source:'sampled',observedAt:checkedAt},resources:resources?{...resources,sampledAt:checkedAt}:null};
 }catch(error){const checkedAt=new Date().toISOString();heartbeat={format:'wsl-device-v1',id:device.id,connection:'unreachable',checkedAt,...(previous?.lastSeenAt?{lastSeenAt:previous.lastSeenAt}:{}),resources:normalizeDeviceResources(previous?.resources),error:['DEVICE_IDENTITY_MISMATCH','PROBE_TIMEOUT','PROBE_OUTPUT_LIMIT','PROBE_START_FAILED'].includes(error.message)?error.message:'PROBE_CONNECTION_FAILED'};}
 await mkdir(resolve(root),{recursive:true});await writeFile(file+'.tmp',JSON.stringify(heartbeat,null,2)+'\n',{mode:0o600});await rename(file+'.tmp',file);return heartbeat;
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
