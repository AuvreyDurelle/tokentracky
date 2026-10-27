#!/usr/bin/env node
import process from 'node:process';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {download} from '../bin/tokentracky.mjs';

export async function verifyPublication(manifest, version, fetcher = globalThis.fetch) {
  const release = manifest?.releases?.[version];
  if (manifest?.schemaVersion !== 1 || manifest.latest !== version || release?.verified !== true) {
    throw new Error('npm publication requires the matching verified release manifest.');
  }
  const folder = await mkdtemp(join(tmpdir(), 'tokentracky-publication-'));
  try {
    for (const [kind, extension] of [['cli', ''], ['app', '.dmg']]) {
      const name = `tokentracky-${version}-macos-arm64${extension}`;
      const expectedUrl = `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/${name}`;
      const artifact = release.macos?.arm64?.[kind];
      if (artifact?.file !== name || artifact.url !== expectedUrl || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
        throw new Error(`Invalid ${kind} release artifact metadata.`);
      }
      // Public URLs must already serve the exact candidate bytes before an immutable npm version is published.
      const bytes = await download(expectedUrl, join(folder, name), fetcher);
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error(`Public ${kind} artifact checksum mismatch.`);
    }
  } finally {await rm(folder, {recursive: true, force: true});}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
    if (!license.includes('MIT License') || !license.includes('Permission is hereby granted')) throw new Error('npm publication requires the MIT licence notice.');
    const manifest = JSON.parse(await readFile(new URL('../release-manifest.json', import.meta.url), 'utf8'));
    const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    await verifyPublication(manifest, version);
    process.stdout.write('Public CLI and DMG match the verified manifest.\n');
  } catch (error) {process.stderr.write(`Publication blocked: ${error.message}\n`);process.exitCode = 1;}
}
