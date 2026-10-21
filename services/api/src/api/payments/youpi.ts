// YouPI-PG as an EXPERIMENTAL payment provider (https://github.com/youpi-pg/YouPI-PG). Written against its documented contract:
//   POST /api/v1/payments (X-Merchant-Id, Idempotency-Key) → { paymentId, checkoutUrl, status }
//   GET  /api/v1/payments/{id}                             → { status, amountPaise, verificationLevel, ... }
//   POST /api/v1/checkout/{id}/cancel
//   webhook: raw JSON body, X-Gateway-Signature: sha256=HMAC-SHA256(webhookSecret, rawBody), X-Gateway-Delivery-Id, X-Gateway-Timestamp (ms),
//   events SUCCESS | FAILED | EXPIRED | CANCELLED.
// It is a one-time UPI collection, INR only, no recurring mandates. Its own README says it is not audited or production-ready and that a
// signed webhook is not proof the bank settled: so this adapter reports what YouPI says and nothing here treats it as settlement.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookRejected, type Checkout, type CheckoutRequest, type PaymentProvider, type ProviderEventKind, type ProviderPayment, type VerifiedWebhook } from './provider.ts';

export interface YoupiOptions { apiUrl: string; merchantId: string; webhookSecret: string; fetch?: typeof fetch; toleranceMs?: number }

const EVENTS: ReadonlySet<string> = new Set<ProviderEventKind>(['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED']);
const AMOUNT = /^\d{1,9}\.\d{2}$/;
const header = (h: Record<string, string | string[] | undefined>, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };

/** 49900 → "499.00". Integer arithmetic only. */
export const toMajor = (minor: number): string => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
/** "499.00" → 49900, or undefined if it is not exactly that shape. */
export const toMinor = (major: string): number | undefined => { if (!AMOUNT.test(major)) return undefined; const [a, b] = major.split('.'); return Number(a) * 100 + Number(b); };

export class YoupiProvider implements PaymentProvider {
  readonly id = 'youpi';
  readonly experimental = true;
  private readonly o: Required<Omit<YoupiOptions, 'fetch'>> & { fetch: typeof fetch };
  constructor(o: YoupiOptions) { this.o = { toleranceMs: 5 * 60_000, fetch, ...o, apiUrl: o.apiUrl.replace(/\/+$/, '') } as never; }

  private async call(path: string, init: RequestInit = {}) {
    const r = await this.o.fetch(`${this.o.apiUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', 'x-merchant-id': this.o.merchantId, ...(init.headers ?? {}) } });
    const body = (await r.json().catch(() => ({}))) as Record<string, any>;
    return { status: r.status, body };
  }

  async createCheckout(req: CheckoutRequest): Promise<Checkout> {
    if (req.currency !== 'inr') throw new Error('YouPI collects INR only.');
    const { status, body } = await this.call('/api/v1/payments', {
      method: 'POST', headers: { 'idempotency-key': req.orderId },
      body: JSON.stringify({ orderId: req.orderId, amount: toMajor(req.amountMinor), currency: 'INR', description: req.description, returnUrl: req.returnUrl, customer: req.customer, metadata: req.metadata }),
    });
    if ((status !== 201 && status !== 200) || typeof body.paymentId !== 'string' || typeof body.checkoutUrl !== 'string') throw new Error(`The payment provider refused the checkout (${status}${body.error ? `: ${String(body.error).slice(0, 80)}` : ''}).`);
    // The provider echoes the amount it will charge: it must be the one we asked for.
    if (body.amount !== undefined && toMinor(String(body.amount)) !== req.amountMinor) throw new Error('The payment provider would charge a different amount than requested.');
    return { providerPaymentId: body.paymentId, checkoutUrl: body.checkoutUrl };
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    const { status, body } = await this.call(`/api/v1/payments/${encodeURIComponent(id)}`);
    if (status !== 200 || typeof body.status !== 'string') throw new Error(`The payment provider could not report that payment (${status}).`);
    const minor = body.amountPaise !== undefined ? Number(body.amountPaise) : toMinor(String(body.amount));
    if (!Number.isInteger(minor)) throw new Error('The payment provider sent an amount that is not a number.');
    return { providerPaymentId: String(body.paymentId ?? id), orderId: String(body.orderId ?? ''), status: body.status, amountMinor: minor as number, currency: String(body.currency ?? 'INR').toLowerCase(), verificationLevel: Number(body.verificationLevel ?? 0), reference: typeof body.utr === 'string' ? body.utr : undefined };
  }

  async cancel(id: string): Promise<void> {
    await this.call(`/api/v1/checkout/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now = Date.now()): VerifiedWebhook {
    // 1. the signature, over the exact bytes, compared in constant time
    const given = header(headers, 'x-gateway-signature') ?? '';
    if (!/^sha256=[0-9a-f]{64}$/.test(given)) throw new WebhookRejected('signature', 'missing or malformed signature');
    const want = `sha256=${createHmac('sha256', this.o.webhookSecret).update(rawBody).digest('hex')}`;
    if (!timingSafeEqual(Buffer.from(given), Buffer.from(want))) throw new WebhookRejected('signature', 'signature does not match');
    // 2. freshness: an old delivery, replayed, is refused
    const ts = Number(header(headers, 'x-gateway-timestamp'));
    if (!Number.isFinite(ts) || Math.abs(now - ts) > this.o.toleranceMs) throw new WebhookRejected('timestamp', 'timestamp missing or outside the allowed window');
    const deliveryId = header(headers, 'x-gateway-delivery-id');
    if (!deliveryId || !/^[A-Za-z0-9._:-]{8,100}$/.test(deliveryId)) throw new WebhookRejected('delivery', 'delivery id missing or malformed');
    // 3. the shape
    let p: Record<string, any>;
    try { p = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookRejected('shape', 'body is not JSON'); }
    if (!p || typeof p !== 'object' || !EVENTS.has(p.event) || typeof p.paymentId !== 'string' || typeof p.orderId !== 'string' || typeof p.currency !== 'string') throw new WebhookRejected('shape', 'unexpected payload');
    const fromString = typeof p.amount === 'string' ? toMinor(p.amount) : undefined;
    const fromPaise = typeof p.amountPaise === 'number' && Number.isInteger(p.amountPaise) ? p.amountPaise : undefined;
    if (fromString === undefined && fromPaise === undefined) throw new WebhookRejected('shape', 'no usable amount');
    if (fromString !== undefined && fromPaise !== undefined && fromString !== fromPaise) throw new WebhookRejected('shape', 'amount and amountPaise disagree');
    return { deliveryId, event: p.event, providerPaymentId: p.paymentId, orderId: p.orderId, amountMinor: (fromPaise ?? fromString) as number, currency: p.currency.toLowerCase(),
      reference: typeof p.utr === 'string' ? p.utr : undefined, payload: p };
  }
}

/** The provider from the environment, or undefined when payments are off. Off unless AO_PAYMENTS=youpi-experimental and all three settings exist. */
export function youpiFromEnv(env: NodeJS.ProcessEnv = process.env): YoupiProvider | undefined {
  if (env.AO_PAYMENTS !== 'youpi-experimental') return undefined;
  const apiUrl = env.YOUPI_API_URL?.trim(), merchantId = env.YOUPI_MERCHANT_ID?.trim(), webhookSecret = env.YOUPI_WEBHOOK_SECRET?.trim();
  if (!apiUrl || !merchantId || !webhookSecret) return undefined;
  return new YoupiProvider({ apiUrl, merchantId, webhookSecret });
}
