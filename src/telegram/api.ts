import type { Env } from '../types';
import type { InlineKeyboard } from './format';

function apiUrl(env: Env, method: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/** Sent without parse_mode on purpose - see format.ts. */
export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await fetch(apiUrl(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }),
  });
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  await fetch(apiUrl(env, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function getFileUrl(env: Env, fileId: string): Promise<string | null> {
  const res = await fetch(apiUrl(env, 'getFile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!body.ok || !body.result?.file_path) return null;
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${body.result.file_path}`;
}
