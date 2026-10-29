#!/usr/bin/env node
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir, release as kernelRelease } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';

const { fetch, AbortController } = globalThis;
const REPOSITORY = 'AuvreyDurelle/tokentracky';
const MANIFEST_PATH = new URL('../release-manifest.json', import.meta.url);
const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Each supported Node `platform-arch`: its name, its place in the manifest and its asset's suffix. */
export const PLATFORMS = {
  'darwin-arm64': { name: 'macOS arm64', os: 'macos', arch: 'arm64', asset: 'macos-arm64' },
  'linux-x64': { name: 'Linux x86_64', os: 'linux', arch: 'x86_64', asset: 'linux-x86_64' },
  'linux-arm64': { name: 'Linux aarch64', os: 'linux', arch: 'aarch64', asset: 'linux-aarch64' },
  'win32-x64': { name: 'Windows x86_64', os: 'windows', arch: 'x86_64', asset: 'windows-x86_64.exe' },
};

export function platformError(platform = process.platform, arch = process.arch, release = kernelRelease()) {
  if (platform === 'darwin') {
    if (arch !== 'arm64') return `Tokentracky currently supports Apple Silicon (arm64) only; this system is macOS/${arch}.`;
    const [major] = release.split('.').map(Number);
    if (!Number.isFinite(major) || major < 22) return `Tokentracky requires macOS 13 or later; detected macOS kernel ${release || 'unknown'}.`;
    return null;
  }
  if (!Object.hasOwn(PLATFORMS, `${platform}-${arch}`)) {
    return `Tokentracky supports macOS 13 or later on Apple Silicon, Linux on x64 and arm64, and Windows on x64; this system is ${platform}/${arch}.`;
  }
  return null;
}

/** Where a version's binary is cached: the user's cache folder, or local application data on Windows. */
export function cacheFolder(version, platform, arch, env = process.env) {
  const base = platform === 'win32'
    ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'tokentracky')
    : join(homedir(), '.cache', 'tokentracky');
  return join(base, version, `${platform}-${arch}`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function safeManifestEntry(manifest, version, platform) {
  const { name, os, arch, asset } = platform;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.latest !== version || !manifest.releases || !Object.hasOwn(manifest.releases, version) ||
      !Object.hasOwn(manifest.releases[version]?.[os] ?? {}, arch)) {
    throw new Error(`No verified Tokentracky ${version} binary is published for ${name} yet.`);
  }
  const artifact = manifest.releases[version][os][arch]?.cli;
  const file = `tokentracky-${version}-${asset}`;
  const url = `https://github.com/${REPOSITORY}/releases/download/v${version}/${file}`;
  if (manifest.releases[version]?.verified !== true || artifact?.file !== file || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') || artifact.url !== url) {
    throw new Error(`The packaged integrity manifest for Tokentracky ${version} is invalid.`);
  }
  return { file, url, sha256: artifact.sha256 };
}

const MAX_BINARY_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export async function download(url, destination, fetchImpl = fetch, { maxBytes = MAX_BINARY_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Tokentracky release download timed out.')), timeoutMs);
  let current = new URL(url);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (current.protocol !== 'https:' || current.username || current.password || current.port ||
          !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(current.hostname)) {
        throw new Error('The release download redirected outside the trusted GitHub HTTPS hosts.');
      }
      const response = await fetchImpl(current, { signal: controller.signal, redirect: 'manual', headers: { 'user-agent': 'tokentracky-npm-launcher' } });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('The GitHub release download returned an invalid redirect.');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The Tokentracky release download failed (HTTP ${response.status}).`);
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error('Tokentracky release download exceeds the binary size limit.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('The Tokentracky release download was empty.');
      const abortReader = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener('abort', abortReader, { once: true });
      if (controller.signal.aborted) abortReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('Tokentracky release download exceeds the binary size limit.');
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { controller.signal.removeEventListener('abort', abortReader); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, size);
      controller.signal.throwIfAborted();
      await import('node:fs/promises').then(({ writeFile }) => writeFile(destination, bytes, { flag: 'wx', mode: 0o700 }));
      return bytes;
    }
    throw new Error('Too many redirects while downloading the Tokentracky release.');
  } finally { clearTimeout(timeout); }
}

export async function installVerifiedBinary({ manifest, version = VERSION, platform = process.platform, arch = process.arch, osVersion = kernelRelease(), cacheRoot, fetchImpl = fetch }) {
  const problem = platformError(platform, arch, osVersion);
  if (problem) throw new Error(problem);
  const entry = safeManifestEntry(manifest, version, PLATFORMS[`${platform}-${arch}`]);
  cacheRoot ??= cacheFolder(version, platform, arch);
  const target = resolve(cacheRoot, entry.file);
  if (!target.startsWith(`${resolve(cacheRoot)}${sep}`)) throw new Error('Invalid binary cache path.');
  try {
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > MAX_BINARY_BYTES) throw new Error('Invalid binary cache entry.');
    const existing = await readFile(target);
    if (createHash('sha256').update(existing).digest('hex') === entry.sha256 && (await stat(target)).isFile()) return target;
    await rm(target, { force: true });
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }

  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.tokentracky-${process.pid}-${Date.now()}.tmp`);
  try {
    const bytes = await download(entry.url, temporary, fetchImpl);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) throw new Error(`Tokentracky binary integrity check failed (expected ${entry.sha256}, received ${actual}).`);
    if (platform !== 'win32') await chmod(temporary, 0o700);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return target;
}

/** Where the Mac app is looked for and put: the system's Applications folder, then the user's own. */
export const APP_FOLDERS = ['/Applications', join(homedir(), 'Applications')];
const APP = 'Tokentracky.app';

/** `login` from a Mac terminal, where the launcher offers the app before the CLI starts. */
export function offersApp(args, { platform = process.platform, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  return platform === 'darwin' && interactive && args.includes('login') && !args.some((arg) => ['-h', '--help', '-v', '--version'].includes(arg));
}

/** The installed Mac app, or null. */
export async function installedApp(folders = APP_FOLDERS) {
  for (const folder of folders) {
    const app = join(folder, APP);
    if (await stat(app).then((metadata) => metadata.isDirectory(), () => false)) return app;
  }
  return null;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`))));
  });
}

/** Downloads this version's DMG, checks it against the manifest, and copies the app into the first folder that takes it. */
export async function installMacApp({ manifest, version = VERSION, folders = APP_FOLDERS, fetchImpl = fetch }) {
  const file = `tokentracky-${version}-macos-arm64.dmg`;
  const url = `https://github.com/${REPOSITORY}/releases/download/v${version}/${file}`;
  const entry = manifest?.releases?.[version]?.macos?.arm64?.app;
  if (manifest?.latest !== version || manifest.releases?.[version]?.verified !== true || entry?.file !== file || entry.url !== url || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) {
    throw new Error(`No verified Tokentracky ${version} Mac app is published.`);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'tokentracky-app-'));
  try {
    const image = join(temporary, file);
    const actual = createHash('sha256').update(await download(url, image, fetchImpl)).digest('hex');
    if (actual !== entry.sha256) throw new Error(`Tokentracky app integrity check failed (expected ${entry.sha256}, received ${actual}).`);
    const volume = join(temporary, 'volume');
    await run('hdiutil', ['attach', image, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', volume]);
    try {
      for (const folder of folders) {
        await mkdir(folder, { recursive: true }).catch(() => {});
        if (await run('ditto', [join(volume, APP), join(folder, APP)]).then(() => true, () => false)) return join(folder, APP);
      }
      throw new Error('Tokentracky.app could not be copied into Applications.');
    } finally { await run('hdiutil', ['detach', volume, '-quiet']).catch(() => {}); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** On a Mac without the app, `login` offers it first: after approval the CLI opens it, and it keeps uploading from the
 * menu bar. Without it the CLI keeps uploading itself while its terminal stays open. */
async function offerMacApp(args) {
  if (!offersApp(args) || (await installedApp())) return;
  const { createInterface } = await import('node:readline/promises');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl-C stops here, as it stops the CLI; Ctrl-D answers no.
  terminal.once('SIGINT', () => { terminal.close(); process.stdout.write('\n'); process.exit(130); });
  const answer = await terminal.question('Tokentracky for Mac keeps uploading from the menu bar after you close this terminal. Install it in Applications? [y/N] ').catch(() => '');
  terminal.close();
  if (!/^y(es)?$/i.test(answer.trim())) return;
  try {
    process.stdout.write('Downloading Tokentracky for Mac…\n');
    const app = await installMacApp({ manifest: JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) });
    process.stdout.write(`Installed ${app}. It opens once you approve this computer.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)} Continuing without the app.\n`);
  }
}

async function getBinary() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  return installVerifiedBinary({ manifest, cacheRoot: process.env.TOKENTRACKY_CACHE_DIR });
}

export async function main(args = process.argv.slice(2)) {
  try {
    const binary = await getBinary();
    await offerMacApp(args);
    const child = spawn(binary, args, { stdio: 'inherit' });
    // Windows has no signals to pass on: the console sends Ctrl+C and Ctrl+Break to the CLI itself, and Node could
    // only end it outright. The launcher waits for it to stop.
    const windows = process.platform === 'win32';
    const signals = windows ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = new Map(signals.map((signal) => [signal, () => { if (!windows) child.kill(signal); }]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => { for (const [name, handler] of handlers) process.off(name, handler); };
    child.once('error', (error) => { cleanup(); fail(`Could not start the Tokentracky binary: ${error.message}`); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (signal && !windows) { process.kill(process.pid, signal); return; }
      process.exitCode = code ?? 1;
    });
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) await main();
