import type { Env, Subscriber } from '../types';

export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const RATE_LIMIT_MAX = 5;

export async function countRecentSignupsFromIp(
  db: D1Database,
  ipHash: string,
  since: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM subscribers WHERE ip_hash = ? AND created_at >= ?')
    .bind(ipHash, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Returns null when the address already exists and is currently
 * `pending_approval` or `approved` - a true duplicate, left untouched.
 *
 * When the existing row is `unsubscribed` or `bounced`, it is reset to
 * `pending_approval` with a fresh token and `created_at`, and `approved_at`
 * cleared, then returned as if it were a new signup. Someone who bounced or
 * unsubscribed can otherwise never rejoin the list: `ON CONFLICT DO NOTHING`
 * alone would silently drop them forever while the route still answers
 * `{ok: true}` (deliberately, to prevent enumeration), so the caller has no
 * way to tell "welcomed" apart from "silently ignored" unless this function
 * does the reset itself.
 *
 * The `WHERE` clause on the `DO UPDATE` is what makes this safe for a true
 * duplicate: per SQLite's UPSERT rules, when that condition is false the
 * update is skipped entirely (as if `DO NOTHING`), so a `pending_approval` or
 * `approved` row is never touched and this still returns null for it.
 */
export async function insertSubscriber(
  db: D1Database,
  email: string,
  ipHash: string,
  now: number,
): Promise<Subscriber | null> {
  const token = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO subscribers (email, status, unsub_token, ip_hash, created_at)
       VALUES (?, 'pending_approval', ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         status = 'pending_approval',
         unsub_token = excluded.unsub_token,
         ip_hash = excluded.ip_hash,
         created_at = excluded.created_at,
         approved_at = NULL
       WHERE subscribers.status IN ('unsubscribed', 'bounced')
       RETURNING id, email, status, unsub_token, created_at, approved_at`,
    )
    .bind(email, token, ipHash, now)
    .first<Subscriber>();
  return row ?? null;
}

export async function findByUnsubToken(
  db: D1Database,
  token: string,
): Promise<Subscriber | null> {
  return db
    .prepare(
      'SELECT id, email, status, unsub_token, created_at, approved_at FROM subscribers WHERE unsub_token = ?',
    )
    .bind(token)
    .first<Subscriber>();
}

export async function markUnsubscribed(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE id = ?").bind(id).run();
}

export async function markUnsubscribedByEmail(db: D1Database, email: string): Promise<void> {
  await db
    .prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?")
    .bind(email.toLowerCase())
    .run();
}

export async function markBounced(db: D1Database, email: string): Promise<void> {
  await db
    .prepare("UPDATE subscribers SET status = 'bounced' WHERE email = ?")
    .bind(email.toLowerCase())
    .run();
}

export function unsubUrl(env: Env, token: string): string {
  return `${env.SITE_ORIGIN.replace(/\/$/, '')}/unsubscribe?t=${token}`;
}
