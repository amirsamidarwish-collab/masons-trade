import { Hono } from 'hono';
import type { Env } from '../types';
import { markBounced, markUnsubscribedByEmail } from '../db/subscribers';

export const bounce = new Hono<{ Bindings: Env }>();

/**
 * Provider webhook. A hard bounce removes the address on the FIRST failure -
 * with no confirmation step at signup this is the only thing pruning dead
 * addresses, and a dirty list is what gets a sending domain blocked.
 */
bounce.post('/webhooks/email', async (c) => {
  // Signature verification is deliberately deferred (see CLAUDE.md, KNOWN OPEN RISK).
  // That is only acceptable while nothing is live. The moment DRY_RUN is off, refuse to
  // process unverified webhooks rather than let an unauthenticated endpoint empty the list.
  if (c.env.DRY_RUN !== 'true') {
    return c.json(
      { ok: false, error: 'Webhook signature verification is not configured.' },
      501,
    );
  }

  type BouncePayload = { type?: string; data?: { to?: string[] } };
  const body = await c.req.json<BouncePayload>().catch((): BouncePayload => ({}));
  const to = body.data?.to?.[0];
  if (!to) return c.json({ ok: true });

  if (body.type === 'email.bounced') {
    await markBounced(c.env.DB, to);
  } else if (body.type === 'email.complained') {
    await markUnsubscribedByEmail(c.env.DB, to);
  }

  return c.json({ ok: true });
});
