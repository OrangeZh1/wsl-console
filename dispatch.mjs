import {readFile,writeFile,open,lstat,realpath,mkdir,readdir,rename,unlink,rmdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const GiB=1024**3,ttl=45000,manifestLimit=1024*1024;
const identifier=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);
const own=(object,key)=>Object.hasOwn(object,key);
const date=value=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)?Date.parse(value):NaN;
const fresh=(value,now)=>Number.isFinite(date(value))&&date(value)<=now+5000&&now-date(value)<=ttl;
const revision=job=>!own(job,'revision')?0:Number.isSafeInteger(job.revision)&&job.revision>=0?job.revision:NaN;
const unchanged=(job,reason)=>({route:'unchanged',...(job?.plannedDeviceId?{deviceId:job.plannedDeviceId}:{}),reason});

// Paths are part of the declared binding; existence/content are checked by the adapter.
export function preparedInputDigest(inputs){
 if(!Array.isArray(inputs)||!inputs.length)throw Error('PREPARED_INPUT_INVALID');
 const paths=new Set(),rows=inputs.map(input=>{if(typeof input?.path!=='string'||!input.path.trim()||input.path.length>4096||!/^[a-f0-9]{64}$/i.test(input.sha256||'')||paths.has(input.path))throw Error('PREPARED_INPUT_INVALID');paths.add(input.path);return [input.path,input.sha256.toLowerCase()]});
 rows.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
const preparationSignature=job=>createHash('sha256').update(JSON.stringify({inputs:job.inputs,executors:job.executors,inputsReady:job.inputsReady,peakBytes:job.peakBytes,portable:job.portable,visibility:job.visibility,repositoryVisibility:job.repositoryVisibility,sourcePublic:job.sourcePublic})).digest('hex');

function admission(job,device,now){
 if(device.onlineState!=='online'||!fresh(device.checkedAt,now))return {reason:'设备不可达或核验已过期'};
 const data=device.resources;
 if(!data||!fresh(own(data,'normalizedTimes')?data.normalizedTimes?.sampledAt:data.sampledAt,now))return {reason:'资源采样缺失或已过期'};
 if(device.leaseBusy===true||data.lockBusy===true||['executing','unconfirmed'].includes(device.workload))return {reason:'设备已有执行、租约或待确认活动'};
 const host=data.windows?.availableBytes,hostRequired=Math.max(2.5*GiB,job.peakBytes+GiB);
 if(!Number.isSafeInteger(host)||host<hostRequired)return {reason:'Windows 可用内存不足或未核验'};
 if(data.state==='stopped')return {needsWarmup:true};
 if(data.state!=='running')return {reason:'WSL 运行状态尚未确认'};
 if(data.lockBusy!==false)return {reason:'统一重任务锁状态尚未核验'};
 const memory=data.memory?.availableBytes,linuxRequired=Math.max(2*GiB,job.peakBytes+GiB/2),cpu=data.cpu;
 if(!Number.isSafeInteger(memory)||memory<linuxRequired)return {reason:'WSL 可用内存不足或未核验'};
 if(!Number.isSafeInteger(cpu?.logicalProcessors)||cpu.logicalProcessors<1||!Number.isFinite(cpu.load1)||cpu.load1<0)return {reason:'CPU 负载尚未核验'};
 if(cpu.load1>=cpu.logicalProcessors)return {reason:'CPU 负载已达到逻辑核数'};
 return {needsWarmup:false};
}

// This chooses a candidate from fresh snapshots. The adapter must re-sample and
// hold that physical device's unified flock for the complete child lifetime.
export function chooseExecutionDevice(job,devices,{now=Date.now()}={}){
 if(!job||typeof job!=='object'||Array.isArray(job)||!Number.isFinite(now))return {route:'queued',reason:'任务或当前时间无效'};
 if(job.status!=='queued'||own(job,'startedAt'))return unchanged(job,'已有启动记录或不处于排队状态，保留原分配');
 if(job.recoveryRequired||job.dispatchLease)return unchanged(job,'已有任务租约或恢复要求，不自动重跑');
 if(job.sourcePublic===true||job.visibility==='public'||job.repositoryVisibility==='public')return {route:'github-actions',reason:'公开源码的 CI 只走 GitHub Actions，不回退物理设备'};
 if(job.approved!==true)return {route:'queued',reason:'任务尚未获准执行'};
 if(!['private','internal','none','unpublished'].includes(job.visibility||job.repositoryVisibility))return {route:'queued',reason:'仓库可见性尚未核实，不推断执行位置'};
 if(job.inputsReady!==true)return {route:'queued',reason:'不可变输入尚未准备完成'};
 if(!Number.isSafeInteger(job.peakBytes)||job.peakBytes<0)return {route:'queued',reason:'缺少明确的有界内存峰值预算'};
 const configured=Array.isArray(devices)?devices:[],remotes=configured.filter(device=>device?.transport==='ssh');
 const available=configured.filter(device=>identifier(device?.id)&&['local','ssh'].includes(device.transport)),counts=new Map();
 for(const device of available)counts.set(device.id,(counts.get(device.id)||0)+1);
 const unique=available.filter(device=>counts.get(device.id)===1);
 const online=unique.filter(device=>device.transport==='ssh'&&device.onlineState==='online'&&fresh(device.checkedAt,now));
 const unreachable=remotes.length>0&&remotes.every(device=>counts.get(device.id)===1&&device.onlineState==='unreachable'&&fresh(device.checkedAt,now));
 if(!online.length&&!unreachable)return {route:'queued',reason:remotes.length?'远程状态缺失、已过期或尚未确认不可达，本机不接收项目':'尚未配置远程设备，不能将缺少探测当作远程不可达'};
 // Online remotes lock the execution location even when admission fails.
 // Local capacity is considered only after every configured remote is freshly unreachable.
 const pool=online.length?online:unique.filter(device=>device.transport==='local');
 const candidates=job.portable===true?pool:pool.filter(device=>device.id===job.plannedDeviceId);
 const location=online.length?'远程在线，本机不接收项目':'所有远程均已确认不可达，核验本机准入';
 const reasons=[];
 for(const device of candidates){const check=admission(job,device,now);if(!check.reason)return {route:'device',deviceId:device.id,needsWarmup:check.needsWarmup,reason:check.needsWarmup?location+'；候选设备 WSL 未运行，须先预热、重新采样并持有统一 flock，尚未通过 Linux 准入':location+'；'+(job.portable===true?'候选设备满足本次快照准入':'保留满足准入的原设备')};reasons.push(device.id+'：'+check.reason);}
 return {route:'queued',reason:location+'；'+(reasons.length?reasons.join('；'):job.portable===true?'没有满足条件的候选设备':'任务不可迁移，保留原分配排队')};
}

async function atomicJson(file,value){
 const text=JSON.stringify(value,null,2)+'\n',temporary=file+'.'+randomUUID()+'.tmp';let created=false;
 try{const handle=await open(temporary,'wx',0o600);created=true;try{await handle.writeFile(text,'utf8');await handle.sync()}finally{await handle.close()}await rename(temporary,file);created=false;return text;}
 finally{if(created)await unlink(temporary).catch(()=>{});}
}

export async function readQueueManifest(file,jobId){
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('QUEUE_MANIFEST_INVALID');
 if(info.size>manifestLimit)throw Error('QUEUE_MANIFEST_TOO_LARGE');
 const handle=await open(file,'r');let text;try{const buffer=Buffer.alloc(Math.min(info.size+1,manifestLimit+1));let length=0;while(length<buffer.length){const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}if(length>manifestLimit||length>info.size)throw Error('QUEUE_MANIFEST_CHANGED_DURING_READ');text=buffer.subarray(0,length).toString('utf8')}finally{await handle.close()}
 const job=JSON.parse(text);
 if(!job||Array.isArray(job)||job.id!==jobId||!Number.isFinite(revision(job))||['assignmentHistory','attemptHistory'].some(key=>own(job,key)&&!Array.isArray(job[key])))throw Error('QUEUE_MANIFEST_INVALID');
 return {job,text};
}

// execute(job, device) owns the real process and validates its terminal receipt.
// It returns queued/busy only before launch, or {status,runId,receiptFile,
// exitCode,finishedAt}. Throw/timeout/unknown keeps the lease for manual recovery.
// Queue status is not fabricated as running before the adapter actually starts.
export async function dispatchQueuedJob(queueRoot,jobId,devices,execute,{now}={}){
 if(!identifier(jobId))throw Error('QUEUE_JOB_ID_INVALID');
 const observedAt=Date.now(),clock=()=>now===undefined?Date.now():now+Math.max(0,Date.now()-observedAt);if(!Number.isFinite(clock()))throw Error('QUEUE_TIME_INVALID');
 const root=await realpath(resolve(queueRoot)),directory=join(root,jobId),directoryInfo=await lstat(directory);
 if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink())throw Error('QUEUE_DIRECTORY_INVALID');
 const file=join(directory,'job.json'),lease=join(directory,'lease'),ownerFile=join(lease,'owner.json');
 let expected=await readQueueManifest(file,jobId),job=expected.job,choice=chooseExecutionDevice(job,devices,{now:clock()});
 if(choice.route==='unchanged')return {...choice,recoveryRequired:job.recoveryRequired===true};
 const priorWait=job.waiting,signature=preparationSignature(job),candidate=devices.find(device=>device.id===choice.deviceId);
 if(choice.route==='queued'&&priorWait?.kind==='resources'&&priorWait.reason===choice.reason&&priorWait.preparationSignature===signature&&clock()-date(priorWait.checkedAt)<30000)return choice;
 if(choice.route==='device'&&priorWait&&priorWait.deviceId===choice.deviceId&&priorWait.preparationSignature===signature&&['preparation','admission'].includes(priorWait.kind)&&date(priorWait.nextCheckAt)>clock()&&(priorWait.kind==='preparation'||priorWait.deviceCheckedAt===candidate?.checkedAt))return {route:'queued',deviceId:choice.deviceId,reason:priorWait.reason,retryAt:priorWait.nextCheckAt};
 try{await mkdir(lease)}catch(error){if(error.code==='EEXIST')return {route:'queued',reason:'任务已有租约，保留原租约且不自动抢占'};throw error;}
 const token=randomUUID(),claimedAt=new Date(clock()).toISOString();
 let owner={format:'wsl-job-lease-v1',jobId,token,pid:process.pid,claimedAt,revision:revision(job),state:'leased'},invoked=false;
 async function owns(){try{return JSON.parse(await readFile(ownerFile,'utf8')).token===token}catch{return false}}
 async function assertOwner(){if(!await owns())throw Error('QUEUE_LEASE_OWNERSHIP_CHANGED')}
 async function writeOwner(patch){await assertOwner();owner={...owner,...patch};await atomicJson(ownerFile,owner);}
 async function save(next){
  await assertOwner();const current=await readQueueManifest(file,jobId);
  // The lease is the exclusion mechanism; revision + exact contents detect
  // conflicting non-participating writers before a write, rather than replacing them.
  if(revision(current.job)!==revision(expected.job)||current.text!==expected.text)throw Error('QUEUE_REVISION_CHANGED');
  next={...next,revision:revision(expected.job)+1,updatedAt:new Date(clock()).toISOString()};
  const text=await atomicJson(file,next);job=next;expected={job:next,text};return next;
 }
 async function release(){
  await assertOwner();const entries=await readdir(lease);if(entries.length!==1||entries[0]!=='owner.json')throw Error('QUEUE_LEASE_HAS_RECOVERY_FILES');
  await unlink(ownerFile);await rmdir(lease);
 }
 async function recover(reason,evidence){
  let recoveryRecorded=false;
  const recovery={reason,recordedAt:new Date(clock()).toISOString(),...(evidence?{result:evidence}:{})};
  try{await writeOwner({state:'recovery-required',recoveryRequired:true,recovery});recoveryRecorded=true}catch{}
  try{await save({...job,status:'blocked',recoveryRequired:true,dispatchLease:{token,deviceId:choice.deviceId,claimedAt,state:'recovery-required'},recovery});recoveryRecorded=true}catch{}
  return {route:'unchanged',deviceId:choice.deviceId,reason,recoveryRequired:true,recoveryRecorded,leaseRetained:true};
 }
 async function recordWait(reason,{kind='resources',result,deviceId=choice.deviceId,retryAfterMs=5000}={}){
  const nowMs=clock(),at=new Date(nowMs).toISOString(),previous=job.waiting,same=previous?.reason===reason&&previous?.deviceId===deviceId&&previous?.kind===kind&&previous?.preparationSignature===signature;
  const next={...job,status:'queued',queueReason:reason,waiting:{kind,reason,...(deviceId?{deviceId}:{}),since:same?previous.since:at,checkedAt:at,nextCheckAt:new Date(nowMs+Math.max(1000,Math.min(retryAfterMs,300000))).toISOString(),preparationSignature:signature,...(candidate?.checkedAt?{deviceCheckedAt:candidate.checkedAt}:{}),...(result?.admissionEvidence?{admissionEvidence:result.admissionEvidence}:{})}};
  delete next.dispatchLease;
  if(result)next.result=result;
  // Admission polls are not execution attempts. Unchanged resource waits stay bounded.
  if(!same||job.dispatchLease||result||nowMs-date(previous.checkedAt)>=30000)await save(next);
 }
 let progressTail=Promise.resolve(),progressError;
 function report(progress){
  const operation=progressTail.then(async()=>{
   if(progress?.format!=='wsl-job-result-v2'||progress.finished!==false||progress.commandStarted!==true||progress.status!=='running'||progress.attemptId!==token||progress.deviceId!==choice.deviceId||!job.dispatchLease?.inputDigest||progress.inputDigest!==job.dispatchLease.inputDigest||!identifier(progress.runId))throw Error('EXECUTION_PROGRESS_BINDING_MISMATCH');
   const start=date(progress.startedAt),heartbeat=date(progress.heartbeatAt||progress.startedAt);
   if(!Number.isFinite(start)||!Number.isFinite(heartbeat)||start<date(claimedAt)-15000||heartbeat<start||heartbeat>clock()+15000)throw Error('EXECUTION_PROGRESS_TIME_INVALID');
   if(job.execution&&(job.execution.runId!==progress.runId||job.execution.startedAt!==progress.startedAt))throw Error('EXECUTION_PROGRESS_ATTEMPT_CHANGED');
   if(job.execution&&date(job.execution.heartbeatAt)>=heartbeat)return;
   const execution={attemptId:token,deviceId:choice.deviceId,inputDigest:progress.inputDigest,runId:progress.runId,startedAt:progress.startedAt,heartbeatAt:progress.heartbeatAt||progress.startedAt,...(typeof progress.activity==='string'?{activity:progress.activity.slice(0,2000)}:{})};
   const next={...job,status:'running',startedAt:progress.startedAt,heartbeatAt:execution.heartbeatAt,execution,dispatchLease:{...job.dispatchLease,state:'running'}};delete next.waiting;delete next.queueReason;
   await save(next);await writeOwner({state:'running',execution});
  });
  progressTail=operation.catch(error=>{progressError=error});return operation;
 }
 try{
  await writeFile(ownerFile,JSON.stringify(owner,null,2)+'\n',{flag:'wx',mode:0o600});
  const latest=await readQueueManifest(file,jobId);
  if(latest.text!==expected.text||revision(latest.job)!==revision(expected.job)){await release();return unchanged(latest.job,'任务修订已变化，未执行且保留新状态');}
  choice=chooseExecutionDevice(job,devices,{now:clock()});
  if(choice.route==='unchanged'){await release();return choice;}
  if(choice.route==='queued'){await recordWait(choice.reason);await release();return choice;}
  const event={at:claimedAt,route:choice.route,fromDeviceId:job.plannedDeviceId??null,toDeviceId:choice.deviceId??null,reason:choice.reason};
  const changed=job.executionRoute!==choice.route||job.plannedDeviceId!==choice.deviceId;
  const assigned={...job,executionRoute:choice.route,...(changed?{assignmentHistory:[...(job.assignmentHistory||[]),event]}:{})};
  if(choice.route==='github-actions'){
   delete assigned.plannedDeviceId;delete assigned.waiting;delete assigned.queueReason;if(changed||job.waiting)await save(assigned);await release();return {...choice,status:job.status,leaseRetained:false};
  }
  if(typeof execute!=='function'){await release();return {route:'queued',reason:'缺少实际执行端回调，尚未启动'};}
  let inputDigest;try{inputDigest=preparedInputDigest(job.inputs)}catch{}
  assigned.plannedDeviceId=choice.deviceId;assigned.dispatchLease={token,deviceId:choice.deviceId,inputDigest,claimedAt,needsWarmup:choice.needsWarmup,state:'leased'};
  await save(assigned);await writeOwner({deviceId:choice.deviceId,state:'callback',executionInvokedAt:new Date(clock()).toISOString()});
  invoked=true;
  let result;try{result=await execute(structuredClone(job),devices.find(device=>device.id===choice.deviceId),report);await progressTail;if(progressError)throw progressError}catch(error){await progressTail;return recover('执行结果未知：'+(error?.message||'执行端异常'));}
  if(!result||typeof result!=='object'||Array.isArray(result))return recover('执行端未返回可确认的实际结果');
  try{result=JSON.parse(JSON.stringify(result))}catch{return recover('执行端结果无法持久化，保留租约等待恢复');}
  if(!result||typeof result!=='object'||Array.isArray(result))return recover('执行端未返回可持久化的实际结果');
  if(['queued','busy'].includes(result.status)){
   if(own(job,'startedAt')||job.execution||['runId','receiptFile','exitCode','startedAt','finishedAt'].some(key=>own(result,key))||result.commandStarted!==false)return recover('排队结果含启动或结束证据，无法确认命令未启动',result);
   if(result.waitKind==='admission'){const evidence=result.admissionEvidence;if(evidence?.format!=='wsl-job-result-v2'||evidence.attemptId!==token||evidence.deviceId!==choice.deviceId||!job.dispatchLease?.inputDigest||evidence.inputDigest!==job.dispatchLease.inputDigest||![0,75].includes(evidence.exitCode)||!Number.isFinite(date(evidence.reportedAt))||date(evidence.reportedAt)<date(claimedAt)-15000||date(evidence.reportedAt)>clock()+15000)return recover('准入等待缺少本次尝试的未启动回执，保留租约等待恢复',result);}
   const reason=result.reason||'执行端尚未启动命令，等待重新准入';await recordWait(reason,{kind:result.waitKind==='admission'?'admission':'preparation',result,retryAfterMs:Number.isFinite(result.retryAfterMs)?result.retryAfterMs:30000});
   await release();return {...choice,route:'queued',status:'queued',reason,leaseRetained:false};
  }
  const terminal=['passed','failed','blocked','interrupted','cancelled'].includes(result.status),receipt=typeof result.runId==='string'&&result.runId&&typeof result.receiptFile==='string'&&result.receiptFile&&Number.isFinite(date(result.finishedAt)),exit=Number.isInteger(result.exitCode)||result.exitCode===null;
  if(!terminal||!receipt||!exit||result.format!=='wsl-job-result-v2'||result.commandStarted!==true||result.attemptId!==token||result.deviceId!==choice.deviceId||result.inputDigest!==job.dispatchLease?.inputDigest||!inputDigest||result.status==='passed'&&result.exitCode!==0||result.timedOut===true||result.finished!==true||!Number.isFinite(date(result.startedAt))||date(result.startedAt)<date(claimedAt)-15000||date(result.finishedAt)<date(result.startedAt)||date(result.finishedAt)>clock()+15000)return recover('执行端未提供一致的真实终态回执，保留租约等待恢复',result);
  if(job.execution&&(job.execution.runId!==result.runId||job.execution.startedAt!==result.startedAt))return recover('执行端终态与已确认运行不一致，保留租约等待恢复',result);
  const next={...job,status:result.status,finishedAt:result.finishedAt,result,attemptHistory:[...(job.attemptHistory||[]),{at:new Date(clock()).toISOString(),deviceId:choice.deviceId,leaseToken:token,result}]};delete next.dispatchLease;
  delete next.waiting;delete next.queueReason;next.execution={attemptId:token,deviceId:choice.deviceId,inputDigest,runId:result.runId,startedAt:result.startedAt,finishedAt:result.finishedAt};
  if(own(result,'startedAt')){if(!Number.isFinite(date(result.startedAt)))return recover('执行端启动时间无效，保留租约等待恢复');next.startedAt=result.startedAt;}
  await save(next);await release();return {...choice,status:result.status,result,leaseRetained:false};
 }catch(error){
  if(invoked||['QUEUE_REVISION_CHANGED','QUEUE_LEASE_OWNERSHIP_CHANGED','QUEUE_LEASE_HAS_RECOVERY_FILES'].includes(error.code||error.message))return recover(error.message);
  if(await owns()){try{await release()}catch{return recover(error.message)}}else{try{await rmdir(lease)}catch{}}
  throw error;
 }
}
