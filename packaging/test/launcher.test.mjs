import { Buffer } from 'node:buffer';
import { ReadableStream } from 'node:stream/web';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { installVerifiedBinary, platformError, download, cacheFolder, offersApp, installedApp, installMacApp } from '../bin/tokentracky.mjs';

const { Response } = globalThis;
const bytes = Buffer.from('#!/bin/sh\nprintf "synthetic cli\\n"\nexit 7\n');
const digest = createHash('sha256').update(bytes).digest('hex');
// The launcher installs the version in its own package.json, so the synthetic release uses that version.
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const file = `tokentracky-${version}-macos-arm64`;
const url = `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/${file}`;
const manifest = { schemaVersion: 1, latest: version, releases: { [version]: { verified: true, macos: { arm64: { cli: { file, url, sha256: digest } } } } } };

test('rejects unsupported operating systems, architectures, and macOS versions clearly', () => {
  for (const [platform, arch] of [['freebsd', 'x64'], ['linux', 'ia32'], ['win32', 'arm64'], ['win32', 'ia32']]) {
    assert.match(platformError(platform, arch, '10.0.0'), new RegExp(`Linux on x64 and arm64, and Windows on x64; this system is ${platform}/${arch}`));
  }
  assert.match(platformError('darwin', 'x64', '22.0.0'), /Apple Silicon \(arm64\)/);
  assert.match(platformError('darwin', 'arm64', '21.6.0'), /requires macOS 13 or later/);
  assert.equal(platformError('darwin', 'arm64', '22.0.0'), null);
  // Only macOS has a minimum version.
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) assert.equal(platformError(platform, arch, '5.4.0'), null);
});

test('installs each system\'s own verified binary from its manifest entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-launcher-'));
  const cli = (name) => ({ file: `tokentracky-${version}-${name}`, url: `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/tokentracky-${version}-${name}`, sha256: digest });
  const every = { schemaVersion: 1, latest: version, releases: { [version]: { verified: true,
    macos: { arm64: { cli: cli('macos-arm64') } },
    linux: { x86_64: { cli: cli('linux-x86_64') }, aarch64: { cli: cli('linux-aarch64') } },
    windows: { x86_64: { cli: cli('windows-x86_64.exe') } },
  } } };
  try {
    for (const [platform, arch, name] of [['darwin', 'arm64', 'macos-arm64'], ['linux', 'x64', 'linux-x86_64'], ['linux', 'arm64', 'linux-aarch64'], ['win32', 'x64', 'windows-x86_64.exe']]) {
      const requested = [];
      const fetchImpl = async (url) => { requested.push(String(url)); return new Response(bytes, { status: 200 }); };
      const cacheRoot = join(root, `${platform}-${arch}`);
      const target = await installVerifiedBinary({ manifest: every, cacheRoot, platform, arch, osVersion: '22.0.0', fetchImpl });
      assert.equal(target, join(cacheRoot, `tokentracky-${version}-${name}`));
      assert.deepEqual(requested, [cli(name).url]);
      assert.deepEqual(await readFile(target), bytes);
    }
    // A release without a system's build says so rather than calling the manifest invalid.
    await assert.rejects(installVerifiedBinary({ manifest, cacheRoot: root, platform: 'linux', arch: 'x64', osVersion: '6.1.0' }), /No verified Tokentracky .* published for Linux x86_64 yet/);
    await assert.rejects(installVerifiedBinary({ manifest, cacheRoot: root, platform: 'win32', arch: 'x64', osVersion: '10.0.0' }), /published for Windows x86_64 yet/);
    // An entry naming another system's file is refused.
    const swapped = { ...every, releases: { [version]: { ...every.releases[version], linux: { x86_64: { cli: cli('windows-x86_64.exe') } } } } };
    await assert.rejects(installVerifiedBinary({ manifest: swapped, cacheRoot: root, platform: 'linux', arch: 'x64', osVersion: '6.1.0' }), /manifest.*invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('caches under the user cache folder, and under local application data on Windows', () => {
  const home = homedir();
  assert.equal(cacheFolder('0.2.0', 'darwin', 'arm64', {}), join(home, '.cache', 'tokentracky', '0.2.0', 'darwin-arm64'));
  assert.equal(cacheFolder('0.2.0', 'linux', 'x64', {}), join(home, '.cache', 'tokentracky', '0.2.0', 'linux-x64'));
  assert.equal(cacheFolder('0.2.0', 'win32', 'x64', { LOCALAPPDATA: join(home, 'Local') }), join(home, 'Local', 'tokentracky', '0.2.0', 'win32-x64'));
  assert.equal(cacheFolder('0.2.0', 'win32', 'x64', {}), join(home, 'AppData', 'Local', 'tokentracky', '0.2.0', 'win32-x64'));
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
    const unsafe = { schemaVersion: 1, latest: version, releases: { [version]: { verified: true, macos: { arm64: { cli: { ...manifest.releases[version].macos.arm64.cli, file: '../escape' } } } } } };
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

test('offers the Mac app to login on a Mac terminal only', () => {
  assert.equal(offersApp(['login'], { platform: 'darwin', interactive: true }), true);
  assert.equal(offersApp(['--cloud-url', 'https://tokentracky.com', 'login'], { platform: 'darwin', interactive: true }), true);
  for (const [args, platform, interactive] of [[['login'], 'linux', true], [['login'], 'win32', true], [['login'], 'darwin', false],
    [['serve'], 'darwin', true], [['login', '--help'], 'darwin', true], [['login', '-v'], 'darwin', true]]) {
    assert.equal(offersApp(args, { platform, interactive }), false, `${args} ${platform} ${interactive}`);
  }
  // The app opens with the system's environment, so the CLI opens it only for the default credential folder.
  assert.equal(offersApp(['login'], { platform: 'darwin', interactive: true, env: { TOKENTRACKY_HOME: '/custom' } }), false);
  assert.equal(offersApp(['login'], { platform: 'darwin', interactive: true, env: { TOKENTRACKY_HOME: '' } }), true);
});

test('finds the Mac app in either Applications folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-mac-app-test-'));
  try {
    const [system, user] = [join(root, 'system'), join(root, 'user')];
    assert.equal(await installedApp([system, user]), null);
    await mkdir(join(user, 'Tokentracky.app'), { recursive: true });
    assert.equal(await installedApp([system, user]), join(user, 'Tokentracky.app'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses to install a Mac app the manifest does not pin', async () => {
  await assert.rejects(installMacApp({ manifest, folders: [] }), /No verified Tokentracky .* Mac app/);
  const app = { file: `tokentracky-${version}-macos-arm64.dmg`, url: 'https://evil.example/app.dmg', sha256: digest };
  const elsewhere = { ...manifest, releases: { [version]: { verified: true, macos: { arm64: { app } } } } };
  await assert.rejects(installMacApp({ manifest: elsewhere, folders: [] }), /No verified Tokentracky .* Mac app/);
});

test('installs the verified Mac app from its disk image into the first Applications folder that takes it', { skip: process.platform !== 'darwin' && 'hdiutil is macOS only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-mac-app-test-'));
  const locked = join(root, 'locked');
  try {
    // A disk image laid out as the release's: the app beside a link to Applications.
    const plist = '<plist><dict><key>CFBundleIdentifier</key><string>com.tokentracky.desktop</string></dict></plist>';
    const stage = join(root, 'stage');
    await mkdir(join(stage, 'Tokentracky.app', 'Contents'), { recursive: true });
    await writeFile(join(stage, 'Tokentracky.app', 'Contents', 'Info.plist'), plist);
    await symlink('/Applications', join(stage, 'Applications'));
    const created = spawnSync('hdiutil', ['create', '-quiet', '-srcfolder', stage, '-volname', 'Tokentracky', '-format', 'UDZO', '-o', join(root, 'app.dmg')]);
    assert.equal(created.status, 0, String(created.stderr));
    const image = await readFile(join(root, 'app.dmg'));
    const file = `tokentracky-${version}-macos-arm64.dmg`;
    const app = { file, url: `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/${file}`, sha256: createHash('sha256').update(image).digest('hex') };
    const pinned = { schemaVersion: 1, latest: version, releases: { [version]: { verified: true, macos: { arm64: { app } } } } };
    const requested = [];
    const fetchImpl = async (url) => { requested.push(String(url)); return new Response(image); };
    // The system folder refuses this user, so the app goes into the user's own.
    await mkdir(locked, { mode: 0o500 });
    const user = join(root, 'user');
    const installed = await installMacApp({ manifest: pinned, folders: [locked, user], fetchImpl });
    assert.equal(installed, join(user, 'Tokentracky.app'));
    assert.deepEqual(requested, [app.url]);
    assert.equal(await readFile(join(installed, 'Contents', 'Info.plist'), 'utf8'), plist);
    assert.equal(await installedApp([locked, user]), installed);
    // The image is detached afterwards.
    assert.doesNotMatch(spawnSync('hdiutil', ['info'], { encoding: 'utf8' }).stdout, /tokentracky-app-/);
    const other = join(root, 'other');
    await assert.rejects(installMacApp({ manifest: pinned, folders: [other], fetchImpl: async () => new Response('tampered') }), /integrity check failed/);
    assert.equal(await installedApp([other]), null);
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
