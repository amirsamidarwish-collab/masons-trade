import type { StoredTrade, Trade } from '../types';

export async function createDraft(
  db: D1Database,
  trade: Trade,
  transcript: string,
  now: number,
): Promise<StoredTrade> {
  const token = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO trades (pair, direction, entry, take_profit, stop_loss, note, transcript, status, draft_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
       RETURNING id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token`,
    )
    .bind(
      trade.pair,
      trade.direction,
      trade.entry,
      trade.take_profit,
      trade.stop_loss,
      trade.note,
      transcript,
      token,
      now,
    )
    .first<StoredTrade>();
  return row!;
}

export async function findDraftByToken(
  db: D1Database,
  token: string,
): Promise<StoredTrade | null> {
  return db
    .prepare(
      `SELECT id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token
       FROM trades WHERE draft_token = ?`,
    )
    .bind(token)
    .first<StoredTrade>();
}

/**
 * Atomically moves draft -> sending. Returns null when the draft was already
 * claimed, which is what stops an old message being tapped twice.
 */
export async function claimDraft(db: D1Database, token: string): Promise<StoredTrade | null> {
  return db
    .prepare(
      `UPDATE trades SET status = 'sending'
       WHERE draft_token = ? AND status = 'draft'
       RETURNING id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token`,
    )
    .bind(token)
    .first<StoredTrade>();
}

export async function cancelDraft(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("UPDATE trades SET status = 'cancelled' WHERE draft_token = ? AND status = 'draft'")
    .bind(token)
    .run();
}

/**
 * Supersede any unresolved draft and create the new one as ONE transaction.
 * Done separately these race: two voice notes processed concurrently can both
 * find nothing to cancel and both insert, leaving two live Send buttons - which
 * is the stale-broadcast hazard this supersede exists to remove.
 */
export async function createDraftSupersedingOthers(
  db: D1Database,
  trade: Trade,
  transcript: string,
  now: number,
): Promise<StoredTrade> {
  const token = crypto.randomUUID();
  const [, inserted] = await db.batch<StoredTrade>([
    db.prepare("UPDATE trades SET status = 'cancelled' WHERE status = 'draft'"),
    db.prepare(
      `INSERT INTO trades (pair, direction, entry, take_profit, stop_loss, note, transcript, status, draft_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
       RETURNING id, pair, direction, entry, take_profit, stop_loss, note, status, draft_token`,
    ).bind(
      trade.pair,
      trade.direction,
      trade.entry,
      trade.take_profit,
      trade.stop_loss,
      trade.note,
      transcript,
      token,
      now,
    ),
  ]);
  return inserted.results[0];
}

export async function countApproved(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'approved'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}
