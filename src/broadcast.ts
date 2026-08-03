import type { Env, StoredTrade, Subscriber } from './types';
import { sendBatch } from './email/send';
import { renderTrade } from './email/templates';
import { unsubUrl } from './db/subscribers';

export const CHUNK_SIZE = 100;

/**
 * Sends a trade to every approved subscriber.
 *
 * A recipient's chunk is a pure function of their own subscriber id
 * (`floor((id - 1) / CHUNK_SIZE)`), not of their position in a query result.
 * The `-1` accounts for ids being 1-indexed (SQLite AUTOINCREMENT never
 * issues id 0), so chunk 0 is ids [1, 100], chunk 1 is ids [101, 200], and
 * so on - full 100-person chunks from the very first one, not just an
 * off-by-one-short first chunk. That fixed, id-derived numbering is what
 * makes chunk membership - and therefore the provider idempotency key
 * derived from (trade, chunk) - immune to the approved set changing shape
 * between runs. Subscriber ids are AUTOINCREMENT and never reused, so
 * "chunk 3" means exactly "approved subscribers with id in [301, 400]" for
 * the entire life of the trade, whether or not everyone in that range is
 * still approved. Deriving the chunk from array position instead would let
 * someone unsubscribing between runs shift a later chunk's membership and
 * reuse an already-spent idempotency key for a different set of people.
 * Chunks may be sparse after churn (fewer than 100 people); that's harmless.
 *
 * Only runs for a trade whose status is 'sending' - i.e. one that has gone
 * through claimDraft. Nothing sends unprompted: an unclaimed or already
 * finished trade is a no-op.
 *
 * Safe to call repeatedly: recipients already logged as sent are skipped
 * without calling the provider at all.
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
  if (!trade || trade.status !== 'sending') return { sent: 0, failed: 0 };

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

  const pendingRecipients = approved.filter((s) => !alreadySent.has(s.id));

  const byChunk = new Map<number, Subscriber[]>();
  for (const s of pendingRecipients) {
    const key = Math.floor((s.id - 1) / CHUNK_SIZE);
    const group = byChunk.get(key);
    if (group) group.push(s);
    else byChunk.set(key, [s]);
  }

  let sent = 0;
  let failed = 0;

  for (const chunkIndex of [...byChunk.keys()].sort((a, b) => a - b)) {
    const chunk = byChunk.get(chunkIndex)!;

    const emails = chunk.map((s) => {
      const url = unsubUrl(env, s.unsub_token);
      const mail = renderTrade(env, trade, url);
      return { to: s.email, subject: mail.subject, html: mail.html, text: mail.text, unsubUrl: url };
    });

    const results = await sendBatch(env, emails, `trade-${tradeId}-chunk-${chunkIndex}`);

    await env.DB.batch(
      chunk.map((s, idx) =>
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
