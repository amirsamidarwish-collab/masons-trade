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

  it('strips markdown characters from a note', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note *important* check_this');
    expect(r.ok && r.trade.note).toBe('important checkthis');
  });

  it('treats a note that is only emoji as no note at all', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note 🔥🔥');
    expect(r.ok && r.trade.note).toBe(null);
  });

  it('strips flag emoji, which are not Extended_Pictographic', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note watch 🇺🇸 open');
    expect(r.ok && r.trade.note).toBe('watch open');
  });

  it('strips keycap sequences without leaving the combining mark', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note tier 1️⃣ setup');
    expect(r.ok && r.trade.note).toBe('tier 1 setup');
  });

  it('strips a compound emoji without leaving an orphaned skin tone modifier', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note nice 👍🏽 one');
    expect(r.ok && r.trade.note).toBe('nice one');
  });

  it('strips zero width joiner sequences completely', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note family 👨‍👩‍👧‍👦 time');
    expect(r.ok && r.trade.note).toBe('family time');
  });

  it('preserves Hebrew text in a note', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note בדיקה מהירה');
    expect(r.ok && r.trade.note).toBe('בדיקה מהירה');
  });

  it('preserves currency and arithmetic symbols in a note', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note target +20 pips at $2360');
    expect(r.ok && r.trade.note).toBe('target +20 pips at $2360');
  });

  it('does not let label words inside a note disturb price parsing', () => {
    expect(parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note stop watching the entry at tp')).toEqual({
      ok: true,
      trade: {
        pair: 'XAUUSD',
        direction: 'Buy',
        entry: '2350.50',
        take_profit: '2360.00',
        stop_loss: '2340.00',
        note: 'stop watching the entry at tp',
      },
    });
  });

  it('strips emoji that are also math symbols, which the allowlist would otherwise keep', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note reversal ⤴️ then ⤵️ later');
    expect(r.ok && r.trade.note).toBe('reversal then later');
  });

  it('keeps genuine math and currency notation', () => {
    const r = parseTrade('gold buy at 2350.50 tp 2360.00 sl 2340.00 note risk ±20 at $2360 → hold');
    expect(r.ok && r.trade.note).toBe('risk ±20 at $2360 → hold');
  });

  it('preserves accented text regardless of composition form', () => {
    const decomposed = 'gold buy at 2350.50 tp 2360.00 sl 2340.00 note café open';
    const r = parseTrade(decomposed);
    expect(r.ok && r.trade.note).toBe('café open');
  });

  it('parses a real Whisper transcript, mishearings and punctuation included', () => {
    expect(parseTrade('Eurodollar by at 1.0850, stop loss 1.0800, take profit 1.0900.')).toEqual({
      ok: true,
      trade: {
        pair: 'EURUSD',
        direction: 'Buy',
        entry: '1.0850',
        take_profit: '1.0900',
        stop_loss: '1.0800',
        note: null,
      },
    });
  });

  it('never reads "by" as Buy when an explicit direction is present', () => {
    const r = parseTrade('gold sell by market at 2350.50 tp 2340.00 sl 2360.00');
    expect(r.ok && r.trade.direction).toBe('Sell');
  });

  it('refuses a self-corrected price instead of inventing one', () => {
    const r = parseTrade('gold buy at 2350 take profit 2360 2370 stop loss 2340');
    expect(r).toEqual({ ok: false, missing: ['take profit'] });
  });

  it('accepts trailing chatter after the last price', () => {
    const r = parseTrade('gold buy at 2350 take profit 2360 stop loss 2340 send it');
    expect(r.ok && r.trade.stop_loss).toBe('2340');
  });

  it('accepts a unit word after a price', () => {
    const r = parseTrade('gold buy at 2350 take profit 2360 stop loss 2340 pips');
    expect(r.ok && r.trade.stop_loss).toBe('2340');
  });

  it('handles chained filler words before a price', () => {
    const r = parseTrade('gold buy at 2350 take profit is at 2360 stop loss 2340');
    expect(r.ok && r.trade.take_profit).toBe('2360');
  });

  it('parses a buy stop pending order without losing the entry', () => {
    const r = parseTrade('gold buy stop at 2350 take profit 2360 stop loss 2340');
    expect(r.ok && r.trade.entry).toBe('2350');
  });
});
