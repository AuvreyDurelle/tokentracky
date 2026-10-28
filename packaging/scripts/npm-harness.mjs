#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';
import { PLATFORMS } from '../bin/tokentracky.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(resolve(tmpdir(), 'tokentracky-npm-harness-'));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options });
  if (result.error) throw result.error;
  return result;
};
const check = (result, description) => {
  if (result.status !== 0) throw new Error(`${description} failed:\n${result.stdout}\n${result.stderr}`);
};

try {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const cargo = await readFile(resolve(root, '../Cargo.toml'), 'utf8');
  const version = cargo.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  if (version !== pkg.version) throw new Error('npm package version does not match Cargo workspace version');
  const packed = run('npm', ['pack', '--pack-destination', temp], { cwd: root });
  check(packed, 'npm pack');
  const tarball = resolve(temp, packed.stdout.trim().split('\n').at(-1));
  const prefix = resolve(temp, 'local');
  const globalPrefix = resolve(temp, 'global');
  check(run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball]), 'local npm install');
  check(run('npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', globalPrefix, tarball]), 'global npm install');
  const globalRoot = run('npm', ['root', '--global', '--prefix', globalPrefix]);
  check(globalRoot, 'global npm root');
  const packages = [resolve(prefix, 'node_modules/tokentracky'), resolve(globalRoot.stdout.trim(), 'tokentracky')];
  const bins = [resolve(prefix, 'node_modules/.bin/tokentracky'), resolve(globalPrefix, 'bin/tokentracky')];
  for (const directory of packages) {
    if ((await readFile(resolve(directory, 'bin/tokentracky.mjs'), 'utf8')).includes('TOKENTRACKY_TEST_MANIFEST')) throw new Error('test manifest override shipped');
  }
  // Only the disposable installed package is modified; no production manifest override.
  const preload = resolve(temp, 'fetch.mjs');
  // Each supported host in turn, whatever system the harness runs on: its manifest entry, and Node made to report it.
  const setPayload = async ([host, { os: system, arch, asset }], payload, corrupt = false) => {
    const [platform, nodeArch] = host.split('-');
    const file = `tokentracky-${version}-${asset}`;
    const url = `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/${file}`;
    const sha256 = corrupt ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex');
    const manifest = { schemaVersion: 1, latest: version, releases: { [version]: { verified: true, [system]: { [arch]: { cli: { file, url, sha256 } } } } } };
    for (const directory of packages) await writeFile(resolve(directory, 'release-manifest.json'), JSON.stringify(manifest));
    await writeFile(preload, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
// Simulate a supported host for synthetic payloads on Linux CI as well. Only the launcher: npm and npx run as themselves.
if (/[\\\\/]tokentracky(\\.mjs)?$/.test(process.argv[1] ?? '')) {
  Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
  Object.defineProperty(process, 'arch', { value: ${JSON.stringify(nodeArch)} });
  os.release = () => '22.0.0'; syncBuiltinESMExports();
}
globalThis.fetch = async () => new Response(Buffer.from(${JSON.stringify(Buffer.from(payload).toString('base64'))}, 'base64'));
`);
  };
  const env = { ...process.env, TOKENTRACKY_CACHE_DIR: resolve(temp, 'cache'), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const payload = '#!/bin/sh\nprintf "synthetic cli: %s\\n" "$1"\nexit 23\n';
  const invocations = [
    [bins[0], ['local']],
    ['npx', ['--no-install', '--prefix', prefix, 'tokentracky', 'npx']],
    [bins[1], ['global']],
  ];
  for (const host of Object.entries(PLATFORMS)) {
    await setPayload(host, payload);
    for (const [command, args] of invocations) {
      const result = run(command, args, { cwd: prefix, env });
      if (result.status !== 23 || !result.stdout.includes(`synthetic cli: ${args.at(-1)}`)) throw new Error(`installed launcher failed on ${host[0]}: ${result.stdout} ${result.stderr}`);
    }
    await setPayload(host, payload, true);
    for (const [command, args] of invocations) {
      const result = run(command, args, { cwd: prefix, env });
      if (result.status !== 1 || !result.stderr.includes('integrity check failed')) throw new Error(`installed launcher accepted corruption on ${host[0]}: ${result.stdout} ${result.stderr}`);
    }
    // Windows passes no signals on: its console sends them to the CLI itself.
    if (host[0].startsWith('win32')) continue;
    for (const binary of bins) {
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        const marker = resolve(temp, 'signal.txt');
        await rm(marker, { force: true });
        await setPayload(host, `#!/bin/sh
exec node --input-type=commonjs - <<'JS'
const { writeFileSync } = require('node:fs');
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
  writeFileSync(${JSON.stringify(marker)}, signal);
  process.removeAllListeners(signal); process.kill(process.pid, signal);
});
console.log('signal-ready:' + process.pid);
setInterval(() => {}, 1000);
JS
`);
        const launcher = spawn(binary, [], { env: { ...env, TOKENTRACKY_CACHE_DIR: resolve(temp, `signal-${signal}`) }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', errors = '', childPid, sent = false;
        launcher.stdout.setEncoding('utf8').on('data', (chunk) => {
          output += chunk;
          const ready = output.match(/signal-ready:(\d+)/);
          if (ready && !sent) { childPid = Number(ready[1]); sent = true; launcher.kill(signal); }
        });
        launcher.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
        let timeout;
        try {
          const [, actualSignal] = await Promise.race([
            once(launcher, 'exit'),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`signal harness timeout: ${errors}`)), 5000); }),
          ]);
          if (actualSignal !== signal || await readFile(marker, 'utf8') !== signal) throw new Error(`signal not preserved: expected ${signal}, got ${actualSignal}; ${errors}`);
        } finally {
          clearTimeout(timeout);
          launcher.kill('SIGKILL');
          if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ } }
        }
      }
    }
  }
  process.stdout.write('npm pack, local/global install, npx, arguments, exit status and corruption on macOS, Linux and Windows hosts, SIGTERM/SIGINT/SIGHUP on macOS and Linux passed (synthetic payloads).\n');
} finally { await rm(temp, { recursive: true, force: true }); }
