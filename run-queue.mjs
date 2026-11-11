import {spawn} from 'node:child_process';
import {readFile,readdir,mkdir,appendFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readDevices} from './devices.mjs';
import {chooseExecutionDevice,dispatchQueuedJob,preparedInputDigest,readQueueManifest} from './dispatch.mjs';

export {preparedInputDigest} from './dispatch.mjs';
const receiptProtocol='wsl-job-result-v2',timeSlack=15000;
const own=(value,key)=>Object.hasOwn(value,key);
const timestamp=value=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const wait=(reason,waitKind='preparation')=>({status:'queued',commandStarted:false,waitKind,reason,retryAfterMs:waitKind==='admission'?15000:30000});

export function reserveDevice(reservations,deviceId,owner){
 if(!deviceId||reservations.has(deviceId))return null;
 const reservation={deviceId,owner};reservations.set(deviceId,reservation);return reservation;
}
export function releaseDevice(reservations,reservation){
 if(!reservation||reservations.get(reservation.deviceId)!==reservation)return false;
 reservations.delete(reservation.deviceId);return true;
}

// Receipts refer to one actual execution attempt, not merely a reusable job id.
export function validateExecutionReceipt(receipt,binding,exitCode,{terminal=true}={}){
 if(!receipt||receipt.format!==receiptProtocol||receipt.dispatchJobId!==binding.jobId||receipt.attemptId!==binding.attemptId||receipt.deviceId!==binding.deviceId||receipt.inputDigest!==binding.inputDigest)throw Error('EXECUTION_RECEIPT_BINDING_MISMATCH');
 if(typeof receipt.id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(receipt.id))throw Error('EXECUTION_RECEIPT_RUN_ID_INVALID');
 const offset=Number.isFinite(binding.clockOffsetMs)&&Math.abs(binding.clockOffsetMs)<=86400000?binding.clockOffsetMs:0;
 const normalized=value=>timestamp(value)-offset,validWindow=value=>Number.isFinite(value)&&value>=binding.started-timeSlack&&value<=binding.receivedAt+timeSlack;
 const common={format:receiptProtocol,attemptId:binding.attemptId,deviceId:binding.deviceId,inputDigest:binding.inputDigest};
 if(receipt.commandStarted===false){
  if(!terminal||receipt.finished!==true||!['queued','blocked'].includes(receipt.status)||own(receipt,'startedAt')||receipt.admission?.decision!=='wait'||typeof receipt.admission.reason!=='string'||!receipt.admission.reason.trim()||receipt.admission.reason.length>2000||![0,75].includes(exitCode))throw Error('EXECUTION_ADMISSION_RECEIPT_INVALID');
  const reported=normalized(receipt.reportedAt);if(!validWindow(reported))throw Error('EXECUTION_RECEIPT_TIME_INVALID');
  return {...wait(receipt.admission.reason.trim(),'admission'),admissionEvidence:{...common,runId:receipt.id,reportedAt:new Date(reported).toISOString(),sourceReportedAt:receipt.reportedAt,exitCode}};
 }
 if(receipt.commandStarted!==true)throw Error('EXECUTION_RECEIPT_START_UNCONFIRMED');
 const started=normalized(receipt.startedAt);if(!validWindow(started))throw Error('EXECUTION_RECEIPT_TIME_INVALID');
 if(!terminal){
  if(receipt.finished!==false||receipt.status!=='running')throw Error('EXECUTION_PROGRESS_NOT_RUNNING');
  const heartbeat=normalized(receipt.heartbeatAt||receipt.updatedAt||receipt.startedAt);if(!validWindow(heartbeat)||heartbeat<started)throw Error('EXECUTION_RECEIPT_TIME_INVALID');
  return {...common,status:'running',finished:false,commandStarted:true,runId:receipt.id,startedAt:new Date(started).toISOString(),heartbeatAt:new Date(heartbeat).toISOString(),activity:typeof receipt.activity==='string'?receipt.activity.slice(0,2000):receipt.steps?.find(step=>step.status==='running')?.activity};
 }
 if(receipt.finished!==true||!['passed','failed','blocked','interrupted','cancelled'].includes(receipt.status))throw Error('EXECUTION_RECEIPT_NOT_TERMINAL');
 const finished=normalized(receipt.finishedAt);if(!validWindow(finished)||finished<started)throw Error('EXECUTION_RECEIPT_TIME_INVALID');
 if(receipt.status==='passed'&&(exitCode!==0||receipt.exitCode!==undefined&&receipt.exitCode!==0||(receipt.tests?.fail??0)!==0||receipt.steps?.some(step=>step.status!=='passed'||(step.tests?.fail??0)!==0||step.exitCode!==undefined&&step.exitCode!==0)))throw Error('EXECUTION_EXIT_RECEIPT_CONFLICT');
 return {...common,status:receipt.status,finished:true,commandStarted:true,runId:receipt.id,exitCode,startedAt:new Date(started).toISOString(),finishedAt:new Date(finished).toISOString(),sourceTimes:{startedAt:receipt.startedAt,finishedAt:receipt.finishedAt,clockOffsetMs:offset}};
}

async function verifyInputs(inputs){
 for(const input of inputs){
  if((await stat(input.path)).size>16*1024*1024)return false;
  if(createHash('sha256').update(await readFile(input.path)).digest('hex')!==input.sha256.toLowerCase())return false;
 }
 return true;
}
async function readReceipt(file){if((await stat(file)).size>1024*1024)throw Error('EXECUTION_RECEIPT_TOO_LARGE');return JSON.parse(await readFile(file,'utf8'));}

// Commands and inputs must already be prepared and authorized by the project's executor.
// This adapter neither copies project state nor decides what a business task may do.
export async function executePreparedJob(job,device,directory,report=async()=>{}){
 const adapter=job.executors?.[device.id];
 if(!adapter||adapter.admissionEnforced!==true||adapter.lockEnforced!==true||!Array.isArray(adapter.args)||!adapter.args.every(arg=>typeof arg==='string')||typeof adapter.file!=='string'||typeof adapter.receiptFile!=='string')return wait('目标设备尚无具备资源准入与统一flock的已准备执行器');
 if(adapter.receiptProtocol!==receiptProtocol)return wait('执行器尚未准备绑定本次尝试的v2回执协议');
 if(typeof job.dispatchLease?.token!=='string'||!job.dispatchLease.token)return wait('本次执行租约尚未准备');
 let digest;try{digest=preparedInputDigest(job.inputs);if(!await verifyInputs(job.inputs))return wait('已准备输入发生变化或过大，等待执行端重新冻结')}catch{return wait('不可变输入摘要或文件尚未准备完成')}
 const binding={jobId:job.id,attemptId:job.dispatchLease.token,deviceId:device.id,inputDigest:digest,clockOffsetMs:device.clockOffsetMs||0};
 const started=Date.now(),log=join(directory,'executor.log');try{await appendFile(log,new Date(started).toISOString()+' device='+device.id+'\n')}catch{return wait('执行日志目录不可写，项目命令尚未启动')}
 let logTail=Promise.resolve(),logError,progressError,polling,lastProgress;
 async function pollProgress(){
  let progress;try{progress=validateExecutionReceipt(await readReceipt(adapter.receiptFile),{...binding,started,receivedAt:Date.now()},undefined,{terminal:false})}catch{return}
  const key=progress.runId+'|'+progress.heartbeatAt;if(key===lastProgress)return;lastProgress=key;await report(progress);
 }
 function poll(){if(polling)return;polling=pollProgress().catch(error=>{progressError??=error}).finally(()=>{polling=null})}
 let child,exitCode;const timer=setInterval(poll,1000);
 try{
  exitCode=await new Promise((ok,reject)=>{
   child=spawn(adapter.file,adapter.args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WSL_CONSOLE_JOB_ID:binding.jobId,WSL_CONSOLE_ATTEMPT_ID:binding.attemptId,WSL_CONSOLE_DEVICE_ID:binding.deviceId,WSL_CONSOLE_INPUT_DIGEST:binding.inputDigest}});
   for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{stream.pause();logTail=logTail.then(async()=>{try{if(!logError)await appendFile(log,chunk)}catch(error){logError=error}finally{stream.resume()}})});
   child.once('error',reject);child.once('close',code=>ok(code));poll();
  });
 }catch(error){if(!child?.pid)return wait('执行器启动器不可用，项目命令尚未启动');throw error}
 finally{clearInterval(timer);if(polling)await polling;await logTail;}
 if(logError)throw Error('EXECUTION_LOG_WRITE_FAILED');if(progressError)throw progressError;
 let receipt;try{receipt=await readReceipt(adapter.receiptFile)}catch{throw Error('EXECUTION_RESULT_UNKNOWN')}
 const result=validateExecutionReceipt(receipt,{...binding,started,receivedAt:Date.now()},exitCode);
 if(!await verifyInputs(job.inputs))throw Error('EXECUTION_INPUTS_CHANGED');
 return result.commandStarted===false?result:{...result,receiptFile:adapter.receiptFile};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),watch=args.includes('--watch'),configPath=args.find(arg=>!arg.startsWith('--'));
 if(!configPath||args.some(arg=>arg.startsWith('--')&&!['--watch','--once'].includes(arg)))throw Error('Use: node run-queue.mjs private-config.json [--once|--watch]');
 const config=JSON.parse(await readFile(resolve(configPath),'utf8'));
 if(!config.queueRoot||!config.devicesRoot||!Array.isArray(config.devices))throw Error('QUEUE_CONFIG_INVALID');
 const queueRoot=resolve(config.queueRoot);await mkdir(queueRoot,{recursive:true});let stopped=false;
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true});
 const inFlight=new Map(),reserved=new Map(),readErrors=new Map(),lastResults=new Map();
 do{
  const {devices}=await readDevices({...config,runsRoot:join(queueRoot,'unused-runs')});
  for(const device of devices)if(reserved.has(device.id))device.workload='executing';
  const entries=await readdir(queueRoot,{withFileTypes:true});
  for(const entry of entries){
   if(stopped)break;
   if(!entry.isDirectory()||!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(entry.name)||inFlight.has(entry.name))continue;
   const directory=join(queueRoot,entry.name);let job;try{({job}=await readQueueManifest(join(directory,'job.json'),entry.name));readErrors.delete(entry.name)}catch(error){if(readErrors.get(entry.name)!==error.message){readErrors.set(entry.name,error.message);console.error(JSON.stringify({job:entry.name,error:error.message}))}continue}
   if(job.approved!==true||job.status!=='queued'||job.recoveryRequired||job.executionRoute==='github-actions')continue;
   const choice=chooseExecutionDevice(job,devices,{now:Date.now()});
   const reservation=choice.route==='device'?reserveDevice(reserved,choice.deviceId,entry.name):null;if(choice.route==='device'&&!reservation)continue;
   if(reservation){const device=devices.find(item=>item.id===reservation.deviceId);if(device)device.workload='executing';}
   const running=dispatchQueuedJob(queueRoot,entry.name,devices.map(device=>reservation&&device.id===reservation.deviceId?{...device,workload:'idle'}:device),(current,device,report)=>executePreparedJob(current,device,directory,report)).then(result=>{const key=JSON.stringify([result.route,result.status,result.deviceId,result.reason,result.result?.runId,result.recoveryRequired]);if(lastResults.get(entry.name)!==key){lastResults.set(entry.name,key);console.log(JSON.stringify({job:entry.name,result}))}}).catch(error=>{const key='error:'+error.message;if(lastResults.get(entry.name)!==key){lastResults.set(entry.name,key);console.error(JSON.stringify({job:entry.name,error:error.message}))}}).finally(()=>{if(inFlight.get(entry.name)===running)inFlight.delete(entry.name);releaseDevice(reserved,reservation)});
   inFlight.set(entry.name,running);
  }
  if(!watch||stopped)break;
  await new Promise(ok=>setTimeout(ok,5000));
 }while(!stopped);
 await Promise.all(inFlight.values());
}
