async function background(action,data={}){const reply=await chrome.runtime.sendMessage({action,...data});if(!reply?.ok)throw new Error(reply?.error||'Background unavailable.');return reply.result;}
const engine=new SyncQueue({store:SyncStore,connection:()=>background('engine-connection'),notify:event=>background('engine-update',{event}).catch(()=>{})});
const ready=engine.initialize();
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.target!=='engine'||sender.id!==chrome.runtime.id||sender.tab||sender.url!==chrome.runtime.getURL('background.js')){
    // Service-worker senders may omit url; extension pages cannot issue engine commands directly.
    if(message.target!=='engine'||sender.id!==chrome.runtime.id||sender.tab||sender.url)return;
  }
  (async()=>{await ready;const c=await background('engine-connection');
    if(message.action==='wake'){engine.kick();return null;}
    if(message.action==='control'){await engine.control(message.id,message.control,c);return null;}
    if(message.action==='pause-account'){await engine.pauseAccount(c);return null;}
    throw new Error('Unknown engine action.');
  })().then(result=>reply({ok:true,result})).catch(error=>reply({ok:false,error:error.message}));return true;
});
ready.then(()=>engine.kick()).catch(error=>background('engine-update',{event:{status:'failed',error:error.message}}));
setInterval(()=>engine.expire().catch(()=>{}),1000);
