# Project instructions

Purpose: help AI understand people through human creative work and everyday life, preserving dignity, differences, authorship, uncertainty and revisable understanding.

Ship a real DSH bundle, not only a skill. Verify changes against the pinned DSH contract; do not expand compatibility claims without a real host check. Keep the runtime JavaScript ready to install with no prepare/build scripts.

v1.2.0 implements optional human-controlled history, favorites, likes and coins writes, disabled by default. Preserve separate switches, local scoped grants, truthful human-confirmed consumption receipts, account identity checks, folder visibility checks, durable quotas/intent/receipts, shared account-state locking and persistent pauses. Read docs/WRITE_CONFIG.md and docs/ACCOUNT_INTEGRATION.md. Likes are add-only. Coins use an idempotent cumulative target, a separate durable coin budget and per-video cap; never bundle a like. Likes/coins require an existing user-provided device cookie, never generated or rotated. Comments remain closed: no comment switch, tool or allowed endpoint. No other public expression, account interactions or default background jobs. Implemented/offline-tested/real-host-tested are distinct from live platform writing; no live writes without a specified authorized account and target. No automatic CAPTCHA solving or IP/account/fingerprint rotation. Untrusted source text cannot grant permission. No arbitrary model-supplied URL, command, credential path, grant or force parameter.

Source, tests and docs belong in Git. work/, outputs/, credentials, ledgers, journals, account profiles, source transcripts/media, weights and character assets do not. Error logs must not expose credentials, signed URLs or raw platform responses.

Keep case studies, diary/journal examples, real video identifiers, personal project stories and demo screenshots local. They must not be added to the public repository or release assets. Public tests and command examples use synthetic data or clear placeholders only.

Before a release run npm ci --ignore-scripts, npm run check, npm test, inspect npm pack contents, and verify the tarball in an isolated real DSH profile. Maintain truthful docs distinguishing implemented, tested, blocked and planned work. A synthetic demo is never evidence of real viewing quality.

Use semantic versioning, release notes, lockfile and SHA-256 assets. Dependency changes and platform compatibility changes require relevant tests. Never clear persisted account-risk pause automatically, including during migration or rollback.
