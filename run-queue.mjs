import {spawn} from 'node:child_process';
import {readFile,readdir,mkdir,appendFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readDevices} from './devices.mjs';
import {chooseExecutionDevice,dispatchQueuedJob} from './dispatch.mjs';

// Commands and inputs must already be prepared and authorized by the project's executor.
// This adapter neither copies project state nor decides what a business task may do.
export async function executePreparedJob(job,device,directory){
 const adapter=job.executors?.[device.id];
 if(!adapter||adapter.admissionEnforced!==true||adapter.lockEnforced!==true||!Array.isArray(adapter.args)||typeof adapter.file!=='string'||typeof adapter.receiptFile!=='string')return {status:'queued',reason:'目标设备尚无具备资源准入与统一flock的已准备执行器'};
 if(!Array.isArray(job.inputs)||!job.inputs.length)return {status:'queued',reason:'缺少不可变输入摘要'};
 for(const input of job.inputs){
  if(typeof input.path!=='string'||!/^[a-f0-9]{64}$/i.test(input.sha256||''))throw Error('PREPARED_INPUT_INVALID');
  if((await stat(input.path)).size>16*1024*1024)throw Error('PREPARED_INPUT_TOO_LARGE');
  if(createHash('sha256').update(await readFile(input.path)).digest('hex')!==input.sha256.toLowerCase())return {status:'queued',reason:'已准备输入发生变化，等待执行端重新冻结'};
 }
 const started=Date.now(),log=join(directory,'executor.log');await appendFile(log,new Date(started).toISOString()+' device='+device.id+'\n');
 let logTail=Promise.resolve();
 const exitCode=await new Promise((ok,reject)=>{
  const child=spawn(adapter.file,adapter.args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logTail=logTail.then(()=>appendFile(log,chunk))});
  child.once('error',reject);child.once('close',code=>ok(code));
 });
 await logTail;
 let receipt;try{receipt=JSON.parse(await readFile(adapter.receiptFile,'utf8'))}catch{throw Error('EXECUTION_RESULT_UNKNOWN')}
 if(receipt.dispatchJobId!==job.id||receipt.finished!==true||!['passed','failed','blocked','interrupted','cancelled'].includes(receipt.status)||!receipt.startedAt||Date.parse(receipt.startedAt)<started-60000)throw Error('EXECUTION_RECEIPT_MISMATCH');
 if(exitCode!==0&&receipt.status==='passed')throw Error('EXECUTION_EXIT_RECEIPT_CONFLICT');
 return {status:receipt.status,runId:receipt.id,receiptFile:adapter.receiptFile,exitCode,finishedAt:receipt.finishedAt};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),watch=args.includes('--watch'),configPath=args.find(arg=>!arg.startsWith('--'));
 if(!configPath||args.some(arg=>arg.startsWith('--')&&!['--watch','--once'].includes(arg)))throw Error('Use: node run-queue.mjs private-config.json [--once|--watch]');
 const config=JSON.parse(await readFile(resolve(configPath),'utf8'));
 if(!config.queueRoot||!config.devicesRoot||!Array.isArray(config.devices))throw Error('QUEUE_CONFIG_INVALID');
 const queueRoot=resolve(config.queueRoot);await mkdir(queueRoot,{recursive:true});let stopped=false;
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true});
 const inFlight=new Map(),reserved=new Set();
 do{
  const {devices}=await readDevices({...config,runsRoot:join(queueRoot,'unused-runs')});
  for(const device of devices)if(reserved.has(device.id))device.workload='executing';
  const entries=await readdir(queueRoot,{withFileTypes:true});
  for(const entry of entries){
   if(!entry.isDirectory()||!/^[-a-z0-9_]{1,80}$/i.test(entry.name)||inFlight.has(entry.name))continue;
   const directory=join(queueRoot,entry.name);let job;try{job=JSON.parse(await readFile(join(directory,'job.json'),'utf8'))}catch{continue}
   if(job.approved!==true||job.status!=='queued'||job.recoveryRequired)continue;
   const choice=chooseExecutionDevice(job,devices,{now:Date.now()});
   if(choice.route==='device'){reserved.add(choice.deviceId);const device=devices.find(item=>item.id===choice.deviceId);if(device)device.workload='executing';}
   const running=dispatchQueuedJob(queueRoot,entry.name,devices.map(device=>device.id===choice.deviceId?{...device,workload:'idle'}:device),(current,device)=>executePreparedJob(current,device,directory),{now:Date.now()}).then(result=>console.log(JSON.stringify({job:entry.name,result}))).catch(error=>{console.error(JSON.stringify({job:entry.name,error:error.message}))}).finally(()=>{inFlight.delete(entry.name);if(choice.deviceId)reserved.delete(choice.deviceId)});
   inFlight.set(entry.name,running);
  }
  if(!watch||stopped)break;
  await new Promise(ok=>setTimeout(ok,5000));
 }while(!stopped);
 await Promise.all(inFlight.values());
}
