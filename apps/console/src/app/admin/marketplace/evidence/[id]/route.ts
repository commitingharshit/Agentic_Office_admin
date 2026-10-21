import { AdminApiError, adminBytes } from '../../../../../lib/admin-api';
import { requireAdmin } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * One verification evidence image for a reviewer. The console forwards the service token (the browser never holds it or a blob URL);
 * the admin API checks marketplace.read, serves only a blob a verification row of THIS version references, and audits the read.
 * Anything that is not a PNG is refused here as well, and the response cannot be rendered as a page.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sha = new URL(req.url).searchParams.get('sha') ?? '';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !/^[0-9a-f]{64}$/.test(sha)) return new Response('Not found', { status: 404 });
  const admin = await requireAdmin('/admin/marketplace');
  try {
    const { bytes, type } = await adminBytes(`/admin/marketplace/versions/${encodeURIComponent(id)}/evidence?sha=${sha}`, { acting: admin.id });
    if (type !== 'image/png') return new Response('Not found', { status: 404 });
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store' } });
  } catch (e) { return new Response('Not found', { status: e instanceof AdminApiError && e.status === 403 ? 403 : 404 }); }
}
