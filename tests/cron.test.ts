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
