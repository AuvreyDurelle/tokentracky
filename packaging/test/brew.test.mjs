import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';

const script = resolve(fileURLToPath(new URL('../scripts/generate-brew.mjs', import.meta.url)));
const version = '0.1.0';
const manifest = {
  schemaVersion: 1,
  latest: version,
  releases: {
    [version]: {
      verified: true,
      macos: { arm64: {
        app: { file: `tokentracky-${version}-macos-arm64.dmg`, url: `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/tokentracky-${version}-macos-arm64.dmg`, sha256: 'a'.repeat(64) },
        cli: { file: `tokentracky-${version}-macos-arm64`, url: `https://github.com/AuvreyDurelle/tokentracky/releases/download/v${version}/tokentracky-${version}-macos-arm64`, sha256: 'b'.repeat(64) },
      } },
    },
  },
};

test('generates arm64 Homebrew definitions only from verified manifest artifacts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tokentracky-brew-'));
  try {
    const input = join(temp, 'manifest.json');
    const output = join(temp, 'brew');
    await writeFile(input, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [script, input, output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    // A formula named like the cask is not linked once the app is installed, so the CLI formula has its own name.
    const formula = await readFile(join(output, 'Formula/tokentracky-cli.rb'), 'utf8');
    assert.match(formula, /\nclass TokentrackyCli < Formula\n/);
    const cask = await readFile(join(output, 'Casks/tokentracky.rb'), 'utf8');
    // brew audit refuses the string form ">= :ventura" in a formula; a bare symbol is already a minimum.
    for (const definition of [formula, cask]) assert.match(definition, /\n {2}depends_on macos: :ventura\n/);
    assert.match(formula, /depends_on arch: :arm64/);
    assert.match(formula, new RegExp(manifest.releases[version].macos.arm64.cli.sha256));
    assert.match(cask, /depends_on arch: :arm64/);
    // The app updates itself, so Homebrew must not try to replace it on brew upgrade.
    assert.match(cask, /\n {2}auto_updates true\n/);
    assert.match(cask, new RegExp(manifest.releases[version].macos.arm64.app.sha256));
    // brew audit reads the url line as written and fails a pinned sha256 unless it interpolates the version.
    assert.match(cask, /\n {2}url "https:\/\/github\.com\/AuvreyDurelle\/tokentracky\/releases\/download\/v#\{version\}\/tokentracky-#\{version\}-macos-arm64\.dmg"\n/);
    // Homebrew reads the version from the release URL, and brew audit fails a version line that repeats it.
    assert.doesNotMatch(formula, /^\s*version "/m);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('refuses unverified, missing, and invalid-checksum release inputs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tokentracky-brew-'));
  try {
    const input = join(temp, 'manifest.json');
    for (const invalid of [
      { ...manifest, releases: { [version]: { ...manifest.releases[version], verified: false } } },
      { ...manifest, releases: { [version]: { verified: true, macos: { arm64: { ...manifest.releases[version].macos.arm64, cli: { ...manifest.releases[version].macos.arm64.cli, sha256: 'not-a-sha' } } } } } },
    ]) {
      await writeFile(input, JSON.stringify(invalid));
      const result = spawnSync(process.execPath, [script, input, join(temp, 'out')], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('generated tap paths parse as Ruby and formula install maps the raw artifact to bin/tokentracky', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tokentracky-brew-install-'));
  try {
    const input = join(temp, 'manifest.json');
    await writeFile(input, JSON.stringify(manifest));
    assert.equal(spawnSync(process.execPath, [script, input, temp]).status, 0);
    for (const path of ['Formula/tokentracky-cli.rb', 'Casks/tokentracky.rb']) {
      const syntax = spawnSync('ruby', ['-c', join(temp, path)], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    const contract = `require 'fileutils'
class Formula
  def self.method_missing(name, *args, **kwargs, &block); end
  def self.test(&block); end

end
load ARGV[0]
# Homebrew's bin object performs this mapping; the stub checks the generated install method.
class Bin
  def install(mapping)
    raise 'wrong mapping' unless mapping == { 'tokentracky-0.1.0-macos-arm64' => 'tokentracky' }
    FileUtils.mkdir_p('installed'); FileUtils.cp(mapping.keys.first, 'installed/tokentracky')
  end
end
class TokentrackyCli
  def bin; Bin.new; end
end
TokentrackyCli.new.install
raise 'install lost payload' unless File.read('installed/tokentracky') == 'native fixture'
class CaskCheck
  def initialize; @app = nil; end
  def method_missing(name, *args, **kwargs); @app = args.first if name == :app; end
  def validate; raise 'missing app install stanza' unless @app == 'Tokentracky.app'; end
end
def cask(token, &block)
  raise 'cask filename/token mismatch' unless token == File.basename(ARGV[1], '.rb')
  check = CaskCheck.new; check.instance_eval(&block); check.validate
end
load ARGV[1]
`;
    await writeFile(join(temp, 'contract.rb'), contract);
    await writeFile(join(temp, 'tokentracky-0.1.0-macos-arm64'), 'native fixture');
    const installed = spawnSync('ruby', [join(temp, 'contract.rb'), join(temp, 'Formula/tokentracky-cli.rb'), join(temp, 'Casks/tokentracky.rb')], { cwd: temp, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
