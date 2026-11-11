import {readFile,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {normalizeHost} from './host.mjs';
import {performance} from 'node:perf_hooks';
import {platform} from 'node:os';
import {createClockObserver} from './clock-observation.mjs';

const id=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const generic=name=>/^(?:localhost(?:\.localdomain)?|ubuntu|wsl)$/i.test(name||'');
const defaultClockObserver=createClockObserver();

export function normalizeDeviceResources(value){
 if(!value||typeof value!=='object')return null;
 const range=input=>{const total=input?.totalBytes,available=input?.availableBytes;return Number.isSafeInteger(total)&&Number.isSafeInteger(available)&&total>=0&&available>=0&&available<=total?{totalBytes:total,availableBytes:available,usedBytes:total-available}:null};
 const result={state:['running','stopped'].includes(value.state)?value.state:'unknown',status:['available','partial','unavailable'].includes(value.status)?value.status:'unavailable',platform:value.platform==='linux'?'linux':'unknown',memory:range(value.memory),swap:range(value.swap),cpu:Number.isInteger(value.cpu?.logicalProcessors)&&value.cpu.logicalProcessors>0&&Number.isFinite(value.cpu.load1)&&value.cpu.load1>=0?{logicalProcessors:value.cpu.logicalProcessors,load1:value.cpu.load1}:null,windows:range(value.windows),lockBusy:typeof value.lockBusy==='boolean'?value.lockBusy:null};
 if(Number.isFinite(stamp(value.sampledAt)))result.sampledAt=new Date(stamp(value.sampledAt)).toISOString();
 const windowsAt=value.windows?.sampledAt||value.windowsSampledAt||value.sampledAt,lockAt=value.lockSampledAt||value.sampledAt;
 if(Number.isFinite(stamp(windowsAt))){result.windowsSampledAt=new Date(stamp(windowsAt)).toISOString();if(result.windows)result.windows.sampledAt=result.windowsSampledAt;}
 if(Number.isFinite(stamp(lockAt)))result.lockSampledAt=new Date(stamp(lockAt)).toISOString();
 if(value.clock?.domain==='linux'&&typeof value.clock.bootId==='string'&&/^[a-f0-9-]{36}$/i.test(value.clock.bootId)&&Number.isFinite(value.clock.uptimeMs)&&value.clock.uptimeMs>=0)result.clock={domain:'linux',bootId:value.clock.bootId,uptimeMs:value.clock.uptimeMs,...(Number.isFinite(stamp(value.clock.sampledAt))?{sampledAt:value.clock.sampledAt}:{})};
 for(const key of ['ageAtReceiptMs','windowsAgeAtReceiptMs','lockAgeAtReceiptMs'])if(Number.isFinite(value[key])&&value[key]>=0)result[key]=value[key];
 if(typeof value.receipt?.sessionId==='string'&&value.receipt.sessionId.length<=80&&Number.isFinite(value.receipt.monotonicMs))result.receipt={sessionId:value.receipt.sessionId,monotonicMs:value.receipt.monotonicMs};
 return result;
}
function normalizeTimes(resource,pulse,observed,now,ttl){
 if(!resource)return null;resource={...resource,sourceSampledAt:resource.sampledAt};const owner=pulse.observer,receipt=resource.receipt;
 const delay=owner&&receipt&&owner.sessionId===receipt.sessionId&&owner.monotonicMs>=receipt.monotonicMs?owner.monotonicMs-receipt.monotonicMs:NaN;
 const age=value=>observed.verified&&Number.isFinite(delay)&&Number.isFinite(value)?observed.ageMs+delay+value:NaN;
 const linuxAge=age(resource.ageAtReceiptMs),windowsAge=age(resource.windowsAgeAtReceiptMs),lockAge=age(resource.lockAgeAtReceiptMs),date=value=>Number.isFinite(value)?new Date(now-value).toISOString():undefined;
 resource.normalizedTimes={sampledAt:date(linuxAge),windowsSampledAt:date(windowsAge),lockSampledAt:date(lockAge)};resource.freshness={verified:Number.isFinite(linuxAge)&&linuxAge<=ttl,ageMs:Number.isFinite(linuxAge)?linuxAge:null};
 if(!Number.isFinite(linuxAge)||linuxAge>ttl){resource.lastState=resource.state;resource.state='unknown';resource.status='unavailable';resource.memory=null;resource.swap=null;resource.cpu=null;}
 if(!Number.isFinite(windowsAge)||windowsAge>ttl)resource.windows=null;
 if(!Number.isFinite(lockAge)||lockAge>ttl)resource.lockBusy=null;
 return resource;
}
const diagnosticKinds=new Set(['identity','protocol','authentication','host-key','configuration','timeout','connection','linux-state']);
function diagnostic(heartbeat){const value=heartbeat.diagnostic,code=value?.code||heartbeat.error;if(typeof code!=='string'||!/^[A-Z][A-Z0-9_]{1,80}$/.test(code))return undefined;return {kind:diagnosticKinds.has(value?.kind)?value.kind:'protocol',code};}
function connectionState(heartbeat){
 if(heartbeat.connection!=='unreachable')return heartbeat.connection;
 const detail=diagnostic(heartbeat);if(!detail)return 'unknown';
 // V1 collapsed authentication, identity and program errors into unreachable.
 // Such records do not prove that the remote machine is off the network.
 return detail.kind==='connection'&&detail.code==='PROBE_CONNECTION_UNREACHABLE'?'unreachable':'unknown';
}

// A display name is not an identity; a common default Linux hostname proves nothing.
export function sameDevice(a,b){
 if(!a||!b)return false;
 if(a.computerName&&b.computerName)return equal(a.computerName,b.computerName);
 if(a.id&&b.id&&equal(a.id,b.id))return true;
 return Boolean(a.hostname&&b.hostname&&!generic(a.hostname)&&equal(a.hostname,b.hostname));
}

function declaredWorkState(run){
 if(!['running','queued'].includes(run.status))return 'history';
 if(run.status==='queued')return 'waiting';
 if(run.steps?.some(step=>step.status==='running'&&step.command?.length))return 'executing';
 if(typeof run.queueReason==='string'&&run.queueReason.trim())return 'waiting';
 const queued=run.steps?.filter(step=>step.status==='queued')||[];
 if(run.steps?.some(step=>step.status==='running'&&!step.command?.length&&queued.some(next=>next.detail&&step.activity==='阶段等待资源：'+next.detail+'；本阶段命令尚未启动')))return 'waiting';
 return 'workflow';
}
export function deviceRunState(run,now=Date.now(),maxAge=90000,linuxClockOffsetMs=0){
 if(!['running','queued'].includes(run.status))return 'history';
 const seen=stamp(run.heartbeatAt||run.updatedAt)-linuxClockOffsetMs;
 return !Number.isFinite(seen)||seen>now+5000||now-seen>maxAge?'unconfirmed':declaredWorkState(run);
}

function reportedTime(run,step){return step?.heartbeatAt||run.heartbeatAt||step?.activityUpdatedAt||run.updatedAt;}
function observedState(run,step,device,{now,maxAge,clockObserver,monotonicNow,scope=''}){
 const reported=reportedTime(run,step),seen=stamp(reported);
 const observation={observedAt:new Date(now).toISOString(),...(Number.isFinite(seen)?{lastHeartbeatAt:new Date(seen).toISOString()}:{})};
 const unknown=reason=>({workState:'unconfirmed',observation:{...observation,reason}});
 if(!device)return unknown('没有唯一可核实的执行设备');
 if(device.onlineState!=='online')return unknown('执行设备不可达或探测状态未确认');
 if(clockObserver){
  const observed=clockObserver.record(scope+'/run/'+run.id+'/'+(step?.id||'flow'),reported,{mono:monotonicNow,ttl:maxAge});
  observation.clockVerified=observed.verified;if(observed.verified)observation.lastChangeObservedAt=new Date(now-observed.minAgeMs).toISOString();
  if(device.resources?.state==='stopped'&&device.resources.freshness?.verified&&(!observed.verified||device.resources.freshness.ageMs<=observed.minAgeMs))return unknown('较新的设备采样显示WSL已经停止，运行心跳尚无一致的新鲜证据');
  if(!observed.verified||observed.ageMs>maxAge)return unknown(observed.reason||'任务心跳已停止变化或单调观察已过期');
  return {workState:declaredWorkState(step?{...run,steps:[step]}:run),observation};
 }
 // Raw helper callers can compare only timestamps in their explicitly known
 // domain. The Windows offset is never a Linux-heartbeat correction.
 const offset=device.linuxClockOffsetMs||0;
 if(Number.isFinite(seen)&&device.resources?.state==='stopped'&&stamp(device.resources.normalizedTimes?.sampledAt||device.resources.sampledAt)>=seen-offset)return unknown('较新的设备采样显示WSL已经停止'+(now-(seen-offset)>maxAge?'，原运行记录的心跳也已过期':''));
 if(!Number.isFinite(seen)||seen-offset>now+5000||now-(seen-offset)>maxAge)return unknown('任务心跳缺失、过期或时间不可信');
 const state=step?deviceRunState({...run,heartbeatAt:reported,steps:[step]},now,maxAge,offset):deviceRunState(run,now,maxAge,offset);
 return {workState:state,observation};
}
function cloudState(run,{now,maxAge}){
 const ci=run.sourceCi,seen=stamp(ci?.observedAt||ci?.updatedAt||run.heartbeatAt||run.updatedAt),observation={observedAt:new Date(now).toISOString(),...(Number.isFinite(seen)?{lastHeartbeatAt:new Date(seen).toISOString()}:{})};
 if(!ci?.url||!ci.runId||!Number.isFinite(seen)||seen>now+5000||now-seen>maxAge)return {workState:'unconfirmed',observation:{...observation,reason:'云端CI来源或观察时间尚未核实'}};
 if(ci.status==='in_progress')return {workState:'executing',observation};
 if(['queued','requested','waiting','pending'].includes(ci.status))return {workState:'waiting',observation};
 return {workState:'unconfirmed',observation:{...observation,reason:'云端CI状态与活动运行记录不一致'}};
}

export function observeRuns(runs,devices,{now=Date.now(),maxAge=90000,clockObserver,monotonicNow,scope=''}={}){
 const context={now,maxAge,clockObserver,monotonicNow,scope};
 const unassignedRuns=[],observed=[];const priority={executing:0,waiting:1,workflow:2,unconfirmed:3,history:4};
 const uniqueDevice=host=>{const matches=devices.filter(device=>sameDevice(device,host));return matches.length===1?matches[0]:null;};
 for(const original of runs){
  const run={...original,steps:(original.steps||[]).map(step=>({...step}))},terminal=!['running','queued'].includes(run.status),placements=new Map(),states=[];
  function add(device,state,step){states.push(state);if(step)Object.assign(step,state);if(!device)return;const old=placements.get(device.id);if(!old||priority[state.workState]<priority[old.state.workState])placements.set(device.id,{device,state,stepIds:step?[step.id]:[]});else if(step)old.stepIds.push(step.id);}
  const stepHost=step=>Object.hasOwn(step,'executor')?step.executor:run.executor;
  if(terminal){const state={workState:'history',observation:{observedAt:new Date(now).toISOString()}},hosts=run.steps.some(step=>Object.hasOwn(step,'executor'))?run.steps.map(stepHost):[run.executor];for(const host of hosts){const device=uniqueDevice(host);if(device&&!placements.has(device.id))add(device,state);}for(const step of run.steps)if(['running','queued'].includes(step.status))Object.assign(step,{workState:'unconfirmed',observation:{observedAt:new Date(now).toISOString(),reason:'运行已结束，但该步骤没有一致的终态'}});Object.assign(run,state);}
  else{
   const commands=run.steps.filter(step=>step.status==='running'&&step.command?.length);
   if(commands.length){for(const step of commands){const host=stepHost(step);if(host?.platform==='github-actions'){add(null,cloudState(run,{now,maxAge}),step);continue;}const device=uniqueDevice(host);add(device,observedState(run,step,device,context),step);}}
   else{const flow=run.steps.find(step=>step.status==='running'),host=run.plannedExecutor||(flow&&Object.hasOwn(flow,'controller')?flow.controller:flow&&Object.hasOwn(flow,'executor')?flow.executor:run.controller||run.executor);if(host?.platform==='github-actions')add(null,cloudState(run,{now,maxAge}));else{const planned=run.plannedDeviceId?devices.find(device=>device.id===run.plannedDeviceId):null,device=planned||uniqueDevice(host);add(device,observedState(run,null,device,context));}}
   const state=[...states].sort((a,b)=>priority[a.workState]-priority[b.workState])[0]||{workState:'unconfirmed',observation:{observedAt:new Date(now).toISOString(),reason:'没有可核实的活动来源'}};Object.assign(run,state);
  }
  if(!placements.size&&run.executor?.platform!=='github-actions'&&!run.steps.some(step=>step.executor?.platform==='github-actions'&&step.workState!=='unconfirmed'))unassignedRuns.push(run.id);
  for(const {device,state,stepIds}of placements.values()){
   const active=run.steps.find(step=>stepIds.includes(step.id))||run.steps.find(step=>step.status==='running');
   device.runs.push({id:run.id,taskKey:run.taskKey,name:run.name,status:run.status,...state,stepIds,activity:run.queueReason||active?.activity||active?.label,updatedAt:run.updatedAt});
  }
  observed.push(run);
 }
 for(const device of devices){
  device.runs.sort((a,b)=>priority[a.workState]-priority[b.workState]||String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
  const active=device.runs.find(run=>run.workState!=='history');
  device.workload=active?.workState||(device.onlineState==='online'&&device.resources?.state==='stopped'?'idle':device.onlineState==='online'&&device.resources?.state==='running'&&device.resources.lockBusy===false?'idle':'unconfirmed');
  if(!active&&device.resources?.lockBusy===true){device.workload='unconfirmed';device.detail='执行端重任务锁已占用，但没有对应的活动运行记录';}
 }
 return {runs:observed,devices,unassignedRuns};
}

export async function readDevices(config,{runs=[],viewerHost,viewerResources,now,monotonicNow,receiverClock,clockObserver=defaultClockObserver}={}){
 const root=resolve(config.devicesRoot||join(dirname(resolve(config.runsRoot)),'devices'));
 const ttl=Number.isFinite(config.deviceHeartbeatTtlMs)?Math.max(5000,Math.min(config.deviceHeartbeatTtlMs,300000)):45000;
 const configured=Array.isArray(config.devices)?config.devices.slice(0,64):[];
 const definitions=[],used=new Set();
 for(const entry of configured){const host=normalizeHost(entry,'configured');if(!id(entry?.id)||!host||used.has(entry.id))continue;used.add(entry.id);definitions.push({...entry,host});}
 let viewer=definitions.find(item=>sameDevice(item.host,viewerHost));
 if(viewerHost&&!viewer){let deviceId='workbench';for(let n=2;used.has(deviceId);n++)deviceId='workbench-'+n;viewer={id:deviceId,host:normalizeHost({...viewerHost,id:deviceId})};definitions.unshift(viewer);}
 const packets=new Map();
 for(const definition of definitions){try{const file=definition.heartbeatFile?resolve(definition.heartbeatFile):join(root,definition.id+'.json');if((await stat(file)).size>32768)throw Error('HEARTBEAT_TOO_LARGE');packets.set(definition.id,JSON.parse(await readFile(file,'utf8')))}catch(error){packets.set(definition.id,error)}}
 if(!receiverClock){receiverClock={};if(platform()==='linux')try{const [bootId,uptime]=await Promise.all([readFile('/proc/sys/kernel/random/boot_id','utf8'),readFile('/proc/uptime','utf8')]);receiverClock={bootId:bootId.trim(),uptimeMs:Number(uptime.split(' ')[0])*1000}}catch{}}
 now=Number.isFinite(now)?now:Date.now();const mono=Number.isFinite(monotonicNow)?monotonicNow:performance.now();
 const candidate=viewer?packets.get(viewer.id):undefined,reference=candidate?.format==='wsl-device-v1'&&candidate.id===viewer.id&&candidate.connection==='reachable'&&sameDevice(viewer.host,normalizeHost(candidate.host))?candidate:undefined;
 const devices=[];
 for(const definition of definitions){
  const device={...definition.host,id:definition.id,name:definition.host.name||definition.host.computerName||definition.host.hostname,onlineState:'unknown',transport:definition.transport==='ssh'?'ssh':'local',detail:'尚未收到设备探测',resources:null,runs:[]};
  try{
   const heartbeat=packets.get(definition.id);if(heartbeat instanceof Error)throw heartbeat;
   const checked=stamp(heartbeat.checkedAt),lastSeen=stamp(heartbeat.lastSeenAt),host=normalizeHost(heartbeat.host);
   if(heartbeat.format!=='wsl-device-v1'||heartbeat.id!==definition.id||!Number.isFinite(checked)||!['reachable','unreachable','unknown'].includes(heartbeat.connection))throw Error('HEARTBEAT_INVALID');
   if(heartbeat.connection==='reachable'&&(!host||!sameDevice(definition.host,host)))throw Error('DEVICE_IDENTITY_MISMATCH');
   const observed=clockObserver.pulse(root+'/'+definition.id,heartbeat,{mono,ttl,receiver:receiverClock,reference});
   device.controllerReceivedAt=new Date(checked).toISOString();device.clockObservation={...observed,observedAt:new Date(now).toISOString()};
   if(observed.verified){device.checkedAt=new Date(now-observed.ageMs).toISOString();device.normalizedTimes={checkedAt:device.checkedAt};if(heartbeat.connection==='reachable')device.lastSeenAt=device.checkedAt;}
   if(Number.isFinite(lastSeen))device.controllerLastSeenAt=new Date(lastSeen).toISOString();
   device.resources=normalizeTimes(normalizeDeviceResources(heartbeat.resources),heartbeat,observed,now,ttl);
   const windowsOffset=heartbeat.windowsClockOffsetMs??heartbeat.clockOffsetMs;if(Number.isFinite(windowsOffset)&&Math.abs(windowsOffset)<=86400000){device.windowsClockOffsetMs=windowsOffset;device.clockOffsetMs=windowsOffset;}
   if(device.resources?.freshness?.verified&&device.resources.clock&&Number.isFinite(heartbeat.linuxClockOffsetMs)&&Math.abs(heartbeat.linuxClockOffsetMs)<=86400000){device.linuxClockOffsetMs=heartbeat.linuxClockOffsetMs;device.linuxClockUncertaintyMs=heartbeat.linuxClockUncertaintyMs;device.linuxBootId=device.resources.clock.bootId;}
   const detail=diagnostic(heartbeat);if(detail)device.diagnostic=detail;
   const connection=connectionState(heartbeat);device.onlineState=!observed.verified?'unknown':observed.ageMs>ttl?'stale':connection==='reachable'?'online':connection==='unreachable'?'unreachable':'unknown';
   device.detail=!observed.verified?observed.reason:{online:'最近探测成功',unreachable:'最近探测未能连接设备',stale:'设备探测已过期',unknown:'设备连接诊断未能确认是否在线'}[device.onlineState];
   if(host&&heartbeat.connection==='reachable')for(const field of ['computerName','hostname','platform','distro'])if(host[field])device[field]=host[field];
  }catch(error){device.detail=error.code==='ENOENT'?'尚未收到设备探测':'设备探测不可用';}
  if(definition===viewer){device.onlineState='online';device.transport='local';device.checkedAt=new Date(now).toISOString();device.lastSeenAt=device.checkedAt;device.detail='工作台服务正在此设备响应';if(viewerResources?.platform==='linux')device.resources={...normalizeDeviceResources({...viewerResources,state:'running',windows:device.resources?.windows,windowsSampledAt:device.resources?.windowsSampledAt,lockBusy:device.resources?.lockBusy,lockSampledAt:device.resources?.lockSampledAt}),normalizedTimes:{sampledAt:viewerResources.sampledAt,windowsSampledAt:device.resources?.normalizedTimes?.windowsSampledAt,lockSampledAt:device.resources?.normalizedTimes?.lockSampledAt},freshness:{verified:true,ageMs:0}};}
  devices.push(device);
 }
 return observeRuns(runs,devices,{now,maxAge:Number.isFinite(config.deviceRunTtlMs)?Math.max(5000,Math.min(config.deviceRunTtlMs,600000)):90000,clockObserver,monotonicNow:mono,scope:root});
}
