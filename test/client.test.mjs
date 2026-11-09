import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual browser script with delayed network reads; no extra DOM dependency.
class Element{
 constructor(tag='div'){this.tagName=tag;this.children=[];this.attributes={};this.handlers={};this.value='';this.scrollTop=0;this.scrollHeight=100;this.checked=true;this.disabled=false;this.hidden=false;this._text='';}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('')}
 set textContent(value){this._text=String(value??'');this.children=[]}
 append(...nodes){for(const node of nodes)node.parentElement=this;this.children.push(...nodes)}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null}
 select(){this.selected=true}
 replaceChildren(...nodes){this._text='';this.children=nodes}
 setAttribute(name,value){this.attributes[name]=value}
 getAttribute(name){return this.attributes[name]??null}
 addEventListener(name,handler){this.handlers[name]=handler}
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const record=(id,status='running',steps=[{id:'unit',label:id+' 单测',status,startedAt:status==='running'?'2026-11-09T12:00:00Z':undefined}])=>({id,name:id+' 任务',status,projects:[id],steps,versions:[],enqueuedAt:'2026-11-09T11:00:00Z',startedAt:status==='running'?'2026-11-09T12:00:00Z':undefined});
async function client({compact=false}={}){
 const elements=new Map(),requests=[],intervals=[];
 const document={body:new Element('body'),getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)},createElement:tag=>new Element(tag),createElementNS:(_namespace,tag)=>new Element(tag)};
 const context=vm.createContext({document,Intl,Date,Map,console,matchMedia:()=>({matches:compact,addEventListener:()=>{}}),navigator:{clipboard:{writeText:async()=>{}}},setInterval:fn=>intervals.push(fn),fetch:path=>new Promise((resolve,reject)=>requests.push({path,resolve,reject}))});
 vm.runInContext(await readFile(new URL('../public/icons.js',import.meta.url),'utf8'),context);vm.runInContext(await readFile(new URL('../public/app.js',import.meta.url),'utf8'),context);
 const answer=(request,data)=>request.resolve({ok:true,json:async()=>structuredClone(data)});
 return {context,requests,element:id=>document.getElementById(id),call:source=>vm.runInContext(source,context),answer,intervals};
}

test('task switching ignores delayed logs, clears previous metadata and keeps a pending task log-free',async()=>{
 const c=await client();c.answer(c.requests[0],{runs:[record('a'),record('b','queued'),record('c'),record('empty','blocked',[])]});await turn();const first=c.requests.find(request=>request.path.includes('/a/steps/'));
 c.call("chooseRun('b')");assert.match(c.element('started').textContent,/入队/);assert.equal(c.element('elapsed').textContent,'尚未开始');assert.equal(c.element('log-size').textContent,'0 B');assert.equal(c.element('command').textContent,'');assert.equal(c.requests.filter(request=>request.path.includes('/b/steps/')).length,0);
 c.call("chooseRun('c')");const current=c.requests.find(request=>request.path.includes('/c/steps/'));c.answer(first,{text:'a stale log',nextOffset:11,total:11});await turn();assert.equal(c.element('log').textContent,'');const count=c.requests.length;c.call('pollLog()');assert.equal(c.requests.length,count,'old request completion cannot unlock the new request');
 c.answer(current,{text:'c current log',nextOffset:13,total:13});await turn();assert.equal(c.element('log').textContent,'c current log');
 await c.element('copy').handlers.click();assert.equal(c.element('copy').textContent,'已复制');assert.equal(c.element('copy').children[0].attributes['data-icon'],'lucide:copy');c.call("navigator.clipboard.writeText=async()=>{throw Error('denied')}");await c.element('copy').handlers.click();assert.equal(c.element('copy').textContent,'请手动选择复制');assert.equal(c.element('copy').children[0].attributes['data-icon'],'lucide:copy');assert.equal(c.element('copy').attributes['aria-busy'],'false');
 c.call("chooseRun('empty')");assert.equal(c.element('log').textContent,'');assert.equal(c.element('log-size').textContent,'0 B');assert.equal(c.element('step-name').textContent,'此任务暂无阶段');assert.equal(c.element('step-meta').textContent,'');
});

test('background and manual refresh share one read and preserve the task chosen while it is delayed',async()=>{
 const c=await client();c.answer(c.requests[0],{runs:[record('a','queued'),record('b','queued')]});await turn();
 assert.equal(c.element('connection').className,'connection connected');
 const background=c.call('refresh()');assert.equal(c.element('refresh').disabled,false);assert.notEqual(c.element('refresh').textContent,'刷新中…');const request=c.requests.at(-1),count=c.requests.length;
 const manual=c.call('refresh(true)');assert.equal(c.requests.length,count);assert.equal(c.element('refresh').disabled,true);assert.equal(c.element('refresh').textContent,'刷新中…');c.call("chooseRun('b')");
 assert.equal(c.element('refresh').children[0].attributes['data-icon'],'lucide:refresh-cw');
 c.answer(request,{runs:[record('a','queued'),{...record('b','queued'),queuePosition:4}]});await Promise.all([background,manual]);assert.equal(c.element('run-name').textContent,'b 任务');assert.equal(c.element('history').value,'b');assert.equal(c.element('queue').textContent,'队列第 4 位');assert.equal(c.element('refresh').disabled,false);assert.equal(c.element('refresh').textContent,'刷新状态');
 const failed=c.call('refresh(true)');c.requests.at(-1).reject(Error('network failure'));await failed;assert.equal(c.element('refresh').disabled,false);assert.equal(c.element('run-name').textContent,'b 任务');assert.match(c.element('connection').textContent,/network failure/);assert.equal(c.element('connection').className,'connection error');const recovered=c.call('refresh()');c.answer(c.requests.at(-1),{runs:[record('a','queued'),record('b','queued')]});await recovered;assert.equal(c.element('connection').className,'connection connected');
});

test('a stage retry clears old logs and task navigation lists concurrent runs separately from queued stages',async()=>{
 const c=await client(),a=record('a'),b=record('b'),waiting=record('waiting','queued');a.steps.push({id:'later',label:'等待阶段',status:'queued'});c.answer(c.requests[0],{runs:[a,b,waiting]});await turn();c.answer(c.requests.find(request=>request.path.includes('/a/steps/')),{text:'old attempt',nextOffset:11,total:11});await turn();assert.match(c.element('task-count').textContent,/执行 2等待 1历史 0/);assert.equal(c.element('tasks').children.length,2,'only selected category tasks appear');assert.doesNotMatch(c.element('tasks').textContent,/waiting 任务/);
 const reload=c.call('refresh()');a.steps[0].startedAt='2026-11-09T13:00:00Z';c.answer(c.requests.at(-1),{runs:[a,b,waiting]});await reload;assert.equal(c.element('log').textContent,'');assert.equal(c.element('log-size').textContent,'0 B');c.call('pollLog()');assert.match(c.requests.at(-1).path,/offset=0$/);
 c.call("applyMetadata({runs:[{id:'only',name:'应用与插件独立开发 · Linux 验收',status:'passed',projects:['one'],steps:[],versions:[]}]})");c.call("chooseFilter('history')");assert.match(c.element('task-count').textContent,/执行 0等待 0历史 1/);assert.equal(c.element('tasks').children.length,1);assert.doesNotMatch(c.element('tasks').textContent,/暂无|执行中 · 0|等待任务 · 0/);const button=c.element('tasks').children[0];assert.match(button.attributes['aria-label'],/应用与插件独立开发 · Linux 验收/);assert.match(button.attributes.title,/应用与插件独立开发 · Linux 验收/);
 c.call('applyMetadata({runs:[]})');assert.equal(c.element('tasks').textContent,'暂无任务记录');assert.equal(c.element('tasks').children.length,1);
});

test('category buttons restore task and stage choices and survive a delayed metadata response',async()=>{
 const c=await client(),a=record('a'),other=record('other'),waiting=record('waiting','queued'),history=record('old','passed');a.steps.push({id:'later',label:'A 后续阶段',status:'queued'});c.answer(c.requests[0],{runs:[a,other,waiting,history]});await turn();assert.equal(c.call('activeFilter'),'running');
 c.call("chooseRun('other')");c.call("chooseRun('a')");c.call("chooseStep('later')");c.call("chooseFilter('queued')");assert.equal(c.element('run-name').textContent,'waiting 任务');assert.equal(c.call('activeFilter'),'queued');assert.equal(c.element('tasks').children.length,1);
 c.call("chooseFilter('running')");assert.equal(c.element('run-name').textContent,'a 任务');assert.equal(c.element('step-name').textContent,'A 后续阶段');
 const delayed=c.call('refresh()');c.call("chooseFilter('history')");assert.equal(c.element('run-name').textContent,'old 任务');c.answer(c.requests.findLast(request=>request.path==='/api/runs'),{runs:[a,other,waiting,history]});await delayed;assert.equal(c.call('activeFilter'),'history');assert.equal(c.element('run-name').textContent,'old 任务');assert.equal(c.element('task-count').children[2].attributes['aria-pressed'],'true');
 c.call("chooseFilter('running')");assert.equal(c.element('step-name').textContent,'A 后续阶段');
});

test('empty category clears every prior result and delayed logs cannot restore it',async()=>{
 const c=await client(),history=record('old','passed',[{id:'unit',label:'旧阶段',status:'passed',startedAt:'2026-11-09T12:00:00Z',exitCode:0,command:['old-command'],tests:{pass:9,fail:0,skipped:0}}]);history.versions=[{name:'old source',head:'123',sha256:'abc'}];c.answer(c.requests[0],{runs:[history]});await turn();const log=c.requests.find(request=>request.path.includes('/steps/'));
 const delayed=c.call('refresh()');c.call("chooseFilter('running')");assert.equal(c.call('run'),null);for(const id of ['projects','started','elapsed','queue','environment','versions','step-meta','command','log'])assert.equal(c.element(id).textContent,'',id);assert.equal(c.element('steps').children.length,0);assert.equal(c.element('test-count').textContent,'暂无测试统计');assert.equal(c.element('source-info').hidden,true);assert.equal(c.element('step-state').hidden,true);assert.equal(c.element('history').value,'');assert.match(c.element('log-empty').textContent,/暂无执行中任务/);
 c.answer(log,{text:'OLD SECRET RESULT',nextOffset:17,total:17});c.answer(c.requests.findLast(request=>request.path==='/api/runs'),{runs:[history]});await delayed;assert.equal(c.call('activeFilter'),'running');assert.equal(c.call('run'),null);assert.equal(c.element('log').textContent,'');
 c.call("chooseFilter('queued')");assert.match(c.element('run-name').textContent,/暂无等待任务/);c.call("chooseFilter('history')");assert.equal(c.element('run-name').textContent,'old 任务');assert.equal(c.element('step-name').textContent,'旧阶段');assert.match(c.element('command').textContent,/old-command/);
});

test('running task moving to history keeps its detail and active filter until the user switches',async()=>{
 const c=await client(),a=record('a');c.answer(c.requests[0],{runs:[a]});await turn();const log=c.requests.find(request=>request.path.includes('/steps/'));c.answer(log,{text:'running output',nextOffset:14,total:14});await turn();
 const delayed=c.call('refresh()');a.status='passed';a.finished=true;a.finishedAt='2026-11-09T13:00:00Z';a.steps[0].status='passed';a.steps[0].exitCode=0;c.answer(c.requests.findLast(request=>request.path==='/api/runs'),{runs:[a]});await delayed;assert.equal(c.call('activeFilter'),'running');assert.equal(c.element('run-name').textContent,'a 任务');assert.equal(c.element('run-state').textContent,'已通过');assert.equal(c.element('step-name').textContent,'a 单测');assert.equal(c.element('log').textContent,'running output');assert.match(c.element('tasks').textContent,/已转入历史与其他/);
 c.call("chooseFilter('history')");assert.equal(c.element('run-name').textContent,'a 任务');assert.equal(c.element('step-name').textContent,'a 单测');assert.equal(c.element('log').textContent,'running output');
});

test('current activity lists every running stage, uses reported fallback, and never presents history as running',async()=>{
 const a=record('a');a.updatedAt='2026-11-09T12:02:03Z';Object.assign(a.steps[0],{activity:'正在核对累计迁移',activityUpdatedAt:'2026-11-09T12:01:02Z'});a.steps.push({id:'parallel',label:'并行构建',status:'running',startedAt:'2026-11-09T12:00:10Z',detail:'独立后台构建',command:['node','build.mjs']});
 const c=await client();c.answer(c.requests[0],{runs:[a]});await turn();assert.equal(c.element('activity').open,true);assert.equal(c.element('activity-summary').textContent,'2 个阶段执行中');assert.equal(c.element('activity-content').children.length,2);assert.match(c.element('activity-content').textContent,/正在核对累计迁移/);assert.match(c.element('activity-content').textContent,/独立后台构建 · node build.mjs/);assert.match(c.element('activity-content').textContent,/暂无细粒度进展上报/);assert.match(c.element('activity-content').textContent,/进展更新/);assert.match(c.element('activity-content').textContent,/记录更新/);assert.match(c.element('tasks').textContent,/正在核对累计迁移/);
 c.element('activity-content').children[1].children[0].children[1].handlers.click();assert.equal(c.call('selectedStep'),'parallel');assert.equal(c.call('activeFilter'),'running');assert.equal(c.element('run-name').textContent,'a 任务');
 const mobile=await client({compact:true});mobile.answer(mobile.requests[0],{runs:[a]});await turn();assert.equal(mobile.element('activity').open,false);
 a.status='passed';a.finished=true;for(const step of a.steps){step.status='passed';step.exitCode=0}const reload=c.call('refresh()');c.answer(c.requests.findLast(request=>request.path==='/api/runs'),{runs:[a]});await reload;assert.equal(c.element('activity').open,false);assert.equal(c.element('activity-summary').textContent,'已通过');assert.doesNotMatch(c.element('activity-content').textContent,/正在核对累计迁移|独立后台构建/);assert.match(c.element('activity-content').textContent,/没有正在执行/);
 c.call("chooseFilter('queued')");assert.equal(c.element('activity').hidden,true);assert.equal(c.element('activity-content').textContent,'');assert.equal(c.element('activity-summary').textContent,'');
});

test('logical tasks group retries while preserving each selected run, failure, and real concurrency',async()=>{
 const old=record('old','failed',[{id:'unit',label:'旧失败阶段',status:'failed',exitCode:1}]);old.name='Docus';old.projects=['one','two'];old.startedAt='2026-11-09T10:00:00Z';const retry=record('retry');retry.name='Docus';retry.projects=['two','one'];retry.startedAt='2026-11-09T12:00:00Z';const explicitOld=record('explicit-old','passed');explicitOld.name='旧名称';explicitOld.taskKey='stable-task';explicitOld.startedAt='2026-11-09T09:00:00Z';const explicitNew=record('explicit-new','passed');explicitNew.name='新名称';explicitNew.taskKey='stable-task';explicitNew.startedAt='2026-11-09T11:00:00Z';
 const c=await client();c.answer(c.requests[0],{runs:[old,retry,explicitOld,explicitNew]});await turn();assert.equal(c.call('taskGroups.length'),2);assert.match(c.element('task-count').textContent,/执行 1等待 0历史 1/);assert.equal(c.element('tasks').children.length,1);assert.match(c.element('tasks').textContent,/2 次记录/);assert.equal(c.call('run.id'),'retry');assert.equal(c.element('history').children.length,3);
 c.call("chooseRun('old')");assert.equal(c.call('activeFilter'),'running');assert.equal(c.call('run.id'),'old');assert.equal(c.element('run-state').textContent,'未通过');assert.match(c.element('run-context').textContent,/正在查看较早记录，最近一次执行中/);assert.match(c.element('activity-summary').textContent,/历史记录 · 未通过/);assert.doesNotMatch(c.element('activity-content').textContent,/正在执行旧失败阶段/);
 const latest={...retry,id:'latest',startedAt:'2026-11-09T13:00:00Z'};const refresh=c.call('refresh()');c.answer(c.requests.findLast(request=>request.path==='/api/runs'),{runs:[old,retry,latest,explicitOld,explicitNew]});await refresh;assert.equal(c.call('run.id'),'old','a new retry cannot replace the selected failed run');assert.match(c.element('tasks').textContent,/3 次记录 · 2 个执行中/);assert.equal(c.element('history').children.length,4);
 c.call("chooseFilter('history')");assert.equal(c.call('run.id'),'explicit-new');assert.equal(c.element('history').children.length,3);c.call("chooseFilter('running')");assert.equal(c.call('run.id'),'old');assert.equal(c.element('step-name').textContent,'旧失败阶段');assert.deepEqual(old.projects,['one','two']);
});

test('stage statuses use distinct local Iconify symbols with accessible labels',async()=>{
 const statuses=['running','queued','passed','failed','blocked','cancelled','interrupted'],a=record('icons');a.steps=statuses.map(status=>({id:status,label:status,status,exitCode:status==='failed'?1:status==='passed'?0:undefined}));const c=await client();c.answer(c.requests[0],{runs:[a]});await turn();assert.equal(c.element('steps').children.length,7);
 for(const [index,status] of statuses.entries()){const icon=c.element('steps').children[index].children[0];assert.equal(icon.tagName,'svg');assert.equal(icon.attributes.role,'img');assert.ok(icon.attributes['aria-label']);assert.equal(icon.children[0].attributes.href,'/icons.svg#status-'+status);assert.equal(icon.children[1].tagName,'title');assert.notEqual(icon.textContent,'—');}
});

test('run failure details name actual failed stages even while a successful stage is selected',async()=>{
 const a=record('fail-a','failed',[{id:'success',label:'SDK 构建',status:'passed',exitCode:0},{id:'package',label:'原生包检查',status:'failed',exitCode:1},{id:'download',label:'下载检查',status:'failed',exitCode:2}]);const c=await client();c.answer(c.requests[0],{runs:[a]});await turn();const failure=c.requests.find(request=>request.path==='/api/runs/fail-a/failure');assert.ok(failure);c.call("chooseStep('success')");
 c.answer(failure,{failures:[{stepId:'package',label:'原生包检查',exitCode:1,message:'PACKAGE_ENTRY_NOT_FOUND',source:'reported'},{stepId:'download',label:'下载检查',exitCode:2,message:'curl: (28) Operation timed out',source:'log',excerpt:'curl: (28) Operation timed out\n'}]});await turn();assert.equal(c.element('step-name').textContent,'SDK 构建');assert.equal(c.element('failure').hidden,false);assert.equal(c.element('failure-content').children.length,2);assert.match(c.element('failure-content').textContent,/执行端上报/);assert.match(c.element('failure-content').textContent,/来自阶段日志/);assert.match(c.element('failure-content').textContent,/PACKAGE_ENTRY_NOT_FOUND/);assert.doesNotMatch(c.element('failure-content').textContent,/SDK 构建/);
 c.element('failure-content').children[0].children.at(-1).handlers.click();assert.equal(c.element('step-name').textContent,'原生包检查');assert.equal(c.call('run.id'),'fail-a');
});

test('delayed failure responses cannot cross runs or empty filters and missing information stays explicit',async()=>{
 const a=record('fail-a','failed'),b=record('fail-b','failed',[]),c=await client();c.answer(c.requests[0],{runs:[a,b]});await turn();c.call("chooseRun('fail-a')");const first=c.requests.find(request=>request.path==='/api/runs/fail-a/failure');c.call("chooseRun('fail-b')");const second=c.requests.find(request=>request.path==='/api/runs/fail-b/failure');assert.equal(c.element('failure-summary').attributes.title,'');
 c.answer(first,{failures:[{stepId:'unit',label:'A 错误阶段',message:'OLD_A_REASON',source:'reported'}]});await turn();assert.doesNotMatch(c.element('failure-content').textContent,/OLD_A_REASON/);c.answer(second,{failures:[{stepId:null,label:'这次运行',message:'执行端未上报具体失败原因',source:'missing'}]});await turn();assert.match(c.element('failure-content').textContent,/未上报具体失败原因/);assert.doesNotMatch(c.element('failure-content').textContent,/查看失败阶段日志/);
 const refresh=c.call('refresh()');b.updatedAt='2026-11-09T14:30:00Z';c.answer(c.requests.findLast(request=>request.path==='/api/runs'),{runs:[a,b]});await refresh;const third=c.requests.findLast(request=>request.path==='/api/runs/fail-b/failure');assert.notEqual(third,second);c.call("chooseFilter('queued')");assert.equal(c.element('failure').hidden,true);assert.equal(c.element('failure-content').textContent,'');c.answer(third,{failures:[{stepId:null,label:'这次运行',message:'LATE_B_REASON',source:'reported'}]});await turn();assert.equal(c.element('failure').hidden,true);assert.equal(c.element('failure-content').textContent,'');assert.equal(c.element('failure-summary').attributes.title,'');
});

test('mobile task navigation stays user-controlled and the native stage picker retains full names and selection',async()=>{
 const a=record('mobile-a','running',[{id:'ready',label:'已通过阶段',status:'passed',exitCode:0},{id:'active',label:'完整的净环境首装与恢复阶段名称',status:'running',startedAt:'2026-11-09T12:00:00Z',detail:'真实阶段说明'},{id:'later',label:'后续阶段',status:'queued'}]),b=record('mobile-b','queued'),c=await client({compact:true});c.answer(c.requests[0],{runs:[a,b]});await turn();assert.equal(c.element('task-toggle').attributes['aria-expanded'],'false');assert.equal(c.element('stage-picker').value,'active');assert.equal(c.element('mobile-step-count').textContent,'1 / 3');assert.match(c.element('stage-picker').attributes['aria-label'],/完整的净环境首装与恢复阶段名称/);assert.match(c.element('stage-picker').children[2].textContent,/执行中/);
 c.element('stage-picker').handlers.change({target:{value:'ready'}});assert.equal(c.call('selectedStep'),'ready');assert.equal(c.element('stage-picker').value,'ready');const options=c.element('stage-picker').children;c.element('task-toggle').handlers.click();assert.equal(c.element('task-toggle').attributes['aria-expanded'],'true');assert.match(c.element('task-nav').className,/mobile-expanded/);
 const refresh=c.call('refresh()');c.answer(c.requests.findLast(request=>request.path==='/api/runs'),{runs:[a,b]});await refresh;assert.equal(c.element('task-toggle').attributes['aria-expanded'],'true');assert.equal(c.element('stage-picker').children,options);assert.equal(c.element('stage-picker').value,'ready');
 c.call("chooseFilter('queued')");assert.equal(c.element('task-toggle').attributes['aria-expanded'],'true');const queued=c.element('tasks').children.find(item=>item.attributes['aria-label']?.startsWith('mobile-b 任务'));assert.ok(queued);queued.handlers.click();assert.equal(c.call('run.id'),'mobile-b');assert.equal(c.element('task-toggle').attributes['aria-expanded'],'false');assert.equal(c.element('stage-picker').value,'unit');
 c.call("chooseFilter('history')");assert.equal(c.element('stage-picker').disabled,true);assert.equal(c.element('stage-picker').value,'');assert.equal(c.element('mobile-step-count').textContent,'—');
});

test('LAN copy falls back only on the user action and reports success only when copying succeeds',async()=>{
 const c=await client({compact:true});c.answer(c.requests[0],{runs:[record('lan')]});await turn();c.answer(c.requests.find(request=>request.path.includes('/steps/')),{text:'LAN requested log',nextOffset:17,total:17});await turn();c.call("navigator.clipboard=undefined;document.execCommand=command=>{globalThis.copyCommand=command;globalThis.copiedText=document.body.children.at(-1).value;return true}");await c.element('copy').handlers.click();assert.equal(c.call('copyCommand'),'copy');assert.equal(c.call('copiedText'),'LAN requested log');assert.equal(c.element('copy').textContent,'已复制');assert.equal(c.call('document.body.children.length'),0);assert.equal(c.element('copy').children[0].attributes['data-icon'],'lucide:copy');
 c.call('document.execCommand=()=>false');await c.element('copy').handlers.click();assert.equal(c.element('copy').textContent,'请手动选择复制');assert.equal(c.call('document.body.children.length'),0);c.call("navigator.clipboard={writeText:()=>new Promise((_resolve,reject)=>globalThis.rejectCopy=reject)};globalThis.fallbackCalled=false;document.execCommand=()=>{globalThis.fallbackCalled=true;return true}");const pending=c.element('copy').handlers.click();c.call("chooseFilter('queued');rejectCopy(Error('denied'))");await pending;assert.equal(c.call('fallbackCalled'),false);assert.equal(c.element('copy').textContent,'复制日志');assert.equal(c.element('copy').attributes['aria-busy'],'false');
});
