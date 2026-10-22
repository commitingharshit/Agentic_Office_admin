import { AdminApiError, adminApi } from '../../../../lib/admin-api';
import { sameOrigin } from '../../../../lib/same-origin';
import { requireAdmin } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** The help assistant: the question goes to the admin API (which checks help.use, cleans it, answers from the documentation only, and logs no text). */
export async function POST(req: Request) {
  if (!sameOrigin(req) || !(req.headers.get('content-type') ?? '').startsWith('application/json')) return json(403, { error: 'Not allowed.' });
  const admin = await requireAdmin('/admin');
  const b = (await req.json().catch(() => ({}))) as { question?: unknown };
  if (typeof b.question !== 'string' || b.question.length > 2000) return json(400, { error: 'Ask a question of a few words.' });
  try { return json(200, await adminApi('/admin/help/ask', { acting: admin.id, method: 'POST', body: { question: b.question } })); }
  catch (e) { return e instanceof AdminApiError ? json(e.status, { error: e.message }) : json(503, { error: 'The help assistant is unavailable right now.' }); }
}
