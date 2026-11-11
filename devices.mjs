import {readFile,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {normalizeHost} from './host.mjs';

const id=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const generic=name=>/^(?:localhost(?:\.localdomain)?|ubuntu|wsl)$/i.test(name||'');

export function normalizeDeviceResources(value){
 if(!value||typeof value!=='object')return null;
 const range=input=>{const total=input?.totalBytes,available=input?.availableBytes;return Number.isSafeInteger(total)&&Number.isSafeInteger(available)&&total>=0&&available>=0&&available<=total?{totalBytes:total,availableBytes:available,usedBytes:total-available}:null};
 const result={state:['running','stopped'].includes(value.state)?value.state:'unknown',status:['available','partial','unavailable'].includes(value.status)?value.status:'unavailable',platform:value.platform==='linux'?'linux':'unknown',memory:range(value.memory),swap:range(value.swap),cpu:Number.isInteger(value.cpu?.logicalProcessors)&&value.cpu.logicalProcessors>0&&Number.isFinite(value.cpu.load1)&&value.cpu.load1>=0?{logicalProcessors:value.cpu.logicalProcessors,load1:value.cpu.load1}:null,windows:range(value.windows),lockBusy:typeof value.lockBusy==='boolean'?value.lockBusy:null};
 if(Number.isFinite(stamp(value.sampledAt)))result.sampledAt=new Date(stamp(value.sampledAt)).toISOString();
 return result;
}

// A display name is not an identity; a common default Linux hostname proves nothing.
export function sameDevice(a,b){
 if(!a||!b)return false;
 if(a.computerName&&b.computerName)return equal(a.computerName,b.computerName);
 if(a.id&&b.id&&equal(a.id,b.id))return true;
 return Boolean(a.hostname&&b.hostname&&!generic(a.hostname)&&equal(a.hostname,b.hostname));
}

export function deviceRunState(run,now=Date.now(),maxAge=90000,clockOffsetMs=0){
 if(!['running','queued'].includes(run.status))return 'history';
 const seen=stamp(run.heartbeatAt||run.updatedAt)-clockOffsetMs;
 if(!Number.isFinite(seen)||seen>now+5000||now-seen>maxAge)return 'unconfirmed';
 if(run.status==='queued')return 'waiting';
 if(run.steps?.some(step=>step.status==='running'&&step.command?.length))return 'executing';
 if(typeof run.queueReason==='string'&&run.queueReason.trim())return 'waiting';
 const queued=run.steps?.filter(step=>step.status==='queued')||[];
 if(run.steps?.some(step=>step.status==='running'&&!step.command?.length&&queued.some(next=>next.detail&&step.activity==='阶段等待资源：'+next.detail+'；本阶段命令尚未启动')))return 'waiting';
 return 'workflow';
}

export async function readDevices(config,{runs=[],viewerHost,viewerResources,now=Date.now()}={}){
 const root=resolve(config.devicesRoot||join(dirname(resolve(config.runsRoot)),'devices'));
 const ttl=Number.isFinite(config.deviceHeartbeatTtlMs)?Math.max(5000,Math.min(config.deviceHeartbeatTtlMs,300000)):45000;
 const configured=Array.isArray(config.devices)?config.devices.slice(0,64):[];
 const definitions=[],used=new Set();
 for(const entry of configured){const host=normalizeHost(entry,'configured');if(!id(entry?.id)||!host||used.has(entry.id))continue;used.add(entry.id);definitions.push({...entry,host});}
 let viewer=definitions.find(item=>sameDevice(item.host,viewerHost));
 if(viewerHost&&!viewer){let deviceId='workbench';for(let n=2;used.has(deviceId);n++)deviceId='workbench-'+n;viewer={id:deviceId,host:normalizeHost({...viewerHost,id:deviceId})};definitions.unshift(viewer);}
 const devices=[];
 for(const definition of definitions){
  const device={...definition.host,id:definition.id,name:definition.host.name||definition.host.computerName||definition.host.hostname,onlineState:'unknown',transport:definition.transport==='ssh'?'ssh':'local',detail:'尚未收到设备探测',resources:null,runs:[]};
  try{
   const file=definition.heartbeatFile?resolve(definition.heartbeatFile):join(root,definition.id+'.json');
   if((await stat(file)).size>32768)throw Error('HEARTBEAT_TOO_LARGE');
   const heartbeat=JSON.parse(await readFile(file,'utf8'));
   const checked=stamp(heartbeat.checkedAt),lastSeen=stamp(heartbeat.lastSeenAt),host=normalizeHost(heartbeat.host);
   if(heartbeat.format!=='wsl-device-v1'||heartbeat.id!==definition.id||!Number.isFinite(checked)||checked>now+5000||!['reachable','unreachable'].includes(heartbeat.connection))throw Error('HEARTBEAT_INVALID');
   if(heartbeat.connection==='reachable'&&(!host||!sameDevice(definition.host,host)))throw Error('DEVICE_IDENTITY_MISMATCH');
   device.checkedAt=new Date(checked).toISOString();
   device.resources=normalizeDeviceResources(heartbeat.resources);
   if(Number.isFinite(heartbeat.clockOffsetMs)&&Math.abs(heartbeat.clockOffsetMs)<=86400000)device.clockOffsetMs=heartbeat.clockOffsetMs;
   if(Number.isFinite(lastSeen)&&lastSeen<=checked+5000)device.lastSeenAt=new Date(lastSeen).toISOString();
   device.onlineState=now-checked>ttl?'stale':heartbeat.connection==='reachable'?'online':'unreachable';
   device.detail={online:'最近探测成功',unreachable:'最近探测未能连接设备',stale:'设备探测已过期'}[device.onlineState];
   if(host&&heartbeat.connection==='reachable')for(const field of ['computerName','hostname','platform','distro'])if(host[field])device[field]=host[field];
  }catch(error){device.detail=error.code==='ENOENT'?'尚未收到设备探测':'设备探测不可用';}
  if(definition===viewer){device.onlineState='online';device.transport='local';device.checkedAt=new Date(now).toISOString();device.lastSeenAt=device.checkedAt;device.detail='工作台服务正在此设备响应';if(viewerResources)device.resources=normalizeDeviceResources({...viewerResources,state:viewerResources.platform==='linux'?'running':'unknown',windows:device.resources?.windows,lockBusy:device.resources?.lockBusy});}
  devices.push(device);
 }
 const unassignedRuns=[];
 for(const run of runs){
  const matches=devices.filter(device=>sameDevice(device,run.executor));
  if(matches.length!==1){unassignedRuns.push(run.id);continue;}
  const device=matches[0];let workState=deviceRunState(run,now,config.deviceRunTtlMs,device.clockOffsetMs||0);
  if(device.onlineState!=='online'&&workState!=='history')workState='unconfirmed';
  const active=run.steps?.find(step=>step.status==='running');
  device.runs.push({id:run.id,taskKey:run.taskKey,name:run.name,status:run.status,workState,activity:run.queueReason||active?.activity||active?.label,updatedAt:run.updatedAt});
 }
 const priority={executing:0,waiting:1,workflow:2,unconfirmed:3,history:4};
 for(const device of devices){device.runs.sort((a,b)=>priority[a.workState]-priority[b.workState]||String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));device.workload=device.runs.find(run=>run.workState!=='history')?.workState||(device.onlineState==='online'&&['running','stopped'].includes(device.resources?.state)?'idle':'unconfirmed');}
 return {devices,unassignedRuns};
}
