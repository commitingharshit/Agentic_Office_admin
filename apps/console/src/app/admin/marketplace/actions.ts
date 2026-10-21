'use server';
// Marketplace server actions. Same pattern as ../actions.ts: re-check the session, call the admin API as the signed-in admin, come back
// with the outcome in the address. The API enforces permissions and the state machine again; these only carry the request.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { adminApi, AdminApiError, load } from '../../../lib/admin-api';
import { ACTIONS, PUBLISHABLE_TYPES, VISIBILITIES, approvalRequest, haltRequest, hasPermission, incompleteAck, packValidation, policyChange } from '../../../lib/marketplace';
import { parsePolicyForm } from '../../../lib/marketplace-agents';
import { adminContext, requireAdmin } from '../../../lib/session';

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

/** Run the verification pipeline for one version (marketplace.review). The result is read back on the page; a queued run says so. */
export async function runVerification(f: FormData) {
  const id = field(f, 'id'), back = safeBack(field(f, 'back'), `/admin/marketplace/versions/${encodeURIComponent(id)}`);
  await act(back, 'Verification started. Reload in a moment to see the result.', (acting) => adminApi(`/admin/marketplace/versions/${encodeURIComponent(id)}/verify`, { acting, method: 'POST', body: {} }));
}

/** Approve a version whose verification is INCOMPLETE: the typed sentence is sent as acknowledgeIncomplete and stored in admin_audit. A manual-review type (agent, bundle) also needs its summary acknowledgement. */
export async function approveIncomplete(f: FormData) {
  const id = field(f, 'id'), back = safeBack(field(f, 'back'), `/admin/marketplace/versions/${encodeURIComponent(id)}`);
  const sentence = incompleteAck(field(f, 'ack_incomplete'));
  if (!sentence.ok) return done(back, 'err', sentence.error);
  const body: Record<string, unknown> = { acknowledgeIncomplete: sentence.text };
  if (field(f, 'ack')) {
    if (field(f, 'reviewed') !== 'on' && field(f, 'reviewed') !== 'true') return done(back, 'err', 'Tick "I reviewed the permission summary" first.');
    if (!/^[0-9a-f]{64}$/i.test(field(f, 'ack'))) return done(back, 'err', 'The summary hash is missing or malformed; reload the page.');
    body.ack_summary_sha256 = field(f, 'ack').toLowerCase();
  }
  await act(back, 'Version approved with an acknowledged incomplete verification.', (acting) => adminApi(`/admin/marketplace/versions/${encodeURIComponent(id)}/approve`, { acting, method: 'POST', body }));
}

/** A second, server-side role check before a mutating call: the console's permission list comes from the admin API, and the API checks it again. */
async function requirePermission(back: string, permission: string, what: string): Promise<void> {
  const { permissions } = await adminContext();
  if (!hasPermission(permissions, permission)) return done(back, 'err', `Your role cannot ${what} (needs ${permission}).`);
}

/** Approve a version that needs manual review, from its review page: only with the box ticked and the summary hash that was on screen. The API compares it with the hash of the stored version again. */
export async function approveWithAck(f: FormData) {
  const id = field(f, 'id'), back = `/admin/marketplace/review/${encodeURIComponent(id)}`;
  await requirePermission(back, 'marketplace.review', 'approve submissions');
  const r = approvalRequest({ reviewed: field(f, 'reviewed'), ack: field(f, 'ack') });
  if (!r.ok) return done(back, 'err', r.error);
  await act(back, 'Version approved.', (acting) => adminApi(`/admin/marketplace/versions/${encodeURIComponent(id)}/approve`, { acting, method: 'POST', body: r.body }));
}

/** Quarantine every published version of one type. A typed confirmation and a reason are required here; the API requires the reason and marketplace.moderate. */
export async function haltTypeAction(f: FormData) {
  const back = '/admin/marketplace/advanced';
  await requirePermission(back, 'marketplace.moderate', 'halt a type');
  const r = haltRequest({ type: field(f, 'type'), confirm: field(f, 'confirm'), reason: field(f, 'reason') });
  if (!r.ok) return done(back, 'err', r.error);
  let n = 0;
  const admin = await requireAdmin(back);
  try { n = (await adminApi<{ quarantinedVersions: number }>(`/admin/marketplace/types/${encodeURIComponent(r.type)}/halt`, { acting: admin.id, method: 'POST', body: { reason: r.reason } })).quarantinedVersions; }
  catch (e) { return done(back, 'err', e instanceof AdminApiError ? e.message : 'That did not work.'); }
  revalidatePath('/admin/marketplace', 'layout');
  return done(back, 'msg', `Halted ${r.type}: ${n} version${n === 1 ? '' : 's'} quarantined.`);
}

/** Raise a type's policy (marketplace.policy, superadmin). The floor comes from the API, never from the form. */
export async function saveTypePolicy(f: FormData) {
  const back = '/admin/marketplace/type-policy', type = field(f, 'type');
  await requirePermission(back, 'marketplace.policy', 'change a type policy');
  const admin = await requireAdmin(back);
  const cur = await load<{ items: Array<{ type: string; floor: { riskTier: string; manualReview: boolean; minPublisherTrust: string } }> }>('/admin/marketplace/type-policy', admin.id);
  const row = cur.ok ? cur.data.items.find((x) => x.type === type) : undefined;
  if (!row) return done(back, 'err', 'Unknown type.');
  const r = policyChange(row.floor, { riskTier: field(f, 'riskTier'), manualReview: field(f, 'manualReview'), minPublisherTrust: field(f, 'minPublisherTrust'), reason: field(f, 'reason') });
  if (!r.ok) return done(back, 'err', r.error);
  await act(back, `Policy of ${type} saved.`, (acting) => adminApi(`/admin/marketplace/type-policy/${encodeURIComponent(type)}`, { acting, method: 'PUT', body: r.body }));
}
