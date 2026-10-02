const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
require('../extension/sha256.js');require('../extension/shared.js');
const digest=b=>createHash('sha256').update(b).digest('hex');
test('extension package contains its manifest assets and matching shared sources',()=>{
 const root=path.join(__dirname,'../extension'),manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
 assert.equal(manifest.manifest_version,3);
 for(const file of [manifest.background.service_worker,manifest.action.default_popup,...Object.values(manifest.icons),...Object.values(manifest.action.default_icon)])assert.ok(fs.existsSync(path.join(root,file)),file);
 assert.equal(fs.readFileSync(path.join(root,'sha256.js'),'utf8'),fs.readFileSync(path.join(root,'../web/sha256.js'),'utf8'));
 assert.equal(fs.readFileSync(path.join(root,'links.js'),'utf8'),fs.readFileSync(path.join(root,'../web/links.js'),'utf8'));
 assert.equal(manifest.externally_connectable,undefined);
 assert.equal(manifest.omnibox.keyword,'sync');
});
test('server URLs reject credentials and unsafe schemes, including LAN and proxy support',()=>{
 assert.equal(SyncShared.server(' http://192.168.1.10:8080/ '),'http://192.168.1.10:8080');
 assert.equal(SyncShared.server('https://sync.example/proxy/'),'https://sync.example/proxy');
 assert.equal(SyncShared.permission('http://localhost:8080'),'http://localhost/*');
 for(const url of ['file:///etc/passwd','javascript:alert(1)','https://user:pass@example.com','https://example.com/?token=secret'])assert.throws(()=>SyncShared.server(url));
});
test('extension uploads original image bytes in parallel and verifies SHA256',async()=>{
 const data=Buffer.alloc(4096*7+113);for(let i=0;i<data.length;i++)data[i]=i%251;
 const chunks=new Map();let inflight=0,max=0,complete=false;
 const request=async(url,options)=>{
  if(url==='/api/uploads'){assert.equal(JSON.parse(options.body).name,'original.png');return {id:'fixture'};}
  if(url.endsWith('/complete')){assert.equal(JSON.parse(options.body).sha256,digest(data));assert.deepEqual(Buffer.concat([...chunks].sort((a,b)=>a[0]-b[0]).map(x=>x[1])),data);complete=true;return {id:'fixture'};}
  assert.equal(options.headers['X-Chunk-SHA256'],digest(options.body));inflight++;max=Math.max(max,inflight);await new Promise(r=>setTimeout(r,5));inflight--;chunks.set(Number(url.split('/').pop()),Buffer.from(options.body));
 };
 await SyncShared.upload(new Blob([data],{type:'image/png'}),'original.png',{chunkSize:4096,parallel:4,maxFileSize:100000},request);
 assert.equal(max,4);assert.ok(complete);
});
test('extension rejects oversize images and removes failed partial uploads',async()=>{
 let deleted=false;
 await assert.rejects(SyncShared.upload(new Blob(['abc']),'a',{maxFileSize:1},()=>{}),/limit/);
 await assert.rejects(SyncShared.upload(new Blob(['abc']),'a',{maxFileSize:10,chunkSize:2,parallel:2},async(url,options)=>{if(url==='/api/uploads')return {id:'fixture'};if(options.method==='DELETE'){deleted=true;return;}throw new Error('Checksum mismatch');}),/Checksum/);
 assert.ok(deleted);
});
test('download names cannot escape the Downloads directory',()=>{
 assert.equal(SyncShared.filename('https://example.com/a%2Fb.png','image/png'),'a_b.png');
 assert.equal(SyncShared.filename('https://example.com/..','image/png'),'image.png');
 assert.equal(SyncShared.filename('data:image/png;base64,abc','image/png').includes('/'),false);
});
test('links preserve queries, fragments and Unicode while rejecting browser pages and credentials',()=>{
 const link='https://example.com/🦊?q=a%20b&x=2#part';assert.equal(SyncShared.link(' '+link+' '),link);
 for(const url of [undefined,'chrome://settings','javascript:alert(1)','file:///foo','https://user:password@example.com'])assert.throws(()=>SyncShared.link(url),/HTTP or HTTPS/);
 assert.equal(SyncShared.videoType('https://example.com/clip.MP4?signature=abc'),'video/mp4');assert.equal(SyncShared.videoType('https://example.com/video.m3u8'),'');
 assert.equal(SyncShared.filename('https://example.com/','video/webm'),'video.webm');
});
test('content filters search Unicode snippets and filenames while excluding expired items',()=>{
 const expiry=new Date(Date.now()+86400000).toISOString(),note={name:'note.txt',kind:'text',text:'  Привіт 🦊',expires:expiry},image={name:'Original.SVG',kind:'file',type:'image/svg+xml',expires:expiry},file={name:'Project.zip',kind:'file',type:'application/zip',expires:expiry};
 assert.ok(SyncShared.matches(note,'привіт','text'));assert.ok(!SyncShared.matches(note,'','files'));assert.ok(SyncShared.matches(image,'original','images'));assert.ok(!SyncShared.matches(image,'','files'));assert.ok(SyncShared.matches(file,'project','files'));assert.ok(!SyncShared.matches({...file,expires:'2000-01-01'},'','all'));assert.ok(!SyncShared.matches(note,'missing','all'));
});
test('video streams split arbitrary network boundaries into exact parallel chunks',async()=>{
 const data=Buffer.alloc(1093);for(let i=0;i<data.length;i++)data[i]=i%251;
 let position=0,inflight=0,max=0;const chunks=new Map();
 const stream=new ReadableStream({pull(controller){if(position===data.length){controller.close();return;}const end=Math.min(position+177,data.length);controller.enqueue(data.subarray(position,end));position=end;}});
 const request=async(url,options)=>{
  if(url==='/api/uploads'){assert.equal(JSON.parse(options.body).size,data.length);return {id:'video'};}
  if(url.endsWith('/complete')){assert.equal(JSON.parse(options.body).sha256,digest(data));assert.deepEqual(Buffer.concat([...chunks].sort((a,b)=>a[0]-b[0]).map(v=>v[1])),data);return {id:'video'};}
  assert.equal(options.headers['X-Chunk-SHA256'],digest(options.body));inflight++;max=Math.max(max,inflight);await new Promise(r=>setTimeout(r,5));inflight--;chunks.set(Number(url.split('/').pop()),Buffer.from(options.body));
 };
 await SyncShared.uploadStream(stream,data.length,'video/mp4','clip.mp4',{chunkSize:128,parallel:4,maxFileSize:10000},request);
 assert.equal(max,4);assert.equal(chunks.size,9);assert.equal(chunks.get(8).length,69);assert.equal(stream.locked,false);
});
test('stream reading waits for the bounded upload window rather than buffering the video',async()=>{
 let produced=0,uploaded=0;const releases=[],data=Buffer.alloc(160,7);
 const stream=new ReadableStream({pull(controller){if(produced===10){controller.close();return;}produced++;controller.enqueue(data.subarray(0,16));}},{highWaterMark:0});
 const request=async(url,options)=>{
  if(url==='/api/uploads')return {id:'bounded'};
  if(url.endsWith('/complete')){assert.equal(JSON.parse(options.body).sha256,digest(data));return {};}
  uploaded++;await new Promise(resolve=>releases.push(resolve));
 };
 const sending=SyncShared.uploadStream(stream,160,'video/mp4','clip.mp4',{chunkSize:16,parallel:4,maxFileSize:1000},request);
 for(let i=0;i<100&&uploaded<4;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(uploaded,4);assert.equal(produced,4);
 while(uploaded<10){for(const release of releases.splice(0))release();await new Promise(r=>setTimeout(r,2));}
 for(const release of releases)release();await sending;
});
test('truncated, oversized and interrupted video streams delete partial uploads without publishing',async()=>{
 for(const mode of ['short','long','network','upload']){
  let deleted=false,completed=false,cancelled=false,reads=0;
  const stream=new ReadableStream({pull(controller){reads++;if(mode==='network'&&reads===2){controller.error(new Error('source failed'));return;}if(reads===1){controller.enqueue(new Uint8Array(mode==='long'?17:8));return;}controller.close();},cancel(){cancelled=true;}},{highWaterMark:0});
  const request=async(url,options)=>{if(url==='/api/uploads')return {id:'failed'};if(options.method==='DELETE'){deleted=true;return;}if(url.endsWith('/complete')){completed=true;return;}if(mode==='upload')throw new Error('upload failed');};
  await assert.rejects(SyncShared.uploadStream(stream,16,'video/mp4','clip.mp4',{chunkSize:4,parallel:2,maxFileSize:100},request),/incomplete|size changed|source failed|upload failed/);
  assert.ok(deleted);assert.equal(completed,false);assert.equal(stream.locked,false);if(mode==='long'||mode==='upload')assert.equal(cancelled,true);
 }
});
