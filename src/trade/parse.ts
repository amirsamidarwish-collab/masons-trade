import type { Trade } from '../types';
import { isNumberToken, takeLeadingNumber } from './numbers';
import { resolvePair } from './pairs';

export type ParseResult =
  | { ok: true; trade: Trade }
  | { ok: false; missing: string[] };

const TP_LABELS = ['take profit', 'takeprofit', 'tp', 'target'];
const SL_LABELS = ['stop loss', 'stoploss', 'sl', 'stop'];
const ENTRY_LABELS = ['entry', 'enter at', 'enter', 'at'];
const PRICE_LABELS = [...TP_LABELS, ...SL_LABELS];
const ALL_LABELS = [...TP_LABELS, ...SL_LABELS, ...ENTRY_LABELS, 'note'];
const FILLER_WORDS = new Set(['at', 'of', 'is', 'to']);
const STOP_PRECEDERS = new Set(['buy', 'sell', 'long', 'short']);

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[,!?;:]/g, ' ')
    // A period not followed by a digit is sentence punctuation (Whisper adds a
    // trailing one), not a decimal point, and must not survive into a price.
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Index of the next padded occurrence of `label` in `text`, or -1 if absent.
 * "buy stop" / "sell stop" are standard pending-order phrasing, not a
 * stop-loss label, so a bare "stop" occurrence immediately preceded by
 * buy/sell/long/short is skipped in favour of a later, genuine occurrence.
 */
function indexOfLabel(text: string, label: string): number {
  let at = text.indexOf(` ${label} `);
  if (label !== 'stop') return at;
  while (at !== -1) {
    const before = text.slice(0, at).trimEnd();
    const prevWord = before.slice(before.lastIndexOf(' ') + 1);
    if (!STOP_PRECEDERS.has(prevWord)) return at;
    at = text.indexOf(` ${label} `, at + 1);
  }
  return -1;
}

/** Strips leading filler words ("is at", "of") so chained fillers all fall away. */
function stripLeadingFillers(text: string): string {
  const tokens = text.split(' ').filter(Boolean);
  let i = 0;
  while (i < tokens.length && FILLER_WORDS.has(tokens[i])) i++;
  return tokens.slice(i).join(' ');
}

/**
 * Reads the value following a label. Takes the leading run of number tokens
 * after the label (and any stop label), then hands them to parseSpokenNumber.
 * Trailing chatter ("2340 send it") is accepted; a further numeric token
 * ("2360 2370") is the operator correcting himself and must refuse rather
 * than guess which price he meant.
 */
function valueAfter(text: string, labels: string[], stopLabels: string[]): string | null {
  for (const label of labels) {
    const at = indexOfLabel(text, label);
    if (at === -1) continue;
    let rest = text.slice(at + label.length + 2);
    // Strip fillers before hunting for a stop label: ALL_LABELS includes the
    // bare entry label "at", so an unstripped "is at 2360" would be cut at
    // its own trailing "at" and truncated to nothing before it ever reaches
    // the number.
    rest = stripLeadingFillers(rest);
    for (const stop of stopLabels) {
      const stopAt = indexOfLabel(rest, stop);
      if (stopAt !== -1) rest = rest.slice(0, stopAt);
    }
    const words = rest.split(' ').slice(0, 12).join(' ');
    const { value, rest: afterNumber } = takeLeadingNumber(words);
    if (value !== null) {
      const trailing = afterNumber.split(/\s+/).filter(Boolean);
      if (trailing.some(isNumberToken)) return null;
      return value;
    }
    // Label present but unreadable value: refuse rather than try another label.
    return null;
  }
  return null;
}

/** Earliest index of any label's padded occurrence in text, or -1 if none is present. */
function firstLabelIndex(text: string, labels: string[]): number {
  let min = -1;
  for (const label of labels) {
    const at = indexOfLabel(text, label);
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
 *
 * The allowlist alone is not enough: Sm/Sc were widened in so a note can say "$" or
 * "+20 pips", but seven codepoints are both Sm/Sc and genuine emoji - U+2194, U+25FB-FE,
 * U+2934/U+2935 - so they survived the first pass. A second, unconditional pass strips
 * anything Extended_Pictographic regardless of category; it cannot reopen the
 * flag/keycap/skin-tone leaks the first pass already closed, since those codepoints are
 * already gone by the time this pass runs. NFC normalisation runs first so a base letter
 * plus a combining accent (outside the allowlist as \p{M}) is precomposed into a single
 * accented letter before the allowlist strips anything - otherwise "café" typed in
 * decomposed form would lose its accent.
 */
function sanitiseNote(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{P}\p{Sc}\p{Sm}\s]/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
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
  // Whisper routinely hears "buy" as "by". Only trusted when no explicit
  // direction word appears, so "sell by tomorrow" can never become a Buy.
  else if (/\bby\b/.test(text)) direction = 'Buy';
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
