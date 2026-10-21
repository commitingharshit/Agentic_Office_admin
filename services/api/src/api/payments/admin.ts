// The administrator's side of payments: see every order and what the provider told us, and take the three deliberate steps that change money
// state: settle (the bank credit was checked), reject, refund. Each needs a reason, is audited by the caller, and goes through the database
// functions that do all or nothing. Nobody can rewrite the ledger or mark an unobserved order paid from here.
import type pg from 'pg';
import type { AdminDeps } from '../admin.ts';
import { HttpError } from '../errors.ts';
import { toMajor, toMinor } from './youpi.ts';
import { stateOf, type OrderStatus } from './service.ts';

const rows = async (p: pg.Pool, sql: string, args: unknown[] = []) => (await p.query(sql, args)).rows;
const ORDER = /^ord_[A-Za-z0-9]{10,60}$/;
const STATUSES = ['created', 'pending', 'observed', 'review', 'settled', 'failed', 'expired', 'cancelled', 'refunded', 'rejected'];
const reasonOf = (b: Record<string, unknown>, what = 'A reason'): string => { const r = typeof b.reason === 'string' ? b.reason.trim() : ''; if (r.length < 3 || r.length > 500) throw new HttpError(400, `${what} of 3 to 500 characters is required.`); return r; };

export async function listOrders(deps: AdminDeps, q: URLSearchParams) {
  const status = q.get('status'), userId = q.get('user_id');
  if (status && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
  const where: string[] = [], args: unknown[] = [];
  if (status) { args.push(status); where.push(`o.status = $${args.length}`); }
  if (userId) { if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId)) throw new HttpError(400, 'Not a user id.'); args.push(userId); where.push(`o.user_id = $${args.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const list = await rows(deps.ro, `SELECT o.id, o.user_id, u.email, o.plan_id, o.amount_minor, o.currency, o.billing_interval, o.status, o.provider, o.provider_reference, o.review_reason, o.created_at, o.observed_at, o.settled_at
    FROM payment_orders o JOIN users u ON u.id = o.user_id ${w} ORDER BY (o.status IN ('observed','review')) DESC, o.created_at DESC LIMIT 200`, args);
  const [counts] = await rows(deps.ro, `SELECT count(*) FILTER (WHERE status = 'observed')::int AS observed, count(*) FILTER (WHERE status = 'review')::int AS review, count(*) FILTER (WHERE status = 'settled')::int AS settled, count(*) FILTER (WHERE status IN ('created','pending'))::int AS pending FROM payment_orders`);
  return { orders: list.map((o) => ({ ...o, amount_minor: Number(o.amount_minor), amount: toMajor(Number(o.amount_minor)), state: stateOf(o.status as OrderStatus) })), counts };
}

export async function orderDetail(deps: AdminDeps, id: string) {
  if (!ORDER.test(id)) throw new HttpError(400, 'Not an order id.');
  const [o] = await rows(deps.ro, `SELECT o.*, u.email, u.status AS user_status FROM payment_orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [id]);
  if (!o) throw new HttpError(404, 'No such order.');
  const attempts = await rows(deps.ro, `SELECT id, provider, provider_payment_id, status, error, created_at FROM payment_attempts WHERE order_id = $1 ORDER BY created_at`, [id]);
  const events = await rows(deps.ro, `SELECT id::int, delivery_id, event, signature_ok, outcome, received_at, payload FROM payment_events WHERE order_id = $1 ORDER BY id`, [id]);
  const [invoice] = await rows(deps.ro, `SELECT number, issued_at FROM invoices WHERE order_id = $1`, [id]);
  const [period] = await rows(deps.ro, `SELECT starts_at, ends_at FROM subscription_periods WHERE order_id = $1`, [id]);
  return { order: { ...o, amount_minor: Number(o.amount_minor), amount: toMajor(Number(o.amount_minor)), state: stateOf(o.status) }, attempts, events, invoice: invoice ?? null, period: period ?? null };
}

/** The bank credit was checked by a person. The amount they enter must equal the order's; a bank reference they enter must equal the one the provider reported. */
export async function settleOrder(deps: AdminDeps, adminId: string, id: string, b: Record<string, unknown>) {
  if (!ORDER.test(id)) throw new HttpError(400, 'Not an order id.');
  const reason = reasonOf(b, 'Say how you checked the bank record: a reason');
  const [o] = await rows(deps.ro, `SELECT o.status, o.amount_minor, o.currency, o.provider_reference, u.status AS user_status FROM payment_orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [id]);
  if (!o) throw new HttpError(404, 'No such order.');
  if (o.status === 'settled') return { already: true, order_id: id };
  if (o.status !== 'observed' && o.status !== 'review') throw new HttpError(409, `This order is ${o.status}: only an order the provider reported as paid can be settled.`);
  if (o.user_status !== 'active') throw new HttpError(409, 'This person\'s account is not active. Enable it, or reject the order.');
  const received = typeof b.amount_received === 'string' ? toMinor(b.amount_received) : typeof b.amount_received_minor === 'number' && Number.isInteger(b.amount_received_minor) ? b.amount_received_minor : undefined;
  if (received === undefined) throw new HttpError(400, 'Enter the amount the bank received, such as 499.00.');
  if (received !== Number(o.amount_minor)) throw new HttpError(409, `The bank amount (${toMajor(received)}) is not the order amount (${toMajor(Number(o.amount_minor))}). Do not settle: reject or refund it instead.`);
  const ref = typeof b.reference === 'string' ? b.reference.trim() : '';
  if (ref && !/^[A-Za-z0-9-]{6,40}$/.test(ref)) throw new HttpError(400, 'The bank reference is letters and digits, 6 to 40 characters.');
  if (o.provider_reference && ref && ref !== o.provider_reference) throw new HttpError(409, 'That bank reference differs from the one the provider reported.');
  if (o.status === 'review' && !ref && !o.provider_reference) throw new HttpError(400, 'An order in review needs the bank reference you checked.');
  const evidence = { amount_minor: received, currency: o.currency, reference: ref || o.provider_reference || null, reason, method: 'manual_bank_reconciliation', checked_by: adminId };
  try {
    const r = (await deps.admin.query('SELECT ao_activate_order($1, $2, $3) AS r', [id, adminId, JSON.stringify(evidence)])).rows[0].r;
    return r;
  } catch (e) { throw dbError(e); }
}

export async function rejectOrder(deps: AdminDeps, adminId: string, id: string, b: Record<string, unknown>) {
  if (!ORDER.test(id)) throw new HttpError(400, 'Not an order id.');
  const reason = reasonOf(b);
  const r = await deps.admin.query(`UPDATE payment_orders SET status = 'rejected', review_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('observed', 'review') RETURNING id`, [id, `${reason} (rejected by ${adminId})`]);
  if (!r.rowCount) throw new HttpError(409, 'Only an order waiting for review can be rejected.');
  return { ok: true };
}

export async function refundOrder(deps: AdminDeps, adminId: string, id: string, b: Record<string, unknown>) {
  if (!ORDER.test(id)) throw new HttpError(400, 'Not an order id.');
  const reason = reasonOf(b);
  try { return (await deps.admin.query('SELECT ao_refund_order($1, $2, $3) AS r', [id, adminId, reason])).rows[0].r; } catch (e) { throw dbError(e); }
}

function dbError(e: unknown): Error {
  const m = (e as Error).message ?? '';
  if (/order_not_found/.test(m)) return new HttpError(404, 'No such order.');
  if (/order_not_settleable:(\w+)/.test(m)) return new HttpError(409, `This order is ${/order_not_settleable:(\w+)/.exec(m)![1]}.`);
  if (/order_not_refundable:(\w+)/.test(m)) return new HttpError(409, `Only a settled order can be refunded (this one is ${/order_not_refundable:(\w+)/.exec(m)![1]}).`);
  if (/amount_mismatch/.test(m)) return new HttpError(409, 'The evidence does not match the order amount.');
  return e as Error;
}
