import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const names=['status-passed','status-running','status-failed','status-queued','status-cancelled','status-interrupted','status-blocked','refresh','copy','chevron-right','chevron-down','terminal','clock','activity','history','list','server'];
async function renderer(){
 const document={createElementNS:(namespace,tagName)=>({namespace,tagName,attributes:{},children:[],setAttribute(name,value){this.attributes[name]=String(value)},append(child){this.children.push(child)}})};
 const context=vm.createContext({document});vm.runInContext(await readFile(new URL('../public/icons.js',import.meta.url),'utf8'),context);return context.wslIcon;
}

test('local Iconify sprite contains the required symbols and safe vector shapes only',async()=>{
 const svg=await readFile(new URL('../public/icons.svg',import.meta.url),'utf8');
 const symbols=[...svg.matchAll(/<symbol id="([^"]+)" viewBox="0 0 24 24">/g)].map(match=>match[1]);
 assert.deepEqual(symbols,names);assert.match(svg,/stroke="currentColor"/);
 assert.doesNotMatch(svg,/<(?:script|foreignObject|image|style|animate)\b|\bon\w+\s*=|\b(?:href|src)\s*=|url\s*\(/i);
 for(const match of svg.matchAll(/<\/?([a-z][\w-]*)\b/gi))assert.ok(['svg','symbol','g','path','circle','rect','line','polyline','polygon','ellipse'].includes(match[1]),match[1]);
});

test('Iconify helper renders every local symbol without an external request',async()=>{
 const icon=await renderer();
 for(const name of names){
  const result=icon(name);assert.equal(result.namespace,'http://www.w3.org/2000/svg');assert.equal(result.tagName,'svg');assert.equal(result.attributes.viewBox,'0 0 24 24');assert.equal(result.attributes.width,'16');assert.equal(result.attributes.height,'16');assert.equal(result.attributes['aria-hidden'],'true');assert.equal(result.attributes.focusable,'false');assert.match(result.attributes['data-icon'],/^lucide:/);assert.equal(result.children[0].tagName,'use');assert.equal(result.children[0].attributes.href,'/icons.svg#'+name);
 }
});

test('Iconify helper exposes accessible labels and rejects names outside its local whitelist',async()=>{
 const icon=await renderer(),named=icon('status-cancelled',{label:'已取消',className:'symbol cancelled'});
 assert.equal(named.attributes.role,'img');assert.equal(named.attributes['aria-label'],'已取消');assert.equal(named.attributes['aria-hidden'],undefined);assert.equal(named.attributes.class,'symbol cancelled');
 for(const name of ['https://outside.example/icon.svg','constructor','<script>',undefined])assert.equal(icon(name).children[0].attributes.href,'/icons.svg#status-queued');
 assert.equal(icon('copy',{label:'  '}).attributes['aria-hidden'],'true');
});
