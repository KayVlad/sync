const $=selector=>document.querySelector(selector);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
let server='',currentUser=null,items=[],loading=false,urls=new Map(),imageRequests=new Map(),category='all',draftFiles=[],staging=false;
function status(text,error=false){$('#status').hidden=!text;$('#status').textContent=text;$('#status').classList.toggle('error',error);}
async function message(action,data={}){const response=await chrome.runtime.sendMessage({action,...data});if(!response?.ok)throw new Error(response?.error||'Could not reach sync.');return response.result;}
function loginScreen(){observer.disconnect();for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();imageRequests.clear();items=[];currentUser=null;draftFiles=[];$('#draft').value='';renderAttachments();$('#queue').replaceChildren();$('#items').replaceChildren();$('#login').hidden=false;$('#shelf').hidden=true;$('#tools').hidden=true;}
function size(n){return n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(1)} GB`;}
function expires(value){const minutes=Math.max(0,Math.ceil((new Date(value)-Date.now())/60000));return minutes>=60?`${Math.floor(minutes/60)}h ${minutes%60}m`:`${minutes}m`;}
async function sourceBlob(id){
  if(!imageRequests.has(id))imageRequests.set(id,message('image',{id}).then(source=>new Blob([Uint8Array.from(atob(source.base64),c=>c.charCodeAt(0))],{type:source.type})).catch(error=>{imageRequests.delete(id);throw error;}));
  return imageRequests.get(id);
}
async function pngBlob(item){
  const source=await sourceBlob(item.id);if(source.type==='image/png')return source;
  const bitmap=await createImageBitmap(source);
  try{const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Image copy unavailable.')),'image/png'));}finally{bitmap.close();}
}
const observer=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);const image=entry.target,id=image.dataset.id;
    if(urls.has(id)){image.src=urls.get(id);continue;}
    sourceBlob(id).then(blob=>{if(!image.isConnected)return;const url=URL.createObjectURL(blob);urls.set(id,url);image.src=url;}).catch(()=>image.remove());
  }
},{root:$('#items'),rootMargin:'40px'});
function render(){
  observer.disconnect();const old=new Map(Array.from($('#items').children,node=>[node.dataset.id,node]));
  const visible=items.filter(item=>SyncShared.matches(item,$('#search').value,category)),ids=new Set(visible.map(i=>i.id));
  for(const [id,url]of urls)if(!ids.has(id)){URL.revokeObjectURL(url);urls.delete(id);imageRequests.delete(id);}
  for(const [id,node]of old)if(!ids.has(id))node.remove();
  for(const item of visible){
    const previous=old.get(item.id);if(previous&&previous.dataset.public===String(!!item.public)){previous.querySelector('.expires').textContent=expires(item.expires);$('#items').append(previous);continue;}previous?.remove();
    const card=el('article','item'+(item.public?' public':''));card.dataset.id=item.id;card.dataset.public=String(!!item.public);
    const toolbar=el('div','toolbar');toolbar.append(el('span','expires',expires(item.expires)));
    if(item.public){const link=el('button','','Link');link.type='button';link.setAttribute('aria-label',`Copy share link for ${item.name}`);link.onclick=async()=>{try{await navigator.clipboard.writeText(await message('share-link',{id:item.id}));status('Link copied');}catch(error){status(error.message,true);}};toolbar.append(link);}
    if(item.kind==='text'||SyncShared.imageType(item.type)){
      const cp=el('button','','Copy');cp.type='button';cp.setAttribute('aria-label',item.kind==='text'?'Copy text':`Copy ${item.name}`);
      cp.onclick=async()=>{cp.disabled=true;try{if(item.kind==='text')await navigator.clipboard.writeText(item.text);else await navigator.clipboard.write([new ClipboardItem({'image/png':pngBlob(item)})]);status('Copied');}catch(error){status(error.message,true);}finally{cp.disabled=false;}};toolbar.append(cp);
    }
    const download=el('button','','Download');download.type='button';download.setAttribute('aria-label',`Download ${item.name}`);download.onclick=async()=>{download.disabled=true;try{await message('download',{id:item.id});status('Downloading');}catch(error){status(error.message,true);}finally{download.disabled=false;}};toolbar.append(download);card.append(toolbar);
    if(item.kind==='text'){
      const pre=el('pre','text');for(const part of linkParts(item.text)){if(part.href){const link=el('a','',part.text);link.href=part.href;link.target='_blank';link.rel='noopener noreferrer';link.onclick=event=>{event.preventDefault();chrome.tabs.create({url:part.href}).catch(error=>status(error.message,true));};pre.append(link);}else pre.append(document.createTextNode(part.text));}card.append(pre);
    }else{
      const row=el('div','file'),info=el('div','file-info'),name=el('p','name',item.name);name.title=item.name;info.append(name,el('div','size',size(item.size)));row.append(info);
      if(SyncShared.imageType(item.type)&&item.size<=4*1024*1024){const image=el('img','preview');image.alt=item.name;image.dataset.id=item.id;image.onerror=()=>image.remove();row.prepend(image);observer.observe(image);}card.append(row);
    }
    $('#items').append(card);
  }
  for(const image of $('#items').querySelectorAll('img.preview'))if(!image.getAttribute('src'))observer.observe(image);
  $('#empty').hidden=visible.length!==0;$('#empty').textContent=items.length?'No matches':'Nothing here yet';
}
async function refresh(){
  if(loading)return;loading=true;
  try{const result=await message('list');server=result.server;currentUser=result.user;items=result.items;$('#account').textContent=`${result.user.name} · ${new URL(server).host}`;$('#login').hidden=true;$('#shelf').hidden=false;$('#tools').hidden=false;render();await renderQueue();}
  catch(error){const stored=await chrome.storage.local.get('connection');if(!stored.connection)loginScreen();status(error.message,true);}
  finally{loading=false;}
}
$('#login').addEventListener('submit',async event=>{
  event.preventDefault();let requested;
  try{server=SyncShared.server($('#server').value);requested=chrome.permissions.request({origins:[SyncShared.permission(server)]});}catch(error){status(error.message,true);return;}
  $('#sign-in').disabled=true;status('');
  try{if(!await requested)throw new Error('Allow access to your sync server to sign in.');await message('login',{server,username:$('#username').value,password:$('#password').value});$('#password').value='';await refresh();}
  catch(error){status(error.message,true);}finally{$('#sign-in').disabled=false;}
});
$('#refresh').onclick=()=>{status('');refresh();};
$('#sync-url').onclick=async()=>{const button=$('#sync-url');button.disabled=true;try{await message('sync-url');status('Queued');await renderQueue();}catch(error){status(error.message,true);}finally{button.disabled=false;}};
$('#open-app').onclick=()=>chrome.tabs.create({url:server}).catch(error=>status(error.message,true));
$('#logout').onclick=async()=>{try{await message('logout');loginScreen();status('');}catch(error){status(error.message,true);}};
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;if(changes.queueTick)renderQueue().catch(()=>{});if(changes.lastStatus?.newValue){const s=changes.lastStatus.newValue;status(s.message,s.error);if(!s.error&&s.message==='Sent')refresh();}if(changes.connection&&!changes.connection.newValue)loginScreen();});
(async()=>{const saved=await chrome.storage.local.get(['connection','server','lastStatus']);$('#server').value=saved.server||'http://localhost:8080';if(saved.lastStatus)status(saved.lastStatus.message,saved.lastStatus.error);if(saved.connection){await refresh();$('#draft').focus();await message('wake').catch(()=>{});}})();
setInterval(()=>{if(!$('#shelf').hidden)refresh();},5000);
function renderAttachments(){
  const holder=$('#attachments');holder.replaceChildren();holder.hidden=!draftFiles.length;
  draftFiles.forEach((file,index)=>{const chip=el('span','attachment',file.name||'Image');chip.title=`${file.name||'Image'} · ${size(file.size)}`;const remove=el('button','','×');remove.type='button';remove.setAttribute('aria-label',`Remove ${file.name||'image'}`);remove.onclick=()=>{draftFiles.splice(index,1);renderAttachments();};chip.append(remove);holder.append(chip);});
}
async function stageFiles(files,info){
  for(const file of files){if(file.size>info.config.maxFileSize)throw new Error(`${file.name} exceeds the server upload limit.`);}
  return files.map(file=>{const name=file.name||SyncShared.filename('https://clipboard/',file.type);return {job:SyncStore.job(info,'file',name,{size:file.size,type:file.type||'application/octet-stream'}),blob:file};});
}
async function submitDraft(filesOnly){
  if(staging)return;const text=filesOnly?'':$('#draft').value,files=filesOnly||draftFiles.slice();if(!text.length&&!files.length)return;
  staging=true;$('#send-draft').disabled=true;status('Preparing…');
  try{
    const info=await message('queue-info'),bytes=new TextEncoder().encode(text);if(bytes.length>info.config.maxNoteSize)throw new Error('Text exceeds the server note limit.');
    await SyncStore.expire();const entries=await stageFiles(files,info);
    if(text.length)entries.push({job:SyncStore.job(info,'text',text.trim().split(/\r?\n/)[0].slice(0,60)||'Text',{size:bytes.length,type:'text/plain; charset=utf-8'}),blob:new Blob([bytes],{type:'text/plain; charset=utf-8'})});
    await SyncStore.addBatch(entries);
    if(!filesOnly){$('#draft').value='';draftFiles=[];renderAttachments();}
    await message('wake');status('Queued');await renderQueue();
  }catch(error){status(error.name==='QuotaExceededError'?'Browser storage is full. Cancel queued transfers or use the main app.':error.message,true);}
  finally{staging=false;$('#send-draft').disabled=false;}
}
$('#composer').addEventListener('submit',event=>{event.preventDefault();submitDraft();});
$('#choose-files').onclick=()=>$('#file-input').click();
$('#file-input').onchange=()=>{const files=Array.from($('#file-input').files);$('#file-input').value='';submitDraft(files);};
document.addEventListener('paste',event=>{
  if($('#shelf').hidden||(['INPUT','TEXTAREA'].includes(event.target.tagName)&&event.target!==$('#draft')))return;
  const files=Array.from(event.clipboardData?.files||[]);
  if(files.length){event.preventDefault();draftFiles.push(...files);renderAttachments();$('#draft').focus();}
  else if(event.target!==$('#draft')){const text=event.clipboardData?.getData('text/plain');if(text){event.preventDefault();const draft=$('#draft'),start=draft.selectionStart,end=draft.selectionEnd;draft.value=draft.value.slice(0,start)+text+draft.value.slice(end);draft.focus();draft.selectionStart=draft.selectionEnd=start+text.length;}}
});
document.addEventListener('dragover',event=>{if(!$('#shelf').hidden&&event.dataTransfer?.types.includes('Files')){event.preventDefault();$('#composer').classList.add('dropping');}});
document.addEventListener('dragleave',event=>{if(!event.relatedTarget)$('#composer').classList.remove('dropping');});
document.addEventListener('drop',event=>{
  $('#composer').classList.remove('dropping');if($('#shelf').hidden||!event.dataTransfer?.files.length)return;event.preventDefault();
  if(Array.from(event.dataTransfer.items||[]).some(item=>item.webkitGetAsEntry?.()?.isDirectory)){status('Use the main app to send folders.',true);return;}submitDraft(Array.from(event.dataTransfer.files));
});
$('#search').oninput=render;
$('#categories').onclick=event=>{const button=event.target.closest('[data-category]');if(!button)return;category=category===button.dataset.category?'all':button.dataset.category;for(const node of $('#categories').children)node.setAttribute('aria-pressed',String(node.dataset.category===category));render();};
document.addEventListener('keydown',event=>{
  if($('#shelf').hidden||event.isComposing)return;
  if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();submitDraft();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();$('#search').focus();$('#search').select();return;}
  if(event.key==='Escape'&&event.target===$('#search')){$('#search').value='';render();$('#draft').focus();return;}
  if(event.ctrlKey||event.metaKey||event.altKey||event.key.length!==1||['INPUT','TEXTAREA'].includes(event.target.tagName)||event.target.isContentEditable||window.getSelection()?.toString())return;
  const draft=$('#draft');draft.focus();draft.setRangeText(event.key,draft.selectionStart,draft.selectionEnd,'end');event.preventDefault();
});
let queueRendering=false;
async function renderQueue(){
  if(queueRendering||!currentUser)return;queueRendering=true;
  try{
    const jobs=(await SyncStore.list()).filter(job=>job.server===server&&job.userId===currentUser?.id&&job.expires>Date.now()&&job.status!=='sent').sort((a,b)=>a.created-b.created),holder=$('#queue');holder.replaceChildren();holder.hidden=!jobs.length;
    for(const job of jobs){
      const row=el('div','transfer'),info=el('div','transfer-info'),name=el('span','transfer-name',job.name);name.title=job.name;
      const label=job.status==='sending'?(job.size?`${Math.floor((job.sent||0)/job.size*100)}%`:'Preparing'):({queued:'Queued',paused:'Paused',failed:'Failed'})[job.status]||job.status;
      const state=el('span','transfer-state',label);if(job.error)state.title=job.error;const top=el('div','transfer-top');top.append(name,state);const progress=el('progress');progress.max=job.size||1;progress.value=job.sent||0;progress.setAttribute('aria-label',`Sending ${job.name}`);info.append(top,progress);if(job.error){const error=el('div','transfer-error',job.error);info.append(error);}row.append(info);
      function control(action,label){const button=el('button','',label);button.type='button';button.setAttribute('aria-label',`${action==='resume'?'Resume':action==='pause'?'Pause':'Cancel'} ${job.name}`);button.onclick=async()=>{button.disabled=true;try{await message('queue-control',{id:job.id,control:action});}catch(error){status(error.message,true);}finally{button.disabled=false;await renderQueue();}};row.append(button);}
      if(['paused','failed'].includes(job.status))control('resume',job.status==='failed'?'Retry':'Resume');else control('pause','Pause');control('cancel','×');holder.append(row);
    }
  }finally{queueRendering=false;}
}
