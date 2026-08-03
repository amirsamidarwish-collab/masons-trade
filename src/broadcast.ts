import type { Env, StoredTrade, Subscriber } from './types';
import { sendBatch } from './email/send';
import { renderTrade } from './email/templates';
import { unsubUrl } from './db/subscribers';

export const CHUNK_SIZE = 100;

/**
 * Sends a trade to every approved subscriber.
 *
 * Recipients are ordered by id and cut into fixed chunks, so chunk N always
 * contains the same people, no matter how much of the trade has already been
 * sent. That fixed numbering is what the provider idempotency key is derived
 * from: a retry after a crash re-issues the same key for the same chunk, so
 * the provider can deduplicate it. Chunk indices are computed against the
 * full approved list, not the filtered "still pending" list - re-deriving
 * them from a filtered list would shift a later chunk's index every time an
 * earlier chunk finishes, reusing an already-spent key for different people.
 *
 * Safe to call repeatedly: chunks that are already fully logged as sent are
 * skipped without calling the provider at all.
 */
export async function broadcastTrade(
  env: Env,
  tradeId: number,
  now: number,
): Promise<{ sent: number; failed: number }> {
  const trade = await env.DB.prepare(
    `SELECT id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token
     FROM trades WHERE id = ?`,
  )
    .bind(tradeId)
    .first<StoredTrade>();
  if (!trade) return { sent: 0, failed: 0 };

  const { results: approved } = await env.DB.prepare(
    `SELECT id, email, status, unsub_token, created_at, approved_at
     FROM subscribers WHERE status = 'approved' ORDER BY id`,
  ).all<Subscriber>();

  const { results: sentRows } = await env.DB.prepare(
    `SELECT subscriber_id FROM send_log WHERE trade_id = ? AND status = 'sent'`,
  )
    .bind(tradeId)
    .all<{ subscriber_id: number }>();
  const alreadySent = new Set(sentRows.map((r) => r.subscriber_id));

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < approved.length; i += CHUNK_SIZE) {
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const chunk = approved.slice(i, i + CHUNK_SIZE);
    const pending = chunk.filter((s) => !alreadySent.has(s.id));
    if (pending.length === 0) continue;

    const emails = pending.map((s) => {
      const url = unsubUrl(env, s.unsub_token);
      const mail = renderTrade(env, trade, url);
      return { to: s.email, subject: mail.subject, html: mail.html, text: mail.text, unsubUrl: url };
    });

    const results = await sendBatch(env, emails, `trade-${tradeId}-chunk-${chunkIndex}`);

    await env.DB.batch(
      pending.map((s, idx) =>
        env.DB.prepare(
          `INSERT INTO send_log (trade_id, subscriber_id, chunk, status, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(trade_id, subscriber_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        ).bind(tradeId, s.id, chunkIndex, results[idx]?.ok ? 'sent' : 'failed', now),
      ),
    );

    for (const r of results) r.ok ? sent++ : failed++;
  }

  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM send_log WHERE trade_id = ? AND status = 'sent'",
  )
    .bind(tradeId)
    .first<{ n: number }>();

  await env.DB.prepare(
    `UPDATE trades SET status = ?, sent_at = ?, recipient_count = ? WHERE id = ?`,
  )
    .bind(failed === 0 ? 'sent' : 'sending', now, total?.n ?? 0, tradeId)
    .run();

  return { sent, failed };
}
