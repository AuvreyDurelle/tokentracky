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
const TARGETS = [
  ['x86_64-pc-windows-msvc', 'windows-x86_64', 'tokentracky-0.1.0-windows-x86_64-setup.exe', []],
  ['x86_64-unknown-linux-gnu', 'linux-x86_64-appimage', 'tokentracky-0.1.0-linux-x86_64.AppImage', ['tokentracky-0.1.0-linux-x86_64.deb']],
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-desktop-orchestration-'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packaging'));
  await mkdir(join(root, 'apps/mac'), { recursive: true });
  for (const file of ['prepare-desktop-release.sh', 'macos-release.mjs', 'desktop-release-stubs.py']) await cp(join(source, 'scripts', file), join(root, 'scripts', file));
  await writeFile(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.1.0"\n');
  await writeFile(join(root, 'package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'packaging/package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'apps/mac/tauri.conf.json'), '{"version":"0.1.0"}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], ['tag', 'v0.1.0']]) assert.equal(run('git', args, { cwd: root }).status, 0);
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Keep doubles and their log outside the fixture git tree.
  await writeFile(join(root, '.git/info/exclude'), 'bin/\nlog.jsonl\ndist/\n');
  for (const tool of ['npm', 'cargo', 'minisign', 'rustc']) await symlink(join(root, 'scripts/desktop-release-stubs.py'), join(bin, tool));
  const packet = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40, 7)]).toString('base64');
  const publicKey = Buffer.from(`untrusted comment: minisign public key: TEST\n${packet}\n`).toString('base64');
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(root, 'log.jsonl'), GITHUB_REF_NAME: 'v0.1.0',
    TAURI_SIGNING_PRIVATE_KEY: 'stub-not-a-key', TOKENTRACKY_UPDATER_PUBLIC_KEY: publicKey,
    TOKENTRACKY_UPDATER_ENDPOINT: 'https://updates.example.invalid/stable.json', TOKENTRACKY_UPDATER_CHANNEL: 'stable',
    TOKENTRACKY_RELEASE_BASE_URL: BASE,
  };
  const log = async () => (await readFile(env.STUB_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, env, log, execute: (target) => run('bash', [join(root, 'scripts/prepare-desktop-release.sh'), target], { cwd: tmpdir(), env }) };
}

for (const [target, feedTarget, updater, others] of TARGETS) {
  test(`a ${target} candidate holds its installers, the updater signed for its version, its feed and checksums`, async () => {
    const f = await fixture();
    try {
      const result = f.execute(target);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const dist = join(f.root, 'dist/desktop-release', target);
      const files = [updater, `${updater}.sig`, ...others, 'SHA256SUMS', 'source-provenance.txt', 'stable.json'];
      assert.deepEqual((await readdir(dist)).sort(), files.sort());
      const signature = (await readFile(join(dist, `${updater}.sig`), 'utf8')).trim();
      const feed = JSON.parse(await readFile(join(dist, 'stable.json'), 'utf8'));
      assert.equal(feed.version, '0.1.0');
      assert.deepEqual(feed.platforms, { [feedTarget]: { url: `${BASE}/${updater}`, signature } });
      const sums = (await readFile(join(dist, 'SHA256SUMS'), 'utf8')).trim().split('\n');
      assert.deepEqual(sums.map((line) => line.split('  ')[1]), files.filter((file) => file !== 'SHA256SUMS').sort());
      const sha256 = createHash('sha256').update(await readFile(join(dist, updater))).digest('hex');
      assert.ok(sums.includes(`${sha256}  ${updater}`));
      assert.match(await readFile(join(dist, 'source-provenance.txt'), 'utf8'), new RegExp(`^target=${target}$`, 'm'));
      const log = await f.log();
      const build = log.find((e) => e.tool === 'cargo' && e.args[1] === 'build');
      assert.ok(build.cwd.endsWith('/apps/mac'), build.cwd);
      assert.equal(build.updater, '1');
      assert.equal(build.args[build.args.indexOf('--target') + 1], target);
      // A fresh target folder for every candidate.
      assert.ok(!build.target_dir.startsWith(f.root));
      // The copy that is published is the one signed and verified.
      const sign = log.find((e) => e.tool === 'cargo' && e.args[1] === 'signer');
      assert.equal(sign.args.at(-1), join(dist, updater));
      const verify = log.find((e) => e.tool === 'minisign');
      assert.equal(verify.args[verify.args.indexOf('-Vm') + 1], join(dist, updater));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('an unknown target is refused before anything is built', async () => {
  const f = await fixture();
  try {
    for (const target of ['', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-musl', 'aarch64-apple-darwin']) {
      const result = f.execute(target);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /usage: prepare-desktop-release\.sh/);
    }
    assert.deepEqual(await f.log(), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const FAILURES = {
  dirty: /dirty working tree/,
  tag: /does not match source version 0\.1\.0/,
  'tag-head': /exact version tag/,
  exists: /must not already exist/,
  setting: /TAURI_SIGNING_PRIVATE_KEY/,
  'tauri-version': /Tauri CLI 2\.11\.5/,
  'missing-bundle': /No such file/,
  signature: /Signature verification failed/,
  'signed-version': /not for 0\.1\.0/,
};
for (const [failure, message] of Object.entries(FAILURES)) {
  for (const [target] of TARGETS) {
    test(`a ${target} candidate fails closed for ${failure}`, async () => {
      const f = await fixture();
      try {
        f.env.STUB_FAIL = failure;
        if (failure === 'dirty') await writeFile(join(f.root, 'dirty.txt'), 'uncommitted');
        if (failure === 'tag') f.env.GITHUB_REF_NAME = 'v0.1.1';
        if (failure === 'tag-head') {
          await writeFile(join(f.root, 'new-commit.txt'), 'after tag');
          assert.equal(run('git', ['add', '.'], { cwd: f.root }).status, 0);
          assert.equal(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'after tag'], { cwd: f.root }).status, 0);
        }
        if (failure === 'exists') await mkdir(join(f.root, 'dist/desktop-release', target), { recursive: true });
        if (failure === 'setting') delete f.env.TAURI_SIGNING_PRIVATE_KEY;
        const result = f.execute(target);
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, message);
        await assert.rejects(readFile(join(f.root, 'dist/desktop-release', target, 'stable.json')), /ENOENT/);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }
}
