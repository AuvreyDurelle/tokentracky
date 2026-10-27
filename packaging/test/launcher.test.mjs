import { Buffer } from 'node:buffer';
import { ReadableStream } from 'node:stream/web';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { installVerifiedBinary, platformError, download } from '../bin/tokentracky.mjs';

const { Response } = globalThis;
const bytes = Buffer.from('#!/bin/sh\nprintf "synthetic cli\\n"\nexit 7\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const file = 'tokentracky-0.1.0-macos-arm64';
const url = `https://github.com/AuvreyDurelle/tokentracky/releases/download/v0.1.0/${file}`;
const manifest = { schemaVersion: 1, latest: '0.1.0', releases: { '0.1.0': { verified: true, macos: { arm64: { cli: { file, url, sha256: digest } } } } } };

test('rejects unsupported operating systems, architectures, and macOS versions clearly', () => {
  assert.match(platformError('linux', 'arm64', '6.1'), /supports macOS 13 or later/);
  assert.match(platformError('darwin', 'x64', '22.0.0'), /Apple Silicon \(arm64\)/);
  assert.match(platformError('darwin', 'arm64', '21.6.0'), /requires macOS 13 or later/);
  assert.equal(platformError('darwin', 'arm64', '22.0.0'), null);
});

test('downloads a synthetic CLI only after SHA-256 matches and reuses the verified cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-launcher-'));
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response(bytes, { status: 200 }); };
  try {
    const target = await installVerifiedBinary({ manifest, cacheRoot: root, platform: 'darwin', arch: 'arm64', osVersion: '22.0.0', fetchImpl });
    assert.deepEqual(await readFile(target), bytes);
    const child = spawn(target, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 7);
    assert.equal(stdout, 'synthetic cli\n');
    await installVerifiedBinary({ manifest, cacheRoot: root, platform: 'darwin', arch: 'arm64', osVersion: '22.0.0', fetchImpl });
    assert.equal(requests, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a corrupt binary and redirects outside approved GitHub HTTPS hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-launcher-'));
  try {
    await assert.rejects(installVerifiedBinary({ manifest, cacheRoot: root, platform: 'darwin', arch: 'arm64', osVersion: '22.0.0', fetchImpl: async () => new Response('tampered') }), /integrity check failed/);
    await assert.rejects(installVerifiedBinary({ manifest, cacheRoot: root, platform: 'darwin', arch: 'arm64', osVersion: '22.0.0', fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/payload' } }) }), /outside the trusted GitHub HTTPS hosts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects absent and path-traversing manifest entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-launcher-'));
  try {
    await assert.rejects(installVerifiedBinary({ manifest: { schemaVersion: 1, latest: null, releases: {} }, cacheRoot: root, platform: 'darwin', arch: 'arm64', osVersion: '22.0.0' }), /No verified Tokentracky/);
    const unsafe = { schemaVersion: 1, latest: '0.1.0', releases: { '0.1.0': { verified: true, macos: { arm64: { cli: { ...manifest.releases['0.1.0'].macos.arm64.cli, file: '../escape' } } } } } };
    await assert.rejects(installVerifiedBinary({ manifest: unsafe, cacheRoot: root, platform: 'darwin', arch: 'arm64', osVersion: '22.0.0' }), /manifest.*invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('rejects redirect credentials and ports, and cancels every redirect body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-download-'));
  try {
    for (const location of ['https://user:pass@github.com/a', 'https://github.com:8443/a']) {
      let cancelled = false;
      await assert.rejects(download(url, join(root, 'binary'), async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location } })), /trusted GitHub HTTPS hosts/);
      assert.equal(cancelled, true);
    }
    let redirects = 0;
    await assert.rejects(download(url, join(root, 'binary'), async () => { redirects++; return new Response(null, { status: 302, headers: { location: url } }); }), /invalid redirect/);
    assert.equal(redirects, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounds declared and streamed download bytes before writing an executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-download-'));
  try {
    for (const headers of [{ 'content-length': '1000' }, {}]) {
      let cancelled = false;
      const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } });
      await assert.rejects(download(url, join(root, 'binary'), async () => new Response(body, { headers }), { maxBytes: 10 }), /size limit/);
      assert.equal(cancelled, true);
      await assert.rejects(readFile(join(root, 'binary')), /ENOENT/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('download deadline aborts headers and stalled response bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-download-'));
  try {
    await assert.rejects(download(url, join(root, 'binary'), async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { timeoutMs: 20 }), /timed out/);
    let cancelled = false;
    await assert.rejects(download(url, join(root, 'binary'), async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), { timeoutMs: 20 }), /timed out/);
    assert.equal(cancelled, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
