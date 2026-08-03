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
- `send_log` is written before sending: each chunk is logged `pending` before the provider
  is called, then flipped to `sent` or `failed` after. A crash between those two writes
  leaves the row `pending`, and the recipient query retries anything short of `sent` -
  including `pending` - so a crashed run resumes instead of stranding that recipient. Sends
  must stay idempotent and resumable.
- The Telegram webhook checks the secret-token header **and** the chat ID allowlist. Without
  both, anyone who finds the bot can mail the list.

**Deliverability** (this is how the sending domain stays alive):

- **There is no double opt-in** — an explicit owner decision, not an oversight. Do not add
  one back without asking. Because it is absent, these are load-bearing: MX validation at
  signup, honeypot field, IP rate limiting, and pruning a subscriber on their *first* hard
  bounce. They are the only thing keeping dead addresses off the list.
  MX validation is coarse: it only proves a domain can receive mail, not that the address
  was typed correctly. Typo domains are frequently registered with working mail servers
  (`gmial.com` has a live MX record as of this writing) and will still pass, so the list will
  keep accumulating some undeliverable addresses regardless. First-bounce pruning carries
  more of the deliverability weight than the original design implied.
- `List-Unsubscribe` headers on every send. Bounce/complaint webhooks mark subscribers.
- **KNOWN OPEN RISK — `POST /webhooks/email` is unauthenticated.** Anyone who finds the URL can
  mark any address `bounced` or `unsubscribed` and silently empty the list. Accepted deliberately
  on 2026-08-03 only because nothing is live yet (no domain, no real subscribers).
  **This must be closed before the first real send** — see the go-live gate in Task 14 of the
  plan. Fix is Svix signature verification against a `RESEND_WEBHOOK_SECRET`. Do not treat this
  as settled just because the code has shipped this way for a while.
  There is a code-level failsafe, not just this paragraph: `bounce.ts` returns `501` on every
  request whenever `DRY_RUN` is not `'true'`, so going live without signature verification fails
  loudly (webhook calls start erroring) instead of silently emptying the list.
- A previously `unsubscribed` or `bounced` address that signs up again is reset to
  `pending_approval` (fresh token, fresh `created_at`, `approved_at` cleared) and sent the
  under-review email again, exactly like a new signup. An address still `pending_approval`
  or `approved` is left untouched. The response body is identical in every case -
  enumeration resistance still holds even though the address can now rejoin.
- Unsubscribe is split by verb on purpose: `GET` renders a confirm button and mutates nothing,
  `POST` performs the removal. Mail scanners prefetch links, and a mutating GET lets them
  unsubscribe real people. Gmail's one-click already POSTs, so it stays instant.
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
