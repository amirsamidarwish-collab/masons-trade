import type { Trade } from '../types';
import { parseSpokenNumber } from './numbers';
import { resolvePair } from './pairs';

export type ParseResult =
  | { ok: true; trade: Trade }
  | { ok: false; missing: string[] };

const TP_LABELS = ['take profit', 'takeprofit', 'tp', 'target'];
const SL_LABELS = ['stop loss', 'stoploss', 'sl', 'stop'];
const ENTRY_LABELS = ['entry', 'enter at', 'enter', 'at'];
const PRICE_LABELS = [...TP_LABELS, ...SL_LABELS];
const ALL_LABELS = [...TP_LABELS, ...SL_LABELS, ...ENTRY_LABELS, 'note'];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reads the value following a label. Takes words up to the next label or the
 * end, then hands them to parseSpokenNumber, which refuses anything ambiguous.
 */
function valueAfter(text: string, labels: string[], stopLabels: string[]): string | null {
  for (const label of labels) {
    const at = text.indexOf(` ${label} `);
    if (at === -1) continue;
    let rest = text.slice(at + label.length + 2);
    for (const stop of stopLabels) {
      const stopAt = rest.indexOf(` ${stop} `);
      if (stopAt !== -1) rest = rest.slice(0, stopAt);
    }
    const words = rest
      .split(' ')
      .slice(0, 12)
      .join(' ')
      .replace(/^(?:at|of|is|to)\s+/, '');
    const value = parseSpokenNumber(words);
    if (value !== null) return value;
    // Label present but unreadable value: refuse rather than try another label.
    return null;
  }
  return null;
}

/** Earliest index of any label's padded occurrence in text, or -1 if none is present. */
function firstLabelIndex(text: string, labels: string[]): number {
  let min = -1;
  for (const label of labels) {
    const at = text.indexOf(` ${label} `);
    if (at !== -1 && (min === -1 || at < min)) min = at;
  }
  return min;
}

const BARE_NUMBER = /(?<![a-z0-9])\d+(?:\.\d+)?(?![a-z0-9])/g;

/**
 * The note is spoken aloud by VoiceOver and rendered into the broadcast email.
 * Emoji are announced by name ("check mark button") and markdown characters are read
 * out as punctuation - both bury the prices the operator needs to hear.
 *
 * This is an allowlist, not a blacklist, because blacklisting emoji leaks: flags are
 * Regional_Indicator, keycaps are a digit plus combining marks, and skin tones are
 * Modifier_Symbol - none of which are Extended_Pictographic, and stripping only the
 * base glyph of a compound emoji leaves orphaned codepoints behind.
 *
 * Letters are matched by Unicode property, not by ASCII range, so Hebrew and any other
 * script survive intact. Symbol categories So (emoji, flags) and Sk (skin-tone
 * modifiers) and format characters Cf (ZWJ, variation selectors) all fall outside the
 * allowlist and are removed.
 */
function sanitiseNote(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N}\p{P}\p{Sc}\p{Sm}\s]/gu, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Entry is searched only in the text before the first take-profit/stop-loss
 * label, so a stray "at" inside "take profit at ..." can never be misread as
 * the entry. A labelled entry wins; failing that (and only when no entry
 * label was present at all), a single bare number in that region is
 * accepted - two or more is genuinely ambiguous and must refuse.
 */
function findEntry(text: string): string | null {
  const boundary = firstLabelIndex(text, PRICE_LABELS);
  const region = boundary === -1 ? text : `${text.slice(0, boundary)} `;

  const labelled = valueAfter(region, ENTRY_LABELS, ALL_LABELS);
  if (labelled !== null) return labelled;

  const hasEntryLabel = ENTRY_LABELS.some((label) => region.includes(` ${label} `));
  if (hasEntryLabel) return null; // present but unreadable: refuse, don't fall back

  const candidates = region.match(BARE_NUMBER) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

export function parseTrade(transcript: string): ParseResult {
  const fullText = ` ${normalise(transcript)} `;
  const noteBoundary = fullText.search(/\bnote\b/);
  // Everything after "note" is free text. Scanning it for labels means a note saying
  // "target" or "stop" silently truncates a real price and refuses a valid trade.
  const text = noteBoundary === -1 ? fullText : `${fullText.slice(0, noteBoundary)} `;
  const missing: string[] = [];

  const pair = resolvePair(text);
  if (!pair) missing.push('currency pair');

  let direction: 'Buy' | 'Sell' | null = null;
  if (/\b(buy|long)\b/.test(text)) direction = 'Buy';
  else if (/\b(sell|short)\b/.test(text)) direction = 'Sell';
  if (!direction) missing.push('direction');

  const entry = findEntry(text);
  if (entry === null) missing.push('entry');

  const takeProfit = valueAfter(text, TP_LABELS, ALL_LABELS);
  if (takeProfit === null) missing.push('take profit');

  const stopLoss = valueAfter(text, SL_LABELS, ALL_LABELS);
  if (stopLoss === null) missing.push('stop loss');

  if (missing.length > 0) return { ok: false, missing };

  const lower = transcript.toLowerCase();
  const noteAt = lower.search(/\bnote\b/);
  const rawNote =
    noteAt === -1 ? null : transcript.slice(noteAt + 4).replace(/^[\s:,.\-]+/, '').trim() || null;
  const note = rawNote === null ? null : sanitiseNote(rawNote) || null;

  return {
    ok: true,
    trade: {
      pair: pair!,
      direction: direction!,
      entry: entry!,
      take_profit: takeProfit!,
      stop_loss: stopLoss!,
      note,
    },
  };
}
