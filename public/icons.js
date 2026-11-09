// Local Iconify / Lucide sprite; source and third-party notices: docs/icon-attribution.md.
(() => {
 const icons=Object.freeze({"status-passed":"circle-check","status-running":"loader-circle","status-failed":"circle-x","status-queued":"circle","status-cancelled":"circle-slash","status-interrupted":"circle-pause","status-blocked":"triangle-alert","refresh":"refresh-cw","copy":"copy","chevron-right":"chevron-right","chevron-down":"chevron-down","terminal":"terminal","clock":"clock","activity":"activity","history":"history","list":"list","server":"server"});
 globalThis.wslIcon=function(name,{label,className}={}){
  const key=Object.hasOwn(icons,name)?name:'status-queued';
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [attribute,value] of Object.entries({viewBox:'0 0 24 24',width:'16',height:'16',fill:'none',focusable:'false',class:className||'icon','data-icon':'lucide:'+icons[key]}))svg.setAttribute(attribute,value);
  if(typeof label==='string'&&label.trim()){svg.setAttribute('role','img');svg.setAttribute('aria-label',label)}else svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','/icons.svg#'+key);svg.append(use);return svg;
 };
})();
