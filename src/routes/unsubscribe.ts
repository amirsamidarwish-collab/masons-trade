import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { findByUnsubToken, markUnsubscribed } from '../db/subscribers';

export const unsubscribe = new Hono<{ Bindings: Env }>();

async function handle(c: Context<{ Bindings: Env }>) {
  const token = c.req.query('t') ?? '';
  const subscriber = await findByUnsubToken(c.env.DB, token);
  if (!subscriber) return c.text('This unsubscribe link is not valid.', 404);

  await markUnsubscribed(c.env.DB, subscriber.id);
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
     <p style="font-family:Helvetica,Arial,sans-serif">You've been unsubscribed. You will not receive further emails from Mason's Trade.</p>`,
  );
}

unsubscribe.get('/unsubscribe', handle);
// Gmail and others POST the link because of List-Unsubscribe-Post.
unsubscribe.post('/unsubscribe', handle);
