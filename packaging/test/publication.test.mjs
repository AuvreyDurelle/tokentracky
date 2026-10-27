import {test} from 'node:test';
import {TextEncoder} from 'node:util';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyPublication} from '../scripts/validate-publication.mjs';
const bytes = new TextEncoder().encode('synthetic release payload');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const artifacts = Object.fromEntries([['cli',''],['app','.dmg']].map(([kind,ext])=>{
  const file=`tokentracky-0.1.0-macos-arm64${ext}`;
  return [kind,{file,url:`https://github.com/AuvreyDurelle/tokentracky/releases/download/v0.1.0/${file}`,sha256}];
}));
const manifest={schemaVersion:1,latest:'0.1.0',releases:{'0.1.0':{verified:true,macos:{arm64:artifacts}}}};
test('empty or unpublished release cannot consume an npm version',async()=>{
  await assert.rejects(verifyPublication({schemaVersion:1,releases:{}},'0.1.0'),/verified release/);
  await assert.rejects(verifyPublication(manifest,'0.1.0',async()=>new Response('',{status:404})),/HTTP 404/);
});
test('publication requires public CLI and DMG bytes to match',async()=>{
  const calls=[];
  await verifyPublication(manifest,'0.1.0',async url=>{calls.push(String(url));return new Response(bytes);});
  assert.equal(calls.length,2);
  await assert.rejects(verifyPublication(manifest,'0.1.0',async()=>new Response('corrupt')),/checksum mismatch/);
});
