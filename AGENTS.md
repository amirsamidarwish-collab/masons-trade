# Mason's Trade — automation backend

All project instructions live in [`CLAUDE.md`](CLAUDE.md). Read that file first — it is the
single source of truth and is kept up to date.

The full design is in
[`docs/superpowers/specs/2026-08-03-masons-trade-automation-design.md`](docs/superpowers/specs/2026-08-03-masons-trade-automation-design.md).

Short version: Cloudflare Worker + D1 backend for an email signal list. The operator is
nearly blind (iPhone + VoiceOver), which drives the whole trade-input design — voice notes
in, plain text out, no emoji, self-describing button labels. Broadcasts must stay idempotent
and always pass through an explicit confirm step. See `CLAUDE.md` for the full list of
non-negotiables before changing anything.
