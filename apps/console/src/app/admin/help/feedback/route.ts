import { AdminApiError, adminApi } from '../../../../lib/admin-api';
import { sameOrigin } from '../../../../lib/same-origin';
import { requireAdmin } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  if (!sameOrigin(req) || !(req.headers.get('content-type') ?? '').startsWith('application/json')) return json(403, { error: 'Not allowed.' });
  const admin = await requireAdmin('/admin');
  const b = (await req.json().catch(() => ({}))) as { questionId?: unknown; helpful?: unknown };
  if (!Number.isInteger(b.questionId) || typeof b.helpful !== 'boolean') return json(400, { error: 'questionId and helpful are required.' });
  try { return json(200, await adminApi('/admin/help/feedback', { acting: admin.id, method: 'POST', body: { questionId: b.questionId, helpful: b.helpful } })); }
  catch (e) { return e instanceof AdminApiError ? json(e.status, { error: e.message }) : json(503, { error: 'Unavailable.' }); }
}
