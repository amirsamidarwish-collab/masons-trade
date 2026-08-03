import { describe, expect, it } from 'vitest';
import { parseTrade } from '../src/trade/parse';

describe('parseTrade', () => {
  it('parses a fully spoken transcript', () => {
    const result = parseTrade(
      'euro dollar buy at one point zero eight five zero take profit one point zero nine two zero stop loss one point zero eight two zero',
    );
    expect(result).toEqual({
      ok: true,
      trade: {
        pair: 'EURUSD',
        direction: 'Buy',
        entry: '1.0850',
        take_profit: '1.0920',
        stop_loss: '1.0820',
        note: null,
      },
    });
  });

  it('parses a digit transcript with abbreviations', () => {
    const result = parseTrade('gold sell entry 2350.50 tp 2340.00 sl 2360.00');
    expect(result).toEqual({
      ok: true,
      trade: {
        pair: 'XAUUSD',
        direction: 'Sell',
        entry: '2350.50',
        take_profit: '2340.00',
        stop_loss: '2360.00',
        note: null,
      },
    });
  });

  it('treats long as Buy and short as Sell', () => {
    const long = parseTrade('cable long at 1.2700 tp 1.2750 sl 1.2680');
    expect(long.ok && long.trade.direction).toBe('Buy');
    const short = parseTrade('cable short at 1.2700 tp 1.2650 sl 1.2720');
    expect(short.ok && short.trade.direction).toBe('Sell');
  });

  it('reports the missing field rather than guessing when stop loss is absent', () => {
    const result = parseTrade('euro dollar buy at 1.0850 take profit 1.0920');
    expect(result).toEqual({ ok: false, missing: ['stop loss'] });
  });

  it('reports every missing field at once', () => {
    const result = parseTrade('something inaudible');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.missing).toEqual([
      'currency pair',
      'direction',
      'entry',
      'take profit',
      'stop loss',
    ]);
  });

  it('refuses when a labelled price is not a readable number', () => {
    const result = parseTrade('euro dollar buy at 1.0850 take profit around there sl 1.0820');
    expect(result).toEqual({ ok: false, missing: ['take profit'] });
  });

  it('captures a trailing note after the last price', () => {
    const result = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note London session only');
    expect(result.ok && result.trade.note).toBe('London session only');
  });

  it('returns a null note when the transcript merely trails off on the word note', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note');
    expect(r.ok && r.trade.note).toBe(null);
  });

  it('reads a note introduced with punctuation or mixed case', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 Note: London session');
    expect(r.ok && r.trade.note).toBe('London session');
  });

  it('parses prices spoken as "take profit at X"', () => {
    expect(parseTrade('euro dollar buy at 1.0850 take profit at 1.0920 stop loss at 1.0820')).toEqual({
      ok: true,
      trade: { pair: 'EURUSD', direction: 'Buy', entry: '1.0850', take_profit: '1.0920', stop_loss: '1.0820', note: null },
    });
  });

  it('accepts a single unlabelled entry price before the first take profit label', () => {
    const r = parseTrade('gold buy 2350.50 take profit 2360.00 stop loss 2340.00');
    expect(r.ok && r.trade.entry).toBe('2350.50');
  });

  it('refuses when the entry region contains two candidate numbers', () => {
    const r = parseTrade('euro dollar buy 1.0850 1.0900 take profit 1.0920 stop loss 1.0820');
    expect(r).toEqual({ ok: false, missing: ['entry'] });
  });

  it('does not mistake the digits in an index symbol for a price', () => {
    const r = parseTrade('nas100 buy 18000 take profit 18200 stop loss 17900');
    expect(r.ok && r.trade.entry).toBe('18000');
  });
});
