# Tokentracky npm distribution

This package is a Node launcher for the native Rust CLI. Node is needed to run `npx tokentracky` or the installed npm command; the downloaded Tokentracky CLI itself has no Node runtime dependency.

The package currently contains an empty release manifest, so it intentionally reports that a verified binary is not available. Release publication must replace `release-manifest.json` with the verified manifest for the matching package version. Each entry has the form:

```json
{
  "schemaVersion": 1,
  "latest": "0.1.0",
  "releases": {
    "0.1.0": {
      "verified": true,
      "macos": { "arm64": {
        "cli": {
          "file": "tokentracky-0.1.0-macos-arm64",
          "url": "https://github.com/AuvreyDurelle/tokentracky/releases/download/v0.1.0/tokentracky-0.1.0-macos-arm64",
          "sha256": "<64 lowercase hex characters from the verified release>"
        },
        "app": {
          "file": "tokentracky-0.1.0-macos-arm64.dmg",
          "url": "https://github.com/AuvreyDurelle/tokentracky/releases/download/v0.1.0/tokentracky-0.1.0-macos-arm64.dmg",
          "sha256": "<64 lowercase hex characters from the verified release>"
        }
      }},
      "linux": {
        "x86_64": { "cli": { "file": "tokentracky-0.1.0-linux-x86_64", "url": "…", "sha256": "…" } },
        "aarch64": { "cli": { "file": "tokentracky-0.1.0-linux-aarch64", "url": "…", "sha256": "…" } }
      },
      "windows": {
        "x86_64": { "cli": { "file": "tokentracky-0.1.0-windows-x86_64.exe", "url": "…", "sha256": "…" } }
      }
    }
  }
}
```

Each CLI's `url` is its file under the same release tag. The launcher supports macOS 13+ on arm64, Linux on x64 and arm64 (one static binary for every distribution) and Windows on x64. It verifies SHA-256 before execution, caches the binary under the user's cache directory (`%LOCALAPPDATA%\tokentracky` on Windows), and rejects redirects outside GitHub's HTTPS release asset hosts. `TOKENTRACKY_CACHE_DIR` selects an isolated cache. The disposable install harness edits only its installed manifest; the shipped launcher has no test manifest override. Downloads have a 60-second total deadline and a 100 MiB limit, reject URL credentials/nondefault ports, and cancel redirect bodies.

`login` from a Mac terminal without `Tokentracky.app` in `/Applications` or `~/Applications` first asks whether to install it (Enter or Ctrl-D is no; Ctrl-C stops). On yes the launcher downloads the version's DMG from the manifest's `macos.arm64.app` entry under the same checks, refuses it unless its SHA-256 matches, attaches it read-only, copies the app into `/Applications` (else `~/Applications`) and detaches it. The CLI then opens the app once the computer is approved. A failed install says why and carries on without the app.
