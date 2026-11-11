import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {privateIPv4} from './lan-relay.mjs';

const root=dirname(fileURLToPath(import.meta.url)),stateFile=join(root,'.local/lan-session.json');
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function get(url){try{const response=await fetch(url,{signal:AbortSignal.timeout(1500)});return response.ok?await response.json():null}catch{return null}}
function wslPath(path){const match=resolve(path).match(/^([a-z]):[\\/](.*)$/i);if(!match)throw Error('LOCAL_DRIVE_PATH_REQUIRED');return '/mnt/'+match[1].toLowerCase()+'/'+match[2].replaceAll('\\','/');}
function startHidden(file,args){
 const literal=value=>"'"+value.replaceAll("'","''")+"'";
 const argument=value=>/[\s"]/u.test(value)?'"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"':value;
 // Start-Process keeps the child alive after the launcher exits, without detached mode's new console.
 const script="$ErrorActionPreference='Stop'; (Start-Process -WindowStyle Hidden -FilePath "+literal(file)+' -ArgumentList '+literal(args.map(argument).join(' '))+' -PassThru).Id';
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
 if(result.status!==0)throw Error('HIDDEN_PROCESS_START_FAILED: '+(result.error?.code||result.stderr.trim()));
}
function physicalAddresses(){
 const command="@(Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.NetAdapter.HardwareInterface } | ForEach-Object { foreach($address in $_.IPv4Address) { [pscustomobject]@{address=$address.IPAddress;prefix=$address.PrefixLength;interface=$_.InterfaceAlias} } }) | ConvertTo-Json -Compress";
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true});
 if(result.status!==0)throw Error('LAN_INTERFACE_DISCOVERY_FAILED');
 const parsed=result.stdout.trim()?JSON.parse(result.stdout):[];return (Array.isArray(parsed)?parsed:[parsed]).filter(item=>privateIPv4(item.address)&&Number.isInteger(item.prefix)&&item.prefix>=8&&item.prefix<=32);
}
async function state(){try{
 const info=await lstat(stateFile);if(!info.isFile()||info.isSymbolicLink())throw Error('SESSION_NOT_REGULAR');
 const saved=JSON.parse(await readFile(stateFile,'utf8')),pid=value=>Number.isSafeInteger(value)&&value>0,uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value),port=value=>Number.isInteger(value)&&value>=1&&value<=65535;
 if(saved.format!=='wsl-console-session-v1'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(saved.localUrl)||!saved.backend||!Array.isArray(saved.relays)||saved.backend.owned&&(!pid(saved.backend.pid)||!uuid(saved.backend.instanceId))||saved.relays.some(relay=>!privateIPv4(relay.address)||!Number.isInteger(relay.prefix)||relay.prefix<8||relay.prefix>32||!port(relay.port)||!port(relay.upstreamPort)||!pid(relay.pid)||!uuid(relay.instanceId)))throw Error('SESSION_UNRECOGNIZED');return saved;
 }catch(error){if(error.code==='ENOENT')return null;throw error}}
async function save(record){await mkdir(dirname(stateFile),{recursive:true});await writeFile(stateFile+'.tmp',JSON.stringify(record,null,2)+'\n',{mode:0o600});await rename(stateFile+'.tmp',stateFile);}

export async function startWslConsole(options={}){
 if(process.platform!=='win32')throw Error('WINDOWS_LAUNCHER_REQUIRED');
 const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));
 const {distro=config.wsl?.distro||'Ubuntu-24.04',user=config.wsl?.user||'qicore-qa',node=config.wsl?.node||'/home/qicore-qa/.local/node/bin/node',port=config.port||4399}=options;
 if(!/^[\w.-]+$/.test(distro)||!/^[a-z_][a-z0-9_-]*$/.test(user)||!node.startsWith('/')||!Number.isInteger(port)||port<1||port>65535)throw Error('START_OPTIONS_INVALID');
 const previous=await state(),localUrl='http://127.0.0.1:'+port;
 let backend=await get(localUrl+'/api/viewer'),owned=false;
 if(!backend){
  // Older compatible viewers can be reused, but this launcher never claims ownership.
  const response=await fetch(localUrl,{signal:AbortSignal.timeout(1500)}).catch(()=>null);
  if(response){if(response.ok&&(await response.text()).includes('<title>WSL 验收进度</title>'))backend={application:'wsl-console',pid:null};else throw Error('LOCAL_PORT_IN_USE');}
 }
 if(backend&&backend.application!=='wsl-console')throw Error('LOCAL_PORT_IN_USE');
 if(!backend){
  const instanceId=randomUUID();
  startHidden('wsl.exe',['-d',distro,'-u',user,'--exec','env','WSL_CONSOLE_INSTANCE_ID='+instanceId,'WSL_CONSOLE_WINDOWS_HOST='+hostname(),node,wslPath(join(root,'server.mjs')),wslPath(join(root,'config.json'))]);
  for(let i=0;i<60&&!backend;i++){await wait(500);backend=await get(localUrl+'/api/viewer');}
  if(backend?.application!=='wsl-console')throw Error('LOCAL_VIEWER_START_FAILED');owned=backend.instanceId===instanceId;
 }else owned=!!(previous?.backend.owned&&previous.backend.pid===backend.pid&&previous.backend.instanceId===backend.instanceId);
 const addresses=physicalAddresses();
 const relays=(previous?.relays||[]).filter(item=>item.owned&&!addresses.some(address=>address.address===item.address)).map(item=>({...item,stale:true}));
 const record={format:'wsl-console-session-v1',checkedAt:new Date().toISOString(),localUrl,distro,user,node,backend:{pid:backend.pid,instanceId:backend.instanceId,owned},relays};await save(record);
 if(!addresses.length)return {localUrl,lanUrls:[],lanStatus:'NO_PRIVATE_LAN_INTERFACE',firewallChanged:false,automaticStartup:false};
 for(const entry of addresses){
  const url='http://'+entry.address+':'+port,existing=await get(url+'/__wsl_console_lan');
  if(existing){if(existing.application!=='wsl-console-lan'||existing.upstreamPort!==port||existing.address!==entry.address||existing.prefix!==entry.prefix)throw Error('LAN_PORT_IN_USE');relays.push({...entry,...existing,owned:previous?.relays.some(item=>item.instanceId===existing.instanceId&&item.owned)||false});await save(record);continue;}
  const instanceId=randomUUID(),options={address:entry.address,prefix:entry.prefix,port,upstreamPort:port,instanceId};
  startHidden(process.execPath,[join(root,'lan-relay.mjs'),JSON.stringify(options)]);
  let ready;for(let i=0;i<30&&!ready;i++){await wait(100);ready=await get(url+'/__wsl_console_lan');}
  if(ready?.instanceId!==instanceId)throw Error('LAN_RELAY_START_FAILED: '+url);
  relays.push({...entry,...ready,owned:true});await save(record);
 }
 await save(record);return {localUrl,lanUrls:relays.filter(item=>!item.stale).map(item=>'http://'+item.address+':'+port),firewallChanged:false,automaticStartup:false};
}

export async function stopWslConsole(){
 if(process.platform!=='win32')throw Error('WINDOWS_LAUNCHER_REQUIRED');
 const saved=await state();if(!saved)return {stopped:[]};const stopped=[],retained=[];
 for(const relay of saved.relays){
  if(!relay.owned)continue;const current=await get('http://'+relay.address+':'+relay.port+'/__wsl_console_lan');
  if(current?.instanceId===relay.instanceId&&current.pid===relay.pid){process.kill(relay.pid,'SIGTERM');stopped.push(relay.pid);}else retained.push(relay);
 }
 if(retained.length){await save({...saved,relays:retained});return {stopped,lanRetained:'OWNED_RELAY_IDENTITY_UNAVAILABLE'};}
 saved.relays=saved.relays.filter(relay=>!stopped.includes(relay.pid));await save(saved);
 if(saved.backend.owned){
  const current=await get(saved.localUrl+'/api/viewer'),runs=await get(saved.localUrl+'/api/runs');
  if(current?.application==='wsl-console'&&current.pid===saved.backend.pid&&current.instanceId===saved.backend.instanceId){
   if(!runs||runs.runs.some(run=>['running','queued'].includes(run.status)))return {stopped,backendRetained:'ACTIVE_OR_UNREADABLE_RUNS'};
   const result=spawnSync('wsl.exe',['-d',saved.distro,'-u',saved.user,'--exec',saved.node,'--input-type=module','-e',"process.kill(Number(process.argv[1]),'SIGTERM')",String(saved.backend.pid)],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('OWNED_BACKEND_STOP_FAILED');stopped.push(saved.backend.pid);
  }
 }
 await rm(stateFile);return {stopped};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.some(arg=>!['--stop','--no-browser'].includes(arg)))throw Error('Use: node start-wsl.mjs [--no-browser|--stop]');
 console.log(JSON.stringify(args.includes('--stop')?await stopWslConsole():await startWslConsole(),null,2));
 // Browser opening is intentionally delegated to the user/Codex UI API; no shell UI control.
}
