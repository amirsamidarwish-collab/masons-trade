# Mason's Trade Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Cloudflare Worker backend that onboards email signups from the Mason's Trade site and broadcasts trades that the operator posts as Telegram voice notes.

**Architecture:** One Worker fronted by Hono handles four HTTP routes plus a 15-minute cron. D1 holds subscribers, trades and a per-recipient send log. Telegram voice notes are transcribed with Whisper on Workers AI, parsed into trade fields, read back to the operator for confirmation, then broadcast in idempotent batches of 100 through a single swappable `sendEmail` module.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, Workers AI (Whisper), Vitest with `@cloudflare/vitest-pool-workers`, Resend (dev) / Amazon SES (prod).

## Global Constraints

Read `CLAUDE.md` and `docs/superpowers/specs/2026-08-03-masons-trade-automation-design.md` before starting. These apply to **every** task:

- **The operator is nearly blind — iPhone + VoiceOver.** Voice note is the primary trade input; typed input is a fallback only.
- **No emoji and no markdown emphasis in any Telegram message.** Call `sendMessage` **without** `parse_mode` so Telegram renders plain text. VoiceOver reads `*` and emoji aloud as noise.
- **Bot replies are text, never audio.**
- **Button labels are self-describing:** `Send to 143 subscribers`, `Cancel, do not send`. Never bare `Send` / `Cancel`.
- **Confirm and cancel buttons go on separate `inline_keyboard` rows.** Never in the same row.
- **The parser never guesses.** Low confidence returns a refusal naming the missing field.
- **There is no double opt-in** — an owner decision. Do not add one. MX validation, honeypot, IP rate limiting and first-hard-bounce pruning are therefore mandatory.
- **Prices are stored and compared as `TEXT`, never as SQL `REAL`.** `1.0850` must not become `1.085`.
- **`List-Unsubscribe` and `List-Unsubscribe-Post` headers on every send.**
- **Never modify the visual styling in `site/index.html`.** Wire the form only.
- Test time-dependent logic with an injected `now: number`. Never sleep in a test.
- Secrets via `wrangler secret put`, never committed. Local dev secrets go in `.dev.vars` (gitignored).
- **`npx tsc --noEmit` must be clean before every commit**, alongside the tests. `vitest run`
  does not type-check, so a green suite proves nothing about types.
- **Typing traps in test files.** The example test snippets in this plan are a starting
  point, not verified TypeScript — apply these two rules when a snippet trips the type
  checker:
  - `afterEach(() => vi.restoreAllMocks())` returns a value where `void` is expected. Write
    it with a block body: `afterEach(() => { vi.restoreAllMocks(); });`
  - `vi.fn(async () => ...)` produces a mock whose `mock.calls` is typed `[]`, so indexing
    `calls[0][1]` fails. Declare fetch mocks with `stubFetch` from `tests/helpers.ts`
    (created in Task 3), which keeps `mock.calls` typed as `[string, RequestInit | undefined]`.

---

## File Structure

| File | Responsibility |
|---|---|
| `wrangler.toml` | Bindings, cron trigger, vars |
| `migrations/0001_init.sql` | Schema |
| `src/index.ts` | Hono app, route mounting, `scheduled` handler |
| `src/types.ts` | `Env` and shared domain types |
| `src/db/subscribers.ts` | Subscriber queries |
| `src/db/trades.ts` | Trade and send-log queries |
| `src/validate.ts` | Email syntax, MX lookup, rate limit |
| `src/email/send.ts` | `sendBatch()` — the only place a provider is named |
| `src/email/templates.ts` | Renders the three emails |
| `src/routes/subscribe.ts` | `POST /subscribe` |
| `src/routes/unsubscribe.ts` | `GET /unsubscribe` |
| `src/routes/bounce.ts` | `POST /webhooks/email` |
| `src/routes/telegram.ts` | `POST /telegram/webhook` |
| `src/telegram/api.ts` | Telegram HTTP calls |
| `src/telegram/format.ts` | VoiceOver-safe message and keyboard building |
| `src/trade/numbers.ts` | Spoken-number parsing |
| `src/trade/pairs.ts` | Spoken-pair parsing and display names |
| `src/trade/parse.ts` | Transcript to trade fields |
| `src/transcribe.ts` | Telegram audio to text via Workers AI |
| `src/broadcast.ts` | Batched, resumable send |
| `src/cron.ts` | 30-hour approval sweep |
| `site/index.html` | Form wiring (styling untouched) |

---

### Task 1: Scaffold, schema and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `migrations/0001_init.sql`, `src/types.ts`, `src/index.ts`, `tests/env.d.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Env` (bindings `DB: D1Database`, `AI: Ai`; vars `DRY_RUN`, `SITE_ORIGIN`, `FROM_EMAIL`, `TEST_INBOX`; secrets `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPERATOR_CHAT_ID`), and the default export `{ fetch, scheduled }`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "masons-trade",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "migrate:local": "wrangler d1 migrations apply masons-trade --local",
    "migrate:remote": "wrangler d1 migrations apply masons-trade --remote"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.1",
    "@cloudflare/workers-types": "^4.20240925.0",
    "typescript": "^5.6.0",
    "vitest": "~2.0.5",
    "wrangler": "^3.80.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create `wrangler.toml`**

`database_id` is filled in at Step 6.

```toml
name = "masons-trade"
main = "src/index.ts"
compatibility_date = "2026-08-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "masons-trade"
database_id = "PLACEHOLDER_REPLACED_IN_STEP_6"
migrations_dir = "migrations"

[ai]
binding = "AI"

# Request-level rate limit, enforced at the edge before the handler runs.
# The per-IP signup counter in D1 protects list quality; this protects cost,
# because requests that never insert a row (duplicates, bad domains) do not
# increment that counter.
[[unsafe.bindings]]
name = "SUBSCRIBE_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 20, period = 60 }

[triggers]
crons = ["*/15 * * * *"]

[vars]
DRY_RUN = "true"
SITE_ORIGIN = "https://masonstrade.com"
FROM_EMAIL = "Mason's Trade <noreply@masonstrade.com>"
TEST_INBOX = "set-me@example.com"
```

- [ ] **Step 4: Create `migrations/0001_init.sql`**

Prices are `TEXT` on purpose — see Global Constraints.

```sql
CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  unsub_token TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);
CREATE INDEX idx_subscribers_status ON subscribers (status);
CREATE INDEX idx_subscribers_sweep ON subscribers (status, created_at);
CREATE INDEX idx_subscribers_ip ON subscribers (ip_hash, created_at);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry TEXT NOT NULL,
  take_profit TEXT NOT NULL,
  stop_loss TEXT NOT NULL,
  note TEXT,
  transcript TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  draft_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  recipient_count INTEGER
);

CREATE TABLE send_log (
  trade_id INTEGER NOT NULL,
  subscriber_id INTEGER NOT NULL,
  chunk INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trade_id, subscriber_id)
);
CREATE INDEX idx_send_log_pending ON send_log (trade_id, status);
```

- [ ] **Step 5: Create `src/types.ts`**

```ts
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  AI: Ai;
  SUBSCRIBE_LIMITER: RateLimiter;
  DRY_RUN: string;
  SITE_ORIGIN: string;
  FROM_EMAIL: string;
  TEST_INBOX: string;
  RESEND_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPERATOR_CHAT_ID: string;
}

export type SubscriberStatus =
  | 'pending_approval'
  | 'approved'
  | 'unsubscribed'
  | 'bounced';

export interface Subscriber {
  id: number;
  email: string;
  status: SubscriberStatus;
  unsub_token: string;
  created_at: number;
  approved_at: number | null;
}

export interface Trade {
  pair: string;
  direction: 'Buy' | 'Sell';
  entry: string;
  take_profit: string;
  stop_loss: string;
  note: string | null;
}

export interface StoredTrade extends Trade {
  id: number;
  draft_token: string;
  status: 'draft' | 'sending' | 'sent' | 'cancelled';
}
```

- [ ] **Step 6: Create the D1 database and paste the id into `wrangler.toml`**

```bash
npx wrangler d1 create masons-trade
```

Copy the printed `database_id` over `PLACEHOLDER_REPLACED_IN_STEP_6`, then:

```bash
npm run migrate:local
```

Expected: `0001_init.sql` reported as applied.

- [ ] **Step 7: Create `vitest.config.ts`**

`readD1Migrations` reads the SQL files at config time and exposes them to tests as the
`TEST_MIGRATIONS` binding, so every test file can apply the real schema to its isolated
database.

```ts
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const migrations = await readD1Migrations('./migrations');

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
  },
});
```

- [ ] **Step 8: Declare the test environment types**

Without this, `env.DB` and `env.TEST_MIGRATIONS` are untyped in every test file in the
project. Create `tests/env.d.ts`:

```ts
import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

- [ ] **Step 9: Write the failing test**

Create `tests/health.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('health', () => {
  it('returns ok', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/health'),
      env as any,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

```bash
npx vitest run tests/health.test.ts
```

Expected: FAIL — `src/index.ts` has no default export yet.

- [ ] **Step 11: Write `src/index.ts`**

```ts
import { Hono } from 'hono';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Approval sweep is wired in Task 6.
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 12: Run the test to verify it passes**

```bash
npx vitest run tests/health.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "Scaffold Worker, D1 schema and test harness"
```

---

### Task 2: Email templates

**Files:**
- Create: `src/email/templates.ts`
- Test: `tests/templates.test.ts`

**Interfaces:**
- Consumes: `Trade`, `Env` from `src/types.ts`
- Produces:
  - `renderUnderReview(env: Env, unsubUrl: string): { subject: string; html: string; text: string }`
  - `renderApproved(env: Env, unsubUrl: string): { subject: string; html: string; text: string }`
  - `renderTrade(env: Env, trade: Trade, unsubUrl: string): { subject: string; html: string; text: string }`

Copy comes from `docs/email-templates.md`. Do not invent performance claims.

- [ ] **Step 1: Write the failing test**

Create `tests/templates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderApproved, renderTrade, renderUnderReview } from '../src/email/templates';
import type { Env, Trade } from '../src/types';

const env = { SITE_ORIGIN: 'https://masonstrade.com' } as Env;
const UNSUB = 'https://api.masonstrade.com/unsubscribe?t=abc';

const trade: Trade = {
  pair: 'EURUSD',
  direction: 'Buy',
  entry: '1.0850',
  take_profit: '1.0920',
  stop_loss: '1.0820',
  note: null,
};

describe('templates', () => {
  it('under review email carries subject, disclaimer and unsubscribe link', () => {
    const m = renderUnderReview(env, UNSUB);
    expect(m.subject).toBe("Your Mason's Trade application");
    expect(m.text).toContain('does not constitute financial advice');
    expect(m.html).toContain(UNSUB);
  });

  it('approved email carries subject and unsubscribe link', () => {
    const m = renderApproved(env, UNSUB);
    expect(m.subject).toBe("Your Mason's Trade access is approved");
    expect(m.html).toContain(UNSUB);
  });

  it('trade email keeps trailing zeros in prices', () => {
    const m = renderTrade(env, trade, UNSUB);
    expect(m.subject).toBe('EURUSD — Buy');
    expect(m.text).toContain('1.0850');
    expect(m.text).not.toContain('1.085\n');
    expect(m.text).toContain('Take profit: 1.0920');
  });

  it('trade email omits the note line entirely when there is no note', () => {
    const m = renderTrade(env, trade, UNSUB);
    expect(m.text).not.toContain('undefined');
    expect(m.text).not.toContain('null');
  });

  it('trade email includes the note when present', () => {
    const m = renderTrade(env, { ...trade, note: 'London session only' }, UNSUB);
    expect(m.text).toContain('London session only');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/templates.test.ts
```

Expected: FAIL — cannot resolve `../src/email/templates`.

- [ ] **Step 3: Write `src/email/templates.ts`**

```ts
import type { Env, Trade } from '../types';
import { displayPair } from '../trade/pairs';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const DISCLAIMER =
  'The information provided does not constitute financial advice. We do not manage ' +
  'client funds or charge for outcomes. Each individual is responsible for their own ' +
  'trading decisions.';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap(bodyHtml: string, bodyText: string, env: Env, unsubUrl: string): { html: string; text: string } {
  const origin = env.SITE_ORIGIN.replace(/^https?:\/\//, '');
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222">
${bodyHtml}
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="font-size:12px;color:#666">${escapeHtml(DISCLAIMER)}</p>
<p style="font-size:12px;color:#666">You're receiving this because you requested access at ${escapeHtml(origin)}.<br>
<a href="${escapeHtml(unsubUrl)}">Unsubscribe</a></p>
</body></html>`;

  const text = `${bodyText}

---
${DISCLAIMER}

You're receiving this because you requested access at ${origin}.
Unsubscribe: ${unsubUrl}`;

  return { html, text };
}

export function renderUnderReview(env: Env, unsubUrl: string): RenderedEmail {
  const bodyText = `We've received your request for access to Mason's Trade.

Applications are reviewed before access is granted. You'll hear back from us within roughly 30 hours - no action is needed from you in the meantime.

Mason's Trade`;
  const bodyHtml = `<p>We've received your request for access to Mason's Trade.</p>
<p>Applications are reviewed before access is granted. You'll hear back from us within roughly 30 hours &mdash; no action is needed from you in the meantime.</p>
<p>Mason's Trade</p>`;
  return { subject: "Your Mason's Trade application", ...wrap(bodyHtml, bodyText, env, unsubUrl) };
}

export function renderApproved(env: Env, unsubUrl: string): RenderedEmail {
  const bodyText = `Your application has been approved.

You'll now receive our market predictions for Forex, commodities and indexes as they're published. Nothing else is required from you.

Mason's Trade`;
  const bodyHtml = `<p>Your application has been approved.</p>
<p>You'll now receive our market predictions for Forex, commodities and indexes as they're published. Nothing else is required from you.</p>
<p>Mason's Trade</p>`;
  return { subject: "Your Mason's Trade access is approved", ...wrap(bodyHtml, bodyText, env, unsubUrl) };
}

export function renderTrade(env: Env, trade: Trade, unsubUrl: string): RenderedEmail {
  const heading = `${displayPair(trade.pair)} — ${trade.direction}`;
  const noteText = trade.note ? `\n\n${trade.note}` : '';
  const noteHtml = trade.note ? `<p>${escapeHtml(trade.note)}</p>` : '';

  const bodyText = `${heading}

Entry: ${trade.entry}
Take profit: ${trade.take_profit}
Stop loss: ${trade.stop_loss}${noteText}

Mason's Trade`;

  const bodyHtml = `<p><strong>${escapeHtml(heading)}</strong></p>
<p>Entry: ${escapeHtml(trade.entry)}<br>
Take profit: ${escapeHtml(trade.take_profit)}<br>
Stop loss: ${escapeHtml(trade.stop_loss)}</p>
${noteHtml}
<p>Mason's Trade</p>`;

  return { subject: `${trade.pair} — ${trade.direction}`, ...wrap(bodyHtml, bodyText, env, unsubUrl) };
}
```

This imports `displayPair` from Task 5. Create a temporary stub now so the test runs — Task 5 replaces the file wholesale:

```ts
// src/trade/pairs.ts — replaced in Task 5
export function displayPair(pair: string): string {
  return pair;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/templates.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add email templates with disclaimer and unsubscribe footer"
```

---

### Task 3: Email sending boundary

**Files:**
- Create: `src/email/send.ts`, `tests/helpers.ts`
- Test: `tests/send.test.ts`

**Interfaces:**
- Consumes: `Env`, `RenderedEmail`
- Produces:
  - `interface OutgoingEmail { to: string; subject: string; html: string; text: string }`
  - `interface SendResult { to: string; ok: boolean; error?: string }`
  - `sendBatch(env: Env, emails: OutgoingEmail[], idempotencyKey: string): Promise<SendResult[]>`

This is the **only** file that names an email provider. Swapping Resend for SES must touch nothing else.

- [ ] **Step 1: Create the shared test helper**

Every test file in this project stubs `fetch`. Declaring the mock inline as
`vi.fn(async () => ...)` types `mock.calls` as `[]`, so any test that inspects the request
fails `tsc --noEmit`. This helper keeps the call tuple typed. Create `tests/helpers.ts`:

```ts
import { vi } from 'vitest';

export type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

/** Stubs global fetch and returns the mock with `mock.calls` correctly typed. */
export function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/send.test.ts`. The assertions below are the requirement; the mock plumbing is
a starting point — stub fetch through `stubFetch`/`jsonResponse` from Step 1 rather than
inline `vi.fn`, so `mock.calls[0]` stays typed and `tsc --noEmit` passes:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendBatch } from '../src/email/send';
import type { Env } from '../src/types';

const baseEnv = {
  DRY_RUN: 'false',
  RESEND_API_KEY: 'key_test',
  FROM_EMAIL: "Mason's Trade <noreply@masonstrade.com>",
  TEST_INBOX: 'test@example.com',
} as Env;

const email = {
  to: 'real@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  unsubUrl: 'https://masonstrade.com/unsubscribe?t=abc',
};

afterEach(() => { vi.restoreAllMocks(); });

describe('sendBatch', () => {
  it('posts to the provider with the idempotency key and returns per-recipient results', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'e1' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const results = await sendBatch(baseEnv, [email], 'trade-1-chunk-0');

    expect(results).toEqual([{ to: 'real@example.com', ok: true }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails/batch');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('trade-1-chunk-0');
    const body = JSON.parse(init.body as string);
    expect(body[0].to).toEqual(['real@example.com']);
    expect(body[0].headers['List-Unsubscribe']).toBe(
      '<https://masonstrade.com/unsubscribe?t=abc>',
    );
    expect(body[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('sends the unsubscribe headers even when the recipient is redirected by DRY_RUN', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'e1' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendBatch({ ...baseEnv, DRY_RUN: 'true' } as Env, [email], 'k');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body[0].headers['List-Unsubscribe']).toBe(
      '<https://masonstrade.com/unsubscribe?t=abc>',
    );
  });

  it('redirects every recipient to the test inbox when DRY_RUN is on', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'e1' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendBatch({ ...baseEnv, DRY_RUN: 'true' } as Env, [email], 'k');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body[0].to).toEqual(['test@example.com']);
  });

  it('marks every recipient failed when the provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));

    const results = await sendBatch(baseEnv, [email], 'k');

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('429');
  });

  it('returns an empty array without calling the provider for an empty batch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await sendBatch(baseEnv, [], 'k')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/send.test.ts
```

Expected: FAIL — cannot resolve `../src/email/send`.

- [ ] **Step 3: Write `src/email/send.ts`**

```ts
import type { Env } from '../types';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Required: every send must carry List-Unsubscribe. Not optional by design. */
  unsubUrl: string;
}

export interface SendResult {
  to: string;
  ok: boolean;
  error?: string;
}

const ENDPOINT = 'https://api.resend.com/emails/batch';

/**
 * The only place an email provider is named. Swapping to Amazon SES means
 * rewriting this function and nothing else.
 *
 * `idempotencyKey` must be stable for a given (trade, chunk) so that a retry
 * after a crash cannot deliver the same email twice.
 */
export async function sendBatch(
  env: Env,
  emails: OutgoingEmail[],
  idempotencyKey: string,
): Promise<SendResult[]> {
  if (emails.length === 0) return [];

  const dryRun = env.DRY_RUN === 'true';

  const payload = emails.map((e) => ({
    from: env.FROM_EMAIL,
    to: [dryRun ? env.TEST_INBOX : e.to],
    subject: e.subject,
    html: e.html,
    text: e.text,
    headers: {
      'List-Unsubscribe': `<${e.unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }));

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const error = `network error: ${String(err)}`;
    return emails.map((e) => ({ to: e.to, ok: false, error }));
  }

  if (!res.ok) {
    const error = `provider responded ${res.status}: ${await res.text()}`;
    return emails.map((e) => ({ to: e.to, ok: false, error }));
  }

  return emails.map((e) => ({ to: e.to, ok: true }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/send.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add provider-agnostic email sending boundary"
```

---

### Task 4: Signup endpoint with anti-junk controls

**Files:**
- Create: `src/validate.ts`, `src/db/subscribers.ts`, `src/routes/subscribe.ts`
- Modify: `src/index.ts`
- Test: `tests/validate.test.ts`, `tests/subscribe.test.ts`

**Interfaces:**
- Consumes: `sendBatch`, `renderUnderReview`, `Env`, `Subscriber`
- Produces:
  - `isValidEmailSyntax(email: string): boolean`
  - `hasMxRecord(domain: string): Promise<boolean>`
  - `hashIp(ip: string): Promise<string>`
  - `countRecentSignupsFromIp(db: D1Database, ipHash: string, since: number): Promise<number>`
  - `insertSubscriber(db: D1Database, email: string, ipHash: string, now: number): Promise<Subscriber | null>` — `null` when the email already exists
  - `unsubUrl(env: Env, token: string): string`

Because there is no double opt-in, MX validation, the honeypot and the rate limit are the only defences. Do not weaken them.

- [ ] **Step 1: Write the failing validation test**

Create `tests/validate.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasMxRecord, isValidEmailSyntax } from '../src/validate';

afterEach(() => { vi.restoreAllMocks(); });

describe('isValidEmailSyntax', () => {
  it.each(['a@b.co', 'first.last+tag@sub.example.com'])('accepts %s', (v) => {
    expect(isValidEmailSyntax(v)).toBe(true);
  });

  it.each(['', 'nope', 'a@b', 'a b@c.com', 'a@@b.com', `${'x'.repeat(250)}@b.com`])(
    'rejects %s',
    (v) => {
      expect(isValidEmailSyntax(v)).toBe(false);
    },
  );
});

describe('hasMxRecord', () => {
  it('accepts a domain that returns MX answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ Answer: [{ type: 15 }] }))),
    );
    expect(await hasMxRecord('gmail.com')).toBe(true);
  });

  it('rejects a typo domain with no MX answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}))));
    expect(await hasMxRecord('gmial.com')).toBe(false);
  });

  it('rejects rather than accepts when the DNS lookup itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    expect(await hasMxRecord('gmail.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/validate.test.ts
```

Expected: FAIL — cannot resolve `../src/validate`.

- [ ] **Step 3: Write `src/validate.ts`**

```ts
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmailSyntax(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false;
  const [local] = email.split('@');
  if (!local || local.length > 64) return false;
  return EMAIL_RE.test(email);
}

/**
 * DNS-over-HTTPS MX lookup. Workers cannot make raw DNS queries.
 * Fails closed: a lookup error rejects the address rather than letting it in,
 * because there is no confirmation click behind this.
 */
export async function hasMxRecord(domain: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { Answer?: unknown[] };
    return Array.isArray(body.Answer) && body.Answer.length > 0;
  } catch {
    return false;
  }
}

export async function hashIp(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run tests/validate.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Write `src/db/subscribers.ts`**

```ts
import type { Env, Subscriber } from '../types';

export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const RATE_LIMIT_MAX = 5;

export async function countRecentSignupsFromIp(
  db: D1Database,
  ipHash: string,
  since: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM subscribers WHERE ip_hash = ? AND created_at >= ?')
    .bind(ipHash, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Returns null when the address already exists. */
export async function insertSubscriber(
  db: D1Database,
  email: string,
  ipHash: string,
  now: number,
): Promise<Subscriber | null> {
  const token = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO subscribers (email, status, unsub_token, ip_hash, created_at)
       VALUES (?, 'pending_approval', ?, ?, ?)
       ON CONFLICT(email) DO NOTHING
       RETURNING id, email, status, unsub_token, created_at, approved_at`,
    )
    .bind(email, token, ipHash, now)
    .first<Subscriber>();
  return row ?? null;
}

export async function findByUnsubToken(
  db: D1Database,
  token: string,
): Promise<Subscriber | null> {
  return db
    .prepare(
      'SELECT id, email, status, unsub_token, created_at, approved_at FROM subscribers WHERE unsub_token = ?',
    )
    .bind(token)
    .first<Subscriber>();
}

export async function markUnsubscribed(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE id = ?").bind(id).run();
}

export async function markUnsubscribedByEmail(db: D1Database, email: string): Promise<void> {
  await db
    .prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?")
    .bind(email.toLowerCase())
    .run();
}

export async function markBounced(db: D1Database, email: string): Promise<void> {
  await db
    .prepare("UPDATE subscribers SET status = 'bounced' WHERE email = ?")
    .bind(email.toLowerCase())
    .run();
}

export function unsubUrl(env: Env, token: string): string {
  return `${env.SITE_ORIGIN.replace(/\/$/, '')}/unsubscribe?t=${token}`;
}
```

- [ ] **Step 6: Write the failing subscribe test**

Create `tests/subscribe.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('dns-query')) {
        return new Response(JSON.stringify({ Answer: [{ type: 15 }] }));
      }
      return new Response(JSON.stringify({ data: [{ id: 'e1' }] }), { status: 200 });
    }),
  );
});

afterEach(() => { vi.restoreAllMocks(); });

function post(body: unknown, ip = '203.0.113.1') {
  return worker.fetch(
    new Request('https://example.com/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify(body),
    }),
    env as any,
    {} as ExecutionContext,
  );
}

describe('POST /subscribe', () => {
  it('stores a valid address as pending_approval', async () => {
    const res = await post({ email: 'New@Example.com' });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT email, status FROM subscribers').first();
    expect(row).toMatchObject({ email: 'new@example.com', status: 'pending_approval' });
  });

  it('rejects a malformed address with 400', async () => {
    expect((await post({ email: 'nope' })).status).toBe(400);
  });

  it('rejects an address whose domain has no MX record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}))));
    expect((await post({ email: 'a@gmial.com' })).status).toBe(400);
  });

  it('silently drops a submission that filled the honeypot', async () => {
    const res = await post({ email: 'bot@example.com', company: 'spam' });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('returns success for a duplicate without creating a second row', async () => {
    await post({ email: 'dupe@example.com' });
    const res = await post({ email: 'dupe@example.com' });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers').first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('rate limits a single IP after five signups', async () => {
    for (let i = 0; i < 5; i++) await post({ email: `u${i}@example.com` });
    expect((await post({ email: 'u6@example.com' })).status).toBe(429);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
npx vitest run tests/subscribe.test.ts
```

Expected: FAIL — `/subscribe` returns 404.

- [ ] **Step 8: Write `src/routes/subscribe.ts`**

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../types';
import { hasMxRecord, hashIp, isValidEmailSyntax } from '../validate';
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  countRecentSignupsFromIp,
  insertSubscriber,
  unsubUrl,
} from '../db/subscribers';
import { sendBatch } from '../email/send';
import { renderUnderReview } from '../email/templates';

export const subscribe = new Hono<{ Bindings: Env }>();

subscribe.use('/subscribe', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'] }));

subscribe.post('/subscribe', async (c) => {
  const body = await c.req.json<{ email?: string; company?: string }>().catch(() => ({}));

  // Honeypot: `company` is hidden from humans, so anything in it is a bot.
  // Answer 200 so the bot cannot tell it was caught.
  if (body.company) return c.json({ ok: true });

  const email = (body.email ?? '').trim().toLowerCase();
  if (!isValidEmailSyntax(email)) {
    return c.json({ ok: false, error: 'Enter a valid email address.' }, 400);
  }

  const domain = email.split('@')[1];
  if (!(await hasMxRecord(domain))) {
    return c.json({ ok: false, error: 'That email domain cannot receive mail.' }, 400);
  }

  const now = Date.now();
  const ipHash = await hashIp(c.req.header('CF-Connecting-IP') ?? 'unknown');
  const recent = await countRecentSignupsFromIp(c.env.DB, ipHash, now - RATE_LIMIT_WINDOW_MS);
  if (recent >= RATE_LIMIT_MAX) {
    return c.json({ ok: false, error: 'Too many requests. Try again later.' }, 429);
  }

  const subscriber = await insertSubscriber(c.env.DB, email, ipHash, now);
  // Duplicate: same response as success, so the endpoint cannot be used to
  // discover who is already on the list.
  if (!subscriber) return c.json({ ok: true });

  const url = unsubUrl(c.env, subscriber.unsub_token);
  const mail = renderUnderReview(c.env, url);
  await sendBatch(
    c.env,
    [{ to: subscriber.email, subject: mail.subject, html: mail.html, text: mail.text, unsubUrl: url }],
    `welcome-${subscriber.id}`,
  );

  return c.json({ ok: true });
});
```

- [ ] **Step 9: Mount it in `src/index.ts`**

Replace the file body with:

```ts
import { Hono } from 'hono';
import type { Env } from './types';
import { subscribe } from './routes/subscribe';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', subscribe);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Approval sweep is wired in Task 6.
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 10: Run it to verify it passes**

```bash
npx vitest run tests/subscribe.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "Add signup endpoint with MX, honeypot and rate-limit controls"
```

---

### Task 5: Spoken number and pair parsing

**Files:**
- Create: `src/trade/numbers.ts`
- Replace: `src/trade/pairs.ts` (the Task 2 stub)
- Test: `tests/numbers.test.ts`, `tests/pairs.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseSpokenNumber(text: string): string | null` — returns the price as a **string**, preserving trailing zeros
  - `resolvePair(text: string): string | null` — returns a symbol such as `EURUSD`
  - `displayPair(symbol: string): string` — returns `Euro Dollar`

- [ ] **Step 1: Write the failing number test**

Create `tests/numbers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSpokenNumber } from '../src/trade/numbers';

describe('parseSpokenNumber', () => {
  it('passes through a digit form unchanged, keeping trailing zeros', () => {
    expect(parseSpokenNumber('1.0850')).toBe('1.0850');
  });

  it('parses fully spelled digits', () => {
    expect(parseSpokenNumber('one point zero eight five zero')).toBe('1.0850');
  });

  it('treats "oh" as zero', () => {
    expect(parseSpokenNumber('one point oh eight five oh')).toBe('1.0850');
  });

  it('parses a whole number', () => {
    expect(parseSpokenNumber('two thousand three hundred')).toBe(null);
    expect(parseSpokenNumber('2300')).toBe('2300');
  });

  it('parses a mixed digit and word form', () => {
    expect(parseSpokenNumber('1 point zero nine two zero')).toBe('1.0920');
  });

  it('returns null for anything it cannot read confidently', () => {
    expect(parseSpokenNumber('somewhere around one ish')).toBe(null);
    expect(parseSpokenNumber('')).toBe(null);
    expect(parseSpokenNumber('point')).toBe(null);
  });

  it('returns null for two decimal points', () => {
    expect(parseSpokenNumber('one point zero point five')).toBe(null);
  });
});
```

Note: `two thousand three hundred` deliberately returns `null`. Compound number words are not supported; refusing is correct behaviour, and Whisper emits digits for values like this in practice.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/numbers.test.ts
```

Expected: FAIL — cannot resolve `../src/trade/numbers`.

- [ ] **Step 3: Write `src/trade/numbers.ts`**

```ts
const WORD_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

const POINT_WORDS = new Set(['point', 'dot', 'decimal']);

/**
 * Returns the number as a STRING so that trailing zeros survive.
 * `1.0850` must never become `1.085`.
 *
 * Returns null whenever the input is not unambiguously a number. Refusing is
 * the correct outcome - a guessed price reaches every subscriber.
 */
export function parseSpokenNumber(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;

  const tokens = trimmed.split(/[\s-]+/).filter(Boolean);
  let out = '';
  let seenPoint = false;

  for (const token of tokens) {
    if (POINT_WORDS.has(token)) {
      if (seenPoint) return null;
      seenPoint = true;
      out += '.';
      continue;
    }
    if (/^\d+$/.test(token)) {
      out += token;
      continue;
    }
    const digit = WORD_DIGITS[token];
    if (digit === undefined) return null;
    out += digit;
  }

  if (out.length === 0 || out === '.') return null;
  if (out.startsWith('.') || out.endsWith('.')) return null;
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run tests/numbers.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing pair test**

Create `tests/pairs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { displayPair, resolvePair } from '../src/trade/pairs';

describe('resolvePair', () => {
  it.each([
    ['euro dollar', 'EURUSD'],
    ['eurusd', 'EURUSD'],
    ['eur usd', 'EURUSD'],
    ['cable', 'GBPUSD'],
    ['pound dollar', 'GBPUSD'],
    ['gold', 'XAUUSD'],
    ['dollar yen', 'USDJPY'],
    ['nasdaq', 'NAS100'],
  ])('resolves %s', (input, expected) => {
    expect(resolvePair(input)).toBe(expected);
  });

  it('finds the pair inside a full sentence', () => {
    expect(resolvePair('euro dollar buy at 1.0850 take profit 1.0920')).toBe('EURUSD');
  });

  it('returns null when no pair is present', () => {
    expect(resolvePair('buy at 1.0850')).toBe(null);
  });
});

describe('displayPair', () => {
  it('returns a spoken-friendly name', () => {
    expect(displayPair('EURUSD')).toBe('Euro Dollar');
    expect(displayPair('XAUUSD')).toBe('Gold');
  });

  it('falls back to the symbol for anything unmapped', () => {
    expect(displayPair('EURNZD')).toBe('EURNZD');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
npx vitest run tests/pairs.test.ts
```

Expected: FAIL — `resolvePair` is not exported.

- [ ] **Step 7: Replace `src/trade/pairs.ts`**

```ts
interface PairDef {
  symbol: string;
  display: string;
  aliases: string[];
}

const PAIRS: PairDef[] = [
  { symbol: 'EURUSD', display: 'Euro Dollar', aliases: ['eurusd', 'eur usd', 'euro dollar', 'euro us dollar', 'fiber'] },
  { symbol: 'GBPUSD', display: 'Pound Dollar', aliases: ['gbpusd', 'gbp usd', 'pound dollar', 'sterling dollar', 'cable'] },
  { symbol: 'USDJPY', display: 'Dollar Yen', aliases: ['usdjpy', 'usd jpy', 'dollar yen'] },
  { symbol: 'AUDUSD', display: 'Aussie Dollar', aliases: ['audusd', 'aud usd', 'aussie dollar', 'aussie'] },
  { symbol: 'USDCAD', display: 'Dollar Loonie', aliases: ['usdcad', 'usd cad', 'dollar cad', 'loonie'] },
  { symbol: 'USDCHF', display: 'Dollar Swiss', aliases: ['usdchf', 'usd chf', 'dollar swiss', 'swissy'] },
  { symbol: 'XAUUSD', display: 'Gold', aliases: ['xauusd', 'xau usd', 'gold'] },
  { symbol: 'XAGUSD', display: 'Silver', aliases: ['xagusd', 'xag usd', 'silver'] },
  { symbol: 'USOIL', display: 'Oil', aliases: ['usoil', 'oil', 'crude', 'wti'] },
  { symbol: 'NAS100', display: 'Nasdaq', aliases: ['nas100', 'nasdaq', 'nas 100', 'us tech 100'] },
  { symbol: 'US30', display: 'Dow', aliases: ['us30', 'us 30', 'dow', 'dow jones'] },
  { symbol: 'US500', display: 'S and P 500', aliases: ['us500', 'us 500', 's and p', 'sp500', 'spx'] },
];

/** Longest alias first, so "euro dollar" never loses to a shorter partial match. */
const SORTED = PAIRS.flatMap((p) => p.aliases.map((a) => ({ alias: a, symbol: p.symbol }))).sort(
  (a, b) => b.alias.length - a.alias.length,
);

export function resolvePair(text: string): string | null {
  const normalised = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const { alias, symbol } of SORTED) {
    const pattern = new RegExp(`(^|\\s)${alias.replace(/\s+/g, '\\s+')}($|\\s)`);
    if (pattern.test(normalised)) return symbol;
  }
  return null;
}

export function displayPair(symbol: string): string {
  return PAIRS.find((p) => p.symbol === symbol)?.display ?? symbol;
}
```

- [ ] **Step 8: Run the full suite to verify nothing regressed**

```bash
npx vitest run
```

Expected: PASS. The Task 2 template test now renders `Euro Dollar` through the real `displayPair`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Add spoken number and currency pair parsing"
```

---

### Task 6: Trade transcript parser

**Files:**
- Create: `src/trade/parse.ts`
- Test: `tests/parse.test.ts`

**Interfaces:**
- Consumes: `parseSpokenNumber`, `resolvePair`, `Trade`
- Produces: `parseTrade(transcript: string): { ok: true; trade: Trade } | { ok: false; missing: string[] }`

The refusal path is the point of this task. A guessed stop-loss reaches every subscriber.

> **Amended after review.** The Step 3 reference code below carried two defects, both found in
> review and fixed in commit `095bd18`, plus a third found later during Task 9 review once the
> note started carrying real free text. The shipped `src/trade/parse.ts` is the source of truth:
>
> 1. **Note mis-slice.** The gate tested the normalised copy while the slice re-ran `indexOf` on
>    the raw transcript. A transcript trailing off on `"note"` produced `slice(5)` — garbage that
>    reached the read-back and the broadcast. Now one index, computed once, via `/\bnote\b/`.
> 2. **The generic `'at'` entry label** could match inside `"take profit at X"`, which made the
>    parser refuse while naming the wrong fields. Entry is now searched only before the first
>    TP/SL label, filler words are stripped from captured values, and a single unlabelled number
>    in the entry region is accepted while two or more refuse.
> 3. **Label lookups scanned the whole transcript, including the note.** A note that happened to
>    contain an ordinary trading word matching a label alias — `"target"` (a `TP_LABELS` alias),
>    or equally `"stop"`, `"entry"`, `"at"`, `"tp"` — silently truncated a real price during
>    `valueAfter`'s stop-word scan and refused an otherwise well-formed trade, naming the wrong
>    field as missing. The note is free text by definition and must never influence pair,
>    direction, or price extraction. `parseTrade` now computes the note boundary
>    (`fullText.search(/\bnote\b/)`) before any label work and confines `resolvePair`, the
>    direction regex, and all three price lookups to the text before that boundary; note
>    extraction itself is unaffected and still runs against the raw transcript.
> 4. **Two more defects, found in the final whole-branch review of `feature/automation-v1` and
>    fixed in fix wave A.** First, `parseSpokenNumber` concatenated any two adjacent numeral
>    tokens into one fabricated price — `'2340 2350'` became `'23402350'`, and
>    `'take profit 2360 2370'` (the operator correcting himself mid-sentence, a common dictation
>    pattern) silently produced `'23602370'` instead of refusing. It now refuses whenever two
>    consecutive numeral tokens appear with no point word between them; spoken word-digits
>    (`'two three four five'` → `'2345'`) and numeral-plus-point-word (`'2340 point 50'` →
>    `'2340.50'`) are unaffected. Second, `valueAfter` required the *entire* remainder of the
>    transcript after the last labelled price to parse as one number, so any trailing word —
>    `"send it"`, `"thanks"`, `"pips"`, `"ok"` — refused the whole trade and named a field the
>    operator had in fact said, prompting him to re-record and hit the same refusal. `numbers.ts`
>    now exports `isNumberToken` and `takeLeadingNumber`, which reads only the leading run of
>    number tokens after a label; `valueAfter` accepts trailing non-numeric chatter and refuses
>    only if a further *numeric* token follows the run (closing the first defect too, since
>    `'2360 2370'` is two numeric tokens with no valid split). Leading filler words (`at`, `of`,
>    `is`, `to`) are now stripped in a loop rather than once, so chained fillers
>    (`"take profit is at 2360"`) no longer refuse either. Separately, a bare `'stop'` label
>    immediately preceded by `buy`, `sell`, `long`, or `short` (`"buy stop"` / `"sell stop"`,
>    standard pending-order phrasing) is now ignored in favour of a later, genuine stop-loss
>    label, so it no longer truncates and loses the entry region.

- [ ] **Step 1: Write the failing test**

Create `tests/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseTrade } from '../src/trade/parse';

describe('parseTrade', () => {
  it('parses a fully spoken transcript', () => {
    const result = parseTrade(
      'euro dollar buy at one point zero eight five zero take profit one point zero nine two zero stop loss one point zero eight two zero',
    );
    expect(result).toEqual({
      ok: true,
      trade: {
        pair: 'EURUSD',
        direction: 'Buy',
        entry: '1.0850',
        take_profit: '1.0920',
        stop_loss: '1.0820',
        note: null,
      },
    });
  });

  it('parses a digit transcript with abbreviations', () => {
    const result = parseTrade('gold sell entry 2350.50 tp 2340.00 sl 2360.00');
    expect(result).toEqual({
      ok: true,
      trade: {
        pair: 'XAUUSD',
        direction: 'Sell',
        entry: '2350.50',
        take_profit: '2340.00',
        stop_loss: '2360.00',
        note: null,
      },
    });
  });

  it('treats long as Buy and short as Sell', () => {
    const long = parseTrade('cable long at 1.2700 tp 1.2750 sl 1.2680');
    expect(long.ok && long.trade.direction).toBe('Buy');
    const short = parseTrade('cable short at 1.2700 tp 1.2650 sl 1.2720');
    expect(short.ok && short.trade.direction).toBe('Sell');
  });

  it('reports the missing field rather than guessing when stop loss is absent', () => {
    const result = parseTrade('euro dollar buy at 1.0850 take profit 1.0920');
    expect(result).toEqual({ ok: false, missing: ['stop loss'] });
  });

  it('reports every missing field at once', () => {
    const result = parseTrade('something inaudible');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.missing).toEqual([
      'currency pair',
      'direction',
      'entry',
      'take profit',
      'stop loss',
    ]);
  });

  it('refuses when a labelled price is not a readable number', () => {
    const result = parseTrade('euro dollar buy at 1.0850 take profit around there sl 1.0820');
    expect(result).toEqual({ ok: false, missing: ['take profit'] });
  });

  it('captures a trailing note after the last price', () => {
    const result = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note London session only');
    expect(result.ok && result.trade.note).toBe('London session only');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/parse.test.ts
```

Expected: FAIL — cannot resolve `../src/trade/parse`.

- [ ] **Step 3: Write `src/trade/parse.ts`**

```ts
import type { Trade } from '../types';
import { parseSpokenNumber } from './numbers';
import { resolvePair } from './pairs';

export type ParseResult =
  | { ok: true; trade: Trade }
  | { ok: false; missing: string[] };

const TP_LABELS = ['take profit', 'takeprofit', 'tp', 'target'];
const SL_LABELS = ['stop loss', 'stoploss', 'sl', 'stop'];
const ENTRY_LABELS = ['entry', 'enter at', 'enter', 'at'];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reads the value following a label. Takes words up to the next label or the
 * end, then hands them to parseSpokenNumber, which refuses anything ambiguous.
 */
function valueAfter(text: string, labels: string[], stopLabels: string[]): string | null {
  for (const label of labels) {
    const at = text.indexOf(` ${label} `);
    if (at === -1) continue;
    let rest = text.slice(at + label.length + 2);
    for (const stop of stopLabels) {
      const stopAt = rest.indexOf(` ${stop} `);
      if (stopAt !== -1) rest = rest.slice(0, stopAt);
    }
    const words = rest.split(' ').slice(0, 12).join(' ');
    const value = parseSpokenNumber(words);
    if (value !== null) return value;
    // Label present but unreadable value: refuse rather than try another label.
    return null;
  }
  return null;
}

export function parseTrade(transcript: string): ParseResult {
  const text = ` ${normalise(transcript)} `;
  const missing: string[] = [];

  const pair = resolvePair(text);
  if (!pair) missing.push('currency pair');

  let direction: 'Buy' | 'Sell' | null = null;
  if (/\b(buy|long)\b/.test(text)) direction = 'Buy';
  else if (/\b(sell|short)\b/.test(text)) direction = 'Sell';
  if (!direction) missing.push('direction');

  const allLabels = [...TP_LABELS, ...SL_LABELS, ...ENTRY_LABELS, 'note'];
  const entry = valueAfter(text, ENTRY_LABELS, allLabels);
  if (entry === null) missing.push('entry');

  const takeProfit = valueAfter(text, TP_LABELS, allLabels);
  if (takeProfit === null) missing.push('take profit');

  const stopLoss = valueAfter(text, SL_LABELS, allLabels);
  if (stopLoss === null) missing.push('stop loss');

  if (missing.length > 0) return { ok: false, missing };

  const noteAt = text.indexOf(' note ');
  const note = noteAt === -1 ? null : transcript.slice(transcript.toLowerCase().indexOf(' note ') + 6).trim() || null;

  return {
    ok: true,
    trade: {
      pair: pair!,
      direction: direction!,
      entry: entry!,
      take_profit: takeProfit!,
      stop_loss: stopLoss!,
      note,
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run tests/parse.test.ts
```

Expected: PASS, 7 tests. If the `stop` label inside `stop loss` causes a mis-slice, order `SL_LABELS` longest-first — it already is.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add trade transcript parser that refuses ambiguous input"
```

---

### Task 7: Approval sweep

**Files:**
- Create: `src/cron.ts`
- Modify: `src/index.ts`
- Test: `tests/cron.test.ts`

**Interfaces:**
- Consumes: `sendBatch`, `renderApproved`, `unsubUrl`
- Produces: `runApprovalSweep(env: Env, now: number): Promise<number>` — returns how many were approved

`now` is a parameter so the 30-hour boundary is tested without waiting.

> **Amended after review.** The Step 3 reference code below selected rows, updated them, then
> emailed from the *pre-update* snapshot, discarding what the guarded `UPDATE` actually changed.
> The guard therefore prevented a double status flip but not a double email — and once Task 8
> lands, someone unsubscribing inside the SELECT-to-UPDATE window would keep the correct status
> and still be mailed. Fixed in commit noted in the ledger: a single
> `UPDATE ... WHERE id IN (SELECT ...) RETURNING ...` makes the set of approved rows and the set
> of emailed rows the same set by construction. The shipped `src/cron.ts` is the source of truth.

- [ ] **Step 1: Write the failing test**

Create `tests/cron.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_DELAY_MS, runApprovalSweep } from '../src/cron';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'e1' }] }), { status: 200 })),
  );
});

afterEach(() => { vi.restoreAllMocks(); });

async function seed(email: string, createdAt: number, status = 'pending_approval') {
  await env.DB.prepare(
    'INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(email, status, crypto.randomUUID(), createdAt)
    .run();
}

const NOW = 1_800_000_000_000;

describe('runApprovalSweep', () => {
  it('approves a subscriber past the 30 hour mark', async () => {
    await seed('old@example.com', NOW - APPROVAL_DELAY_MS - 1000);

    expect(await runApprovalSweep(env as any, NOW)).toBe(1);

    const row = await env.DB.prepare('SELECT status, approved_at FROM subscribers').first<any>();
    expect(row.status).toBe('approved');
    expect(row.approved_at).toBe(NOW);
  });

  it('leaves a subscriber one second short of the mark alone', async () => {
    await seed('young@example.com', NOW - APPROVAL_DELAY_MS + 1000);

    expect(await runApprovalSweep(env as any, NOW)).toBe(0);

    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('pending_approval');
  });

  it('never re-approves someone already approved', async () => {
    await seed('done@example.com', NOW - APPROVAL_DELAY_MS - 1000, 'approved');
    expect(await runApprovalSweep(env as any, NOW)).toBe(0);
  });

  it('never approves an unsubscribed or bounced address', async () => {
    await seed('gone@example.com', NOW - APPROVAL_DELAY_MS - 1000, 'unsubscribed');
    await seed('dead@example.com', NOW - APPROVAL_DELAY_MS - 1000, 'bounced');
    expect(await runApprovalSweep(env as any, NOW)).toBe(0);
  });

  it('is idempotent across two consecutive runs', async () => {
    await seed('once@example.com', NOW - APPROVAL_DELAY_MS - 1000);
    expect(await runApprovalSweep(env as any, NOW)).toBe(1);
    expect(await runApprovalSweep(env as any, NOW)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/cron.test.ts
```

Expected: FAIL — cannot resolve `../src/cron`.

- [ ] **Step 3: Write `src/cron.ts`**

```ts
import type { Env, Subscriber } from './types';
import { unsubUrl } from './db/subscribers';
import { sendBatch } from './email/send';
import { renderApproved } from './email/templates';

export const APPROVAL_DELAY_MS = 30 * 60 * 60 * 1000;

const BATCH = 100;

export async function runApprovalSweep(env: Env, now: number): Promise<number> {
  const cutoff = now - APPROVAL_DELAY_MS;

  const { results } = await env.DB.prepare(
    `SELECT id, email, status, unsub_token, created_at, approved_at
     FROM subscribers
     WHERE status = 'pending_approval' AND created_at <= ?
     ORDER BY id
     LIMIT ?`,
  )
    .bind(cutoff, BATCH)
    .all<Subscriber>();

  if (results.length === 0) return 0;

  // Flip status first: a crash after this point costs an approval email, not a
  // duplicate one. The reverse order would re-mail everyone on the next tick.
  await env.DB.batch(
    results.map((s) =>
      env.DB.prepare(
        "UPDATE subscribers SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending_approval'",
      ).bind(now, s.id),
    ),
  );

  const emails = results.map((s) => {
    const url = unsubUrl(env, s.unsub_token);
    const mail = renderApproved(env, url);
    return { to: s.email, subject: mail.subject, html: mail.html, text: mail.text, unsubUrl: url };
  });

  await sendBatch(env, emails, `approvals-${cutoff}-${results[0].id}`);

  return results.length;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run tests/cron.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Wire the scheduled handler in `src/index.ts`**

Replace the `scheduled` function:

```ts
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runApprovalSweep(env, event.scheduledTime));
  },
```

and add the import:

```ts
import { runApprovalSweep } from './cron';
```

- [ ] **Step 6: Run the full suite**

```bash
npx vitest run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add 30 hour approval sweep on cron"
```

---

### Task 8: Unsubscribe and bounce handling

**Files:**
- Create: `src/routes/unsubscribe.ts`, `src/routes/bounce.ts`
- Modify: `src/index.ts`
- Test: `tests/unsubscribe.test.ts`

**Interfaces:**
- Consumes: `findByUnsubToken`, `markUnsubscribed`, `markUnsubscribedByEmail`, `markBounced` (all from Task 4's `src/db/subscribers.ts`)
- Produces: routes `GET /unsubscribe`, `POST /unsubscribe`, `POST /webhooks/email`

`POST /unsubscribe` exists because `List-Unsubscribe-Post` makes Gmail POST the link.

- [ ] **Step 1: Write the failing test**

Create `tests/unsubscribe.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
  await env.DB.prepare(
    "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES ('a@example.com', 'approved', 'tok123', 1)",
  ).run();
});

function call(path: string, method = 'GET') {
  return worker.fetch(
    new Request(`https://example.com${path}`, { method }),
    env as any,
    {} as ExecutionContext,
  );
}

describe('unsubscribe', () => {
  it('marks the subscriber unsubscribed on GET', async () => {
    expect((await call('/unsubscribe?t=tok123')).status).toBe(200);
    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('unsubscribed');
  });

  it('accepts a one-click POST from a mail client', async () => {
    expect((await call('/unsubscribe?t=tok123', 'POST')).status).toBe(200);
    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('unsubscribed');
  });

  it('returns 404 for an unknown token', async () => {
    expect((await call('/unsubscribe?t=nope')).status).toBe(404);
  });

  it('is safe to call twice', async () => {
    await call('/unsubscribe?t=tok123');
    expect((await call('/unsubscribe?t=tok123')).status).toBe(200);
  });
});

describe('bounce webhook', () => {
  it('marks a hard-bounced address on the first bounce', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/webhooks/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'email.bounced', data: { to: ['a@example.com'] } }),
      }),
      env as any,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('bounced');
  });

  it('marks a complaint as unsubscribed', async () => {
    await worker.fetch(
      new Request('https://example.com/webhooks/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'email.complained', data: { to: ['a@example.com'] } }),
      }),
      env as any,
      {} as ExecutionContext,
    );
    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('unsubscribed');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/unsubscribe.test.ts
```

Expected: FAIL — routes return 404.

- [ ] **Step 3: Write `src/routes/unsubscribe.ts`**

```ts
import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { findByUnsubToken, markUnsubscribed } from '../db/subscribers';

export const unsubscribe = new Hono<{ Bindings: Env }>();

async function handle(c: Context<{ Bindings: Env }>) {
  const token = c.req.query('t') ?? '';
  const subscriber = await findByUnsubToken(c.env.DB, token);
  if (!subscriber) return c.text('This unsubscribe link is not valid.', 404);

  await markUnsubscribed(c.env.DB, subscriber.id);
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
     <p style="font-family:Helvetica,Arial,sans-serif">You've been unsubscribed. You will not receive further emails from Mason's Trade.</p>`,
  );
}

unsubscribe.get('/unsubscribe', handle);
// Gmail and others POST the link because of List-Unsubscribe-Post.
unsubscribe.post('/unsubscribe', handle);
```

- [ ] **Step 4: Write `src/routes/bounce.ts`**

```ts
import { Hono } from 'hono';
import type { Env } from '../types';
import { markBounced, markUnsubscribedByEmail } from '../db/subscribers';

export const bounce = new Hono<{ Bindings: Env }>();

/**
 * Provider webhook. A hard bounce removes the address on the FIRST failure -
 * with no confirmation step at signup this is the only thing pruning dead
 * addresses, and a dirty list is what gets a sending domain blocked.
 */
bounce.post('/webhooks/email', async (c) => {
  const body = await c.req.json<{ type?: string; data?: { to?: string[] } }>().catch(() => ({}));
  const to = body.data?.to?.[0];
  if (!to) return c.json({ ok: true });

  if (body.type === 'email.bounced') {
    await markBounced(c.env.DB, to);
  } else if (body.type === 'email.complained') {
    await markUnsubscribedByEmail(c.env.DB, to);
  }

  return c.json({ ok: true });
});
```

- [ ] **Step 5: Mount both in `src/index.ts`**

```ts
import { bounce } from './routes/bounce';
import { unsubscribe } from './routes/unsubscribe';
```

```ts
app.route('/', unsubscribe);
app.route('/', bounce);
```

- [ ] **Step 6: Run it to verify it passes**

```bash
npx vitest run tests/unsubscribe.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add unsubscribe route and bounce webhook pruning"
```

---

### Task 9: Telegram transport and VoiceOver-safe formatting

**Files:**
- Create: `src/telegram/api.ts`, `src/telegram/format.ts`
- Test: `tests/format.test.ts`

**Interfaces:**
- Consumes: `Trade`, `displayPair`, `Env`
- Produces:
  - `sendMessage(env, chatId, text, keyboard?): Promise<void>`
  - `answerCallbackQuery(env, id, text): Promise<void>`
  - `getFileUrl(env, fileId): Promise<string | null>`
  - `formatTradeReadback(trade: Trade, recipientCount: number): string`
  - `confirmKeyboard(draftToken: string, recipientCount: number): InlineKeyboard`
  - `formatRefusal(missing: string[]): string`

Every constraint in this task is an accessibility requirement. Read the Global Constraints again before writing it.

> **Amended after review.** The Step 3/4 reference code below carried two defects, both found
> in review:
>
> 1. **`trade.note` reached VoiceOver unsanitised.** `note` is a raw slice of the transcript
>    (or of typed fallback input, where iOS predictive text inserts emoji freely), and
>    `formatTradeReadback` interpolated it verbatim. Since `sendMessage` sets no `parse_mode`,
>    an emoji or `*`/`_`/backtick in a note would reach Telegram literally and VoiceOver would
>    announce it by name in the middle of the prices — exactly what the no-emoji rule exists to
>    prevent. Fixed at the source, not in `format.ts`: `src/trade/parse.ts` now runs the note
>    through a `sanitiseNote()` step (strips `\p{Extended_Pictographic}` and `[*_`~]`, collapses
>    whitespace, trims) before it ever becomes part of the `Trade`, so the value the operator
>    confirms in the readback and the value that reaches the broadcast email are the same clean
>    text. A note that is empty after sanitising becomes `null`, not `''`, since both the
>    readback and the email template branch on falsiness.
> 2. **`sendMessage` and `answerCallbackQuery` discarded the Telegram response.** Both awaited
>    `fetch(...)` and returned `void`, so a blocked bot, unknown chat, or rate limit was
>    indistinguishable from success — `getFileUrl` right below them already checked `res.ok`.
>    Both now return `Promise<boolean>` (`res.ok`) instead of `Promise<void>`, still without
>    throwing on a non-ok response and without logging the response body (the request URL
>    embeds the bot token). The interface list above is superseded by this signature; the
>    shipped `src/telegram/api.ts` and `src/trade/parse.ts` are the source of truth.

- [ ] **Step 1: Write the failing test**

Create `tests/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { confirmKeyboard, formatRefusal, formatTradeReadback } from '../src/telegram/format';
import type { Trade } from '../src/types';

const trade: Trade = {
  pair: 'EURUSD',
  direction: 'Buy',
  entry: '1.0850',
  take_profit: '1.0920',
  stop_loss: '1.0820',
  note: null,
};

const EMOJI = /\p{Extended_Pictographic}/u;

describe('formatTradeReadback', () => {
  it('leads with the pair and direction in spoken form', () => {
    expect(formatTradeReadback(trade, 143).split('\n')[0]).toBe('Euro Dollar. Buy.');
  });

  it('lists each price on its own line', () => {
    const text = formatTradeReadback(trade, 143);
    expect(text).toContain('Entry 1.0850');
    expect(text).toContain('Take profit 1.0920');
    expect(text).toContain('Stop loss 1.0820');
  });

  it('states the recipient count', () => {
    expect(formatTradeReadback(trade, 143)).toContain('143');
  });

  it('contains no emoji and no markdown emphasis characters', () => {
    const text = formatTradeReadback(trade, 143);
    expect(EMOJI.test(text)).toBe(false);
    expect(text).not.toMatch(/[*_`~]/);
  });
});

describe('confirmKeyboard', () => {
  it('puts confirm and cancel on separate rows so a mistap cannot send', () => {
    const kb = confirmKeyboard('tok', 143);
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0]).toHaveLength(1);
    expect(kb.inline_keyboard[1]).toHaveLength(1);
  });

  it('uses self-describing labels, never bare Send or Cancel', () => {
    const kb = confirmKeyboard('tok', 143);
    expect(kb.inline_keyboard[0][0].text).toBe('Send to 143 subscribers');
    expect(kb.inline_keyboard[1][0].text).toBe('Cancel, do not send');
  });

  it('carries the one-time draft token in callback data', () => {
    const kb = confirmKeyboard('tok', 143);
    expect(kb.inline_keyboard[0][0].callback_data).toBe('send:tok');
    expect(kb.inline_keyboard[1][0].callback_data).toBe('cancel:tok');
  });

  it('contains no emoji in any label', () => {
    const kb = confirmKeyboard('tok', 143);
    for (const row of kb.inline_keyboard) {
      for (const button of row) expect(EMOJI.test(button.text)).toBe(false);
    }
  });
});

describe('formatRefusal', () => {
  it('names every field it could not read', () => {
    const text = formatRefusal(['take profit', 'stop loss']);
    expect(text).toContain('take profit');
    expect(text).toContain('stop loss');
  });

  it('contains no emoji', () => {
    expect(EMOJI.test(formatRefusal(['entry']))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/format.test.ts
```

Expected: FAIL — cannot resolve `../src/telegram/format`.

- [ ] **Step 3: Write `src/telegram/format.ts`**

```ts
import type { Trade } from '../types';
import { displayPair } from '../trade/pairs';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/**
 * The operator uses VoiceOver, which reads this text aloud.
 * No emoji, no markdown characters, short lines, numbers last on each line.
 * Messages are sent WITHOUT parse_mode so Telegram renders them literally.
 */
export function formatTradeReadback(trade: Trade, recipientCount: number): string {
  const lines = [
    `${displayPair(trade.pair)}. ${trade.direction}.`,
    `Entry ${trade.entry}`,
    `Take profit ${trade.take_profit}`,
    `Stop loss ${trade.stop_loss}`,
  ];
  if (trade.note) lines.push(`Note. ${trade.note}`);
  lines.push('', `Send to ${recipientCount} subscribers?`);
  return lines.join('\n');
}

/**
 * Confirm and cancel are on SEPARATE ROWS. Side-by-side buttons are a mistap
 * away from mailing the whole list.
 */
export function confirmKeyboard(draftToken: string, recipientCount: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: `Send to ${recipientCount} subscribers`, callback_data: `send:${draftToken}` }],
      [{ text: 'Cancel, do not send', callback_data: `cancel:${draftToken}` }],
    ],
  };
}

export function formatRefusal(missing: string[]): string {
  return [
    'I could not read this trade.',
    `Missing: ${missing.join(', ')}.`,
    'Please record it again, saying the pair, buy or sell, entry, take profit and stop loss.',
  ].join('\n');
}
```

- [ ] **Step 4: Write `src/telegram/api.ts`**

```ts
import type { Env } from '../types';
import type { InlineKeyboard } from './format';

function apiUrl(env: Env, method: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/** Sent without parse_mode on purpose - see format.ts. */
export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await fetch(apiUrl(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }),
  });
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  await fetch(apiUrl(env, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function getFileUrl(env: Env, fileId: string): Promise<string | null> {
  const res = await fetch(apiUrl(env, 'getFile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!body.ok || !body.result?.file_path) return null;
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${body.result.file_path}`;
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npx vitest run tests/format.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add Telegram transport and VoiceOver-safe message formatting"
```

---

### Task 10: Voice transcription

**Files:**
- Create: `src/transcribe.ts`
- Test: `tests/transcribe.test.ts`

**Interfaces:**
- Consumes: `getFileUrl`, `Env`
- Produces: `transcribeVoice(env: Env, fileId: string): Promise<string | null>`

**Known risk:** Telegram voice notes are OGG/Opus. Whisper on Workers AI is documented for common audio formats but OGG/Opus is the least certain of them. Step 6 verifies this against the real API before the task is considered done. If it fails, the fallback is `@cf/openai/whisper-large-v3-turbo`, which takes base64 audio — typed input already exists as the operator-facing fallback either way, so this does not block the rest of the system.

- [ ] **Step 1: Write the failing test**

Create `tests/transcribe.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeVoice } from '../src/transcribe';
import type { Env } from '../src/types';

afterEach(() => { vi.restoreAllMocks(); });

function envWith(aiResult: unknown): Env {
  return {
    TELEGRAM_BOT_TOKEN: 'tok',
    AI: { run: vi.fn(async () => aiResult) },
  } as unknown as Env;
}

describe('transcribeVoice', () => {
  it('returns the transcript text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/a.oga' } }));
        }
        return new Response(new Uint8Array([1, 2, 3]));
      }),
    );

    const env = envWith({ text: 'euro dollar buy at 1.0850' });
    expect(await transcribeVoice(env, 'file1')).toBe('euro dollar buy at 1.0850');
  });

  it('returns null when the file cannot be located', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false }))));
    expect(await transcribeVoice(envWith({ text: 'x' }), 'file1')).toBe(null);
  });

  it('returns null when the model returns an empty transcript', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/a.oga' } }));
        }
        return new Response(new Uint8Array([1, 2, 3]));
      }),
    );
    expect(await transcribeVoice(envWith({ text: '   ' }), 'file1')).toBe(null);
  });

  it('returns null rather than throwing when the model errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/a.oga' } }));
        }
        return new Response(new Uint8Array([1, 2, 3]));
      }),
    );
    const env = {
      TELEGRAM_BOT_TOKEN: 'tok',
      AI: { run: vi.fn(async () => { throw new Error('model down'); }) },
    } as unknown as Env;
    expect(await transcribeVoice(env, 'file1')).toBe(null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/transcribe.test.ts
```

Expected: FAIL — cannot resolve `../src/transcribe`.

- [ ] **Step 3: Write `src/transcribe.ts`**

```ts
import type { Env } from './types';
import { getFileUrl } from './telegram/api';

const MODEL = '@cf/openai/whisper';

/**
 * Telegram voice note to text. Returns null on any failure - the caller tells
 * the operator to record again rather than proceeding on a partial transcript.
 */
export async function transcribeVoice(env: Env, fileId: string): Promise<string | null> {
  const url = await getFileUrl(env, fileId);
  if (!url) return null;

  try {
    const audioRes = await fetch(url);
    if (!audioRes.ok) return null;
    const bytes = new Uint8Array(await audioRes.arrayBuffer());

    const result = (await env.AI.run(MODEL as any, { audio: [...bytes] })) as { text?: string };
    const text = (result?.text ?? '').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run tests/transcribe.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add Whisper transcription for Telegram voice notes"
```

- [ ] **Step 6: Verify OGG/Opus against the real Workers AI API**

This cannot be proven with mocks. Record a short voice note, download it, and run:

```bash
npx wrangler ai run @cf/openai/whisper --file ./sample.oga
```

Expected: a JSON response containing recognisable transcript text.

If it returns an error or empty text, change `MODEL` to `@cf/openai/whisper-large-v3-turbo` and send the audio base64-encoded instead:

```ts
const b64 = btoa(String.fromCharCode(...bytes));
const result = (await env.AI.run(MODEL as any, { audio: b64 })) as { text?: string };
```

Re-run `npx vitest run tests/transcribe.test.ts` after any change, then commit.

---

### Task 11: Broadcast

**Files:**
- Create: `src/db/trades.ts`, `src/broadcast.ts`
- Test: `tests/broadcast.test.ts`

**Interfaces:**
- Consumes: `sendBatch`, `renderTrade`, `unsubUrl`, `Trade`, `StoredTrade`
- Produces:
  - `createDraft(db: D1Database, trade: Trade, transcript: string, now: number): Promise<StoredTrade>`
  - `findDraftByToken(db: D1Database, token: string): Promise<StoredTrade | null>`
  - `claimDraft(db: D1Database, token: string): Promise<StoredTrade | null>` — atomic `draft` to `sending`; `null` if already claimed
  - `cancelDraft(db: D1Database, token: string): Promise<void>`
  - `countApproved(db: D1Database): Promise<number>`
  - `broadcastTrade(env: Env, tradeId: number, now: number): Promise<{ sent: number; failed: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/broadcast.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcastTrade } from '../src/broadcast';
import { claimDraft, countApproved, createDraft } from '../src/db/trades';
import type { Trade } from '../src/types';

const trade: Trade = {
  pair: 'EURUSD',
  direction: 'Buy',
  entry: '1.0850',
  take_profit: '1.0920',
  stop_loss: '1.0820',
  note: null,
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
  await env.DB.prepare('DELETE FROM trades').run();
  await env.DB.prepare('DELETE FROM send_log').run();
});

afterEach(() => { vi.restoreAllMocks(); });

async function seedApproved(count: number) {
  for (let i = 0; i < count; i++) {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES (?, 'approved', ?, 1)",
    )
      .bind(`u${i}@example.com`, `tok${i}`)
      .run();
  }
}

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
}

describe('countApproved', () => {
  it('counts only approved subscribers', async () => {
    await seedApproved(3);
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES ('p@example.com', 'pending_approval', 'tokp', 1)",
    ).run();
    expect(await countApproved(env.DB)).toBe(3);
  });
});

describe('claimDraft', () => {
  it('returns the trade the first time and null the second', async () => {
    const draft = await createDraft(env.DB, trade, 'transcript', 1);
    expect(await claimDraft(env.DB, draft.draft_token)).not.toBeNull();
    expect(await claimDraft(env.DB, draft.draft_token)).toBeNull();
  });
});

describe('broadcastTrade', () => {
  it('sends to every approved subscriber and records the count', async () => {
    await seedApproved(5);
    vi.stubGlobal('fetch', okFetch());
    const draft = await createDraft(env.DB, trade, 't', 1);

    expect(await broadcastTrade(env as any, draft.id, 1000)).toEqual({ sent: 5, failed: 0 });

    const row = await env.DB.prepare('SELECT status, recipient_count FROM trades').first<any>();
    expect(row.status).toBe('sent');
    expect(row.recipient_count).toBe(5);
  });

  it('never sends to a pending, unsubscribed or bounced subscriber', async () => {
    await seedApproved(2);
    for (const s of ['pending_approval', 'unsubscribed', 'bounced']) {
      await env.DB.prepare(
        'INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES (?, ?, ?, 1)',
      )
        .bind(`${s}@example.com`, s, `tok-${s}`)
        .run();
    }
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const draft = await createDraft(env.DB, trade, 't', 1);

    expect(await broadcastTrade(env as any, draft.id, 1000)).toEqual({ sent: 2, failed: 0 });
  });

  it('chunks into batches of 100 with a stable idempotency key per chunk', async () => {
    await seedApproved(150);
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const draft = await createDraft(env.DB, trade, 't', 1);

    await broadcastTrade(env as any, draft.id, 1000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map(
      (call: any) => (call[1].headers as Record<string, string>)['Idempotency-Key'],
    );
    expect(keys).toEqual([`trade-${draft.id}-chunk-0`, `trade-${draft.id}-chunk-1`]);
  });

  it('resumes without re-sending after a mid-run failure', async () => {
    await seedApproved(150);
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 2) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    const draft = await createDraft(env.DB, trade, 't', 1);

    const first = await broadcastTrade(env as any, draft.id, 1000);
    expect(first).toEqual({ sent: 100, failed: 50 });

    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const second = await broadcastTrade(env as any, draft.id, 2000);

    expect(second).toEqual({ sent: 50, failed: 0 });
    // Only the un-sent chunk is retried - the first 100 are not re-mailed.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const total = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM send_log WHERE status = 'sent'",
    ).first<{ n: number }>();
    expect(total?.n).toBe(150);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/broadcast.test.ts
```

Expected: FAIL — cannot resolve `../src/db/trades`.

- [ ] **Step 3: Write `src/db/trades.ts`**

```ts
import type { StoredTrade, Trade } from '../types';

export async function createDraft(
  db: D1Database,
  trade: Trade,
  transcript: string,
  now: number,
): Promise<StoredTrade> {
  const token = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO trades (pair, direction, entry, take_profit, stop_loss, note, transcript, status, draft_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
       RETURNING id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token`,
    )
    .bind(
      trade.pair,
      trade.direction,
      trade.entry,
      trade.take_profit,
      trade.stop_loss,
      trade.note,
      transcript,
      token,
      now,
    )
    .first<StoredTrade>();
  return row!;
}

export async function findDraftByToken(
  db: D1Database,
  token: string,
): Promise<StoredTrade | null> {
  return db
    .prepare(
      `SELECT id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token
       FROM trades WHERE draft_token = ?`,
    )
    .bind(token)
    .first<StoredTrade>();
}

/**
 * Atomically moves draft -> sending. Returns null when the draft was already
 * claimed, which is what stops an old message being tapped twice.
 */
export async function claimDraft(db: D1Database, token: string): Promise<StoredTrade | null> {
  return db
    .prepare(
      `UPDATE trades SET status = 'sending'
       WHERE draft_token = ? AND status = 'draft'
       RETURNING id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token`,
    )
    .bind(token)
    .first<StoredTrade>();
}

export async function cancelDraft(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("UPDATE trades SET status = 'cancelled' WHERE draft_token = ? AND status = 'draft'")
    .bind(token)
    .run();
}

export async function countApproved(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'approved'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}
```

- [ ] **Step 4: Write `src/broadcast.ts`**

```ts
import type { Env, StoredTrade, Subscriber } from './types';
import { sendBatch } from './email/send';
import { renderTrade } from './email/templates';
import { unsubUrl } from './db/subscribers';

export const CHUNK_SIZE = 100;

/**
 * Sends a trade to every approved subscriber.
 *
 * Recipients are ordered by id and cut into fixed chunks, so chunk N always
 * contains the same people. The provider idempotency key is derived from
 * (trade, chunk), which means a retry after a crash cannot deliver twice even
 * if the previous attempt died after the provider accepted the batch.
 *
 * Safe to call repeatedly: already-sent recipients are excluded by send_log.
 */
export async function broadcastTrade(
  env: Env,
  tradeId: number,
  now: number,
): Promise<{ sent: number; failed: number }> {
  const trade = await env.DB.prepare(
    `SELECT id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token
     FROM trades WHERE id = ?`,
  )
    .bind(tradeId)
    .first<StoredTrade>();
  if (!trade) return { sent: 0, failed: 0 };

  const { results: recipients } = await env.DB.prepare(
    `SELECT s.id, s.email, s.status, s.unsub_token, s.created_at, s.approved_at
     FROM subscribers s
     LEFT JOIN send_log l ON l.subscriber_id = s.id AND l.trade_id = ?
     WHERE s.status = 'approved' AND (l.status IS NULL OR l.status = 'failed')
     ORDER BY s.id`,
  )
    .bind(tradeId)
    .all<Subscriber>();

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const chunk = recipients.slice(i, i + CHUNK_SIZE);

    const emails = chunk.map((s) => {
      const url = unsubUrl(env, s.unsub_token);
      const mail = renderTrade(env, trade, url);
      return { to: s.email, subject: mail.subject, html: mail.html, text: mail.text, unsubUrl: url };
    });

    const results = await sendBatch(env, emails, `trade-${tradeId}-chunk-${chunkIndex}`);

    await env.DB.batch(
      chunk.map((s, idx) =>
        env.DB.prepare(
          `INSERT INTO send_log (trade_id, subscriber_id, chunk, status, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(trade_id, subscriber_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        ).bind(tradeId, s.id, chunkIndex, results[idx]?.ok ? 'sent' : 'failed', now),
      ),
    );

    for (const r of results) r.ok ? sent++ : failed++;
  }

  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM send_log WHERE trade_id = ? AND status = 'sent'",
  )
    .bind(tradeId)
    .first<{ n: number }>();

  await env.DB.prepare(
    `UPDATE trades SET status = ?, sent_at = ?, recipient_count = ? WHERE id = ?`,
  )
    .bind(failed === 0 ? 'sent' : 'sending', now, total?.n ?? 0, tradeId)
    .run();

  return { sent, failed };
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npx vitest run tests/broadcast.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add resumable batched trade broadcast"
```

---

### Task 12: Telegram webhook wiring

**Files:**
- Create: `src/routes/telegram.ts`
- Modify: `src/index.ts`
- Test: `tests/telegram.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5, 6, 9, 10, 11
- Produces: route `POST /telegram/webhook`

Both the secret-token header **and** the chat-ID allowlist are required. Either one alone lets a stranger mail the list.

- [ ] **Step 1: Write the failing test**

Create `tests/telegram.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const SECRET = 'webhook-secret';
const OPERATOR = '555001';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
  await env.DB.prepare('DELETE FROM trades').run();
  await env.DB.prepare('DELETE FROM send_log').run();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 })),
  );
});

afterEach(() => { vi.restoreAllMocks(); });

const testEnv = () =>
  ({ ...env, TELEGRAM_WEBHOOK_SECRET: SECRET, OPERATOR_CHAT_ID: OPERATOR }) as any;

function hook(body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return worker.fetch(
    new Request('https://example.com/telegram/webhook', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    testEnv(),
    {} as ExecutionContext,
  );
}

const textUpdate = (text: string, chatId: string = OPERATOR) => ({
  message: { chat: { id: Number(chatId) }, text },
});

describe('telegram webhook security', () => {
  it('rejects a request with no secret token', async () => {
    expect((await hook(textUpdate('gold buy at 1 tp 2 sl 3'), null)).status).toBe(401);
  });

  it('rejects a request with the wrong secret token', async () => {
    expect((await hook(textUpdate('gold buy at 1 tp 2 sl 3'), 'wrong')).status).toBe(401);
  });

  it('ignores a message from a chat that is not the operator', async () => {
    const res = await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00', '999'));
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM trades').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('telegram webhook trade flow', () => {
  it('creates a draft and replies with a read-back for a valid typed trade', async () => {
    const res = await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00'));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT pair, status, entry FROM trades').first<any>();
    expect(row).toMatchObject({ pair: 'XAUUSD', status: 'draft', entry: '2350.50' });

    const calls = (globalThis.fetch as any).mock.calls;
    const sendMessage = calls.find((c: any) => String(c[0]).includes('sendMessage'));
    const body = JSON.parse(sendMessage[1].body);
    expect(body.text).toContain('Gold. Buy.');
    expect(body.parse_mode).toBeUndefined();
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
  });

  it('replies with a refusal and creates no draft when a field is unreadable', async () => {
    await hook(textUpdate('gold buy at 2350.50 tp 2360.00'));

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM trades').first<{ n: number }>();
    expect(row?.n).toBe(0);

    const calls = (globalThis.fetch as any).mock.calls;
    const sendMessage = calls.find((c: any) => String(c[0]).includes('sendMessage'));
    expect(JSON.parse(sendMessage[1].body).text).toContain('stop loss');
  });

  it('broadcasts when the send button is tapped', async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES ('a@example.com', 'approved', 'tk', 1)",
    ).run();
    await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00'));
    const draft = await env.DB.prepare('SELECT draft_token FROM trades').first<any>();

    await hook({
      callback_query: {
        id: 'cb1',
        from: { id: Number(OPERATOR) },
        message: { chat: { id: Number(OPERATOR) } },
        data: `send:${draft.draft_token}`,
      },
    });

    const row = await env.DB.prepare('SELECT status, recipient_count FROM trades').first<any>();
    expect(row.status).toBe('sent');
    expect(row.recipient_count).toBe(1);
  });

  it('refuses a second tap on the same draft', async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES ('a@example.com', 'approved', 'tk', 1)",
    ).run();
    await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00'));
    const draft = await env.DB.prepare('SELECT draft_token FROM trades').first<any>();

    const callback = {
      callback_query: {
        id: 'cb1',
        from: { id: Number(OPERATOR) },
        message: { chat: { id: Number(OPERATOR) } },
        data: `send:${draft.draft_token}`,
      },
    };
    await hook(callback);
    await hook(callback);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM send_log WHERE status = 'sent'",
    ).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('cancels a draft without sending', async () => {
    await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00'));
    const draft = await env.DB.prepare('SELECT draft_token FROM trades').first<any>();

    await hook({
      callback_query: {
        id: 'cb2',
        from: { id: Number(OPERATOR) },
        message: { chat: { id: Number(OPERATOR) } },
        data: `cancel:${draft.draft_token}`,
      },
    });

    const row = await env.DB.prepare('SELECT status FROM trades').first<any>();
    expect(row.status).toBe('cancelled');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/telegram.test.ts
```

Expected: FAIL — `/telegram/webhook` returns 404.

- [ ] **Step 3: Write `src/routes/telegram.ts`**

```ts
import { Hono } from 'hono';
import type { Env } from '../types';
import { answerCallbackQuery, sendMessage } from '../telegram/api';
import { confirmKeyboard, formatRefusal, formatTradeReadback } from '../telegram/format';
import { parseTrade } from '../trade/parse';
import { transcribeVoice } from '../transcribe';
import { cancelDraft, claimDraft, countApproved, createDraft } from '../db/trades';
import { broadcastTrade } from '../broadcast';

export const telegram = new Hono<{ Bindings: Env }>();

interface Update {
  message?: {
    chat: { id: number };
    text?: string;
    voice?: { file_id: string };
    audio?: { file_id: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number } };
    data?: string;
  };
}

telegram.post('/telegram/webhook', async (c) => {
  // Both checks are required. The header proves the request came from Telegram;
  // the chat allowlist proves it came from the operator.
  if (c.req.header('X-Telegram-Bot-Api-Secret-Token') !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text('unauthorized', 401);
  }

  const update = await c.req.json<Update>().catch(() => ({} as Update));
  const operatorId = String(c.env.OPERATOR_CHAT_ID);

  if (update.callback_query) {
    const cq = update.callback_query;
    if (String(cq.from.id) !== operatorId) return c.json({ ok: true });
    await handleCallback(c.env, cq.id, cq.message?.chat.id ?? cq.from.id, cq.data ?? '');
    return c.json({ ok: true });
  }

  const message = update.message;
  if (!message || String(message.chat.id) !== operatorId) return c.json({ ok: true });

  const fileId = message.voice?.file_id ?? message.audio?.file_id;
  let transcript: string | null = null;

  if (fileId) {
    transcript = await transcribeVoice(c.env, fileId);
    if (transcript === null) {
      await sendMessage(
        c.env,
        message.chat.id,
        'I could not hear that recording. Please record it again.',
      );
      return c.json({ ok: true });
    }
  } else if (message.text) {
    transcript = message.text;
  } else {
    return c.json({ ok: true });
  }

  const parsed = parseTrade(transcript);
  if (!parsed.ok) {
    await sendMessage(c.env, message.chat.id, formatRefusal(parsed.missing));
    return c.json({ ok: true });
  }

  const count = await countApproved(c.env.DB);
  const draft = await createDraft(c.env.DB, parsed.trade, transcript, Date.now());

  await sendMessage(
    c.env,
    message.chat.id,
    formatTradeReadback(parsed.trade, count),
    confirmKeyboard(draft.draft_token, count),
  );

  return c.json({ ok: true });
});

async function handleCallback(
  env: Env,
  callbackQueryId: string,
  chatId: number,
  data: string,
): Promise<void> {
  const [action, token] = data.split(':');
  if (!token) return;

  if (action === 'cancel') {
    await cancelDraft(env.DB, token);
    await answerCallbackQuery(env, callbackQueryId, 'Cancelled');
    await sendMessage(env, chatId, 'Cancelled. Nothing was sent.');
    return;
  }

  if (action !== 'send') return;

  // Atomic claim: a second tap finds the draft already claimed and stops here.
  const claimed = await claimDraft(env.DB, token);
  if (!claimed) {
    await answerCallbackQuery(env, callbackQueryId, 'Already handled');
    await sendMessage(env, chatId, 'That trade was already sent or cancelled.');
    return;
  }

  await answerCallbackQuery(env, callbackQueryId, 'Sending');
  const { sent, failed } = await broadcastTrade(env, claimed.id, Date.now());
  await sendMessage(env, chatId, `Sent ${sent}. Failed ${failed}.`);
}
```

- [ ] **Step 4: Mount it in `src/index.ts`**

```ts
import { telegram } from './routes/telegram';
```

```ts
app.route('/', telegram);
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npx vitest run tests/telegram.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Run the full suite**

```bash
npx vitest run
```

Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Wire Telegram webhook with auth, read-back and confirm-to-send"
```

---

### Task 13: Site form wiring

**Superseded: the honeypot field below is named `company` in this frozen brief; the
shipped implementation renamed it to `subscribe_hp`** (see `src/routes/subscribe.ts` and
`site/index.html`) because `company` is exactly the kind of field name browser/password-manager
autofill heuristics target. This brief is left as-is as the Codex handoff record; do not
implement it literally.

**Files:**
- Modify: `site/index.html`

**Interfaces:**
- Consumes: `POST /subscribe`
- Produces: nothing consumed by later tasks

**Do not change any CSS or any existing colour, font, spacing or layout rule.** Only the form markup and the script block change.

- [ ] **Step 1: Add the honeypot field and a status paragraph**

Replace the `<form>` and success paragraph block:

```html
  <form id="waitlistForm">
    <input type="email" id="email" name="email" placeholder="your@email.com" required autocomplete="email">
    <input type="text" id="company" name="company" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
    <button type="submit" id="submitBtn">Request access</button>
  </form>
  <p class="form-success" id="formSuccess">Your request has been received.</p>
  <p class="form-error" id="formError" role="alert"></p>
```

- [ ] **Step 2: Add the error style**

Add next to the existing `.form-success` rule, matching its style. Do not modify `.form-success` itself:

```css
  .form-error{
    display:none;
    max-width: 380px;
    font-family: 'Cormorant Garamond', serif;
    font-size: 17px;
    color: #e5989b;
  }
```

- [ ] **Step 3: Replace the script block**

```html
  <script>
    const ENDPOINT = 'https://masons-trade.<your-subdomain>.workers.dev/subscribe';

    const form = document.getElementById('waitlistForm');
    const success = document.getElementById('formSuccess');
    const errorEl = document.getElementById('formError');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const emailInput = document.getElementById('email');
      if(!emailInput.checkValidity()){
        emailInput.focus();
        return;
      }

      errorEl.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';

      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: emailInput.value,
            company: document.getElementById('company').value
          })
        });

        if (res.ok) {
          form.style.display = 'none';
          success.style.display = 'block';
          return;
        }

        const body = await res.json().catch(() => ({}));
        errorEl.textContent = body.error || 'Something went wrong. Please try again.';
        errorEl.style.display = 'block';
      } catch (err) {
        errorEl.textContent = 'Could not reach the server. Please try again.';
        errorEl.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Request access';
      }
    });
  </script>
```

- [ ] **Step 4: Verify manually**

```bash
npx wrangler dev
```

Open `site/index.html` in a browser with `ENDPOINT` pointed at `http://localhost:8787/subscribe`. Check: a valid address shows the success message; `a@gmial.com` shows an inline error; the page looks identical to before.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Wire site form to subscribe endpoint with real error states"
```

---

### Task 14: Deploy and connect

**Files:** none — this is configuration.

- [ ] **Step 1: Create the Telegram bot**

Message `@BotFather`, send `/newbot`, follow the prompts, and keep the token.
Get the operator's chat ID by having **him** message the bot once, then:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Read `result[0].message.chat.id`.

- [ ] **Step 2: Set the secrets**

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OPERATOR_CHAT_ID
npx wrangler secret put RESEND_API_KEY
```

`TELEGRAM_WEBHOOK_SECRET` is any random string you choose — generate one with `openssl rand -hex 32`.

- [ ] **Step 3: Apply migrations remotely and deploy**

```bash
npm run migrate:remote
npx wrangler deploy
```

- [ ] **Step 4: Register the Telegram webhook**

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://masons-trade.<subdomain>.workers.dev/telegram/webhook","secret_token":"<WEBHOOK_SECRET>"}'
```

Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`

- [ ] **Step 5: End-to-end test with DRY_RUN still on**

`DRY_RUN` is `"true"` in `wrangler.toml`, so every email goes to `TEST_INBOX` only.

1. Submit the form. Confirm the "under review" email arrives at the test inbox.
2. Have the operator send a voice note. Confirm the read-back arrives with two buttons on separate rows, and confirm **he** can navigate it with VoiceOver.
3. Tap send. Confirm the trade email arrives at the test inbox and the bot reports the count.
4. Manually age a subscriber and confirm the cron approves them:

```bash
npx wrangler d1 execute masons-trade --remote --command "UPDATE subscribers SET created_at = created_at - 200000000"
```

- [ ] **Step 6: Go live — only after the domain exists**

> **BLOCKING GATE — close the open webhook risk first.** `POST /webhooks/email` currently accepts
> unauthenticated requests, so anyone who finds the URL can mark arbitrary addresses `bounced` or
> `unsubscribed` and empty the list. This was accepted on 2026-08-03 solely because nothing was
> live. Before the first real send: add a `RESEND_WEBHOOK_SECRET` secret, verify the Svix headers
> (`svix-id`, `svix-timestamp`, `svix-signature`) on every request, and reject anything that fails.
> Do not complete the remaining steps of this task with the endpoint still open.
>
> There is a code-level failsafe backing this gate: `bounce.ts` checks `DRY_RUN` before doing
> anything else and returns `501` whenever it is not exactly `'true'`. That means bounce/complaint
> processing will simply stop working — return `501` to the provider — the moment Step 6 sets
> `DRY_RUN = "false"`, until the Svix verification above is actually implemented and this check
> is updated to depend on it instead. Treat the `501`s after go-live as the expected signal that
> this gate has not been closed yet, not as a bug to route around.

Blocked until the site owner provides the domain. Then:

1. Add the domain to the email provider and configure SPF, DKIM and DMARC.
2. Update `FROM_EMAIL` and `SITE_ORIGIN` in `wrangler.toml`.
3. Point the site's `ENDPOINT` at the deployed Worker URL.
4. Set `DRY_RUN = "false"` and redeploy.
5. Register the provider's bounce/complaint webhook against `POST /webhooks/email`.

- [ ] **Step 7: Commit any config changes**

```bash
git add -A
git commit -m "Configure deployment"
```

---

## Post-implementation

Run in this order:

1. `superpowers:requesting-code-review`
2. `/security-review` — this Worker takes public input and holds an email list
3. `/simplify`
