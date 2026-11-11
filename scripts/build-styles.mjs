import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const upstream=new URL('../vendor/qisvc-console-ui/console.css',import.meta.url),source=JSON.parse(await readFile(new URL('../vendor/qisvc-console-ui/source.json',import.meta.url),'utf8'));
const shared=(await readFile(upstream,'utf8')).replace(/\r\n/g,'\n'),own=(await readFile(new URL('../styles/workbench.css',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
if(createHash('sha256').update(shared).digest('hex')!==source.sha256)throw Error('QISVC_STYLES_INTEGRITY_MISMATCH');
await mkdir(new URL('../public/',import.meta.url),{recursive:true});
await writeFile(new URL('../public/style.css',import.meta.url),'/* Generated from qisvc-console-ui '+source.commit+' and styles/workbench.css. */\n'+shared+'\n'+own);
console.log('Built shared QiSvc console styles and workbench layout.');
