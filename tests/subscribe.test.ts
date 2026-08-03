import { env, applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hashIp } from '../src/validate';
import { stubFetch } from './helpers';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
  fetchMock = stubFetch(async (url) => {
    if (String(url).includes('dns-query')) {
      return new Response(JSON.stringify({ Answer: [{ type: 15 }] }));
    }
    return new Response(JSON.stringify({ data: [{ id: 'e1' }] }), { status: 200 });
  });
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
    const res = await post({ email: 'bot@example.com', subscribe_hp: 'spam' });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('does not treat a stray company field as the honeypot', async () => {
    const res = await post({ email: 'real@example.com', company: 'Acme Ltd' }, '203.0.113.99');
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers').first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('returns an identical response for a duplicate, so the list cannot be enumerated', async () => {
    const first = await post({ email: 'dupe@example.com' });
    const second = await post({ email: 'dupe@example.com' });

    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(await first.text());

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers').first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('rate limits a single IP after five signups', async () => {
    for (let i = 0; i < 5; i++) await post({ email: `u${i}@example.com` });
    expect((await post({ email: 'u5@example.com' })).status).toBe(429);
  });

  it('rejects at the edge limiter before performing an MX lookup', async () => {
    const ip = '198.51.100.7';
    const ipHash = await hashIp(ip);

    // Exhaust the edge limiter's budget directly via the binding, without
    // going through the HTTP endpoint, so this test isolates the limiter
    // check itself rather than depending on 20 round trips through Hono.
    for (let i = 0; i < 20; i++) {
      const result = await env.SUBSCRIBE_LIMITER.limit({ key: ipHash });
      expect(result.success).toBe(true);
    }

    const res = await post({ email: 'blocked@example.com' }, ip);
    expect(res.status).toBe(429);

    const dnsQueries = fetchMock.mock.calls.filter(([url]) => String(url).includes('dns-query'));
    expect(dnsQueries).toHaveLength(0);

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

// I5 - an unsubscribed or bounced address must be able to rejoin, but the
// response body must stay identical to a fresh signup in every case (no
// account enumeration). Each test below uses its own IP: this file shares an
// edge-limiter budget on the default IP across all its tests.
describe('resubscription after unsubscribe or bounce', () => {
  it('resets an unsubscribed address to pending_approval and mails it again, with a response byte-identical to a new signup', async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES ('rejoin@example.com', 'unsubscribed', 'old-token', 1)",
    ).run();

    const control = await post({ email: 'control-signup@example.com' }, '203.0.113.201');
    const res = await post({ email: 'rejoin@example.com' }, '203.0.113.202');

    expect(res.status).toBe(control.status);
    expect(await res.text()).toBe(await control.text());

    const row = await env.DB.prepare(
      "SELECT status, unsub_token, approved_at FROM subscribers WHERE email = 'rejoin@example.com'",
    ).first<any>();
    expect(row.status).toBe('pending_approval');
    expect(row.unsub_token).not.toBe('old-token');
    expect(row.approved_at).toBeNull();

    // One under-review email for the control signup, one for the reset.
    const emailCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('dns-query'));
    expect(emailCalls).toHaveLength(2);
  });

  it('resets a bounced address to pending_approval on re-signup', async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at) VALUES ('bounced-again@example.com', 'bounced', 'old-token-2', 1)",
    ).run();

    const res = await post({ email: 'bounced-again@example.com' }, '203.0.113.203');
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT status FROM subscribers WHERE email = 'bounced-again@example.com'",
    ).first<any>();
    expect(row.status).toBe('pending_approval');

    const emailCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('dns-query'));
    expect(emailCalls).toHaveLength(1);
  });

  it('does not reset or re-mail an address that is already pending_approval or approved', async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, status, unsub_token, created_at, approved_at) VALUES ('already@example.com', 'approved', 'kept-token', 1, 5)",
    ).run();

    const res = await post({ email: 'already@example.com' }, '203.0.113.204');
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT status, unsub_token, approved_at FROM subscribers WHERE email = 'already@example.com'",
    ).first<any>();
    expect(row.status).toBe('approved');
    expect(row.unsub_token).toBe('kept-token');
    expect(row.approved_at).toBe(5);

    const emailCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('dns-query'));
    expect(emailCalls).toHaveLength(0);
  });
});
