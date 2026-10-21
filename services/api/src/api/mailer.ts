// Outbound email for announcements. One provider (Resend's HTTP API, called with fetch: no SDK), off unless a key and a sender are set.
// A send resolves only when the provider accepted the message, with the provider's own id; anything else throws. Nothing here pretends.
export interface Mail { to: string; subject: string; text: string; html?: string; headers?: Record<string, string>; tags?: Array<{ name: string; value: string }> }
export type Mailer = (mail: Mail) => Promise<{ id: string }>;

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Mailer | undefined {
  const key = env.RESEND_API_KEY?.trim(), from = env.AO_MAIL_FROM?.trim();
  if (!key || !from) return undefined;
  return async (mail) => {
    const r = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}), ...(mail.headers ? { headers: mail.headers } : {}), ...(mail.tags ? { tags: mail.tags } : {}) }),
    });
    const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!r.ok || !body.id) throw new Error(`The email provider refused it (${r.status}${body.message ? `: ${body.message.slice(0, 120)}` : ''}).`);
    return { id: body.id };
  };
}
