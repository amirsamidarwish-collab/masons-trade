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

  it('ignores a callback query from a chat that is not the operator', async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES ('a@example.com', 'approved', 'tk', 1)",
    ).run();
    await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00'));
    const draft = await env.DB.prepare('SELECT draft_token FROM trades').first<any>();

    const res = await hook({
      callback_query: {
        id: 'cb-intruder',
        from: { id: 999999 },
        message: { chat: { id: 999999 } },
        data: `send:${draft.draft_token}`,
      },
    });

    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT status FROM trades').first<any>();
    expect(row.status).toBe('draft');
    const sent = await env.DB.prepare('SELECT COUNT(*) AS n FROM send_log').first<{ n: number }>();
    expect(sent?.n).toBe(0);
  });

  it('returns 200 rather than 500 for a malformed update shape', async () => {
    const res = await hook({ message: { text: 'hi' } });
    expect(res.status).toBe(200);
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

  it('supersedes an unresolved draft when a new trade is recorded', async () => {
    await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00'));
    const first = await env.DB.prepare('SELECT draft_token FROM trades').first<any>();

    await hook(textUpdate('cable sell at 1.2700 tp 1.2650 sl 1.2720'));

    const stale = await env.DB.prepare('SELECT status FROM trades WHERE draft_token = ?')
      .bind(first.draft_token).first<any>();
    expect(stale.status).toBe('cancelled');
  });

  it('refuses to broadcast a superseded draft when its old button is tapped', async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES ('a@example.com', 'approved', 'tk', 1)",
    ).run();
    await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00'));
    const first = await env.DB.prepare('SELECT draft_token FROM trades').first<any>();
    await hook(textUpdate('cable sell at 1.2700 tp 1.2650 sl 1.2720'));

    await hook({
      callback_query: {
        id: 'cb-stale',
        from: { id: Number(OPERATOR) },
        message: { chat: { id: Number(OPERATOR) } },
        data: `send:${first.draft_token}`,
      },
    });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM send_log WHERE status = 'sent'").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('leaves exactly one draft live after recording two trades', async () => {
    await hook(textUpdate('gold buy at 2350.50 tp 2360.00 sl 2340.00'));
    await hook(textUpdate('cable sell at 1.2700 tp 1.2650 sl 1.2720'));

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'draft'").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
