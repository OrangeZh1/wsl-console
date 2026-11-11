import {hostname,platform} from 'node:os';

const sources=new Set(['sampled','reported','configured','manual']);
const text=(value,max=160)=>typeof value==='string'&&value.trim().length<=max&&!/[\u0000-\u001f\u007f]/u.test(value)?value.trim()||undefined:undefined;

// Host identity is a snapshot supplied by the executor, never a guess about old runs.
export function normalizeHost(value,source='reported'){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const host={};for(const key of ['id','name','hostname','computerName','platform','distro']){const field=text(value[key]);if(field)host[key]=field;}
 if(!host.name&&!host.hostname&&!host.computerName)return null;
 host.source=source==='configured'?'configured':sources.has(value.source)?value.source:source;
 const observed=text(value.observedAt,64);if(observed&&Number.isFinite(Date.parse(observed)))host.observedAt=new Date(observed).toISOString();
 return host;
}

export function captureHost(overrides={}){
 const machine=hostname(),computerName=process.env.WSL_CONSOLE_WINDOWS_HOST||(platform()==='win32'?machine:undefined);
 return normalizeHost({...overrides,id:overrides.id||computerName||machine,name:overrides.name||computerName||machine,hostname:machine,computerName,platform:platform(),distro:process.env.WSL_DISTRO_NAME,source:'sampled',observedAt:new Date().toISOString()},'sampled');
}
