const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../web/clipboard.js');

test('a faint suggestion retains exact text until sent', () => {
  const draft=new ClipboardDraft(),text='  Привіт\t🦊\n<em>literal</em>\n';
  assert.equal(draft.offer({text}),true);assert.equal(draft.suggestion.text,text);
  assert.equal(draft.take().text,text);assert.equal(draft.suggestion,null);
});
test('typing dismisses a suggestion and prevents automatic resurfacing', () => {
  const draft=new ClipboardDraft();draft.offer({text:'clipboard'});draft.dismiss();
  assert.equal(draft.offer({text:'clipboard'}),false);
  assert.equal(draft.offer({text:'new clipboard'}),true);
  draft.dismiss();assert.equal(draft.offer({text:'new clipboard'},{explicit:true}),true);
});
test('clipboard cannot overwrite a typed draft', () => {
  const draft=new ClipboardDraft();assert.equal(draft.offer({text:'clipboard'},{hasText:true}),false);
  assert.equal(draft.suggestion,null);
});
test('files and images preserve their bytes and names until accepted', async () => {
  const draft=new ClipboardDraft();const files=[new File([new Uint8Array([0,255,13,10])],'original.bin'),new File(['png'],'image.png',{type:'image/png'})];
  draft.offer({files});const accepted=draft.take();assert.equal(accepted.files[0],files[0]);assert.equal(accepted.files[1],files[1]);
  assert.deepEqual(new Uint8Array(await accepted.files[0].arrayBuffer()),new Uint8Array([0,255,13,10]));
});
test('pending clipboard reads can be invalidated by a new edit', () => {
  const draft=new ClipboardDraft(),readVersion=draft.version;draft.dismiss();assert.notEqual(draft.version,readVersion);
});

test('polling updates changed text and leaves unchanged previews stable', () => {
  const draft=new ClipboardDraft();draft.offer({text:'first'});
  const version=draft.version, suggestion=draft.suggestion;
  assert.equal(draft.offer({text:'first'}),false);
  assert.equal(draft.version,version);assert.equal(draft.suggestion,suggestion);
  assert.equal(draft.offer({text:'second'}),true);
  assert.equal(draft.suggestion.text,'second');
  assert.equal(draft.offer({text:''}),true);assert.equal(draft.suggestion,null);
});
test('same-size clipboard images update by content, including after dismissal', () => {
  const draft=new ClipboardDraft();
  const files=[new File(['abc'],'clipboard.png',{type:'image/png',lastModified:0})];
  draft.offer({files,hashes:['first digest']});draft.dismiss();
  assert.equal(draft.offer({files,hashes:['first digest']}),false);
  assert.equal(draft.offer({files,hashes:['different digest']}),true);
});
test('a cleared or changed clipboard permits a previously dismissed value again', () => {
  const draft=new ClipboardDraft();draft.offer({text:'first'});draft.dismiss();
  draft.offer({text:'second'});assert.equal(draft.offer({text:'first'}),true);
  draft.dismiss();draft.offer({text:''});assert.equal(draft.offer({text:'first'}),true);
});

test('typing anywhere routes printable characters, including after clicking a button', () => {
  const state={signedIn:true};
  assert.equal(shouldRoutePageTyping({key:'h'},state),true);
  assert.equal(shouldRoutePageTyping({key:'H',shiftKey:true},state),true);
  assert.equal(shouldRoutePageTyping({key:'h'},{...state,interactive:true}),true);
  assert.equal(shouldRoutePageTyping({key:' '},{...state,interactive:true}),false);
});
test('page typing preserves forms, dialogs, selections, shortcuts, and composition', () => {
  for(const state of [{signedIn:false},{signedIn:true,dialogOpen:true},{signedIn:true,editable:true},{signedIn:true,selection:true}])assert.equal(shouldRoutePageTyping({key:'a'},state),false);
  for(const event of [{key:'a',ctrlKey:true},{key:'a',metaKey:true},{key:'a',altKey:true},{key:'a',isComposing:true},{key:'a',defaultPrevented:true},{key:'Enter'},{key:'Tab'},{key:'ArrowDown'}])assert.equal(shouldRoutePageTyping(event,{signedIn:true}),false);
});
