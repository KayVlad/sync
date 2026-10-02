const $=selector=>document.querySelector(selector);
const icon=name=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href',`#i-${name}`);svg.append(use);svg.setAttribute('aria-hidden','true');return svg;};
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const bytes=n=>{if(n<1024)return `${n} B`;const units=['KB','MB','GB','TB'];let i=-1;do{n/=1024;i++;}while(n>=1024&&i<units.length-1);return `${n>=10?n.toFixed(0):n.toFixed(1)} ${units[i]}`;};
let config,items=[],active=false,queue=[],refreshing=false,refreshAgain=false,toastTimer;
let currentUser=null,events=null,authEpoch=0,currentTask=null;
const clipboardDraft=new ClipboardDraft();
let draftFiles=[],suggestionURLs=[],clipboardReading=false,clipboardReadAllowed=false;

function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200);}
async function api(url,options){const epoch=authEpoch,response=await fetch(url,options);if(!response.ok){if(response.status===401&&url!=='/api/auth/login'&&epoch===authEpoch)showLogin();const body=await response.json().catch(()=>({}));const error=new Error(body.error||'Couldn’t reach sync. Try again.');error.status=response.status;throw error;}return response.status===204?null:response.json();}
const jsonOptions=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function button(label,name,cls='icon-button'){const b=el('button',cls);b.type='button';b.title=label;b.setAttribute('aria-label',label);b.append(icon(name));return b;}
function expiryText(date){const ms=new Date(date)-Date.now();if(ms<=0)return 'Expired';const m=Math.ceil(ms/60000);return m>=60?`${Math.floor(m/60)}h ${m%60}m left`:`${m}m left`;}


async function copy(text){
  if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}
  // Clipboard API requires HTTPS. execCommand still supports user-initiated copying on LAN HTTP.
  const previous=document.activeElement;const field=el('textarea','clipboard-fallback');field.value=text;field.setAttribute('readonly','');(document.querySelector('dialog[open]')||document.body).append(field);field.select();const ok=document.execCommand('copy');field.remove();previous?.focus();if(!ok)throw new Error('Copy unavailable in this browser. Select the text to copy it.');
}

const isImage=item=>/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(item.type);
async function imageBlob(item){
  const response=await fetch(`/api/items/${item.id}/download`);
  if(!response.ok)throw new Error('Could not read image. It may have expired.');
  const source=await response.blob();
  if(item.type==='image/png')return new Blob([source],{type:'image/png'});
  // The OS clipboard accepts a still PNG. Original downloads are never converted.
  const bitmap=await createImageBitmap(new Blob([source],{type:item.type}));
  try{const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Could not copy this image.')),'image/png'));}finally{bitmap.close();}
}
async function copyImage(item){
  if(!navigator.clipboard?.write||!window.ClipboardItem||!window.isSecureContext)throw new Error('Image copy needs HTTPS or localhost. Download still works.');
  // Start clipboard.write during the click gesture; Safari accepts a promised Blob.
  await navigator.clipboard.write([new ClipboardItem({'image/png':imageBlob(item)})]);
}

function renderItems(){
  const holder=$('#items'),existing=new Map(Array.from(holder.children,node=>[node.dataset.id,node]));
  const visible=items.filter(item=>new Date(item.expires)>Date.now()),keep=new Set(visible.map(item=>item.id));
  for(const node of Array.from(holder.children))if(!keep.has(node.dataset.id))node.remove();
  $('#item-count').textContent=visible.length;$('#empty').hidden=visible.length!==0;
  for(const item of visible){
    const key=JSON.stringify([item.public,!!item.canManage,currentUser?.id]);
    const previous=existing.get(item.id);if(previous?.dataset.state===key){holder.append(previous);continue;}previous?.remove();
    const card=el('article','item-card');card.dataset.id=item.id;card.dataset.state=key;card.classList.toggle('is-public',!!item.public);
    const toolbar=el('div','item-toolbar'),expiry=el('span','expiry');expiry.title=`Deletes ${new Date(item.expires).toLocaleString()}`;expiry.append(el('span','expiry-value',expiryText(item.expires)));expiry.dataset.expires=item.expires;
    const actions=el('div','item-actions');
    if(item.canManage){
      const toggle=el('button','public-toggle','Public');toggle.type='button';toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(item.public));toggle.title='Visible to anyone, without signing in';toggle.append(el('span','switch-track'));
      toggle.onclick=async()=>{toggle.disabled=true;try{const updated=await api(`/api/items/${item.id}`,jsonOptions('PATCH',{public:!item.public}));items=items.map(i=>i.id===item.id?updated:i);renderItems();}catch(e){toast(e.message);toggle.disabled=false;}};
      actions.append(toggle);
    }
    if(item.kind==='text'||isImage(item)){
      const cp=el('button','action-button','Copy');cp.type='button';cp.setAttribute('aria-label',item.kind==='text'?'Copy text':'Copy image');
      cp.onclick=async()=>{cp.disabled=true;try{if(item.kind==='text')await copy(item.text);else await copyImage(item);toast('Copied');}catch(e){toast(e.message);}finally{cp.disabled=false;}};actions.append(cp);
    }
    const download=el('a','action-button','Download');download.href=`/api/items/${item.id}/download`;download.download=item.name;download.title='Download original';download.setAttribute('aria-label',`Download ${item.name}`);actions.append(download);
    if(item.public){const link=el('button','action-button','Link');link.type='button';link.setAttribute('aria-label',`Copy share link for ${item.name}`);link.onclick=async()=>{try{const latest=await api('/api/items');if(!latest.some(i=>i.id===item.id&&i.public))throw new Error('This item is no longer public.');await copy(download.href);toast('Link copied');}catch(error){toast(error.message);}};actions.append(link);}
    if(item.canManage){const del=button('Delete now','trash','icon-button delete');del.onclick=async()=>{del.disabled=true;try{await api(`/api/items/${item.id}`,{method:'DELETE'});items=items.filter(i=>i.id!==item.id);renderItems();}catch(e){toast(e.message);del.disabled=false;}};actions.append(del);}
    toolbar.append(expiry,actions);card.append(toolbar);
    if(item.kind==='text'){
      const pre=el('pre','note-content');pre.tabIndex=0;
      for(const part of linkParts(item.text)){if(part.href){const link=el('a','',part.text);link.href=part.href;link.target='_blank';link.rel='noopener noreferrer';pre.append(link);}else pre.append(document.createTextNode(part.text));}card.append(pre);
    }else{
      if(isImage(item)&&item.size<32*1024*1024){const img=el('img','image-preview');img.loading='lazy';img.alt=item.name;img.src=`/api/items/${item.id}/preview`;img.addEventListener('error',()=>img.remove());card.append(img);}
      const row=el('div','item-main'),info=el('div','file-info'),name=el('h3','file-name',item.name);name.title=item.name;
      const meta=el('div','file-meta',bytes(item.size));meta.title=`SHA-256: ${item.sha256}`;info.append(name,meta);row.append(info);card.append(row);
    }
    holder.append(card);
  }
}

async function refresh(){
  if(refreshing){refreshAgain=true;return;}refreshing=true;
  const epoch=authEpoch;
  try{const result=await api('/api/items');if(epoch!==authEpoch)return;items=result;renderItems();$('#load-error').hidden=true;}catch(e){$('#load-error').hidden=false;}finally{$('#loading').hidden=true;refreshing=false;if(refreshAgain){refreshAgain=false;refresh();}}
}

function addFiles(files){
  if(!config||!currentUser){toast('Sign in before sending.');return;}
  for(const file of files){
    if(file.size>config.maxFileSize){toast(`${file.name} exceeds the ${bytes(config.maxFileSize)} limit.`);continue;}
    const row=el('div','transfer');const fi=el('span','file-icon');fi.append(icon('file'));const content=el('div','transfer-content');const top=el('div','transfer-top');const name=el('span','transfer-name',file.name);name.title=file.name;const status=el('span','transfer-status','Queued');top.append(name,status);const progress=el('progress');progress.max=100;progress.value=0;progress.setAttribute('aria-label',`Sending ${file.name}`);content.append(top,progress);const cancel=button('Cancel transfer','close');row.append(fi,content,cancel);$('#transfers').append(row);
    const task={file,row,status,progress,cancel,cancelled:false};cancel.onclick=()=>{task.cancelled=true;if(task.worker)task.worker.postMessage({action:'cancel'});else row.remove();};queue.push(task);
  }
  runQueue();
}

async function runQueue(){
  if(active)return;active=true;
  while(queue.length){
    const task=queue.shift();if(task.cancelled)continue;currentTask=task;
    await new Promise(resolve=>{
      const worker=new Worker('/transfer-worker.js');task.worker=worker;task.status.textContent='Starting…';
      const finish=()=>{worker.terminate();task.worker=null;resolve();};
      const failed=message=>{task.row.classList.add('failed');task.status.textContent=message;task.progress.hidden=true;task.cancel.title='Dismiss';task.cancel.setAttribute('aria-label','Dismiss');task.cancel.onclick=()=>task.row.remove();const retry=button('Retry transfer','upload','action-button');retry.append('Retry');retry.onclick=()=>{task.row.remove();addFiles([task.file]);};task.row.append(retry);finish();};
      worker.onmessage=({data})=>{
        if(data.type==='started')task.id=data.id;
        if(data.type==='progress'){task.progress.value=data.total?data.sent/data.total*100:100;task.status.textContent=`${Math.floor(task.progress.value)}% · ${bytes(data.speed)}/s`;}
        if(data.type==='verifying'){task.progress.value=100;task.status.textContent='Verifying…';}
        if(data.type==='done'){task.row.classList.add('done');task.status.textContent='Sent';task.progress.hidden=true;task.cancel.remove();setTimeout(()=>task.row.remove(),3500);refresh();finish();}
        if(data.type==='cancelled'){task.row.remove();finish();}
        if(data.type==='error')failed(data.message);
      };
      worker.onerror=()=>{if(task.id)fetch(`/api/items/${task.id}`,{method:'DELETE'}).catch(()=>{});failed('Transfer interrupted. Try again.');};
      worker.postMessage({action:'upload',file:task.file,config});
    });
  }
  active=false;currentTask=null;
}

const folderJobs=new Set();
async function sendFolder(name,getEntries){
  if(!config||!currentUser){toast('Sign in before sending.');return;}
  const epoch=authEpoch,maxSize=config.maxFileSize;
  const row=el('div','transfer'),label=el('span','transfer-name',name),status=el('span','transfer-status','Reading folder…'),cancel=button('Cancel folder upload','close');
  row.append(label,status,cancel);$('#transfers').append(row);
  const job={worker:null,cancelled:false,cancel(){this.cancelled=true;this.worker?.terminate();folderJobs.delete(this);row.remove();}};folderJobs.add(job);cancel.onclick=()=>job.cancel();
  try{
    const entries=await getEntries();if(job.cancelled||epoch!==authEpoch){job.cancel();return;}
    const worker=job.worker=new Worker('/folder-worker.js');status.textContent='Preparing ZIP…';
    const finish=()=>{worker.terminate();folderJobs.delete(job);};
    const fail=message=>{finish();row.classList.add('failed');status.textContent=message;cancel.setAttribute('aria-label','Dismiss');};
    worker.onerror=()=>fail('Could not prepare folder. Drop it again to retry.');
    worker.onmessage=({data})=>{
      if(job.cancelled||epoch!==authEpoch){job.cancel();return;}
      if(data.type==='progress')status.textContent=`Preparing ZIP · ${data.total?Math.floor(data.done/data.total*100):100}%`;
      if(data.type==='error')fail(data.message);
      if(data.type==='done'){finish();row.remove();addFiles([new File([data.blob],`${name}.zip`,{type:'application/zip'})]);}
    };
    worker.postMessage({entries,maxSize});
  }catch(error){folderJobs.delete(job);if(!job.cancelled){row.classList.add('failed');status.textContent=error.message||'Could not read folder.';cancel.setAttribute('aria-label','Dismiss');}}
}
$('#dropzone').addEventListener('click',()=>$('#file-input').click());
$('#choose-folder').onclick=event=>{event.stopPropagation();$('#folder-input').click();};
$('#folder-input').addEventListener('change',event=>{
  const files=Array.from(event.target.files);event.target.value='';if(!files.length)return;
  const name=files[0].webkitRelativePath.split('/')[0];
  sendFolder(name,async()=>files.map(file=>({path:file.webkitRelativePath,file})));
});
$('#file-input').addEventListener('change',event=>{addFiles(event.target.files);event.target.value='';});
let dragDepth=0;
window.addEventListener('dragenter',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth++;$('#drag-overlay').hidden=false;}});
window.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
window.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('#drag-overlay').hidden=true;});
window.addEventListener('drop',event=>{
  if(event.dataTransfer.types.includes('Files')){
    event.preventDefault();
    const dropped=Array.from(event.dataTransfer.items||[]).filter(item=>item.kind==='file').map(item=>({entry:item.webkitGetAsEntry?.(),file:item.getAsFile()}));
    if(!dropped.length)addFiles(event.dataTransfer.files);
    for(const {entry,file} of dropped){if(entry?.isDirectory)sendFolder(entry.name,()=>collectFolder(entry));else if(file)addFiles([file]);else toast('This browser could not read the drop. Use choose folder.');}
  }
  dragDepth=0;$('#drag-overlay').hidden=true;
});
let sendingNote=false;
function updateSend(){
  $('#send-note').disabled=sendingNote||!currentUser||!($('#note').value.length||draftFiles.length||clipboardDraft.suggestion);
}
function renderDraft(){
  for(const url of suggestionURLs)URL.revokeObjectURL(url);suggestionURLs=[];
  const ghost=$('#clipboard-suggestion'),suggestion=clipboardDraft.suggestion;
  ghost.replaceChildren();ghost.hidden=!suggestion;$('#note-form').classList.toggle('has-suggestion',!!suggestion);
  if(suggestion){
    if(suggestion.files.length){
      for(const file of suggestion.files.slice(0,3)){
        const row=el('div','suggested-file');
        if(isImage(file)){const image=el('img');image.alt='Clipboard image';image.src=URL.createObjectURL(file);suggestionURLs.push(image.src);row.append(image);}else row.append(icon('file'));
        row.append(el('span','',`${file.name} · ${bytes(file.size)}`));ghost.append(row);
      }
      if(suggestion.files.length>3)ghost.append(el('span','',`+ ${suggestion.files.length-3} more`));
    }else ghost.textContent=suggestion.text;
  }
  const attachments=$('#draft-files');attachments.replaceChildren();attachments.hidden=!draftFiles.length;
  draftFiles.forEach((file,index)=>{const chip=el('span','draft-file');chip.append(el('span','',file.name));const remove=button(`Remove ${file.name}`,'close');remove.onclick=()=>{draftFiles.splice(index,1);renderDraft();};chip.append(remove);attachments.append(chip);});
  $('#send-hint').textContent=suggestion?'Ctrl / ⌘ + Enter to send clipboard':'Ctrl / ⌘ + Enter to send';
  updateSend();
}
function suggest(value,explicit=false){
  if(!currentUser||draftFiles.length)return;
  if(clipboardDraft.offer(value,{explicit,hasText:!!$('#note').value.length}))renderDraft();
}
async function readClipboard(explicit=false){
  if(!currentUser||clipboardReading||sendingNote||$('#note').value||draftFiles.length||document.querySelector('dialog[open]'))return;
  if(!explicit&&(document.hidden||!document.hasFocus()))return;
  if(!navigator.clipboard?.read||!window.isSecureContext){if(explicit)toast('Press Ctrl / ⌘ + V to paste. Automatic previews need HTTPS.');return;}
  clipboardReading=true;const version=clipboardDraft.version,epoch=authEpoch;
  try{
    if(!explicit&&!clipboardReadAllowed){try{const permission=await navigator.permissions.query({name:'clipboard-read'});if(permission.state!=='granted')return;}catch{return;}}
    const clipboard=await navigator.clipboard.read();clipboardReadAllowed=true;const files=[];let text='';
    for(const entry of clipboard){
      const binary=entry.types.find(type=>!type.startsWith('text/'));
      if(binary){const blob=await entry.getType(binary);const ext=binary.split('/')[1]?.replace(/[^a-z0-9]/gi,'')||'bin';files.push(new File([blob],`clipboard.${ext}`,{type:binary,lastModified:0}));}
      else if(entry.types.includes('text/plain'))text+=(await (await entry.getType('text/plain')).text());
    }
    // Clipboard images can change without changing their name, size, or timestamp.
    const hashes=await Promise.all(files.map(async file=>new SHA256().update(new Uint8Array(await file.arrayBuffer())).digest()));
    if(epoch===authEpoch&&version===clipboardDraft.version&&!sendingNote&&(explicit||(!document.hidden&&document.hasFocus())))suggest({text:files.length?'':text,files,hashes},explicit);
  }catch{clipboardReadAllowed=false;if(explicit)toast('Clipboard access unavailable. Press Ctrl / ⌘ + V instead.');}
  finally{clipboardReading=false;}
}
$('#read-clipboard').onclick=()=>readClipboard(true);
// readClipboard skips background tabs, occupied drafts, and overlapping reads.
setInterval(()=>readClipboard(),1000);
window.addEventListener('focus',()=>readClipboard());
$('#note').addEventListener('focus',()=>readClipboard());
window.addEventListener('paste',event=>{
  if(!currentUser||document.querySelector('dialog[open]'))return;
  const target=event.target;
  if(target!==$('#note')&&(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target.isContentEditable))return;
  const files=Array.from(event.clipboardData?.files||[]),text=event.clipboardData?.getData('text/plain')||'';
  if(!files.length&&!text)return;
  if(files.length){event.preventDefault();clipboardDraft.dismiss();if($('#note').value.length){draftFiles.push(...files);renderDraft();}else suggest({text:'',files},true);$('#note').focus();return;}
  if(!$('#note').value.length&&!draftFiles.length){event.preventDefault();suggest({text,files:[]},true);$('#note').focus();}
  else if(target!==$('#note')){event.preventDefault();$('#note').focus();$('#note').setRangeText(text,$('#note').selectionStart,$('#note').selectionEnd,'end');updateSend();}
});
$('#note').addEventListener('beforeinput',()=>{clipboardDraft.dismiss();renderDraft();});
$('#note').addEventListener('input',()=>{clipboardDraft.dismiss();renderDraft();});
window.addEventListener('keydown',event=>{
  if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&currentUser&&!document.querySelector('dialog[open]')){event.preventDefault();$('#note-form').requestSubmit();}
  if(event.key==='Escape'&&clipboardDraft.suggestion){clipboardDraft.dismiss();renderDraft();}
  // Leave shortcuts, native controls, text selection, and dialogs alone.
  const target=event.target;
  if(!shouldRoutePageTyping(event,{signedIn:!!currentUser,dialogOpen:!!document.querySelector('dialog[open]'),editable:target instanceof Element&&!!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),interactive:target instanceof Element&&!!target.closest('button, a'),selection:!!window.getSelection()?.toString()}))return;
  event.preventDefault();clipboardDraft.dismiss();const field=$('#note');field.focus({preventScroll:true});
  field.setRangeText(event.key,field.selectionStart,field.selectionEnd,'end');renderDraft();
});
$('#note-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!currentUser||sendingNote)return;
  const field=$('#note'),suggestion=clipboardDraft.suggestion,text=field.value||(suggestion?.text||'');
  const files=[...draftFiles,...(suggestion?.files||[])];if(!text.length&&!files.length)return;
  const encoded=new TextEncoder().encode(text);if(encoded.length>(config?.maxNoteSize||1048576)){toast('Text is limited to 1 MiB. Send a file for larger text.');return;}
  const draftVersion=clipboardDraft.version,epoch=authEpoch;
  sendingNote=true;updateSend();
  try{
    if(text.length)await api('/api/notes',jsonOptions('POST',{text,sha256:new SHA256().update(encoded).digest()}));
    if(epoch!==authEpoch)return;
    if(files.length)addFiles(files);
    if(field.value===text)field.value='';
    if(clipboardDraft.version===draftVersion)clipboardDraft.dismiss();
    draftFiles=draftFiles.filter(file=>!files.includes(file));
    if(text.length){toast('Sent');refresh();}
  }catch(e){toast(e.message);}finally{sendingNote=false;renderDraft();}
});

function connectEvents(){
  events?.close();events=new EventSource('/api/events');
  events.onopen=()=>{$('#load-error').hidden=true;refresh();};
  events.onerror=()=>{if(currentUser)refreshAccount();};
  events.addEventListener('change',()=>{refresh();if(currentUser)refreshAccount();});
}
function showLogin(){
  for(const job of folderJobs)job.cancel();
  if(currentUser){authEpoch++;currentUser=null;config=null;events?.close();events=null;queue=[];currentTask?.worker?.postMessage({action:'cancel'});items=[];$('#items').replaceChildren();$('#note').value='';draftFiles=[];clipboardDraft.dismiss();renderDraft();for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();}
  $('#account-bar').hidden=false;$('#account-name').textContent='';$('#manage-users').hidden=true;$('#sign-out').hidden=true;$('#sign-in').hidden=false;$('#workspace').hidden=false;$('.send-panel').hidden=true;$('#login-screen').hidden=true;refresh();connectEvents();
}
function updateAccount(user){currentUser=user;$('#account-name').textContent=user.name;$('#manage-users').hidden=user.role!=='admin';if(user.role!=='admin')$('#users-dialog').close();}
async function refreshAccount(){const epoch=authEpoch;try{const user=await api('/api/auth/me');if(epoch===authEpoch&&currentUser)updateAccount(user);}catch{}}
async function startSession(user){
  authEpoch++;const epoch=authEpoch;updateAccount(user);events?.close();
  $('#login-screen').hidden=true;$('#workspace').hidden=false;$('#account-bar').hidden=false;$('.send-panel').hidden=false;$('#sign-in').hidden=true;$('#sign-out').hidden=false;$('#login-password').value='';$('#login-error').hidden=true;
  config=await api('/api/config');if(epoch!==authEpoch)return;
  await refresh();updateSend();
  connectEvents();
  readClipboard();
}
$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();$('#login-submit').disabled=true;$('#login-error').hidden=true;
  try{const user=await api('/api/auth/login',jsonOptions('POST',{username:$('#login-username').value.trim(),password:$('#login-password').value}));await startSession(user);}
  catch(e){$('#login-error').textContent=e.message;$('#login-error').hidden=false;}
  finally{$('#login-submit').disabled=false;}
});
$('#sign-in').onclick=()=>{$('#login-screen').hidden=!$('#login-screen').hidden;if(!$('#login-screen').hidden)$('#login-username').focus();};
$('#sign-out').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});showLogin();}catch(e){toast(e.message);}};

function userError(error){$('#users-error').textContent=error.message;$('#users-error').hidden=false;}
let passwordUser=null;
async function loadUsers(){
  const users=await api('/api/admin/users');const list=$('#users-list');list.replaceChildren();
  for(const user of users){
    const row=el('div','user-row');row.dataset.id=user.id;
    const name=el('input');name.value=user.name;name.maxLength=80;name.setAttribute('aria-label',`Name for ${user.name}`);
    const role=el('select');role.setAttribute('aria-label',`Role for ${user.name}`);for(const value of ['user','admin']){const option=el('option','',value==='admin'?'Admin':'User');option.value=value;role.append(option);}role.value=user.role;
    const save=button(`Save ${user.name}`,'check');save.onclick=async()=>{save.disabled=true;try{await api(`/api/admin/users/${user.id}`,jsonOptions('PATCH',{name:name.value,role:role.value}));updateAccount(await api('/api/auth/me'));toast('User updated');if(currentUser.role==='admin')await loadUsers();}catch(e){userError(e);}finally{save.disabled=false;}};
    const rotate=button(`Set password for ${user.name}`,'key');rotate.onclick=()=>{passwordUser=user;$('#password-title').textContent=`Password for ${user.name}`;$('#password-error').hidden=true;$('#password-dialog').showModal();$('#reset-password').focus();};
    const remove=button(`Delete ${user.name}`,'trash','icon-button delete');remove.onclick=async()=>{remove.disabled=true;try{await api(`/api/admin/users/${user.id}`,{method:'DELETE'});if(user.id===currentUser?.id)showLogin();else await loadUsers();toast('User deleted');}catch(e){userError(e);}finally{remove.disabled=false;}};
    row.append(name,role,save,rotate,remove);list.append(row);
  }
}
$('#manage-users').onclick=async()=>{$('#users-error').hidden=true;$('#users-dialog').showModal();try{await loadUsers();}catch(e){userError(e);}};
$('#close-users').onclick=()=>$('#users-dialog').close();
$('#create-user').addEventListener('submit',async event=>{
  event.preventDefault();const submit=event.submitter;submit.disabled=true;$('#users-error').hidden=true;
  try{await api('/api/admin/users',jsonOptions('POST',{name:$('#new-user-name').value,role:$('#new-user-role').value,password:$('#new-user-password').value}));$('#new-user-name').value='';$('#new-user-password').value='';await loadUsers();toast('User created');}catch(e){userError(e);}finally{submit.disabled=false;}
});
$('#close-password').onclick=()=>$('#password-dialog').close();
$('#password-dialog').addEventListener('close',()=>{$('#reset-password').value='';passwordUser=null;});
$('#password-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!passwordUser)return;const user=passwordUser,password=$('#reset-password').value,submit=event.submitter,own=user.id===currentUser?.id;submit.disabled=true;
  try{if(own)events?.close();await api(`/api/admin/users/${user.id}/password`,jsonOptions('POST',{password}));if(own)await startSession(await api('/api/auth/login',jsonOptions('POST',{username:user.name,password})));$('#password-dialog').close();toast('Password saved');}
  catch(e){$('#password-error').textContent=e.message;$('#password-error').hidden=false;}
  finally{submit.disabled=false;}
});

async function initialize(){
  try{await startSession(await api('/api/auth/me'));}catch(e){if(e.status!==401){showLogin();$('#login-error').textContent='Couldn’t reach sync. Reconnecting…';$('#login-error').hidden=false;setTimeout(initialize,3000);}}
}
initialize();
setInterval(()=>{let expired=false;for(const node of document.querySelectorAll('.expiry')){if(new Date(node.dataset.expires)<=Date.now())expired=true;else node.querySelector('.expiry-value').textContent=expiryText(node.dataset.expires);}if(expired){items=items.filter(i=>new Date(i.expires)>Date.now());renderItems();}},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();readClipboard();}});
window.addEventListener('beforeunload',event=>{if(active||queue.length||sendingNote||folderJobs.size){event.preventDefault();event.returnValue='';}});
