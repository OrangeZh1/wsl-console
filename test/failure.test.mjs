import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createViewer} from '../server.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'wsl-failure-')),runsRoot=join(root,'runs');await mkdir(runsRoot);t.after(()=>rm(root,{recursive:true,force:true}));
 const server=await createViewer({runsRoot});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));
 const url='http://127.0.0.1:'+server.address().port;
 async function run(id,steps,patch={}){const directory=join(runsRoot,id);await mkdir(join(directory,'logs'),{recursive:true});await writeFile(join(directory,'run.json'),JSON.stringify({format:'wsl-progress-v1',id,name:id,status:'failed',finished:true,finishedAt:new Date().toISOString(),steps,...patch}));return join(directory,'logs');}
 return {root,runsRoot,url,run,details:async id=>(await fetch(url+'/api/runs/'+id+'/failure')).json()};
}

test('failure details prefer reported errors and return each failed stage without other-run data',async t=>{
 const f=await fixture(t),logs=await f.run('failed',[{id:'compile',label:'编译',status:'failed',exitCode:2,error:'Error: 实际编译错误\n  at compiler.mjs:1\n'+('x'.repeat(6000))},{id:'download',label:'下载',status:'failed',exitCode:28},{id:'waiting',status:'queued'}]);
 await writeFile(join(logs,'compile.log'),'ERROR wrong fallback');await writeFile(join(logs,'download.log'),'下载进度 99%\n\u001b[31mcurl: (28) Operation timed out after 300000 milliseconds\u001b[0m\n');
 const other=await f.run('other',[{id:'download',status:'failed'}]);await writeFile(join(other,'download.log'),'ERROR OTHER RUN SECRET');
 const {failures}=await f.details('failed');assert.equal(failures.length,2);assert.equal(failures[0].message,'Error: 实际编译错误');assert.equal(failures[0].source,'reported');assert.equal(failures[0].reportedBy,'stage');assert.ok(failures[0].excerpt.length<=4000);assert.match(failures[0].excerpt,/compiler.mjs/);assert.equal(failures[1].message,'curl: (28) Operation timed out after 300000 milliseconds');assert.equal(failures[1].source,'log');assert.equal(failures[1].exitCode,28);assert.doesNotMatch(JSON.stringify(failures),/OTHER RUN|wrong fallback|\u001b/);
});

test('ordinary output and test summaries are not invented failure causes',async t=>{
 const f=await fixture(t),logs=await f.run('unreported',[{id:'package',label:'打包',status:'failed',exitCode:1,error:'\u001b[31m \u001b[0m'}]);await writeFile(join(logs,'package.log'),'$ tar --create source.tar\n92 30.5M 92 28.3M\n# fail 1\nℹ fail 1\nTests 1 failed (1)\n');
 const {failures}=await f.details('unreported');assert.equal(failures[0].message,'执行端未上报具体失败原因');assert.equal(failures[0].source,'missing');assert.equal(failures[0].logStatus,'read');assert.match(failures[0].excerpt,/tar --create/);
});

test('log fallback reads only a bounded tail and prefers a specific error over a wrapper',async t=>{
 const f=await fixture(t),logs=await f.run('tail',[{id:'build',label:'构建',status:'failed',exitCode:1}]);await writeFile(join(logs,'build.log'),'ERROR OLD OUTSIDE TAIL\n'+('normal progress line\n'.repeat(3000))+'Error: missing compiler module\nELIFECYCLE Command failed with exit code 1\n');
 const {failures}=await f.details('tail');assert.equal(failures[0].message,'Error: missing compiler module');assert.equal(failures[0].source,'log');assert.ok(failures[0].excerpt.length<=4000);assert.doesNotMatch(failures[0].excerpt,/OLD OUTSIDE TAIL/);
});

test('missing, symlinked and nonregular logs have explicit unavailable states',async t=>{
 const f=await fixture(t),logs=await f.run('unsafe',[{id:'absent',status:'failed'},{id:'linked',status:'failed'},{id:'directory',status:'failed'}]);const privateDirectory=join(f.root,'private');await mkdir(privateDirectory);const privateFile=join(privateDirectory,'private.txt');await writeFile(privateFile,'PRIVATE CONTENT');await symlink(process.platform==='win32'?privateDirectory:privateFile,join(logs,'linked.log'),process.platform==='win32'?'junction':'file');await mkdir(join(logs,'directory.log'));
 const {failures}=await f.details('unsafe');assert.deepEqual(failures.map(item=>item.logStatus),['missing','forbidden','forbidden']);assert.ok(failures.every(item=>item.source==='missing'));assert.doesNotMatch(JSON.stringify(failures),/PRIVATE CONTENT/);
});

test('failure endpoint preserves read-only, Host, identifier and expired-history guards',async t=>{
 const f=await fixture(t);await f.run('old',[{id:'fail',status:'failed',exitCode:1}],{finishedAt:new Date(Date.now()-31*86400000).toISOString()});await f.run('passed',[{id:'ok',status:'passed',exitCode:0}],{status:'passed'});
 assert.deepEqual(await f.details('passed'),{failures:[]});assert.equal((await fetch(f.url+'/api/runs/missing/failure')).status,404);assert.equal((await fetch(f.url+'/api/runs/old/failure')).status,404);assert.equal((await fetch(f.url+'/api/runs/bad%2Fid/failure')).status,404);assert.equal((await fetch(f.url+'/api/runs/passed/failure',{method:'POST',body:'{}'})).status,405);
 const code=await new Promise((ok,fail)=>{const req=request(f.url+'/api/runs/passed/failure',{headers:{host:'outside.example'}},res=>{res.resume();ok(res.statusCode)});req.on('error',fail);req.end()});assert.equal(code,403);
});

test('a failed run can report its error even when no failed stage was supplied',async t=>{
 const f=await fixture(t);await f.run('run-error',[],{error:'Error: executor startup failed\nstack detail'});const {failures}=await f.details('run-error');assert.deepEqual(failures,[{stepId:null,label:'任务',message:'Error: executor startup failed',source:'reported',reportedBy:'run',excerpt:'stack detail'}]);
});
