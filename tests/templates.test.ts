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
    expect(m.text).toContain('does not constitute financial advice');
    expect(m.html).toContain(UNSUB);
  });

  it('trade email omits the note line entirely when there is no note', () => {
    const m = renderTrade(env, trade, UNSUB);
    expect(m.text).not.toContain('undefined');
    expect(m.text).not.toContain('null');
    expect(m.text).toContain('does not constitute financial advice');
    expect(m.html).toContain(UNSUB);
  });

  it('trade email includes the note when present', () => {
    const m = renderTrade(env, { ...trade, note: 'London session only' }, UNSUB);
    expect(m.text).toContain('London session only');
    expect(m.text).toContain('does not constitute financial advice');
    expect(m.html).toContain(UNSUB);
  });
});
