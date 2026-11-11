import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('compiled viewer styles include the pinned shared library and current workbench source',async()=>{
 const source=JSON.parse(await readFile(new URL('../vendor/qisvc-console-ui/source.json',import.meta.url),'utf8'));
 const shared=(await readFile(new URL('../vendor/qisvc-console-ui/console.css',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 const own=(await readFile(new URL('../styles/workbench.css',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 const built=(await readFile(new URL('../public/style.css',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 assert.equal(createHash('sha256').update(shared).digest('hex'),source.sha256);
 assert.equal(createHash('sha1').update('blob '+Buffer.byteLength(shared)+'\0'+shared).digest('hex'),source.upstreamBlob);
 assert.ok(built.startsWith('/* Generated from qisvc-console-ui '+source.commit));
 assert.ok(built.includes(shared));assert.ok(built.endsWith(own));
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 assert.match(html,/qisvc-console-stage/);assert.match(html,/qisvc-surface-card/);assert.match(html,/<title>WSL 验收进度<\/title>/);
});
