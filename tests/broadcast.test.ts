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
  // Chunking is now keyed on the subscriber's own AUTOINCREMENT id, so tests
  // that assert exact chunk splits (e.g. 100/50) need ids to start at 1 each
  // time - otherwise ids carried over from an earlier test in this file
  // shift the chunk boundaries.
  await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name IN ('subscribers', 'trades')").run();
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

/**
 * Builds a 200 response whose `data` array matches the outgoing payload's
 * length, the way sendBatch (see I2) now requires to count a chunk as sent.
 * A stub that returns a fixed-size (or empty) `data` array regardless of
 * payload size would misreport delivery - that's the exact hazard I2 fixes.
 */
function sizedOkResponse(init?: RequestInit): Response {
  const payload = JSON.parse((init?.body as string) ?? '[]');
  return new Response(
    JSON.stringify({ data: payload.map((_: unknown, i: number) => ({ id: `e${i}` })) }),
    { status: 200 },
  );
}

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => sizedOkResponse(init));
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
    await claimDraft(env.DB, draft.draft_token);

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
    await claimDraft(env.DB, draft.draft_token);

    expect(await broadcastTrade(env as any, draft.id, 1000)).toEqual({ sent: 2, failed: 0 });
  });

  it('chunks into batches of 100 with a stable idempotency key per chunk', async () => {
    await seedApproved(150);
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const draft = await createDraft(env.DB, trade, 't', 1);
    await claimDraft(env.DB, draft.draft_token);

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
      vi.fn(async (_url: string, init?: RequestInit) => {
        call++;
        if (call === 2) return new Response('boom', { status: 500 });
        return sizedOkResponse(init);
      }),
    );
    const draft = await createDraft(env.DB, trade, 't', 1);
    await claimDraft(env.DB, draft.draft_token);

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

  it('keeps chunk membership stable when a subscriber leaves between runs', async () => {
    await seedApproved(150);
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        call++;
        if (call === 2) return new Response('boom', { status: 500 });
        return sizedOkResponse(init);
      }),
    );
    const draft = await createDraft(env.DB, trade, 't', 1);
    await claimDraft(env.DB, draft.draft_token);
    await broadcastTrade(env as any, draft.id, 1000);

    await env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'u49@example.com'",
    ).run();

    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await broadcastTrade(env as any, draft.id, 2000);

    const keys = fetchMock.mock.calls.map(
      (c: any) => (c[1].headers as Record<string, string>)['Idempotency-Key'],
    );
    expect(keys).not.toContain(`trade-${draft.id}-chunk-0`);
  });

  it('does not send for a trade that was never claimed', async () => {
    await seedApproved(3);
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const draft = await createDraft(env.DB, trade, 't', 1);

    expect(await broadcastTrade(env as any, draft.id, 1000)).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// I2 - a 2xx status alone does not prove delivery. sendBatch must check the
// provider's `data` array against the payload size, and broadcastTrade must
// treat a mismatch as a failed chunk, not a sent one.
describe('provider response verification (I2)', () => {
  it('fails an entire chunk, and leaves the trade resumable, when the provider confirms fewer recipients than were sent', async () => {
    await seedApproved(5);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ data: [{ id: 'only-one' }] }), { status: 200 }),
      ),
    );
    const draft = await createDraft(env.DB, trade, 't', 1);
    await claimDraft(env.DB, draft.draft_token);

    expect(await broadcastTrade(env as any, draft.id, 1000)).toEqual({ sent: 0, failed: 5 });

    const row = await env.DB.prepare('SELECT status, recipient_count FROM trades').first<any>();
    // failed > 0, so the trade stays 'sending' (resumable) rather than 'sent'.
    expect(row.status).toBe('sending');
    expect(row.recipient_count).toBe(0);

    const failedLog = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM send_log WHERE trade_id = ? AND status = 'failed'",
    )
      .bind(draft.id)
      .first<{ n: number }>();
    expect(failedLog?.n).toBe(5);
  });
});

// I3 - send_log must be written before the provider is called (write-ahead),
// and a recipient left 'pending' by a crashed run must be retried, not
// stranded.
describe('send_log write-ahead (I3)', () => {
  it('writes pending send_log rows before the provider call returns', async () => {
    await seedApproved(3);
    const draft = await createDraft(env.DB, trade, 't', 1);
    await claimDraft(env.DB, draft.draft_token);

    let pendingDuringCall = -1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM send_log WHERE trade_id = ? AND status = 'pending'",
        )
          .bind(draft.id)
          .first<{ n: number }>();
        pendingDuringCall = row?.n ?? 0;
        return sizedOkResponse(init);
      }),
    );

    await broadcastTrade(env as any, draft.id, 1000);

    expect(pendingDuringCall).toBe(3);
  });

  it('retries a recipient left pending by a crashed run on the next call', async () => {
    await seedApproved(2);
    const draft = await createDraft(env.DB, trade, 't', 1);
    await claimDraft(env.DB, draft.draft_token);

    const subscriber = await env.DB.prepare('SELECT id FROM subscribers ORDER BY id LIMIT 1').first<{
      id: number;
    }>();
    // Simulate a crashed run: the write-ahead 'pending' row was written but
    // the process died before the provider call resolved it to 'sent' or
    // 'failed'.
    await env.DB.prepare(
      `INSERT INTO send_log (trade_id, subscriber_id, chunk, status, updated_at) VALUES (?, ?, 0, 'pending', 500)`,
    )
      .bind(draft.id, subscriber!.id)
      .run();

    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const result = await broadcastTrade(env as any, draft.id, 1000);

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload).toHaveLength(2);

    const row = await env.DB.prepare(
      'SELECT status FROM send_log WHERE trade_id = ? AND subscriber_id = ?',
    )
      .bind(draft.id, subscriber!.id)
      .first<any>();
    expect(row.status).toBe('sent');
  });
});
