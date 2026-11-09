import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const ipv4=value=>{
 if(typeof value!=='string')return null;
 value=value.replace(/^::ffff:/,'');
 if(!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value))return null;
 const parts=value.split('.').map(Number);return parts.every(part=>part<256)?parts.reduce((sum,part)=>sum*256+part,0):null;
};
export function privateIPv4(value){const address=ipv4(value);return address!==null&&((address>>>24)===10||(address>>>20)===0xac1||(address>>>16)===0xc0a8);}
export function sameSubnet(remote,address,prefix){
 const source=ipv4(remote),target=ipv4(address);if(source===null||target===null||!Number.isInteger(prefix)||prefix<8||prefix>32||!privateIPv4(remote)||!privateIPv4(address))return false;
 const mask=prefix===32?0xffffffff:(0xffffffff<<(32-prefix))>>>0;return (source&mask)===(target&mask);
}
const cleanHeaders=headers=>Object.fromEntries(Object.entries(headers).filter(([name])=>!['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','set-cookie','access-control-allow-origin','access-control-allow-credentials'].includes(name.toLowerCase())));

export function createLanRelay({address,prefix,port=4399,upstreamPort=4399,instanceId=randomUUID()}){
 if(!privateIPv4(address)||!Number.isInteger(prefix)||prefix<8||prefix>32||![port,upstreamPort].every(value=>Number.isInteger(value)&&value>=1&&value<=65535))throw Error('LAN_CONFIG_INVALID');
 const server=http.createServer((req,res)=>{
  const reply=(code,body)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:JSON.stringify(body));};
  if(!['GET','HEAD'].includes(req.method))return reply(405,{error:'READ_ONLY_VIEWER'});
  if(!sameSubnet(req.socket.remoteAddress,address,prefix))return reply(403,{error:'LAN_SUBNET_ONLY'});
  if(!new RegExp('^'+address.replaceAll('.','\\.')+'(?::'+port+')?$').test(req.headers.host||''))return reply(403,{error:'LAN_HOST_FORBIDDEN'});
  if(!req.url?.startsWith('/')||req.url.startsWith('//')||/[\\\x00-\x20]/.test(req.url))return reply(400,{error:'PATH_INVALID'});
  if(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)!==0){req.resume();return reply(400,{error:'REQUEST_BODY_FORBIDDEN'});}
  if(req.url==='/__wsl_console_lan')return reply(200,{application:'wsl-console-lan',instanceId,pid:process.pid,address,prefix,port,upstreamPort});
  const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,path:req.url,method:req.method,headers:{host:'127.0.0.1:'+upstreamPort,accept:req.headers.accept||'*/*','accept-encoding':'identity'},timeout:15000},response=>{
   res.writeHead(response.statusCode||502,{...cleanHeaders(response.headers),'cache-control':'no-store'});response.pipe(res);response.on('error',()=>res.destroy());
  });
  upstream.on('timeout',()=>upstream.destroy(Error('UPSTREAM_TIMEOUT')));
  upstream.on('error',()=>{if(!res.headersSent)reply(502,{error:'LOCAL_VIEWER_UNAVAILABLE'});else res.destroy();});
  req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());upstream.end();
 });
 for(const event of ['connect','upgrade'])server.on(event,(_req,socket)=>socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
 return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options=JSON.parse(process.argv[2]||'{}'),server=createLanRelay(options);
 server.listen(options.port||4399,options.address,()=>console.log('WSL Console LAN: http://'+options.address+':'+(options.port||4399)));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
}
