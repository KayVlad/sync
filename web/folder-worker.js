// Stored ZIP64 archives: no transcoding/compression and bounded CRC working memory.
// Blob parts reference the original files; even large folders need no giant ArrayBuffer.
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const encoder=new TextEncoder();
function record(size,signature){const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);view.setUint32(0,signature,true);return {bytes,view};}
function zipPath(path){
  const parts=path.replace(/\/$/,'').split('/');
  if(!path||path.includes('\\')||parts.some(p=>!p||p==='.'||p==='..'||/[\x00-\x1f:]/.test(p)))throw new Error('Folder contains an unsupported path.');
  const name=encoder.encode(path);if(name.length>65535)throw new Error('Folder path is too long.');return name;
}
async function folderArchive(entries,maxSize,onProgress=()=>{}){
  if(!entries.length||entries.length>10000)throw new Error('Folders need 1–10,000 entries.');
  const seen=new Set();let estimated=98;
  for(const entry of entries){const name=zipPath(entry.path);if(seen.has(entry.path))throw new Error('Duplicate folder path.');seen.add(entry.path);if(!!entry.file===entry.path.endsWith('/'))throw new Error('Invalid folder entry.');estimated+=(entry.file?.size||0)+30+20+46+28+2*name.length;}
  if(estimated>maxSize)throw new Error('Folder ZIP exceeds the upload limit.');
  const parts=[],central=[];let offset=0,processed=0;const total=entries.reduce((n,e)=>n+(e.file?.size||0),0);
  for(const entry of entries){
    const name=zipPath(entry.path),file=entry.file,size=file?.size||0;let crc=0xffffffff;
    if(file)for(let start=0;start<size;start+=4*1024*1024){const bytes=new Uint8Array(await file.slice(start,start+4*1024*1024).arrayBuffer());for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);processed+=bytes.length;onProgress(processed,total);}
    crc=(crc^0xffffffff)>>>0;
    const date=file?new Date(file.lastModified):new Date(1980,0,1),year=Math.min(2107,Math.max(1980,date.getFullYear()));
    const dosDate=((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate(),dosTime=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
    const local=record(30,0x04034b50),v=local.view;
    v.setUint16(4,45,true);v.setUint16(6,0x800,true);v.setUint16(10,dosTime,true);v.setUint16(12,dosDate,true);v.setUint32(14,crc,true);v.setUint32(18,0xffffffff,true);v.setUint32(22,0xffffffff,true);v.setUint16(26,name.length,true);v.setUint16(28,20,true);
    const extra=record(20,0x00100001);extra.view.setBigUint64(4,BigInt(size),true);extra.view.setBigUint64(12,BigInt(size),true);
    parts.push(local.bytes,name,extra.bytes);if(file)parts.push(file);
    const header=record(46,0x02014b50),c=header.view;
    c.setUint16(4,45,true);c.setUint16(6,45,true);c.setUint16(8,0x800,true);c.setUint16(12,dosTime,true);c.setUint16(14,dosDate,true);c.setUint32(16,crc,true);c.setUint32(20,0xffffffff,true);c.setUint32(24,0xffffffff,true);c.setUint16(28,name.length,true);c.setUint16(30,28,true);c.setUint32(38,file?0:16,true);c.setUint32(42,0xffffffff,true);
    const ce=record(28,0x00180001);ce.view.setBigUint64(4,BigInt(size),true);ce.view.setBigUint64(12,BigInt(size),true);ce.view.setBigUint64(20,BigInt(offset),true);
    central.push(header.bytes,name,ce.bytes);offset+=30+name.length+20+size;
  }
  const centralSize=central.reduce((n,p)=>n+p.length,0),end=record(56,0x06064b50),e=end.view;
  e.setBigUint64(4,44n,true);e.setUint16(12,45,true);e.setUint16(14,45,true);e.setBigUint64(24,BigInt(entries.length),true);e.setBigUint64(32,BigInt(entries.length),true);e.setBigUint64(40,BigInt(centralSize),true);e.setBigUint64(48,BigInt(offset),true);
  const locator=record(20,0x07064b50);locator.view.setBigUint64(8,BigInt(offset+centralSize),true);locator.view.setUint32(16,1,true);
  const tail=record(22,0x06054b50);tail.view.setUint16(8,65535,true);tail.view.setUint16(10,65535,true);tail.view.setUint32(12,0xffffffff,true);tail.view.setUint32(16,0xffffffff,true);
  return new Blob([...parts,...central,end.bytes,locator.bytes,tail.bytes],{type:'application/zip'});
}
globalThis.folderArchive=folderArchive;
if(typeof self!=='undefined')self.onmessage=async({data})=>{
  try{const blob=await folderArchive(data.entries,data.maxSize,(done,total)=>self.postMessage({type:'progress',done,total}));self.postMessage({type:'done',blob});}
  catch(error){self.postMessage({type:'error',message:error.message||'Could not read folder.'});}
};
