import { adminApi } from '../../../../lib/admin-api';
import { requireAdmin } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/** The directory as CSV (up to 10,000 rows, formula-looking cells quoted by the API). The admin API checks the permission and audits the export. */
export async function GET(req: Request) {
  const admin = await requireAdmin('/admin/users');
  const p = new URL(req.url).searchParams;
  const out = new URLSearchParams({ format: 'csv' });
  for (const k of ['q', 'status', 'role', 'plan', 'provider', 'from', 'to', 'sort', 'dir']) if (p.get(k)) out.set(k, p.get(k)!);
  try {
    const csv = await adminApi<string>(`/admin/users?${out}`, { acting: admin.id });
    return new Response(String(csv), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="agentic-office-users.csv"', 'cache-control': 'no-store' } });
  } catch (e) { return new Response((e as Error).message, { status: 403 }); }
}
