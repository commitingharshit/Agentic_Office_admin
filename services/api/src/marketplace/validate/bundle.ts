// Bundle validator (Plan 2 Task 5). NOT registered here: Task 7 owns validate/index.ts and calls createBundleValidator
// with a caller-scoped CatalogView and the bundle's visibility context. Without a catalog every check that needs the
// catalog is `skipped` + `required`, so the report is never `verified` (fail closed).
import { isRange, satisfies } from '../manifest.ts';
import { isPublishable, maxTier, TYPE_POLICY } from '../support.ts';
import type { ListingType, RiskTier, ValidationCheck, Visibility } from '../types.ts';
import type { CatalogView } from '../blueprint/catalogView.ts';
import { BUNDLE_FILE, BUNDLE_LIMITS, BundleError, parseBundleText, confusableKey, type BundleV1 } from '../bundle/schema.ts';
import { memberElevated, memberTier, topoOrder, unionPermissions, type MemberInfo } from '../bundle/plan.ts';
import { checkNoLiteralSecrets, checkOnlyFiles, impliedPermissions, riskTierCheck } from './advanced-common.ts';
import type { Validator } from './index.ts';

export interface BundleValidatorContext { visibility: Visibility; teamId: string | null }
export interface BundleValidatorOptions {
  catalog?: CatalogView;
  /** the bundle's own audience; resolved per package (the publisher's choice), absent = visibility checks skipped+required */
  context?: BundleValidatorContext | ((manifestId: string) => BundleValidatorContext | undefined);
  /** which member types are operational; default is the shared OPERATIONAL table */
  supported?: (type: ListingType) => boolean;
}

const ALLOWED_FILES: readonly RegExp[] = [/^bundle\.json$/, /^README\.md$/];
const skipped = (name: string, detail: string): ValidationCheck => ({ name, ok: true, skipped: true, required: true, detail });
const check = (name: string, problems: string[], note?: string): ValidationCheck => {
  const detail = problems.length ? problems.slice(0, 10).join('; ') : note;
  return { name, ok: problems.length === 0, ...(detail ? { detail } : {}) };
};

/** Candidate versions that can witness a non-empty intersection: every number mentioned in any range, and its neighbours. */
function candidates(ranges: string[]): string[] {
  const nums = new Set<number>([0, 1]);
  for (const r of ranges) for (const m of r.matchAll(/\d+/g)) { const n = Number(m[0]); if (Number.isSafeInteger(n)) { nums.add(n); nums.add(n + 1); } }
  const ns = [...nums].filter((n) => n < 1000).sort((a, b) => a - b).slice(0, 12);
  const out: string[] = [];
  for (const a of ns) for (const b of ns) for (const c of ns) out.push(`${a}.${b}.${c}`);
  return out;
}
export function compatIntersects(ranges: string[]): boolean {
  if (ranges.some((r) => !isRange(r))) return false;
  return candidates(ranges).some((v) => ranges.every((r) => satisfies(v, r)));
}

export function createBundleValidator(opts: BundleValidatorOptions = {}): Validator {
  const supported = opts.supported ?? ((t: ListingType) => isPublishable(t));
  return async (pkg) => {
    const checks: ValidationCheck[] = [];
    checks.push({ ...checkOnlyFiles(pkg, ALLOWED_FILES), name: 'bundle-files-allowlist' });
    const bytes = pkg.files.get(BUNDLE_FILE);
    let b: BundleV1;
    try {
      if (!bytes) throw new BundleError(BUNDLE_FILE, 'missing', `${BUNDLE_FILE} is missing`);
      b = parseBundleText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      checks.push({ name: 'bundle-parse', ok: true });
    } catch (e) {
      checks.push({ name: 'bundle-parse', ok: false, detail: e instanceof Error ? e.message : String(e) });
      return checks;
    }
    // secrets: the payload only, with the 64-hex pins removed (they are validated by shape, and would trip the entropy rule)
    const scanned = { items: b.items.map((i) => ({ id: i.id, type: i.type, version: i.version })), installOrder: b.installOrder, teamScope: b.teamScope, ...(b.notes ? { notes: b.notes } : {}) };
    checks.push({ ...checkNoLiteralSecrets(scanned, new Set()), name: 'no-secrets' });
    checks.push({ ...checkNoLiteralSecrets(pkg.manifest.payload, new Set()), name: 'no-secrets-manifest-payload' });

    const self = pkg.manifest.id;
    const typeProblems: string[] = [], unsupported: string[] = [];
    for (const it of b.items) {
      if (it.type === 'bundle') typeProblems.push(`${it.id}: a bundle cannot contain a bundle (nesting depth limit 0)`);
      else if (it.id === self) typeProblems.push(`${it.id}: a bundle cannot contain itself`);
      else if (!supported(it.type)) unsupported.push(`${it.id}: type ${it.type} is not supported yet`);
    }
    checks.push(check('items-types', typeProblems));
    checks.push(check('members-supported', unsupported, undefined));
    // confusable ids across members and the bundle itself (parse already caught member/member collisions)
    checks.push(check('confusable-ids', b.items.filter((i) => i.id !== self && confusableKey(i.id) === confusableKey(self)).map((i) => `${i.id} is confusable with the bundle id ${self}`)));

    // manifest.dependencies must be exactly the items at =version
    const want = new Map(b.items.map((i) => [i.id, `=${i.version}`]));
    const depProblems: string[] = [];
    const have = new Map(pkg.manifest.dependencies.map((d) => [d.id, d.range]));
    for (const [id, r] of want) if (have.get(id) !== r) depProblems.push(`manifest.dependencies must list ${id} ${r}${have.has(id) ? ` (has ${have.get(id)})` : ''}`);
    for (const id of have.keys()) if (!want.has(id)) depProblems.push(`manifest.dependencies lists ${id}, which is not an item`);
    checks.push(check('deps-match-manifest', depProblems));

    // team scope: shape is checked by the parser; here, agreement with the declared audience
    const ctx = typeof opts.context === 'function' ? opts.context(self) : opts.context;

    if (!opts.catalog || !ctx) {
      const why = !opts.catalog ? 'no catalog available to resolve members' : 'bundle audience unknown';
      for (const n of ['items-pinned', 'closure-complete', 'install-order-valid', 'compat-consistent', 'visibility-no-escalation', 'permissions-union']) checks.push(skipped(n, why));
      checks.push(riskTierCheck(TYPE_POLICY.bundle.riskTier));
      return checks;
    }
    const teamProblems: string[] = [];
    if (b.teamScope.kind === 'team' && (ctx.visibility !== 'team' || ctx.teamId !== b.teamScope.teamId)) teamProblems.push('teamScope names a team, but the bundle audience is not that team');
    if (b.teamScope.kind === 'none' && ctx.visibility === 'team') teamProblems.push('a team bundle needs teamScope.kind team');
    checks.push(check('team-scope-valid', teamProblems));

    // ---- resolve every member through the caller's own view of the catalog
    const resolved = new Map<string, MemberInfo>();
    const pinProblems: string[] = [], visProblems: string[] = [];
    for (const it of b.items) {
      if (it.type === 'bundle' || it.id === self) continue;
      let r: Awaited<ReturnType<CatalogView['resolve']>>;
      try { r = await opts.catalog.resolve({ id: it.id, range: `=${it.version}` }, { forVisibility: ctx.visibility, forTeamId: ctx.teamId }); }
      catch (e) { pinProblems.push(`${it.id}: could not be resolved (${(e as Error).message})`); continue; }
      if ('error' in r) { pinProblems.push(`${it.id}@${it.version}: ${r.error === 'not_visible' ? 'not visible to the publisher' : r.error}`); continue; }
      const m = r as MemberInfo;
      if (m.version !== it.version) pinProblems.push(`${it.id}: resolved ${m.version}, not the pinned ${it.version}`);
      else if (m.type !== it.type) pinProblems.push(`${it.id}: is a ${m.type}, the bundle says ${it.type}`);
      else if (m.type === 'bundle') typeProblems.push(`${it.id}: resolves to a bundle`);
      else if (m.state !== 'published') pinProblems.push(`${it.id}@${it.version}: is ${m.state}, not published`);
      else if (m.sha256 !== it.sha256) pinProblems.push(`${it.id}@${it.version}: sha256 does not match the published artifact`);
      else if (m.scanVerdict !== 'clean' && m.scanVerdict !== 'warnings') pinProblems.push(`${it.id}@${it.version}: security scan is not clean`);
      else {
        resolved.set(it.id, m);
        // a bundle may only contain what its audience can see: public sees public; org sees public/org; team sees +its own team
        const v = m.visibility;
        const okVis = ctx.visibility === 'private' ? true
          : ctx.visibility === 'public' ? v === 'public'
          : ctx.visibility === 'org' ? v === 'public' || v === 'org'
          : v === 'public' || v === 'org' || (v === 'team' && m.teamId === ctx.teamId);
        if (!okVis) visProblems.push(`${it.id}: a ${ctx.visibility} bundle cannot contain a ${v} listing${m.teamId ? ' of another team' : ''}`);
      }
    }
    // closure-complete used to re-check items-types after resolution
    checks[checks.findIndex((c) => c.name === 'items-types')] = check('items-types', typeProblems);
    checks.push(check('items-pinned', pinProblems));
    checks.push(check('visibility-no-escalation', visProblems));

    // ---- closure and order (only over members that resolved; unresolved ones already failed items-pinned)
    const graph = new Map<string, string[]>();
    const closureProblems: string[] = [];
    let edges = 0;
    for (const [id, m] of resolved) {
      const deps: string[] = [];
      for (const d of m.dependencies) {
        if (++edges > BUNDLE_LIMITS.maxClosure) { closureProblems.push(`dependency closure larger than ${BUNDLE_LIMITS.maxClosure}`); break; }
        const item = b.items.find((x) => x.id === d.id);
        if (!item) { closureProblems.push(`${id} needs ${d.id} ${d.range}, which is not an item of the bundle`); continue; }
        if (!isRange(d.range) || !satisfies(item.version, d.range)) { closureProblems.push(`${id} needs ${d.id} ${d.range}, the bundle pins ${item.version}`); continue; }
        deps.push(d.id);
      }
      graph.set(id, deps);
    }
    const order = topoOrder(graph);
    if (!Array.isArray(order)) closureProblems.push(`dependency cycle: ${order.cycle.join(' -> ')}`);
    checks.push(check('closure-complete', closureProblems));

    const orderProblems: string[] = [];
    const ids = b.items.map((i) => i.id);
    const pos = new Map(b.installOrder.map((id, i) => [id, i]));
    if (pos.size !== b.installOrder.length) orderProblems.push('installOrder has duplicates');
    if (b.installOrder.length !== ids.length || ids.some((id) => !pos.has(id))) orderProblems.push('installOrder must list every item exactly once');
    for (const [id, deps] of graph) for (const d of deps) if ((pos.get(d) ?? -1) >= (pos.get(id) ?? -1)) orderProblems.push(`${d} must be installed before ${id}`);
    checks.push(check('install-order-valid', orderProblems));

    // ---- compat intersection (members and the bundle itself)
    const compat: string[] = [pkg.manifest.compat.app];
    let missingCompat = 0;
    for (const m of resolved.values()) { if (m.compatApp) compat.push(m.compatApp); else missingCompat++; }
    if (missingCompat) checks.push(skipped('compat-consistent', `${missingCompat} member(s) did not report compat.app`));
    else checks.push(check('compat-consistent', compatIntersects(compat) ? [] : [`no app version satisfies all of: ${[...new Set(compat)].sort().join(', ')}`]));

    // ---- permissions union: under-declared fails, over-declared notes (impliedPermissions)
    const union = unionPermissions([...resolved.values()].map((m) => m.permissions));
    checks.push({ ...impliedPermissions(pkg.manifest.permissions, union), name: 'permissions-union' });

    // ---- tier: an elevated member makes the bundle elevated (manual review); never below the bundle floor
    let tier: RiskTier = TYPE_POLICY.bundle.riskTier;
    const elevated: string[] = [];
    for (const [id, m] of resolved) { tier = maxTier(tier, memberTier(m)); if (memberElevated(m)) elevated.push(id); }
    checks.push(riskTierCheck(tier));
    if (elevated.length) checks.push({ name: 'manual-review-required', ok: true, detail: `elevated member(s): ${elevated.sort().join(', ')}` });
    return checks;
  };
}
