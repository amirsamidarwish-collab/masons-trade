const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmailSyntax(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false;
  const [local] = email.split('@');
  if (!local || local.length > 64) return false;
  return EMAIL_RE.test(email);
}

/**
 * DNS-over-HTTPS MX lookup. Workers cannot make raw DNS queries.
 * Fails closed: a lookup error rejects the address rather than letting it in,
 * because there is no confirmation click behind this.
 */
export async function hasMxRecord(domain: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { Answer?: { type?: number }[] };
    return Array.isArray(body.Answer) && body.Answer.some((a) => a.type === 15);
  } catch {
    return false;
  }
}

export async function hashIp(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
