const WORD_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

const POINT_WORDS = new Set(['point', 'dot', 'decimal']);

/**
 * Returns the number as a STRING so that trailing zeros survive.
 * `1.0850` must never become `1.085`.
 *
 * Returns null whenever the input is not unambiguously a number. Refusing is
 * the correct outcome - a guessed price reaches every subscriber.
 */
export function parseSpokenNumber(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;

  const tokens = trimmed.split(/[\s-]+/).filter(Boolean);
  let out = '';
  let seenPoint = false;
  // Two consecutive numeral tokens ("2340 2350") are the operator correcting
  // himself mid-sentence, not one number - gluing them into "23402350" is
  // exactly the kind of guess this parser must never make.
  let prevWasNumeral = false;

  for (const token of tokens) {
    if (POINT_WORDS.has(token)) {
      if (seenPoint) return null;
      seenPoint = true;
      out += '.';
      prevWasNumeral = false;
      continue;
    }
    if (/^\d+$/.test(token)) {
      if (prevWasNumeral) return null;
      out += token;
      prevWasNumeral = true;
      continue;
    }
    const digit = WORD_DIGITS[token];
    if (digit === undefined) return null;
    out += digit;
    prevWasNumeral = false;
  }

  if (out.length === 0 || out === '.') return null;
  if (out.startsWith('.') || out.endsWith('.')) return null;
  return out;
}

/** A token that can form part of a spoken number. */
export function isNumberToken(token: string): boolean {
  return /^\d+(\.\d+)?$/.test(token) || token in WORD_DIGITS || POINT_WORDS.has(token);
}

/**
 * Reads the leading run of number tokens and returns the rest untouched.
 * Trailing chatter ("2340 send it") must not refuse a trade, but a second
 * number ("2360 2370") must - that is the operator correcting himself, and
 * guessing which one he meant is exactly what this parser must never do.
 */
export function takeLeadingNumber(text: string): { value: string | null; rest: string } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const run: string[] = [];
  for (const t of tokens) {
    if (!isNumberToken(t)) break;
    run.push(t);
  }
  const value = run.length > 0 ? parseSpokenNumber(run.join(' ')) : null;
  return { value, rest: tokens.slice(run.length).join(' ') };
}
