import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const luminance=hex=>{const c=hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]};
const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05)};
test('small informational text retains AA contrast on its normal and selected surfaces',async()=>{
 const css=await readFile(new URL('../styles/workbench.css',import.meta.url),'utf8'),color=name=>{const match=css.match(new RegExp('--'+name+':\\s*(#[a-f0-9]{6})','i'));assert.ok(match,'Missing color '+name);return match[1]};
 const backgrounds=['surface','page-bg','subtle','accent-soft'].map(color),hostBackground=css.match(/\.host-location\s*\{[^}]*background:\s*(#[a-f0-9]{6})/i)?.[1];assert.ok(hostBackground);backgrounds.push(hostBackground);
 for(const name of ['muted','faint'])for(const background of backgrounds)assert.ok(contrast(color(name),background)>=4.5,name+' on '+background+' has contrast '+contrast(color(name),background).toFixed(2));
});
