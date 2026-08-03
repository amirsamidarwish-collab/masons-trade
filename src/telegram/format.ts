import type { Trade } from '../types';
import { displayPair } from '../trade/pairs';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/**
 * The operator uses VoiceOver, which reads this text aloud.
 * No emoji, no markdown characters, short lines, important numbers first on each line.
 * Messages are sent WITHOUT parse_mode so Telegram renders them literally.
 */
export function formatTradeReadback(trade: Trade, recipientCount: number): string {
  const lines = [
    `${displayPair(trade.pair)}. ${trade.direction}.`,
    `Entry ${trade.entry}`,
    `Take profit ${trade.take_profit}`,
    `Stop loss ${trade.stop_loss}`,
  ];
  if (trade.note) lines.push(`Note. ${trade.note}`);
  lines.push('', `Send to ${recipientCount} subscribers?`);
  return lines.join('\n');
}

/**
 * Confirm and cancel are on SEPARATE ROWS. Side-by-side buttons are a mistap
 * away from mailing the whole list.
 */
export function confirmKeyboard(draftToken: string, recipientCount: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: `Send to ${recipientCount} subscribers`, callback_data: `send:${draftToken}` }],
      [{ text: 'Cancel, do not send', callback_data: `cancel:${draftToken}` }],
    ],
  };
}

export function formatRefusal(missing: string[]): string {
  return [
    'I could not read this trade.',
    `Missing: ${missing.join(', ')}.`,
    'Please record it again, saying the pair, buy or sell, entry, take profit and stop loss.',
  ].join('\n');
}
