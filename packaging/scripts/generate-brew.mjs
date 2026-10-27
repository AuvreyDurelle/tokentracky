#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import process from 'node:process';
import { resolve } from 'node:path';

const [manifestPath, outputDir] = process.argv.slice(2);
if (!manifestPath || !outputDir) {
  process.stderr.write('Usage: node scripts/generate-brew.mjs <verified-release-manifest.json> <output-directory>\n');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const version = manifest.latest;
const entry = manifest.releases?.[version];
if (manifest.schemaVersion !== 1 || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !entry || entry.verified !== true) throw new Error('Refusing to generate Homebrew definitions without a verified release manifest.');
const { app, cli } = entry.macos?.arm64 ?? {};
const expected = (artifact, kind) => {
  const filename = kind === 'app' ? `tokentracky-${version}-macos-arm64.dmg` : `tokentracky-${version}-macos-arm64`;
  const url = `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/${filename}`;
  if (!artifact || artifact.file !== filename || artifact.url !== url || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
    throw new Error(`Missing or invalid verified macOS arm64 ${kind} artifact for ${version}.`);
  }
  return artifact;
};
const appArtifact = expected(app, 'app');
const cliArtifact = expected(cli, 'cli');
const cask = `# typed: strict\n# frozen_string_literal: true\n\ncask "tokentracky" do\n  version "${version}"\n  sha256 "${appArtifact.sha256}"\n\n  url "${appArtifact.url.replaceAll(version, '#{version}')}"\n  name "Tokentracky"\n  desc "Local AI coding token tracker and leaderboard"\n  homepage "https://github.com/AuvreyDurelle/tokentracky"\n\n  auto_updates true\n  depends_on arch: :arm64\n  depends_on macos: ">= :ventura"\n\n  app "Tokentracky.app"\nend\n`;
const formula = `# typed: strict\n# frozen_string_literal: true\n\n# CLI formula for Tokentracky on macOS Apple Silicon.\nclass Tokentracky < Formula\n  desc "Local AI coding token tracker and leaderboard CLI"\n  homepage "https://github.com/AuvreyDurelle/tokentracky"\n  url "${cliArtifact.url}"\n  sha256 "${cliArtifact.sha256}"\n\n  depends_on arch: :arm64\n  depends_on macos: ">= :ventura"\n\n  def install\n    bin.install "${cliArtifact.file}" => "tokentracky"\n  end\n\n  test do\n    assert_match version.to_s, shell_output("#{bin}/tokentracky --version")\n  end\nend\n`;
const destination = resolve(outputDir);
await Promise.all(['Formula', 'Casks'].map((directory) => mkdir(resolve(destination, directory), { recursive: true })));
await Promise.all([
  writeFile(resolve(destination, 'Formula/tokentracky.rb'), formula),
  writeFile(resolve(destination, 'Casks/tokentracky.rb'), cask),
]);
