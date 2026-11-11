import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {executePreparedJob} from '../run-queue.mjs';

test('prepared adapter verifies immutable inputs and a matching actual terminal receipt',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-queue-adapter-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'worker.mjs'),receiptFile=join(root,'receipt.json');
 const source="import{writeFile}from'node:fs/promises';await writeFile(process.argv[2],JSON.stringify({id:'actual',dispatchJobId:'job',status:'passed',finished:true,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()}));";await writeFile(file,source);
 const job={id:'job',inputs:[{path:file,sha256:createHash('sha256').update(source).digest('hex')}],executors:{remote:{file:process.execPath,args:[file,receiptFile],receiptFile,admissionEnforced:true,lockEnforced:true}}};
 assert.equal((await executePreparedJob(job,{id:'remote'},root)).status,'passed');
 await writeFile(file,source+'\n');assert.equal((await executePreparedJob(job,{id:'remote'},root)).status,'queued');
 assert.equal((await executePreparedJob(job,{id:'other'},root)).status,'queued');
 await stat(join(root,'executor.log'));
});

test('missing or unrelated execution receipts remain unknown rather than reporting success',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wsl-queue-unknown-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'worker.mjs'),source='process.exit(0);';await writeFile(file,source);
 const job={id:'job',inputs:[{path:file,sha256:createHash('sha256').update(source).digest('hex')}],executors:{remote:{file:process.execPath,args:[file],receiptFile:join(root,'missing.json'),admissionEnforced:true,lockEnforced:true}}};
 await assert.rejects(executePreparedJob(job,{id:'remote'},root),/EXECUTION_RESULT_UNKNOWN/);
 await writeFile(job.executors.remote.receiptFile,JSON.stringify({dispatchJobId:'other',status:'passed',finished:true,startedAt:new Date().toISOString()}));
 await assert.rejects(executePreparedJob(job,{id:'remote'},root),/EXECUTION_RECEIPT_MISMATCH/);
});
