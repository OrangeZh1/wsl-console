import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const API_VERSION='wsl-console-api-v2';
export const ASSET_FILES=Object.freeze({'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/icons.svg':['icons.svg','image/svg+xml'],'/icons.js':['icons.js','text/javascript; charset=utf-8']});
export const BACKEND_FILES=Object.freeze(['server.mjs','state.mjs','model.mjs','identity.mjs','record-cache.mjs','clock-observation.mjs','host.mjs','devices.mjs','failure.mjs','resources.mjs','retention.mjs']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
export const configVersion=config=>digest(JSON.stringify(ordered(config)));
export async function readAssetSnapshot(root){
 const assets=new Map(),parts=[];
 for(const [route,[name,type]]of Object.entries(ASSET_FILES)){const bytes=Buffer.from((await readFile(join(root,'public',name),'utf8')).replace(/\r\n/g,'\n'));assets.set(route,{bytes,type});parts.push([name,digest(bytes)]);}
 return {assets,version:digest(JSON.stringify(parts))};
}
export async function backendVersion(root){const parts=[];for(const file of BACKEND_FILES)parts.push([file,digest((await readFile(join(root,file),'utf8')).replace(/\r\n/g,'\n'))]);return digest(JSON.stringify(parts));}
export async function runtimeIdentity(root,config,assets){
 const buildVersion=await backendVersion(root),assetsVersion=assets?.version||(await readAssetSnapshot(root)).version;
 let manifest;try{manifest=JSON.parse(await readFile(join(root,'build-manifest.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')return {apiVersion:API_VERSION,buildVersion,assetsVersion,configVersion:configVersion(config),build:{commit:null,manifestStatus:'invalid'}};}
 const matched=manifest?.schema==='wsl-console-build-v1'&&manifest.backendVersion===buildVersion&&manifest.assetsVersion===assetsVersion&&typeof manifest.commit==='string'&&/^[a-f0-9]{40,64}$/i.test(manifest.commit);
 return {apiVersion:API_VERSION,buildVersion,assetsVersion,configVersion:configVersion(config),build:{commit:matched?manifest.commit:null,manifestStatus:matched?'verified':manifest?'mismatch':'missing',...(matched&&typeof manifest.builtAt==='string'?{builtAt:manifest.builtAt}:{})}};
}
