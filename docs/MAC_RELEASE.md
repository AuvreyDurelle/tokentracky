# macOS releases

This runbook describes the Rust/Tauri Mac release path, and the Linux and Windows CLIs released beside it ([below](#linux-and-windows-cli-releases)). The **Release** workflow (`release-macos.yml`) builds a GitHub draft and checks every uploaded byte. Unless `publish` is false, it then publishes the release as latest, publishes npm and updates the Homebrew tap. The first releases are **ad-hoc signed** (`signing: adhoc`): not notarized, so users click Open Anyway once ([README](../README.md#install-on-a-mac)). Once a Developer ID certificate exists, `signing: developer-id` signs and notarizes instead. The first supported release target is Apple Silicon (`aarch64`) on macOS 13 or newer. Intel artifacts need their own signed build and validation before they are advertised.

## Native gate

`native-macos` in CI runs on `macos-14` and builds the React resources, the Tauri application and the Rust CLI from the same checked-out commit. It also bundles and extracts an unsigned native app, verifies CLI version/arm64 architecture and bundled web resources, and runs the Mac crate's tests, clippy, formatting and packaging harnesses. This is additional to, not a replacement for, the Linux Rust and HTTP contract gates.

The CLI is built with `--features embed-web`; release builds cannot omit the dashboard bundle. Both the native package gate and candidate script test the actual raw executable copied outside the checkout with `apps/web/dist` temporarily hidden, isolated home/data and test credential namespace. The check requires complete HTML and JS/CSS delivery, correct MIME types, SPA/API/session/traversal behavior and graceful quit. The signed candidate's exact raw bytes are checked before notarization; npm/Homebrew keep the same single executable interface. See `DISTRIBUTION.md` for the standalone check command and restoration behavior.

Unsigned local builds have no updater plugin configuration and no update menu items. A signed candidate is built only when `TOKENTRACKY_RELEASE_UPDATER=1` and a generated, temporary Tauri override contains a real HTTPS endpoint and public verification key. Release builds check 30 seconds after the collector starts and every six hours thereafter, including while the dashboard is closed. When a newer version is available, a nonmodal native prompt offers **Update now** or **Later**. Updating downloads, verifies and installs the selected version, then offers **Restart now** or **Later**. The app never restarts without the user's action. Automatic reminders for the same version are limited to once per 24 hours, persisted in `update-reminder.json` under the app configuration directory; a different version or a manual check can prompt sooner. Checks run without overlapping checks/downloads and stop on shutdown. Background no-update/network-error results stay silent; manual checks still report their result. Check requests time out after 30 seconds; download requests after five minutes. The updater requires a signature whose trusted version matches the advertised version and refuses downgrades.

The updater is called only by Rust native code, not by the webview. Consequently no updater IPC permission is granted to the renderer: the plugin’s frontend `check`/`download`/`install` commands are deliberately unavailable. This keeps the update capability at the native UI boundary while still using Tauri’s signature verification.

The app's own pages still have no IPC. They reach the app through same-origin `/api/shell/*` routes served by its `app://` handler (state, launch at login, open the dashboard, the gear menu, quit; see `IMPLEMENTATION_CONTRACT.md`). For updates the page can only ask for a check: downloading and restarting to install stay in native prompts and the gear menu.

Clicking the menu bar icon toggles a borderless, transparent 380×640 popover web view at `/popover`, placed under the icon on that icon's screen. It closes when it loses focus. `release_webkit` waits until every window, the popover included, has closed before releasing WebKit's helpers. The transparent, vibrant window needs Tauri's `macos-private-api` feature with `macOSPrivateApi: true` in `tauri.conf.json`. Apps using private API can't go through the Mac App Store; Tokentracky ships outside it. `--open-popover` opens the popover for the runtime harness, as `--open-you` opens the dashboard.

## Workflow setup

Configure a protected GitHub environment named `macos-release`, with required reviewers and limited to `v*` tags. Do not put any of these values in repository files, workflow YAML, shell history, or logs.

| GitHub environment secret/variable | Kind | Purpose |
| --- | --- | --- |
| `APPLE_CERTIFICATE_BASE64` | secret | Developer ID only. Base64 Developer ID Application `.p12` certificate. |
| `APPLE_CERTIFICATE_PASSWORD` | secret | Developer ID only. Password for that `.p12`. |
| `APPLE_SIGNING_IDENTITY` | variable | Developer ID only. Exact `Developer ID Application: … (TEAMID)` identity selected by `codesign`. |
| `APPLE_API_KEY_ID` | secret | Developer ID only. App Store Connect API key id for `notarytool`. |
| `APPLE_API_ISSUER` | secret | Developer ID only. App Store Connect issuer UUID. |
| `APPLE_API_PRIVATE_KEY_BASE64` | secret | Developer ID only. Base64 contents of the App Store Connect API `.p8`. |
| `TAURI_SIGNING_PRIVATE_KEY` | secret | Tauri updater private signing key, separate from Apple credentials. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | Password for the Tauri signing key, if the key is encrypted. |
| `TOKENTRACKY_UPDATER_PUBLIC_KEY` | variable | Matching Tauri updater public verification key. It is compiled into the signed candidate; it is not a private secret. |
| `TOKENTRACKY_UPDATER_ENDPOINT` | variable | HTTPS endpoint for the selected channel’s feed. For `stable`: `https://github.com/AuvreyDurelle/tokentracky/releases/latest/download/stable.json`. Drafts are never latest, so installed apps only see a release once it is published. |
| `TOKENTRACKY_UPDATER_CHANNEL` | variable | `stable` or `beta`. |
| `TOKENTRACKY_RELEASE_BASE_URL` | set by the workflow | `https://github.com/AuvreyDurelle/tokentracky/releases/download/<tag>`, from the `ref` input; the updater filename is appended directly. |
| `GH_TOKEN` | workflow token | Read CI workflow runs for the exact tagged commit; the workflow grants `actions: read`. |
| `HOMEBREW_TAP_TOKEN` | secret | Fine-grained token with contents write on `AuvreyDurelle/homebrew-tokentracky` only. Without it, publishing warns and skips the tap. |

npm needs no stored token. The `publish-npm` job runs after the release is published, in the same environment. A publishing run asks for approval four times: `build-macos`, `publish`, `homebrew` and `publish-npm` (a run with `publish: false` twice: `build-macos` and `publish`). npm accepts that job's GitHub identity token (trusted publishing, with provenance) only if the package has a matching trusted publisher, which must already exist on npm, so the first version is published by hand from `packaging/` with that release's `verified-candidate-manifest.json` as `release-manifest.json`. Within two days before the first release that publishes from the workflow, an owner with npm 2FA runs this with npm 11.15 or later; npm expires a configuration that no publish has used within two days:

```sh
npm trust github tokentracky --repo AuvreyDurelle/tokentracky --file release-macos.yml --env macos-release --allow-publish
```

`--allow-publish` is required: without it, new configurations accept only `npm stage publish`. `npm trust list tokentracky` shows the configuration, and npm allows one per package. If it expired or changed, run `npm trust revoke tokentracky --id <id>` and create it again. `packaging/package.json` `repository.url` must keep naming this repository. If the job fails, the GitHub release is already public: create the configuration, then rerun only the failed job.

The script requires a clean checkout at the exact version tag and a successful **entire** `ci.yml` workflow on that commit (including hosted contracts and native/distribution gates). Missing/failed/pending CI, absent values, malformed public key envelopes, non-HTTPS URLs, credentials/nondefault ports and mismatched source versions fail closed. Public-key validation checks the Tauri minisign envelope/packet structure only; the final archive is also cryptographically verified with `minisign` against that key.

All temporary files start under `umask 077`. For Developer ID, Apple material is imported into a temporary keychain, the exact prior user keychain search list is restored on success and failure, and the temporary keychain, certificate, notary key and build directory are removed. Restore failures fail the run. Dependencies include pinned Tauri CLI 2.11.5, `minisign`, Python 3, Swift/Xcode command-line tools and Finder automation permission. Workflow action SHAs are pinned; checkout/setup-node/rust-cache/upload-artifact/download-artifact/cargo-deny revisions were checked against their upstream refs.

Run **Release** with a version tag matching all source versions, the signing mode, and `publish` (default true; false stops at the checked draft). Update Cargo workspace, root and packaging `package.json`, and `apps/mac/tauri.conf.json` together. After full CI succeeds on that commit, the script builds web resources, runs `cargo tauri build --no-bundle --config ... -- --locked` **from `apps/mac` with `TOKENTRACKY_RELEASE_UPDATER=1`**, then bundles from the same directory/config in a fresh target tree. The CLI is built locked, signed with hardened runtime/timestamp, checked for version/arm64, submitted in a ZIP and assessed with Gatekeeper. Apps are submitted separately, stapled and validated before either delivery container is constructed. With `adhoc`, the app, CLI and DMG are signed with `-` and must report `Signature=adhoc`; there is no keychain, notarization, stapling or Gatekeeper assessment.

The DMG uses `scripts/dmg-background.swift`, fixed repo-native artwork with “Waste tokens, not time.”, a 660×440 Finder window, fixed app/Applications icon positions and the standard Applications symlink. `build-macos-dmg.py` bounds Finder automation to 30 seconds (40-second process deadline), checks the background/icon settings and `.DS_Store`, and fails with captured AppleScript diagnostics on automation denial or failure. For Developer ID, the DMG copies the already-stapled app, is signed, submitted, stapled, validated and assessed; for ad-hoc it is only signed and checked. This layout still requires a real GUI release-runner verification; an unstyled image is never accepted as fallback.

The updater tar is rebuilt **after app stapling**, then signed using the real `TAURI_SIGNING_PRIVATE_KEY` and `cargo tauri signer sign --app-version VERSION`. Its final bytes are verified with `minisign`; earlier bundle archives/signatures are discarded with the temporary build tree. The exact distribution names are `tokentracky-VERSION-macos-arm64` and `tokentracky-VERSION-macos-arm64.dmg`. The release includes `verified-candidate-manifest.json`, both Homebrew definitions in an archive, accepted notary receipts (Developer ID), inventories and provenance. It also carries `Tokentracky.dmg`, a fixed-name copy of the DMG for the website's latest link, and `SHA256SUMS` of exactly the uploaded files, repeated in the notes. The checked-in `packaging/release-manifest.json` stays empty; npm gets the manifest at publish time.

## Linux and Windows CLI releases

The same run builds the CLI, with its embedded dashboard, for Linux x86_64 (`ubuntu-22.04`), Linux aarch64 (`ubuntu-24.04-arm`) and Windows x86_64 (`windows-2022`) in the `build-cli` matrix. These jobs hold no secrets, so they run outside the `macos-release` environment and need no approval. Each runs `scripts/prepare-cli-release.sh <target>` (with bash on Windows too), which refuses a dirty tree or a commit other than the exact version tag, builds the web bundle and `cargo build --locked --release -p tokentracky-cli --features embed-web --target <target>` in a fresh target folder, checks `--version`, that a Linux binary is statically linked, and runs the standalone check against the copied binary. It writes `tokentracky-<VERSION>-linux-x86_64`, `-linux-aarch64` or `-windows-x86_64.exe` with `SHA256SUMS`, `source-provenance.txt`, `cargo-metadata.json` and `manifest-fragment.json` to `dist/cli-release/<target>`. The whole-CI gate is checked once, by `build-macos`, which `publish` waits for.

Linux binaries are static musl builds: one per architecture runs on any distribution. The Windows binary is not signed yet; the published SHA-256 checksums are its integrity, as for the ad-hoc Mac build. A double-clicked download may get a SmartScreen warning; the npm launcher's download does not. Azure Trusted Signing or SignPath is the later fix.

The `publish` job merges the macOS manifest and the three fragments with `node scripts/macos-release.mjs merge`, which refuses parts of different or unverified releases and any platform twice. It uploads the macOS assets, the three CLIs and the merged manifest under the name `verified-candidate-manifest.json` that npm publication downloads, and refuses to continue unless all three CLIs are there. The release notes gain a first-run paragraph for each system. Homebrew stays macOS-only.

The workflow keeps its file name, `release-macos.yml`, because npm trusted publishing is pinned to it; rename it only together with a new `npm trust` configuration.

Outside macOS there is no menu bar app to keep collecting: users keep `tokentracky serve` running, or run `tokentracky refresh` on a schedule. On Windows the credential file has no mode bits; the user profile's access list keeps it the owner's. DPAPI or the Credential Manager is a follow-up.

## Feed and verification

`scripts/macos-release.mjs` generates the release-only Tauri config and validates a channel feed. The feed (`stable.json`), the signed updater archive and its `.sig` are uploaded with the release. Installed apps read the feed through `releases/latest/download/stable.json`, so they see a release only once it is published. Do not point a public endpoint at a draft or a locally generated feed.

Before announcing the app, publish two versions `N` and `N+1` signed with the same updater key. On a clean supported Mac, install `N`, then:

- Positive: launch `N`, wait for its automatic update prompt, choose **Update now**, then **Restart now**. Verify the installed version, that Gatekeeper does not ask again, and that local data, consent settings and the credential file survive. Repeat via **Check for updates** and the native menu.
- Choose **Later**, relaunch and verify no automatic prompt for that version before 24 hours; a manual check and a newer version can prompt sooner. Leave a prompt open across a scheduled check and verify it is not replaced. Choose **Later** at the restart prompt and verify collection continues with a restart action in the menu.
- Negative: serve an `N+1` feed with a malformed/tampered signature and verify download fails without replacing `N`; repeat with a valid old artifact advertised as `N+1` to prove `requireSignedVersion` rejects the version mismatch.
- Interrupt the download (offline/network termination), relaunch `N`, then repeat with a valid feed. Verify no partial installer replaces the app and recovery succeeds.
- Return HTTP/network failure and verify the manual check remains idle-safe and the app continues to collect normally. Test no-update and channel selection separately for `stable` and `beta`.
- Withdraw a bad feed by returning no update/withholding the affected version, then test a signed forward-fix `N+2`. Downgrades are intentionally not supported; recovery is a newer, signed version.

These are runtime signing tests, not tests the repository can honestly mark passed without real Tauri credentials and artifacts (and Apple ones for Developer ID). The negative feed tests need a candidate built with a test feed endpoint, since the published feed cannot be tampered with. Record the candidate checksums, commit, OS/hardware, date and evidence location with each run.

## Key rotation and incident recovery

The embedded public key is an update trust root. A new private key cannot update an installed build that only trusts the old public key. Test rotation with real candidates before needing it: ship a bridge release signed by the currently trusted key that contains the next trusted public key only if the selected Tauri key-rotation strategy supports that chain; otherwise maintain the old signing key under emergency controls until the supported population is migrated. Never replace the key in the feed and assume existing apps will accept it. For a compromised updater or Apple credential, stop the affected feed/download immediately, preserve evidence, revoke/replace the credential, and issue a signed forward-fix where the installed trust root permits it.

## Local validation commands

```sh
node --test scripts/macos-release*.test.mjs packaging/test/*.test.mjs
npm run test:harness --prefix packaging
shellcheck scripts/prepare-macos-release.sh scripts/check-native-package.sh
actionlint .github/workflows/*.yml
cargo fmt --all --check
cargo clippy -p tokentracky-mac --all-targets -- -D warnings
cargo test -p tokentracky-mac
npm run build --workspace=@tokentracky/web
cargo clippy -p tokentracky-cli --all-targets --features embed-web -- -D warnings
cargo test -p tokentracky-cli --features embed-web
bash scripts/check-native-package.sh
```

The last command produces an unsigned native build only. Do not represent it as a signed release candidate or use it to test the live updater.
