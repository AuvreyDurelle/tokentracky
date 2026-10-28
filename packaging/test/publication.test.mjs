import {test} from 'node:test';
import {TextEncoder} from 'node:util';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyPublication} from '../scripts/validate-publication.mjs';
const bytes = new TextEncoder().encode('synthetic release payload');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const artifact = (name) => {
  const file=`tokentracky-0.1.0-${name}`;
  return {file,url:`https://github.com/AuvreyDurelle/tokentracky/releases/download/v0.1.0/${file}`,sha256};
};
const release={verified:true,
  macos:{arm64:{cli:artifact('macos-arm64'),app:artifact('macos-arm64.dmg')}},
  linux:{x86_64:{cli:artifact('linux-x86_64')},aarch64:{cli:artifact('linux-aarch64')}},
  windows:{x86_64:{cli:artifact('windows-x86_64.exe')}}};
const manifest={schemaVersion:1,latest:'0.1.0',releases:{'0.1.0':release}};
test('empty or unpublished release cannot consume an npm version',async()=>{
  await assert.rejects(verifyPublication({schemaVersion:1,releases:{}},'0.1.0'),/verified release/);
  await assert.rejects(verifyPublication(manifest,'0.1.0',async()=>new Response('',{status:404})),/HTTP 404/);
});
test('publication requires every public CLI and the DMG bytes to match',async()=>{
  const calls=[];
  await verifyPublication(manifest,'0.1.0',async url=>{calls.push(String(url));return new Response(bytes);});
  assert.deepEqual(calls,[
    artifact('macos-arm64').url,artifact('linux-x86_64').url,artifact('linux-aarch64').url,artifact('windows-x86_64.exe').url,
    artifact('macos-arm64.dmg').url,
  ]);
  await assert.rejects(verifyPublication(manifest,'0.1.0',async()=>new Response('corrupt')),/checksum mismatch/);
});
test('a release missing a system the launcher installs for cannot be published',async()=>{
  const fetcher=async()=>new Response(bytes);
  const withoutWindows={...release};
  delete withoutWindows.windows;
  await assert.rejects(verifyPublication({...manifest,releases:{'0.1.0':withoutWindows}},'0.1.0',fetcher),/Invalid windows x86_64 cli release artifact metadata/);
  const renamed={...release,linux:{...release.linux,aarch64:{cli:artifact('linux-x86_64')}}};
  await assert.rejects(verifyPublication({...manifest,releases:{'0.1.0':renamed}},'0.1.0',fetcher),/Invalid linux aarch64 cli/);
});
