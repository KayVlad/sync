// Keep snippet text byte-for-byte at the DOM text level; only HTTP(S) links are actionable.
function linkParts(text){
  const parts=[];let start=0;
  for(const match of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi)){
    let label=match[0].replace(/[.,!?;:]+$/,'');
    for(const [open,close] of [['(',')'],['[',']'],['{','}']])while(label.endsWith(close)&&label.split(close).length>label.split(open).length)label=label.slice(0,-1);
    const href=label.toLowerCase().startsWith('www.')?'https://'+label:label;
    try{const url=new URL(href);if(!['http:','https:'].includes(url.protocol))continue;}catch{continue;}
    if(match.index>start)parts.push({text:text.slice(start,match.index)});
    parts.push({text:label,href});start=match.index+label.length;
  }
  if(start<text.length)parts.push({text:text.slice(start)});
  return parts;
}
globalThis.linkParts=linkParts;
