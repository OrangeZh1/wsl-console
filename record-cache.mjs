import {open} from 'node:fs/promises';
import {resolve} from 'node:path';

const signature=info=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
// The byte bound counts UTF-8 source bytes, not an assertion about total JS heap.
export function createRecordCache({maxBytes=16*1024*1024,maxEntries=2048,openFile=open}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>4096)throw Error('RECORD_CACHE_LIMIT_INVALID');
 const entries=new Map();let bytes=0,hits=0,misses=0,reads=0,evictions=0;
 function discard(file){const old=entries.get(file);if(old){entries.delete(file);bytes-=old.bytes;}}
 return {
  async read(file){
   file=resolve(file);const handle=await openFile(file,'r');
   try{
    const info=await handle.stat({bigint:true});if(!info.isFile()||info.size>1048576n)throw Error('RUN_METADATA_NOT_REGULAR_OR_TOO_LARGE');
    const key=signature(info),cached=entries.get(file);
    if(cached?.key===key){hits++;entries.delete(file);entries.set(file,cached);return cached.value;}
    misses++;discard(file);const text=await handle.readFile('utf8');reads++;
    if(signature(await handle.stat({bigint:true}))!==key)throw Error('RUN_METADATA_CHANGED_DURING_READ');
    let value;try{value=JSON.parse(text)}catch{throw Error('RUN_METADATA_INVALID_JSON')}
    const size=Buffer.byteLength(text);if(size<=maxBytes){discard(file);entries.set(file,{key,value,bytes:size});bytes+=size;while(entries.size>maxEntries||bytes>maxBytes){discard(entries.keys().next().value);evictions++;}}
    return value;
   }finally{await handle.close()}
  },
  stats(){return {entries:entries.size,sourceBytes:bytes,maxSourceBytes:maxBytes,maxEntries,hits,misses,reads,evictions};}
 };
}
