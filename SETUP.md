# Setup — connecting Mason's Trade

Everything in this repo is built and tested. What remains is connecting it to real accounts.
Work through this in order; each step depends on the one before.

Budget about an hour, most of it waiting for DNS.

---

## What you need before you start

| Thing | Where it comes from | Used for |
|---|---|---|
| A domain | Any registrar | The sending address, and SPF/DKIM/DMARC |
| A Resend account | resend.com — free tier is fine to start | Sending email |
| A Telegram account | The operator's phone | Receiving trades from him |
| A Cloudflare account | dash.cloudflare.com | Hosting the Worker and database |

You cannot skip the domain. Bulk email from a free Gmail address goes straight to spam, and no
provider will let you authenticate as one.

---

## Step 1 — Domain and email provider

1. Buy the domain if you haven't. Anything sensible; it appears in every email's From address.
2. In Resend, go to **Domains → Add Domain** and enter it.
3. Resend gives you DNS records — typically SPF (`TXT`), DKIM (`TXT` or `CNAME`), and a DMARC
   record. **Add all of them at your registrar.** Verification usually takes minutes but can take
   a few hours.
4. Wait until Resend shows the domain as **Verified**. Do not continue until it does — sending
   from an unverified domain damages the domain's reputation from the very first email, and that
   is hard to undo.
5. Create an API key: **API Keys → Create**. Copy it; you only see it once.

Then update `wrangler.toml`:

```toml
SITE_ORIGIN = "https://yourdomain.com"
FROM_EMAIL = "Mason's Trade <noreply@yourdomain.com>"
TEST_INBOX = "your-own-address@example.com"
```

`TEST_INBOX` is where **every** email goes while `DRY_RUN` is on. Set it to an inbox you can
actually check — nothing will reach you until you do.

---

## Step 2 — Telegram bot

1. On any Telegram account, message **@BotFather** and send `/newbot`. Follow the prompts.
2. It replies with a token like `1234567890:AAxx...`. Keep it — it is a password.
3. Now get **the operator's** chat ID. He must message the bot first (Telegram won't let a bot
   start a conversation). Have him send it anything — "hi" is fine. Then run:

   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```

   Find `result[0].message.chat.id` in the response. That number is `OPERATOR_CHAT_ID`.

**This must be the operator's own chat ID, not yours.** It is the allowlist that stops anyone
else who finds the bot from mailing the entire subscriber list.

4. Generate a webhook secret — any random string:

   ```bash
   openssl rand -hex 32
   ```

---

## Step 3 — Cloudflare

If you are using **a different Cloudflare account** than the one this was built on, create your
own database and replace the id:

```bash
npx wrangler d1 create masons-trade
```

Copy the printed `database_id` into `wrangler.toml` under `[[d1_databases]]`, replacing the
existing one. If you're using the same account, leave it alone.

Apply the schema:

```bash
npm run migrate:remote
```

Set the four secrets. These are never committed — `wrangler` stores them encrypted:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OPERATOR_CHAT_ID
```

For local development instead, copy `.dev.vars.example` to `.dev.vars` and fill it in.

---

## Step 4 — Deploy

```bash
npm install
npm test          # should be 158 passing
npm run typecheck # should be silent
npm run deploy
```

Wrangler prints your Worker URL, something like
`https://masons-trade.<your-subdomain>.workers.dev`. Keep it; the next two steps need it.

---

## Step 5 — Register the Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://masons-trade.<your-subdomain>.workers.dev/telegram/webhook","secret_token":"<YOUR_WEBHOOK_SECRET>"}'
```

Expect `{"ok":true,"result":true,"description":"Webhook was set"}`.

---

## Step 6 — Point the site form at the Worker

In `site/index.html`, find:

```js
const ENDPOINT = 'https://masons-trade.<your-subdomain>.workers.dev/subscribe';
```

Replace it with your real Worker URL. Then copy that file into the live site — or, if the site
already exists elsewhere, copy across just the form markup, the `.form-error` CSS rule, and the
script block. **Nothing else in that file should change**; the styling is the site's own.

---

## Step 7 — Test it end to end, with DRY_RUN still on

`DRY_RUN = "true"` means every email goes to `TEST_INBOX` and nobody real is contacted. Verify all
of this before turning it off:

1. **Signup.** Submit the form. An "application under review" email should arrive at `TEST_INBOX`.
2. **A bad address.** Try `someone@thisdomaindoesnotexist.invalid`. You should see an inline error
   on the page, not a success message.
3. **Approval.** Rather than waiting 30 hours, age the row and let the cron catch it:

   ```bash
   npx wrangler d1 execute masons-trade --remote --command "UPDATE subscribers SET created_at = created_at - 200000000"
   ```

   Within 15 minutes the "approved" email should arrive.
4. **A voice note.** Have the operator send one to the bot — e.g. *"Euro dollar buy at 1.0850,
   take profit 1.0920, stop loss 1.0820."* The bot should reply with a read-back and two buttons
   on separate rows.
5. **Have him navigate it with VoiceOver himself.** This is the step worth not skipping. Everything
   about the bot's output was built for his screen reader, and he is the only person who can tell
   you whether it actually reads well.
6. **Tap Send.** The trade email should arrive at `TEST_INBOX`, and the bot should report
   `Sent 1. Failed 0.`
7. **Unsubscribe.** Click the link in any email. It should show a confirm button, and only remove
   you after you press it.

---

## Step 8 — Going live

**Do this last, and do the first item or the rest doesn't matter.**

### Required: close the open webhook risk

`POST /webhooks/email` currently accepts unauthenticated requests. Anyone who finds the URL could
mark any address bounced or unsubscribed and quietly empty your list. This was accepted while
nothing was live.

There is a failsafe: **`bounce.ts` returns `501` on every request whenever `DRY_RUN` is not
`"true"`.** So the moment you go live, bounce processing stops working rather than accepting
forged requests. That is intentional — it fails loudly instead of silently.

To close it: add a `RESEND_WEBHOOK_SECRET` secret and verify Resend's Svix signature headers
(`svix-id`, `svix-timestamp`, `svix-signature`) at the top of `src/routes/bounce.ts`, rejecting
anything that fails. Then remove the `DRY_RUN` guard. Resend gives you the signing secret when you
create the webhook.

### Then

1. In Resend, add a webhook pointing at
   `https://your-worker-url/webhooks/email`, subscribed to bounce and complaint events.
2. Set `DRY_RUN = "false"` in `wrangler.toml`.
3. `npm run deploy`.
4. Send one real trade to yourself as the only approved subscriber before letting anyone else in.

---

## Things worth knowing

**Email deliverability is the fragile part.** Trading-signal content is a category providers watch
closely. Mailchimp flags "online trading and stock market related content" for additional scrutiny;
Resend's policy prohibits adjacent categories. Nothing here is banned outright, but an account
termination takes the subscriber list with it. If you outgrow Resend or want to de-risk, everything
sends through one function — `sendBatch()` in `src/email/send.ts` — and Amazon SES is the
content-neutral alternative. Nothing else in the codebase names a provider.

**There is no confirmation email by design.** Signup goes straight to "under review". That was a
deliberate choice for a frictionless signup, and it means four things carry the weight instead: MX
validation, a honeypot field, IP rate limiting, and removing an address on its *first* hard bounce.
Don't weaken any of them without understanding that.

**MX validation is coarser than it sounds.** It proves a domain can receive mail, not that the
address was typed right. Popular typo domains are often registered with working mail servers —
`gmial.com` has a live MX record — so some undeliverable addresses will get in regardless.
First-bounce pruning is what actually keeps the list clean.

**Whisper mishears predictably.** It writes "buy" as "by" and "EURUSD" as "Eurodollar"; the parser
handles both. If the operator finds a phrasing that consistently fails, the fix belongs in
`src/trade/pairs.ts` (aliases) or `src/trade/parse.ts` (labels) — and add a test with his actual
transcript, because guessed test fixtures are exactly what hid these bugs the first time.

**When the parser refuses, it names the field it couldn't read.** That is intentional. It never
guesses a price, because a wrong stop-loss reaching the whole list is worse than asking him to
record again.

---

## If something breaks

```bash
npx wrangler tail                                    # live Worker logs
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"   # webhook status and last error
npx wrangler d1 execute masons-trade --remote --command "SELECT status, COUNT(*) FROM subscribers GROUP BY status"
```

Bot silent? Check `getWebhookInfo` for `last_error_message`, and confirm `OPERATOR_CHAT_ID`
matches the account actually sending the voice notes.

Emails not arriving? Confirm the Resend domain still shows Verified, and remember `DRY_RUN`
redirects everything to `TEST_INBOX`.
