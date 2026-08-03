import type { Env } from './types';
import { unsubUrl } from './db/subscribers';
import { sendBatch } from './email/send';
import { renderApproved } from './email/templates';
import { broadcastTrade } from './broadcast';

export const APPROVAL_DELAY_MS = 30 * 60 * 60 * 1000;

const BATCH = 100;

/** Bounded so a tick with many stuck trades cannot blow the cron's time budget. */
export const STUCK_BROADCAST_SWEEP_LIMIT = 5;

interface ApprovedRow {
  id: number;
  email: string;
  unsub_token: string;
}

export async function runApprovalSweep(env: Env, now: number): Promise<number> {
  const cutoff = now - APPROVAL_DELAY_MS;

  // Flip status first, and make the approved set and the emailed set the same set by
  // construction: RETURNING hands back exactly the rows this statement actually changed,
  // so a row that no-ops (e.g. unsubscribed between selection and update) is never
  // mailed. A crash after this point costs a missed approval email, not a duplicate one
  // — the reverse order would re-mail everyone on the next tick.
  const { results } = await env.DB.prepare(
    `UPDATE subscribers
     SET status = 'approved', approved_at = ?
     WHERE id IN (
       SELECT id FROM subscribers
       WHERE status = 'pending_approval' AND created_at <= ?
       ORDER BY id
       LIMIT ?
     )
     RETURNING id, email, unsub_token`,
  )
    .bind(now, cutoff, BATCH)
    .all<ApprovedRow>();

  if (results.length === 0) return 0;

  const emails = results.map((s) => {
    const url = unsubUrl(env, s.unsub_token);
    const mail = renderApproved(env, url);
    return { to: s.email, subject: mail.subject, html: mail.html, text: mail.text, unsubUrl: url };
  });

  await sendBatch(env, emails, `approvals-${results[0].id}-${results[results.length - 1].id}`);

  return results.length;
}

/**
 * Resumes any broadcast left stuck in 'sending' - a trade that had at least
 * one failed recipient last time `broadcastTrade` ran and was never retried.
 * `claimDraft` only claims 'draft' rows, so nothing else can move a trade out
 * of 'sending'; without this sweep an operator who sees "Sent 100. Failed 50."
 * has no way to finish that broadcast.
 *
 * `broadcastTrade` is safe to call repeatedly - already-sent recipients are
 * skipped - so this just re-invokes it for each stuck trade. Bounded to
 * `STUCK_BROADCAST_SWEEP_LIMIT` per tick since the cron runs every 15 minutes
 * and will pick up any remainder on the next tick.
 */
export async function runStuckBroadcastSweep(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM trades WHERE status = 'sending' ORDER BY id LIMIT ?`,
  )
    .bind(STUCK_BROADCAST_SWEEP_LIMIT)
    .all<{ id: number }>();

  for (const row of results) {
    await broadcastTrade(env, row.id, now);
  }

  return results.length;
}
