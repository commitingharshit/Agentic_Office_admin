// The reviewer-facing permission summary of a version (Plan 3 Task 12). Built ONLY from the stored manifest and the recorded validation
// checks; nothing here reads request input. Two rules matter more than any rendering detail:
//   1. The hash the reviewer acknowledges (`reviewSummaryHash`) covers the whole canonical manifest payload, the artifact sha and the risk
//      tier, so a change to ANYTHING the text is derived from changes the hash, and a stale acknowledgement cannot approve a different
//      version. (This is the Plan 3 Task 1 hash, moved here unchanged; test/marketplace-advanced-admin.test.ts pins it.)
//   2. The text must never hide what the hash covers. Every rule/tool/field is listed (the validators cap their counts, the summary does
//      not re-cap them below that); if the summary still cannot show everything within its hard size cap it says so (`truncated`) and the
//      approve path refuses it (a reviewer must not approve what they could not read).
// No secret ever appears: values are withheld when they look like credentials, secret fields and env vars are shown by NAME only.
import { createHash } from 'node:crypto';
import { checkNoLiteralSecrets } from './validate/advanced-common.ts';
import { HOOK_EVENTS } from './validate/hook.ts';
import { LOCAL_PROVIDERS, PROVIDER_HOSTS } from './validate/memory.ts';
import { classifyTool, walkPlan } from './validate/workflow.ts';
import type { ListingType, ManifestV1, RiskTier } from './types.ts';

export const MAX_SUMMARY_BYTES = 32 * 1024;
export const MAX_LINE = 400;
export const MAX_PROMPT = 4096;
export const MAX_HIGH_RISK = 24;
const MAX_ITEMS = 200;

export interface SummarySection { title: string; lines: string[] }
export interface SummaryCheck { name: string; ok: boolean; skipped: boolean; detail: string | null }
export interface ReviewSummary {
  text: string; sha256: string; riskTier: RiskTier; highRisk: string[]; truncated: boolean;
  sections: SummarySection[]; validation: SummaryCheck[];
}
export interface SummaryContext { artifactSha256: string; riskTier: RiskTier | string | null; checks?: ReadonlyArray<{ name: string; ok: boolean; skipped?: boolean; detail?: string }> }

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩​-‏﻿]/g;

const WITHHELD = '[withheld: looks like a credential]';
/** Text safe to show: control and bidi characters removed, credential-looking values withheld, length capped. Never throws. */
export function safe(v: unknown, cap = MAX_LINE, keepNewlines = false): string {
  if (v === undefined || v === null) return '';
  let s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '[object]';
  s = (keepNewlines ? s.replace(/\r/g, '') : s.replace(/[\n\r\t]+/g, ' ')).replace(CTRL, '');
  if (s.length > cap + 400) s = s.slice(0, cap + 400);       // bound the scan itself
  if (s && !checkNoLiteralSecrets(s, new Set()).ok) return WITHHELD;
  return s.length > cap ? `${s.slice(0, cap)}... [${s.length - cap} more characters not shown]` : s;
}

/** The Plan 3 Task 1 acknowledgement hash, unchanged: canonical JSON of what the version asks for. */
export function reviewSummaryHash(manifest: any, artifactSha: string, tier: string | null): string {
  const canon = (v: any): any => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  const perms = Array.isArray(manifest?.permissions) ? [...manifest.permissions].map(canon).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) : [];
  return createHash('sha256').update(JSON.stringify(canon({ schema: 'agentic.marketplace.review-summary/1', id: manifest?.id, type: manifest?.type, version: manifest?.version,
    artifact: artifactSha, riskTier: tier, permissions: perms, dependencies: canon(manifest?.dependencies ?? []), payload: canon(manifest?.payload ?? {}) }))).digest('hex');
}

class Builder {
  sections: SummarySection[] = []; highRisk: string[] = []; truncated = false; private bytes = 0;
  section(title: string): SummarySection { const s = { title, lines: [] as string[] }; this.sections.push(s); return s; }
  line(s: SummarySection, text: string) {
    const t = text.length > MAX_LINE * 3 ? text.slice(0, MAX_LINE * 3) : text;
    if (t.includes(WITHHELD)) this.risk('some text was withheld because it looks like a credential');
    this.bytes += t.length + 1;
    if (this.bytes > MAX_SUMMARY_BYTES) { this.truncated = true; return; }
    s.lines.push(t);
  }
  list<T>(s: SummarySection, items: T[], render: (x: T) => string, what: string) {
    const shown = items.slice(0, MAX_ITEMS);
    for (const x of shown) this.line(s, render(x));
    if (items.length > shown.length) { this.truncated = true; this.line(s, `[${items.length - shown.length} more ${what} not shown]`); }
  }
  risk(r: string) { const t = safe(r, 160); if (t && !this.highRisk.includes(t) && this.highRisk.length < MAX_HIGH_RISK) this.highRisk.push(t); else if (this.highRisk.length >= MAX_HIGH_RISK && !this.highRisk.includes('more high-risk items than can be listed')) this.highRisk.push('more high-risk items than can be listed'); }
}

const hostOf = (url: unknown): string => {
  if (typeof url !== 'string') return '';
  const m = /^https?:\/\/([^/?#:@]+)/i.exec(url.replace(/\{[^}]*\}/g, 'X'));
  return m ? safe(url.split(/[?#]/)[0], 200) : safe(url.split(/[?#]/)[0], 200);
};

function common(b: Builder, type: ListingType, m: ManifestV1, ctx: SummaryContext, tier: RiskTier) {
  const s = b.section('Package');
  b.line(s, `${safe(m.id, 120)} ${safe(m.version, 40)} (${type})`);
  b.line(s, `Title: ${safe(m.title, 160)}`);
  b.line(s, `Risk tier: ${tier}`);
  b.line(s, `Artifact sha256: ${/^[0-9a-f]{64}$/.test(ctx.artifactSha256) ? ctx.artifactSha256 : safe(ctx.artifactSha256, 80)}`);   // a plain hash is not a secret (the credential scan would withhold it)
  b.line(s, `Files: ${arr(m.files).length}`);
  if (tier === 'executable') b.risk('risk tier: executable (elevated consent)');
  const p = b.section('Permissions declared (the union the user will be asked to grant)');
  const perms = arr(m.permissions).filter(isObj);
  if (!perms.length) b.line(p, 'None.');
  b.list(p, perms, (x) => `${safe(x.capability, 40)}  ${safe(x.scope, 160)}  - ${safe(x.reason, 200)}`, 'permissions');
  for (const x of perms) {
    if (x.capability === 'exec.script') b.risk(`runs code: exec.script ${safe(x.scope, 60)}`);
    else if (x.capability === 'secrets.use') b.risk(`uses a secret: ${safe(x.scope, 60)}`);
    else if (x.capability === 'network') b.risk(`network: ${safe(x.scope, 80)}${/\*/.test(String(x.scope)) ? ' (wildcard)' : ''}`);
    else if (x.capability === 'fs.workspace.write') b.risk(`writes workspace files: ${safe(x.scope, 60)}`);
  }
  const d = arr(m.dependencies).filter(isObj);
  if (d.length) { const ds = b.section('Dependencies'); b.list(ds, d, (x) => `${safe(x.id, 120)} ${safe(x.range, 60)}`, 'dependencies'); }
}

function hook(b: Builder, payload: Record<string, any>) {
  const s = b.section('Hook rules (every rule is listed)');
  b.line(s, `Mode: ${safe(payload.kind, 40) || '(none)'}`);
  if (payload.kind !== 'declarative') b.risk(`hook mode ${safe(payload.kind, 30) || 'unknown'} is not the declarative engine`);
  const rules = arr(payload.rules);
  b.line(s, `Rules: ${rules.length}`);
  b.list(s, rules, (r) => {
    if (!isObj(r)) return '- (malformed rule)';
    const ev = typeof r.event === 'string' && Object.prototype.hasOwnProperty.call(HOOK_EVENTS, r.event) ? HOOK_EVENTS[r.event] : null;
    const when = isObj(r.when) ? Object.entries(r.when).map(([k, v]) => `${safe(k, 24)}=${isObj(v) ? '{' + Object.entries(v).map(([a, c]) => `${safe(a, 40)}:${safe(c, 80)}`).join(', ') + '}' : safe(v, 80)}`).join('; ') : '';
    const a = isObj(r.action) ? r.action : {};
    const text = a.type === 'block' ? safe(a.message, 300) : a.type === 'inject_context' ? safe(a.text, 2048) : '';
    return `- [${safe(r.id, 40)}] on ${safe(r.event, 60)}${ev ? ` -> Hermes ${ev.hermes || 'none'} (${ev.status})` : ' (NOT a known event)'}${when ? ` when ${when}` : ''}: ${safe(a.type, 30)}${text ? ` "${text}"` : ''}`;
  }, 'rules');
  for (const r of rules) {
    if (!isObj(r)) continue;
    const ev = typeof r.event === 'string' && Object.prototype.hasOwnProperty.call(HOOK_EVENTS, r.event) ? HOOK_EVENTS[r.event] : null;
    if (!ev) b.risk(`rule ${safe(r.id, 30)}: event ${safe(r.event, 40)} is not a mapped event`);
    else if (ev.status !== 'direct') b.risk(`rule ${safe(r.id, 30)}: event ${safe(r.event, 40)} is ${ev.status}, not exact`);
    const a = isObj(r.action) ? r.action : {};
    if (a.type === 'block') b.risk(`rule ${safe(r.id, 30)} can BLOCK ${safe(r.when?.tool, 60) || 'matching calls'}`);
    if (a.type === 'inject_context') b.risk(`rule ${safe(r.id, 30)} injects text into the model context`);
  }
}

function toolLines(b: Builder, s: SummarySection, tools: any[]) {
  b.list(s, tools.filter(isObj), (t) => `- ${safe(t.name, 80)} [${safe(t.capability, 20)}] ${safe(t.summary, 160)}`, 'tools');
  for (const t of tools) if (isObj(t) && t.capability !== 'read') b.risk(`${safe(t.capability, 20)} tool: ${safe(t.name, 60)}`);
}

function bridge(b: Builder, payload: Record<string, any>) {
  const srv = isObj(payload.server) ? payload.server : {};
  const s = b.section('Bridge: remote MCP server');
  b.line(s, `Host: ${hostOf(srv.url)}   Transport: ${safe(srv.transport, 40)}`);
  const auth = isObj(payload.auth) ? payload.auth : null;
  b.line(s, auth ? `Auth: ${safe(auth.kind, 30)} header ${safe(auth.header, 60)} scheme ${safe(auth.scheme, 30)}, uses secret named "${safe(auth.secret, 60)}" (value never shown)` : 'Auth: none');
  if (isObj(payload.limits)) b.line(s, `Limits: ${Object.entries(payload.limits).map(([k, v]) => `${safe(k, 30)}=${safe(v, 20)}`).join(', ')}`);
  const t = b.section('Tools it exposes to the agent');
  toolLines(b, t, arr(payload.tools));
}

function connector(b: Builder, payload: Record<string, any>) {
  const s = b.section('Connector definition');
  b.line(s, `Service: ${safe(payload.service, 80)}`);
  const auth = isObj(payload.auth) ? payload.auth : {};
  b.line(s, `Auth: ${safe(auth.kind, 30)}${auth.header ? ` header ${safe(auth.header, 60)}` : ''}`);
  const br = isObj(payload.bridge) ? payload.bridge : {};
  b.line(s, `Server: ${hostOf(br.url_template)} (${safe(br.transport, 40)})`);
  if (isObj(payload.health)) b.line(s, `Health check: ${safe(payload.health.path, 80)}`);
  if (isObj(payload.limits)) b.line(s, `Limits: ${Object.entries(payload.limits).map(([k, v]) => `${safe(k, 30)}=${safe(v, 20)}`).join(', ')}`);
  const f = b.section('Fields the user fills in (values are stored on the device only)');
  b.list(f, arr(payload.fields).filter(isObj), (x) => `- ${safe(x.key, 60)}: ${safe(x.label, 80)}${x.secret === true ? ' [SECRET, kept in the OS keychain]' : ''}${x.pattern ? ` pattern ${safe(x.pattern, 120)}` : ''}`, 'fields');
  for (const x of arr(payload.fields)) if (isObj(x) && x.secret === true) b.risk(`secret field: ${safe(x.key, 60)}`);
  const n = b.section('Data locality and network');
  const dl = isObj(payload.data_locality) ? payload.data_locality : {};
  b.line(n, `Data: ${safe(dl.description, 300) || '(not declared)'}`);
  b.line(n, `Regions: ${arr(dl.regions).map((r) => safe(r, 30)).join(', ') || '(not declared)'}`);
  b.line(n, `Network allowlist: ${arr(payload.network_allowlist).map((h) => safe(h, 80)).join(', ') || '(none)'}`);
  for (const h of arr(payload.network_allowlist)) b.risk(`network: ${safe(h, 80)}${/\*/.test(String(h)) ? ' (wildcard)' : ''}`);
  const t = b.section('Tools it exposes to the agent');
  toolLines(b, t, arr(br.tools));
}

function routine(b: Builder, payload: Record<string, any>) {
  const bp = isObj(payload.blueprint) ? payload.blueprint : {};
  const s = b.section('Routine blueprint');
  b.line(s, `Schedule template: ${safe(bp.schedule_template, 120)}`);
  b.line(s, `Delivery: ${safe(bp.deliver_default, 60) || '(default)'}`);
  b.line(s, `Toolsets it may use: ${arr(bp.enabled_toolsets).map((t) => safe(t, 40)).join(', ') || '(none)'}`);
  for (const t of arr(bp.enabled_toolsets)) b.risk(`toolset: ${safe(t, 40)}`);
  if (bp.deliver_default && bp.deliver_default !== 'local') b.risk(`delivers output to ${safe(bp.deliver_default, 40)}`);
  const sl = b.section('Settings the user chooses at install');
  b.list(sl, arr(bp.slots).filter(isObj), (x) => `- ${safe(x.name, 40)} (${safe(x.type, 30)}): ${safe(x.label, 80)}, default ${safe(x.default, 80)}`, 'settings');
  const p = b.section('Prompt the agent will run (full text, template placeholders in braces)');
  b.line(p, safe(bp.prompt_template, MAX_PROMPT, true));
  b.line(p, 'It runs on a schedule WITHOUT the user present.');
  b.risk('runs unattended on a schedule');
}

function memory(b: Builder, payload: Record<string, any>) {
  const prov = typeof payload.provider === 'string' ? payload.provider : '';
  const local = LOCAL_PROVIDERS.includes(prov);
  const host = Object.prototype.hasOwnProperty.call(PROVIDER_HOSTS, prov) ? PROVIDER_HOSTS[prov] : null;
  const s = b.section('Memory backend');
  b.line(s, `Provider: ${safe(prov, 60)} (a provider Hermes already ships; this listing is configuration only)`);
  b.line(s, `Scope: ${safe(payload.scope, 30)}`);
  b.line(s, `Data locality: ${local ? 'local to this device' : host ? `REMOTE: your memories are sent to ${host}` : 'unknown provider (not a known local or remote provider)'}`);
  if (!local) b.risk(host ? `memory leaves the device: ${host}` : 'unknown memory provider');
  const cfg = isObj(payload.config) ? Object.entries(payload.config) : [];
  const c = b.section('Configuration keys');
  if (!cfg.length) b.line(c, 'None.');
  b.list(c, cfg, ([k, v]) => `- ${safe(k, 60)} = ${typeof v === 'boolean' || typeof v === 'number' ? safe(v) : typeof v === 'string' && v.length <= 60 && !/[:/]/.test(v) ? safe(v, 60) : typeof v === 'string' && /^\$HERMES_HOME\//.test(v) ? safe(v, 100) : '(text, not shown)'}`, 'keys');
  const sec = arr(payload.secrets).filter(isObj);
  if (sec.length) { const x = b.section('Secrets (names only; the user supplies the values)'); b.list(x, sec, (e) => `- ${safe(e.key, 60)} via environment variable ${safe(e.env_var, 60)}`, 'secrets'); for (const e of sec) b.risk(`secret: ${safe(e.env_var, 60)}`); }
}

function workflow(b: Builder, payload: Record<string, any>) {
  const plan = payload.plan;
  const facts = walkPlan(plan, payload?.requires?.agent_nodes === true);
  const s = b.section('Workflow (DAG summary)');
  b.line(s, `Root step: ${isObj(plan) ? safe(plan.type, 30) : '(missing)'}`);
  b.line(s, `Steps: ${facts.nodes}   Depth: ${facts.depth}   Agent steps: ${facts.agentSteps}`);
  if (facts.agentSteps) b.risk(`${facts.agentSteps} agent step(s) run a model with tools`);
  const params = arr(payload.parameters).filter(isObj);
  if (params.length) { const p = b.section('Parameters the user supplies'); b.list(p, params, (x) => `- ${safe(x.name, 40)} (${safe(x.type, 30)})`, 'parameters'); }
  const t = b.section('Tools it calls (server:tool, area)');
  const seen = new Set<string>();
  const uniq = facts.tools.filter((u) => { const k = `${u.server}:${u.tool}`; if (seen.has(k)) return false; seen.add(k); return true; });
  b.list(t, uniq, (u) => { const c = classifyTool(u.server, u.tool); return `- ${safe(u.server, 60)}:${safe(u.tool, 80)} (${c.ok ? c.area : 'UNKNOWN: ' + c.reason})`; }, 'tools');
  for (const u of uniq) { const c = classifyTool(u.server, u.tool); if (!c.ok) b.risk(`unclassified tool ${safe(u.server, 30)}:${safe(u.tool, 40)}`); else if (c.area === 'edit' || c.area === 'author') b.risk(`changes documents: ${safe(u.server, 30)}:${safe(u.tool, 40)}`); }
  const problems = [...facts.shape, ...facts.acyclic, ...facts.caps].length;
  if (problems) b.risk(`the plan has ${problems} structural problem(s)`);
}

function agentOrBundle(b: Builder, type: ListingType, payload: Record<string, any>, checks: SummaryCheck[]) {
  const s = b.section(type === 'bundle' ? 'Bundle contents' : 'Agent blueprint');
  const comps = arr(payload.components).filter(isObj);
  if (comps.length) b.list(s, comps, (c) => `- ${safe(c.id ?? c.listing ?? c.name, 120)} ${safe(c.range ?? c.version, 40)} ${safe(c.type ?? c.kind, 30)}`, 'components');
  else b.line(s, `Fields: ${Object.keys(payload).slice(0, 20).map((k) => safe(k, 30)).join(', ')}`);
  const r = b.section('Automated results');
  for (const n of ['compiles', 'dry-run', 'permissions-subset', 'unsupported-reported', 'permissions-union', 'closure-complete', 'manual-review-required']) {
    const c = checks.find((k) => k.name === n);
    if (c) b.line(r, `${n}: ${c.skipped ? 'skipped' : c.ok ? 'ok' : 'FAILED'}${c.detail ? ` - ${c.detail}` : ''}`);
  }
}

/** The review summary for a version of `type`. Pure: manifest + recorded checks in, text and hash out. Never throws on a malformed manifest. */
export function buildReviewSummary(type: ListingType, manifest: ManifestV1, ctx: SummaryContext): ReviewSummary {
  const tier = (ctx.riskTier === 'data' || ctx.riskTier === 'declarative' || ctx.riskTier === 'executable' ? ctx.riskTier : 'executable') as RiskTier;   // unknown: show the strictest
  const b = new Builder();
  const m = isObj(manifest) ? manifest : ({} as ManifestV1);
  const payload = isObj(m.payload) ? m.payload : {};
  const checks: SummaryCheck[] = arr(ctx.checks).filter(isObj).slice(0, 60).map((c) => ({ name: safe(c.name, 80), ok: c.ok === true, skipped: c.skipped === true, detail: c.detail ? safe(c.detail, 300) : null }));
  common(b, type, m, ctx, tier);
  try {
    if (type === 'hook') hook(b, payload);
    else if (type === 'bridge') bridge(b, payload);
    else if (type === 'connector') connector(b, payload);
    else if (type === 'routine') routine(b, payload);
    else if (type === 'memory') memory(b, payload);
    else if (type === 'workflow') workflow(b, payload);
    else if (type === 'agent' || type === 'bundle') agentOrBundle(b, type, payload, checks);
  } catch { b.truncated = true; b.risk('the summary could not be built for this payload'); }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { const f = b.section('Automated checks that did not pass'); b.list(f, failed, (c) => `- ${c.name}${c.detail ? `: ${c.detail}` : ''}`, 'checks'); for (const c of failed) b.risk(`failed check: ${c.name}`); }
  const skipped = checks.filter((c) => c.skipped);
  if (skipped.length) { const f = b.section('Automated checks that did NOT run'); b.list(f, skipped, (c) => `- ${c.name}`, 'checks'); }
  if (b.truncated) b.line(b.section('Summary incomplete'), 'This summary was cut to its size limit. It cannot be approved from here.');
  const text = b.sections.map((s) => `${s.title}\n${s.lines.join('\n')}`).join('\n\n');
  return { text, sha256: reviewSummaryHash(manifest, ctx.artifactSha256, typeof ctx.riskTier === 'string' ? ctx.riskTier : null), riskTier: tier, highRisk: b.highRisk, truncated: b.truncated, sections: b.sections, validation: checks };
}
