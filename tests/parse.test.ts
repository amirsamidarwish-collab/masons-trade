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
});
