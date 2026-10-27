import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, options) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...options });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-orchestration-'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packaging/scripts'), { recursive: true });
  await mkdir(join(root, 'apps/mac'), { recursive: true });
  for (const file of ['prepare-macos-release.sh', 'macos-release.mjs', 'build-macos-dmg.py', 'macos-release-stubs.py']) await cp(join(source, 'scripts', file), join(root, 'scripts', file));
  // The standalone HTTP regression runs against the real Rust CLI in native CI. Here verify that
  // orchestration invokes it on the final signed raw asset and stops on failure.
  await writeFile(join(root, 'scripts/check-standalone-cli.py'), `import json, os, pathlib, sys
assert sys.argv[1] == '--binary' and sys.argv[3] == '--web-dist'
assert pathlib.Path(sys.argv[2]).name == 'tokentracky-0.1.0-macos-arm64'
assert '# signed' in pathlib.Path(sys.argv[2]).read_text()
assert pathlib.Path(sys.argv[4]).name == 'dist'
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps({'tool': 'standalone-cli', 'args': sys.argv[1:]}) + '\\n')
sys.exit(1 if os.getenv('STUB_FAIL') == 'standalone' else 0)
`);
  await cp(join(source, 'packaging/scripts/generate-brew.mjs'), join(root, 'packaging/scripts/generate-brew.mjs'));
  await writeFile(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.1.0"\n');
  await writeFile(join(root, 'package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'packaging/package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'apps/mac/tauri.conf.json'), '{"version":"0.1.0"}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], ['tag', 'v0.1.0']]) assert.equal(run('git', args, { cwd: root }).status, 0);
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Keep doubles and their log outside the fixture git tree.
  await writeFile(join(root, '.git/info/exclude'), 'bin/\nlog.jsonl\ndist/\n');
  for (const tool of ['uname', 'gh', 'security', 'uuidgen', 'npm', 'cargo', 'codesign', 'lipo', 'ditto', 'xcrun', 'swift', 'hdiutil', 'osascript', 'minisign', 'spctl', 'xcodebuild', 'rustc']) await symlink(join(root, 'scripts/macos-release-stubs.py'), join(bin, tool));
  const packet = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40, 7)]).toString('base64');
  const publicKey = Buffer.from(`untrusted comment: minisign public key: TEST\n${packet}\n`).toString('base64');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(root, 'log.jsonl'), GITHUB_REF_NAME: 'v0.1.0', GH_TOKEN: 'stub', TOKENTRACKY_SIGNING: 'developer-id', APPLE_CERTIFICATE_BASE64: 'c3R1Yg==', APPLE_CERTIFICATE_PASSWORD: 'stub', APPLE_SIGNING_IDENTITY: 'Developer ID Application: Stub (TEST)', APPLE_API_KEY_ID: 'stub', APPLE_API_ISSUER: 'stub', APPLE_API_PRIVATE_KEY_BASE64: 'c3R1Yg==', TAURI_SIGNING_PRIVATE_KEY: 'stub-not-a-key', TOKENTRACKY_UPDATER_PUBLIC_KEY: publicKey, TOKENTRACKY_UPDATER_ENDPOINT: 'https://updates.example.invalid/stable.json', TOKENTRACKY_UPDATER_CHANNEL: 'stable', TOKENTRACKY_RELEASE_BASE_URL: 'https://github.com/AuvreyDurelle/tokentracky/releases/download/v0.1.0' };
  return { root, env, execute: () => run('bash', [join(root, 'scripts/prepare-macos-release.sh')], { cwd: tmpdir(), env }) };
}

test('release builds from app cwd, gates and notarizes CLI/app/DMG, then signs stapled updater and emits matching packaging metadata', async () => {
  const f = await fixture();
  try {
    const result = f.execute();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const dist = join(f.root, 'dist/macos-release');
    const manifest = JSON.parse(await readFile(join(dist, 'verified-candidate-manifest.json')));
    for (const artifact of Object.values(manifest.releases['0.1.0'].macos.arm64)) {
      assert.equal(artifact.sha256, createHash('sha256').update(await readFile(join(dist, artifact.file))).digest('hex'));
      assert.equal(artifact.url, `${f.env.TOKENTRACKY_RELEASE_BASE_URL}/${artifact.file}`);
    }
    const feed = JSON.parse(await readFile(join(dist, 'stable.json')));
    assert.equal(feed.platforms['darwin-aarch64'].url, `${f.env.TOKENTRACKY_RELEASE_BASE_URL}/Tokentracky.app.tar.gz`);
    const log = (await readFile(f.env.STUB_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    const submit = log.filter((e) => e.tool === 'xcrun' && e.args[0] === 'notarytool');
    assert.equal(submit.length, 3);
    assert.deepEqual(log.find((e) => e.tool === 'cargo' && e.args[0] === 'build').args,
      ['build', '--locked', '--release', '-p', 'tokentracky-cli', '--features', 'embed-web']);
    assert.equal(log.filter((e) => e.tool === 'standalone-cli').length, 1);
    const keychains = log.filter((e) => e.tool === 'security' && e.args[0] === 'list-keychains');
    assert.deepEqual(keychains.at(-1).args, ['list-keychains', '-d', 'user', '-s', '/Users/test/Library/Keychains/login.keychain-db', '/Users/test/custom keychain.keychain-db']);
    const temporary = keychains[1].args[4];
    await assert.rejects(readFile(temporary), /ENOENT/);
    assert.match(await readFile(join(dist, 'SHA256SUMS'), 'utf8'), /tokentracky-0\.1\.0-macos-arm64\n/);
    assert.match(await readFile(join(dist, 'homebrew/Casks/tokentracky.rb'), 'utf8'), /cask "tokentracky"/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const APPLE = ['APPLE_CERTIFICATE_BASE64', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_API_PRIVATE_KEY_BASE64'];
async function adhocFixture() {
  const f = await fixture();
  for (const name of APPLE) delete f.env[name];
  f.env.TOKENTRACKY_SIGNING = 'adhoc';
  return f;
}

test('ad-hoc release needs no Apple material: no keychain, notarization or stapling, and every artifact is ad-hoc signed', async () => {
  const f = await adhocFixture();
  try {
    const result = f.execute();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ad-hoc signed review artifacts \(not notarized\)/);
    const dist = join(f.root, 'dist/macos-release');
    const manifest = JSON.parse(await readFile(join(dist, 'verified-candidate-manifest.json')));
    for (const artifact of Object.values(manifest.releases['0.1.0'].macos.arm64)) {
      assert.equal(artifact.sha256, createHash('sha256').update(await readFile(join(dist, artifact.file))).digest('hex'));
    }
    assert.ok(JSON.parse(await readFile(join(dist, 'stable.json'))).platforms['darwin-aarch64']);
    await assert.rejects(readFile(join(dist, 'app-notary.json')), /ENOENT/);
    const log = (await readFile(f.env.STUB_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(log.filter((e) => ['security', 'xcrun', 'spctl'].includes(e.tool)), []);
    const signs = log.filter((e) => e.tool === 'codesign' && e.args.includes('--sign'));
    assert.equal(signs.length, 2);
    for (const sign of signs) assert.equal(sign.args[sign.args.indexOf('--sign') + 1], '-');
    const checked = log.filter((e) => e.tool === 'codesign' && e.args[0] === '-dv').map((e) => e.args.at(-1));
    assert.equal(checked.length, 4);
    assert.ok(checked.some((path) => path.endsWith('.dmg')) && checked.some((path) => path.endsWith('-macos-arm64')));
    assert.equal(log.filter((e) => e.tool === 'standalone-cli').length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const [name, change] of [['a missing signing mode', (env) => delete env.TOKENTRACKY_SIGNING], ['an unknown signing mode', (env) => { env.TOKENTRACKY_SIGNING = 'none'; }], ['an artifact that is not ad-hoc signed', (env) => { env.STUB_FAIL = 'adhoc-signature'; }], ['ad-hoc with the gate absent', (env) => { env.STUB_FAIL = 'gate'; }]]) {
  test(`ad-hoc release fails closed for ${name}`, async () => {
    const f = await adhocFixture();
    try {
      change(f.env);
      const result = f.execute();
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      await assert.rejects(readFile(join(f.root, 'dist/macos-release/verified-candidate-manifest.json')), /ENOENT/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const failure of ['gate', 'gate-pending', 'gate-failed', 'notary', 'finder', 'signature', 'key-mismatch', 'restore', 'import', 'standalone', 'dirty', 'tag', 'tag-head']) {
  test(`release fails closed for ${failure}`, async () => {
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
      const result = f.execute();
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      await assert.rejects(readFile(join(f.root, 'dist/macos-release/verified-candidate-manifest.json')), /ENOENT/);
      const log = await readFile(f.env.STUB_LOG, 'utf8').catch(() => '');
      if (['notary', 'finder', 'signature', 'key-mismatch', 'restore', 'import', 'standalone'].includes(failure)) {
        const calls = log.trim().split('\n').map(JSON.parse);
        const lists = calls.filter((call) => call.tool === 'security' && call.args[0] === 'list-keychains');
        assert.deepEqual(lists.at(-1).args, ['list-keychains', '-d', 'user', '-s', '/Users/test/Library/Keychains/login.keychain-db', '/Users/test/custom keychain.keychain-db']);
        assert.equal(calls.at(-1).tool, 'security');
        assert.equal(calls.at(-1).args[0], 'delete-keychain');
      }
      if (failure === 'finder') assert.match(result.stderr, /-1743/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
