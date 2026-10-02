require('../web/folder-worker.js');
module.exports=()=>folderArchive([
  {path:'folder/'},{path:'folder/empty/'},
  {path:'folder/nested/Привіт.txt',file:new File(['  hello\t🦊\r\n'],'text',{lastModified:new Date(2000,0,1).getTime()})},
  {path:'folder/raw.bin',file:new File([new Uint8Array([0,255,13,10])],'raw',{lastModified:new Date(2000,0,1).getTime()})},
  {path:'folder/empty.bin',file:new File([],'empty',{lastModified:new Date(2000,0,1).getTime()})}
],20*1024*1024);
