// A stand-in for a self-hosted YouPI-PG, speaking its documented contract (docs/MERCHANT_INTEGRATION.md, openapi.yaml): payment creation with an
// Idempotency-Key, status lookup, cancel, and signed webhooks (HMAC-SHA256 over the raw body, X-Gateway-Signature: sha256=…, delivery id, timestamp in ms).
// Tests drive it to play the provider: succeed, fail, expire, replay, tamper, go down. No real payment is possible against it.
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockPayment { paymentId: string; orderId: string; amountMinor: number; currency: string; status: string; verificationLevel: number; utr?: string; idempotencyKey?: string }
export const SECRET = 'whsec_test_0123456789abcdef0123456789abcdef';
export const MERCHANT = '00000000-0000-4000-8000-000000000001';
const major = (m: number) => `${Math.floor(m / 100)}.${String(m % 100).padStart(2, '0')}`;

export class MockYoupi {
  server!: Server; url = '';
  payments = new Map<string, MockPayment>();
  created: Array<{ body: any; headers: Record<string, string | string[] | undefined> }> = [];
  cancelled: string[] = [];
  down = false; failCreate = false; chargeDifferent = false;

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (this.down) { req.socket.destroy(); return; }
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.headers['x-merchant-id'] !== MERCHANT) return send(403, { error: 'unknown merchant' });
    if (req.method === 'POST' && u.pathname === '/api/v1/payments') {
      const body = raw ? JSON.parse(raw) : {};
      this.created.push({ body, headers: req.headers });
      if (this.failCreate) return send(500, { error: 'internal' });
      if (!body.orderId || !/^\d+\.\d{2}$/.test(String(body.amount ?? ''))) return send(400, { error: 'Missing required fields: orderId and amount.' });
      const key = String(req.headers['idempotency-key'] ?? '');
      const again = key ? [...this.payments.values()].find((p) => p.idempotencyKey === key) : undefined;
      const [a, b] = String(body.amount).split('.'); const minor = Number(a) * 100 + Number(b);
      const p: MockPayment = again ?? { paymentId: randomUUID(), orderId: body.orderId, amountMinor: minor, currency: 'INR', status: 'ACTIVE', verificationLevel: 0, idempotencyKey: key || undefined };
      this.payments.set(p.paymentId, p);
      const shown = this.chargeDifferent ? p.amountMinor + 100 : p.amountMinor;
      return send(again ? 200 : 201, { paymentId: p.paymentId, orderId: p.orderId, amount: major(shown), amountPaise: String(shown), currency: 'INR', status: p.status, checkoutUrl: `${this.url}/checkout/${p.paymentId}` });
    }
    const get = /^\/api\/v1\/payments\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'GET' && get) {
      const p = this.payments.get(get[1]); if (!p) return send(404, { error: 'not found' });
      return send(200, { paymentId: p.paymentId, orderId: p.orderId, amount: major(p.amountMinor), amountPaise: String(p.amountMinor), currency: p.currency, status: p.status, method: 'UPI', verificationLevel: p.verificationLevel, utr: p.utr, completedAt: null });
    }
    const cancel = /^\/api\/v1\/checkout\/([^/]+)\/cancel$/.exec(u.pathname);
    if (req.method === 'POST' && cancel) { const p = this.payments.get(cancel[1]); if (!p) return send(404, {}); p.status = 'CANCELLED'; this.cancelled.push(p.paymentId); return send(200, { success: true, status: 'CANCELLED' }); }
    return send(404, { error: 'not found' });
  }

  /** What the provider would POST to us for this payment, as raw bytes + headers. Override pieces to play a bad or odd sender. */
  webhook(paymentId: string, event: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'CANCELLED', o: { amountMinor?: number; currency?: string; orderId?: string; deliveryId?: string; timestamp?: number; secret?: string; utr?: string; tamper?: boolean; noSignature?: boolean } = {}) {
    const p = this.payments.get(paymentId)!;
    const amount = o.amountMinor ?? p.amountMinor;
    const payload = { event, paymentId, orderId: o.orderId ?? p.orderId, amount: major(amount), amountPaise: amount, currency: o.currency ?? p.currency, method: 'UPI', utr: o.utr ?? (event === 'SUCCESS' ? '412345678901' : undefined), completedAt: new Date().toISOString(), metadata: {} };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = `sha256=${createHmac('sha256', o.secret ?? SECRET).update(raw).digest('hex')}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-gateway-event': event, 'x-gateway-delivery-id': o.deliveryId ?? randomUUID(), 'x-gateway-timestamp': String(o.timestamp ?? Date.now()) };
    if (!o.noSignature) headers['x-gateway-signature'] = sig;
    const body = o.tamper ? Buffer.from(raw.toString().replace(`"amountPaise":${amount}`, `"amountPaise":${amount - 100}`)) : raw;
    return { body, headers };
  }

  async deliver(to: string, w: { body: Buffer; headers: Record<string, string> }) {
    const r = await fetch(to, { method: 'POST', headers: w.headers, body: w.body });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  }

  /** The provider's own record changes (what a status lookup would return). */
  set(paymentId: string, patch: Partial<MockPayment>) { Object.assign(this.payments.get(paymentId)!, patch); }
}
