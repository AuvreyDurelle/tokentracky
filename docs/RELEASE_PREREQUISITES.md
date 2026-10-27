# Release prerequisites

The initial native target is Apple Silicon on macOS 13+. Ad-hoc signed releases require **Open Anyway** on first launch and are not notarized. Developer ID distribution requires separate Apple credentials and candidate verification. Windows, Linux and Intel Mac distribution are deferred. See [Mac releases](MAC_RELEASE.md) and [distribution](DISTRIBUTION.md) for the implemented workflows.

Repository checks establish code behavior on synthetic inputs. They do not establish that hosting, OAuth providers, signing credentials, public artifacts or clean-machine installation have been verified for a release candidate.

## Before publishing source

- Review the exact public tree, package contents, dependency notices and secret-scan results. Plans, mockups, runbooks and raw diagnostics remain local ignored archives.
- Choose the public history deliberately. Earlier commits still contain removed operational records, research, personal paths and author metadata. An ordinary cleanup PR does not erase these, other branches, old PR diffs or cached GitHub views. Review every branch/tag intended for publication; do not export local tool/checkpoint refs.
- Supply `TOKENTRACKY_MODERATION_POLICY` through private server configuration before deploying this revision. Hosted startup and operator commands require the complete validated policy. Public test values are synthetic; preserve the deployment's reviewed values privately.
- Preserve the MIT licence, LiteLLM notice and Lucide/Feather icon notices in distributed artifacts. Review privacy and hosted-service terms for the intended launch jurisdiction.

## Native candidate gates

- Keep formatting, clippy, generated-type verification, Rust tests, TypeScript lint/typecheck/tests, PostgreSQL migration/replay/access-isolation tests, web/server builds and packaging harnesses passing on the exact candidate commit.
- Rerun `cycle_budget` on the 200,000-request workload. The targets remain ≤50 ms CPU for an unchanged cycle and ≤500 ms when one session grows. A previously measured growing-session cycle of about 1.3 seconds missed the target; no later source cleanup establishes that this gate passed.
- Use `scripts/native_runtime.py` and `scripts/soak-native.sh` for the final candidate. Require a complete 24-hour soak, ≤40 MiB settled closed-window memory including attributed helpers, and ≤3 MiB difference between the first and last four settled readings. Restart after runtime changes. Keep raw diagnostics privately and publish only sanitized measurements.
- Exercise short, long and repeated sleep/wake, offline wake, and wake during synchronization on a machine that can safely undergo those actions. Unchanged wake must avoid duplicate uploads; fresh data must refresh and publish correctly.
- On clean supported Macs, verify quarantined download, Open Anyway, Finder-first launch, real hosted sign-in and linking, login items, CLI/app single-writer locking, shared owner-only credentials, install/update/uninstall and preservation of local data.
- Verify the actual Finder DMG layout on a GUI release runner. Stub-based packaging tests do not establish the layout or permission behavior.
- Configure the protected `macos-release` environment and real updater key/HTTPS feed. Test two real versions, signature/version mismatch rejection, interrupted download, Later reminders, channel selection and signed forward recovery. Developer ID additionally requires accepted notarization and stapling checks. CI success alone does not satisfy these runtime gates.

## Hosted candidate gates

- Verify production DNS/TLS, narrow CSP, proxy/gateway identity, database TLS and least-privilege schema access, and configured Supabase origins/redirects. Public hosts in the deployment configs are observable routing configuration.
- Enable only sign-in providers actually configured in Supabase. Verify GitHub/Google OAuth, email sign-up and password reset, SMTP delivery, and PKCE callbacks on staging. Reissue legacy implicit-flow links after the PKCE migration.
- Run fresh migrations and upgrades, including fixed-sharing migration `0010` and counter-integrity migration `0015`. PostgreSQL 15+ is required; CI uses 17. Previously narrower publications require reconnecting after fixed sharing.
- Test local-to-hosted linking and uploads, retries/lost responses, generation resets, source exclusions, multiple computers, revocation, account deletion and public-cache expiry. Keep the limitations in [accounting publication scope](ACCOUNTING_PUBLICATION_SCOPE.md) visible.
- Confirm aggregate-only logs, monitoring, moderation queue/audit ownership, backup/restore drills, retention and incident/rollback procedures in private operations records. `npx tsx scripts/moderation.ts counter-audit` provides count-only integrity diagnostics.
- Treat client-reported usage as unverified. Moderation and deduplication do not prove real spending, independent requests, or one person per account. This accepted architectural limit remains after the security fixes.

## Publication

Generate versioned native artifacts, checksums, release notes and dependency/provenance records from the same verified commit. The npm launcher requires an already-public verified native manifest; Homebrew uses the same immutable artifact bytes. Verify that all announced installation links work before announcing availability. This checklist does not authorize deployment, package publication or a repository visibility change.
