#!/usr/bin/env node
/**
 * Release-only configuration and metadata helpers.
 *
 * No endpoint, signing key or public verification key is committed. `config` reads the
 * release environment, validates it, and writes a short-lived Tauri override file for the
 * signed build. The output is intentionally unsuitable for a normal developer build.
 */
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required release setting: ${name}`);
  return value;
};

const releaseUrl = (value, name) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return url.toString();
};

export const validatePublicKey = (value) => {
  if (/placeholder|change.?me|example/i.test(value)) {
    throw new Error('TOKENTRACKY_UPDATER_PUBLIC_KEY must be the real release verification key, not a placeholder');
  }
  // Structural validation only: the envelope contains a comment and an Ed25519
  // minisign public packet (algorithm + key id + public key), never a private packet.
  const decode = (text) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
    const bytes = Buffer.from(text, 'base64');
    return bytes.toString('base64') === text ? bytes : null;
  };
  const envelope = decode(value)?.toString('utf8');
  const lines = envelope?.replace(/\r/g, '').trimEnd().split('\n');
  const packet = lines?.length === 2 ? decode(lines[1]) : null;
  if (!lines?.[0].startsWith('untrusted comment: minisign public key: ') ||
      !packet || packet.length !== 42 || packet.subarray(0, 2).toString() !== 'Ed') {
    throw new Error('TOKENTRACKY_UPDATER_PUBLIC_KEY must be a base64 Tauri minisign public envelope (42-byte Ed public packet)');
  }
  return value;
};

export async function versions(root) {
  const [cargo, packageJson, tauri, npmPackage] = await Promise.all([
    readFile(resolve(root, 'Cargo.toml'), 'utf8'),
    readFile(resolve(root, 'package.json'), 'utf8'),
    readFile(resolve(root, 'apps/mac/tauri.conf.json'), 'utf8'),
    readFile(resolve(root, 'packaging/package.json'), 'utf8'),
  ]);
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const packageVersion = JSON.parse(packageJson).version;
  const tauriVersion = JSON.parse(tauri).version;
  const npmVersion = JSON.parse(npmPackage).version;
  if (!cargoVersion || !packageVersion || !tauriVersion || !npmVersion) throw new Error('Could not read all release versions');
  if (new Set([cargoVersion, packageVersion, tauriVersion, npmVersion]).size !== 1) {
    throw new Error(`Version mismatch: Cargo=${cargoVersion}, package.json=${packageVersion}, Tauri=${tauriVersion}, npm=${npmVersion}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cargoVersion)) throw new Error('Release version must be a distribution-compatible SemVer');
  return cargoVersion;
}

export async function releaseSettings(env, root) {
  const version = await versions(root);
  const ref = env.GITHUB_REF_NAME?.replace(/^v/, '');
  if (ref && ref !== version) throw new Error(`Tag version ${ref} does not match source version ${version}`);
  const channel = required(env, 'TOKENTRACKY_UPDATER_CHANNEL');
  if (!['stable', 'beta'].includes(channel)) throw new Error('TOKENTRACKY_UPDATER_CHANNEL must be stable or beta');
  const signing = required(env, 'TOKENTRACKY_SIGNING');
  if (!['adhoc', 'developer-id'].includes(signing)) throw new Error('TOKENTRACKY_SIGNING must be adhoc or developer-id');
  const artifactBase = new URL(releaseUrl(required(env, 'TOKENTRACKY_RELEASE_BASE_URL'), 'TOKENTRACKY_RELEASE_BASE_URL'));
  if (artifactBase.search || artifactBase.hash) throw new Error('TOKENTRACKY_RELEASE_BASE_URL cannot contain a query or fragment');
  return {
    version,
    channel,
    artifactBase: artifactBase.toString(),
    endpoint: releaseUrl(required(env, 'TOKENTRACKY_UPDATER_ENDPOINT'), 'TOKENTRACKY_UPDATER_ENDPOINT'),
    publicKey: validatePublicKey(required(env, 'TOKENTRACKY_UPDATER_PUBLIC_KEY')),
    signing,
    // Ad-hoc (`-`) needs no Apple account; Gatekeeper then asks the user once to Open Anyway.
    signingIdentity: signing === 'adhoc' ? '-' : required(env, 'APPLE_SIGNING_IDENTITY'),
  };
}

const ASSETS = 'https://github.com/AuvreyDurelle/tokentracky/releases/download';

/** The Linux and Windows CLI builds: each Rust target's place in the manifest and its asset's suffix. */
export const CLI_TARGETS = {
  'x86_64-unknown-linux-musl': { os: 'linux', arch: 'x86_64', extension: '' },
  'aarch64-unknown-linux-musl': { os: 'linux', arch: 'aarch64', extension: '' },
  'x86_64-pc-windows-msvc': { os: 'windows', arch: 'x86_64', extension: '.exe' },
};

export function updaterConfig(settings) {
  return {
    bundle: {
      createUpdaterArtifacts: true,
      macOS: { signingIdentity: settings.signingIdentity, hardenedRuntime: settings.signing === 'developer-id' },
    },
    plugins: {
      updater: {
        endpoints: [settings.endpoint],
        pubkey: settings.publicKey,
        requireSignedVersion: true,
        allowDowngrades: false,
      },
    },
  };
}

export function updaterFeed({ version, notes, pubDate, artifactUrl, signature, target = 'darwin-aarch64' }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Feed version must be SemVer');
  const url = releaseUrl(artifactUrl, 'artifact URL');
  if (!signature?.trim() || /placeholder|change.?me/i.test(signature)) {
    throw new Error('Feed requires a real updater artifact signature');
  }
  if (!/^darwin-(aarch64|x86_64)$/.test(target)) throw new Error('Feed target must be a supported macOS architecture');
  return {
    version,
    notes: notes ?? '',
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: { [target]: { url, signature: signature.trim() } },
  };
}

export function validateUpdaterFeed(feed) {
  if (!feed || typeof feed !== 'object') throw new Error('Updater feed must be an object');
  for (const [target, release] of Object.entries(feed.platforms ?? {})) {
    updaterFeed({ ...feed, target, artifactUrl: release?.url, signature: release?.signature });
  }
  if (!Object.keys(feed.platforms ?? {}).length) throw new Error('Updater feed has no platform artifacts');
  return feed;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  const options = new Map();
  const allowed = {
    validate: ['--root'], version: ['--root'], config: ['--root', '--out'],
    feed: ['--out', '--signature-file', '--artifact-url', '--version', '--notes', '--target'],
    candidate: ['--out', '--version', '--dist'], 'cli-candidate': ['--out', '--version', '--target', '--dist'],
    notary: ['--receipt'],
  }[command];
  if (!allowed) throw new Error('Unknown release command');
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(`Malformed or duplicate release option: ${args[i]}`);
    }
    options.set(args[i], args[i + 1]);
  }
  const value = (name) => options.get(name);
  const root = resolve(value('--root') ?? process.cwd());
  if (command === 'notary') {
    const receipt = JSON.parse(await readFile(value('--receipt'), 'utf8'));
    if (receipt.status !== 'Accepted' || !receipt.id) throw new Error('Notarization was not Accepted');
    return;
  }
  if (command === 'candidate') {
    const version = value('--version');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '') || !value('--out') || !value('--dist')) {
      throw new Error('candidate requires --version, --dist and --out');
    }
    const artifacts = {};
    for (const [kind, extension] of [['cli', ''], ['app', '.dmg']]) {
      const file = `tokentracky-${version}-macos-arm64${extension}`;
      const bytes = await readFile(resolve(value('--dist'), file));
      artifacts[kind] = { file, url: `${ASSETS}/v${version}/${file}`, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    await writeFile(value('--out'), `${JSON.stringify({ schemaVersion: 1, latest: version, releases: { [version]: { verified: true, macos: { arm64: artifacts } } } }, null, 2)}\n`);
    return;
  }
  if (command === 'cli-candidate') {
    const version = value('--version');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '') || !value('--out') || !value('--dist') || !value('--target')) {
      throw new Error('cli-candidate requires --version, --target, --dist and --out');
    }
    if (!Object.hasOwn(CLI_TARGETS, value('--target'))) throw new Error(`Unknown CLI release target ${value('--target')}`);
    const { os, arch, extension } = CLI_TARGETS[value('--target')];
    const file = `tokentracky-${version}-${os}-${arch}${extension}`;
    const bytes = await readFile(resolve(value('--dist'), file));
    const cli = { file, url: `${ASSETS}/v${version}/${file}`, sha256: createHash('sha256').update(bytes).digest('hex') };
    await writeFile(value('--out'), `${JSON.stringify({ schemaVersion: 1, latest: version, releases: { [version]: { verified: true, [os]: { [arch]: { cli } } } } }, null, 2)}\n`);
    return;
  }
  if (command === 'version') {
    process.stdout.write(`${await versions(root)}\n`);
    return;
  }
  if (command === 'validate') {
    process.stdout.write(`${await releaseSettings(env, root).then(({ version }) => version)}\n`);
    return;
  }
  if (command === 'config') {
    const output = value('--out');
    if (!output) throw new Error('config requires --out PATH');
    await writeFile(output, `${JSON.stringify(updaterConfig(await releaseSettings(env, root)), null, 2)}\n`);
    return;
  }
  if (command === 'feed') {
    const output = value('--out');
    const signatureFile = value('--signature-file');
    if (!output || !signatureFile || !value('--artifact-url') || !value('--version')) {
      throw new Error('feed requires --out, --signature-file, --artifact-url and --version');
    }
    const signature = await readFile(signatureFile, 'utf8');
    const feed = updaterFeed({
      version: value('--version'),
      artifactUrl: value('--artifact-url'),
      signature,
      notes: value('--notes') ?? '',
      target: value('--target') ?? 'darwin-aarch64',
    });
    validateUpdaterFeed(feed);
    await writeFile(output, `${JSON.stringify(feed, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: macos-release.mjs <validate|config|feed> [options]');
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`macOS release validation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
