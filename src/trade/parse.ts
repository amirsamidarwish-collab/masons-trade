import type { Trade } from '../types';
import { parseSpokenNumber } from './numbers';
import { resolvePair } from './pairs';

export type ParseResult =
  | { ok: true; trade: Trade }
  | { ok: false; missing: string[] };

const TP_LABELS = ['take profit', 'takeprofit', 'tp', 'target'];
const SL_LABELS = ['stop loss', 'stoploss', 'sl', 'stop'];
const ENTRY_LABELS = ['entry', 'enter at', 'enter', 'at'];

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
    const words = rest.split(' ').slice(0, 12).join(' ');
    const value = parseSpokenNumber(words);
    if (value !== null) return value;
    // Label present but unreadable value: refuse rather than try another label.
    return null;
  }
  return null;
}

export function parseTrade(transcript: string): ParseResult {
  const text = ` ${normalise(transcript)} `;
  const missing: string[] = [];

  const pair = resolvePair(text);
  if (!pair) missing.push('currency pair');

  let direction: 'Buy' | 'Sell' | null = null;
  if (/\b(buy|long)\b/.test(text)) direction = 'Buy';
  else if (/\b(sell|short)\b/.test(text)) direction = 'Sell';
  if (!direction) missing.push('direction');

  const allLabels = [...TP_LABELS, ...SL_LABELS, ...ENTRY_LABELS, 'note'];
  const entry = valueAfter(text, ENTRY_LABELS, allLabels);
  if (entry === null) missing.push('entry');

  const takeProfit = valueAfter(text, TP_LABELS, allLabels);
  if (takeProfit === null) missing.push('take profit');

  const stopLoss = valueAfter(text, SL_LABELS, allLabels);
  if (stopLoss === null) missing.push('stop loss');

  if (missing.length > 0) return { ok: false, missing };

  const noteAt = text.indexOf(' note ');
  const note = noteAt === -1 ? null : transcript.slice(transcript.toLowerCase().indexOf(' note ') + 6).trim() || null;

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
