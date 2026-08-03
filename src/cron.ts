import type { Env } from './types';
import { unsubUrl } from './db/subscribers';
import { sendBatch } from './email/send';
import { renderApproved } from './email/templates';

export const APPROVAL_DELAY_MS = 30 * 60 * 60 * 1000;

const BATCH = 100;

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
