const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {MemoryStore}=require('./extension-harness.cjs');
require('../extension/sha256.js');require('../extension/shared.js');require('../extension/queue.js');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(options={}){
 const store=new MemoryStore(),events=[],uploads=new Map(),puts=[],sourceReads=[];let inflight=0,max=0,failed=false,etag='"v1"',hold=!!options.hold;
 const c={server:'http://sync.local',token:'secret',user:{id:'owner'}};const data=options.data||Buffer.alloc(1093,7);
 const fetcher=async(url,opts={})=>{
  if(url==='https://video.local/clip.mp4'){
   assert.equal(opts.headers?.Authorization,undefined);assert.equal(opts.credentials,'include');sourceReads.push(opts.headers?.Range||'full');
   const range=/^bytes=(\d+)-(\d+)$/.exec(opts.headers?.Range||'');if(!options.noRanges&&range){const start=+range[1],end=+range[2];return new Response(data.subarray(start,end+1),{status:206,headers:{'Content-Type':'video/mp4','Content-Range':`bytes ${start}-${end}/${data.length}`,'Content-Length':String(end-start+1),ETag:etag}});}
   return new Response(data,{headers:{'Content-Type':'video/mp4','Content-Length':String(data.length),ETag:etag}});
  }
  assert.ok(url.startsWith(c.server));assert.equal(opts.headers.Authorization,'Bearer secret');assert.equal(opts.credentials,'omit');const path=new URL(url).pathname;
  if(path==='/api/config')return Response.json({chunkSize:128,parallel:4,maxFileSize:100000,maxNoteSize:1048576});
  if(path==='/api/notes'){const note=JSON.parse(opts.body);assert.equal(note.sha256,digest(Buffer.from(note.text)));assert.equal(note.clientId.length,32);return Response.json({id:'note'});}
  if(path==='/api/uploads'){const req=JSON.parse(opts.body),id='a'.repeat(32);uploads.set(id,{...req,id,chunks:[],bytes:new Map(),expires:new Date(Date.now()+86400000).toISOString()});return Response.json({...req,id,expires:uploads.get(id).expires});}
  const [,id,index]=/^\/api\/uploads\/([^/]+)(?:\/([^/]+))?$/.exec(path)||[];
  if(opts.method==='DELETE'){uploads.delete(path.split('/')[3]);return new Response(null,{status:204});}
  const record=uploads.get(id);assert.ok(record,path);
  if(!index)return Response.json({...record,bytes:undefined});
  if(index==='complete'){assert.equal(JSON.parse(opts.body).sha256,digest(data));assert.deepEqual(Buffer.concat([...record.bytes].sort((a,b)=>a[0]-b[0]).map(v=>v[1])),data);record.complete=true;return Response.json({id});}
  assert.equal(opts.headers['X-Chunk-SHA256'],digest(opts.body));puts.push(+index);inflight++;max=Math.max(max,inflight);
  try{
   if(hold)await new Promise((resolve,reject)=>{if(opts.signal.aborted)return reject(new Error('aborted'));opts.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
   else await new Promise(resolve=>setTimeout(resolve,2));
   if(options.failChunk===+index&&!failed){failed=true;return Response.json({error:'rejected chunk'},{status:422});}
   record.bytes.set(+index,Buffer.from(opts.body));record.chunks[+index]=digest(opts.body);return new Response(null,{status:204});
  }finally{inflight--;}
 };
 const engine=new SyncQueue({store,connection:async()=>c,notify:async event=>events.push(structuredClone(event)),fetcher});
 const job=(kind='file')=>({id:'b'.repeat(32),server:c.server,userId:c.user.id,kind,name:'clip.mp4',size:kind==='video'?undefined:data.length,type:'video/mp4',source:kind==='video'?'https://video.local/clip.mp4':undefined,status:'queued',created:Date.now(),expires:Date.now()+86400000,sent:0});
 return {store,c,data,engine,events,uploads,puts,sourceReads,job,max:()=>max,release:()=>{hold=false;},changeSource:()=>{etag='"v2"';}};
}
async function settled(engine){for(let i=0;i<1000;i++){if(!engine.running)return;await new Promise(resolve=>setTimeout(resolve,2));}throw new Error('queue did not settle');}
test('file queue sends exact bytes in a bounded parallel window and removes local payload on success',async()=>{
 const h=fixture();const job=h.job();await h.store.add(job,new Blob([h.data]));await h.engine.kick();assert.equal(h.max(),4);assert.ok(h.uploads.get('a'.repeat(32)).complete);assert.equal(await h.store.get(job.id),undefined);assert.equal(await h.store.blob(job.id),undefined);assert.ok(h.events.some(e=>e.status==='sent'));
});
test('retry restores the saved hash and skips acknowledged chunks without allocating a second file',async()=>{
 const h=fixture({failChunk:4});const job=h.job();await h.store.add(job,new Blob([h.data]));await h.engine.kick();const failed=await h.store.get(job.id);assert.equal(failed.status,'failed');assert.equal(failed.checkpoint.index,4);const first=h.puts.length;
 await h.engine.control(job.id,'resume',h.c);await settled(h.engine);assert.ok(h.puts.slice(first).every(index=>index>=4));assert.equal(h.uploads.size,1);assert.ok(h.uploads.get('a'.repeat(32)).complete);
});
test('pausing retains original data and receipts; cancel deletes the partial server upload and local bytes',async()=>{
 const h=fixture({hold:true});const job=h.job();await h.store.add(job,new Blob([h.data]));const sending=h.engine.kick();for(let i=0;i<100&&!h.puts.length;i++)await new Promise(resolve=>setTimeout(resolve,2));await h.engine.control(job.id,'pause',h.c);await sending;
 assert.equal((await h.store.get(job.id)).status,'paused');assert.ok(await h.store.blob(job.id));await h.engine.control(job.id,'cancel',h.c);assert.equal(h.uploads.size,0);assert.equal(await h.store.get(job.id),undefined);assert.equal(await h.store.blob(job.id),undefined);
});
test('reopened engine marks interrupted transfers paused and keeps them bound to their account',async()=>{
 const h=fixture();const job=h.job();job.status='sending';await h.store.add(job,new Blob([h.data]));await h.engine.initialize();assert.equal((await h.store.get(job.id)).status,'paused');
 await assert.rejects(h.engine.control(job.id,'resume',{...h.c,user:{id:'different'}}),/unavailable/);assert.equal(h.uploads.size,0);
});
test('range videos resume verified chunks while source identity changes are rejected',async()=>{
 const h=fixture({failChunk:4});const job=h.job('video');await h.store.add(job);await h.engine.kick();assert.equal((await h.store.get(job.id)).status,'failed');const before=h.sourceReads.length;
 await h.engine.control(job.id,'resume',h.c);await settled(h.engine);assert.equal(h.sourceReads[before],'bytes=0-0');assert.equal(h.sourceReads[before+1],'bytes=512-639');assert.ok(h.uploads.get('a'.repeat(32)).complete);
 const changed=fixture({failChunk:4});const second=changed.job('video');await changed.store.add(second);await changed.engine.kick();changed.changeSource();await changed.engine.control(second.id,'resume',changed.c);await settled(changed.engine);assert.match((await changed.store.get(second.id)).error,/source changed/);assert.equal(changed.uploads.get('a'.repeat(32)).complete,undefined);
});
test('direct videos without range support still stream through verified chunks',async()=>{
 const h=fixture({noRanges:true});const job=h.job('video');await h.store.add(job);await h.engine.kick();assert.ok(h.uploads.get('a'.repeat(32)).complete);assert.equal(h.max(),4);
});
test('expired local payloads are deleted and never sent; other account queues remain untouched',async()=>{
 const h=fixture();const expired=h.job();expired.expires=Date.now()-1;await h.store.add(expired,new Blob([h.data]));const other={...h.job(),id:'c'.repeat(32),userId:'different'};await h.store.add(other,new Blob([h.data]));await h.engine.initialize();await h.engine.kick();assert.equal(await h.store.blob(expired.id),undefined);assert.ok(await h.store.blob(other.id));assert.equal(h.uploads.size,0);
});
