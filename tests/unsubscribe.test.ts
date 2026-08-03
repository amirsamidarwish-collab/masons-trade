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
  it('does not unsubscribe on GET, only offers a confirm button', async () => {
    const res = await call('/unsubscribe?t=tok123');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<form method="POST"');

    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('approved');
  });

  it('accepts a one-click POST from a mail client', async () => {
    expect((await call('/unsubscribe?t=tok123', 'POST')).status).toBe(200);
    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('unsubscribed');
  });

  it('returns 404 for an unknown token', async () => {
    expect((await call('/unsubscribe?t=nope')).status).toBe(404);
  });

  it('returns 404 for an unknown token on GET without disclosing anything', async () => {
    const res = await call('/unsubscribe?t=nope');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('<form');
    expect(body).not.toContain('Unsubscribe');
  });

  it('is safe to POST twice', async () => {
    expect((await call('/unsubscribe?t=tok123', 'POST')).status).toBe(200);
    expect((await call('/unsubscribe?t=tok123', 'POST')).status).toBe(200);

    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('unsubscribed');
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

  it('refuses to process webhooks once DRY_RUN is off, until signatures are verified', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/webhooks/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'email.bounced', data: { to: ['a@example.com'] } }),
      }),
      { ...env, DRY_RUN: 'false' } as any,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(501);

    const row = await env.DB.prepare('SELECT status FROM subscribers').first<any>();
    expect(row.status).toBe('approved');
  });
});
