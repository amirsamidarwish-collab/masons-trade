# Mason's Trade — automation backend

Backend for a Forex/commodities/indexes signal list. Two jobs: onboard email signups from
the marketing site, and broadcast trades that the operator posts from his phone.

The marketing site is built and hosted separately by its owner. This repo is backend only
and connects to the site through one endpoint URL.

**Full design:** [`docs/superpowers/specs/2026-08-03-masons-trade-automation-design.md`](docs/superpowers/specs/2026-08-03-masons-trade-automation-design.md).
Read it before changing behaviour — it records *why* the non-obvious decisions were made.

## Stack

Cloudflare Worker + D1 + Cron Triggers, deployed with `wrangler deploy`. Telegram bot for
trade input, Whisper on Workers AI for transcription, Resend (dev) / Amazon SES (prod) for
email. Tests are Vitest against the local Workers runtime.

## Non-negotiables

These are the things a future change is most likely to break. Do not "simplify" them.

**The operator is nearly blind — iPhone with VoiceOver, and writing is hard for him.**
The entire trade-input path exists in its current shape because of this:

- Voice note is the primary input. Typed input is a fallback, never a replacement.
- Bot replies are plain text, **never audio** — VoiceOver already speaks text, so audio
  would make him slower, not faster.
- **No emoji and no markdown emphasis in bot messages.** VoiceOver reads them aloud as
  noise. Short lines. Important numbers first.
- Button labels are self-describing: "Send to 143 subscribers", not "Send". VoiceOver reads
  the label and nothing else.
- Confirm and cancel buttons go on **separate keyboard rows**, so a mistap cannot send.

**Sending safety:**

- The parser refuses low-confidence input and names the field it could not read. It never
  guesses a number. A misheard stop-loss reaching the whole list is the failure that hurts.
- Every broadcast passes through the read-back-and-confirm step. Nothing sends unprompted.
- `send_log` is written before sending. Sends must stay idempotent and resumable.
- The Telegram webhook checks the secret-token header **and** the chat ID allowlist. Without
  both, anyone who finds the bot can mail the list.

**Deliverability** (this is how the sending domain stays alive):

- Double opt-in via the confirmation link inside the "under review" email. Unconfirmed
  addresses never receive a trade.
- `List-Unsubscribe` headers on every send. Bounce/complaint webhooks mark subscribers.
- Emails are semantic text, never image-based layouts.
- All sending goes through the single `sendEmail()` module so the provider can be swapped
  quickly — the content category carries real AUP risk. See the spec.

**The site's existing visual styling is not to be modified.** Wire up the form, leave the
design alone.

## Secrets

Never committed. Set with `wrangler secret put`: Telegram bot token, Telegram webhook
secret, operator chat ID, email provider API key.

## Conventions

- `DRY_RUN` routes all sends to one test inbox. Use it for any end-to-end testing.
- Test time-dependent logic with injected time. Never sleep in a test.
