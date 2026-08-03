import { Hono } from 'hono';
import type { Env } from '../types';
import { answerCallbackQuery, sendMessage } from '../telegram/api';
import { confirmKeyboard, formatRefusal, formatTradeReadback } from '../telegram/format';
import { parseTrade } from '../trade/parse';
import { transcribeVoice } from '../transcribe';
import {
  cancelDraft,
  claimDraft,
  countApproved,
  createDraftSupersedingOthers,
} from '../db/trades';
import { broadcastTrade } from '../broadcast';

export const telegram = new Hono<{ Bindings: Env }>();

interface Update {
  message?: {
    chat?: { id: number };
    text?: string;
    voice?: { file_id: string };
    audio?: { file_id: string };
  };
  callback_query?: {
    id: string;
    from?: { id: number };
    message?: { chat?: { id: number } };
    data?: string;
  };
}

telegram.post('/telegram/webhook', async (c) => {
  // Both checks are required. The header proves the request came from Telegram;
  // the chat allowlist proves it came from the operator.
  if (c.req.header('X-Telegram-Bot-Api-Secret-Token') !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text('unauthorized', 401);
  }

  const update = await c.req.json<Update>().catch(() => ({} as Update));
  const operatorId = String(c.env.OPERATOR_CHAT_ID);

  if (update.callback_query) {
    const cq = update.callback_query;
    if (String(cq.from?.id) !== operatorId) return c.json({ ok: true });
    const chatId = cq.message?.chat?.id ?? cq.from?.id;
    if (chatId === undefined) return c.json({ ok: true });
    await handleCallback(c.env, cq.id, chatId, cq.data ?? '');
    return c.json({ ok: true });
  }

  const message = update.message;
  if (!message) return c.json({ ok: true });
  const chatId = message.chat?.id;
  if (chatId === undefined || String(chatId) !== operatorId) return c.json({ ok: true });

  const fileId = message.voice?.file_id ?? message.audio?.file_id;
  let transcript: string | null = null;

  if (fileId) {
    transcript = await transcribeVoice(c.env, fileId);
    if (transcript === null) {
      await sendMessage(
        c.env,
        chatId,
        'I could not hear that recording. Please record it again.',
      );
      return c.json({ ok: true });
    }
  } else if (message.text) {
    transcript = message.text;
  } else {
    return c.json({ ok: true });
  }

  const parsed = parseTrade(transcript);
  if (!parsed.ok) {
    await sendMessage(c.env, chatId, formatRefusal(parsed.missing));
    return c.json({ ok: true });
  }

  const count = await countApproved(c.env.DB);
  // Supersede-and-insert run as one D1 batch (one transaction) - done as two
  // separate statements, concurrent voice notes could both find nothing to
  // cancel and both insert, leaving two live Send buttons.
  const draft = await createDraftSupersedingOthers(c.env.DB, parsed.trade, transcript, Date.now());

  await sendMessage(
    c.env,
    chatId,
    formatTradeReadback(parsed.trade, count),
    confirmKeyboard(draft.draft_token, count),
  );

  return c.json({ ok: true });
});

async function handleCallback(
  env: Env,
  callbackQueryId: string,
  chatId: number,
  data: string,
): Promise<void> {
  const [action, token] = data.split(':');
  if (!token) return;

  if (action === 'cancel') {
    await cancelDraft(env.DB, token);
    await answerCallbackQuery(env, callbackQueryId, 'Cancelled');
    await sendMessage(env, chatId, 'Cancelled. Nothing was sent.');
    return;
  }

  if (action !== 'send') return;

  // Atomic claim: a second tap finds the draft already claimed and stops here.
  const claimed = await claimDraft(env.DB, token);
  if (!claimed) {
    await answerCallbackQuery(env, callbackQueryId, 'Already handled');
    await sendMessage(env, chatId, 'That trade was already sent or cancelled.');
    return;
  }

  await answerCallbackQuery(env, callbackQueryId, 'Sending');
  const { sent, failed } = await broadcastTrade(env, claimed.id, Date.now());
  await sendMessage(env, chatId, `Sent ${sent}. Failed ${failed}.`);
}
