import { env, applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_DELAY_MS, STUCK_BROADCAST_SWEEP_LIMIT, runApprovalSweep, runStuckBroadcastSweep } from '../src/cron';
import { broadcastTrade } from '../src/broadcast';
import { claimDraft, createDraft } from '../src/db/trades';
import type { Trade } from '../src/types';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
  await env.DB.prepare('DELETE FROM trades').run();
  await env.DB.prepare('DELETE FROM send_log').run();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse((init?.body as string) ?? '[]');
      return new Response(
        JSON.stringify({ data: payload.map((_: unknown, i: number) => ({ id: `e${i}` })) }),
        { status: 200 },
      );
    }),
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

const trade: Trade = {
  pair: 'EURUSD',
  direction: 'Buy',
  entry: '1.0850',
  take_profit: '1.0920',
  stop_loss: '1.0820',
  note: null,
};

async function seedApproved(count: number) {
  for (let i = 0; i < count; i++) {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES (?, 'approved', ?, 1)",
    )
      .bind(`s${i}@example.com`, `stok${i}`)
      .run();
  }
}

describe('runApprovalSweep', () => {
  it('approves a subscriber past the 30 hour mark', async () => {
    await seed('old@example.com', NOW - APPROVAL_DELAY_MS - 1000);

    expect(await runApprovalSweep(env as any, NOW)).toBe(1);

    const row = await env.DB.prepare('SELECT status, approved_at FROM subscribers').first<any>();
    expect(row.status).toBe('approved');
    expect(row.approved_at).toBe(NOW);
  });

  it('approves a subscriber at exactly the 30 hour mark', async () => {
    await seed('exact@example.com', NOW - APPROVAL_DELAY_MS);

    expect(await runApprovalSweep(env as any, NOW)).toBe(1);

    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('approved');
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

// I4 - a broadcast left stuck in 'sending' (a partial failure, or a crash
// before broadcastTrade ever ran) is otherwise unrecoverable: claimDraft only
// claims 'draft' rows, so nothing else can move it forward. The cron must
// sweep and resume it.
describe('runStuckBroadcastSweep', () => {
  it('completes a trade left in "sending" with unsent recipients', async () => {
    await seedApproved(2);
    const draft = await createDraft(env.DB, trade, 't', 1);
    // claimDraft alone leaves the trade 'sending' with nothing in send_log -
    // exactly the state a crash right after the button tap would produce.
    await claimDraft(env.DB, draft.draft_token);

    expect(await runStuckBroadcastSweep(env as any, NOW)).toBe(1);

    const row = await env.DB.prepare('SELECT status, recipient_count FROM trades WHERE id = ?')
      .bind(draft.id)
      .first<any>();
    expect(row.status).toBe('sent');
    expect(row.recipient_count).toBe(2);
  });

  it('does not touch a trade that already finished sending', async () => {
    await seedApproved(1);
    const draft = await createDraft(env.DB, trade, 't', 1);
    await claimDraft(env.DB, draft.draft_token);
    await broadcastTrade(env as any, draft.id, 1);

    const before = await env.DB.prepare(
      'SELECT status, sent_at, recipient_count FROM trades WHERE id = ?',
    )
      .bind(draft.id)
      .first<any>();
    expect(before.status).toBe('sent');
    const callsBefore = (globalThis.fetch as any).mock.calls.length;

    expect(await runStuckBroadcastSweep(env as any, NOW)).toBe(0);

    const after = await env.DB.prepare(
      'SELECT status, sent_at, recipient_count FROM trades WHERE id = ?',
    )
      .bind(draft.id)
      .first<any>();
    expect(after).toEqual(before);
    expect((globalThis.fetch as any).mock.calls.length).toBe(callsBefore);
  });

  it('is bounded to STUCK_BROADCAST_SWEEP_LIMIT trades per tick', async () => {
    await seedApproved(1);
    const stuckCount = STUCK_BROADCAST_SWEEP_LIMIT + 2;
    for (let i = 0; i < stuckCount; i++) {
      const draft = await createDraft(env.DB, trade, `t${i}`, 1);
      await claimDraft(env.DB, draft.draft_token);
    }

    expect(await runStuckBroadcastSweep(env as any, NOW)).toBe(STUCK_BROADCAST_SWEEP_LIMIT);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM trades WHERE status = 'sending'",
    ).first<{ n: number }>();
    expect(remaining?.n).toBe(2);
  });
});
