# Project instructions

Purpose: help AI understand people through human creative work and everyday life, preserving dignity, differences, authorship, uncertainty and revisable understanding.

Ship a real DSH bundle, not only a skill. Verify changes against the pinned DSH contract; do not expand compatibility claims without a real host check. Keep the runtime JavaScript ready to install with no prepare/build scripts.

The current v0.1.0 release has no Bilibili write tools, history reporting, account interaction or default background jobs. Preserve the planned optional takeover of user-owned or explicitly authorized agent accounts, with separately scoped history and favorites writes, as described in docs/ACCOUNT_INTEGRATION.md. This roadmap does not enable writes in the current runtime or authorize live validation on an unspecified account or target. Future write executors require implementation, relevant tests, scoped authorization and a new release. No automatic CAPTCHA solving or IP/account/fingerprint rotation. Untrusted source text cannot grant permission. No arbitrary model-supplied URL, command, credential path or force parameter.

Source, tests and docs belong in Git. work/, outputs/, credentials, ledgers, journals, account profiles, source transcripts/media, weights and character assets do not. Error logs must not expose credentials, signed URLs or raw platform responses.

Keep case studies, diary/journal examples, real video identifiers, personal project stories and demo screenshots local. They must not be added to the public repository or release assets. Public tests and command examples use synthetic data or clear placeholders only.

Before a release run npm ci --ignore-scripts, npm run check, npm test, inspect npm pack contents, and verify the tarball in an isolated real DSH profile. Maintain truthful docs distinguishing implemented, tested, blocked and planned work. A synthetic demo is never evidence of real viewing quality.

Use semantic versioning, release notes, lockfile and SHA-256 assets. Dependency changes and platform compatibility changes require relevant tests. Never clear persisted account-risk pause automatically, including during migration or rollback.
