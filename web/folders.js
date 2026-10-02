// Directory entries must be captured synchronously during the drop event.
async function collectFolder(entry) {
  const entries=[];
  async function visit(node, parent='') {
    const path=parent+node.name;
    if(entries.length>=10000)throw new Error('Folders are limited to 10,000 entries.');
    if(node.isFile){entries.push({path,file:await new Promise((resolve,reject)=>node.file(resolve,reject))});return;}
    if(!node.isDirectory)throw new Error('This folder entry cannot be read.');
    entries.push({path:path+'/'});
    const reader=node.createReader();
    // Chromium returns directories in batches, often only 100 children at a time.
    for(;;){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch)await visit(child,path+'/');}
  }
  await visit(entry);return entries;
}
globalThis.collectFolder=collectFolder;
