import { describe, expect, it } from 'vitest';
import { displayPair, resolvePair } from '../src/trade/pairs';

describe('resolvePair', () => {
  it.each([
    ['euro dollar', 'EURUSD'],
    ['eurusd', 'EURUSD'],
    ['eur usd', 'EURUSD'],
    ['cable', 'GBPUSD'],
    ['pound dollar', 'GBPUSD'],
    ['gold', 'XAUUSD'],
    ['dollar yen', 'USDJPY'],
    ['nasdaq', 'NAS100'],
  ])('resolves %s', (input, expected) => {
    expect(resolvePair(input)).toBe(expected);
  });

  it('finds the pair inside a full sentence', () => {
    expect(resolvePair('euro dollar buy at 1.0850 take profit 1.0920')).toBe('EURUSD');
  });

  it('returns null when no pair is present', () => {
    expect(resolvePair('buy at 1.0850')).toBe(null);
  });
});

describe('displayPair', () => {
  it('returns a spoken-friendly name', () => {
    expect(displayPair('EURUSD')).toBe('Euro Dollar');
    expect(displayPair('XAUUSD')).toBe('Gold');
  });

  it('falls back to the symbol for anything unmapped', () => {
    expect(displayPair('EURNZD')).toBe('EURNZD');
  });
});
