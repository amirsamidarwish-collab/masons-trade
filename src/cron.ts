import type { Env, Subscriber } from './types';
import { unsubUrl } from './db/subscribers';
import { sendBatch } from './email/send';
import { renderApproved } from './email/templates';

export const APPROVAL_DELAY_MS = 30 * 60 * 60 * 1000;

const BATCH = 100;

export async function runApprovalSweep(env: Env, now: number): Promise<number> {
  const cutoff = now - APPROVAL_DELAY_MS;

  const { results } = await env.DB.prepare(
    `SELECT id, email, status, unsub_token, created_at, approved_at
     FROM subscribers
     WHERE status = 'pending_approval' AND created_at <= ?
     ORDER BY id
     LIMIT ?`,
  )
    .bind(cutoff, BATCH)
    .all<Subscriber>();

  if (results.length === 0) return 0;

  // Flip status first: a crash after this point costs an approval email, not a
  // duplicate one. The reverse order would re-mail everyone on the next tick.
  await env.DB.batch(
    results.map((s) =>
      env.DB.prepare(
        "UPDATE subscribers SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending_approval'",
      ).bind(now, s.id),
    ),
  );

  const emails = results.map((s) => {
    const url = unsubUrl(env, s.unsub_token);
    const mail = renderApproved(env, url);
    return { to: s.email, subject: mail.subject, html: mail.html, text: mail.text, unsubUrl: url };
  });

  await sendBatch(env, emails, `approvals-${cutoff}-${results[0].id}`);

  return results.length;
}
