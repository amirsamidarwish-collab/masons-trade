import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../types';
import { hasMxRecord, hashIp, isValidEmailSyntax } from '../validate';
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  countRecentSignupsFromIp,
  insertSubscriber,
  unsubUrl,
} from '../db/subscribers';
import { sendBatch } from '../email/send';
import { renderUnderReview } from '../email/templates';

export const subscribe = new Hono<{ Bindings: Env }>();

subscribe.use('/subscribe', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'] }));

subscribe.post('/subscribe', async (c) => {
  const body = await c.req
    .json<{ email?: string; company?: string }>()
    .catch(() => ({}) as { email?: string; company?: string });

  // Honeypot: `company` is hidden from humans, so anything in it is a bot.
  // Answer 200 so the bot cannot tell it was caught.
  if (body.company) return c.json({ ok: true });

  const email = (body.email ?? '').trim().toLowerCase();
  if (!isValidEmailSyntax(email)) {
    return c.json({ ok: false, error: 'Enter a valid email address.' }, 400);
  }

  const domain = email.split('@')[1];
  if (!(await hasMxRecord(domain))) {
    return c.json({ ok: false, error: 'That email domain cannot receive mail.' }, 400);
  }

  const now = Date.now();
  const ipHash = await hashIp(c.req.header('CF-Connecting-IP') ?? 'unknown');
  const recent = await countRecentSignupsFromIp(c.env.DB, ipHash, now - RATE_LIMIT_WINDOW_MS);
  if (recent >= RATE_LIMIT_MAX) {
    return c.json({ ok: false, error: 'Too many requests. Try again later.' }, 429);
  }

  const subscriber = await insertSubscriber(c.env.DB, email, ipHash, now);
  // Duplicate: same response as success, so the endpoint cannot be used to
  // discover who is already on the list.
  if (!subscriber) return c.json({ ok: true });

  const url = unsubUrl(c.env, subscriber.unsub_token);
  const mail = renderUnderReview(c.env, url);
  await sendBatch(
    c.env,
    [{ to: subscriber.email, subject: mail.subject, html: mail.html, text: mail.text, unsubUrl: url }],
    `welcome-${subscriber.id}`,
  );

  return c.json({ ok: true });
});
