// Blob payloads stay in IndexedDB, never in Chrome's JSON messages or sync storage.
const SyncStore={
  database:null,
  open(){
    if(!this.database)this.database=new Promise((resolve,reject)=>{
      const request=indexedDB.open('sync-transfers',1);
      request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('jobs',{keyPath:'id'});db.createObjectStore('payloads',{keyPath:'id'});};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>{this.database=null;reject(request.error);};
    });return this.database;
  },
  async transaction(stores,mode,run){
    const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction(stores,mode);let result;
      tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(tx.syncError||tx.error||new Error('Could not save the transfer.'));
      run(tx,value=>{result=value;});
    });
  },
  async add(job,blob){return this.addBatch([{job,blob}]).then(()=>job);},
  async addBatch(entries){return this.transaction(['jobs','payloads'],'readwrite',(tx,done)=>{
    const jobs=tx.objectStore('jobs'),count=jobs.count();count.onsuccess=()=>{if(count.result+entries.length>200){tx.syncError=new Error('Queue is full. Cancel transfers or use the main app.');tx.abort();return;}for(const {job,blob} of entries){jobs.add(job);if(blob)tx.objectStore('payloads').add({id:job.id,blob});}done(entries.map(entry=>entry.job));};
  });},
  async list(){return this.transaction(['jobs'],'readonly',(tx,done)=>{const request=tx.objectStore('jobs').getAll();request.onsuccess=()=>done(request.result);});},
  async get(id){return this.transaction(['jobs'],'readonly',(tx,done)=>{const request=tx.objectStore('jobs').get(id);request.onsuccess=()=>done(request.result);});},
  async blob(id){return this.transaction(['payloads'],'readonly',(tx,done)=>{const request=tx.objectStore('payloads').get(id);request.onsuccess=()=>done(request.result?.blob);});},
  async patch(id,values){return this.transaction(['jobs'],'readwrite',(tx,done)=>{const store=tx.objectStore('jobs'),request=store.get(id);request.onsuccess=()=>{const job=request.result;if(!job)return;Object.assign(job,values);store.put(job);done(job);};});},
  async dropPayload(id){return this.transaction(['payloads'],'readwrite',tx=>tx.objectStore('payloads').delete(id));},
  async remove(id){return this.transaction(['jobs','payloads'],'readwrite',tx=>{tx.objectStore('jobs').delete(id);tx.objectStore('payloads').delete(id);});},
  async expire(now=Date.now()){return this.transaction(['jobs','payloads'],'readwrite',tx=>{const request=tx.objectStore('jobs').openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(cursor.value.expires<=now){tx.objectStore('payloads').delete(cursor.key);cursor.delete();}cursor.continue();};});},
  job(c,kind,name,extra={}){const id=crypto.randomUUID().replaceAll('-',''),created=Date.now();return {id,server:c.server,userId:c.user.id,kind,name,created,expires:created+86400000,status:'queued',sent:0,...extra};}
};
globalThis.SyncStore=SyncStore;
