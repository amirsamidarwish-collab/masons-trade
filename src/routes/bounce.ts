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
