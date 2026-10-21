'use server';
// Marketplace server actions. Same pattern as ../actions.ts: re-check the session, call the admin API as the signed-in admin, come back
// with the outcome in the address. The API enforces permissions and the state machine again; these only carry the request.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { adminApi, AdminApiError } from '../../../lib/admin-api';
import { ACTIONS, PUBLISHABLE_TYPES, VISIBILITIES, packValidation } from '../../../lib/marketplace';
import { parsePolicyForm } from '../../../lib/marketplace-agents';
import { requireAdmin } from '../../../lib/session';

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const safeBack = (b: string, fallback: string) => (b.startsWith('/admin/marketplace') && !b.includes('//') && !b.includes('\\') ? b : fallback);
const done = (to: string, key: 'msg' | 'err', text: string): never => redirect(`${to}${to.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(text)}`);

async function act(back: string, ok: string, fn: (acting: string) => Promise<unknown>): Promise<never> {
  const admin = await requireAdmin(back);
  try { await fn(admin.id); } catch (e) { return done(back, 'err', e instanceof AdminApiError ? e.message : 'That did not work.'); }
  revalidatePath('/admin/marketplace', 'layout');
  return done(back, 'msg', ok);
}

export async function versionAction(f: FormData) {
  const id = field(f, 'id'), action = field(f, 'action'), back = safeBack(field(f, 'back'), '/admin/marketplace/review');
  if (!(ACTIONS as readonly string[]).includes(action)) return done(back, 'err', 'Unknown action.');
  const body: Record<string, unknown> = {};
  if (field(f, 'reason')) body.reason = field(f, 'reason');
  await act(back, `Version ${action === 'claim' ? 'claimed' : action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'publish' ? 'published' : action === 'deprecate' ? 'deprecated' : action === 'quarantine' ? 'quarantined' : 'revoked'}.`,
    (acting) => adminApi(`/admin/marketplace/versions/${encodeURIComponent(id)}/${action}`, { acting, method: 'POST', body }));
}
export async function rescanVersion(f: FormData) {
  const id = field(f, 'id'), back = safeBack(field(f, 'back'), '/admin/marketplace/review');
  let verdict = '';
  await act(back, 'Rescanned.', async (acting) => {
    const r = await adminApi<{ validation?: { ok?: boolean; verified?: boolean } }>(`/admin/marketplace/versions/${encodeURIComponent(id)}/rescan`, { acting, method: 'POST', body: {} });
    verdict = r.validation?.verified ? 'verified' : r.validation?.ok ? 'NOT verified' : 'failed';
    if (verdict !== 'verified') throw new AdminApiError(409, `Rescan finished: ${verdict}. See the scan results below.`);
  });
}
export async function deleteReview(f: FormData) {
  const id = field(f, 'id');
  await act(safeBack(field(f, 'back'), '/admin/marketplace/reviews'), 'Review deleted.', (acting) => adminApi(`/admin/marketplace/reviews/${encodeURIComponent(id)}`, { acting, method: 'DELETE' }));
}
export async function saveMarketplacePublisher(f: FormData) {
  const id = field(f, 'id');
  await act('/admin/marketplace/publishers', `Publisher ${id} saved.`, (acting) => adminApi('/admin/marketplace/publishers', { acting, method: 'POST', body: { id, trust: field(f, 'trust'), ...(field(f, 'displayName') ? { displayName: field(f, 'displayName') } : {}), ...(field(f, 'ownerUserId') ? { ownerUserId: field(f, 'ownerUserId') } : {}) } }));
}
export async function resolveReport(f: FormData) {
  const id = field(f, 'id');
  await act('/admin/marketplace/security', `Report marked ${field(f, 'state')}.`, (acting) => adminApi(`/admin/marketplace/reports/${encodeURIComponent(id)}/resolve`, { acting, method: 'POST', body: { state: field(f, 'state'), ...(field(f, 'reason') ? { reason: field(f, 'reason') } : {}) } }));
}

/** Upload a package. The server's validation report is the answer: the page re-reads it (by version id, or packed in the address when nothing was stored). */
export async function submitPackage(f: FormData) {
  const back = '/admin/marketplace/publish';
  const admin = await requireAdmin(back);
  const type = field(f, 'type'), visibility = field(f, 'visibility'), publisher = field(f, 'publisher');
  const file = f.get('package');
  if (!PUBLISHABLE_TYPES.includes(type)) return done(back, 'err', 'Not available in this release.');
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) return done(back, 'err', 'Choose a visibility.');
  if (!publisher) return done(back, 'err', 'Choose a publisher.');
  if (!(file instanceof File) || file.size === 0) return done(back, 'err', 'Choose a package ZIP to upload.');
  const qs = new URLSearchParams({ publisher, visibility });
  if (field(f, 'team')) qs.set('team', field(f, 'team'));
  let r: { versionId: string; state: string; validation: any };
  try {
    r = await adminApi(`/admin/marketplace/submissions?${qs}`, { acting: admin.id, method: 'POST', bytes: { data: new Uint8Array(await file.arrayBuffer()), contentType: 'application/zip' } });
  } catch (e) {
    if (e instanceof AdminApiError && e.body?.validation) return done(`${back}?vr=${packValidation(e.body.validation)}`, 'err', e.message);
    return done(back, 'err', e instanceof AdminApiError ? e.message : 'That did not work.');
  }
  revalidatePath('/admin/marketplace', 'layout');
  return redirect(`${back}?vr=${packValidation(r.validation)}&version=${encodeURIComponent(r.versionId)}&state=${encodeURIComponent(r.state)}`);
}

/** Approve a manual-review version after reading the server's summary: the hash shown with it is sent back, and the API compares it to the hash of this exact version. */
export async function approveReviewed(f: FormData) {
  const id = field(f, 'id'), back = safeBack(field(f, 'back'), '/admin/marketplace/review');
  if (!/^[0-9a-f]{64}$/i.test(field(f, 'ack'))) return done(back, 'err', 'The summary hash is missing; reload the page.');
  await act(back, 'Version approved after review.', (acting) => adminApi(`/admin/marketplace/versions/${encodeURIComponent(id)}/approve`, { acting, method: 'POST', body: { ack_summary_sha256: field(f, 'ack') } }));
}

/** The organization install policy. The API needs marketplace.policy and validates every value; this only parses the form into the document. */
export async function saveOrgPolicy(f: FormData) {
  const back = '/admin/marketplace/policies';
  const parsed = parsePolicyForm({ mode: field(f, 'mode'), minTrust: field(f, 'minTrust'), requireCleanScan: field(f, 'requireCleanScan') || undefined, rules: String(f.get('rules') ?? '') });
  if (!parsed.ok) return done(back, 'err', parsed.error);
  await act(back, 'Organization policy saved.', (acting) => adminApi('/admin/marketplace/policies/org', { acting, method: 'PUT', body: parsed.doc }));
}
