import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { findByUnsubToken, markUnsubscribed } from '../db/subscribers';

export const unsubscribe = new Hono<{ Bindings: Env }>();

// A mail scanner or client can prefetch a GET link without the subscriber ever
// clicking it, so GET must not mutate anything (RFC 8058). It renders a real
// <form method="POST"> confirm button instead. Gmail's one-click already POSTs
// the link directly (List-Unsubscribe-Post), so that path stays instant.
unsubscribe.get('/unsubscribe', async (c: Context<{ Bindings: Env }>) => {
  const token = c.req.query('t') ?? '';
  const subscriber = await findByUnsubToken(c.env.DB, token);
  if (!subscriber) return c.text('This unsubscribe link is not valid.', 404);

  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title>
     <p style="font-family:Helvetica,Arial,sans-serif">Unsubscribe this address from Mason's Trade?</p>
     <form method="POST">
       <button type="submit" style="font-family:Helvetica,Arial,sans-serif;padding:12px 24px">Unsubscribe me</button>
     </form>`,
  );
});

unsubscribe.post('/unsubscribe', async (c: Context<{ Bindings: Env }>) => {
  const token = c.req.query('t') ?? '';
  const subscriber = await findByUnsubToken(c.env.DB, token);
  if (!subscriber) return c.text('This unsubscribe link is not valid.', 404);

  await markUnsubscribed(c.env.DB, subscriber.id);
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
     <p style="font-family:Helvetica,Arial,sans-serif">You've been unsubscribed. You will not receive further emails from Mason's Trade.</p>`,
  );
});
