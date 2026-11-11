// Absolute timestamps belong to their producer's clock. Freshness is measured
// by the receiver's monotonic clock, or by a probe of this exact Linux boot.
export function createClockObserver({maxEntries=4096}={}){
 const seen=new Map();
 function remember(key,value){seen.delete(key);seen.set(key,value);while(seen.size>maxEntries)seen.delete(seen.keys().next().value);}
 function transition(key,token,{mono,ttl,session='',sequence,sourceMono}={}){
  const old=seen.get(key),current={token,session,sequence,sourceMono,lastRead:mono,confirmed:false};
  if(!old||old.session!==session||mono<old.lastRead){remember(key,current);return {verified:false,reason:'首次观察该时钟域，等待新一次探测或心跳变化'};}
  if(token!==old.token){
   const sourceAdvanced=sourceMono===undefined||Number.isFinite(old.sourceMono)&&sourceMono>old.sourceMono&&sourceMono-old.sourceMono<=ttl;
   const sequenceAdvanced=sequence===undefined||Number.isSafeInteger(old.sequence)&&sequence>old.sequence;
   if(mono-old.lastRead<=ttl&&sourceAdvanced&&sequenceAdvanced){current.confirmed=true;current.receiptLower=old.lastRead;current.receiptUpper=mono;}
  }else{current.confirmed=old.confirmed;current.receiptLower=old.receiptLower;current.receiptUpper=old.receiptUpper;}
  remember(key,current);
  return current.confirmed?{verified:true,ageMs:mono-current.receiptLower,minAgeMs:mono-current.receiptUpper}:{verified:false,reason:'探测或心跳还没有连续的新鲜单调观察'};
 }
 return {
  pulse(key,pulse,{mono,ttl,receiver,reference}={}){
   const valid=value=>value&&typeof value.sessionId==='string'&&/^[a-z0-9_-]{1,80}$/i.test(value.sessionId)&&Number.isSafeInteger(value.sequence)&&value.sequence>0&&Number.isFinite(value.monotonicMs)&&value.monotonicMs>=0;
   if(pulse.observer!==undefined&&!valid(pulse.observer))return {verified:false,reason:'探测的单调时钟标识无效'};
   const owner=valid(pulse.observer)?pulse.observer:null,local=valid(reference?.observer)?reference.observer:null,clock=reference?.resources?.clock;
   if(owner&&local&&clock?.domain==='linux'&&receiver?.bootId===clock.bootId&&owner.sessionId===local.sessionId&&Number.isFinite(receiver.uptimeMs)&&Number.isFinite(clock.uptimeMs)&&Number.isFinite(owner.monotonicMs)&&Number.isFinite(local.monotonicMs)){
    const referenceAge=receiver.uptimeMs-clock.uptimeMs,ageMs=referenceAge-(owner.monotonicMs-local.monotonicMs);
    if(referenceAge>=0&&referenceAge<=ttl&&ageMs>=0)return {verified:true,ageMs,minAgeMs:Math.max(0,ageMs-(reference.resources.ageAtReceiptMs||0)),method:'local-linux-monotonic-bridge'};
   }
   const token=owner?owner.sessionId+':'+owner.sequence+':'+owner.monotonicMs:pulse.checkedAt;
   if(!token)return {verified:false,reason:'缺少可连续核实的探测标识'};
   return {...transition(key,token,{mono,ttl,session:owner?.sessionId||'legacy',sequence:owner?.sequence,sourceMono:owner?.monotonicMs}),method:'receiver-monotonic-observation'};
  },
  record(key,token,{mono,ttl}={}){if(typeof token!=='string'||!token){seen.delete(key);return {verified:false,reason:'任务没有可核实的心跳标识'}};return transition(key,token,{mono,ttl});},
  clear(){seen.clear();}
 };
}
