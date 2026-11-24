import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, options) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...options });
const BASE = 'https://github.com/AuvreyDurelle/tokentracky/releases/download/v0.1.0';
const packet = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40, 7)]).toString('base64');
const SYSTEMS = {
  linux: { platform: 'linux-x86_64', target: 'linux-x86_64-appimage', updater: 'tokentracky-0.1.0-linux-x86_64.AppImage', signature: 'appimage-signature',
    files: ['SHA256SUMS', 'feed.json', 'source-provenance.txt', 'tokentracky-0.1.0-linux-x86_64.AppImage', 'tokentracky-0.1.0-linux-x86_64.AppImage.sig', 'tokentracky-0.1.0-linux-x86_64.deb'] },
  windows: { platform: 'windows-x86_64', target: 'windows-x86_64', updater: 'tokentracky-0.1.0-windows-x86_64-setup.exe', signature: 'installer-signature',
    files: ['SHA256SUMS', 'feed.json', 'source-provenance.txt', 'tokentracky-0.1.0-windows-x86_64-setup.exe', 'tokentracky-0.1.0-windows-x86_64-setup.exe.sig'] },
};

async function fixture(system) {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-app-orchestration-'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packaging'));
  await mkdir(join(root, 'apps/mac'), { recursive: true });
  for (const file of ['prepare-desktop-release.sh', 'macos-release.mjs', 'desktop-release-stubs.py']) await cp(join(source, 'scripts', file), join(root, 'scripts', file));
  // The real smoke runs the installers in native CI; here it only has to be run on the final assets, and stop the
  // candidate when it fails.
  await writeFile(join(root, 'scripts/smoke-desktop-linux.sh'), 'exec smoke-linux "$@"\n');
  await writeFile(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.1.0"\n');
  await writeFile(join(root, 'package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'packaging/package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'apps/mac/tauri.conf.json'), '{"version":"0.1.0"}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], ['tag', 'v0.1.0']]) assert.equal(run('git', args, { cwd: root }).status, 0);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(root, '.git/info/exclude'), 'bin/\nlog.jsonl\ndist/\n');
  for (const tool of ['uname', 'cygpath', 'npm', 'cargo', 'rustc', 'pwsh', 'smoke-linux']) await symlink(join(root, 'scripts/desktop-release-stubs.py'), join(bin, tool));
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(root, 'log.jsonl'), STUB_SYSTEM: system, GITHUB_REF_NAME: 'v0.1.0',
    TAURI_SIGNING_PRIVATE_KEY: 'test-only-private-key', TOKENTRACKY_UPDATER_CHANNEL: 'stable', TOKENTRACKY_RELEASE_BASE_URL: BASE,
    TOKENTRACKY_UPDATER_ENDPOINT: 'https://updates.example.invalid/stable.json',
    TOKENTRACKY_UPDATER_PUBLIC_KEY: Buffer.from(`untrusted comment: minisign public key: TEST\n${packet}\n`).toString('base64'),
  };
  const log = async () => (await readFile(env.STUB_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const dist = join(root, 'dist/app-release', SYSTEMS[system].platform);
  return { root, env, log, dist, execute: () => run('bash', [join(root, 'scripts/prepare-desktop-release.sh')], { cwd: tmpdir(), env }) };
}

for (const [system, expected] of Object.entries(SYSTEMS)) {
  test(`a ${system} app candidate holds its installers, the updater signature, its feed, checksums and provenance`, async () => {
    const f = await fixture(system);
    try {
      const result = f.execute();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual((await readdir(f.dist)).sort(), expected.files);
      const feed = JSON.parse(await readFile(join(f.dist, 'feed.json'), 'utf8'));
      assert.equal(feed.version, '0.1.0');
      assert.deepEqual(feed.platforms, { [expected.target]: { url: `${BASE}/${expected.updater}`, signature: expected.signature } });
      const sums = (await readFile(join(f.dist, 'SHA256SUMS'), 'utf8')).trim().split('\n');
      assert.deepEqual(sums.map((line) => line.split('  ')[1]), expected.files.filter((file) => file !== 'SHA256SUMS'));
      const sha256 = createHash('sha256').update(await readFile(join(f.dist, expected.updater))).digest('hex');
      assert.ok(sums.includes(`${sha256}  ${expected.updater}`));
      assert.match(await readFile(join(f.dist, 'source-provenance.txt'), 'utf8'), new RegExp(`^platform=${expected.platform}$`, 'm'));
      const log = await f.log();
      const build = log.find((entry) => entry.tool === 'cargo' && entry.args[1] === 'build');
      assert.equal(build.updater, '1');
      // A fresh target folder for every candidate.
      assert.ok(!build.target_dir.startsWith(f.root));
      // The smoke run uses the very files the release uploads.
      const smoke = log.filter((entry) => entry.tool === (system === 'linux' ? 'smoke-linux' : 'pwsh'));
      assert.equal(smoke.length, 1);
      if (system === 'linux') assert.deepEqual(smoke[0].args, [join(f.dist, expected.updater), join(f.dist, 'tokentracky-0.1.0-linux-x86_64.deb')]);
      else assert.deepEqual(smoke[0].args.slice(-2), ['-Installer', join(f.dist, expected.updater)]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const failure of ['dirty', 'tag', 'exists', 'secret', 'key', 'smoke']) {
  test(`an app candidate fails closed for ${failure}`, async () => {
    const f = await fixture('linux');
    try {
      f.env.STUB_FAIL = failure;
      if (failure === 'dirty') await writeFile(join(f.root, 'dirty.txt'), 'uncommitted');
      if (failure === 'tag') f.env.GITHUB_REF_NAME = 'v0.1.1';
      if (failure === 'exists') await mkdir(f.dist, { recursive: true });
      if (failure === 'secret') delete f.env.TAURI_SIGNING_PRIVATE_KEY;
      const result = f.execute();
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      await assert.rejects(readFile(join(f.dist, 'feed.json')), /ENOENT/);
      if (failure === 'secret') assert.match(result.stderr, /missing required release secret\/configuration: TAURI_SIGNING_PRIVATE_KEY/);
      if (failure === 'key') assert.match(result.stderr, /does not match TOKENTRACKY_UPDATER_PUBLIC_KEY/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
