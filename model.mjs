import {normalizeHost} from './host.mjs';
import {aggregateRunStatus,timestamp,validState} from './state.mjs';

export const identifier=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
function text(value,key,max=20000){if(value===undefined||value===null)return undefined;if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw Error('RUN_'+key.toUpperCase()+'_INVALID');return value;}
function date(value,key){if(value===undefined||value===null||value==='')return undefined;if(timestamp(value)===null)throw Error('RUN_'+key.toUpperCase()+'_INVALID');return value;}
function list(value,key,normalize,max=1000){if(value===undefined||value===null)return [];if(!Array.isArray(value)||value.length>max)throw Error('RUN_'+key.toUpperCase()+'_INVALID');return value.map(normalize);}
const compact=value=>Object.fromEntries(Object.entries(value).filter(([,entry])=>entry!==undefined));

export function normalizeReusedFrom(value){
 if(value===undefined||value===null)return undefined;
 if(typeof value==='string')value={runId:value};
 if(!object(value)||!identifier(value.runId)||value.stepId!==undefined&&!identifier(value.stepId))throw Error('RUN_REUSE_SOURCE_INVALID');
 return compact({runId:value.runId,stepId:value.stepId});
}
export function normalizeSourceCi(value){
 if(value===undefined||value===null)return undefined;if(!object(value))throw Error('RUN_CI_SOURCE_INVALID');
 const result={provider:'github-actions'};
 if(value.provider!==undefined&&value.provider!=='github-actions')throw Error('RUN_CI_PROVIDER_INVALID');
 if(value.url!==undefined){let url;try{url=new URL(value.url)}catch{throw Error('RUN_CI_URL_INVALID')};const match=url.pathname.match(/^\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/actions\/runs\/(\d+)\/?$/i);if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||!match)throw Error('RUN_CI_URL_INVALID');result.url=url.origin+url.pathname;result.runId=match[1];}
 if(value.runId!==undefined){const runId=String(value.runId);if(!/^\d{1,30}$/.test(runId)||result.runId&&result.runId!==runId)throw Error('RUN_CI_ID_INVALID');result.runId=runId;}
 if(value.headSha!==undefined){if(typeof value.headSha!=='string'||!/^[a-f0-9]{7,64}$/i.test(value.headSha))throw Error('RUN_CI_COMMIT_INVALID');result.headSha=value.headSha;}
 if(value.status!==undefined){if(!['queued','in_progress','completed','requested','waiting','pending'].includes(value.status))throw Error('RUN_CI_STATUS_INVALID');result.status=value.status;}
 if(value.conclusion!==undefined&&value.conclusion!==null&&value.conclusion!==''){if(!['success','failure','cancelled','skipped','timed_out','action_required','neutral','stale','startup_failure'].includes(value.conclusion))throw Error('RUN_CI_CONCLUSION_INVALID');result.conclusion=value.conclusion;}
 for(const key of ['observedAt','updatedAt'])if(value[key]!==undefined)result[key]=date(value[key],key);
 return result;
}
export function normalizeRecoveryRefs(value){
 return list(value,'recovery_refs',item=>{if(typeof item==='string')return text(item,'recovery_ref',4096);if(!object(item))throw Error('RUN_RECOVERY_REF_INVALID');const result={};for(const key of ['runId','stepId'])if(item[key]!==undefined){if(!identifier(item[key]))throw Error('RUN_RECOVERY_REF_INVALID');result[key]=item[key];}for(const key of ['path','reason','kind'])if(item[key]!==undefined)result[key]=text(item[key],key,key==='path'?4096:2000);return result;},1000);
}
export function normalizeTests(value){
 if(value===undefined||value===null)return undefined;if(!object(value))throw Error('RUN_TESTS_INVALID');const result={};for(const key of ['pass','fail','skipped']){const count=value[key]??0;if(!Number.isSafeInteger(count)||count<0)throw Error('RUN_TESTS_INVALID');result[key]=count;}return result;
}
export function normalizeVersions(value){
 return list(value,'versions',item=>{if(!object(item))throw Error('RUN_VERSION_INVALID');return compact({name:text(item.name,'version_name',300)||'未命名来源',branch:text(item.branch,'version_branch',300),head:text(item.head,'version_head',300),sha256:text(item.sha256,'version_digest',300)});},100);
}
function step(value,{attempt=false,id}={}){
 if(!object(value)||!identifier(value.id??id)||(!attempt||value.status!==undefined)&&!validState(value.status))throw Error('RUN_STEP_INVALID');
 const command=value.command===undefined||value.command===null?[]:typeof value.command==='string'?[text(value.command,'command',65536)]:list(value.command,'command',arg=>{if(typeof arg!=='string')throw Error('RUN_COMMAND_INVALID');return text(arg,'command',32768);},256);
 const result=compact({id:value.id??id,label:text(value.label,'label',1000)||value.id||id,detail:text(value.detail,'detail'),status:value.status,command,tests:normalizeTests(value.tests),activity:text(value.activity,'activity',4000),error:text(value.error,'error',40000),executor:Object.hasOwn(value,'executor')?normalizeHost(value.executor):undefined,controller:Object.hasOwn(value,'controller')?normalizeHost(value.controller):undefined,reusedFrom:normalizeReusedFrom(value.reusedFrom)});
 for(const key of ['startedAt','finishedAt','activityUpdatedAt','heartbeatAt'])if(value[key]!==undefined)result[key]=date(value[key],key);
 if(value.seconds!==undefined&&value.seconds!==null){if(!Number.isFinite(value.seconds)||value.seconds<0)throw Error('RUN_SECONDS_INVALID');result.seconds=value.seconds;}
 if(value.exitCode!==undefined){if(value.exitCode!==null&&!Number.isSafeInteger(value.exitCode))throw Error('RUN_EXIT_CODE_INVALID');result.exitCode=value.exitCode;}
 if(!attempt&&value.attempts!==undefined)result.attempts=list(value.attempts,'attempts',entry=>step(entry,{attempt:true,id:result.id}),1000);
 if(!attempt&&['running','queued'].includes(result.status)){for(const key of ['finishedAt','seconds','exitCode'])delete result[key];if(result.status==='queued'){for(const key of ['startedAt','tests','error','activity','activityUpdatedAt','heartbeatAt'])delete result[key];result.command=[];}}
 return result;
}

export function normalizeRunRecord(record,source,{manifestVersions}={}){
 if(!object(record)||!Array.isArray(record.steps))throw Error('RUN_STEPS_INVALID');
 const steps=list(record.steps,'steps',entry=>step(entry),10000);if(new Set(steps.map(entry=>entry.id)).size!==steps.length)throw Error('RUN_STEPS_DUPLICATED');
 const versions=own(record,'versions')?normalizeVersions(record.versions):normalizeVersions(manifestVersions);
 const projects=list(record.projects??source.projects,'projects',value=>{if(typeof value!=='string')throw Error('RUN_PROJECTS_INVALID');return text(value,'project',300);},100);
 const taskKey=text(record.taskKey??source.taskKey,'task_key',160)?.trim()||undefined;
 const run=compact({id:source.id,taskKey,format:text(record.format,'format',100),name:text(record.name??source.name,'name',1000)||source.id,projects,environment:text(record.environment??source.environment,'environment',2000)||'WSL Linux',status:validState(record.status)?record.status:undefined,finished:record.finished===true,versions,steps,executor:record.executor===undefined?normalizeHost(source.executor,'configured'):normalizeHost(record.executor),controller:normalizeHost(record.controller),sourceCi:normalizeSourceCi(record.sourceCi),recoveryRefs:record.recoveryRefs===undefined?undefined:normalizeRecoveryRefs(record.recoveryRefs),error:text(record.error,'error',40000)});
 for(const key of ['enqueuedAt','startedAt','updatedAt','heartbeatAt','finishedAt'])if(record[key]!==undefined)run[key]=date(record[key],key);
 const starts=steps.flatMap(entry=>[entry.startedAt,...(entry.attempts||[]).map(item=>item.startedAt)]).filter(Boolean).sort();run.startedAt??=starts[0];
 if(record.queueReason!==undefined){const reason=text(record.queueReason,'queue_reason',4000)?.trim();if(reason)run.queueReason=reason;}
 if(record.plannedDeviceId!==undefined){if(!identifier(record.plannedDeviceId))throw Error('RUN_PLANNED_DEVICE_INVALID');run.plannedDeviceId=record.plannedDeviceId;}
 if(record.plannedExecutor!==undefined)run.plannedExecutor=normalizeHost(record.plannedExecutor);
 run.status=aggregateRunStatus(run);
 if(run.status==='queued'){delete run.startedAt;delete run.finishedAt;if(Number.isSafeInteger(record.queuePosition)&&record.queuePosition>0)run.queuePosition=record.queuePosition;}
 return run;
}
