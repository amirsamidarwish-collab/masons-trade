import { describe, expect, it } from 'vitest';
import { parseSpokenNumber } from '../src/trade/numbers';

describe('parseSpokenNumber', () => {
  it('passes through a digit form unchanged, keeping trailing zeros', () => {
    expect(parseSpokenNumber('1.0850')).toBe('1.0850');
  });

  it('parses fully spelled digits', () => {
    expect(parseSpokenNumber('one point zero eight five zero')).toBe('1.0850');
  });

  it('treats "oh" as zero', () => {
    expect(parseSpokenNumber('one point oh eight five oh')).toBe('1.0850');
  });

  it('parses a whole number', () => {
    expect(parseSpokenNumber('two thousand three hundred')).toBe(null);
    expect(parseSpokenNumber('2300')).toBe('2300');
  });

  it('parses a mixed digit and word form', () => {
    expect(parseSpokenNumber('1 point zero nine two zero')).toBe('1.0920');
  });

  it('returns null for anything it cannot read confidently', () => {
    expect(parseSpokenNumber('somewhere around one ish')).toBe(null);
    expect(parseSpokenNumber('')).toBe(null);
    expect(parseSpokenNumber('point')).toBe(null);
  });

  it('returns null for two decimal points', () => {
    expect(parseSpokenNumber('one point zero point five')).toBe(null);
  });

  it('refuses two adjacent numerals rather than gluing them together', () => {
    expect(parseSpokenNumber('2340 2350')).toBe(null);
  });

  it('still concatenates spoken word digits', () => {
    expect(parseSpokenNumber('two three four five')).toBe('2345');
  });

  it('still parses a numeral followed by a point word', () => {
    expect(parseSpokenNumber('2340 point 50')).toBe('2340.50');
  });
});
