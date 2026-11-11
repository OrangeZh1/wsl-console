import {readFile} from 'node:fs/promises';
import {cpus,loadavg,platform} from 'node:os';

export function memoryFromProc(text){
 const fields=Object.fromEntries([...text.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB$/gm)].map(([,name,value])=>[name,Number(value)*1024]));
 const range=(total,available)=>Number.isSafeInteger(total)&&Number.isSafeInteger(available)&&total>=0&&available>=0&&available<=total?{totalBytes:total,availableBytes:available,usedBytes:total-available}:null;
 return {memory:range(fields.MemTotal,fields.MemAvailable),swap:range(fields.SwapTotal,fields.SwapFree)};
}

export async function readResources(){
 let memory=null,swap=null,cpu=null;
 if(platform()==='linux'){
  try{({memory,swap}=memoryFromProc(await readFile('/proc/meminfo','utf8')))}catch{}
  try{const logicalProcessors=cpus().length,load1=loadavg()[0];if(logicalProcessors>0&&Number.isFinite(load1)&&load1>=0)cpu={logicalProcessors,load1}}catch{}
 }
 return {status:memory&&swap&&cpu?'available':memory||swap||cpu?'partial':'unavailable',sampledAt:new Date().toISOString(),platform:platform(),memory,swap,cpu};
}
