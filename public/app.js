const $=id=>document.getElementById(id);
const labels={queued:'等待执行',running:'执行中',passed:'已通过',failed:'未通过',blocked:'受阻',cancelled:'已取消',interrupted:'已中断'};
const taskLabel=status=>status==='running'?'进行中':labels[status]||status;
const stageLabel=step=>step.status==='running'&&!step.command?.length?(stageQueue(run)?'阶段排队':'进行中'):labels[step.status]||step.status;
const statusIcon=(status,override)=>{const label=override||labels[status]||'未知状态',icon=wslIcon('status-'+(Object.hasOwn(labels,status)?status:'interrupted'),{label,className:'symbol '+status}),title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=label;icon.append(title);return icon};
let runs=[],taskGroups=[],run=null,selectedStep=null,offset=0,logText='',selection=0,logBusy=null,manualBusy=false,metadataRequest=null,activeFilter=null;
let activityViewKey=null;
let failureKey=null,failureGeneration=0;
let mobileTasksOpen=false,stageOptionsSignature=null;
let resourcesBusy=false,viewerHost=null,hostProtocol=false;
let devices=[],deviceProtocol=false,deviceSnapshotCurrent=false,unassignedRunIds=[];
const hostName=host=>host?.name||host?.computerName||host?.hostname||'未上报';
const hostDescription=host=>host?[hostName(host),host.computerName&&host.computerName!==hostName(host)?'Windows '+host.computerName:null,host.hostname&&host.hostname!==hostName(host)?'主机名 '+host.hostname:null,host.distro||host.platform].filter(Boolean).join(' · '):'未上报';
const executorCaption=record=>record?.executor?.platform==='github-actions'?'CI执行端':record?.status==='queued'||record?.status==='running'&&!hasRunningCommand(record)?'流程记录':'执行电脑';
const executionText=record=>executorCaption(record)+'：'+hostDescription(record?.executor);
function hostLocation(host){if(host?.platform==='github-actions')return '云端';for(const key of ['computerName','hostname','id'])if(viewerHost?.[key]&&host?.[key])return viewerHost[key].toLowerCase()===host[key].toLowerCase()?'本机':'远程';return '已上报';}
function hostBadge(host,caption='执行电脑'){
 const badge=node('span','','host-badge'+(!host?' unknown':hostLocation(host)==='云端'?' cloud':hostLocation(host)==='远程'?' remote':' local')+(caption==='流程记录'?' recording':''));badge.setAttribute('title',caption+'：'+hostDescription(host));badge.append(wslIcon('server',{className:'host-icon'}),node('span',caption+'：','host-caption'),node('strong',hostName(host),'host-name'));if(host)badge.append(node('span',hostLocation(host),'host-location'));return badge;
}
function renderViewerHost(host){viewerHost=host||null;$('viewer-host').textContent=viewerHost?'工作台：'+hostName(viewerHost):'共享验收工作台';$('viewer-host').setAttribute('title',viewerHost?'工作台所在电脑：'+hostDescription(viewerHost):'当前服务尚未提供工作台主机身份');$('resource-host').replaceChildren(...(viewerHost?[hostBadge(viewerHost,'资源来自')]:[node('span',hostProtocol?'资源主机信息未提供':'旧版服务尚未提供主机信息','host-service-note')]));$('resource-host').setAttribute('title','资源仅来自工作台主机，不随所选任务切换。');}
const deviceStates={online:'在线',unreachable:'无法连接',stale:'状态已过期',unknown:'尚未核验'},deviceWorkloads={executing:'执行中',waiting:'等待中',workflow:'流程记录',idle:'空闲',unconfirmed:'状态待确认'};
const deviceOnline=device=>deviceSnapshotCurrent&&device.onlineState==='online';
const deviceStateText=device=>deviceSnapshotCurrent?(deviceStates[device.onlineState]||deviceStates.unknown):'状态待确认';
const assignedDevices=id=>devices.filter(device=>(device.runs||[]).some(item=>item.id===id));
function deviceResourceText(device){const data=device.resources,windows=data?.windows;if(!data)return 'WSL 资源未上报';const parts=data.state==='stopped'?['WSL 未运行']:[data.state==='unknown'?'WSL 状态未知':'WSL',data.memory?'内存 '+gib(data.memory.usedBytes)+' / '+gib(data.memory.totalBytes)+' · 可用 '+gib(data.memory.availableBytes):'内存未上报',data.swap?'Swap '+gib(data.swap.usedBytes)+' / '+gib(data.swap.totalBytes):null,data.cpu?'CPU '+data.cpu.load1.toFixed(2)+' / '+data.cpu.logicalProcessors+' 核':null].filter(Boolean);if(windows)parts.push('Windows 可用 '+gib(windows.availableBytes));return (deviceOnline(device)?'':'最后采样 · ')+parts.join(' · ');}
function deviceResourceView(device){
 const full=deviceResourceText(device),element=node('span','','device-resources'),data=device.resources; element.setAttribute('aria-label',hostName(device)+'的 WSL 资源：'+full);element.setAttribute('title',full+' · '+(data?.sampledAt?'采样 '+fmt(data.sampledAt):'尚无资源采样时间'));
 if(data?.state!=='running'||!data.memory){element.textContent=full;return element;}
 const line1=node('span','','device-resource-line'),line2=node('span','','device-resource-line'),prefix=deviceOnline(device)?'':'最后采样 · ';
 line1.append(node('span',prefix+'内存 '+gib(data.memory.usedBytes)+' / '+gib(data.memory.totalBytes),'device-metric memory'));
 if(data.windows)line1.append(node('span','Windows 可用 '+gib(data.windows.availableBytes),'device-metric windows'+(deviceOnline(device)&&data.windows.availableBytes<2.5*1024**3?' pressure':'')));
 if(data.cpu)line2.append(node('span','CPU '+data.cpu.load1.toFixed(2)+' / '+data.cpu.logicalProcessors+' 核','device-metric cpu'));
 if(data.swap)line2.append(node('span','Swap '+gib(data.swap.usedBytes)+' / '+gib(data.swap.totalBytes),'device-metric swap'));
 element.append(line1,line2);return element;
}
function renderDevices(){
 const list=$('devices'),left=list.scrollLeft||0,focusedRun=document.activeElement?.getAttribute?.('data-run-id');let focusTarget;list.replaceChildren();$('device-panel').setAttribute('data-protocol',deviceProtocol?'current':'legacy');$('legacy-resources').hidden=deviceProtocol;
 if(!deviceProtocol){$('device-summary').textContent='当前服务尚未提供设备在线状态';$('device-note').textContent='';return;}
 const online=devices.filter(deviceOnline),working=online.filter(device=>device.workload==='executing');
 $('device-summary').textContent=deviceSnapshotCurrent?(working.length?'正在执行：'+working.map(hostName).join('、'):'当前没有已确认正在执行命令的设备')+' · '+online.length+'/'+devices.length+' 在线':'设备状态读取失败，展示最后一次记录';
 $('device-note').textContent=unassignedRunIds.length?unassignedRunIds.length+' 条记录未标注设备':'';
 for(const device of devices){
  const confirmed=deviceOnline(device),active=(device.runs||[]).filter(item=>item.workState!=='history'),target=active.find(item=>item.workState==='executing')||active[0],card=node('article','','device-card qisvc-surface-card'+(confirmed&&device.workload==='executing'?' working':'')),heading=node('div','','device-heading'),identity=node(target?'button':'strong',hostName(device),'device-name'+(target?' device-select':'')),state=node('span',deviceStateText(device),'device-state '+(confirmed?'online':device.onlineState==='unreachable'?'unreachable':'unknown')),location=device.transport==='local'?'本机':device.transport==='ssh'?'远程':hostLocation(device),work=node('span',confirmed?(deviceWorkloads[device.workload]||deviceWorkloads.unconfirmed):'最后上报 · 状态待确认','device-workload');
  card.setAttribute('data-device-id',device.id);identity.setAttribute('title',hostDescription(device));heading.append(wslIcon('server',{className:'device-icon'}),identity,node('span',location,'device-location'),state,work);card.append(heading);
  const detail=[device.detail,device.checkedAt?'核验 '+fmt(device.checkedAt):null,device.lastSeenAt?'最后在线 '+fmt(device.lastSeenAt):null].filter(Boolean).join(' · ');card.setAttribute('title',detail||'尚无设备核验时间');
  if(target){identity.type='button';identity.setAttribute('data-run-id',target.id);identity.setAttribute('aria-label','查看'+hostName(device)+'的任务：'+target.name);identity.setAttribute('title',[hostDescription(device),target.name,target.activity].filter(Boolean).join(' · '));identity.disabled=!runs.some(record=>record.id===target.id);identity.addEventListener('click',()=>{chooseRun(target.id);if(compactMedia?.matches)mobileTasks(false)});if(target.id===focusedRun)focusTarget=identity;}
  card.append(deviceResourceView(device));list.append(card);
 }
 if(!devices.length)list.append(node('span','尚未登记设备','device-empty'));list.scrollLeft=left;focusTarget?.focus?.({preventScroll:true});
}
function renderDeviceAssignment(){
 if(!run){$('device-assignment').textContent='';return;}
 const caption=executorCaption(run),assigned=assignedDevices(run.id),location=hostLocation(run.executor);
 $('device-assignment').textContent=caption==='流程记录'?'暂无执行命令 · '+(run.executor?'记录于'+(location==='已上报'?hostName(run.executor):location):'记录位置未上报'):caption==='CI执行端'?'CI执行端：'+hostName(run.executor)+'（云端）':assigned.length?'归属设备：'+assigned.map(device=>hostName(device)+'（'+deviceStateText(device)+'）').join('、'):deviceProtocol?'此记录未标注设备归属':'';
}
const rememberedSteps=new Map(),rememberedRuns=new Map(),rememberedTaskRuns=new Map();
const filterNames={running:'进行中',queued:'待启动',history:'历史与其他'},filterOf=record=>['running','queued'].includes(record.status)?record.status:'history';
function hasRunningCommand(record){return (record?.steps||[]).some(step=>step.status==='running'&&step.command?.length)}
function stageQueue(record){
 if(record?.status!=='running'||hasRunningCommand(record))return null;
 const reason=typeof record.queueReason==='string'?record.queueReason.trim():'',allSteps=record.steps||[];
 if(reason)return {reason,steps:allSteps.filter(step=>step.status==='queued'&&step.detail?.trim()===reason)};
 // Compatibility with the existing executor's exact metadata contract, not a
 // guess from logs or keywords. Future queued steps do not establish waiting.
 const steps=allSteps.filter(step=>step.status==='queued'&&step.detail?.trim()&&allSteps.some(flow=>flow.status==='running'&&!flow.command?.length&&flow.activity==='阶段等待资源：'+step.detail+'；本阶段命令尚未启动'));
 return steps.length?{reason:steps[0].detail,steps:steps.filter(step=>step.detail===steps[0].detail)}:null;
}
const runLabel=record=>stageQueue(record)?'阶段排队':taskLabel(record.status);
function groupStageQueue(group){return group.running.some(hasRunningCommand)?null:group.running.map(stageQueue).find(Boolean)||null}
const taskKeyOf=record=>record.taskKey?'key:'+record.taskKey:'legacy:'+JSON.stringify([[...(record.projects||[])].sort(),record.name]);
const groupForRun=id=>taskGroups.find(group=>group.runs.some(record=>record.id===id));
const runTime=record=>record.startedAt||record.enqueuedAt||record.updatedAt||record.finishedAt||'';
function groupRuns(records){
 const groups=new Map();for(const record of records){const key=taskKeyOf(record);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(record);}
 return [...groups].map(([key,items])=>{const ordered=[...items].sort((a,b)=>runTime(b).localeCompare(runTime(a))||b.id.localeCompare(a.id)),running=ordered.filter(item=>item.status==='running'),queued=ordered.filter(item=>item.status==='queued'),current=running[0]||queued[0]||ordered[0];return {key,name:current.name,projects:current.projects||[],runs:ordered,current,running,queued,status:running.length?'running':queued.length?'queued':current.status};}).sort((a,b)=>runTime(b.current).localeCompare(runTime(a.current)));
}
const compactMedia=typeof matchMedia==='function'?matchMedia('(max-width:768px)'):null;
const formatCommand=step=>step.command?.map(arg=>/\s/.test(arg)?JSON.stringify(arg):arg).join(' ')||'';
const fmt=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)):'—';
const duration=step=>{const live=step.status==='running',seconds=step.status==='queued'?null:live?(step.startedAt?Math.max(0,Math.floor((Date.now()-new Date(step.startedAt))/1000)):null):step.seconds??(step.startedAt?Math.max(0,Math.floor((new Date(step.finishedAt||Date.now())-new Date(step.startedAt))/1000)):null);if(seconds===null)return '—';return seconds>=60?Math.floor(seconds/60)+'分 '+Math.floor(seconds%60)+'秒':Math.floor(seconds)+'秒'};
const badge=(element,status)=>{element.className='badge '+status;element.textContent=labels[status]||status};
function connection(message,state){$('connection').textContent=message;$('connection').className='connection '+state;}
function node(tag,text,className){const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el}
function buttonLabel(id,icon,text){$(id).replaceChildren(wslIcon(icon,{className:'button-icon'}),node('span',text));}
function legacyCopy(text){if(typeof document.execCommand!=='function')return false;const field=node('textarea','','clipboard-fallback'),previous=document.activeElement;field.value=text;field.setAttribute('readonly','');field.setAttribute('aria-hidden','true');field.setAttribute('tabindex','-1');try{document.body.append(field);field.select();return document.execCommand('copy')===true}catch{return false}finally{field.remove();previous?.focus?.({preventScroll:true});}}
function disclosureIcons(){for(const id of ['activity','failure','source-info'])$(id+'-chevron').replaceChildren(wslIcon($(id).open?'chevron-down':'chevron-right',{className:'disclosure-icon'}));}
function mobileTasks(open){mobileTasksOpen=open;$('task-nav').className='task-sidebar'+(open?' mobile-expanded':'');$('task-toggle').setAttribute('aria-expanded',String(open));$('task-toggle-label').textContent=open?'收起':'任务';$('task-toggle-icon').replaceChildren(wslIcon(open?'chevron-down':'list',{className:'button-icon'}));if(open&&compactMedia?.matches)for(const id of ['activity','failure','source-info'])$(id).open=false;}
async function api(path){const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw Error('读取失败（'+response.status+'）');return response.json()}
const gib=value=>(value/1024**3).toFixed(1)+' GiB';
function renderResources(data){
 $('resource-memory').textContent=data.memory?'内存 '+gib(data.memory.usedBytes)+' 已用 / '+gib(data.memory.availableBytes)+' 可用 / '+gib(data.memory.totalBytes)+' 总量':'内存 未知';
 $('resource-swap').textContent=data.swap?'Swap '+gib(data.swap.usedBytes)+' / '+gib(data.swap.totalBytes):'Swap 未知';
 $('resource-cpu').textContent=data.cpu?'CPU 负载 '+data.cpu.load1.toFixed(2)+' / '+data.cpu.logicalProcessors+' 核':'CPU 负载 未知';
 $('resource-time').textContent=data.sampledAt?'采样 '+fmt(data.sampledAt)+(data.status==='available'?'':data.status==='partial'?' · 部分未知':' · 不可用'):'采样不可用';
 $('legacy-resources').setAttribute('title','工作台主机 WSL：'+['resource-memory','resource-swap','resource-cpu','resource-time'].map(id=>$(id).textContent).join(' · '));
}
async function refreshResources(){if(resourcesBusy||deviceProtocol)return;resourcesBusy=true;try{renderResources(await api('/api/resources'))}catch{renderResources({})}finally{resourcesBusy=false}}
function selected(){return run?.steps.find(step=>step.id===selectedStep)}
function renderTasks(){
 const container=$('tasks'),scroll=container.scrollTop,focusedFilter=document.activeElement?.getAttribute?.('data-filter');container.replaceChildren();
 const tabs=[['running','进行'],['queued','待启动'],['history','历史']].map(([filter,label])=>{const count=taskGroups.filter(item=>filterOf(item)===filter).length,button=node('button',label+' '+count,'task-tab'+(activeFilter===filter?' selected':''));button.type='button';button.setAttribute('data-filter',filter);button.setAttribute('aria-pressed',String(activeFilter===filter));button.setAttribute('aria-label',filterNames[filter]+'任务，'+count+' 个');button.addEventListener('click',()=>chooseFilter(filter));return button}),waitingCount=taskGroups.filter(group=>groupStageQueue(group)).length,waitingNote=node('span','阶段排队 '+waitingCount,'stage-queue-count');waitingNote.id='stage-queue-count';waitingNote.setAttribute('title','已开始的任务中，当前阶段由执行端明确上报等待；任务仍归进行中。');$('task-count').replaceChildren(...tabs,waitingNote);if(focusedFilter)tabs.find(button=>button.getAttribute('data-filter')===focusedFilter)?.focus();
 const records=taskGroups.filter(item=>filterOf(item)===activeFilter),selectedGroup=run&&groupForRun(run.id);
 if(selectedGroup&&filterOf(selectedGroup)!==activeFilter)container.append(node('p','当前任务已转入'+filterNames[filterOf(selectedGroup)]+'，继续保留其详情。','task-notice'));
 for(const group of records){
   const record=group.current,waiting=groupStageQueue(group),displayState=waiting?'阶段排队':taskLabel(group.status),project=group.projects.join(' / ')||'未指定项目',meta=(group.status==='queued'?'入队 '+fmt(record.enqueuedAt)+(record.queuePosition?' · 第 '+record.queuePosition+' 位':' · 顺序未上报'):displayState+' · '+duration(record))+' · '+group.runs.length+' 次记录'+(group.running.length>1?' · '+group.running.length+' 个进行中':'');
   const hosts=[...new Set((group.running.length?group.running:[record]).map(executionText))],hostText=hosts.join('、'),button=node('button','','task'+(group.key===selectedGroup?.key?' selected':''));button.type='button';button.setAttribute('aria-current',group.key===selectedGroup?.key?'true':'false');button.setAttribute('title',group.name+'\n'+project+'\n'+hostText+'\n'+meta);button.setAttribute('aria-label',group.name+'，'+taskLabel(group.status)+'，'+project+'，'+hostText+'，'+meta);
   const heading=node('span','','task-title'),name=node('strong',record.name,'task-name'),symbol=statusIcon(waiting?'queued':group.status,displayState);name.setAttribute('title',record.name);heading.append(symbol,name);if(waiting)heading.append(node('span','阶段排队','task-wait-badge'));
   const projectNode=node('span',project,'task-project'),hostNode=node('span','','task-executor'),timeNode=node('span',meta,'task-time');projectNode.setAttribute('title',project);hostNode.setAttribute('title',hostText);timeNode.setAttribute('title',meta);const hostRuns=group.running.length?group.running:[record],shown=new Set();for(const item of hostRuns){const description=executionText(item);if(item.executor&&!shown.has(description)){shown.add(description);hostNode.append(hostBadge(item.executor,executorCaption(item)));}}hostNode.hidden=!shown.size;button.append(heading,projectNode,hostNode,timeNode);
   const assigned=[...new Set(hostRuns.flatMap(item=>assignedDevices(item.id)))],recording=hostRuns.every(item=>executorCaption(item)==='流程记录');if(assigned.length)button.append(node('span',(recording?'流程记录：':'归属：')+assigned.map(device=>(recording?(device.transport==='local'?'本机':device.transport==='ssh'?'远程':hostName(device)):hostName(device))+' · '+deviceStateText(device)).join('；'),'task-device-state'));
   if(waiting){const text=(waiting.steps.length?waiting.steps.map(step=>step.label).join('、')+'：':'')+waiting.reason;button.append(node('span',text,'task-stage-queue'));button.setAttribute('aria-label',group.name+'，阶段排队，'+project+'，'+hostText+'，'+text);}
   else if(group.status==='running'){const stages=group.running.flatMap(item=>item.steps.filter(step=>step.status==='running')),text=stages.length?stages.map(step=>step.label+(step.activity?'：'+step.activity:'')).join('；'):'当前未上报活动阶段',activity=node('span',text,'task-activity');activity.setAttribute('title',text);button.append(activity);button.setAttribute('aria-label',button.getAttribute('aria-label')+'，'+text);}
   button.addEventListener('click',()=>chooseTask(group.key));container.append(button);
 }if(!records.length)container.append(node('p',taskGroups.length?'暂无'+filterNames[activeFilter]+'任务':'暂无任务记录','task-empty'));container.scrollTop=scroll;
}
function renderSteps(){
 const container=$('steps'),scroll=container.scrollTop;container.replaceChildren();
 for(const step of run?.steps||[]){const button=node('button','','step'+(step.id===selectedStep?' selected':''));button.type='button';button.setAttribute('aria-current',step.id===selectedStep?'step':'false');button.append(statusIcon(stageQueue(run)&&step.status==='running'&&!step.command?.length?'queued':step.status,stageLabel(step)),node('span',step.label,'label'),node('span',duration(step),'duration'));button.setAttribute('aria-label',step.label+'，'+stageLabel(step));button.addEventListener('click',()=>chooseStep(step.id));container.append(button)}
 container.scrollTop=scroll;const steps=run?.steps||[];$('step-count').textContent=run?steps.filter(s=>s.status==='passed').length+' / '+steps.length:'—';
 $('mobile-step-count').textContent=$('step-count').textContent;const picker=$('stage-picker'),signature=JSON.stringify([run?.id,!!stageQueue(run),steps.map(step=>[step.id,step.label,step.status])]);if(signature!==stageOptionsSignature){const placeholder=node('option',steps.length?'选择执行阶段':'暂无阶段');placeholder.value='';placeholder.disabled=true;picker.replaceChildren(placeholder,...steps.map(step=>{const option=node('option',step.label+' · '+stageLabel(step));option.value=step.id;return option}));stageOptionsSignature=signature;}picker.disabled=!steps.length;picker.value=selectedStep||'';const current=selected();picker.setAttribute('title',current?[current.label,stageLabel(current),current.detail].filter(Boolean).join(' · '):'选择执行阶段');picker.setAttribute('aria-label',current?'执行阶段：'+current.label+'，'+stageLabel(current):'选择执行阶段');picker.setAttribute('aria-description',current?.detail||'');
 if(!run){$('test-count').textContent='暂无测试统计';return;}
 const tests=steps.filter(s=>s.tests).reduce((a,s)=>{for(const key of ['pass','fail','skipped'])a[key]+=s.tests[key]||0;return a},{pass:0,fail:0,skipped:0});$('test-count').textContent='测试：'+tests.pass+' 通过 · '+tests.fail+' 失败 · '+tests.skipped+' 跳过';
}
function renderRun(){
 if(!run)return renderEmpty();const group=groupForRun(run.id),waiting=stageQueue(run);$('run-disclosures').hidden=false;$('source-info').hidden=false;$('run-name').textContent=group?.name||run.name;badge($('run-state'),waiting?'queued':run.status);$('run-state').textContent=runLabel(run);$('projects').textContent=(run.projects||[]).join(' / ')||'未指定项目';
 $('stage-queue').hidden=!waiting;$('stage-queue-icon').replaceChildren(...(waiting?[wslIcon('clock',{className:'wait-icon'})]:[]));$('stage-queue-step').textContent=waiting?(waiting.steps.length?waiting.steps.map(step=>step.label).join('、'):'执行端未标注具体阶段'):'';$('stage-queue-reason').textContent=waiting?.reason||'';
 const latest=group?.runs[0];$('run-context').textContent=latest&&run.id!==latest.id&&run.status!==latest.status?'正在查看较早记录，最近一次'+runLabel(latest):'';
 $('started').textContent=run.status==='queued'?'入队于 '+fmt(run.enqueuedAt):'开始于 '+fmt(run.startedAt);$('elapsed').textContent=run.status==='queued'?'尚未开始':'总耗时 '+duration(run);$('queue').textContent=run.status==='queued'?(run.queuePosition?'队列第 '+run.queuePosition+' 位':'队列顺序未上报'):'';
 $('environment').textContent=run.environment||'';$('versions').replaceChildren();
 renderDeviceAssignment();
 $('executor').hidden=!hostProtocol&&!run.executor;$('executor').replaceChildren(...($('executor').hidden?[]:[hostBadge(run.executor,executorCaption(run))]));$('executor').setAttribute('title',executionText(run));
 const provenance={sampled:'执行端采集',reported:'运行记录上报',configured:'数据源配置',manual:'人工记录'},host=run.executor;
 $('executor-info').textContent=executionText(run)+(host?' · 来源：'+(provenance[host.source]||'运行记录上报')+(host.observedAt?' · 记录于 '+fmt(host.observedAt):''):hostProtocol?' · 此记录未包含执行主机信息':' · 旧版服务未提供此字段，无法判断原记录是否包含主机信息');
 for(const version of run.versions||[]){const row=node('div','','version-row');row.append(node('strong',version.name),node('span',version.branch||'工作区'),node('code',(version.head||'').slice(0,12)),node('span','源码快照 '+(version.sha256||'').slice(0,12)));$('versions').append(row)}
 renderTasks();renderSteps();renderStep();renderActivity();loadFailure();$('updated').textContent='记录更新 '+fmt(run.updatedAt);
}
function clearFailure(){failureGeneration++;failureKey=null;$('failure').hidden=true;$('failure').open=false;$('failure-summary').textContent='';$('failure-summary').setAttribute('title','');$('failure-content').replaceChildren();}
function loadFailure(){
 if(!run||run.status!=='failed'&&!run.steps.some(step=>step.status==='failed')){clearFailure();return;}
 const key=JSON.stringify([run.id,run.updatedAt,run.status,run.steps.filter(step=>step.status==='failed').map(step=>step.id)]);if(key===failureKey)return;
 failureKey=key;const stamp=++failureGeneration,id=run.id;$('failure').hidden=false;$('failure-summary').textContent='正在读取';$('failure-summary').setAttribute('title','');$('failure-content').replaceChildren(node('p','正在读取这次运行的失败详情。','failure-note'));
 void api('/api/runs/'+encodeURIComponent(id)+'/failure').then(data=>{
  if(stamp!==failureGeneration||run?.id!==id||failureKey!==key)return;
  const failures=Array.isArray(data.failures)&&data.failures.length?data.failures:[{label:'这次运行',message:'执行端未提供具体失败信息。',source:'missing'}],sources={reported:'执行端上报',log:'来自阶段日志',missing:'未提供具体错误'},first=failures[0];
  $('failure-summary').textContent='· '+failures.length+' 项';$('failure-summary').setAttribute('title',(sources[first.source]||sources.missing)+' · '+first.message);$('failure-content').replaceChildren();
  for(const item of failures){
   const row=node('section','','failure-item'),heading=node('div','','failure-heading');heading.append(node('strong',item.label||'失败阶段'),node('span',(sources[item.source]||sources.missing)+(item.exitCode!==undefined&&item.exitCode!==null?' · 退出码 '+item.exitCode:'')));row.append(heading,node('p',String(item.message||'执行端未提供具体失败信息。'),'failure-message'));
   if(item.excerpt){const excerpt=node('details','','failure-excerpt');excerpt.append(node('summary','查看原文摘录'),node('pre',String(item.excerpt)));row.append(excerpt);}
   if(item.stepId&&run.steps.some(step=>step.id===item.stepId)){const jump=node('button','查看失败阶段日志','failure-jump');jump.type='button';jump.addEventListener('click',()=>chooseStep(item.stepId));row.append(jump);}
   $('failure-content').append(row);
  }
 }).catch(error=>{if(stamp!==failureGeneration||run?.id!==id)return;failureKey=null;$('failure-summary').textContent='暂时无法读取';$('failure-content').replaceChildren(node('p','暂时无法读取这次运行的失败详情：'+error.message+'。','failure-note'));});
}
function renderActivity(){
 const details=$('activity'),content=$('activity-content'),focusedStep=document.activeElement?.getAttribute?.('data-activity-step'),jumps=[];content.replaceChildren();
 if(!run){details.hidden=true;$('activity-summary').textContent='';activityViewKey=null;return;}
 details.hidden=false;const key=run.id+'|'+run.status;if(activityViewKey!==key){details.open=run.status==='running'&&!compactMedia?.matches;activityViewKey=key;}
 const running=run.steps.filter(step=>step.status==='running'),commands=running.filter(step=>step.command?.length),active=running;
 if(run.status==='running'&&running.length){
  $('activity-summary').textContent=commands.length?running.length+' 个阶段进行中':'流程进行中';
  for(const step of active){
   const row=node('div','','activity-row'),heading=node('div','','activity-heading'),jump=node('button','查看日志','activity-jump');jump.type='button';jump.setAttribute('data-activity-step',step.id);jump.setAttribute('aria-label','查看'+step.label+'日志');jump.addEventListener('click',()=>chooseStep(step.id));jumps.push(jump);heading.append(node('strong',step.label),jump);row.append(heading);
   const message=step.activity||[step.detail,formatCommand(step)].filter(Boolean).join(' · ')||'执行端尚未提供阶段说明。';row.append(node('p',message,'activity-message'));
   if(!step.activity)row.append(node('p','暂无细粒度进展上报','activity-fallback'));
   row.append(node('p','开始 '+fmt(step.startedAt)+' · 耗时 '+duration(step)+' · '+(step.activityUpdatedAt?'进展更新 '+fmt(step.activityUpdatedAt):'记录更新 '+fmt(run.updatedAt)),'activity-meta'));content.append(row);
  }
 }else{
  const historical=groupForRun(run.id)?.current.id!==run.id&&!['running','queued'].includes(run.status);$('activity-summary').textContent=(historical?'历史记录 · ':'')+(run.status==='running'?'进行中 · 暂无活动阶段':labels[run.status]||run.status);
  const failed=run.steps.filter(step=>step.status==='failed'),message=run.status==='queued'?'任务等待执行。'+(run.enqueuedAt?'入队 '+fmt(run.enqueuedAt)+'。':'')+(run.queuePosition?'队列第 '+run.queuePosition+' 位。':''):failed.length?'未通过阶段：'+failed.map(step=>step.label).join('、')+'。':run.status==='running'?'任务流程仍标记进行中，当前没有上报正在执行的命令或阶段。':'当前没有正在执行的阶段。';
  content.append(node('p',message,'activity-message'));if(run.finishedAt)content.append(node('p','结束 '+fmt(run.finishedAt),'activity-meta'));
 }
 if(focusedStep)jumps.find(button=>button.getAttribute('data-activity-step')===focusedStep)?.focus();
 disclosureIcons();
}
function renderStep(){
 const step=selected();$('step-meta').replaceChildren();$('step-state').hidden=false;renderLogRefresh();
 if(!step){$('step-name').textContent=run?.error?'任务记录读取受阻':'此任务暂无阶段';$('step-detail').textContent=run?.error||'';badge($('step-state'),run?.status||'queued');$('command').hidden=true;$('command').textContent='';$('log-empty').textContent=run?.error||'执行端尚未上报阶段';return;}
 $('step-name').textContent=step.label;$('step-detail').textContent=step.detail;badge($('step-state'),stageQueue(run)&&step.status==='running'&&!step.command?.length?'queued':step.status);$('step-state').textContent=stageLabel(step);
 if(run.executor){const executor=node('span','日志来自：'+hostName(run.executor),'step-executor');executor.setAttribute('title',executionText(run));$('step-meta').append(executor);}
 for(const value of [step.status==='queued'?'尚未开始':'耗时 '+duration(step),step.startedAt?'开始 '+fmt(step.startedAt):null,step.exitCode!==undefined?'退出码 '+step.exitCode:null,step.tests?'测试 '+step.tests.pass+' 通过 / '+step.tests.fail+' 失败 / '+step.tests.skipped+' 跳过':null].filter(Boolean))$('step-meta').append(node('span',value));
 $('command').hidden=!step.command?.length;$('command').textContent=formatCommand(step);
 if(!logText)$('log-empty').textContent=step.status==='running'?'正在等待新的日志输出':step.status==='queued'?'此阶段尚未开始，无执行日志':step.error||'此阶段尚未产生日志';
}
function renderLogRefresh(){const busy=logBusy?.manual===true;$('refresh-log').disabled=busy||!run||!selected()||run.status==='queued'||selected().status==='queued';$('refresh-log').setAttribute('aria-busy',String(busy));buttonLabel('refresh-log','refresh',busy?'刷新中…':'刷新日志');}
function logLineCount(text){return text?text.split('\n').length-(text.endsWith('\n')?1:0):0;}
function renderLog(){const count=logLineCount(logText);$('log').textContent=logText;$('log-numbers').textContent=Array.from({length:count},(_,index)=>index+1).join('\n');$('log-content').hidden=!logText;}
function resetLog(){selection++;offset=0;logText='';logBusy=null;renderLog();$('log-empty').hidden=false;$('copy').disabled=true;$('copy').setAttribute('aria-busy','false');buttonLabel('copy','copy','复制日志');$('log-summary').textContent='实时日志';$('log-size').textContent='0 B';$('log-view').scrollTop=0;renderLogRefresh();}
function renderEmpty(){
 clearFailure();
 $('stage-queue').hidden=true;$('stage-queue-reason').textContent='';$('stage-queue-step').textContent='';$('stage-queue-icon').replaceChildren();
 const message='暂无'+filterNames[activeFilter]+'任务';$('run-name').textContent=message;$('run-state').className='badge';$('run-state').textContent='暂无任务';
 for(const id of ['projects','started','elapsed','queue','run-context','environment','updated','executor','executor-info','device-assignment'])$(id).textContent='';$('versions').replaceChildren();$('source-info').hidden=true;$('run-disclosures').hidden=true;renderActivity();$('history').value='';
 $('step-name').textContent=message;$('step-detail').textContent='选择其他分类查看任务记录。';$('step-state').hidden=true;$('step-state').textContent='';$('step-meta').replaceChildren();$('command').textContent='';$('command').hidden=true;$('log-empty').textContent=message+'，可切换其他分类。';renderTasks();renderSteps();renderHistory();
}
function chooseFilter(filter){
 if(!Object.hasOwn(filterNames,filter)||filter===activeFilter)return;activeFilter=filter;
 const records=taskGroups.filter(item=>filterOf(item)===filter),current=run&&groupForRun(run.id),remembered=runs.find(item=>item.id===rememberedRuns.get(filter)),target=current&&filterOf(current)===filter?run:remembered&&records.some(group=>group.runs.includes(remembered))?remembered:records[0]?.current;
 if(target)chooseRun(target.id);else{run=null;selectedStep=null;resetLog();renderEmpty();}
}
function chooseStep(id){if(id===selectedStep)return;selectedStep=id||null;if(run&&id)rememberedSteps.set(run.id,id);resetLog();renderSteps();renderStep();pollLog()}
function chooseTask(key){const group=taskGroups.find(item=>item.key===key);if(!group)return;const target=run&&group.runs.some(item=>item.id===run.id)?run:group.runs.find(item=>item.id===rememberedTaskRuns.get(key))||group.current;chooseRun(target.id);if(compactMedia?.matches)mobileTasks(false);}
function renderHistory(){const placeholder=node('option','选择运行记录');placeholder.value='';placeholder.disabled=true;const group=run&&groupForRun(run.id),history=$('history');$('history-caption').textContent='运行记录'+(group?'（'+group.runs.length+'）':'');history.replaceChildren(placeholder,...(group?.runs||[]).map(record=>{const option=node('option',fmt(record.startedAt||record.enqueuedAt)+' · '+runLabel(record)+(record.executor?' · '+hostName(record.executor):hostProtocol?' · 主机未记录':''));option.value=record.id;return option}));history.value=run?.id||'';history.disabled=!group;}
function chooseRun(id){
 const record=runs.find(item=>item.id===id),group=record&&groupForRun(id);if(!record||!group)return;activeFilter=filterOf(group);rememberedRuns.set(activeFilter,id);rememberedTaskRuns.set(group.key,id);if(record.id===run?.id){run=record;renderRun();renderHistory();return;}clearFailure();run=record;selectedStep=null;resetLog();
 const remembered=rememberedSteps.get(id);const next=run.steps.find(s=>s.id===remembered)||run.steps.find(s=>s.status==='running')||run.steps.find(s=>s.status==='failed')||run.steps[0];
 if(next)chooseStep(next.id);renderRun();renderHistory();
}
function applyMetadata(data){
 hostProtocol=Object.hasOwn(data,'viewerHost');
 renderViewerHost(data.viewerHost);
 runs=data.runs;deviceProtocol=Array.isArray(data.devices);devices=deviceProtocol?data.devices:[];deviceSnapshotCurrent=true;unassignedRunIds=Array.isArray(data.unassignedRuns)?data.unassignedRuns:[];renderDevices();taskGroups=groupRuns(runs);const previous=selected();if(activeFilter===null)activeFilter=taskGroups.some(item=>item.status==='running')?'running':taskGroups.some(item=>item.status==='queued')?'queued':'history';
 if(run){
  const latest=runs.find(record=>record.id===run.id);
  if(latest){run=latest;if(selectedStep&&!selected()){selectedStep=null;resetLog();}else if(previous?.startedAt!==selected()?.startedAt){resetLog();}renderRun();}
  else{connection('当前任务已从数据源移除，保留已读取结果','warning');renderTasks();return;}
 }else{const records=taskGroups.filter(item=>filterOf(item)===activeFilter),remembered=runs.find(item=>item.id===rememberedRuns.get(activeFilter)),target=remembered&&records.some(group=>group.runs.includes(remembered))?remembered:records[0]?.current;if(target)chooseRun(target.id);else renderEmpty();}
 renderHistory();
 connection('实时连接','connected');
}
async function refresh(manual=false){
 if(manual&&manualBusy)return;if(manual){manualBusy=true;$('refresh').disabled=true;$('refresh').setAttribute('aria-busy','true');buttonLabel('refresh','refresh','刷新中…');}
 // A manual refresh can join the background read without starting a second request.
 if(!metadataRequest)metadataRequest=api('/api/runs').then(applyMetadata).finally(()=>{metadataRequest=null});
 try{await metadataRequest}catch(error){deviceSnapshotCurrent=false;renderDevices();renderDeviceAssignment();renderTasks();connection(error.message+'，保留已读取结果','error')}
 finally{if(manual){manualBusy=false;$('refresh').disabled=false;$('refresh').setAttribute('aria-busy','false');buttonLabel('refresh','refresh','刷新状态')}}
}
async function pollLog(manual=false){
 if(!run||!selectedStep||selected()?.status==='queued'||run.status==='queued'||logBusy&&(logBusy.manual||!manual))return;
 const stamp=selection,runId=run.id,stepId=selectedStep,request={manual};logBusy=request;renderLogRefresh();
 try{
  const path='/api/runs/'+encodeURIComponent(runId)+'/steps/'+encodeURIComponent(stepId)+'/log?offset=';
  let data=await api(path+(manual?0:offset));if(stamp!==selection||logBusy!==request)return;
  if(manual){const target=data.total;let text=data.text||'',truncated=false;while(data.nextOffset<target){const previous=data.nextOffset,next=await api(path+previous);if(stamp!==selection||logBusy!==request)return;if(next.reset||next.nextOffset<=previous)throw Error('日志在读取期间发生变化，请重新刷新');text+=next.text||'';if(text.length>1500000){text=text.slice(-1500000);truncated=true}data=next;}data={...data,text:(truncated?'[仅显示最近 1.5MB 日志]\n':'')+text};}
  const view=$('log-view'),scrollTop=view.scrollTop,scrollLeft=view.scrollLeft;
  if(manual||data.reset){offset=0;logText='';}offset=data.nextOffset;
  if(data.text||manual||data.reset){logText+=(data.text||'').replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/\r(?!\n)/g,'\n');if(logText.length>1500000)logText='[仅显示最近 1.5MB 日志]\n'+logText.slice(-1500000);renderLog();$('log-empty').hidden=Boolean(logText);$('copy').disabled=!logText||$('copy').getAttribute('aria-busy')==='true';if($('follow').checked)view.scrollTop=view.scrollHeight;else{view.scrollTop=scrollTop;view.scrollLeft=scrollLeft}}
  $('log-size').textContent=(data.total/1024).toFixed(1)+' KiB';$('log-summary').textContent=data.total?'运行日志 · '+logLineCount(logText)+' 行':'实时日志';
 }catch(error){if(stamp===selection&&logBusy===request)$('log-summary').textContent=error.message}finally{if(stamp===selection&&logBusy===request){logBusy=null;renderLogRefresh()}}
}
$('history').addEventListener('change',event=>{chooseRun(event.target.value);if(compactMedia?.matches)mobileTasks(false)});$('refresh').addEventListener('click',()=>refresh(true));$('stage-picker').addEventListener('change',event=>chooseStep(event.target.value));$('task-toggle').addEventListener('click',()=>mobileTasks(!mobileTasksOpen));
$('copy').addEventListener('click',async()=>{const stamp=selection,text=logText;$('copy').disabled=true;$('copy').setAttribute('aria-busy','true');buttonLabel('copy','copy','复制中…');let copied=false;try{if(typeof navigator.clipboard?.writeText==='function')try{await navigator.clipboard.writeText(text);copied=true}catch{}if(stamp!==selection)return;if(!copied)copied=legacyCopy(text);buttonLabel('copy','copy',copied?'已复制':'请手动选择复制')}finally{if(stamp===selection){$('copy').disabled=!logText;$('copy').setAttribute('aria-busy','false')}}});
$('refresh-log').addEventListener('click',()=>pollLog(true));
$('follow').addEventListener('change',()=>{if($('follow').checked)$('log-view').scrollTop=$('log-view').scrollHeight});
compactMedia?.addEventListener('change',event=>{if(event.matches)$('activity').open=false});
for(const id of ['activity','failure','source-info'])$(id).addEventListener('toggle',()=>{if($(id).open){for(const other of ['activity','failure','source-info'])if(other!==id)$(other).open=false;if(compactMedia?.matches)mobileTasks(false)}disclosureIcons();});
$('failure-status-icon').replaceChildren(wslIcon('status-failed',{className:'disclosure-icon'}));disclosureIcons();
mobileTasks(false);buttonLabel('refresh','refresh','刷新状态');buttonLabel('copy','copy','复制日志');renderLogRefresh();refresh();refreshResources();setInterval(refreshResources,5000);setInterval(()=>refresh(),2500);setInterval(pollLog,1000);setInterval(()=>{if(run){$('elapsed').textContent=run.status==='queued'?'尚未开始':'总耗时 '+duration(run);renderStep();if($('activity').open)renderActivity()}},1000);
