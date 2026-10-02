// End-to-end API smoke check. Chrome APIs are simulated; the extension background and server are real.
// Run against a disposable local server: SYNC_EXTENSION_TEST_URL, SYNC_EXTENSION_TEST_PASSWORD.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto'),{prepareChrome}=require('./extension-harness.cjs');
const server=process.env.SYNC_EXTENSION_TEST_URL,password=process.env.SYNC_EXTENSION_TEST_PASSWORD;
if(!server||!password)throw new Error('Set the disposable test server URL and password.');
const store={},event=()=>({addListener(){}});let downloaded;
const chrome={runtime:{id:'a'.repeat(32),onInstalled:event(),onStartup:event(),onMessage:event()},storage:{local:{setAccessLevel:async()=>{},get:async key=>typeof key==='string'?{[key]:store[key]}:{...store},set:async value=>Object.assign(store,value),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete store[key];}}},contextMenus:{onClicked:event(),removeAll:async()=>{},create(){}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},permissions:{request:async()=>true},downloads:{download:async options=>{
 const response=await fetch(options.url,{headers:Object.fromEntries(options.headers.map(h=>[h.name,h.value]))});assert.equal(response.status,200);downloaded=Buffer.from(await response.arrayBuffer());return 1;
}}};
chrome.omnibox={onInputStarted:event(),onInputEntered:event(),setDefaultSuggestion:async()=>{}};
chrome.tabs={query:async()=>[{id:1,url:'https://example.com/current-tab?x=a%20b#part'}]};
const native=prepareChrome(chrome);
const context=vm.createContext({crypto:webcrypto,chrome,URL,Blob,Uint8Array,Uint32Array,DataView,TextEncoder,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,btoa,atob,console,fetch:(url,options={})=>fetch(url,{...options,headers:{...options.headers,...(String(url).startsWith(server)?{Origin:'chrome-extension://'+'a'.repeat(32),'Sec-Fetch-Site':'cross-site'}:{})}})});
context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',file),'utf8'),context));
vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
native.attach(context);
(async()=>{
 context.login={action:'login',server,username:'extension-test',password};await vm.runInContext('handleMessage(login)',context);
 const token=store.connection.token;assert.ok(token);assert.ok(!JSON.stringify(store).includes(password));
 context.info={selectionText:'  Привіт\t🦊\r\nhttps://example.com/'};await vm.runInContext('syncContext(info,null,Promise.resolve(false))',context);await native.drain();assert.equal(store.lastStatus.message,'Sent');
 const image=fs.readFileSync(path.join(__dirname,'../extension/icons/128.png'));
 context.info={mediaType:'image',srcUrl:'data:image/png;base64,'+image.toString('base64')};await vm.runInContext('syncContext(info,null,Promise.resolve(false))',context);await native.drain();assert.equal(store.lastStatus.message,'Sent');
 context.info={linkUrl:'https://example.com/link?token=a%20b#section'};await vm.runInContext('syncContext(info,null,Promise.resolve(false))',context);await native.drain();
 await vm.runInContext("handleMessage({action:'sync-url'})",context);await native.drain();
 // Synthetic MP4-sized payload larger than the image capture cap, served in irregular network chunks.
 const video=Buffer.alloc(32*1024*1024+113);for(let i=0;i<video.length;i++)video[i]=i%251;video.write('ftypisom',4,'ascii');
 const videoSource=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-sync-client'],undefined);
  res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':video.length});
  for(let start=0;start<video.length&&!res.destroyed;start+=70001){if(!res.write(video.subarray(start,start+70001)))await new Promise(resolve=>{const drained=()=>{res.off('close',closed);resolve();},closed=()=>{res.off('drain',drained);resolve();};res.once('drain',drained);res.once('close',closed);});}res.end();
 });
 await new Promise(resolve=>videoSource.listen(0,'127.0.0.1',resolve));
 try{context.info={mediaType:'video',srcUrl:`http://127.0.0.1:${videoSource.address().port}/clip.mp4`};await vm.runInContext('syncContext(info,null,Promise.resolve(true))',context);await native.drain();assert.equal(store.lastStatus.message,'Sent');}
 finally{await new Promise(resolve=>videoSource.close(resolve));}
 const result=await vm.runInContext("handleMessage({action:'list'})",context);assert.equal(result.items.length,5);assert.ok(result.items.every(i=>!i.public&&i.ownerId===result.user.id));
 assert.ok(result.items.some(i=>i.text==='https://example.com/link?token=a%20b#section'));assert.ok(result.items.some(i=>i.text==='https://example.com/current-tab?x=a%20b#part'));
 const text=result.items.find(i=>i.text?.startsWith('  Привіт')),file=result.items.find(i=>i.type==='image/png');assert.equal(text.text,'  Привіт\t🦊\r\nhttps://example.com/');
 context.imageID=file.id;const source=await vm.runInContext("handleMessage({action:'image',id:imageID})",context);assert.deepEqual(Buffer.from(source.base64,'base64'),image);
 await vm.runInContext("handleMessage({action:'download',id:imageID})",context);assert.deepEqual(downloaded,image);
 context.videoID=result.items.find(i=>i.type==='video/mp4').id;await vm.runInContext("handleMessage({action:'download',id:videoID})",context);assert.deepEqual(downloaded,video);
 context.cleanupIDs=result.items.map(i=>i.id);await vm.runInContext("(async()=>{const c=await connection();for(const id of cleanupIDs)await request(c,'/api/items/'+id,{method:'DELETE'});})()",context);
 assert.equal((await vm.runInContext("handleMessage({action:'list'})",context)).items.length,0);
 await vm.runInContext("handleMessage({action:'logout'})",context);assert.equal(store.connection,undefined);
 const revoked=await fetch(server+'/api/auth/me',{headers:{Authorization:'Bearer '+token}});assert.equal(revoked.status,401);
 console.log('Real-server smoke passed: login, exact text/image/link/current-tab sends, streamed 32+ MiB video, private list, copy source, original downloads, logout/revocation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
