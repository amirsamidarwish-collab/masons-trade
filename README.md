# Mason's Trade — automation backend

Backend for a Forex / commodities / indexes signal list. It does two jobs:

1. **Onboarding.** A visitor submits their email on the marketing site. They immediately get an
   "application under review" email, and 30 hours later an "approved" email. From then on they
   receive trades.
2. **Broadcast.** The operator sends a **voice note** to a Telegram bot. It's transcribed, parsed
   into a trade, read back to him for confirmation, and — only after he taps Send — emailed to
   every approved subscriber.

The operator is nearly blind and uses VoiceOver, which is why the input path is voice-first and
why the bot's replies are plain unstyled text. That constraint drives most of the non-obvious
design decisions in this repo. **Read [`CLAUDE.md`](CLAUDE.md) before changing anything** — it
records what must not be "simplified" and why.

## Connecting it up

**→ [`SETUP.md`](SETUP.md)** is the step-by-step guide: domain, email provider, Telegram bot,
deployment, and wiring the site form. Start there.

## Stack

Cloudflare Worker + D1 + Cron Triggers. Telegram Bot API for input, Whisper on Workers AI for
transcription, Resend for email (swappable — see below). Vitest against the real local Workers
runtime.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | Hono app, route mounting, the scheduled (cron) handler |
| `src/routes/` | `subscribe`, `unsubscribe`, `bounce` (provider webhook), `telegram` |
| `src/trade/` | Transcript parsing — spoken numbers, currency pairs, trade extraction |
| `src/telegram/` | Bot transport and VoiceOver-safe message formatting |
| `src/email/` | `send.ts` is the **only** file that names an email provider; templates alongside |
| `src/broadcast.ts` | Chunked, resumable send with a per-recipient log |
| `src/cron.ts` | 30-hour approval sweep + retry sweep for stalled broadcasts |
| `migrations/` | D1 schema |
| `site/index.html` | Copy of the marketing page, with the signup form wired up |
| `docs/` | Design spec, implementation plan, email copy drafts |

## Commands

```bash
npm install
npm test          # full suite against the local Workers runtime
npm run typecheck # tsc --noEmit - a required gate, vitest does not type-check
npm run dev       # local Worker on :8787
npm run deploy    # wrangler deploy
```

## Two things to know before you touch it

**`DRY_RUN` is a safety switch, and it's on.** While `DRY_RUN = "true"` in `wrangler.toml`, every
email is redirected to `TEST_INBOX` regardless of the real recipient. You can exercise the entire
system end to end without mailing a single subscriber. Turning it off is a deliberate go-live step.

**Swapping email provider is a one-file change.** Everything sends through `sendBatch()` in
`src/email/send.ts`. Nothing else names Resend. This matters because trading-signal content draws
provider scrutiny — Mailchimp flags it for review, Resend's AUP prohibits adjacent categories — so
being able to move to Amazon SES in an afternoon is a deliberate design property, not an accident.
