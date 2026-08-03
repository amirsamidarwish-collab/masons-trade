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
