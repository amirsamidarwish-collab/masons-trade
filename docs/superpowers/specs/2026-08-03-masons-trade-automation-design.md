# Mason's Trade — Signup & Broadcast Automation

**Date:** 2026-08-03
**Status:** Approved design, not yet implemented

## Problem

A single-page site ("Mason's Trade") collects email addresses from visitors who want to
receive market predictions for Forex, commodities and indexes. Two things need to happen
automatically:

1. **Onboarding** — a new signup is told their application is under review, then approved
   30 hours later.
2. **Broadcast** — the operator posts a trade from his phone and it reaches every approved
   subscriber as an email.

The site itself is built and hosted separately by the site owner. This project is the
backend only; it is hosting-agnostic and connects to the site via a single endpoint URL.

## Critical constraint: the operator is nearly blind

The operator uses an **iPhone with VoiceOver** and finds writing difficult. This is the
single most important design driver for the trade-input side of the system. Every decision
below marked *[a11y]* exists because of it and must not be "simplified" away.

- *[a11y]* Trade input is **voice-first**. He records a Telegram voice note; the system
  transcribes it. Typed input remains as a fallback, never as the primary path.
- *[a11y]* Confirmations are **plain text, not audio**. VoiceOver already speaks text
  aloud; an audio reply would force him to locate and play it. Text is faster for him.
- *[a11y]* Bot replies contain **no emoji and no markdown emphasis characters** — VoiceOver
  announces these as noise ("check mark button", "asterisk"). Short lines. Most important
  numbers first.
- *[a11y]* Button labels are fully self-describing, because VoiceOver reads the label and
  nothing else. "Send to 143 subscribers", not "Send". "Cancel, do not send", not "Cancel".
- *[a11y]* Destructive and confirming buttons sit on **separate keyboard rows**, never side
  by side, so a mistap cannot trigger a send.

## Architecture

One Cloudflare Worker, one D1 database, one repository, deployed with `wrangler deploy`.
No servers, no always-on process.

```
Site form ──POST──> /subscribe ─┐
                                │
Subscriber ──GET──> /confirm    ├──> D1 (subscribers, trades, send_log)
Subscriber ──GET──> /unsubscribe│
                                │
Operator ──voice──> Telegram ───┴──> /telegram/webhook ──> Workers AI (Whisper)
                                                              │
Cron (*/15) ──> approvals sweep                               v
                                                        Email provider
```

### Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/subscribe` | POST | Public. Accepts `{email}` from the site form. CORS-enabled. |
| `/confirm` | GET | Double opt-in confirmation link, token in query string. |
| `/unsubscribe` | GET | One-click unsubscribe, token in query string. |
| `/telegram/webhook` | POST | Telegram updates. Secret-token header + chat ID allowlist. |
| cron `*/15 * * * *` | — | Approves subscribers past their 30-hour window. |

### Data model

**`subscribers`** — `id`, `email` (unique, lowercased), `status`, `confirm_token`,
`unsub_token`, `created_at`, `confirmed_at`, `approved_at`, `ip_hash`.

Status transitions:

```
pending_confirm ──confirm link──> pending_approval ──cron, +30h──> approved
       │                                 │                             │
       └─────────────────────────────────┴──> unsubscribed / bounced <─┘
```

**`trades`** — `id`, parsed fields (`pair`, `direction`, `entry`, `take_profit`,
`stop_loss`, `note`), `transcript` (raw Whisper output, kept for debugging mishears),
`rendered_html`, `sent_at`, `recipient_count`.

**`send_log`** — one row per (`trade_id`, `subscriber_id`) with status. This is what makes
sending idempotent and resumable.

## Flow 1 — signup and approval

1. Site form POSTs to `/subscribe`. The Worker validates the address, rate-limits by IP,
   and inserts the subscriber as `pending_confirm`. A duplicate address returns the same
   success response as a new one (no account enumeration).
2. Email 1, "your application is under review", is sent immediately. **The confirmation
   link lives inside this email**, worded as part of the review process: confirm this
   address so we can contact you about your application. This is a genuine double opt-in
   without feeling like a hoop, and it is the main protection for the sending domain.
3. The cron sweep runs every 15 minutes and finds subscribers who are confirmed and whose
   `created_at` is more than 30 hours ago. It flips them to `approved` and sends email 2,
   "approved".
4. The 30-hour clock starts at signup, not at confirmation. Someone who confirms late is
   picked up on the next tick.

**Unconfirmed addresses never receive a trade.**

## Flow 2 — trade broadcast

1. Operator sends a voice note to the Telegram bot.
2. The webhook verifies Telegram's secret-token header and checks the sender's chat ID
   against an allowlist. Anything else is dropped silently. Without this, anyone who finds
   the bot can mail the entire list.
3. The audio is transcribed with **Whisper on Cloudflare Workers AI** — same account, no
   new vendor.
4. The transcript is parsed into pair, direction, entry, take-profit and stop-loss. The
   parser must handle spoken forms: `"one point zero eight five zero"` → `1.0850`,
   `"euro dollar"` → `EURUSD`, `"cable"` → `GBPUSD`, `"gold"` → `XAUUSD`.
   **If the parser is not confident, it refuses and says exactly which field it could not
   read.** It never guesses. A misheard digit that reaches the list is the failure mode
   that actually causes harm.
5. The bot replies with a text read-back and two buttons on separate rows:

   ```
   Euro Dollar. Buy.
   Entry 1.0850
   Take profit 1.0920
   Stop loss 1.0820

   [ Send to 143 subscribers ]
   [ Cancel, do not send     ]
   ```

6. The button callback carries a **one-time token bound to that draft**, so an old message
   cannot be re-tapped later to re-send a stale trade.
7. On confirm, approved subscribers are read from D1 and sent in **batches of 100** via the
   provider's batch endpoint. Each recipient gets their own unsubscribe link — no shared
   BCC. Each batch writes to `send_log` before sending, so a crashed run resumes with only
   the un-sent recipients and nobody receives a duplicate.
8. The bot reports the outcome: `Sent 143. Failed 2.`

## Email delivery

**Provider risk.** This content category draws scrutiny. Verified 2026-08-03:

- **Mailchimp** — cryptocurrency outright prohibited; "online trading, day trading tips,
  and stock market related content" is subject to additional scrutiny.
- **Resend** — no forex clause, but prohibits "get rich quick opportunities" and reserves a
  catch-all for content that harms their deliverability reputation.

Neither is a flat ban, but an account termination takes the list with it.

**Mitigation.** All sending goes through a single `sendEmail()` module. Resend is used for
development and testing; **Amazon SES is the expected production sender** (cheaper at
volume, most content-neutral, no daily cap). Swapping providers must be a change to one
module, not a rewrite. Resend's free tier caps at 100 emails/day, which a real list exceeds
immediately.

**Reputation hygiene** — non-negotiable, this is how a sending domain survives:

- Own domain with SPF, DKIM and DMARC configured.
- Double opt-in (see Flow 1).
- `List-Unsubscribe` and `List-Unsubscribe-Post` headers on every send, so one-click
  unsubscribe works from Gmail's own UI.
- Bounce and complaint webhooks mark subscribers `bounced` / `unsubscribed` automatically.
- Emails built as real semantic text, never image-based layouts — required for screen
  readers, and preferred by spam filters.

## Site integration

The existing `masons-trade.html` fakes success: it hides the form and shows the confirmation
message regardless of what happened. It will be wired to the real endpoint with genuine
loading, error and duplicate states. **The existing visual styling is not to be changed.**

## Error handling

- Invalid email → 400 with a field-level message the form displays inline.
- Duplicate email → 200, same response as success.
- Rate limit exceeded → 429.
- Provider failure during a batch → that batch's rows stay un-sent in `send_log`; the run
  is retried and resumes where it stopped.
- Transcription failure → the bot says it could not hear the message and asks him to resend.
  It never proceeds on a partial transcript.

## Testing

Vitest against the local Workers runtime with a real local D1.

- Parser unit tests, including spoken-number and spoken-pair forms, and the refusal cases.
- The 30-hour approval logic tested with **injected time**, never by waiting.
- Resumability tested by killing a send mid-batch and asserting no duplicates and no gaps.
- Webhook rejection tested: wrong secret token, wrong chat ID, replayed callback token.
- A `DRY_RUN` flag routes every send to a single test inbox so the full flow can be
  exercised without touching a real subscriber.

## Secrets

Held in `wrangler secret`, never committed: Telegram bot token, Telegram webhook secret,
operator chat ID, email provider API key.

## Out of scope

- Any admin UI. If manual review of applicants is wanted later, it is added then.
- WhatsApp input. Trade parsing is kept separate from the Telegram transport, so adding it
  later is one new route rather than a rewrite.
- Payments, tiers, or subscriber segmentation.
