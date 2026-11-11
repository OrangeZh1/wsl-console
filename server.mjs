import http from 'node:http';
import {readFile,readdir,open,mkdir,realpath} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isExpiredHistory,startHistoryMaintenance} from './retention.mjs';
import {failureDetails} from './failure.mjs';
import {readResources} from './resources.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const viewerInstance=/^[a-f0-9-]{36}$/i.test(process.env.WSL_CONSOLE_INSTANCE_ID||'')?process.env.WSL_CONSOLE_INSTANCE_ID:randomUUID();
const identifier=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);
const states=new Set(['queued','running','passed','failed','blocked','cancelled','interrupted']);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
function statusOf(run){
 if(run.steps.some(step=>step.status==='running'))return 'running';
 if(run.steps.some(step=>step.status==='failed'))return 'failed';
 if(run.steps.some(step=>['blocked','interrupted','cancelled'].includes(step.status)))return 'blocked';
 const successful=run.finished&&run.steps.length&&run.steps.every(step=>step.status==='passed'&&(step.exitCode===0||(!run.format&&step.exitCode===undefined&&!step.command.length&&!step.tests))&&(step.tests?.fail??0)===0);
 if(run.status==='passed')return successful?'passed':'blocked';
 if(states.has(run.status))return run.status;
 if(run.finished)return successful?'passed':'blocked';
 return run.startedAt&&!run.finished?'running':'queued';
}
export async function createViewer(config){
 const dataRoot=resolve(config.runsRoot);await mkdir(dataRoot,{recursive:true});
 async function sources(){
  const result=[...(config.sources||[])];
  for(const entry of await readdir(dataRoot,{withFileTypes:true}))if(entry.isDirectory()&&identifier(entry.name)&&!result.some(item=>item.id===entry.name))result.push({id:entry.name,progressFile:join(dataRoot,entry.name,'run.json'),logsRoot:join(dataRoot,entry.name,'logs')});
  return result.filter(item=>identifier(item.id));
 }
 async function load(source){
  const record=await json(source.progressFile);
  if(!Array.isArray(record.steps))throw Error('RUN_STEPS_INVALID');
  if(isExpiredHistory(record))return null;
  let versions=record.versions||[];
  if(source.manifestFile){const manifest=await json(source.manifestFile);versions=Object.entries(manifest.repositories||{}).map(([name,repo])=>({name,branch:repo.branch,head:repo.head,sha256:repo.sha256}));}
  const steps=record.steps.filter(step=>identifier(step.id)).map(step=>({id:step.id,label:String(step.label||step.id),detail:String(step.detail||''),status:states.has(step.status)?step.status:'interrupted',startedAt:step.startedAt,finishedAt:step.finishedAt,seconds:step.seconds,exitCode:step.exitCode,command:Array.isArray(step.command)?step.command.map(String):[],tests:step.tests,activity:typeof step.activity==='string'?step.activity:undefined,activityUpdatedAt:step.activityUpdatedAt,error:step.error?String(step.error):undefined}));
  const times=record.steps.flatMap(step=>[step.startedAt,...(step.attempts||[]).map(attempt=>attempt.startedAt)]).filter(Boolean).sort();
  for(const step of steps)if(['running','queued'].includes(step.status)){delete step.seconds;delete step.finishedAt;delete step.exitCode;if(step.status==='queued'){delete step.startedAt;delete step.tests;delete step.error;delete step.activity;delete step.activityUpdatedAt;}}
  const taskKey=record.taskKey||source.taskKey;
  const run={id:source.id,taskKey:typeof taskKey==='string'&&taskKey.trim()&&taskKey.length<=160?taskKey.trim():undefined,format:record.format,name:record.name||source.name||source.id,projects:record.projects||source.projects||[],environment:record.environment||source.environment||'WSL Linux',status:record.status,enqueuedAt:record.enqueuedAt,startedAt:record.startedAt||times[0],updatedAt:record.updatedAt,finishedAt:record.finishedAt,finished:record.finished===true,versions,steps};
  run.status=statusOf(run);
  if(run.status==='failed'&&typeof record.error==='string')run.error=record.error;
  if(run.status==='queued'){delete run.startedAt;delete run.finishedAt;if(Number.isSafeInteger(record.queuePosition)&&record.queuePosition>0)run.queuePosition=record.queuePosition;}
  return run;
 }
 async function find(id){if(!identifier(id))return null;return (await sources()).find(source=>source.id===id)||null;}
 const server=http.createServer(async(req,res)=>{
  const send=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'"});res.end(req.method==='HEAD'?undefined:type.startsWith('application/json')?JSON.stringify(value):value);};
  try{
   if(!['GET','HEAD'].includes(req.method))return send(405,{error:'READ_ONLY_VIEWER'});
   if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host||''))return send(403,{error:'LOCAL_ACCESS_ONLY'});
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/api/viewer')return send(200,{application:'wsl-console',pid:process.pid,instanceId:viewerInstance,platform:process.platform});
   if(url.pathname==='/api/resources')return send(200,await readResources());
   const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/icons.svg':['icons.svg','image/svg+xml'],'/icons.js':['icons.js','text/javascript; charset=utf-8']};
   if(assets[url.pathname]){const [file,type]=assets[url.pathname];return send(200,await readFile(join(root,'public',file)),type);}
   if(url.pathname==='/api/runs'){
    const runs=[];for(const source of await sources()){try{const run=await load(source);if(run)runs.push(run)}catch(error){runs.push({id:source.id,name:source.name||source.id,status:'blocked',error:'无法读取运行记录：'+error.message,steps:[],versions:[],projects:source.projects||[]})}}
    runs.sort((a,b)=>String(b.startedAt||b.enqueuedAt||'').localeCompare(String(a.startedAt||a.enqueuedAt||'')));return send(200,{runs,readOnly:true});
   }
   const failure=url.pathname.match(/^\/api\/runs\/([^/]+)\/failure$/);
   const match=failure||url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/steps\/([^/]+)\/log)?$/);
   if(!match)return send(404,{error:'NOT_FOUND'});
   const source=await find(match[1]);if(!source)return send(404,{error:'RUN_NOT_FOUND'});
   const run=await load(source);if(!run)return send(404,{error:'RUN_NOT_FOUND'});if(failure)return send(200,{failures:await failureDetails(run,source.logsRoot)});if(!match[2])return send(200,run);
   const step=run.steps.find(step=>step.id===match[2]);if(!identifier(match[2])||!step)return send(404,{error:'STEP_NOT_FOUND'});
   const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)return send(400,{error:'OFFSET_INVALID'});
   if(run.status==='queued'||step.status==='queued')return send(200,{text:'',nextOffset:0,total:0,reset:offset!==0});
   const file=join(resolve(source.logsRoot),match[2]+'.log');
   let handle;try{
    const logRoot=await realpath(source.logsRoot),actual=await realpath(file);if(!actual.startsWith(logRoot+sep))return send(403,{error:'LOG_PATH_FORBIDDEN'});
    handle=await open(file,'r');const info=await handle.stat();const start=offset>info.size?0:offset;const bytes=Buffer.alloc(Math.min(131072,info.size-start));const {bytesRead}=await handle.read(bytes,0,bytes.length,start);let length=bytesRead;
    if(start+length<info.size){const newline=bytes.lastIndexOf(10,length-1);if(newline>=0)length=newline+1;}
    return send(200,{text:bytes.subarray(0,length).toString('utf8'),nextOffset:start+length,total:info.size,reset:offset>info.size});
   }catch(error){if(error.code==='ENOENT')return send(200,{text:'',nextOffset:0,total:0});throw error}finally{await handle?.close()}
  }catch(error){send(500,{error:'无法读取验收记录',detail:error.code||error.message});}
 });
 return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const configFile=resolve(process.argv[2]||join(root,'config.json'));const config=await json(configFile);const server=await createViewer(config),maintenance=startHistoryMaintenance(config);await maintenance.ready;
 server.listen(config.port||4399,'127.0.0.1',()=>console.log('WSL progress viewer: http://127.0.0.1:'+server.address().port+' (read only)'));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>maintenance.stop().finally(()=>process.exit(0))));
}
