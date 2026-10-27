# CLI and Mac distribution

The Rust CLI is `crates/cli` (`tokentracky`), currently version `0.1.0`. The separate `packaging/` npm package owns the eventual public `tokentracky` npm name and must be published at the exact Cargo CLI version.

## Supported target

The first distribution target is macOS 13+ (Ventura) on Apple Silicon (`darwin-arm64`). npm users need Node 18+ to run the small launcher; after download, the Rust executable runs without Node. The launcher rejects Linux, Windows, Intel macOS and older macOS with a platform-specific message.

## Release asset interface

The native release pipeline builds the Rust executable from the same versioned commit as the Mac app, signs it (ad-hoc, or Developer ID with notarization), and publishes these immutable assets on the GitHub release `https://github.com/AuvreyDurelle/tokentracky/releases/tag/v<VERSION>`:

| Asset | Name | Purpose |
| --- | --- | --- |
| Raw signed CLI executable | `tokentracky-<VERSION>-macos-arm64` | npm launcher and Homebrew formula |
| Signed Mac disk image | `tokentracky-<VERSION>-macos-arm64.dmg` | Homebrew cask |
| The same disk image, fixed name | `Tokentracky.dmg` | Website download through `releases/latest/download/Tokentracky.dmg` |
| Release checksums | `SHA256SUMS` | Auditable checksums for every published artifact |

The raw executable must be directly executable after download and report the exact Cargo version for `--version`. The DMG must contain `Tokentracky.app`. Assets and release tags must use the exact versioned names above; do not overwrite published assets.

The raw CLI includes its dashboard: build web resources first, then `cargo build --locked --release -p tokentracky-cli --features embed-web`. Release compilation rejects a missing feature or incomplete asset bundle. npm, Homebrew and direct downloads all install those same executable bytes; no sibling web directory, repository or Node runtime is needed by the CLI. The embedded files are extracted into a fresh private temporary directory for the process lifetime, removed on graceful quit. `TOKENTRACKY_WEB_ROOT` remains an explicit development override.

After signature/notarization validation and SHA-256 calculation, the packaging release step emits this manifest shape (the checked-in npm manifest stays empty until that gate passes):

```json
{
  "schemaVersion": 1,
  "latest": "<VERSION>",
  "releases": {
    "<VERSION>": {
      "verified": true,
      "macos": {
        "arm64": {
          "cli": {
            "file": "tokentracky-<VERSION>-macos-arm64",
            "url": "https://github.com/AuvreyDurelle/tokentracky/releases/download/v<VERSION>/tokentracky-<VERSION>-macos-arm64",
            "sha256": "<actual lowercase SHA-256>"
          },
          "app": {
            "file": "tokentracky-<VERSION>-macos-arm64.dmg",
            "url": "https://github.com/AuvreyDurelle/tokentracky/releases/download/v<VERSION>/tokentracky-<VERSION>-macos-arm64.dmg",
            "sha256": "<actual lowercase SHA-256>"
          }
        }
      }
    }
  }
}
```

Only release automation may set `verified: true`, after it has validated the actual release artifacts: signed and notarized for Developer ID, ad-hoc signed otherwise. It means the manifest matches the published bytes, not that Apple notarized them. When a release is published, the release workflow copies the manifest into `packaging/` and runs `npm publish`; the checked-in manifest stays empty. The npm package embeds this manifest and the wrapper downloads only the matching version, validates its fixed GitHub release URL and checksum, and runs it from a user cache. `npm pack` must be repeated with the manifest matching the package/Cargo version for each npm publication. The `prepublishOnly` guard refuses an empty/unverified manifest and downloads both public CLI and DMG to verify their checksums before allowing `npm publish` from `packaging/`. Do not bypass lifecycle scripts during publication.

## Homebrew and website

Run `node packaging/scripts/generate-brew.mjs <verified-manifest.json> <output-directory>` to write `Casks/tokentracky.rb` and `Formula/tokentracky-cli.rb`. The formula has its own name because Homebrew does not link a formula named like an installed cask; it still installs the `tokentracky` command. It refuses an unverified release or missing checksum and emits only the supported arm64 artifacts. The cask declares `auto_updates true`: the app updates itself, so `brew upgrade` leaves it alone. When a release is published, the release workflow commits both definitions to `AuvreyDurelle/homebrew-tokentracky` without pushing, taps that local commit, runs `brew audit` on both, installs both and runs `brew test`, and only then pushes. It needs a `HOMEBREW_TAP_TOKEN` secret: a fine-grained token with contents write on the tap only. Create the tap with a README so it has a default branch. Users install with `brew install --cask AuvreyDurelle/tokentracky/tokentracky` (app) or `brew install AuvreyDurelle/tokentracky/tokentracky` (CLI).

The website's download entry stays “Mac app coming soon” unless the deploy sets `VITE_MACOS_DOWNLOAD_ENABLED=true` at build time. The button then links `https://github.com/AuvreyDurelle/tokentracky/releases/latest/download/Tokentracky.dmg`, a fixed-name copy of the DMG that every published release carries. Drafts are never latest, so the link only serves a finished release and the site needs no change per release. Turn it on after the first release is published and the repository is public.

## Candidate handoff and promotion

`scripts/prepare-macos-release.sh` emits both exact asset names, the app updater archive/signature (stapled for Developer ID), accepted Apple notarization receipts (Developer ID only), a `verified-candidate-manifest.json`, `SHA256SUMS` and `homebrew-definitions.tar.gz`. This candidate manifest describes locally verified artifacts with their eventual GitHub URLs; it does **not** assert that a draft URL is publicly downloadable. The checked-in npm manifest and website gate remain unchanged.

The release workflow then uploads the draft, downloads it to check every byte, and (unless `publish` is false) publishes it as latest, publishes npm with the candidate manifest and updates the tap. Turn on the website button once, after the first release is public. For Developer ID, a raw CLI cannot carry a stapled ticket: its exact signed bytes are submitted in a ZIP, and its notarization receipt plus online Gatekeeper assessment are required. Offline first-run behavior of a newly downloaded raw CLI still needs a real clean-Mac check.

`npm run test:harness --prefix packaging` packs and installs into disposable local and global prefixes, exercises direct/local/global/npx execution, arguments/exit codes, cache corruption rejection and SIGTERM/SIGINT/SIGHUP delivery. Its synthetic payloads simulate a supported host on Linux too. `node --test packaging/test/*.test.mjs` validates bounded downloads, Ruby syntax, tap filename/token shape and the formula's raw-binary install mapping; these checks do not substitute for real Homebrew install/audit against published signed artifacts.

Native CI and the candidate script additionally run `python3 scripts/check-standalone-cli.py --binary <actual-cli> --web-dist apps/web/dist`. It copies only the executable outside the checkout, temporarily hides the checkout web build, and uses an isolated home/data folder and credential namespace. It consumes the private launch link and verifies exact HTML and every built JS/CSS file with MIME types, an SPA route, authenticated API health, session/traversal rejection and graceful shutdown/lock release. The source build is restored on success or failure. Run this check after other packaging work has finished reading that directory.
