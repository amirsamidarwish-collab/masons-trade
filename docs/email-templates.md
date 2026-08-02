# Email templates — first drafts

Three emails, drafted to be edited. The site owner owns the final wording.

Deliberately plain: no performance claims, no urgency language, no promises about returns.
That is partly a legal question for the owner, and partly deliverability — spam filters
score exactly that vocabulary in exactly this content category.

Every email ends with the shared footer below. Every email is semantic text, never an
image-based layout — required for screen readers, and preferred by spam filters.

---

## 1. Under review

Sent immediately on signup.

**Subject:** Your Mason's Trade application

> We've received your request for access to Mason's Trade.
>
> Applications are reviewed before access is granted. You'll hear back from us within
> roughly 30 hours — no action is needed from you in the meantime.
>
> Mason's Trade

---

## 2. Approved

Sent by the cron sweep, 30 hours after signup.

**Subject:** Your Mason's Trade access is approved

> Your application has been approved.
>
> You'll now receive our market predictions for Forex, commodities and indexes as they're
> published. Nothing else is required from you.
>
> Mason's Trade

---

## 3. Trade broadcast

Sent to every approved subscriber when the operator confirms a trade.

**Subject:** `{PAIR} — {DIRECTION}` — e.g. `EURUSD — Buy`

> **{PAIR_DISPLAY} — {DIRECTION}**
>
> Entry: {ENTRY}
> Take profit: {TAKE_PROFIT}
> Stop loss: {STOP_LOSS}
>
> {NOTE — omitted entirely when empty}
>
> Mason's Trade

Fields are laid out one per line rather than in a table: it reads correctly in every mail
client, degrades cleanly to plain text, and is read out sensibly by a screen reader.

---

## Shared footer

Appears on all three. The disclaimer is the wording already used on the site.

> The information provided does not constitute financial advice. We do not manage client
> funds or charge for outcomes. Each individual is responsible for their own trading
> decisions.
>
> You're receiving this because you requested access at masonstrade.com.
> [Unsubscribe]({UNSUBSCRIBE_URL})

The unsubscribe link is unique per subscriber and must appear on every send, alongside the
`List-Unsubscribe` header.
