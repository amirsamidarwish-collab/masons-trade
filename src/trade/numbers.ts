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

  for (const token of tokens) {
    if (POINT_WORDS.has(token)) {
      if (seenPoint) return null;
      seenPoint = true;
      out += '.';
      continue;
    }
    if (/^\d+$/.test(token)) {
      out += token;
      continue;
    }
    const digit = WORD_DIGITS[token];
    if (digit === undefined) return null;
    out += digit;
  }

  if (out.length === 0 || out === '.') return null;
  if (out.startsWith('.') || out.endsWith('.')) return null;
  return out;
}
