importScripts('sha256.js','shared.js','store.js');
const MAX_IMAGE=32*1024*1024;
let busy=false;
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).catch(()=>{});
async function setupMenus(){await chrome.contextMenus.removeAll();chrome.contextMenus.create({id:'sync-it',title:'Sync it',contexts:['selection','image','link','video'],documentUrlPatterns:['http://*/*','https://*/*']});}
chrome.runtime.onInstalled.addListener(()=>{setupMenus();scheduleCleanup();});
chrome.runtime.onStartup.addListener(()=>{setupMenus();scheduleCleanup();ensureEngine().catch(()=>{});});
chrome.omnibox.onInputStarted.addListener(()=>chrome.omnibox.setDefaultSuggestion({description:'Send this URL to sync.'}));
chrome.omnibox.onInputEntered.addListener(text=>syncContext({selectionText:text.trim(),urlOnly:true},null,Promise.resolve(false)).catch(error=>status(error.message,true)));
async function connection(){const {connection}=await chrome.storage.local.get('connection');if(!connection?.token)throw new Error('Open sync. and sign in first.');return connection;}
async function request(c,path,options={},retry=false){
  for(let attempt=0;;attempt++){
    try{
      const headers={'X-Sync-Client':'extension',...options.headers};if(c.token)headers.Authorization=`Bearer ${c.token}`;
      if(typeof options.body==='string')headers['Content-Type']='application/json';
      const response=await fetch(c.server+path,{...options,headers,credentials:'omit',cache:'no-store',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000),redirect:'error'});
      if(!response.ok){const body=await response.json().catch(()=>({}));const error=new Error(body.error||(response.status===404?'Item expired or unavailable.':'Could not reach sync.'));error.status=response.status;throw error;}
      if(options.binary)return response.blob();return response.status===204?null:response.json();
    }catch(error){
      if(!retry||attempt>=3||(error.status&&error.status<500&&error.status!==408&&error.status!==429)){
        if(error.status===401){const saved=await chrome.storage.local.get('connection');if(saved.connection?.token===c.token)await chrome.storage.local.remove('connection');}
        throw error;
      }
      await new Promise(resolve=>setTimeout(resolve,400*2**attempt));
    }
  }
}
async function status(message,error=false){await chrome.storage.local.set({lastStatus:{message,error,time:Date.now()}});await chrome.action.setBadgeBackgroundColor({color:error?'#b34d35':'#f08764'});await chrome.action.setBadgeText({text:error?'!':busy||message==='Queued'?'…':'✓'});await chrome.action.setTitle({title:`sync. · ${message}`});}
async function readImage(info,tab,allowed){
  const src=info.srcUrl;if(!src)throw new Error('No image found.');
  let blob;
  if(/^https?:/.test(src)&&allowed){
    const response=await fetch(src,{credentials:'include',signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw new Error('Could not retrieve the original image.');
    const length=Number(response.headers.get('Content-Length'));if(length>MAX_IMAGE)throw new Error('Context-menu images are limited to 32 MiB.');
    const chunks=[];let size=0;const reader=response.body.getReader();
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_IMAGE)throw new Error('Context-menu images are limited to 32 MiB.');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    blob=new Blob(chunks,{type:response.headers.get('Content-Type')?.split(';')[0]||''});
  }else if(/^data:image\//.test(src)){blob=await (await fetch(src)).blob();}
  else if(/^blob:|^https?:/.test(src)&&tab?.id){
    const results=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[info.frameId||0]},func:async(src,max)=>{
      const response=await fetch(src);if(!response.ok)throw new Error('Image unavailable.');const blob=await response.blob();if(blob.size>max)throw new Error('Context-menu images are limited to 32 MiB.');
      const bytes=new Uint8Array(await blob.arrayBuffer()),parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
      return {base64:btoa(parts.join('')),type:blob.type};
    },args:[src,MAX_IMAGE]});
    const result=results[0]?.result;if(!result)throw new Error('Could not read this image.');blob=new Blob([Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0))],{type:result.type});
  }else throw new Error('This image URL is unsupported.');
  if(blob.size>MAX_IMAGE)throw new Error('Context-menu images are limited to 32 MiB.');
  if(!blob.type.startsWith('image/'))throw new Error('The image source did not return image bytes.');return blob;
}
function videoURL(info){return info.mediaType==='video'?info.srcUrl:!info.selectionText&&SyncShared.videoType(info.linkUrl)?info.linkUrl:null;}
let creating;
function scheduleCleanup(){chrome.alarms.create('expire-transfers',{periodInMinutes:1});}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='expire-transfers')SyncStore.expire().catch(()=>{});});
async function ensureEngine(){
  if(creating)return creating;
  creating=(async()=>{const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});if(!contexts.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'Read staged file Blobs in bounded chunks and retain resumable transfers after the popup closes.'});})();
  try{await creating;}finally{creating=null;}
}
async function engineMessage(action,data={}){await ensureEngine();const reply=await chrome.runtime.sendMessage({target:'engine',action,...data});if(!reply?.ok)throw new Error(reply?.error||'Transfer engine unavailable.');return reply.result;}
async function enqueue(c,kind,name,extra={},blob){
  await SyncStore.expire();const job=SyncStore.job(c,kind,name,extra);await SyncStore.add(job,blob);await status('Queued');await chrome.storage.local.set({queueTick:Date.now()});await engineMessage('wake');return {id:job.id};
}
chrome.contextMenus.onClicked.addListener((info,tab)=>{
  if(info.menuItemId!=='sync-it')return;
  const source=info.mediaType==='image'?info.srcUrl:videoURL(info);let sameOrigin=false;try{sameOrigin=!!source&&new URL(source).origin===new URL(tab.url).origin;}catch{}
  // Video permissions persist because a queued transfer can outlive the source tab.
  const sourcePermission=/^https?:/.test(source||'')?(sameOrigin&&info.mediaType==='image'?Promise.resolve(true):chrome.permissions.request({origins:[SyncShared.permission(source)]}).catch(()=>false)):Promise.resolve(false);
  syncContext(info,tab,sourcePermission).catch(()=>{});
});
async function syncContext(info,tab,sourcePermission){
  try{
    const c=await connection();
    if(info.mediaType==='image'){
      if(busy)throw new Error('An image capture is already running.');
      busy=true;try{const blob=await readImage(info,tab,await sourcePermission);return await enqueue(c,'file',SyncShared.filename(info.srcUrl,blob.type),{size:blob.size,type:blob.type},blob);}finally{busy=false;}
    }
    if(info.mediaType==='video'||videoURL(info)){
      const src=videoURL(info);if(!/^https?:/.test(src||''))throw new Error('This video is a stream or blob. Download the file and send it in sync.');
      SyncShared.link(src);if(!await sourcePermission)throw new Error('Allow access to the video source to send it.');return await enqueue(c,'video',SyncShared.filename(src,SyncShared.videoType(src)),{source:src});
    }
    const text=info.urlOnly?SyncShared.link(info.selectionText):info.selectionText||SyncShared.link(info.linkUrl),bytes=new TextEncoder().encode(text);
    const config=await request(c,'/api/config');if(!bytes.length||bytes.length>config.maxNoteSize)throw new Error('Text exceeds the server note limit.');
    return await enqueue(c,'text',text.trim().split(/\r?\n/)[0].slice(0,60)||'Text',{size:bytes.length,type:'text/plain; charset=utf-8'},new Blob([bytes],{type:'text/plain; charset=utf-8'}));
  }catch(error){await status(error.message,true);throw error;}
}
chrome.commands.onCommand.addListener((command,tab)=>{if(command==='quick-send')quickSend(tab).catch(error=>status(error.message,true));});
async function quickSend(tab){
  if(!tab){[tab]=await chrome.tabs.query({active:true,currentWindow:true});}const url=SyncShared.link(tab?.url);let text='';
  try{const results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{const active=document.activeElement;if(active?.type==='password')return '';if(['INPUT','TEXTAREA'].includes(active?.tagName)&&typeof active.selectionStart==='number')return active.value.slice(active.selectionStart,active.selectionEnd);return window.getSelection()?.toString()||'';}});text=results[0]?.result||'';}catch{}
  return syncContext({selectionText:text||url,urlOnly:!text},tab,Promise.resolve(false));
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.target==='engine'||sender.id!==chrome.runtime.id||sender.tab)return;
  handleMessage(message,sender).then(result=>reply({ok:true,result})).catch(error=>reply({ok:false,error:error.message}));return true;
});
async function handleMessage(message,sender={}){
  if(message.action==='engine-connection'||message.action==='engine-update'){
    if(sender.url!==chrome.runtime.getURL('offscreen.html'))throw new Error('Untrusted engine message.');
    if(message.action==='engine-connection')return connection();
    const event=message.event;await chrome.storage.local.set({queueTick:Date.now()});
    if(event.status==='sending'){await chrome.action.setBadgeText({text:event.size?Math.floor((event.sent||0)/event.size*100)+'%':'…'});}
    else if(event.status==='paused')await chrome.action.setBadgeText({text:'Ⅱ'});
    else if(event.status==='cancelled')await chrome.action.setBadgeText({text:''});
    else if(event.status==='sent')await status('Sent');else if(event.status==='failed')await status(event.error||'Transfer failed.',true);return null;
  }
  if(message.action==='wake'){await connection();await engineMessage('wake');return null;}

  if(message.action==='login'){
    if(busy)throw new Error('Wait for the image capture to finish.');
    const previous=await chrome.storage.local.get('connection');if(previous.connection)await engineMessage('pause-account');
    const server=SyncShared.server(message.server),login=await request({server},'/api/auth/extension/login',{method:'POST',body:JSON.stringify({username:message.username,password:message.password})});
    const c={server,token:login.token,expires:login.expires,user:login.user};await chrome.storage.local.set({connection:c,server});await chrome.storage.local.remove('lastStatus');await engineMessage('wake');return {user:login.user,server};
  }
  const c=await connection();
  if(message.action==='list'){const user=await request(c,'/api/auth/me');const items=await request(c,'/api/items');return {user,server:c.server,items};}
  if(message.action==='logout'){
    if(busy)throw new Error('Wait for the current transfer to finish.');
    await engineMessage('pause-account');await request(c,'/api/auth/logout',{method:'POST'});await chrome.storage.local.remove(['connection','lastStatus']);await chrome.action.setBadgeText({text:''});return null;
  }
  if(message.action==='sync-url'){
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const text=SyncShared.link(tab?.url);return syncContext({selectionText:text,urlOnly:true},tab,Promise.resolve(false));
  }
  if(message.action==='queue-info'){const user=await request(c,'/api/auth/me');return {user,server:c.server,config:await request(c,'/api/config')};}
  const id=SyncShared.itemID(message.id);
  if(message.action==='queue-control')return engineMessage('control',{id,control:message.control});
  if(message.action==='share-link'){
    const items=await request(c,'/api/items'),item=items.find(i=>i.id===id);if(!item?.public)throw new Error('Only public items have share links.');return c.server+'/api/items/'+id+'/download';
  }

  if(message.action==='download'){
    const items=await request(c,'/api/items'),item=items.find(i=>i.id===id);if(!item)throw new Error('Item expired or unavailable.');
    return chrome.downloads.download({url:`${c.server}/api/items/${id}/download`,filename:SyncShared.filename('https://file/'+encodeURIComponent(item.name),item.type),headers:[{name:'Authorization',value:`Bearer ${c.token}`},{name:'X-Sync-Client',value:'extension'}]});
  }
  if(message.action==='image'){
    const items=await request(c,'/api/items'),item=items.find(i=>i.id===id);if(!item||!SyncShared.imageType(item.type))throw new Error('Image unavailable.');if(item.size>MAX_IMAGE)throw new Error('Use Download for images larger than 32 MiB.');
    const blob=await request(c,`/api/items/${id}/download`,{binary:true});const bytes=new Uint8Array(await blob.arrayBuffer()),parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
    return {base64:btoa(parts.join('')),type:item.type};
  }
  throw new Error('Unknown action.');
}
