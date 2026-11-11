const $=id=>document.getElementById(id);
const labels={queued:'等待执行',running:'执行中',passed:'已通过',failed:'未通过',blocked:'受阻',cancelled:'已取消',interrupted:'已中断',workflow:'流程记录',unconfirmed:'状态待确认'};
const taskLabel=status=>status==='running'?'进行中':labels[status]||status;
const stageLabel=step=>step.status==='running'?(stageVisualState(step)==='queued'?'阶段排队':labels[stageVisualState(step)]):labels[step.status]||step.status;
const statusIcon=(status,override)=>{const label=override||labels[status]||'未知状态',glyph=status==='workflow'?'queued':status==='unconfirmed'?'interrupted':Object.hasOwn(labels,status)?status:'interrupted',icon=wslIcon('status-'+glyph,{label,className:'symbol '+status}),title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=label;icon.append(title);return icon};
let runs=[],taskGroups=[],run=null,selectedStep=null,offset=0,logText='',selection=0,logBusy=null,manualBusy=false,metadataRequest=null,activeFilter=null;
let activityViewKey=null;
let failureKey=null,failureGeneration=0;
let mobileTasksOpen=false,stageOptionsSignature=null;
let resourcesBusy=false,viewerHost=null,hostProtocol=false,metadataCurrent=true;
let devices=[],deviceProtocol=false,deviceSnapshotCurrent=false,unassignedRunIds=[],deviceSnapshotReason='';
let logObservation=null,logObservedAt=null,logEmptySignature=null;
let logCursor=null,logFallbackReadAt=0,logFallbackPending=false;
let sourceViewSignature=null;
const deviceRegistry=new Map(),deviceNodes=new Map(),taskNodes=new Map(),stepNodes=new Map(),filterNodes=new Map();
const hostName=host=>host?.name||host?.computerName||host?.hostname||'未上报';
const hostDescription=host=>host?[hostName(host),host.computerName&&host.computerName!==hostName(host)?'Windows '+host.computerName:null,host.hostname&&host.hostname!==hostName(host)?'主机名 '+host.hostname:null,host.distro||host.platform].filter(Boolean).join(' · '):'未上报';
const executorCaption=record=>record?.executor?.platform==='github-actions'?'CI执行端':record?.status==='queued'||record?.status==='running'&&!hasRunningCommand(record)?'流程记录':'执行电脑';
const executionText=record=>executorCaption(record)+(record?.status==='running'&&runWorkState(record)==='unconfirmed'?'（上次上报）':'')+'：'+hostDescription(record?.executor);
const stepExecutor=(step,record)=>Object.hasOwn(step,'executor')?step.executor:record?.executor;
const recordController=(record,step)=>step&&Object.hasOwn(step,'controller')?step.controller:Object.hasOwn(record,'controller')?record.controller:record.executor;
function executionViews(record){const active=record.status==='running'?record.steps.filter(step=>step.status==='running'&&step.command?.length):[];return active.some(step=>Object.hasOwn(step,'executor'))?active.map(step=>({...record,executor:stepExecutor(step,record),workState:step.workState||record.workState,observation:step.observation||record.observation})):[record];}
function hostLocation(host){if(host?.platform==='github-actions')return '云端';const equal=(a,b)=>a.toLowerCase()===b.toLowerCase(),generic=value=>/^(localhost(?:\.localdomain)?|ubuntu|wsl)$/i.test(value||'');if(viewerHost?.computerName&&host?.computerName)return equal(viewerHost.computerName,host.computerName)?'本机':'远程';if(viewerHost?.id&&host?.id&&equal(viewerHost.id,host.id))return '本机';if(viewerHost?.hostname&&host?.hostname&&!generic(viewerHost.hostname)&&!generic(host.hostname))return equal(viewerHost.hostname,host.hostname)?'本机':'远程';return '已上报';}
function hostBadge(host,caption='执行电脑',uncertain=false){
 const badge=node('span','','host-badge'+(!host?' unknown':hostLocation(host)==='云端'?' cloud':hostLocation(host)==='远程'?' remote':' local')+(caption==='流程记录'?' recording':'')+(uncertain?' unconfirmed':'')),prefix=caption+(uncertain?'（上次上报）':'');badge.setAttribute('title',prefix+'：'+hostDescription(host));badge.append(wslIcon('server',{className:'host-icon'}),node('span',prefix+'：','host-caption'),node('strong',hostName(host),'host-name'));if(host)badge.append(node('span',hostLocation(host),'host-location'));return badge;
}
function renderViewerHost(host,current=true){viewerHost=host||null;$('viewer-host').textContent=viewerHost?(current?'工作台：':'工作台（上次）：')+hostName(viewerHost):'共享验收工作台';$('viewer-host').setAttribute('title',viewerHost?(current?'工作台所在电脑：':'上次提供的工作台身份：')+hostDescription(viewerHost):'当前服务尚未提供工作台主机身份');$('resource-host').replaceChildren(...(viewerHost&&current?[hostBadge(viewerHost,'资源来自')]:[node('span',hostProtocol?'资源主机信息未提供':'旧版服务尚未提供主机信息','host-service-note')]));$('resource-host').setAttribute('title','资源仅来自工作台主机，不随所选任务切换。');}
const deviceStates={online:'在线',unreachable:'无法连接',stale:'状态已过期',unknown:'尚未核验'},deviceWorkloads={executing:'执行中',waiting:'等待中',workflow:'流程记录',idle:'空闲',unconfirmed:'状态待确认'};
const deviceOnline=device=>deviceSnapshotCurrent&&device.current!==false&&device.onlineState==='online';
const deviceStateText=device=>deviceSnapshotCurrent&&device.current!==false?(deviceStates[device.onlineState]||deviceStates.unknown):'状态待确认';
const assignedDevices=id=>devices.filter(device=>(device.runs||[]).some(item=>item.id===id));
const resourceData=device=>device.resources?.state==='running'&&device.resources.memory?device.resources:device.resources?.state==='stopped'?device.resources:device.lastResources||device.resources;
const resourcesCurrent=device=>deviceOnline(device)&&device.resources===resourceData(device);
function acceptDevices(data){
 const reported=Array.isArray(data.devices),seen=new Set();deviceSnapshotCurrent=reported;deviceSnapshotReason=reported?'':'当前服务未提供设备状态，展示最后一次记录';
 if(reported)for(const incoming of data.devices){if(!incoming||typeof incoming.id!=='string')continue;const previous=deviceRegistry.get(incoming.id),good=incoming.resources?.state==='running'&&incoming.resources.memory;deviceRegistry.set(incoming.id,{...previous,...incoming,current:true,lastResources:good?incoming.resources:previous?.lastResources});seen.add(incoming.id);}
 for(const [id,device] of deviceRegistry)if(!seen.has(id))deviceRegistry.set(id,{...device,current:false});
 devices=[...deviceRegistry.values()];deviceProtocol=reported||devices.length>0;unassignedRunIds=Array.isArray(data.unassignedRuns)?data.unassignedRuns:unassignedRunIds;
}
function deviceResourceText(device){const data=resourceData(device),windows=data?.windows;if(!data)return 'WSL 资源未上报';const parts=data.state==='stopped'?['WSL 未运行']:[device.resources?.state==='unknown'||!device.resources?'WSL 状态待确认':'WSL',data.memory?'内存 '+gib(data.memory.usedBytes)+' / '+gib(data.memory.totalBytes)+' · 可用 '+gib(data.memory.availableBytes):'内存未上报',data.swap?'Swap '+gib(data.swap.usedBytes)+' / '+gib(data.swap.totalBytes):'Swap 未确认',data.cpu?'CPU '+data.cpu.load1.toFixed(2)+' / '+data.cpu.logicalProcessors+' 核':'CPU 未确认'].filter(Boolean);parts.push(windows?'Windows 可用 '+gib(windows.availableBytes):'Windows 可用未确认');return (resourcesCurrent(device)?'':'最后采样 · ')+parts.join(' · ');}
function deviceResourceView(device){
 const full=deviceResourceText(device),element=node('span','','device-resources'),data=resourceData(device); element.setAttribute('aria-label',hostName(device)+'的 WSL 资源：'+full);element.setAttribute('title',full+' · '+(data?.sampledAt?'采样 '+fmt(data.sampledAt):'尚无资源采样时间'));
 if(data?.state!=='running'||!data.memory){element.textContent=full;return element;}
 const line1=node('span','','device-resource-line'),line2=node('span','','device-resource-line'),prefix=resourcesCurrent(device)?'':'最后采样 · ';
 line1.append(node('span',prefix+'内存 '+gib(data.memory.usedBytes)+' / '+gib(data.memory.totalBytes),'device-metric memory'));
 line1.append(node('span',data.windows?'Windows 可用 '+gib(data.windows.availableBytes):'Windows 可用未确认','device-metric windows'+(resourcesCurrent(device)&&data.windows&&data.windows.availableBytes<2.5*1024**3?' pressure':'')));
 line2.append(node('span',data.cpu?'CPU '+data.cpu.load1.toFixed(2)+' / '+data.cpu.logicalProcessors+' 核':'CPU 未确认','device-metric cpu'));
 line2.append(node('span',data.swap?'Swap '+gib(data.swap.usedBytes)+' / '+gib(data.swap.totalBytes):'Swap 未确认','device-metric swap'));
 element.append(line1,line2);return element;
}
function renderDevices(){
 const list=$('devices'),left=list.scrollLeft||0;$('device-panel').setAttribute('data-protocol',deviceProtocol?'current':'legacy');$('legacy-resources').hidden=deviceProtocol;
 if(!deviceProtocol){$('device-summary').textContent='当前服务尚未提供设备在线状态';$('device-note').textContent='';return;}
 const online=devices.filter(deviceOnline),working=online.filter(device=>device.workload==='executing');
 $('device-summary').textContent=deviceSnapshotCurrent?(working.length?'正在执行：'+working.map(hostName).join('、'):'当前没有已确认正在执行命令的设备')+' · '+online.length+'/'+devices.length+' 在线':deviceSnapshotReason||'设备状态读取失败，展示最后一次记录';
 $('device-note').textContent=unassignedRunIds.length?unassignedRunIds.length+' 条记录未标注设备':'';
 for(const device of devices){
  const confirmed=deviceOnline(device),active=(device.runs||[]).filter(item=>item.workState!=='history'),target=active.find(item=>item.workState==='executing')||active[0];let view=deviceNodes.get(device.id);
  if(!view){const card=node('article','','device-card qisvc-surface-card'),heading=node('div','','device-heading'),identity=node('button','','device-name device-select'),location=node('span','','device-location'),state=node('span','','device-state'),work=node('span','','device-workload');identity.type='button';heading.append(wslIcon('server',{className:'device-icon'}),identity,location,state,work);card.append(heading);view={card,identity,location,state,work,target:null};identity.addEventListener('click',()=>{if(view.target){chooseRun(view.target);if(compactMedia?.matches)mobileTasks(false)}});deviceNodes.set(device.id,view);list.append(card);}
  const {card,identity,location,state,work}=view;card.className='device-card qisvc-surface-card'+(confirmed&&device.workload==='executing'?' working':'');identity.textContent=hostName(device);identity.setAttribute('title',hostDescription(device));location.textContent=device.transport==='local'?'本机':device.transport==='ssh'?'远程':hostLocation(device);state.textContent=deviceStateText(device);state.className='device-state '+(confirmed?'online':device.onlineState==='unreachable'?'unreachable':'unknown');work.textContent=confirmed?(deviceWorkloads[device.workload]||deviceWorkloads.unconfirmed):'最后上报 · 状态待确认';card.setAttribute('data-device-id',device.id);
  const detail=[device.detail,device.checkedAt?'核验 '+fmt(device.checkedAt):null,device.lastSeenAt?'最后在线 '+fmt(device.lastSeenAt):null].filter(Boolean).join(' · ');card.setAttribute('title',detail||'尚无设备核验时间');
  view.target=target?.id||null;identity.setAttribute('data-run-id',target?.id||'');identity.setAttribute('aria-label',target?'查看'+hostName(device)+'的任务：'+target.name:hostName(device)+'，暂无活动任务');identity.disabled=!target||!runs.some(record=>record.id===target.id);if(target)identity.setAttribute('title',[hostDescription(device),target.name,target.activity].filter(Boolean).join(' · '));
  const resourceScroll=view.resources?{top:view.resources.scrollTop,left:view.resources.scrollLeft}:null;view.resources?.remove();view.resources=deviceResourceView(device);card.append(view.resources);if(resourceScroll){view.resources.scrollTop=resourceScroll.top;view.resources.scrollLeft=resourceScroll.left;}
 }
 if(!devices.length&&!list.children.length)list.append(node('span','尚未登记设备','device-empty'));if(devices.length)for(const child of [...list.children])if(child.className==='device-empty')child.remove();list.scrollLeft=left;
}
function renderDeviceAssignment(){
 if(!run){$('device-assignment').textContent='';return;}
 const caption=executorCaption(run),assigned=assignedDevices(run.id),location=hostLocation(run.executor);
 const uncertain=run.status==='running'&&runWorkState(run)==='unconfirmed';$('device-assignment').textContent=caption==='流程记录'?'暂无执行命令 · '+(run.executor?'记录于'+(location==='已上报'?hostName(run.executor):location):'记录位置未上报')+(uncertain?' · 流程状态待确认':''):caption==='CI执行端'?'CI执行端：'+hostName(run.executor)+'（云端）'+(uncertain?' · 结果待确认':''):assigned.length?(uncertain?'上次执行设备：':'归属设备：')+assigned.map(device=>hostName(device)+'（'+deviceStateText(device)+'）').join('、')+(uncertain?' · 任务结果待确认':''):deviceProtocol?'此记录未标注设备归属':'';
}
const rememberedSteps=new Map(),rememberedRuns=new Map(),rememberedTaskRuns=new Map();
const filterNames={running:'进行中',queued:'待启动',history:'历史与其他'},filterOf=record=>['running','queued'].includes(record.status)?record.status:'history';
function hasRunningCommand(record){return (record?.steps||[]).some(step=>step.status==='running'&&step.command?.length)}
function runWorkState(record){if(!record||!['running','queued'].includes(record.status))return 'history';if(!metadataCurrent)return 'unconfirmed';return ['executing','waiting','workflow','unconfirmed'].includes(record.workState)?record.workState:record.status==='queued'?'waiting':'unconfirmed';}
function stageVisualState(step,record=run){if(step.status!=='running')return step.status;const state=runWorkState(record);if(state==='unconfirmed'||step.workState==='unconfirmed')return 'unconfirmed';if(!step.command?.length)return state==='waiting'||stageQueue(record)?'queued':'workflow';return state==='executing'?'running':'unconfirmed';}
function groupVisualState(group){if(group.running.some(record=>runWorkState(record)==='executing'&&(hasRunningCommand(record)||record.executor?.platform==='github-actions')))return 'running';if(group.running.some(record=>runWorkState(record)==='workflow'))return 'workflow';if(group.running.some(record=>runWorkState(record)==='waiting'))return 'queued';return group.running.length?'unconfirmed':group.status;}
function stageQueue(record){
 if(record?.status!=='running'||hasRunningCommand(record)||runWorkState(record)==='unconfirmed')return null;
 const reason=typeof record.queueReason==='string'?record.queueReason.trim():'',allSteps=record.steps||[];
 if(reason)return {reason,steps:allSteps.filter(step=>step.status==='queued'&&step.detail?.trim()===reason)};
 // Compatibility with the existing executor's exact metadata contract, not a
 // guess from logs or keywords. Future queued steps do not establish waiting.
 const steps=allSteps.filter(step=>step.status==='queued'&&step.detail?.trim()&&allSteps.some(flow=>flow.status==='running'&&!flow.command?.length&&flow.activity==='阶段等待资源：'+step.detail+'；本阶段命令尚未启动'));
 return steps.length?{reason:steps[0].detail,steps:steps.filter(step=>step.detail===steps[0].detail)}:null;
}
const runLabel=record=>record.status==='running'&&runWorkState(record)==='unconfirmed'?'状态待确认':stageQueue(record)?'阶段排队':record.status==='running'&&runWorkState(record)==='executing'?'执行中':taskLabel(record.status);
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
const fmt=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)):'—';
const duration=(step,record=run)=>{const owner=Array.isArray(step.steps)?step:record,uncertain=step.status==='running'&&(step.workState==='unconfirmed'||runWorkState(owner)==='unconfirmed'),end=uncertain?step.observation?.lastHeartbeatAt||owner?.observation?.lastHeartbeatAt:Date.now(),live=step.status==='running',seconds=step.status==='queued'?null:live?(step.startedAt&&(!uncertain||end)?Math.max(0,Math.floor((new Date(end)-new Date(step.startedAt))/1000)):null):step.seconds??(step.startedAt?Math.max(0,Math.floor((new Date(step.finishedAt||Date.now())-new Date(step.startedAt))/1000)):null);if(seconds===null||!Number.isFinite(seconds))return '—';return seconds>=60?Math.floor(seconds/60)+'分 '+Math.floor(seconds%60)+'秒':Math.floor(seconds)+'秒'};
const badge=(element,status)=>{element.className='badge '+status;element.textContent=labels[status]||status};
function connection(message,state){$('connection').textContent=message;$('connection').className='connection '+state;}
function node(tag,text,className){const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el}
function buttonLabel(id,icon,text){$(id).replaceChildren(wslIcon(icon,{className:'button-icon'}),node('span',text));}
function legacyCopy(text){if(typeof document.execCommand!=='function')return false;const field=node('textarea','','clipboard-fallback'),previous=document.activeElement;field.value=text;field.setAttribute('readonly','');field.setAttribute('aria-hidden','true');field.setAttribute('tabindex','-1');try{document.body.append(field);field.select();return document.execCommand('copy')===true}catch{return false}finally{field.remove();previous?.focus?.({preventScroll:true});}}
function disclosureIcons(){for(const id of ['activity','failure','source-info'])$(id+'-chevron').replaceChildren(wslIcon($(id).open?'chevron-down':'chevron-right',{className:'disclosure-icon'}));}
function mobileTasks(open){mobileTasksOpen=open;$('task-nav').className='task-sidebar'+(open?' mobile-expanded':'');$('task-toggle').setAttribute('aria-expanded',String(open));$('task-toggle-label').textContent=open?'收起':'任务';$('task-toggle-icon').replaceChildren(wslIcon(open?'chevron-down':'list',{className:'button-icon'}));if(open&&compactMedia?.matches)for(const id of ['activity','failure','source-info'])$(id).open=false;}
async function api(path){try{const response=await fetch(path,{cache:'no-store',...(typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?{signal:AbortSignal.timeout(15000)}:{})});if(!response.ok)throw Error('读取失败（'+response.status+'）');return await response.json()}catch(error){if(error.name==='TimeoutError')throw Error('读取超时');throw error;}}
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
function reconcileChildren(container,children){for(const child of [...container.children])if(!children.includes(child))child.remove();for(let index=0;index<children.length;index++)if(container.children[index]!==children[index])container.insertBefore(children[index],container.children[index]||null);}
function renderTasks(){
 const container=$('tasks'),scroll=container.scrollTop,focusedTask=document.activeElement?.getAttribute?.('data-task-key'),children=[];
 const tabs=[['running','进行'],['queued','待启动'],['history','历史']].map(([filter,label])=>{let button=filterNodes.get(filter);if(!button){button=node('button','');button.type='button';button.setAttribute('data-filter',filter);button.addEventListener('click',()=>chooseFilter(filter));filterNodes.set(filter,button);}const count=taskGroups.filter(item=>filterOf(item)===filter).length;button.textContent=label+' '+count;button.className='task-tab'+(activeFilter===filter?' selected':'');button.setAttribute('aria-pressed',String(activeFilter===filter));button.setAttribute('aria-label',filterNames[filter]+'任务，'+count+' 个');return button;});let waitingNote=filterNodes.get('waiting');if(!waitingNote){waitingNote=node('span','','stage-queue-count');waitingNote.id='stage-queue-count';waitingNote.setAttribute('title','已开始的任务中，当前阶段由执行端明确上报等待；任务仍归进行中。');filterNodes.set('waiting',waitingNote);}waitingNote.textContent='阶段排队 '+taskGroups.filter(group=>groupStageQueue(group)).length;reconcileChildren($('task-count'),[...tabs,waitingNote]);
 const records=taskGroups.filter(item=>filterOf(item)===activeFilter),selectedGroup=run&&groupForRun(run.id);
 if(selectedGroup&&filterOf(selectedGroup)!==activeFilter)children.push(node('p','当前任务已转入'+filterNames[filterOf(selectedGroup)]+'，继续保留其详情。','task-notice'));
 for(const group of records){
   const record=group.current,waiting=groupStageQueue(group),visual=waiting?'queued':groupVisualState(group),displayState=visual==='unconfirmed'?'状态待确认':waiting?'阶段排队':taskLabel(group.status),project=group.projects.join(' / ')||'未指定项目',meta=(group.status==='queued'?'入队 '+fmt(record.enqueuedAt)+(record.queuePosition?' · 第 '+record.queuePosition+' 位':' · 顺序未上报'):displayState+' · '+duration(record))+' · '+group.runs.length+' 次记录'+(group.running.length>1?' · '+group.running.length+' 个进行中':'');
   const hostRuns=group.running.length?group.running:[record],placements=hostRuns.flatMap(executionViews),hostText=[...new Set(placements.map(executionText))].join('、');let view=taskNodes.get(group.key);
   if(!view){const button=node('button','','task'),heading=node('span','','task-title'),name=node('strong','','task-name');button.type='button';button.setAttribute('data-task-key',group.key);button.addEventListener('click',()=>chooseTask(group.key));view={button,heading,name,project:node('span','','task-project'),host:node('span','','task-executor'),time:node('span','','task-time'),assignment:node('span','','task-device-state'),waiting:node('span','','task-stage-queue'),activity:node('span','','task-activity'),symbolKey:null};taskNodes.set(group.key,view);}
   const {button,heading,name}=view;button.className='task'+(group.key===selectedGroup?.key?' selected':'')+(visual==='unconfirmed'?' unconfirmed':'');button.setAttribute('aria-current',group.key===selectedGroup?.key?'true':'false');button.setAttribute('title',group.name+'\n'+project+'\n'+hostText+'\n'+meta);button.setAttribute('aria-label',group.name+'，'+displayState+'，'+project+'，'+hostText+'，'+meta);name.textContent=record.name;name.setAttribute('title',record.name);
   const symbolKey=visual+'|'+displayState;if(symbolKey!==view.symbolKey){heading.replaceChildren(statusIcon(visual,visual==='running'?'执行中':displayState),name);view.symbolKey=symbolKey;}if(waiting){view.waitBadge??=node('span','阶段排队','task-wait-badge');if(![...heading.children].includes(view.waitBadge))heading.append(view.waitBadge);}else if(view.waitBadge){view.waitBadge.remove();view.waitBadge=null;}
   view.project.textContent=project;view.project.setAttribute('title',project);view.host.setAttribute('title',hostText);view.host.replaceChildren();const shown=new Set();for(const item of placements){const description=executionText(item);if(item.executor&&!shown.has(description)){shown.add(description);view.host.append(hostBadge(item.executor,executorCaption(item),item.status==='running'&&runWorkState(item)==='unconfirmed'));}}view.host.hidden=!shown.size;view.time.textContent=meta;view.time.setAttribute('title',meta);const parts=[heading,view.project,view.host,view.time];
   const assigned=[...new Set(hostRuns.flatMap(item=>assignedDevices(item.id)))],recording=hostRuns.every(item=>executorCaption(item)==='流程记录');if(assigned.length){view.assignment.textContent=(recording?'流程记录：':'归属：')+assigned.map(device=>(recording?(device.transport==='local'?'本机':device.transport==='ssh'?'远程':hostName(device)):hostName(device))+' · '+deviceStateText(device)).join('；');parts.push(view.assignment);}
   if(waiting){const text=(waiting.steps.length?waiting.steps.map(step=>step.label).join('、')+'：':'')+waiting.reason;view.waiting.textContent=text;parts.push(view.waiting);button.setAttribute('aria-label',group.name+'，阶段排队，'+project+'，'+hostText+'，'+text);}
   else if(group.status==='running'){const stages=group.running.flatMap(item=>item.steps.filter(step=>step.status==='running')),text=(visual==='unconfirmed'?'最后上报：':'')+(stages.length?stages.map(step=>step.label+(step.activity?'：'+step.activity:'')).join('；'):'当前未上报活动阶段');view.activity.textContent=text;view.activity.setAttribute('title',text);parts.push(view.activity);button.setAttribute('aria-label',button.getAttribute('aria-label')+'，'+text);}
   reconcileChildren(button,parts);children.push(button);
 }if(!records.length)children.push(node('p',taskGroups.length?'暂无'+filterNames[activeFilter]+'任务':'暂无任务记录','task-empty'));reconcileChildren(container,children);container.scrollTop=scroll;if(focusedTask){const target=records.some(group=>group.key===focusedTask)?taskNodes.get(focusedTask)?.button:filterNodes.get(activeFilter);if(target&&document.activeElement!==target)target.focus?.({preventScroll:true});}for(const key of taskNodes.keys())if(!taskGroups.some(group=>group.key===key))taskNodes.delete(key);
}
function renderSteps(){
 const container=$('steps'),scroll=container.scrollTop,focusedStep=document.activeElement?.getAttribute?.('data-step-id'),buttons=[];
 for(const step of run?.steps||[]){const key=run.id+'|'+step.id;let view=stepNodes.get(key);if(!view){const button=node('button','','step');button.type='button';button.setAttribute('data-step-id',step.id);button.addEventListener('click',()=>chooseStep(step.id));view={button,label:node('span','','label'),duration:node('span','','duration'),symbolKey:null};stepNodes.set(key,view);}const state=stageVisualState(step),label=stageLabel(step),symbolKey=state+'|'+label;view.button.className='step'+(step.id===selectedStep?' selected':'');view.button.setAttribute('aria-current',step.id===selectedStep?'step':'false');view.button.setAttribute('aria-label',step.label+'，'+label);view.label.textContent=step.label;view.duration.textContent=duration(step);if(view.symbolKey!==symbolKey){view.button.replaceChildren(statusIcon(state,label),view.label,view.duration);view.symbolKey=symbolKey;}buttons.push(view.button);}
 reconcileChildren(container,buttons);container.scrollTop=scroll;const steps=run?.steps||[];if(focusedStep){const target=stepNodes.get(run?.id+'|'+(steps.some(step=>step.id===focusedStep)?focusedStep:selectedStep))?.button||$('history');if(document.activeElement!==target)target.focus?.({preventScroll:true});}for(const key of stepNodes.keys())if(!key.startsWith(run?.id+'|')||!steps.some(step=>key===run.id+'|'+step.id))stepNodes.delete(key);$('step-count').textContent=run?steps.filter(s=>s.status==='passed').length+' / '+steps.length:'—';
 $('mobile-step-count').textContent=$('step-count').textContent;const picker=$('stage-picker'),signature=JSON.stringify([run?.id,steps.map(step=>[step.id,step.label,stageLabel(step)])]);if(signature!==stageOptionsSignature){const placeholder=node('option',steps.length?'选择执行阶段':'暂无阶段');placeholder.value='';placeholder.disabled=true;picker.replaceChildren(placeholder,...steps.map(step=>{const option=node('option',step.label+' · '+stageLabel(step));option.value=step.id;return option}));stageOptionsSignature=signature;}picker.disabled=!steps.length;picker.value=selectedStep||'';const current=selected();picker.setAttribute('title',current?[current.label,stageLabel(current),current.detail].filter(Boolean).join(' · '):'选择执行阶段');picker.setAttribute('aria-label',current?'执行阶段：'+current.label+'，'+stageLabel(current):'选择执行阶段');picker.setAttribute('aria-description',current?.detail||'');
 if(!run){$('test-count').textContent='暂无测试统计';return;}
 const tests=steps.filter(s=>s.tests).reduce((a,s)=>{for(const key of ['pass','fail','skipped'])a[key]+=s.tests[key]||0;return a},{pass:0,fail:0,skipped:0});$('test-count').textContent='测试：'+tests.pass+' 通过 · '+tests.fail+' 失败 · '+tests.skipped+' 跳过';
}
function renderRun(){
 if(!run)return renderEmpty();const group=groupForRun(run.id),waiting=stageQueue(run),uncertain=run.status==='running'&&runWorkState(run)==='unconfirmed';$('run-disclosures').hidden=false;$('source-info').hidden=false;$('run-name').textContent=run.name;badge($('run-state'),uncertain?'unconfirmed':waiting?'queued':run.status);$('run-state').textContent=runLabel(run);$('projects').textContent=(run.projects||[]).join(' / ')||'未指定项目';
 $('stage-queue').hidden=!waiting;$('stage-queue-icon').replaceChildren(...(waiting?[wslIcon('clock',{className:'wait-icon'})]:[]));$('stage-queue-step').textContent=waiting?(waiting.steps.length?waiting.steps.map(step=>step.label).join('、'):'执行端未标注具体阶段'):'';$('stage-queue-reason').textContent=waiting?.reason||'';
 const latest=group?.runs[0];$('run-context').textContent=[latest&&run.id!==latest.id?'正在查看较早记录，最近一次'+runLabel(latest):'',uncertain?'执行结果待确认 · 最后上报 '+fmt(run.observation?.lastHeartbeatAt)+(run.observation?.reason?' · '+run.observation.reason:''):''].filter(Boolean).join('；');
 $('started').textContent=run.status==='queued'?'入队于 '+fmt(run.enqueuedAt):'开始于 '+fmt(run.startedAt);renderElapsed();$('queue').textContent=run.status==='queued'?(run.queuePosition?'队列第 '+run.queuePosition+' 位':'队列顺序未上报'):'';
 $('environment').textContent=run.environment||'';
 renderDeviceAssignment();
 const placements=executionViews(run),executors=[...new Map(placements.map(record=>[executionText(record),record])).values()];$('executor').hidden=!hostProtocol&&!executors.some(record=>record.executor);$('executor').replaceChildren(...($('executor').hidden?[]:executors.map(record=>hostBadge(record.executor,executorCaption(record),record.status==='running'&&runWorkState(record)==='unconfirmed'))));$('executor').setAttribute('title',executors.map(executionText).join('；'));
 const provenance={sampled:'执行端采集',reported:'运行记录上报',configured:'数据源配置',manual:'人工记录'},host=run.executor;
 $('executor-info').textContent=executors.map(executionText).join('；')+(host?' · 来源：'+(provenance[host.source]||'运行记录上报')+(host.observedAt?' · 记录于 '+fmt(host.observedAt):''):hostProtocol?' · 此记录未包含执行主机信息':' · 旧版服务未提供此字段，无法判断原记录是否包含主机信息')+(placements[0]!==run?' · 流程记录来源：'+hostDescription(recordController(run)):'');
 const sources=JSON.stringify([run.id,run.versions,run.sourceCi,run.recoveryRefs]);if(sources!==sourceViewSignature){sourceViewSignature=sources;$('versions').replaceChildren();for(const version of run.versions||[]){const row=node('div','','version-row');row.append(node('strong',version.name),node('span',version.branch||'工作区'),node('code',(version.head||'').slice(0,12)),node('span','源码快照 '+(version.sha256||'').slice(0,12)));$('versions').append(row)}
  if(run.sourceCi){const ci=run.sourceCi,row=node('div','','version-row ci-source');let url;try{const parsed=new URL(ci.url);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password)url=parsed.href}catch{}const source=node(url?'a':'span','GitHub Actions'+(ci.runId?' #'+ci.runId:''));if(url){source.href=url;source.target='_blank';source.rel='noopener noreferrer';}row.append(source,node('code',(ci.headSha||'').slice(0,12)),node('span',[ci.runAttempt||ci.attempt?'尝试 '+(ci.runAttempt||ci.attempt):'',ci.conclusion||ci.status].filter(Boolean).join(' · ')));$('versions').append(row);}
  if(run.recoveryRefs?.length)$('versions').append(node('div','保留恢复引用 '+run.recoveryRefs.length+' 项','source-recovery'));
 }
 renderTasks();renderSteps();renderStep();renderActivity();loadFailure();$('updated').textContent='记录更新 '+fmt(run.updatedAt);
}
function renderElapsed(){if(run)$('elapsed').textContent=run.status==='queued'?'尚未开始':(run.status==='running'&&runWorkState(run)==='unconfirmed'?'最后上报耗时 ':'总耗时 ')+duration(run);}
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
 const running=run.steps.filter(step=>step.status==='running'),commands=running.filter(step=>stageVisualState(step)==='running'),active=running,uncertain=run.status==='running'&&runWorkState(run)==='unconfirmed';
 if(run.status==='running'&&running.length){
  $('activity-summary').textContent=uncertain?'状态待确认':commands.length?commands.length+' 个命令执行中':'流程进行中';
  for(const step of active){
   const row=node('div','','activity-row'),heading=node('div','','activity-heading'),jump=node('button','查看日志','activity-jump');jump.type='button';jump.setAttribute('data-activity-step',step.id);jump.setAttribute('aria-label','查看'+step.label+'日志');jump.addEventListener('click',()=>chooseStep(step.id));jumps.push(jump);heading.append(node('strong',step.label),jump);row.append(heading);
   const staleStep=stageVisualState(step)==='unconfirmed',message=(staleStep?'最后上报：':'')+(step.activity||[step.detail,formatCommand(step)].filter(Boolean).join(' · ')||'执行端尚未提供阶段说明。');row.append(node('p',message,'activity-message'));
   if(!step.activity)row.append(node('p','暂无细粒度进展上报','activity-fallback'));
   row.append(node('p','开始 '+fmt(step.startedAt)+' · '+(staleStep?'最后上报耗时 ':'耗时 ')+duration(step)+' · '+(step.activityUpdatedAt?'进展更新 '+fmt(step.activityUpdatedAt):'记录更新 '+fmt(run.updatedAt)),'activity-meta'));content.append(row);
  }
 }else{
  const historical=groupForRun(run.id)?.current.id!==run.id&&!['running','queued'].includes(run.status);$('activity-summary').textContent=(historical?'历史记录 · ':'')+(uncertain?'状态待确认':run.status==='running'?'进行中 · 暂无活动阶段':labels[run.status]||run.status);
  const failed=run.steps.filter(step=>step.status==='failed'),message=run.status==='queued'?'任务等待执行。'+(run.enqueuedAt?'入队 '+fmt(run.enqueuedAt)+'。':'')+(run.queuePosition?'队列第 '+run.queuePosition+' 位。':''):uncertain?'未收到有效存活上报，无法确认任务是否仍在执行；保留最后记录供追溯。':failed.length?'未通过阶段：'+failed.map(step=>step.label).join('、')+'。':run.status==='running'?'任务流程仍标记进行中，当前没有上报正在执行的命令或阶段。':'当前没有正在执行的阶段。';
  content.append(node('p',message,'activity-message'));if(run.finishedAt)content.append(node('p','结束 '+fmt(run.finishedAt),'activity-meta'));
 }
 if(focusedStep)jumps.find(button=>button.getAttribute('data-activity-step')===focusedStep)?.focus();
 disclosureIcons();
}
function renderStep(){
 const step=selected();$('step-meta').replaceChildren();$('step-state').hidden=false;renderLogRefresh();
 if(!step){$('step-name').textContent=run?.error?'任务记录读取受阻':'此任务暂无阶段';$('step-detail').textContent=run?.error||'';badge($('step-state'),run?.status||'queued');$('command').hidden=true;$('command').textContent='';$('log-empty').textContent=run?.error||'执行端尚未上报阶段';return;}
 $('step-name').textContent=step.label;$('step-detail').textContent=step.detail;badge($('step-state'),stageVisualState(step));$('step-state').textContent=stageLabel(step);
 const executorHost=stepExecutor(step,run);if(executorHost||Object.hasOwn(step,'executor')){const executor=node('span','日志来自：'+hostName(executorHost),'step-executor');executor.setAttribute('title',hostDescription(executorHost)+(Object.hasOwn(step,'executor')?' · 流程记录来源：'+hostDescription(recordController(run,step)):''));$('step-meta').append(executor);}
 for(const value of [step.status==='queued'?'尚未开始':(stageVisualState(step)==='unconfirmed'?'最后上报耗时 ':'耗时 ')+duration(step),step.startedAt?'开始 '+fmt(step.startedAt):null,step.exitCode!==undefined?'退出码 '+step.exitCode:null,step.tests?'测试 '+step.tests.pass+' 通过 / '+step.tests.fail+' 失败 / '+step.tests.skipped+' 跳过':null,step.attempts?.length?'阶段尝试 '+(step.attempts.length+1)+' 次 · 历史结果保留':null,step.reusedFrom?'复用已有结果':null].filter(Boolean))$('step-meta').append(node('span',value));
 $('command').hidden=step.status==='queued'||!step.command?.length;$('command').textContent=step.status==='queued'?'':formatCommand(step);renderLogEmpty();
}
function reuseSource(step){const ref=step?.reusedFrom;if(!ref||typeof ref!=='object'||Array.isArray(ref)||typeof ref.runId!=='string'||!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(ref.runId))return null;const source=runs.find(record=>record.id===ref.runId);if(!source)return null;if(ref.stepId!==undefined&&(typeof ref.stepId!=='string'||!source.steps.some(item=>item.id===ref.stepId)))return null;return {run:source,stepId:ref.stepId};}
function renderLogEmpty(){
 if(logText){$('log-empty').hidden=true;return;}const step=selected();if(!step)return;const availability=logObservation?.availability,source=reuseSource(step),uncertain=stageVisualState(step)==='unconfirmed';let message;
 if(step.status==='queued'||run.status==='queued'||availability==='not-started')message='此阶段尚未开始，无执行日志';
 else if(step.status==='passed'&&step.reusedFrom)message='已复用历史结果，本次未生成新的执行日志。'+(source?'':'来源记录尚未接入或无法准确定位。');
 else if(logObservation?.error)message='日志读取失败：'+logObservation.error+'；保留当前运行信息，可手动重试。';
 else if(uncertain)message='执行状态已过期或待确认，暂无可用日志；不能据此判断仍在执行或已经通过。';
 else if(step.status==='running'&&!step.command?.length)message='当前是流程记录，尚未上报执行命令；暂无执行日志。';
 else if(step.status==='running'&&!logObservation)message='正在读取这次运行的阶段日志。';
 else if(step.status==='running'){const since=Date.parse(logObservation?.modifiedAt||step.startedAt)||logObservedAt,quiet=since?Math.max(0,Date.now()-since):0;message=quiet>=30000?'命令仍有有效上报，但超过 30 秒未回传日志输出。'+(availability==='missing'?'执行端尚未提供日志文件。':'可查看当前进展与最近上报时间。'):availability==='missing'?'等待执行端首次日志输出，日志文件尚未提供。':'等待执行端首次日志输出。';}
 else if(availability==='missing')message=(labels[step.status]||'执行已结束')+'，但执行端未提供该阶段的日志文件。';
 else if(availability==='empty')message=(labels[step.status]||'执行已结束')+'，日志文件为空；该命令没有产生文本输出。';
 else if(!logObservation)message='正在读取这次运行的阶段日志。';
 else message=(labels[step.status]||'执行已结束')+'，当前没有可读日志；此服务未说明日志文件是否存在。';
 const signature=JSON.stringify([message,source?.run.id,source?.stepId]);$('log-empty').hidden=false;if(signature===logEmptySignature)return;logEmptySignature=signature;$('log-empty').replaceChildren(node('span',message));
 if(step.reusedFrom&&source){const button=node('button',source.stepId?'查看来源阶段日志':'查看来源运行','reuse-jump');button.type='button';button.setAttribute('data-source-run',source.run.id);button.addEventListener('click',()=>{chooseRun(source.run.id);if(source.stepId)chooseStep(source.stepId);});$('log-empty').append(button);}
}
function renderLogRefresh(){const busy=logBusy?.manual===true;$('refresh-log').disabled=busy||!run||!selected()||run.status==='queued'||selected().status==='queued';$('refresh-log').setAttribute('aria-busy',String(busy));buttonLabel('refresh-log','refresh',busy?'刷新中…':'刷新日志');}
function logLineCount(text){return text?text.split('\n').length-(text.endsWith('\n')?1:0):0;}
function renderLog(){const count=logLineCount(logText);$('log').textContent=logText;$('log-numbers').textContent=Array.from({length:count},(_,index)=>index+1).join('\n');$('log-content').hidden=!logText;}
function resetLog(){selection++;offset=0;logText='';logBusy=null;logObservation=null;logCursor=null;logFallbackReadAt=0;logFallbackPending=false;logObservedAt=Date.now();logEmptySignature=null;renderLog();$('log-empty').hidden=false;$('copy').disabled=true;$('copy').setAttribute('aria-busy','false');buttonLabel('copy','copy','复制日志');$('log-summary').textContent='实时日志';$('log-size').textContent='0 B';$('log-view').scrollTop=0;renderLogRefresh();}
function renderEmpty(){
 sourceViewSignature=null;
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
function chooseStep(id,explicit=true){if(run&&id&&explicit)rememberedSteps.set(run.id,id);if(id===selectedStep)return;selectedStep=id||null;resetLog();renderSteps();renderStep();pollLog()}
function chooseTask(key){const group=taskGroups.find(item=>item.key===key);if(!group)return;const target=run&&group.runs.some(item=>item.id===run.id)?run:group.runs.find(item=>item.id===rememberedTaskRuns.get(key))||group.current;chooseRun(target.id);if(compactMedia?.matches)mobileTasks(false);}
function renderHistory(){const placeholder=node('option','选择运行记录');placeholder.value='';placeholder.disabled=true;const group=run&&groupForRun(run.id),history=$('history');$('history-caption').textContent='运行记录'+(group?'（'+group.runs.length+'）':'');history.replaceChildren(placeholder,...(group?.runs||[]).map(record=>{const option=node('option',fmt(record.startedAt||record.enqueuedAt)+' · '+runLabel(record)+(record.executor?' · '+hostName(record.executor):hostProtocol?' · 主机未记录':''));option.value=record.id;return option}));history.value=run?.id||'';history.disabled=!group;}
function chooseRun(id){
 const record=runs.find(item=>item.id===id),group=record&&groupForRun(id);if(!record||!group)return;activeFilter=filterOf(group);rememberedRuns.set(activeFilter,id);rememberedTaskRuns.set(group.key,id);if(record.id===run?.id){run=record;renderRun();renderHistory();return;}clearFailure();run=record;selectedStep=null;resetLog();
 const remembered=rememberedSteps.get(id);const next=run.steps.find(s=>s.id===remembered)||preferredStep(run);
 if(next)chooseStep(next.id,false);renderRun();renderHistory();
}
function preferredStep(record){return record.steps.find(step=>step.command?.length&&stageVisualState(step,record)==='running')||record.steps.find(step=>step.status==='running'&&step.command?.length)||record.steps.find(step=>step.status==='running')||record.steps.find(step=>step.status==='failed')||record.steps[0];}
function applyMetadata(data){
 metadataCurrent=true;hostProtocol=Object.hasOwn(data,'viewerHost');if(hostProtocol)renderViewerHost(data.viewerHost);else renderViewerHost(viewerHost,false);
 runs=data.runs;acceptDevices(data);renderDevices();taskGroups=groupRuns(runs);const previous=selected();if(activeFilter===null)activeFilter=taskGroups.some(item=>item.status==='running')?'running':taskGroups.some(item=>item.status==='queued')?'queued':'history';
 if(run){
  const latest=runs.find(record=>record.id===run.id);
  if(latest){run=latest;const preferred=preferredStep(run),current=selected();if(selectedStep&&!current){selectedStep=preferred?.id||null;resetLog();}else if(!rememberedSteps.has(run.id)&&preferred?.status==='running'&&preferred.command?.length&&selectedStep!==preferred.id&&(!current||current.status!=='running'||!current.command?.length||stageVisualState(current)!=='running')){selectedStep=preferred.id;resetLog();}else if(previous?.startedAt!==current?.startedAt||(previous?.attempts?.length||0)!==(current?.attempts?.length||0)){resetLog();}renderRun();}
  else{connection('当前任务已从数据源移除，保留已读取结果','warning');renderTasks();return;}
 }else{const records=taskGroups.filter(item=>filterOf(item)===activeFilter),remembered=runs.find(item=>item.id===rememberedRuns.get(activeFilter)),target=remembered&&records.some(group=>group.runs.includes(remembered))?remembered:records[0]?.current;if(target)chooseRun(target.id);else renderEmpty();}
 renderHistory();
 connection('实时连接','connected');
}
async function refresh(manual=false){
 if(manual&&manualBusy)return;if(manual){manualBusy=true;$('refresh').disabled=true;$('refresh').setAttribute('aria-busy','true');buttonLabel('refresh','refresh','刷新中…');}
 // A manual refresh can join the background read without starting a second request.
 if(!metadataRequest)metadataRequest=api('/api/runs').then(applyMetadata).finally(()=>{metadataRequest=null});
 try{await metadataRequest}catch(error){metadataCurrent=false;deviceSnapshotCurrent=false;deviceSnapshotReason='设备状态读取失败，展示最后一次记录';renderDevices();if(run)renderRun();else renderTasks();connection(error.message+'，保留已读取结果','error')}
 finally{if(manual){manualBusy=false;$('refresh').disabled=false;$('refresh').setAttribute('aria-busy','false');buttonLabel('refresh','refresh','刷新状态')}}
}
async function pollLog(manual=false){
 if(!run||!selectedStep||selected()?.status==='queued'||run.status==='queued'||logBusy&&(logBusy.manual||!manual))return;
 const stamp=selection,runId=run.id,stepId=selectedStep,request={manual};logBusy=request;renderLogRefresh();
 try{
  const path='/api/runs/'+encodeURIComponent(runId)+'/steps/'+encodeURIComponent(stepId)+'/log?offset=',url=(start,cursor)=>path+start+(cursor?'&cursor='+encodeURIComponent(cursor):'');
  let data=await api(url(manual?0:offset,manual?null:logCursor));if(stamp!==selection||logBusy!==request)return;
  // Legacy servers have no cursor: a same-size rewrite gets one bounded background
  // restart, at most once per 15 seconds. Current servers validate consumed boundaries.
  if(!manual&&!data.reset&&!data.cursor){if(offset>0&&!data.text&&data.total===logObservation?.total&&data.modifiedAt&&logObservation?.modifiedAt&&data.modifiedAt!==logObservation.modifiedAt)logFallbackPending=true;if(logFallbackPending&&(!logFallbackReadAt||Date.now()-logFallbackReadAt>=15000)){logFallbackReadAt=Date.now();data=await api(url(0,null));if(stamp!==selection||logBusy!==request)return;data={...data,reset:true};}}
  if(manual){const target=data.total;let text=data.text||'',truncated=false;while(data.nextOffset<target){const previous=data.nextOffset,next=await api(url(previous,data.cursor));if(stamp!==selection||logBusy!==request)return;if(next.reset||next.nextOffset<=previous)throw Error('日志在读取期间发生变化，请重新刷新');text+=next.text||'';if(text.length>1500000){text=text.slice(-1500000);truncated=true}data=next;}data={...data,text:(truncated?'[仅显示最近 1.5MB 日志]\n':'')+text};}
  const view=$('log-view'),scrollTop=view.scrollTop,scrollLeft=view.scrollLeft;
  logCursor=typeof data.cursor==='string'?data.cursor:null;if(manual||data.reset||logCursor)logFallbackPending=false;logObservation={availability:['available','empty','missing','not-started'].includes(data.availability)?data.availability:'unknown',modifiedAt:data.modifiedAt||null,total:data.total,fileId:data.fileId||null};
  if(manual||data.reset){offset=0;logText='';}offset=data.nextOffset;
  if(data.text||manual||data.reset){logText+=(data.text||'').replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/\r(?!\n)/g,'\n');if(logText.length>1500000)logText='[仅显示最近 1.5MB 日志]\n'+logText.slice(-1500000);renderLog();$('log-empty').hidden=Boolean(logText);$('copy').disabled=!logText||$('copy').getAttribute('aria-busy')==='true';if($('follow').checked)view.scrollTop=view.scrollHeight;else{view.scrollTop=scrollTop;view.scrollLeft=scrollLeft}}
  $('log-size').textContent=(data.total/1024).toFixed(1)+' KiB';$('log-summary').textContent=data.total?'运行日志 · '+logLineCount(logText)+' 行'+(selected()?.attempts?.length?' · 阶段有 '+selected().attempts.length+' 次历史尝试':''):logObservation.availability==='empty'?'日志文件为空':logObservation.availability==='missing'?'日志文件未提供':'实时日志';renderLogEmpty();
 }catch(error){if(stamp===selection&&logBusy===request){logObservation={...logObservation,error:error.message};$('log-summary').textContent=error.message;renderLogEmpty()}}finally{if(stamp===selection&&logBusy===request){logBusy=null;renderLogRefresh()}}
}
$('history').addEventListener('change',event=>{chooseRun(event.target.value);if(compactMedia?.matches)mobileTasks(false)});$('refresh').addEventListener('click',()=>refresh(true));$('stage-picker').addEventListener('change',event=>chooseStep(event.target.value));$('task-toggle').addEventListener('click',()=>mobileTasks(!mobileTasksOpen));
$('copy').addEventListener('click',async()=>{const stamp=selection,text=logText;$('copy').disabled=true;$('copy').setAttribute('aria-busy','true');buttonLabel('copy','copy','复制中…');let copied=false;try{if(typeof navigator.clipboard?.writeText==='function')try{await navigator.clipboard.writeText(text);copied=true}catch{}if(stamp!==selection)return;if(!copied)copied=legacyCopy(text);buttonLabel('copy','copy',copied?'已复制':'请手动选择复制')}finally{if(stamp===selection){$('copy').disabled=!logText;$('copy').setAttribute('aria-busy','false')}}});
$('refresh-log').addEventListener('click',()=>pollLog(true));
$('follow').addEventListener('change',()=>{if($('follow').checked)$('log-view').scrollTop=$('log-view').scrollHeight});
compactMedia?.addEventListener('change',event=>{if(event.matches)$('activity').open=false});
for(const id of ['activity','failure','source-info'])$(id).addEventListener('toggle',()=>{if($(id).open){for(const other of ['activity','failure','source-info'])if(other!==id)$(other).open=false;if(compactMedia?.matches)mobileTasks(false)}disclosureIcons();});
$('failure-status-icon').replaceChildren(wslIcon('status-failed',{className:'disclosure-icon'}));disclosureIcons();
mobileTasks(false);buttonLabel('refresh','refresh','刷新状态');buttonLabel('copy','copy','复制日志');renderLogRefresh();refresh();refreshResources();setInterval(refreshResources,5000);setInterval(()=>refresh(),2500);setInterval(pollLog,1000);setInterval(()=>{if(run){renderElapsed();renderStep();if($('activity').open)renderActivity()}},1000);
