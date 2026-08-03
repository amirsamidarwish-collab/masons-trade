import type { Env } from '../types';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Required: every send must carry List-Unsubscribe. Not optional by design. */
  unsubUrl: string;
}

export interface SendResult {
  to: string;
  ok: boolean;
  error?: string;
}

const ENDPOINT = 'https://api.resend.com/emails/batch';

/**
 * The only place an email provider is named. Swapping to Amazon SES means
 * rewriting this function and nothing else.
 *
 * `idempotencyKey` must be stable for a given (trade, chunk) so that a retry
 * after a crash cannot deliver the same email twice.
 */
export async function sendBatch(
  env: Env,
  emails: OutgoingEmail[],
  idempotencyKey: string,
): Promise<SendResult[]> {
  if (emails.length === 0) return [];

  const dryRun = env.DRY_RUN === 'true';

  const payload = emails.map((e) => ({
    from: env.FROM_EMAIL,
    to: [dryRun ? env.TEST_INBOX : e.to],
    subject: e.subject,
    html: e.html,
    text: e.text,
    headers: {
      'List-Unsubscribe': `<${e.unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }));

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const error = `network error: ${String(err)}`;
    return emails.map((e) => ({ to: e.to, ok: false, error }));
  }

  if (!res.ok) {
    const error = `provider responded ${res.status}: ${await res.text()}`;
    return emails.map((e) => ({ to: e.to, ok: false, error }));
  }

  // A 2xx status alone does not prove every recipient was accepted - Resend's
  // batch endpoint can return 2xx with a `data` array shorter than the
  // payload. Require the array to exist and match the payload size before
  // trusting it; otherwise fail the whole batch loudly rather than silently
  // marking unconfirmed recipients as sent.
  let body: { data?: unknown };
  try {
    body = (await res.json()) as { data?: unknown };
  } catch (err) {
    const error = `provider returned unparseable JSON: ${String(err)}`;
    return emails.map((e) => ({ to: e.to, ok: false, error }));
  }

  if (!Array.isArray(body.data) || body.data.length !== payload.length) {
    const got = Array.isArray(body.data) ? String(body.data.length) : 'no array';
    const error = `provider confirmed ${got} of ${payload.length} recipients in its response`;
    return emails.map((e) => ({ to: e.to, ok: false, error }));
  }

  return emails.map((e) => ({ to: e.to, ok: true }));
}
