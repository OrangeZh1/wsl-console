import {lstat,realpath,open} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';

const identifier=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);
const missing='执行端未上报具体失败原因';
const clean=text=>text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r(?!\n)/g,'\n');
const errorLine=line=>!/^\s*(?:[#ℹ]\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration)|(?:Test Files|Tests)\s+\d)/i.test(line)&&/(?:\b(?:error|exception|fatal|panic|failed|failure|timed\s+out|timeout)\b|curl:\s*\(\d+\)|\bERR_[A-Z_\d]+|错误|失败|异常|超时)/i.test(line);

async function tail(logsRoot,id){
 if(!identifier(id))throw Object.assign(Error('Invalid stage'),{code:'FAILURE_LOG_FORBIDDEN'});
 const root=await realpath(resolve(logsRoot)),file=join(root,id+'.log'),info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink())throw Object.assign(Error('Log is not a regular file'),{code:'FAILURE_LOG_FORBIDDEN'});
 const actual=await realpath(file);if(!actual.startsWith(root+sep))throw Object.assign(Error('Log path escapes root'),{code:'FAILURE_LOG_FORBIDDEN'});
 const handle=await open(actual,'r');
 try{
  const current=await handle.stat();if(!current.isFile()||current.dev!==info.dev||current.ino!==info.ino)throw Object.assign(Error('Log changed'),{code:'FAILURE_LOG_FORBIDDEN'});
  const start=Math.max(0,current.size-32768),bytes=Buffer.alloc(current.size-start),{bytesRead}=await handle.read(bytes,0,bytes.length,start);
  let text=bytes.subarray(0,bytesRead).toString('utf8');if(start>0)text=text.includes('\n')?text.slice(text.indexOf('\n')+1):'';
  return clean(text);
 }finally{await handle.close()}
}

export async function failureDetails(run,logsRoot){
 const failed=run.steps.filter(step=>step.status==='failed');
 const reportedFailure=(result,text,reportedBy)=>{const lines=clean(text).split('\n').filter(line=>line.trim()),excerpt=[lines[0].slice(2000),...lines.slice(1)].filter(Boolean).join('\n').slice(0,4000);return {...result,message:lines[0].slice(0,2000),source:'reported',reportedBy,...excerpt?{excerpt}:{}}};
 const report=text=>typeof text==='string'&&clean(text).trim()?text:undefined;
 if(!failed.length)return run.status==='failed'?[report(run.error)?reportedFailure({stepId:null,label:'任务'},run.error,'run'):{stepId:null,label:'任务',message:missing,source:'missing'}]:[];
 return Promise.all(failed.map(async step=>{
  const result={stepId:step.id,label:step.label,exitCode:step.exitCode};
  const reported=report(step.error)||(failed.length===1?report(run.error):undefined);
  if(reported)return reportedFailure(result,reported,report(step.error)?'stage':'run');
  try{
   const text=await tail(logsRoot,step.id),lines=text.split('\n').map(line=>line.trimEnd()).filter(line=>line.trim());
   const errors=lines.filter(errorLine),specific=errors.filter(line=>!/ELIFECYCLE|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL|Command failed with exit code/i.test(line));
   const message=specific.at(-1)||errors.at(-1);
   return {...result,message:message||missing,source:message?'log':'missing',logStatus:'read',...lines.length?{excerpt:lines.slice(-12).join('\n').slice(-4000)}:{}};
  }catch(error){
   const status=error.code==='ENOENT'?'missing':error.code==='FAILURE_LOG_FORBIDDEN'?'forbidden':'unreadable';
   return {...result,message:missing,source:'missing',logStatus:status,logError:error.code||'LOG_READ_FAILED'};
  }
 }));
}
