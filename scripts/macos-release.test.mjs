import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { releaseSettings, updaterConfig, updaterFeed, validateUpdaterFeed, versions, validatePublicKey, mergeManifests, mergeFeeds, main } from './macos-release.mjs';

const packet = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40, 7)]).toString('base64');
const publicKey = Buffer.from(`untrusted comment: minisign public key: TEST\n${packet}\n`).toString('base64');
const releaseEnv = {
  TOKENTRACKY_UPDATER_CHANNEL: 'stable',
  TOKENTRACKY_RELEASE_BASE_URL: 'https://updates.example.invalid/artifacts',
  TOKENTRACKY_UPDATER_ENDPOINT: 'https://updates.example.invalid/stable.json',
  TOKENTRACKY_UPDATER_PUBLIC_KEY: publicKey,
  TOKENTRACKY_SIGNING: 'developer-id',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAMID)',
  GITHUB_REF_NAME: 'v0.1.0',
};

const temporaryRoots = [];
after(async () => { await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(version = '0.1.0') {
  const root = await mkdtemp(join(tmpdir(), 'tokentracky-release-'));
  temporaryRoots.push(root);
  await Promise.all([
    writeFile(join(root, 'Cargo.toml'), `[workspace.package]\nversion = "${version}"\n`),
    writeFile(join(root, 'package.json'), JSON.stringify({ version })),
    (async () => {
      await mkdir(join(root, 'packaging'));
      await writeFile(join(root, 'packaging/package.json'), JSON.stringify({ version }));
      const app = join(root, 'apps/mac');
      await mkdir(app, { recursive: true });
      await writeFile(join(app, 'tauri.conf.json'), JSON.stringify({ version }));
    })(),
  ]);
  return root;
}

test('rejects absent updater release settings instead of building a fake signed release', async () => {
  const root = await fixture();
  await assert.rejects(releaseSettings({}, root), /TOKENTRACKY_UPDATER_CHANNEL/);
  await assert.rejects(releaseSettings({ ...releaseEnv, TOKENTRACKY_UPDATER_PUBLIC_KEY: 'placeholder' }, root), /real release verification key/);
});

test('rejects mismatched source and tag versions', async () => {
  const root = await fixture();
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.1' }));
  await assert.rejects(versions(root), /Version mismatch/);
  const matching = await fixture();
  await assert.rejects(releaseSettings({ ...releaseEnv, GITHUB_REF_NAME: 'v0.1.1' }, matching), /does not match/);
});

test('creates an HTTPS, signed-version-only updater configuration', async () => {
  const settings = await releaseSettings(releaseEnv, await fixture());
  const config = updaterConfig(settings);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
  assert.equal(config.plugins.updater.allowDowngrades, false);
  assert.equal(config.plugins.updater.endpoints[0], releaseEnv.TOKENTRACKY_UPDATER_ENDPOINT);
});

test('signing mode is required and selects Developer ID or ad-hoc, never by absence', async () => {
  const root = await fixture();
  const noMode = { ...releaseEnv };
  delete noMode.TOKENTRACKY_SIGNING;
  await assert.rejects(releaseSettings(noMode, root), /TOKENTRACKY_SIGNING/);
  await assert.rejects(releaseSettings({ ...releaseEnv, TOKENTRACKY_SIGNING: 'none' }, root), /adhoc or developer-id/);
  const noIdentity = { ...releaseEnv };
  delete noIdentity.APPLE_SIGNING_IDENTITY;
  await assert.rejects(releaseSettings(noIdentity, root), /APPLE_SIGNING_IDENTITY/);

  const developerId = updaterConfig(await releaseSettings(releaseEnv, root));
  assert.deepEqual(developerId.bundle.macOS, { signingIdentity: releaseEnv.APPLE_SIGNING_IDENTITY, hardenedRuntime: true });
  const adhoc = updaterConfig(await releaseSettings({ ...noIdentity, TOKENTRACKY_SIGNING: 'adhoc' }, root));
  assert.deepEqual(adhoc.bundle.macOS, { signingIdentity: '-', hardenedRuntime: false });
  assert.equal(adhoc.plugins.updater.requireSignedVersion, true);
});

test('generates and validates a real-shaped feed and rejects invalid/incomplete feeds', () => {
  const signature = Buffer.alloc(96, 9).toString('base64');
  const feed = updaterFeed({
    version: '0.1.1',
    artifactUrl: 'https://downloads.example.invalid/Tokentracky.app.tar.gz',
    signature,
  });
  assert.deepEqual(validateUpdaterFeed(feed), feed);
  assert.throws(() => updaterFeed({ version: 'not-a-version', artifactUrl: 'https://example.invalid/a', signature }), /SemVer/);
  assert.throws(() => validateUpdaterFeed({ version: '0.1.1', platforms: {} }), /no platform artifacts/);
  assert.throws(() => updaterFeed({ version: '0.1.1', artifactUrl: 'http://example.invalid/a', signature }), /HTTPS/);
});


test('feeds the Windows installer and the Linux AppImage beside the Mac app, never a bare Linux target a .deb would take', () => {
  const signature = Buffer.alloc(96, 9).toString('base64');
  const feed = (target, file) => updaterFeed({ version: '0.4.0', artifactUrl: `https://downloads.example.invalid/${file}`, signature, target, pubDate: '2026-11-24T00:00:00.000Z' });
  assert.deepEqual(feed('windows-x86_64', 'Tokentracky_0.4.0_x64-setup.exe').platforms, {
    'windows-x86_64': { url: 'https://downloads.example.invalid/Tokentracky_0.4.0_x64-setup.exe', signature },
  });
  assert.deepEqual(Object.keys(feed('linux-x86_64-appimage', 'Tokentracky_0.4.0_amd64.AppImage').platforms), ['linux-x86_64-appimage']);
  for (const target of ['linux-x86_64', 'linux-x86_64-deb', 'windows-aarch64', 'windows-x86_64-msi']) {
    assert.throws(() => feed(target, 'x'), /Feed target must be one of/);
  }
});

test('one feed holds every platform of the release, each once, at one version', async () => {
  const signature = Buffer.alloc(96, 9).toString('base64');
  const feed = (target, file, version = '0.4.0') => updaterFeed({ version, artifactUrl: `https://downloads.example.invalid/v${version}/${file}`, signature, target, notes: '', pubDate: '2026-11-24T00:00:00.000Z' });
  const mac = feed('darwin-aarch64', 'tokentracky-0.4.0-macos-arm64.app.tar.gz');
  const windows = feed('windows-x86_64', 'Tokentracky_0.4.0_x64-setup.exe');
  const linux = feed('linux-x86_64-appimage', 'Tokentracky_0.4.0_amd64.AppImage');
  const merged = mergeFeeds([mac, windows, linux]);
  assert.deepEqual(merged, { version: '0.4.0', notes: '', pub_date: '2026-11-24T00:00:00.000Z',
    platforms: { ...mac.platforms, ...windows.platforms, ...linux.platforms } });
  // The Mac app reads its own entry exactly as before.
  assert.deepEqual(merged.platforms['darwin-aarch64'], mac.platforms['darwin-aarch64']);
  assert.throws(() => mergeFeeds([mac, feed('windows-x86_64', 'Tokentracky_0.4.1_x64-setup.exe', '0.4.1')]), /version 0.4.0/);
  assert.throws(() => mergeFeeds([mac, windows, windows]), /windows-x86_64 twice/);
  assert.throws(() => mergeFeeds([mac, { ...linux, platforms: { 'linux-x86_64-appimage': { url: 'http://insecure.invalid/a', signature } } }]), /HTTPS/);
  assert.throws(() => mergeFeeds([]), /at least one/);

  const dist = await mkdtemp(join(tmpdir(), 'tokentracky-feeds-'));
  temporaryRoots.push(dist);
  const files = await Promise.all([mac, windows, linux].map(async (part, index) => {
    const file = join(dist, `${index}.json`);
    await writeFile(file, JSON.stringify(part));
    return file;
  }));
  const out = join(dist, 'stable.json');
  await main(['merge-feeds', '--out', out, ...files]);
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), merged);
  await assert.rejects(main(['merge-feeds', '--out', out]), /merge-feeds requires --out PATH and the feeds/);
});

test('validates public envelope structure without treating arbitrary base64 or private packets as public keys', () => {
  assert.equal(validatePublicKey(publicKey), publicKey);
  for (const key of [Buffer.alloc(100).toString('base64'), Buffer.from('untrusted comment: minisign encrypted secret key\n' + packet).toString('base64'), Buffer.from('untrusted comment: minisign public key: TEST\n' + Buffer.alloc(42).toString('base64')).toString('base64')]) {
    assert.throws(() => validatePublicKey(key), /public envelope/);
  }
});

test('argument parser rejects unknown, missing, duplicate and positional arguments', async () => {
  for (const args of [['feed', '--out'], ['feed', '--version', '--out', 'a'], ['feed', 'positional'], ['config', '--out', 'a', '--out', 'b'], ['feed', '--unknown', 'b']]) {
    await assert.rejects(main(args, releaseEnv), /Malformed|duplicate/);
  }
  await assert.rejects(main(['feed', '--out', 'a'], releaseEnv), /feed requires/);
});

test('release URLs reject credentials and nondefault ports', async () => {
  const root = await fixture();
  for (const url of ['https://user:pass@example.invalid/a', 'https://example.invalid:8443/a']) {
    await assert.rejects(releaseSettings({ ...releaseEnv, TOKENTRACKY_UPDATER_ENDPOINT: url }, root), /credential-free HTTPS/);
  }
});


test('rejects a packaging npm version that differs from native artifacts', async () => {
  const root = await fixture();
  await writeFile(join(root, 'packaging/package.json'), '{"version":"0.2.0"}');
  await assert.rejects(versions(root), /Version mismatch/);
});


const artifact = (version, file) => ({ file, url: `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/${file}`, sha256: 'c'.repeat(64) });
const fragment = (version, os, arch, file) => ({ schemaVersion: 1, latest: version, releases: { [version]: { verified: true, [os]: { [arch]: { cli: artifact(version, file) } } } } });

test('a CLI candidate describes its own target with the checksum of its binary', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'tokentracky-cli-candidate-'));
  temporaryRoots.push(dist);
  for (const [target, os, arch, file] of [
    ['x86_64-unknown-linux-musl', 'linux', 'x86_64', 'tokentracky-0.2.0-linux-x86_64'],
    ['aarch64-unknown-linux-musl', 'linux', 'aarch64', 'tokentracky-0.2.0-linux-aarch64'],
    ['x86_64-pc-windows-msvc', 'windows', 'x86_64', 'tokentracky-0.2.0-windows-x86_64.exe'],
  ]) {
    await writeFile(join(dist, file), `binary for ${target}`);
    const out = join(dist, `${target}.json`);
    await main(['cli-candidate', '--out', out, '--version', '0.2.0', '--target', target, '--dist', dist]);
    const sha256 = createHash('sha256').update(`binary for ${target}`).digest('hex');
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), {
      schemaVersion: 1, latest: '0.2.0', releases: { '0.2.0': { verified: true, [os]: { [arch]: { cli: { ...artifact('0.2.0', file), sha256 } } } } },
    });
  }
  await assert.rejects(main(['cli-candidate', '--out', join(dist, 'x.json'), '--version', '0.2.0', '--target', 'x86_64-apple-darwin', '--dist', dist]), /Unknown CLI release target/);
  await assert.rejects(main(['cli-candidate', '--out', join(dist, 'x.json'), '--version', '0.2.1', '--target', 'x86_64-unknown-linux-musl', '--dist', dist]), /ENOENT/);
});

test('merging keeps every platform of one verified release, and refuses disagreement or a platform twice', () => {
  const macos = { schemaVersion: 1, latest: '0.2.0', releases: { '0.2.0': { verified: true, macos: { arm64: { cli: artifact('0.2.0', 'tokentracky-0.2.0-macos-arm64'), app: artifact('0.2.0', 'tokentracky-0.2.0-macos-arm64.dmg') } } } } };
  const linux = fragment('0.2.0', 'linux', 'x86_64', 'tokentracky-0.2.0-linux-x86_64');
  const arm = fragment('0.2.0', 'linux', 'aarch64', 'tokentracky-0.2.0-linux-aarch64');
  const windows = fragment('0.2.0', 'windows', 'x86_64', 'tokentracky-0.2.0-windows-x86_64.exe');
  const merged = mergeManifests([macos, linux, arm, windows]);
  assert.deepEqual(merged, {
    schemaVersion: 1, latest: '0.2.0', releases: { '0.2.0': {
      verified: true,
      macos: macos.releases['0.2.0'].macos,
      linux: { x86_64: linux.releases['0.2.0'].linux.x86_64, aarch64: arm.releases['0.2.0'].linux.aarch64 },
      windows: windows.releases['0.2.0'].windows,
    } },
  });
  // Launchers already published read only macOS arm64, which the merge leaves as it was.
  assert.deepEqual(merged.releases['0.2.0'].macos, macos.releases['0.2.0'].macos);
  assert.throws(() => mergeManifests([macos, fragment('0.2.1', 'linux', 'x86_64', 'tokentracky-0.2.1-linux-x86_64')]), /same verified release/);
  assert.throws(() => mergeManifests([macos, { ...linux, releases: { '0.2.0': { ...linux.releases['0.2.0'], verified: false } } }]), /same verified release/);
  assert.throws(() => mergeManifests([macos, { ...linux, schemaVersion: 2 }]), /same verified release/);
  assert.throws(() => mergeManifests([linux, linux]), /linux x86_64 twice/);
  assert.throws(() => mergeManifests([macos, fragment('0.2.0', 'linux', 'riscv64', 'tokentracky-0.2.0-linux-riscv64')]), /Unknown release platform linux riscv64/);
  assert.throws(() => mergeManifests([]), /at least one/);
});

test('merge writes the combined manifest from the files it is given', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'tokentracky-merge-'));
  temporaryRoots.push(dist);
  const files = [];
  for (const [os, arch, file] of [['linux', 'x86_64', 'tokentracky-0.2.0-linux-x86_64'], ['windows', 'x86_64', 'tokentracky-0.2.0-windows-x86_64.exe']]) {
    files.push(join(dist, `${os}-${arch}.json`));
    await writeFile(files.at(-1), JSON.stringify(fragment('0.2.0', os, arch, file)));
  }
  const out = join(dist, 'merged.json');
  await main(['merge', '--out', out, ...files]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(out, 'utf8')).releases['0.2.0']), ['verified', 'linux', 'windows']);
  for (const args of [['merge', out, ...files], ['merge', '--out', out], ['merge', '--out', '--version', ...files]]) {
    await assert.rejects(main(args), /merge requires --out/);
  }
});

test('version prints the one version every manifest agrees on, without release settings', async () => {
  const root = await fixture('0.2.0');
  let printed = '';
  const write = process.stdout.write;
  process.stdout.write = (text) => { printed += text; return true; };
  try { await main(['version', '--root', root], {}); } finally { process.stdout.write = write; }
  assert.equal(printed, '0.2.0\n');
});
