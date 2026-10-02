const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const sha = readFileSync(require.resolve('../web/sha256.js'),'utf8');
const worker = readFileSync(require.resolve('../web/transfer-worker.js'),'utf8');
const digest = b => createHash('sha256').update(b).digest('hex');

async function transfer(data,{native=false,retry=false,cancel=false,reject=false}={}){
  const messages=[],chunks=new Map(),attempts=new Map();let inflight=0,maxInflight=0,deleted=false,completed=false,context;
  const self={crypto:native?webcrypto:undefined,postMessage(message){messages.push(message);if(cancel&&message.type==='started')self.onmessage({data:{action:'cancel'}});}};
  context=vm.createContext({self,console,AbortController,DOMException,performance,setTimeout,Uint8Array,DataView,Uint32Array,fetch:async(url,options)=>{
    if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');
    if(options.method==='DELETE'){deleted=true;return new Response(null,{status:204});}
    if(url==='/api/uploads')return Response.json({id:'fixture'});
    if(url.endsWith('/complete')){
      assert.equal(JSON.parse(options.body).sha256,digest(data));
      assert.deepEqual(Buffer.concat([...chunks.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1])),data);completed=true;return Response.json({id:'fixture'});
    }
    const index=Number(url.split('/').pop()),b=Buffer.from(options.body);
    assert.equal(options.headers['X-Chunk-SHA256'],digest(b));
    const attempt=(attempts.get(index)||0)+1;attempts.set(index,attempt);
    if(reject)return Response.json({error:'Checksum mismatch'},{status:422});
    if(retry&&index===0&&attempt===1)return Response.json({error:'Temporary failure'},{status:503});
    inflight++;maxInflight=Math.max(inflight,maxInflight);await new Promise(r=>setTimeout(r,8));inflight--;chunks.set(index,b);return new Response(null,{status:204});
  }});
  context.importScripts=()=>vm.runInContext(sha,context);
  vm.runInContext(worker,context);
  await self.onmessage({data:{action:'upload',file:new File([data],'fixture.bin'),config:{chunkSize:4096,parallel:4}}});
  return {messages,maxInflight,deleted,completed,attempts};
}

test('worker sends parallel chunks and verifies full bytes on LAN HTTP',async()=>{
  const data=Buffer.alloc(4096*9+123);for(let i=0;i<data.length;i++)data[i]=i%251;
  const result=await transfer(data);assert.equal(result.maxInflight,4);assert.equal(result.completed,true);assert.equal(result.messages.at(-1).type,'done');
});
test('worker uses native hashing when available and retries transient failures',async()=>{
  const result=await transfer(Buffer.alloc(18000,37),{native:true,retry:true});assert.equal(result.completed,true);assert.equal(result.attempts.get(0),2);assert.equal(result.messages.at(-1).type,'done');
});
test('worker completes empty files',async()=>{const result=await transfer(Buffer.alloc(0));assert.equal(result.completed,true);assert.equal(result.messages.at(-1).type,'done');});
test('worker cancels and removes partial upload',async()=>{const result=await transfer(Buffer.alloc(100),{cancel:true});assert.equal(result.deleted,true);assert.equal(result.completed,false);assert.equal(result.messages.at(-1).type,'cancelled');});
test('worker rejects checksum errors without retrying or publishing',async()=>{const result=await transfer(Buffer.alloc(100),{reject:true});assert.equal(result.deleted,true);assert.equal(result.completed,false);assert.equal(result.attempts.get(0),1);assert.equal(result.messages.at(-1).type,'error');});
