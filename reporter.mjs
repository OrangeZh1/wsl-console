import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {captureHost,normalizeHost} from './host.mjs';

const valid=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);
const now=()=>new Date().toISOString();
const states=new Set(['queued','running','passed','failed','blocked','cancelled','interrupted']);

// One reporter owns a run's metadata; parallel steps share this serialized writer.
// Execution and process control remain the caller's responsibility.
export async function createReporter(root,definition){
 if(!valid(definition.id)||!Array.isArray(definition.steps)||!definition.steps.length||definition.steps.some(step=>!valid(step.id))||new Set(definition.steps.map(step=>step.id)).size!==definition.steps.length)throw Error('RUN_DEFINITION_INVALID');
 if(definition.queuePosition!==undefined&&(!Number.isSafeInteger(definition.queuePosition)||definition.queuePosition<1))throw Error('QUEUE_POSITION_INVALID');
 if(definition.taskKey!==undefined&&(typeof definition.taskKey!=='string'||!definition.taskKey.trim()||definition.taskKey.length>160))throw Error('TASK_KEY_INVALID');
 const executor=definition.executor===undefined?captureHost():normalizeHost(definition.executor);if(!executor)throw Error('EXECUTOR_INVALID');
 const directory=join(resolve(root),definition.id);await mkdir(resolve(root),{recursive:true});await mkdir(directory);await mkdir(join(directory,'logs'));
 let record={...definition,executor,format:'wsl-progress-v1',status:'queued',enqueuedAt:definition.enqueuedAt||now(),updatedAt:now(),finished:false,steps:definition.steps.map(step=>({...step,status:'queued'}))},tail=Promise.resolve();
 delete record.startedAt;delete record.finishedAt;
 async function persist(){record.updatedAt=now();const temporary=join(directory,'run.json.tmp');await writeFile(temporary,JSON.stringify(record,null,2)+'\n');await rename(temporary,join(directory,'run.json'));}
 const change=operation=>{const task=tail.then(operation);tail=task.catch(()=>{});return task};
 await persist();
 return {
  workDirectory:join(directory,'work'),
  heartbeat(){return change(async()=>{if(record.finished)throw Error('RUN_ALREADY_FINISHED');record.heartbeatAt=now();await persist();})},
  activity(id,message){return change(async()=>{const step=record.steps.find(step=>step.id===id);if(record.finished||step?.status!=='running')throw Error('ACTIVITY_REQUIRES_RUNNING_STEP');if(typeof message!=='string'||!message.trim()||message.length>2000)throw Error('ACTIVITY_MESSAGE_INVALID');step.activity=message.trim();step.activityUpdatedAt=now();await persist();})},
  queue(patch={}){return change(async()=>{if(record.startedAt||record.finished)throw Error('RUN_ALREADY_STARTED');if(patch.queuePosition!==undefined&&(!Number.isSafeInteger(patch.queuePosition)||patch.queuePosition<1))throw Error('QUEUE_POSITION_INVALID');if(patch.queuePosition===undefined)delete record.queuePosition;else record.queuePosition=patch.queuePosition;await persist();})},
  step(id,patch){return change(async()=>{const step=record.steps.find(step=>step.id===id);if(!step||!states.has(patch.status))throw Error('STEP_UPDATE_INVALID');if(record.finished)throw Error('RUN_ALREADY_FINISHED');if(patch.status==='passed'&&(patch.exitCode!==0||(patch.tests?.fail??0)!==0||(step.tests?.fail??0)!==0&&!patch.tests))throw Error('PASSED_STEP_REQUIRES_SUCCESS');const continuing=step.status==='running'&&patch.status==='running',startedAt=continuing&&step.startedAt?step.startedAt:patch.startedAt||now();if(patch.status==='running'&&['passed','failed','blocked','cancelled','interrupted'].includes(step.status)){const {attempts,...previous}=step;step.attempts=[...(attempts||[]),previous];}Object.assign(step,patch,{id});if(patch.status==='running'){step.startedAt=startedAt;if(!continuing)for(const key of ['error','tests','activity','activityUpdatedAt'])if(!(key in patch))delete step[key];for(const key of ['finishedAt','seconds','exitCode'])delete step[key];record.startedAt??=step.startedAt;record.status='running';delete record.queuePosition;}if(['passed','failed','blocked','cancelled','interrupted'].includes(patch.status)){step.finishedAt=now();if(step.startedAt)step.seconds=(Date.parse(step.finishedAt)-Date.parse(step.startedAt))/1000}await persist();})},
  async log(id,text){if(!record.steps.some(step=>step.id===id))throw Error('STEP_NOT_FOUND');await appendFile(join(directory,'logs',id+'.log'),String(text));},
  finish(){return change(async()=>{if(record.steps.some(step=>['running','queued'].includes(step.status)))throw Error('STEP_STILL_RUNNING_OR_QUEUED');record.finished=true;record.finishedAt=now();record.status=record.steps.every(step=>step.status==='passed')?'passed':record.steps.find(step=>step.status!=='passed').status;delete record.queuePosition;await persist();})},
  async snapshot(){await tail;return JSON.parse(await readFile(join(directory,'run.json'),'utf8'));}
 };
}
