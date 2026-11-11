import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('anonymous shared resource consumer contract uses monotonic progress and unchanged memory gates',{skip:process.platform!=='linux'},()=>{
 const result=spawnSync('python3',['-B',fileURLToPath(new URL('./windows_resources_test.py',import.meta.url))],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
