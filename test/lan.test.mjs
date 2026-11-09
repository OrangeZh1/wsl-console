import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {networkInterfaces} from 'node:os';
import {createLanRelay,privateIPv4,sameSubnet} from '../lan-relay.mjs';

function address(){
 for(const values of Object.values(networkInterfaces()))for(const value of values)if(value.family==='IPv4'&&!value.internal&&privateIPv4(value.address))return value.address;
 throw Error('A private local interface is required for the LAN integration check');
}
async function listen(server,host,port=0){await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok)});return server.address().port;}
async function fixture(t){
 const calls=[],upstream=http.createServer((req,res)=>{calls.push({url:req.url,method:req.method,headers:req.headers});res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*','set-cookie':'not-a-viewer-cookie=1'});res.end(JSON.stringify({path:req.url,readOnly:true}));});
 const upstreamPort=await listen(upstream,'127.0.0.1'),host=address(),probe=net.createServer(),port=await listen(probe,host);await new Promise(ok=>probe.close(ok));
 const relay=createLanRelay({address:host,prefix:32,port,upstreamPort,instanceId:'integration-only'});await listen(relay,host,port);
 t.after(async()=>{await new Promise(ok=>relay.close(ok));await new Promise(ok=>upstream.close(ok));});return {url:'http://'+host+':'+port,host,port,relay,upstream,calls};
}
function request(url,options={}){return new Promise((ok,fail)=>{const target=new URL(url),req=http.request({hostname:target.hostname,port:target.port,path:options.path||target.pathname+target.search,method:options.method||'GET',headers:options.headers},res=>{let body='';res.setEncoding('utf8');res.on('data',text=>body+=text);res.on('end',()=>ok({status:res.statusCode,body,headers:res.headers}));});req.once('connect',(res,socket)=>{socket.destroy();ok({status:res.statusCode,body:'',headers:res.headers})});req.on('error',fail);req.end(options.body);});}

test('LAN policy allows only RFC1918 sources inside the bound interface subnet',()=>{
 for(const value of ['10.0.0.1','172.16.0.1','172.31.255.254','192.168.10.100'])assert.equal(privateIPv4(value),true);
 for(const value of ['127.0.0.1','0.0.0.0','172.32.0.1','169.254.1.1','198.18.0.1','203.0.113.2','192.168.010.1','192.168.1.256'])assert.equal(privateIPv4(value),false,value);
 assert.equal(sameSubnet('192.168.10.25','192.168.10.100',24),true);assert.equal(sameSubnet('::ffff:192.168.10.25','192.168.10.100',24),true);
 assert.equal(sameSubnet('192.168.11.25','192.168.10.100',24),false);assert.equal(sameSubnet('10.0.0.1','192.168.10.100',24),false);assert.equal(sameSubnet('127.0.0.1','192.168.10.100',24),false);assert.equal(sameSubnet('192.168.10.25','192.168.10.100',0),false);
 assert.throws(()=>createLanRelay({address:'0.0.0.0',prefix:24}),/LAN_CONFIG_INVALID/);assert.throws(()=>createLanRelay({address:'203.0.113.1',prefix:24}),/LAN_CONFIG_INVALID/);
});
test('relay binds a specific private address and forwards only reads to a fixed loopback upstream',async t=>{
 const f=await fixture(t);assert.equal(f.relay.address().address,f.host);
 const response=await request(f.url+'/api/runs?offset=3',{headers:{authorization:'Bearer isolated-test-value',cookie:'isolated-cookie=1','x-forwarded-host':'outside.example','x-forwarded-for':'203.0.113.1'}});
 assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{path:'/api/runs?offset=3',readOnly:true});assert.equal(f.calls.length,1);assert.match(f.calls[0].headers.host,/^127\.0\.0\.1:/);
 for(const name of ['authorization','cookie','x-forwarded-host','x-forwarded-for'])assert.equal(f.calls[0].headers[name],undefined);
 assert.equal(response.headers['access-control-allow-origin'],undefined);assert.equal(response.headers['set-cookie'],undefined);
 const head=await request(f.url+'/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body,'');
});
test('relay rejects writes, request bodies, foreign Hosts and absolute-form targets before forwarding',async t=>{
 const f=await fixture(t);
 for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','CONNECT'])assert.equal((await request(f.url+'/',{method})).status,405);
 assert.equal((await request(f.url+'/',{headers:{host:'attacker.example'}})).status,403);assert.equal((await request(f.url+'/',{headers:{host:'192.168.255.254:'+f.port}})).status,403);
 assert.equal((await request(f.url+'/',{path:'http://outside.example/private'})).status,400);assert.equal((await request(f.url+'/',{path:'//outside.example/private'})).status,400);
 assert.equal((await request(f.url+'/',{headers:{'content-length':'1'},body:'x'})).status,400);assert.equal(f.calls.length,0);
});
test('relay identity is read-only and upstream failures are reported without exposing connection details',async t=>{
 const f=await fixture(t),identity=await request(f.url+'/__wsl_console_lan');assert.equal(identity.status,200);assert.equal(JSON.parse(identity.body).instanceId,'integration-only');assert.equal(f.calls.length,0);
 await new Promise(ok=>f.upstream.close(ok));const response=await request(f.url+'/api/runs');assert.equal(response.status,502);assert.deepEqual(JSON.parse(response.body),{error:'LOCAL_VIEWER_UNAVAILABLE'});
});
