const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../web/folders.js');
require('../web/folder-worker.js');
test('ZIP writer matches the fixture independently decoded by Go',async()=>{
  const archive=await require('./folder-fixture.cjs')();
  assert.deepEqual(Buffer.from(await archive.arrayBuffer()),require('node:fs').readFileSync(require('node:path').join(__dirname,'../testdata/folder.zip')));
});
const file=name=>({name,isFile:true,file(resolve){resolve(new File([name],name));}});
const dir=(name,batches)=>({name,isDirectory:true,createReader(){let i=0;return {readEntries(resolve){resolve(batches[i++]||[]);}};}});

test('folder drop reads all directory batches and preserves nested and empty directories',async()=>{
  const entries=await collectFolder(dir('root',[Array.from({length:100},(_,i)=>file(`${i}.txt`)),[file('last.txt'),dir('nested',[[file('Unicode 🦊.txt'),dir('empty',[])]])]]));
  assert.equal(entries.length,105);
  assert.equal(entries.at(-1).path,'root/nested/empty/');
  assert.equal(await entries.find(e=>e.path==='root/nested/Unicode 🦊.txt').file.text(),'Unicode 🦊.txt');
  assert.ok(entries.find(e=>e.path==='root/last.txt'));
});
test('unreadable folder entries fail instead of silently uploading a partial folder',async()=>{
  await assert.rejects(collectFolder({name:'bad',isFile:true,file(resolve,reject){reject(new Error('Permission denied'));}}),/Permission denied/);
});
test('folder archive rejects unsafe, duplicate, and over-limit input before reading files',async()=>{
  for(const path of ['../a','/a','a/../b','C:/a','a\\b','a//b'])await assert.rejects(folderArchive([{path,file:new File(['x'],'x')}],10000),/path/);
  await assert.rejects(folderArchive([{path:'same/'},{path:'same/'}],10000),/Duplicate/);
  await assert.rejects(folderArchive([{path:'folder/a',file:new File(['bytes'],'a')}],1),/limit/);
});
