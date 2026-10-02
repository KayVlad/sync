const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto');
const {prepareChrome}=require('./extension-harness.cjs');
const digest=b=>createHash('sha256').update(b).digest('hex');
function harness(settings={}){
 const store={},menus=[],downloads=[],requests=[],notes=[],files=new Map(),allocations=[];let messageListener,contextListener,omniboxListener;
 const fixture=settings.fixture||Buffer.from('original image bytes');const event=()=>({addListener(){}});
 const chrome={runtime:{id:'a'.repeat(32),onInstalled:event(),onStartup:event(),onMessage:{addListener(fn){messageListener=fn;}}},
  storage:{local:{setAccessLevel:async()=>{},get:async keys=>{if(typeof keys==='string')return {[keys]:store[keys]};return {...store};},set:async value=>Object.assign(store,value),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete store[key];}}},
  contextMenus:{removeAll:async()=>{},create:v=>menus.push(v),onClicked:{addListener(fn){contextListener=fn;}}},permissions:{request:async()=>true},
  omnibox:{onInputStarted:event(),setDefaultSuggestion:async()=>{},onInputEntered:{addListener(fn){omniboxListener=fn;}}},tabs:{query:async()=>[{id:1,url:settings.tabURL||'https://page.example/a?b=1#fragment'}]},
  action:{setBadgeBackgroundColor:async()=>{},setBadgeText:async()=>{},setTitle:async()=>{}},downloads:{download:async opts=>{downloads.push(opts);return 1;}}
 };
 const native=prepareChrome(chrome);
 const context=vm.createContext({crypto:webcrypto,chrome,URL,Blob,Uint8Array,Uint32Array,DataView,TextEncoder,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,btoa,atob,console,fetch:async(url,fetchOptions={})=>{
  requests.push({url,options:fetchOptions});
  if(url==='https://image.example/original.png')return new Response(fixture,{headers:{'Content-Type':'image/png'}});
  if(url==='https://video.example/original.mp4')return new Response(fixture,{headers:settings.videoHeaders||{'Content-Type':'video/mp4','Content-Length':String(fixture.length)}});
  const options=fetchOptions;
  const route=new URL(url).pathname;
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Sync-Client'],'extension');
  if(route==='/api/auth/extension/login'){assert.deepEqual(JSON.parse(options.body),{username:'user',password:'p'});return Response.json({token:'session-secret',expires:'2099-01-01',user:{id:'u',name:'user'}});}
  assert.equal(options.headers.Authorization,'Bearer session-secret');
  if(route==='/api/auth/me')return Response.json({id:'u',name:'user'});
  if(route==='/api/config')return Response.json({chunkSize:4096,parallel:4,maxFileSize:100*1024*1024,maxNoteSize:1048576});
  if(route==='/api/items')return Response.json([{id:'b'.repeat(32),name:'original.png',type:'image/png',size:fixture.length}]);
  if(route==='/api/notes'){const note=JSON.parse(options.body);assert.equal(note.sha256,digest(Buffer.from(note.text)));notes.push(note);return Response.json({id:'note'});}
  if(route==='/api/uploads'){const record=JSON.parse(options.body);allocations.push(record);return Response.json({...record,id:'b'.repeat(32),expires:new Date(Date.now()+86400000).toISOString()});}
  if(route.endsWith('/complete')){assert.equal(JSON.parse(options.body).sha256,digest(fixture));assert.deepEqual(Buffer.concat([...files].sort((a,b)=>a[0]-b[0]).map(v=>v[1])),fixture);return Response.json({id:'b'.repeat(32)});}
  if(options.method==='PUT'){assert.equal(options.headers['X-Chunk-SHA256'],digest(options.body));files.set(Number(route.split('/').pop()),Buffer.from(options.body));return new Response(null,{status:204});}
  if(route.endsWith('/download'))return new Response(fixture);
  if(route==='/api/auth/logout')return new Response(null,{status:204});
  throw new Error('Unexpected request '+route);
 }});
 context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',file),'utf8'),context));
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
 native.attach(context);
 return {native,drain:native.drain,context,store,menus,downloads,requests,notes,files,fixture,allocations,messageListener,contextListener,omniboxListener};
}
test('background authenticates without storing passwords, scopes tokens to server, and downloads with auth',async()=>{
 const h=harness();h.context.login={action:'login',server:'http://localhost:8080/',username:'user',password:'p'};
 await vm.runInContext('handleMessage(login)',h.context);
 assert.equal(h.store.connection.token,'session-secret');assert.ok(!JSON.stringify(h.store).includes('password'));
 await vm.runInContext("handleMessage({action:'list'})",h.context);
 await vm.runInContext("handleMessage({action:'download',id:'b'.repeat(32)})",h.context);
 assert.equal(h.downloads[0].url,'http://localhost:8080/api/items/'+'b'.repeat(32)+'/download');
 assert.ok(h.downloads[0].headers.some(header=>header.name==='Authorization'&&header.value==='Bearer session-secret'));
 await vm.runInContext("handleMessage({action:'logout'})",h.context);assert.equal(h.store.connection,undefined);
});
test('context menu text and images retain original bytes; source requests never receive sync tokens',async()=>{
 const h=harness();h.store.connection={server:'http://localhost:8080',token:'session-secret',user:{id:'u',name:'user'}};
 h.context.info={selectionText:'  Привіт\t🦊\r\nhttps://example.com/'};
 await vm.runInContext('syncContext(info,null,Promise.resolve(false))',h.context);await h.drain();assert.equal(h.notes[0].text,h.context.info.selectionText);assert.equal(h.store.lastStatus.message,'Sent');
 h.context.info={mediaType:'image',srcUrl:'https://image.example/original.png'};
 await vm.runInContext('syncContext(info,null,Promise.resolve(true))',h.context);await h.drain();
 assert.equal(h.store.lastStatus.message,'Sent');assert.ok(h.files.size>0);
 const imageRequest=h.requests.find(r=>r.url==='https://image.example/original.png');assert.equal(imageRequest.options.headers,undefined);
});
test('page links, the current tab and address-bar commands send exact URLs as private notes',async()=>{
 const h=harness();h.store.connection={server:'http://localhost:8080',token:'session-secret',user:{id:'u',name:'user'}};
 await vm.runInContext('setupMenus()',h.context);assert.deepEqual(Array.from(h.menus[0].contexts),['selection','image','link','video']);
 h.context.info={linkUrl:'https://example.com/a?q=a%20b&x=2#part'};
 await vm.runInContext('syncContext(info,null,Promise.resolve(false))',h.context);await h.drain();
 assert.equal(h.notes[0].text,h.context.info.linkUrl);assert.equal(h.notes[0].public,undefined);
 await vm.runInContext("handleMessage({action:'sync-url'})",h.context);await h.drain();
 assert.equal(h.notes[1].text,'https://page.example/a?b=1#fragment');
 h.omniboxListener('https://example.com/address-bar?q=🦊');
 for(let i=0;i<100&&h.notes.length<3;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(h.notes[2].text,'https://example.com/address-bar?q=🦊');
});
test('restricted current tabs cannot be sent',async()=>{
 const h=harness({tabURL:'chrome://settings/'});h.store.connection={server:'http://localhost:8080',token:'session-secret',user:{id:'u',name:'user'}};
 await assert.rejects(vm.runInContext("handleMessage({action:'sync-url'})",h.context),/HTTP or HTTPS/);assert.equal(h.notes.length,0);
});
test('direct video elements and file links preserve source bytes and never receive sync tokens',async()=>{
 const fixture=Buffer.alloc(17003);for(let i=0;i<fixture.length;i++)fixture[i]=i%251;
 for(const info of [{mediaType:'video',srcUrl:'https://video.example/original.mp4'},{linkUrl:'https://video.example/original.mp4'}]){
  const h=harness({fixture});h.store.connection={server:'http://localhost:8080',token:'session-secret',user:{id:'u',name:'user'}};h.context.info=info;
  await vm.runInContext('syncContext(info,null,Promise.resolve(true))',h.context);await h.drain();
  assert.equal(h.store.lastStatus.message,'Sent');assert.equal(h.allocations[0].type,'video/mp4');assert.equal(h.allocations[0].name,'original.mp4');assert.equal(h.files.size,5);
  const source=h.requests.find(r=>r.url===info.srcUrl||r.url===info.linkUrl);assert.equal(source.options.headers?.Authorization,undefined);assert.equal(source.options.headers?.['X-Sync-Client'],undefined);assert.equal(source.options.credentials,'include');
 }
});
test('video streams, denied permissions, HTML sources and unknown lengths fail before allocating uploads',async()=>{
 const cases=[{src:'blob:https://example.com/id',allowed:true,error:/stream or blob/},{src:'',allowed:true,error:/stream or blob/},{src:'https://video.example/original.mp4',allowed:false,error:/Allow access/},{src:'https://video.example/original.mp4',allowed:true,headers:{'Content-Type':'text/html','Content-Length':'20'},error:/direct video file/},{src:'https://video.example/original.mp4',allowed:true,headers:{'Content-Type':'video/x-mpegurl','Content-Length':'20'},error:/Streaming playlists/},{src:'https://video.example/original.mp4',allowed:true,headers:{'Content-Type':'video/mp4'},error:/file size/},{src:'https://video.example/original.mp4',allowed:true,headers:{'Content-Type':'video/mp4','Content-Length':'200000000'},error:/server upload limit/},{src:'https://video.example/original.mp4',allowed:true,headers:{'Content-Type':'video/mp4','Content-Length':'20','Content-Encoding':'gzip'},error:/file size/}];
 for(const c of cases){
  const h=harness({videoHeaders:c.headers});h.store.connection={server:'http://localhost:8080',token:'session-secret',user:{id:'u',name:'user'}};h.context.info={mediaType:'video',srcUrl:c.src};h.context.allowed=c.allowed;
  if(!c.allowed||!/^https?:/.test(c.src))await assert.rejects(vm.runInContext('syncContext(info,null,Promise.resolve(allowed))',h.context),c.error);else{await vm.runInContext('syncContext(info,null,Promise.resolve(allowed))',h.context);await h.drain();assert.match(h.store.lastStatus.message,c.error);}assert.equal(h.allocations.length,0);assert.equal(h.store.lastStatus.error,true);
 }
});
test('content-script messages cannot invoke privileged extension actions',()=>{
 const h=harness();let replied=false;
 assert.equal(h.messageListener({action:'list'},{id:'a'.repeat(32),tab:{id:1}},()=>{replied=true;}),undefined);
 assert.equal(h.messageListener({action:'list'},{id:'other'},()=>{replied=true;}),undefined);assert.equal(replied,false);
});
test('quick-send shortcut captures selection or falls back to the current URL',async()=>{
 const h=harness();h.store.connection={server:'http://localhost:8080',token:'session-secret',user:{id:'u'}};
 h.context.chrome.scripting={executeScript:async()=>[{result:'  selected\t🦊\n'}]};await vm.runInContext('quickSend()',h.context);await h.drain();assert.equal(h.notes[0].text,'  selected\t🦊\n');
 h.context.chrome.scripting.executeScript=async()=>[{result:''}];await vm.runInContext('quickSend()',h.context);await h.drain();assert.equal(h.notes[1].text,'https://page.example/a?b=1#fragment');
});
test('private items have no share link and privileged engine messages require the offscreen sender',async()=>{
 const h=harness();h.store.connection={server:'http://localhost:8080',token:'session-secret',user:{id:'u'}};
 await assert.rejects(vm.runInContext("handleMessage({action:'share-link',id:'b'.repeat(32)})",h.context),/Only public/);
 await assert.rejects(vm.runInContext("handleMessage({action:'engine-connection'},{url:chrome.runtime.getURL('popup.html')})",h.context),/Untrusted/);
 const result=await vm.runInContext("handleMessage({action:'engine-connection'},{url:chrome.runtime.getURL('offscreen.html')})",h.context);assert.equal(result.token,'session-secret');
});
