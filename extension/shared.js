const SyncShared={
  server(value){
    const url=new URL(value.trim());
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Enter an HTTP or HTTPS server URL.');
    return url.origin+url.pathname.replace(/\/+$/,'');
  },
  permission(value){const url=new URL(value);return `${url.protocol}//${url.hostname}/*`;},
  itemID(value){if(!/^[a-f0-9]{32}$/.test(value||''))throw new Error('Invalid item.');return value;},
  link(value){
    const text=typeof value==='string'?value.trim():'';let url;try{url=new URL(text);}catch{throw new Error('Choose an HTTP or HTTPS link.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Choose an HTTP or HTTPS link.');return text;
  },
  videoType(url){
    let ext='';try{ext=new URL(url).pathname.split('.').pop().toLowerCase();}catch{}
    return ({mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',mov:'video/quicktime',ogv:'video/ogg',mkv:'video/x-matroska',avi:'video/x-msvideo'})[ext]||'';
  },
  imageType(type){return /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(type);},
  matches(item,query='',category='all',now=Date.now()){
    if(new Date(item.expires).getTime()<=now)return false;
    const image=(item.type||'').startsWith('image/');
    if(category==='text'&&item.kind!=='text'||category==='images'&&!image||category==='files'&&(image||item.kind==='text'))return false;
    const needle=query.toLocaleLowerCase().trim();return !needle||`${item.name||''}\n${item.text||''}`.toLocaleLowerCase().includes(needle);
  },
  filename(url,type){
    let name='';try{name=decodeURIComponent(new URL(url).pathname.split('/').pop());}catch{}
    const ext=({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/avif':'avif','image/bmp':'bmp','image/svg+xml':'svg','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','video/ogg':'ogv','video/x-matroska':'mkv','video/x-msvideo':'avi'})[type]||'bin';
    name=name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'');
    return name&&new TextEncoder().encode(name).length<=240?name:`${type?.startsWith('video/')?'video':type?.startsWith('image/')?'image':'file'}.${ext}`;
  },
  async upload(blob,name,config,request,progress=()=>{}){
    const chunks=async function*(chunkSize){for(let start=0;start<blob.size;start+=chunkSize)yield new Uint8Array(await blob.slice(start,start+chunkSize).arrayBuffer());};
    return SyncShared.uploadChunks(blob.size,blob.type,name,config,request,chunks(config.chunkSize),progress);
  },
  async uploadStream(stream,size,type,name,config,request,progress=()=>{}){
    const reader=stream.getReader();
    const chunks=async function*(){
      let buffer=new Uint8Array(config.chunkSize),used=0,received=0;
      for(;;){
        const {done,value}=await reader.read();if(done)break;
        received+=value.length;if(received>size)throw new Error('Video size changed during download.');
        for(let offset=0;offset<value.length;){
          const count=Math.min(buffer.length-used,value.length-offset);buffer.set(value.subarray(offset,offset+count),used);used+=count;offset+=count;
          if(used===buffer.length){yield buffer;buffer=new Uint8Array(config.chunkSize);used=0;}
        }
      }
      if(received!==size)throw new Error('Video download was incomplete.');
      if(used)yield buffer.subarray(0,used);
    };
    try{return await SyncShared.uploadChunks(size,type,name,config,request,chunks(),progress);}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  },
  async uploadChunks(size,type,name,config,request,chunks,progress=()=>{}){
    if(!Number.isSafeInteger(size)||size<0||size>config.maxFileSize)throw new Error('File exceeds the server upload limit.');
    const record=await request('/api/uploads',{method:'POST',body:JSON.stringify({name,type,size})});
    const hash=new SHA256(),pending=new Set();let sent=0,failure;
    try{
      let index=0;
      for await(const bytes of chunks){
        if(failure)throw failure;
        hash.update(bytes);
        const digest=new SHA256().update(bytes).digest();
        const job=request(`/api/uploads/${record.id}/${index++}`,{method:'PUT',body:bytes,headers:{'X-Chunk-SHA256':digest}},true)
          .then(()=>{sent+=bytes.length;progress(sent,size);})
          .catch(error=>{failure=error;}).finally(()=>pending.delete(job));
        pending.add(job);if(pending.size>=config.parallel)await Promise.race(pending);
      }
      await Promise.all(pending);if(failure)throw failure;
      return await request(`/api/uploads/${record.id}/complete`,{method:'POST',body:JSON.stringify({sha256:hash.digest()})},true);
    }catch(error){await Promise.all(pending);await request(`/api/items/${record.id}`,{method:'DELETE'}).catch(()=>{});throw error;}
  }
};
globalThis.SyncShared=SyncShared;
