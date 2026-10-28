import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, options) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...options });
const TARGETS = [
  ['x86_64-unknown-linux-musl', 'linux', 'x86_64', 'tokentracky-0.1.0-linux-x86_64'],
  ['aarch64-unknown-linux-musl', 'linux', 'aarch64', 'tokentracky-0.1.0-linux-aarch64'],
  ['x86_64-pc-windows-msvc', 'windows', 'x86_64', 'tokentracky-0.1.0-windows-x86_64.exe'],
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-cli-orchestration-'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packaging'));
  await mkdir(join(root, 'apps/mac'), { recursive: true });
  for (const file of ['prepare-cli-release.sh', 'macos-release.mjs', 'cli-release-stubs.py']) await cp(join(source, 'scripts', file), join(root, 'scripts', file));
  // The standalone HTTP regression runs against the real Rust CLI in native CI. Here verify that orchestration
  // invokes it on the final raw asset and stops on failure.
  await writeFile(join(root, 'scripts/check-standalone-cli.py'), `import json, os, pathlib, sys
assert sys.argv[1] == '--binary' and sys.argv[3] == '--web-dist'
assert pathlib.Path(sys.argv[2]).name.startswith('tokentracky-0.1.0-')
assert pathlib.Path(sys.argv[4]).name == 'dist'
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps({'tool': 'standalone-cli', 'args': sys.argv[1:]}) + '\\n')
sys.exit(1 if os.getenv('STUB_FAIL') == 'standalone' else 0)
`);
  await writeFile(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.1.0"\n');
  await writeFile(join(root, 'package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'packaging/package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'apps/mac/tauri.conf.json'), '{"version":"0.1.0"}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], ['tag', 'v0.1.0']]) assert.equal(run('git', args, { cwd: root }).status, 0);
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Keep doubles and their log outside the fixture git tree.
  await writeFile(join(root, '.git/info/exclude'), 'bin/\nlog.jsonl\ndist/\n');
  for (const tool of ['npm', 'cargo', 'file', 'rustc']) await symlink(join(root, 'scripts/cli-release-stubs.py'), join(bin, tool));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(root, 'log.jsonl'), GITHUB_REF_NAME: 'v0.1.0' };
  const log = async () => (await readFile(env.STUB_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, env, log, execute: (target) => run('bash', [join(root, 'scripts/prepare-cli-release.sh'), target], { cwd: tmpdir(), env }) };
}

for (const [target, os, arch, file] of TARGETS) {
  test(`a ${target} candidate holds its checked binary, checksums, provenance and manifest fragment`, async () => {
    const f = await fixture();
    try {
      const result = f.execute(target);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const dist = join(f.root, 'dist/cli-release', target);
      const bytes = await readFile(join(dist, file));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const url = `https://github.com/AuvreyDurelle/tokentracky/releases/download/v0.1.0/${file}`;
      assert.deepEqual(JSON.parse(await readFile(join(dist, 'manifest-fragment.json'), 'utf8')), {
        schemaVersion: 1, latest: '0.1.0', releases: { '0.1.0': { verified: true, [os]: { [arch]: { cli: { file, url, sha256 } } } } },
      });
      const sums = (await readFile(join(dist, 'SHA256SUMS'), 'utf8')).trim().split('\n');
      assert.deepEqual(sums.map((line) => line.split('  ')[1]), ['cargo-metadata.json', 'manifest-fragment.json', 'source-provenance.txt', file]);
      assert.ok(sums.includes(`${sha256}  ${file}`));
      assert.match(await readFile(join(dist, 'source-provenance.txt'), 'utf8'), new RegExp(`^target=${target}$`, 'm'));
      const log = await f.log();
      const build = log.find((e) => e.tool === 'cargo' && e.args[0] === 'build');
      assert.deepEqual(build.args.slice(-2), ['--target', target]);
      // A fresh target folder for every candidate.
      assert.ok(!build.target_dir.startsWith(f.root));
      const standalone = log.filter((e) => e.tool === 'standalone-cli');
      assert.equal(standalone.length, 1);
      assert.equal(standalone[0].args[1], join(dist, file));
      assert.equal(log.some((e) => e.tool === 'file'), os === 'linux');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('an unknown target is refused before anything is built', async () => {
  const f = await fixture();
  try {
    for (const target of ['', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu']) {
      const result = f.execute(target);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /usage: prepare-cli-release\.sh/);
    }
    assert.deepEqual(await f.log(), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a Windows candidate that imports the Visual C++ runtime fails closed', async () => {
  const f = await fixture();
  const target = 'x86_64-pc-windows-msvc';
  try {
    f.env.STUB_FAIL = 'dynamic-crt';
    const result = f.execute(target);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /needs the Visual C\+\+ runtime/);
    await assert.rejects(readFile(join(f.root, 'dist/cli-release', target, 'manifest-fragment.json')), /ENOENT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const failure of ['dirty', 'tag', 'tag-head', 'version', 'standalone', 'dynamic', 'exists']) {
  test(`a CLI candidate fails closed for ${failure}`, async () => {
    const f = await fixture();
    const target = 'x86_64-unknown-linux-musl';
    try {
      f.env.STUB_FAIL = failure;
      if (failure === 'dirty') await writeFile(join(f.root, 'dirty.txt'), 'uncommitted');
      if (failure === 'tag') f.env.GITHUB_REF_NAME = 'v0.1.1';
      if (failure === 'tag-head') {
        await writeFile(join(f.root, 'new-commit.txt'), 'after tag');
        assert.equal(run('git', ['add', '.'], { cwd: f.root }).status, 0);
        assert.equal(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'after tag'], { cwd: f.root }).status, 0);
      }
      if (failure === 'exists') await mkdir(join(f.root, 'dist/cli-release', target), { recursive: true });
      const result = f.execute(target);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      await assert.rejects(readFile(join(f.root, 'dist/cli-release', target, 'manifest-fragment.json')), /ENOENT/);
      if (failure === 'dynamic') assert.match(result.stderr, /not statically linked/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
