const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
require('../web/sha256.js');

test('SHA-256 matches independent implementation across block and chunk boundaries', () => {
  for (const size of [0,1,55,56,63,64,65,127,128,129,4095,4096,4194304,4194337]) {
    const data=randomBytes(size), expected=createHash('sha256').update(data).digest('hex');
    assert.equal(new SHA256().update(data).digest(),expected,`size ${size}`);
    const hash=new SHA256();for(let i=0;i<data.length;i+=137)hash.update(data.subarray(i,i+137));
    assert.equal(hash.digest(),expected,`incremental size ${size}`);
  }
});
test('Unicode, null bytes, and standard known vectors', () => {
  assert.equal(new SHA256().update(Buffer.from('abc')).digest(),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const data=Buffer.from('  \t\r\nПривіт 🦊 e\u0301\x00');
  assert.equal(new SHA256().update(data).digest(),createHash('sha256').update(data).digest('hex'));
  assert.equal(new SHA256().update(Buffer.alloc(1000000,97)).digest(),'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});
