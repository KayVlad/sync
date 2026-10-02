const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
class MemoryStore {
 constructor(){this.jobs=new Map();this.payloads=new Map();}
 async add(job,blob){this.jobs.set(job.id,structuredClone(job));if(blob)this.payloads.set(job.id,blob);return job;}
 async addBatch(entries){for(const entry of entries)await this.add(entry.job,entry.blob);}
 async list(){return [...this.jobs.values()].map(job=>structuredClone(job));}
 async get(id){const job=this.jobs.get(id);return job&&structuredClone(job);}
 async blob(id){return this.payloads.get(id);}
 async patch(id,values){const job=this.jobs.get(id);if(job){Object.assign(job,structuredClone(values));return structuredClone(job);}}
 async dropPayload(id){this.payloads.delete(id);}
 async remove(id){this.jobs.delete(id);this.payloads.delete(id);}
 async expire(now=Date.now()){for(const job of await this.list())if(job.expires<=now)await this.remove(job.id);}
}
function prepareChrome(chrome){
 const h={engine:null,errors:[],memory:new MemoryStore(),document:false,commands:null};
 chrome.runtime.getURL=file=>'chrome-extension://'+chrome.runtime.id+'/'+file;
 chrome.runtime.getContexts=async()=>h.document?[{documentUrl:chrome.runtime.getURL('offscreen.html')}]:[];
 chrome.alarms={create(){},onAlarm:{addListener(){}}};chrome.commands={onCommand:{addListener(fn){h.commands=fn;}}};
 chrome.offscreen={createDocument:async()=>{h.document=true;await h.engine.initialize();}};
 chrome.runtime.sendMessage=async message=>{
  if(message.target!=='engine')throw new Error('Unexpected test message');
  if(message.action==='wake'){h.engine.kick().catch(error=>h.errors.push(error));return {ok:true,result:null};}
  const c=await h.engine.connection();
  if(message.action==='control')await h.engine.control(message.id,message.control,c);
  else if(message.action==='pause-account')await h.engine.pauseAccount(c);
  else throw new Error('Unexpected engine message');return {ok:true,result:null};
 };
 h.attach=context=>{
  const store=vm.runInContext('SyncStore',context);for(const name of ['add','addBatch','list','get','blob','patch','dropPayload','remove','expire'])store[name]=h.memory[name].bind(h.memory);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/queue.js'),'utf8'),context);
  h.engine=vm.runInContext("new SyncQueue({store:SyncStore,connection,notify:event=>handleMessage({action:'engine-update',event},{url:chrome.runtime.getURL('offscreen.html')})})",context);
 };
 h.drain=async()=>{for(let i=0;i<3000;i++){await new Promise(resolve=>setTimeout(resolve,1));if(!h.engine.running){if(h.errors.length)throw h.errors[0];return;}}throw new Error('Test queue did not settle.');};
 return h;
}
module.exports={MemoryStore,prepareChrome};
