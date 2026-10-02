const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../web/links.js');
test('links retain original formatting, punctuation, and Unicode text',()=>{
 const text='  Привіт\t(https://example.com/path?q=1).\nwww.example.org https://example.com/a_(b)\n';
 const parts=linkParts(text);assert.equal(parts.map(p=>p.text).join(''),text);
 assert.deepEqual(parts.filter(p=>p.href).map(p=>p.href),['https://example.com/path?q=1','https://www.example.org','https://example.com/a_(b)']);
});
test('HTML and unsafe schemes remain literal text',()=>{
 const text='<script>alert(1)</script> javascript:alert(1) data:text/html,test file:///secret';
 assert.deepEqual(linkParts(text),[{text}]);
});
