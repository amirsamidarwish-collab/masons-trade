import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendBatch } from '../src/email/send';
import type { Env } from '../src/types';
import { stubFetch, jsonResponse } from './helpers';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendBatch', () => {
  it('posts to the provider with the idempotency key and returns per-recipient results', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ data: [{ id: 'e1' }] }));

    const results = await sendBatch(baseEnv, [email], 'trade-1-chunk-0');

    expect(results).toEqual([{ to: 'real@example.com', ok: true }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails/batch');
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('trade-1-chunk-0');
    const body = JSON.parse(init?.body as string);
    expect(body[0].to).toEqual(['real@example.com']);
    expect(body[0].headers['List-Unsubscribe']).toBe('<https://masonstrade.com/unsubscribe?t=abc>');
    expect(body[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('redirects every recipient to the test inbox when DRY_RUN is on', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ data: [{ id: 'e1' }] }));

    await sendBatch({ ...baseEnv, DRY_RUN: 'true' } as Env, [email], 'k');

    const body = JSON.parse((fetchMock.mock.calls[0][1]?.body as string));
    expect(body[0].to).toEqual(['test@example.com']);
  });

  it('sends the unsubscribe headers even when the recipient is redirected by DRY_RUN', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ data: [{ id: 'e1' }] }));

    await sendBatch({ ...baseEnv, DRY_RUN: 'true' } as Env, [email], 'k');

    const body = JSON.parse((fetchMock.mock.calls[0][1]?.body as string));
    expect(body[0].headers['List-Unsubscribe']).toBe(
      '<https://masonstrade.com/unsubscribe?t=abc>',
    );
  });

  it('marks every recipient failed when the provider errors', async () => {
    stubFetch(async () => new Response('rate limited', { status: 429 }));

    const results = await sendBatch(baseEnv, [email], 'k');

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('429');
  });

  it('returns an empty array without calling the provider for an empty batch', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ data: [] }));

    expect(await sendBatch(baseEnv, [], 'k')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
