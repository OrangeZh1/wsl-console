import http from 'node:http';
import {readFile,readdir,open,mkdir,realpath,lstat} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {isExpiredHistory,startHistoryMaintenance,referenceStrings} from './retention.mjs';
import {failureDetails} from './failure.mjs';
import {readResources} from './resources.mjs';
import {captureHost} from './host.mjs';
import {readDevices} from './devices.mjs';
import {normalizeRunRecord,identifier} from './model.mjs';
import {readAssetSnapshot,runtimeIdentity} from './identity.mjs';
import {createRecordCache} from './record-cache.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const viewerInstance=/^[a-f0-9-]{36}$/i.test(process.env.WSL_CONSOLE_INSTANCE_ID||'')?process.env.WSL_CONSOLE_INSTANCE_ID:randomUUID();
const json=async file=>JSON.parse(await readFile(file,'utf8'));
export function utf8ChunkLength(bytes,length=bytes.length){
 if(!length)return 0;let start=length-1;while(start>0&&(bytes[start]&0xc0)===0x80)start--;
 const lead=bytes[start],required=lead>=0xf0&&lead<=0xf4?4:lead>=0xe0&&lead<=0xef?3:lead>=0xc2&&lead<=0xdf?2:1;
 return length-start<required?start:length;
}
export function parseLogCursor(value,offset){
 if(value===null||value===undefined||value==='')return null;if(typeof value!=='string'||value.length>1024||!/^[a-z0-9_-]+$/i.test(value))throw Error('LOG_CURSOR_INVALID');
 let cursor;try{cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'))}catch{throw Error('LOG_CURSOR_INVALID')}
 if(!cursor||cursor.offset!==offset||!/^[a-f0-9]{24}$/.test(cursor.fileId||'')||!['prefix','boundary'].every(key=>/^[a-f0-9]{64}$/.test(cursor[key]||'')))throw Error('LOG_CURSOR_INVALID');return cursor;
}
async function cursorAt(handle,fileId,offset){
 const digest=async(start,size)=>{const bytes=Buffer.alloc(size),{bytesRead}=await handle.read(bytes,0,size,start);return createHash('sha256').update(bytes.subarray(0,bytesRead)).digest('hex')};
 return {fileId,offset,prefix:await digest(0,Math.min(64,offset)),boundary:await digest(Math.max(0,offset-64),Math.min(64,offset))};
}
export async function createViewer(config,{assetsRoot=root}={}){
 config=structuredClone(config);
 if(config.sources!==undefined&&(!Array.isArray(config.sources)||config.sources.some(source=>!source||!identifier(source.id)||typeof source.progressFile!=='string'||typeof source.logsRoot!=='string'||source.manifestFile!==undefined&&typeof source.manifestFile!=='string')||new Set(config.sources.map(source=>source.id)).size!==config.sources.length))throw Error('VIEWER_SOURCES_CONFIG_INVALID');
 const viewerHost=captureHost(config.host);
 const dataRoot=resolve(config.runsRoot);await mkdir(dataRoot,{recursive:true});
 const snapshot=await readAssetSnapshot(assetsRoot),identity=await runtimeIdentity(root,config,snapshot);
 const bounded=(value,fallback,ceiling)=>Number.isSafeInteger(value)&&value>0?Math.min(value,ceiling):fallback;
 const cache=createRecordCache({maxBytes:bounded(config.recordCacheMaxBytes,16*1024*1024,32*1024*1024),maxEntries:bounded(config.recordCacheMaxEntries,2048,4096)});
 async function sources(){
  const result=[...(config.sources||[])];
  for(const entry of await readdir(dataRoot,{withFileTypes:true}))if(entry.isDirectory()&&identifier(entry.name)&&!result.some(item=>item.id===entry.name))result.push({id:entry.name,managed:true,progressFile:join(dataRoot,entry.name,'run.json'),logsRoot:join(dataRoot,entry.name,'logs')});
  return result.filter(item=>identifier(item.id));
 }
 const blocked=(source,error)=>({id:source.id,name:typeof source.name==='string'?source.name:source.id,status:'blocked',recordUnavailable:true,error:'无法读取运行记录：'+(error.code||error.message),steps:[],versions:[],projects:Array.isArray(source.projects)?source.projects.filter(value=>typeof value==='string'):[]});
 async function entry(source){try{return {source,record:await cache.read(source.progressFile)}}catch(error){return {source,error}}}
 async function rawEntries(items){const result=[];for(const source of items)result.push(await entry(source));return result;}
 const referencesOf=entries=>entries.flatMap(item=>referenceStrings(item.record?.recoveryRefs));
 async function load(item,references=[]){
  const {source,record,error}=item;if(error)return blocked(source,error);
  try{
   if(source.managed&&record?.format==='wsl-progress-v1'&&record.id!==source.id)throw Error('RUN_ID_MISMATCH');
   let manifestVersions;
   if(record&&typeof record==='object'&&!Object.hasOwn(record,'versions')&&source.manifestFile){const manifest=await cache.read(source.manifestFile);if(!manifest?.repositories||typeof manifest.repositories!=='object'||Array.isArray(manifest.repositories))throw Error('RUN_MANIFEST_INVALID');manifestVersions=Object.entries(manifest.repositories).map(([name,repo])=>{if(!repo||typeof repo!=='object'||Array.isArray(repo))throw Error('RUN_MANIFEST_INVALID');return {name,branch:repo.branch,head:repo.head,sha256:repo.sha256}});}
   const run=normalizeRunRecord(record,source,{manifestVersions});
   if(isExpiredHistory(record,Date.now(),{references,id:source.id,aliases:[record.id],directory:dirname(resolve(source.progressFile))}))return null;
   return run;
  }catch(error){return blocked(source,error)}
 }
 async function find(id){if(!identifier(id))return null;return (await sources()).find(source=>source.id===id)||null;}
 async function one(source){const item=await entry(source);const references=isExpiredHistory(item.record)?referencesOf(await rawEntries(await sources())):[];return load(item,references);}
 const server=http.createServer(async(req,res)=>{
  const send=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'"});res.end(req.method==='HEAD'?undefined:type.startsWith('application/json')?JSON.stringify(value):value);};
  try{
   if(!['GET','HEAD'].includes(req.method))return send(405,{error:'READ_ONLY_VIEWER'});
   if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host||''))return send(403,{error:'LOCAL_ACCESS_ONLY'});
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/api/viewer')return send(200,{application:'wsl-console',pid:process.pid,instanceId:viewerInstance,platform:process.platform,host:viewerHost,capabilities:['devices-v1','state-observation-v2','log-availability-v1','frozen-assets-v1'],...identity,diagnostics:{records:cache.stats()}});
   if(url.pathname==='/api/diagnostics')return send(200,{...identity,records:cache.stats()});
   if(url.pathname==='/api/resources')return send(200,await readResources());
   if(snapshot.assets.has(url.pathname)){const {bytes,type}=snapshot.assets.get(url.pathname);return send(200,bytes,type);}
   if(url.pathname==='/api/runs'||url.pathname==='/api/devices'){
    const entries=await rawEntries(await sources()),references=referencesOf(entries),runs=[];for(const item of entries){const run=await load(item,references);if(run)runs.push(run)}
    runs.sort((a,b)=>String(b.startedAt||b.enqueuedAt||'').localeCompare(String(a.startedAt||a.enqueuedAt||'')));const {devices,unassignedRuns,runs:observed}=await readDevices(config,{runs,viewerHost,viewerResources:await readResources()});return send(200,{...(url.pathname==='/api/runs'?{runs:observed}:{}),readOnly:true,viewerHost,devices,unassignedRuns});
   }
   const failure=url.pathname.match(/^\/api\/runs\/([^/]+)\/failure$/);
   const match=failure||url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/steps\/([^/]+)\/log)?$/);
   if(!match)return send(404,{error:'NOT_FOUND'});
   const source=await find(match[1]);if(!source)return send(404,{error:'RUN_NOT_FOUND'});
   const run=await one(source);if(!run)return send(404,{error:'RUN_NOT_FOUND'});if(failure)return send(200,{failures:await failureDetails(run,source.logsRoot)});if(!match[2]){const result=await readDevices(config,{runs:[run],viewerHost,viewerResources:await readResources()});return send(200,result.runs[0]);}
   const step=run.steps.find(step=>step.id===match[2]);if(!identifier(match[2])||!step)return send(404,{error:'STEP_NOT_FOUND'});
   const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)return send(400,{error:'OFFSET_INVALID'});let cursor;try{cursor=parseLogCursor(url.searchParams.get('cursor'),offset)}catch{return send(400,{error:'LOG_CURSOR_INVALID'})}
   if(run.status==='queued'||step.status==='queued')return send(200,{text:'',nextOffset:0,total:0,reset:offset!==0,availability:'not-started',modifiedAt:null,fileId:null,cursor:null});
   const file=join(resolve(source.logsRoot),match[2]+'.log');
   let handle;try{
    const original=await lstat(file,{bigint:true});if(!original.isFile()||original.isSymbolicLink())return send(403,{error:'LOG_PATH_FORBIDDEN'});
    const logRoot=await realpath(source.logsRoot),actual=await realpath(file);if(!actual.startsWith(logRoot+sep))return send(403,{error:'LOG_PATH_FORBIDDEN'});
    handle=await open(actual,'r');const info=await handle.stat({bigint:true});if(!info.isFile()||info.dev!==original.dev||info.ino!==original.ino)return send(403,{error:'LOG_PATH_CHANGED'});if(info.size>BigInt(Number.MAX_SAFE_INTEGER))return send(413,{error:'LOG_TOO_LARGE'});
    const size=Number(info.size),fileId=createHash('sha256').update([info.dev,info.ino,info.birthtimeNs].join(':')).digest('hex').slice(0,24),modifiedAt=info.mtime.toISOString();let reset=offset>size;
    if(cursor&&!reset){const boundary=await cursorAt(handle,fileId,offset);reset=cursor.fileId!==fileId||cursor.prefix!==boundary.prefix||cursor.boundary!==boundary.boundary;}
    if(cursor&&Number.isSafeInteger(cursor.total)&&cursor.modifiedAt&&size<=cursor.total&&cursor.modifiedAt!==modifiedAt)reset=true;
    const start=reset?0:offset,bytes=Buffer.alloc(Math.min(131072,size-start));const {bytesRead}=await handle.read(bytes,0,bytes.length,start);let length=bytesRead;
    if(start+length<size){const newline=bytes.lastIndexOf(10,length-1);if(newline>=0)length=newline+1;}
    length=utf8ChunkLength(bytes,length);const nextOffset=start+length,nextCursor={...await cursorAt(handle,fileId,nextOffset),total:size,modifiedAt};
    return send(200,{text:bytes.subarray(0,length).toString('utf8'),nextOffset,total:size,reset,availability:size?'available':'empty',modifiedAt,fileId,cursor:Buffer.from(JSON.stringify(nextCursor)).toString('base64url')});
   }catch(error){if(error.code==='ENOENT')return send(200,{text:'',nextOffset:0,total:0,reset:offset!==0,availability:'missing',modifiedAt:null,fileId:null,cursor:null});throw error}finally{await handle?.close()}
  }catch(error){send(500,{error:'无法读取验收记录',detail:error.code||error.message});}
 });
 return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const configFile=resolve(process.argv[2]||join(root,'config.json'));const config=await json(configFile);const server=await createViewer(config),maintenance=startHistoryMaintenance(config);await maintenance.ready;
 server.listen(config.port||4399,'127.0.0.1',()=>console.log('WSL progress viewer: http://127.0.0.1:'+server.address().port+' (read only)'));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>maintenance.stop().finally(()=>process.exit(0))));
}
