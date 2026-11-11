import {lstat,realpath,readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {resolve,dirname,join,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {timestamp} from './state.mjs';

export const HISTORY_DAYS=30;
export const HISTORY_CHECK_INTERVAL=60*60*1000;
const terminal=new Set(['passed','failed','blocked','cancelled','interrupted']);
const identifier=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);
const hasReferences=value=>Array.isArray(value)?value.length>0:value&&typeof value==='object'?Object.keys(value).length>0:!!value;
const protectedRecord=record=>!!(record.retain||record.protected||record.retention?.keep||hasReferences(record.recoveryRefs));

function finishedTime(record,now){
 const ended=timestamp(record?.finishedAt);if(ended===null||ended>now)return null;
 if(record.startedAt!==undefined){const started=timestamp(record.startedAt);if(started===null||started>ended)return null;}
 return record.finished===true&&(!record.status||terminal.has(record.status))&&Array.isArray(record.steps)&&record.steps.length>0&&record.steps.every(step=>step&&terminal.has(step.status))?ended:null;
}
export function isExpiredHistory(record,now=Date.now(),{references=[],id=record?.id,directory,aliases=[]}={}){
 const ended=finishedTime(record,now);
 return ended!==null&&!protectedRecord(record)&&!referencesRun(references,{id,directory,aliases})&&ended<now-HISTORY_DAYS*86400000;
}

async function checkedRoot(root){
 const absolute=resolve(root),info=await lstat(absolute);
 if(!info.isDirectory()||info.isSymbolicLink()||await realpath(absolute)!==absolute)throw Error('RETENTION_ROOT_NOT_CANONICAL');
 return absolute;
}

async function inspect(root,id){
 const directory=join(root,id),info=await lstat(directory);
 if(!identifier(id)||dirname(directory)!==root||!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)return {reason:'UNRECOGNIZED_DIRECTORY'};
 const metadata=join(directory,'run.json'),metaInfo=await lstat(metadata);
 if(!metaInfo.isFile()||metaInfo.isSymbolicLink()||metaInfo.size>1048576)return {reason:'UNRECOGNIZED_METADATA'};
 const text=await readFile(metadata,'utf8'),record=JSON.parse(text);
 if(!record||record.format!=='wsl-progress-v1'||record.id!==id||!Array.isArray(record.steps)||record.steps.some(step=>!step||!identifier(step.id))||new Set(record.steps.map(step=>step.id)).size!==record.steps.length)return {reason:'UNRECOGNIZED_RECORD'};
 return {record,text};
}

async function ownedFiles(root,id,record){
 const directory=join(root,id),entries=await readdir(directory);
 if(entries.some(name=>!['run.json','logs','work'].includes(name))||!entries.includes('logs'))return false;
 if(entries.includes('work')){const work=join(directory,'work'),info=await lstat(work);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(work)!==work)return false;}
 const logs=join(directory,'logs'),info=await lstat(logs);
 if(!info.isDirectory()||info.isSymbolicLink()||await realpath(logs)!==logs)return false;
 const names=new Set(record.steps.map(step=>step.id+'.log'));
 for(const name of await readdir(logs)){
  const info=await lstat(join(logs,name));
  if(!names.has(name)||!info.isFile()||info.isSymbolicLink())return false;
 }
 return true;
}

export function referenceStrings(value){
 if(typeof value==='string')return [value];
 if(value&&typeof value==='object')return Object.values(value).flatMap(referenceStrings);
 return [];
}
export function referencesRun(references,{id,directory,aliases=[]}={}){
 const ids=[id,...aliases].filter(value=>typeof value==='string');
 return references.some(value=>typeof value==='string'&&(ids.includes(value)||directory&&(value===directory||value.startsWith(directory+sep))));
}

export async function pruneHistory(config,{now=Date.now(),dryRun=false}={}){
 if(!Number.isFinite(now))throw Error('RETENTION_TIME_INVALID');
 const root=await checkedRoot(config.runsRoot),result={format:'wsl-history-retention-v1',checkedAt:new Date(now).toISOString(),retentionDays:HISTORY_DAYS,status:'completed',dryRun,removed:[],wouldRemove:[],cleanedWork:[],wouldCleanWork:[],retained:[],errors:[]},records=[];
 for(const entry of await readdir(root,{withFileTypes:true})){
  try{
   const item=await inspect(root,entry.name);
   if(item.record)records.push({id:entry.name,...item});else result.retained.push({id:entry.name,reason:item.reason});
  }catch(error){result.retained.push({id:entry.name,reason:'UNREADABLE_RECORD'});result.errors.push({id:entry.name,code:error.code||'INVALID_JSON'});}
 }
 const references=records.flatMap(item=>referenceStrings(item.record.recoveryRefs));
 const configured=await Promise.all((config.sources||[]).flatMap(source=>[source.progressFile,source.logsRoot,source.manifestFile].filter(Boolean).map(async path=>{const absolute=resolve(path);return realpath(absolute).catch(error=>{if(error.code==='ENOENT')return absolute;throw error})})));
 for(const item of records){
  const directory=join(root,item.id),retain=reason=>result.retained.push({id:item.id,reason});
  const ended=finishedTime(item.record,now),expired=isExpiredHistory(item.record,now),successful=item.record.status==='passed'&&item.record.steps.every(step=>step.status==='passed'&&step.exitCode===0&&(step.tests?.fail??0)===0);
  if(ended===null||protectedRecord(item.record)||(!expired&&!successful)){retain('ACTIVE_RECENT_OR_PROTECTED');continue;}
  if(referencesRun(references,{id:item.id,directory})){retain('RECOVERY_REFERENCE');continue;}
  if(configured.some(path=>path===directory||path.startsWith(directory+sep)||directory.startsWith(path+sep))){retain('CONFIGURED_SOURCE');continue;}
  try{
   if(!await ownedFiles(root,item.id,item.record)){retain('UNKNOWN_FILES');continue;}
   // Finished reporter records are immutable. Re-read before removal to catch concurrent changes.
   if(await checkedRoot(root)!==root)throw Error('RETENTION_ROOT_CHANGED');
   const current=await inspect(root,item.id);
   if(current.text!==item.text||finishedTime(current.record,now)===null){retain('RECORD_CHANGED');continue;}
   if(!await ownedFiles(root,item.id,current.record)){retain('FILES_CHANGED');continue;}
   if(expired){if(dryRun)result.wouldRemove.push(item.id);else{await rm(directory,{recursive:true});result.removed.push(item.id);}}
   else{
    const work=join(directory,'work'),info=await lstat(work).catch(error=>{if(error.code==='ENOENT')return null;throw error});
    if(info){if(!info.isDirectory()||info.isSymbolicLink()||await realpath(work)!==work)throw Error('WORK_PATH_CHANGED');if(dryRun)result.wouldCleanWork.push(item.id);else{await rm(work,{recursive:true});result.cleanedWork.push(item.id);}}
    retain('HISTORY_WITHIN_RETENTION');
   }
  }catch(error){result.errors.push({id:item.id,code:error.code||error.message});}
 }
 if(result.errors.length)result.status='partial';
 return result;
}

async function receipt(config,result){
 const root=await checkedRoot(config.runsRoot),parent=dirname(root),target=join(parent,'retention-last.json'),temporary=join(parent,'.retention-'+randomUUID()+'.tmp');
 const existing=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error});
 if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw Error('RETENTION_RECEIPT_NOT_REGULAR');
 if(existing){let previous;try{previous=JSON.parse(await readFile(target,'utf8'))}catch{throw Error('RETENTION_RECEIPT_UNRECOGNIZED')}if(previous?.format!=='wsl-history-retention-v1')throw Error('RETENTION_RECEIPT_UNRECOGNIZED');}
 try{await writeFile(temporary,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,target)}finally{await rm(temporary,{force:true})}
}

export function startHistoryMaintenance(config,{intervalMs=HISTORY_CHECK_INTERVAL,onError=error=>console.error('History retention failed: '+error.message)}={}){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<1)throw Error('RETENTION_INTERVAL_INVALID');
 let pending;
 const check=()=>{
  if(pending)return pending;
  pending=(async()=>{let begun=false;try{
   await receipt(config,{format:'wsl-history-retention-v1',checkedAt:new Date().toISOString(),retentionDays:HISTORY_DAYS,status:'running'});begun=true;
   const result=await pruneHistory(config);await receipt(config,result);if(result.errors.length)onError(Error('RETENTION_PARTIAL: '+result.errors.map(item=>item.id+':'+item.code).join(', ')));return result;
  }catch(error){const result={format:'wsl-history-retention-v1',checkedAt:new Date().toISOString(),retentionDays:HISTORY_DAYS,status:'failed',error:error.message};if(begun)await receipt(config,result).catch(onError);onError(error);return result;}})();
  const current=pending;void current.finally(()=>{if(pending===current)pending=null});return current;
 };
 const ready=check(),timer=setInterval(check,intervalMs);timer.unref();
 return {ready,check,async stop(){clearInterval(timer);await pending}};
}
