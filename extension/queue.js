class SyncQueue {
  constructor({store,connection,notify=async()=>{},fetcher=fetch}){this.store=store;this.connection=connection;this.notify=notify;this.fetcher=fetcher;this.running=false;this.active=null;this.stopped=false;}
  async initialize(){await this.store.expire();for(const job of await this.store.list()){if(job.status==='sending')await this.store.patch(job.id,{status:'paused',error:'Interrupted. Resume to continue.'});if(job.status==='sent')await this.store.remove(job.id);}}
  async update(job,values){Object.assign(job,values);await this.store.patch(job.id,values);await this.notify({id:job.id,status:job.status,sent:job.sent,size:job.size,error:job.error});}
  async api(c,path,options={},signal,retry=false){
    for(let attempt=0;;attempt++){
      if(signal?.aborted)throw new Error('Transfer paused.');
      try{
        const response=await this.fetcher(c.server+path,{...options,headers:{'X-Sync-Client':'extension',Authorization:`Bearer ${c.token}`,...(typeof options.body==='string'?{'Content-Type':'application/json'}:{}),...options.headers},credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(25000)});
        if(!response.ok){const body=await response.json().catch(()=>({}));const error=new Error(body.error||'Could not reach sync.');error.status=response.status;throw error;}
        return response.status===204?null:response.json();
      }catch(error){if(signal?.aborted||!retry||attempt>=3||(error.status&&error.status<500&&![408,429].includes(error.status)))throw error;await new Promise(resolve=>setTimeout(resolve,400*2**attempt));}
    }
  }
  async source(url,options,signal){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    try{return await this.fetcher(url,{...options,credentials:'include',signal:AbortSignal.any([signal,controller.signal])});}finally{clearTimeout(timer);}
  }
  async body(response,size){
    const bytes=new Uint8Array(size),reader=response.body.getReader();let position=0;
    try{for(;;){let timer;const {done,value}=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Video source stalled.')),60000);})]).finally(()=>clearTimeout(timer));if(done)break;if(position+value.length>size)throw new Error('Video size changed.');bytes.set(value,position);position+=value.length;}if(position!==size)throw new Error('Video download was incomplete.');return bytes;}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async probe(job,signal){
    SyncShared.link(job.source);
    const response=await this.source(job.source,{headers:{Range:'bytes=0-0'}},signal);
    try{
      if(!response.ok)throw new Error('Could not retrieve the original video.');
      const type=(response.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase(),guessed=SyncShared.videoType(job.source);
      if(type.includes('mpegurl')||type==='application/dash+xml'||/\.(m3u8|mpd)$/i.test(new URL(job.source).pathname))throw new Error('Streaming playlists are unsupported. Download the video and send the file.');
      if(!type.startsWith('video/')&&(!guessed||!['','application/octet-stream','binary/octet-stream'].includes(type)))throw new Error('This source is not a direct video file.');
      const range=/^bytes 0-0\/(\d+)$/.exec(response.headers.get('Content-Range')||'');
      const size=Number(response.status===206?range?.[1]:response.headers.get('Content-Length'));
      if(!Number.isSafeInteger(size)||size<=0||![200,206].includes(response.status)||!['',null,'identity'].includes(response.headers.get('Content-Encoding')))throw new Error('This video has no usable file size. Download it and send the file.');
      const etag=response.headers.get('ETag')||'',modified=response.headers.get('Last-Modified')||'';
      if(job.size!==undefined&&(job.size!==size||(job.etag&&job.etag!==etag)||(job.modified&&job.modified!==modified)))throw new Error('Video source changed. Cancel this transfer and send it again.');
      await this.update(job,{size,type:type.startsWith('video/')?type:guessed,name:SyncShared.filename(job.source,type||guessed),ranges:response.status===206,etag,modified});
    }finally{await response.body?.cancel().catch(()=>{});}
  }
  async *chunks(job,blob,config,start,signal){
    if(job.kind==='file'){
      for(let index=start;index*config.chunkSize<job.size;index++)yield new Uint8Array(await blob.slice(index*config.chunkSize,(index+1)*config.chunkSize).arrayBuffer());return;
    }
    if(job.ranges){
      for(let index=start;index*config.chunkSize<job.size;index++){
        const offset=index*config.chunkSize,end=Math.min(offset+config.chunkSize,job.size)-1;
        const response=await this.source(job.source,{headers:{Range:`bytes=${offset}-${end}`,...(job.etag&&!job.etag.startsWith('W/')?{'If-Range':job.etag}:job.modified?{'If-Range':job.modified}:{})}},signal);
        try{if(response.status!==206||response.headers.get('Content-Range')!==`bytes ${offset}-${end}/${job.size}`||(job.etag&&response.headers.get('ETag')!==job.etag)||!['',null,'identity'].includes(response.headers.get('Content-Encoding')))throw new Error('Video source changed or no longer supports resume.');yield await this.body(response,end-offset+1);}finally{await response.body?.cancel().catch(()=>{});}
      }return;
    }
    const response=await this.source(job.source,{},signal);
    if(!response.ok||Number(response.headers.get('Content-Length'))!==job.size||(job.etag&&response.headers.get('ETag')!==job.etag)){await response.body?.cancel().catch(()=>{});throw new Error('Video source changed.');}
    const reader=response.body.getReader();let buffer=new Uint8Array(config.chunkSize),used=0,received=0;
    try{
      for(;;){let timer;const {done,value}=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Video source stalled.')),60000);})]).finally(()=>clearTimeout(timer));if(done)break;received+=value.length;if(received>job.size)throw new Error('Video size changed.');
        for(let offset=0;offset<value.length;){const count=Math.min(buffer.length-used,value.length-offset);buffer.set(value.subarray(offset,offset+count),used);used+=count;offset+=count;if(used===buffer.length){yield buffer;buffer=new Uint8Array(config.chunkSize);used=0;}}
      }if(received!==job.size)throw new Error('Video download was incomplete.');if(used)yield buffer.subarray(0,used);
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  snapshot(hash){return {h:Array.from(hash.h),buffer:Array.from(hash.buffer),used:hash.used,length:hash.length};}
  restore(state){const hash=new SHA256();hash.h.set(state.h);hash.buffer.set(state.buffer);hash.used=state.used;hash.length=state.length;return hash;}
  async send(job,c,signal){
    const config=await this.api(c,'/api/config',{},signal);
    const blob=job.kind==='video'?null:await this.store.blob(job.id);
    if(job.kind!=='video'&&!blob)throw new Error('Local file is unavailable. Send it again.');
    if(job.kind==='text'){
      const text=await blob.text(),bytes=new TextEncoder().encode(text);if(!bytes.length||bytes.length>config.maxNoteSize)throw new Error('Text exceeds the server note limit.');
      const item=await this.api(c,'/api/notes',{method:'POST',body:JSON.stringify({text,sha256:new SHA256().update(bytes).digest(),clientId:job.id})},signal,true);await this.update(job,{itemId:item.id,sent:bytes.length,size:bytes.length});return;
    }
    if(job.kind==='video')await this.probe(job,signal);
    if(job.size>config.maxFileSize)throw new Error('File exceeds the server upload limit.');
    let record;
    if(job.uploadId){try{record=await this.api(c,`/api/uploads/${job.uploadId}`,{},signal);}catch(error){if(![404,410].includes(error.status))throw error;throw new Error('Server upload expired or was removed. Cancel and send the file again.');}}
    else{record=await this.api(c,'/api/uploads',{method:'POST',body:JSON.stringify({name:job.name,type:job.type,size:job.size,clientId:job.id})},signal,true);await this.update(job,{uploadId:record.id,expires:Math.min(job.expires,new Date(record.expires).getTime()||job.expires)});}
    if(record.size!==job.size)throw new Error('Server upload size changed.');
    const receipts=record.chunks||[],known=job.receipts||[];
    const count=Math.ceil(job.size/config.chunkSize);let start=0,hash=new SHA256();
    if(job.checkpoint&&(job.kind==='file'||(job.ranges&&job.etag&&!job.etag.startsWith('W/')))&&job.checkpoint.index<=count&&known.slice(0,job.checkpoint.index).every((digest,index)=>receipts[index]===digest)&&known.length>=job.checkpoint.index){start=job.checkpoint.index;hash=this.restore(job.checkpoint.hash);}
    let sent=receipts.reduce((sum,digest,index)=>sum+(digest?Math.min(config.chunkSize,job.size-index*config.chunkSize):0),0);
    await this.update(job,{sent});let index=start,wave=[],waveDigests=[],failure;
    const flush=async()=>{
      await Promise.all(wave);wave=[];if(failure)throw failure;
      await this.update(job,{sent,receipts:known.slice(0,index),checkpoint:{index,hash:this.snapshot(hash)}});waveDigests=[];
    };
    try{
      for await(const bytes of this.chunks(job,blob,config,start,signal)){
        if(signal.aborted)throw new Error('Transfer paused.');hash.update(bytes);const digest=new SHA256().update(bytes).digest(),chunkIndex=index++;
        if(receipts[chunkIndex]&&receipts[chunkIndex]!==digest)throw new Error('Source bytes changed. Cancel and send the file again.');known[chunkIndex]=digest;
        if(!receipts[chunkIndex])wave.push(this.api(c,`/api/uploads/${record.id}/${chunkIndex}`,{method:'PUT',body:bytes,headers:{'X-Chunk-SHA256':digest}},signal,true).then(()=>{sent+=bytes.length;}).catch(error=>{failure=error;}));
        waveDigests.push(digest);if(waveDigests.length>=config.parallel)await flush();
      }
      await flush();if(index!==count)throw new Error('File was incomplete.');
      const item=await this.api(c,`/api/uploads/${record.id}/complete`,{method:'POST',body:JSON.stringify({sha256:hash.digest()})},signal,true);await this.update(job,{itemId:item.id,sent:job.size});
    }finally{await Promise.all(wave);}
  }
  async kick(){
    if(this.running)return;this.running=true;
    try{
      for(;;){const c=await this.connection().catch(()=>null);if(!c)break;
        const job=(await this.store.list()).filter(j=>j.status==='queued'&&j.server===c.server&&j.userId===c.user.id&&j.expires>Date.now()).sort((a,b)=>a.created-b.created)[0];if(!job)break;
        const controller=new AbortController();this.active={job,c,controller,command:null};
        try{await this.update(job,{status:'sending',error:''});await this.send(job,c,controller.signal);await this.update(job,{status:'sent',error:'',checkpoint:null,receipts:null});await this.store.remove(job.id);}
        catch(error){const command=this.active.command;
          if(command==='cancel'){await this.clean(job,c);await this.store.remove(job.id);await this.notify({id:job.id,status:'cancelled'});}
          else await this.update(job,{status:command==='pause'?'paused':'failed',error:command==='pause'?'':error.message});
          if(error.status===401)break;
        }finally{this.active=null;}
      }
    }finally{this.running=false;}
  }
  async clean(job,c){if(job.uploadId&&!job.itemId)await this.api(c,`/api/items/${job.uploadId}`,{method:'DELETE'}).catch(()=>{});}
  async control(id,action,c){
    const job=await this.store.get(id);if(!job||job.server!==c.server||job.userId!==c.user.id)throw new Error('Transfer unavailable.');
    if(this.active?.job.id===id){if(!['pause','cancel'].includes(action))throw new Error('Transfer is already running.');this.active.command=action;this.active.controller.abort();return;}
    if(action==='cancel'){await this.clean(job,c);await this.store.remove(id);await this.notify({id,status:'cancelled'});}
    else if(action==='pause'){await this.update(job,{status:'paused'});}
    else if(action==='resume'&&['paused','failed'].includes(job.status)){await this.update(job,{status:'queued',error:''});this.kick();}
    else throw new Error('Invalid transfer action.');
  }
  async pauseAccount(c){for(const job of await this.store.list())if(job.server===c.server&&job.userId===c.user.id&&['queued','sending'].includes(job.status))await this.control(job.id,'pause',c);while(this.active)await new Promise(resolve=>setTimeout(resolve,10));}
  async expire(){if(this.active?.job.expires<=Date.now()){this.active.command='cancel';this.active.controller.abort();}await this.store.expire();}
}
globalThis.SyncQueue=SyncQueue;
