export const RUN_STATES=Object.freeze(['queued','running','passed','failed','blocked','cancelled','interrupted']);
export const TERMINAL_STATES=Object.freeze(['passed','failed','blocked','cancelled','interrupted']);
const states=new Set(RUN_STATES),terminal=new Set(TERMINAL_STATES);
export const validState=value=>states.has(value);
export const terminalState=value=>terminal.has(value);

export function timestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
 const calendar=Date.parse(value.slice(0,19)+'Z'),parsed=Date.parse(value);
 return Number.isFinite(calendar)&&new Date(calendar).toISOString().slice(0,19)===value.slice(0,19)&&Number.isFinite(parsed)?parsed:null;
}

// Both the writer and reader use the same result precedence. A retained terminal
// kind is not silently changed into "blocked" while crossing the HTTP boundary.
export function aggregateRunStatus(record){
 const steps=record.steps||[],pending=steps.some(step=>!terminal.has(step.status));
 if(!record.finished&&steps.some(step=>step.status==='running'))return 'running';
 for(const status of ['failed','interrupted','cancelled','blocked'])if(steps.some(step=>step.status===status))return status;
 if(record.finished===true&&['failed','interrupted','cancelled','blocked'].includes(record.status))return record.status;
 const successful=record.finished===true&&steps.length>0&&!pending&&steps.every(step=>step.status==='passed'&&(step.tests?.fail??0)===0&&(step.exitCode===0||(!record.format&&step.exitCode===undefined&&!step.command?.length&&!step.tests)));
 if(record.finished||record.status==='passed')return successful?'passed':'blocked';
 if(validState(record.status))return record.status;
 return record.startedAt?'running':'queued';
}
