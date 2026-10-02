importScripts('/sha256.js');

let controller;
let uploadID;
let cancelRequested=false;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function request(url, options={}, retry=false) {
  for(let attempt=0;;attempt++){
    try{
      const response=await fetch(url,{...options,signal:controller.signal});
      if(!response.ok){const body=await response.json().catch(()=>({}));const error=new Error(body.error||`Server error (${response.status})`);error.status=response.status;throw error;}
      return response.status===204?null:await response.json();
    }catch(error){
      if(controller.signal.aborted || !retry || attempt>=3 || (error.status && error.status<500 && error.status!==408 && error.status!==429))throw error;
      await pause(400*2**attempt);
    }
  }
}

self.onmessage=async({data})=>{
  if(data.action==='cancel'){cancelRequested=true;controller?.abort();return;}
  if(data.action!=='upload')return;
  controller=new AbortController();cancelRequested=false;uploadID=null;
  const {file,config}=data;
  const pending=new Set();let failure=null;let sent=0;
  try{
    const record=await request('/api/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,size:file.size,type:file.type})});
    uploadID=record.id;self.postMessage({type:'started',id:uploadID});
    const hash=new SHA256();const started=performance.now();
    for(let offset=0,index=0;offset<file.size;offset+=config.chunkSize,index++){
      if(failure)throw failure;
      if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
      const bytes=new Uint8Array(await file.slice(offset,offset+config.chunkSize).arrayBuffer());
      hash.update(bytes);
      const digest=self.crypto?.subtle
        ? Array.from(new Uint8Array(await self.crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('')
        : new SHA256().update(bytes).digest();
      const job=request(`/api/uploads/${uploadID}/${index}`,{method:'PUT',headers:{'X-Chunk-SHA256':digest},body:bytes},true)
        .then(()=>{sent+=bytes.length;self.postMessage({type:'progress',sent,total:file.size,speed:sent/Math.max((performance.now()-started)/1000,.01)});})
        .catch(error=>{failure=error;controller.abort();})
        .finally(()=>pending.delete(job));
      pending.add(job);
      if(pending.size>=config.parallel)await Promise.race(pending);
    }
    await Promise.all(pending);if(failure)throw failure;
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    self.postMessage({type:'verifying'});
    const result=await request(`/api/uploads/${uploadID}/complete`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sha256:hash.digest()})},true);
    self.postMessage({type:'done',item:result});
  }catch(error){
    controller.abort();await Promise.all(pending);
    if(uploadID)await fetch(`/api/items/${uploadID}`,{method:'DELETE'}).catch(()=>{});
    self.postMessage({type:cancelRequested?'cancelled':'error',message:error.message||'Transfer interrupted. Try again.'});
  }
};
