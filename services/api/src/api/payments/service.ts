// Orders, provider notices and what they may and may not do. Runs as the `ao_billing` database role: it can write payment records and nothing else.
// The one rule everything here serves: a provider's notice is an OBSERVATION. It moves an order to `observed` (or `review` when something does not
// add up) and stops. Turning an observed order into a plan, an invoice and credits is `ao_activate_order`, reachable only from the admin API.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../errors.ts';
import { toMajor } from './youpi.ts';
import { WebhookRejected, type PaymentProvider, type ProviderPayment, type VerifiedWebhook } from './provider.ts';

export type OrderStatus = 'created' | 'pending' | 'observed' | 'review' | 'settled' | 'failed' | 'expired' | 'cancelled' | 'refunded' | 'rejected';
/** What the person sees. They never see "settled" before we have accepted the payment. */
export type OrderState = 'pending' | 'verifying' | 'review_required' | 'completed' | 'failed' | 'expired' | 'cancelled' | 'refunded';
export const stateOf = (s: OrderStatus): OrderState =>
  ({ created: 'pending', pending: 'pending', observed: 'verifying', review: 'review_required', settled: 'completed', failed: 'failed', expired: 'expired', cancelled: 'cancelled', refunded: 'refunded', rejected: 'failed' } as const)[s];

export interface PaymentsOptions { pool: pg.Pool; provider: PaymentProvider; currency?: string; returnUrl?: string; orderTtlMs?: number; now?: () => number }

const ulid = () => `${Date.now().toString(36).padStart(10, '0')}${randomBytes(8).toString('hex')}`;
type Order = { id: string; user_id: string; plan_id: string; amount_minor: string | number; currency: string; billing_interval: string; provider: string; status: OrderStatus; expires_at: Date; created_at: Date; settled_at: Date | null; review_reason: string | null };

export class PaymentsService {
  readonly provider: PaymentProvider;
  private readonly o: Required<Omit<PaymentsOptions, 'returnUrl' | 'provider'>> & { returnUrl?: string };
  constructor(o: PaymentsOptions) { this.provider = o.provider; this.o = { currency: 'inr', orderTtlMs: 10 * 60_000, now: Date.now, ...o } as never; }
  private get pool() { return this.o.pool; }

  // ── checkout ──────────────────────────────────────────────────────────────────────────────────
  /** Start a purchase. The price is read here, from the database: the caller only names a plan. */
  async createCheckout(userId: string, planId: string) {
    const c = await this.pool.connect();
    let order: Order, existing = false;
    try {
      await c.query('BEGIN');
      const u = (await c.query('SELECT status, email FROM users WHERE id = $1', [userId])).rows[0];
      if (!u || u.status !== 'active') throw new HttpError(403, 'This account cannot buy a plan.');
      const plan = (await c.query(`SELECT p.id, p.name, p.active, pp.amount_minor, pp.billing_interval FROM plans p JOIN plan_prices pp ON pp.plan_id = p.id AND pp.currency = $2 AND pp.active
        WHERE p.id = $1 ORDER BY (pp.billing_interval = 'month') DESC LIMIT 1`, [planId, this.o.currency])).rows[0];
      if (!plan) throw new HttpError(404, 'That plan is not available.');
      if (!plan.active) throw new HttpError(409, 'That plan is not on sale yet.');
      if (Number(plan.amount_minor) <= 0) throw new HttpError(400, 'That plan is free: there is nothing to pay.');
      await c.query(`UPDATE payment_orders SET status = 'expired', updated_at = now() WHERE user_id = $1 AND plan_id = $2 AND status IN ('created', 'pending') AND expires_at < now()`, [userId, planId]);
      const id = `ord_${ulid()}`;
      const ins = await c.query(`INSERT INTO payment_orders(id, user_id, plan_id, amount_minor, currency, billing_interval, provider, status, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'created', now() + $8 * interval '1 millisecond') ON CONFLICT DO NOTHING RETURNING *`, [id, userId, planId, plan.amount_minor, this.o.currency, plan.billing_interval, this.provider.id, this.o.orderTtlMs]);
      if (ins.rows[0]) order = ins.rows[0];
      else { existing = true; order = (await c.query(`SELECT * FROM payment_orders WHERE user_id = $1 AND plan_id = $2 AND status IN ('created', 'pending')`, [userId, planId])).rows[0]; }
      await c.query('COMMIT');
      if (existing) {
        const att = (await this.pool.query(`SELECT checkout_url FROM payment_attempts WHERE order_id = $1 AND status = 'created' AND checkout_url IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [order.id])).rows[0];
        if (!att) throw new HttpError(409, 'A checkout for this plan is being prepared. Try again in a moment.');
        return { ...this.view(order), checkout_url: att.checkout_url as string, reused: true };
      }
      const email = u.email as string | null;
      try {
        const co = await this.provider.createCheckout({ orderId: order.id, amountMinor: Number(order.amount_minor), currency: order.currency, description: `Agentic Office ${plan.name}`, returnUrl: this.o.returnUrl, customer: email ? { email } : undefined, metadata: { plan: plan.id } });
        await this.pool.query(`INSERT INTO payment_attempts(id, order_id, provider, provider_payment_id, checkout_url) VALUES ($1,$2,$3,$4,$5)`, [`att_${ulid()}`, order.id, this.provider.id, co.providerPaymentId, co.checkoutUrl]);
        await this.pool.query(`UPDATE payment_orders SET status = 'pending', updated_at = now() WHERE id = $1`, [order.id]);
        return { ...this.view({ ...order, status: 'pending' }), checkout_url: co.checkoutUrl, reused: false };
      } catch (e) {
        await this.pool.query(`INSERT INTO payment_attempts(id, order_id, provider, status, error) VALUES ($1,$2,$3,'failed',$4)`, [`att_${ulid()}`, order.id, this.provider.id, String((e as Error).message).slice(0, 200)]);
        await this.pool.query(`UPDATE payment_orders SET status = 'failed', updated_at = now() WHERE id = $1`, [order.id]);
        throw new HttpError(502, 'The payment provider could not start the checkout. Nothing was charged. Try again later.');
      }
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  view(o: Pick<Order, 'id' | 'plan_id' | 'amount_minor' | 'currency' | 'billing_interval' | 'status' | 'expires_at' | 'created_at'> & Partial<Order>) {
    return { id: o.id, plan_id: o.plan_id, amount_minor: Number(o.amount_minor), amount: toMajor(Number(o.amount_minor)), currency: o.currency, billing_interval: o.billing_interval, state: stateOf(o.status), expires_at: o.expires_at, created_at: o.created_at, settled_at: o.settled_at ?? null };
  }

  async listOrders(userId: string) {
    await this.expireStale();
    const r = await this.pool.query(`SELECT o.*, i.number AS invoice_number FROM payment_orders o LEFT JOIN invoices i ON i.order_id = o.id WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 50`, [userId]);
    return { orders: r.rows.map((o) => ({ ...this.view(o), invoice_number: o.invoice_number ?? null })) };
  }

  /** One of the person's own orders (another person's id is simply not found). While it is pending, the provider is asked, so a lost webhook does not strand it. */
  async getOrder(userId: string, id: string) {
    let o = (await this.pool.query(`SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2`, [id, userId])).rows[0] as Order | undefined;
    if (!o) throw new HttpError(404, 'No such order.');
    if (o.status === 'pending') { await this.reconcile(o.id).catch(() => undefined); o = (await this.pool.query(`SELECT * FROM payment_orders WHERE id = $1`, [id])).rows[0]; }
    const att = o.status === 'pending' ? (await this.pool.query(`SELECT checkout_url FROM payment_attempts WHERE order_id = $1 AND checkout_url IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [id])).rows[0] : undefined;
    return { ...this.view(o), checkout_url: att?.checkout_url ?? null };
  }

  async cancel(userId: string, id: string) {
    const o = (await this.pool.query(`SELECT o.*, a.provider_payment_id FROM payment_orders o LEFT JOIN payment_attempts a ON a.order_id = o.id AND a.provider_payment_id IS NOT NULL WHERE o.id = $1 AND o.user_id = $2 ORDER BY a.created_at DESC LIMIT 1`, [id, userId])).rows[0];
    if (!o) throw new HttpError(404, 'No such order.');
    if (o.status !== 'created' && o.status !== 'pending') throw new HttpError(409, 'That order can no longer be cancelled.');
    if (o.provider_payment_id) await this.provider.cancel(o.provider_payment_id).catch(() => undefined);   // best effort: our own state decides
    await this.pool.query(`UPDATE payment_orders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('created', 'pending')`, [id]);
    return { ok: true };
  }

  /** Orders nobody paid in time end. Never touches an order the provider has reported as paid. */
  async expireStale(): Promise<number> {
    return (await this.pool.query(`UPDATE payment_orders SET status = 'expired', updated_at = now() WHERE status IN ('created', 'pending') AND expires_at < now()`)).rowCount ?? 0;
  }

  // ── what the provider tells us ────────────────────────────────────────────────────────────────
  /** A webhook delivery. Returns what to answer the provider; a bad signature is a 401 and leaves no trace but a count. */
  async handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: number; body: Record<string, unknown> }> {
    let ev: VerifiedWebhook;
    try { ev = this.provider.verifyWebhook(rawBody, headers, this.o.now()); }
    catch (e) {
      if (e instanceof WebhookRejected) return { status: e.reason === 'shape' ? 400 : 401, body: { error: `Rejected: ${e.reason}.` } };
      throw e;
    }
    const outcome = await this.observe(ev, 'webhook');
    // A success notice is checked against the provider's own record before anyone looks at it; a mismatch sends the order to review.
    if (ev.event === 'SUCCESS' && (outcome === 'observed' || outcome === 'review')) await this.confirmWithProvider(ev.orderId).catch(() => undefined);
    return { status: 200, body: { received: true, ...(outcome === 'duplicate' ? { duplicate: true } : {}) } };
  }

  /** Record one observation and apply the state machine. Idempotent per (provider, delivery id). */
  async observe(ev: Pick<VerifiedWebhook, 'deliveryId' | 'event' | 'providerPaymentId' | 'orderId' | 'amountMinor' | 'currency' | 'reference' | 'payload'> & { verificationLevel?: number }, source: 'webhook' | 'poll'): Promise<string> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const order = (await c.query(`SELECT * FROM payment_orders WHERE id = $1 AND provider = $2 FOR UPDATE`, [ev.orderId, this.provider.id])).rows[0] as Order | undefined;
      const attempt = order ? (await c.query(`SELECT 1 FROM payment_attempts WHERE order_id = $1 AND provider_payment_id = $2`, [order.id, ev.providerPaymentId])).rows[0] : undefined;
      const known = !!order && !!attempt;
      const ins = await c.query(`INSERT INTO payment_events(provider, delivery_id, order_id, event, signature_ok, payload, outcome) VALUES ($1,$2,$3,$4,$5,$6,'received')
        ON CONFLICT (provider, delivery_id) WHERE delivery_id IS NOT NULL DO NOTHING RETURNING id`, [this.provider.id, ev.deliveryId, known ? order!.id : null, ev.event, source === 'webhook', JSON.stringify(ev.payload)]);
      if (!ins.rows[0]) { await c.query('COMMIT'); return 'duplicate'; }
      let outcome = 'ignored';
      if (!known) outcome = 'unknown_payment';
      else {
        const o = order!;
        const match = Number(o.amount_minor) === ev.amountMinor && o.currency === ev.currency;
        const open = o.status === 'created' || o.status === 'pending';
        const dead = o.status === 'expired' || o.status === 'failed' || o.status === 'cancelled';
        if (ev.event === 'SUCCESS') {
          const reason = !match ? `the provider reports ${toMajor(ev.amountMinor)} ${ev.currency.toUpperCase()}, the order is ${toMajor(Number(o.amount_minor))} ${o.currency.toUpperCase()}` : ev.verificationLevel === 0 ? 'the provider reports the payment as unverified' : dead ? `payment arrived after the order was ${o.status}` : null;
          if (open || dead) {
            if (reason) { await c.query(`UPDATE payment_orders SET status = 'review', review_reason = $2, observed_at = now(), provider_reference = coalesce($3, provider_reference), updated_at = now() WHERE id = $1`, [o.id, reason, ev.reference ?? null]); outcome = match ? 'review' : 'amount_mismatch'; }
            else { await c.query(`UPDATE payment_orders SET status = 'observed', observed_at = now(), provider_reference = coalesce($2, provider_reference), updated_at = now() WHERE id = $1`, [o.id, ev.reference ?? null]); outcome = 'observed'; }
          } else outcome = 'ignored';    // already observed, in review or settled: a second notice changes nothing
        } else if (open) {
          const to = ev.event === 'FAILED' ? 'failed' : ev.event === 'EXPIRED' ? 'expired' : 'cancelled';
          await c.query(`UPDATE payment_orders SET status = $2, updated_at = now() WHERE id = $1`, [o.id, to]);
          outcome = to;
        }
        await c.query(`UPDATE payment_attempts SET status = $3 WHERE order_id = $1 AND provider_payment_id = $2`, [o.id, ev.providerPaymentId, ev.event.toLowerCase()]);
      }
      await c.query(`UPDATE payment_events SET outcome = $2 WHERE id = $1`, [ins.rows[0].id, outcome]);
      await c.query('COMMIT');
      return outcome;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  /** Ask the provider what it knows. Used when a person opens a pending order, on a timer, and by an administrator. */
  async reconcile(orderId: string): Promise<{ provider_status: string | null; outcome: string | null }> {
    const row = (await this.pool.query(`SELECT a.provider_payment_id FROM payment_attempts a JOIN payment_orders o ON o.id = a.order_id WHERE o.id = $1 AND a.provider_payment_id IS NOT NULL ORDER BY a.created_at DESC LIMIT 1`, [orderId])).rows[0];
    if (!row) return { provider_status: null, outcome: null };
    const p = await this.provider.getPayment(row.provider_payment_id);
    if (p.orderId && p.orderId !== orderId) return { provider_status: p.status, outcome: 'order_mismatch' };
    if (p.status !== 'SUCCESS' && p.status !== 'FAILED' && p.status !== 'EXPIRED' && p.status !== 'CANCELLED') return { provider_status: p.status, outcome: null };
    const outcome = await this.observe({ deliveryId: `poll:${p.providerPaymentId}:${p.status}`, event: p.status, providerPaymentId: p.providerPaymentId, orderId, amountMinor: p.amountMinor, currency: p.currency, reference: p.reference, verificationLevel: p.verificationLevel, payload: { source: 'poll', status: p.status, verificationLevel: p.verificationLevel } }, 'poll');
    return { provider_status: p.status, outcome };
  }

  /** After a SUCCESS notice: does the provider's own record agree? If not, a person must look. */
  private async confirmWithProvider(orderId: string): Promise<void> {
    const row = (await this.pool.query(`SELECT o.status, o.amount_minor, o.currency, a.provider_payment_id FROM payment_orders o JOIN payment_attempts a ON a.order_id = o.id WHERE o.id = $1 AND a.provider_payment_id IS NOT NULL ORDER BY a.created_at DESC LIMIT 1`, [orderId])).rows[0];
    if (!row || row.status !== 'observed') return;
    let p: ProviderPayment;
    try { p = await this.provider.getPayment(row.provider_payment_id); } catch { return; }   // cannot reach it now: the order stays observed, and an administrator sees that
    const why = p.status !== 'SUCCESS' ? `the provider's own record says ${p.status}, not SUCCESS` : p.amountMinor !== Number(row.amount_minor) || p.currency !== row.currency ? 'the provider\'s own record shows a different amount' : p.verificationLevel < 1 ? 'the provider reports the payment as unverified' : null;
    if (why) await this.pool.query(`UPDATE payment_orders SET status = 'review', review_reason = $2, updated_at = now() WHERE id = $1 AND status = 'observed'`, [orderId, why]);
  }
}
