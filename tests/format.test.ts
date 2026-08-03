import { describe, expect, it } from 'vitest';
import { confirmKeyboard, formatRefusal, formatTradeReadback } from '../src/telegram/format';
import type { Trade } from '../src/types';

const trade: Trade = {
  pair: 'EURUSD',
  direction: 'Buy',
  entry: '1.0850',
  take_profit: '1.0920',
  stop_loss: '1.0820',
  note: null,
};

const EMOJI = /\p{Extended_Pictographic}/u;

describe('formatTradeReadback', () => {
  it('leads with the pair and direction in spoken form', () => {
    expect(formatTradeReadback(trade, 143).split('\n')[0]).toBe('Euro Dollar. Buy.');
  });

  it('lists each price on its own line', () => {
    const text = formatTradeReadback(trade, 143);
    expect(text).toContain('Entry 1.0850');
    expect(text).toContain('Take profit 1.0920');
    expect(text).toContain('Stop loss 1.0820');
  });

  it('states the recipient count', () => {
    expect(formatTradeReadback(trade, 143)).toContain('143');
  });

  it('contains no emoji and no markdown emphasis characters', () => {
    const text = formatTradeReadback(trade, 143);
    expect(EMOJI.test(text)).toBe(false);
    expect(text).not.toMatch(/[*_`~]/);
  });

  it('stays emoji-free when the trade carries a populated note', () => {
    const withNote: Trade = { ...trade, note: 'London open watch it' };
    const text = formatTradeReadback(withNote, 143);
    expect(text).toContain('Note. London open watch it');
    expect(EMOJI.test(text)).toBe(false);
    expect(text).not.toMatch(/[*_`~]/);
  });
});

describe('confirmKeyboard', () => {
  it('puts confirm and cancel on separate rows so a mistap cannot send', () => {
    const kb = confirmKeyboard('tok', 143);
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0]).toHaveLength(1);
    expect(kb.inline_keyboard[1]).toHaveLength(1);
  });

  it('uses self-describing labels, never bare Send or Cancel', () => {
    const kb = confirmKeyboard('tok', 143);
    expect(kb.inline_keyboard[0][0].text).toBe('Send to 143 subscribers');
    expect(kb.inline_keyboard[1][0].text).toBe('Cancel, do not send');
  });

  it('carries the one-time draft token in callback data', () => {
    const kb = confirmKeyboard('tok', 143);
    expect(kb.inline_keyboard[0][0].callback_data).toBe('send:tok');
    expect(kb.inline_keyboard[1][0].callback_data).toBe('cancel:tok');
  });

  it('contains no emoji in any label', () => {
    const kb = confirmKeyboard('tok', 143);
    for (const row of kb.inline_keyboard) {
      for (const button of row) expect(EMOJI.test(button.text)).toBe(false);
    }
  });
});

describe('formatRefusal', () => {
  it('names every field it could not read', () => {
    const text = formatRefusal(['take profit', 'stop loss']);
    expect(text).toContain('take profit');
    expect(text).toContain('stop loss');
  });

  it('contains no emoji', () => {
    expect(EMOJI.test(formatRefusal(['entry']))).toBe(false);
  });
});
