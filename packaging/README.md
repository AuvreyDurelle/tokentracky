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
      }}
    }
  }
}
```

The launcher supports macOS 13+ on arm64 only. It verifies SHA-256 before execution, caches the binary under the user's cache directory, and rejects redirects outside GitHub's HTTPS release asset hosts. `TOKENTRACKY_CACHE_DIR` selects an isolated cache. The disposable install harness edits only its installed manifest; the shipped launcher has no test manifest override. Downloads have a 60-second total deadline and a 100 MiB limit, reject URL credentials/nondefault ports, and cancel redirect bodies.
