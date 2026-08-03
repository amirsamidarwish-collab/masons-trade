import type { Env } from '../types';
import type { InlineKeyboard } from './format';

function apiUrl(env: Env, method: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/**
 * Sent without parse_mode on purpose - see format.ts.
 * Returns whether Telegram accepted the call rather than throwing, since this runs inside
 * the webhook handler: an exception there would return a 500 to Telegram, which retries the
 * update and would reprocess the same trade. The caller decides what to do with a false.
 * The fetch itself is caught too - a DNS failure or subrequest error is exactly as capable
 * of causing that retry loop as a non-ok HTTP response is. The caught error is never logged:
 * nothing in this file should ever log a URL, since these URLs carry the bot token.
 */
export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(env, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** See sendMessage above - same reasoning for returning a boolean instead of throwing. */
export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text: string,
): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(env, 'answerCallbackQuery'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** See sendMessage above - same reasoning for catching the fetch instead of letting it throw. */
export async function getFileUrl(env: Env, fileId: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl(env, 'getFile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
    if (!body.ok || !body.result?.file_path) return null;
    return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${body.result.file_path}`;
  } catch {
    return null;
  }
}
