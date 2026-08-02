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
