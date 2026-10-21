// Agent validator (type 'agent'): the ONLY gate for private/team agents. A package is blueprint.json + SOUL.md (+ README.md).
// Every check runs unless it depends on a failed one (then `skipped`). Checks that need infrastructure (the Python
// compiler bridge, the Skills Guard scanner, the catalog) are `skipped` + `required` when that infrastructure is absent,
// so the report is never `verified` on a skip. This module is NOT registered here: Task 7 owns validate/index.ts and
// builds a validator per request with the caller-scoped catalog and the publish visibility.
import type { PermissionRequest, RiskTier, UnpackedPackage, ValidationCheck, Visibility } from '../types.ts';
import { BLUEPRINT_LIMITS } from '../blueprint/limits.ts';
import { BLUEPRINT_SCHEMA, BlueprintError, SOUL_FILE, blueprintFileName, parseBlueprintText, presentComponents, type AgentBlueprint, type BlueprintDiagnostic, type Ref } from '../blueprint/schema.ts';
import type { CatalogView, ResolvedRef } from '../blueprint/catalogView.ts';
import { resolveRefs, type ResolvedRefs } from '../blueprint/resolve.ts';
import { checkEscalation, checkNoWildcards, deriveRequired } from '../blueprint/escalation.ts';
import { checkDelegationGraph } from '../blueprint/cycles.ts';
import { blueprintTexts, scanSecrets } from '../blueprint/secrets.ts';
import type { Bridge, CheckResult } from '../blueprint/pyBridge.ts';
import { checkOnlyFiles, riskTierCheck } from './advanced-common.ts';
import type { SkillScanner } from './skill.ts';

export interface AgentValidatorOptions {
  /** Built from a caller-scoped (RLS) connection. Absent: reference resolution is skipped+required (never verified). */
  catalog?: CatalogView;
  /** createPythonBridge(). Absent or unavailable: compiles / dry-run are skipped+required. */
  bridge?: Bridge;
  /** The Skills Guard scanner; absent: persona-scan is skipped+required. */
  scanner?: SkillScanner;
  /** Audience of the version being published. Defaults to `public`, the strictest (fail closed). */
  context?: { visibility: Visibility; teamId: string | null };
}

const ok = (name: string, extra: Partial<ValidationCheck> = {}): ValidationCheck => ({ name, ok: true, ...extra });
const fail = (name: string, detail: string): ValidationCheck => ({ name, ok: false, detail });
const skip = (name: string, why: string, required = false): ValidationCheck => ({ name, ok: true, skipped: true, detail: `skipped: ${why}`, ...(required ? { required: true } : {}) });
const list = (xs: string[], n = 8) => xs.slice(0, n).join('; ') + (xs.length > n ? `; ... and ${xs.length - n} more` : '');
const diag = (ds: BlueprintDiagnostic[]) => list(ds.map(d => `${d.path ? d.path + ': ' : ''}${d.message}`));
const HIDDEN_RE = /[\p{Cf}\p{Co}\u{E0000}-\u{E007F}︀-️­᠎⠀ㅤ]/u;
const ELEVATED = new Set<PermissionRequest['capability']>(['exec.script', 'network', 'secrets.use']);
const refKey = (r: Ref) => `${r.id}\u0000${r.range}`;
const show = (k: string) => k.replace('\u0000', '@');

/** Every listing reference the blueprint makes. Hooks and workflows are declared-only in Plan 2 but are still dependencies. */
export function blueprintRefs(bp: AgentBlueprint): Ref[] {
  return [
    ...(bp.skillReferences ?? []).map(s => ({ id: s.id, range: s.range })),
    ...(bp.delegationPolicy?.children ?? []).map(c => ({ id: c.id, range: c.range })),
    ...(bp.workflowReferences ?? []).map(w => ({ id: w.id, range: w.range })),
    ...(bp.hookBindings ?? []).map(h => ({ id: h.hook.id, range: h.hook.range })),
  ];
}

/** Components that parse but do not run yet (Plan 3), derived locally so the admin sees them even when the compiler is down. */
export function localUnsupported(bp: AgentBlueprint): string[] {
  const u: string[] = [];
  if (bp.hookBindings?.length) u.push('hookBindings');
  if (bp.workflowReferences?.length) u.push('workflowReferences');
  if (bp.schedulingPolicy?.triggers.some(t => t.kind === 'schedule')) u.push('schedulingPolicy');
  if (bp.knowledgeSources?.some(k => k.kind !== 'workspace')) u.push('knowledgeSources');
  if (bp.modelPolicy?.maxCostTier) u.push('modelPolicy.maxCostTier');
  return u;
}

function visibilityProblems(ctx: { visibility: Visibility; teamId: string | null }, deps: ResolvedRef[]): string[] {
  const bad: string[] = [];
  for (const d of deps) {
    const allowed = d.visibility === 'public'
      || (ctx.visibility === 'private')
      || (ctx.visibility === 'org' && d.visibility === 'org')
      || (ctx.visibility === 'team' && (d.visibility === 'org' || (d.visibility === 'team' && ctx.teamId !== null && d.teamId === ctx.teamId)));
    if (!allowed) bad.push(`${ctx.visibility} agent depends on ${d.visibility}${d.teamId ? ' (team ' + d.teamId + ')' : ''} listing ${d.id}`);
  }
  return bad;
}

export function createAgentValidator(opts: AgentValidatorOptions = {}) {
  const audience = opts.context ?? { visibility: 'public' as Visibility, teamId: null };
  return async (pkg: UnpackedPackage): Promise<ValidationCheck[]> => {
    const checks: ValidationCheck[] = [];
    const m = pkg.manifest;
    const files = checkOnlyFiles(pkg, [/^blueprint\.json$/, /^SOUL\.md$/, /^README\.md$/, /^agentic\.marketplace\.json$/]);
    checks.push({ ...files, name: 'agent-files-allowlist' });

    // ---- blueprint-parse (TS) ----
    const bpBytes = pkg.files.get(blueprintFileName);
    let text: string | undefined, bp: AgentBlueprint | undefined, parseErr: string | undefined;
    if (!bpBytes) parseErr = 'blueprint.json is not in the package';
    else if (bpBytes.length > BLUEPRINT_LIMITS.maxBytes) parseErr = `blueprint.json is ${bpBytes.length} bytes, over the ${BLUEPRINT_LIMITS.maxBytes} byte cap`;
    else {
      // ignoreBOM: keep a BOM in the text so JSON.parse rejects it (the default decoder strips it, and the Python compiler would see different bytes)
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bpBytes); } catch { parseErr = 'blueprint.json is not valid UTF-8'; }
      if (text !== undefined) {
        try { bp = parseBlueprintText(text); }
        catch (e) { parseErr = e instanceof BlueprintError ? `${e.path || '$'}: ${e.message.replace(/^[^:]*: /, '')}` : `cannot parse: ${e instanceof Error ? e.message : String(e)}`; }
      }
    }
    checks.push(parseErr ? fail('blueprint-parse', parseErr) : ok('blueprint-parse'));

    // ---- soul-file ----
    const soulBytes = pkg.files.get(SOUL_FILE);
    let soul: string | undefined;
    const soulProblems: string[] = [];
    if (!soulBytes) soulProblems.push('SOUL.md is not in the package');
    else {
      if (soulBytes.length > BLUEPRINT_LIMITS.maxSoulBytes) soulProblems.push(`SOUL.md is ${soulBytes.length} bytes, over the ${BLUEPRINT_LIMITS.maxSoulBytes} byte cap`);
      else {
        try { soul = new TextDecoder('utf-8', { fatal: true }).decode(soulBytes); } catch { soulProblems.push('SOUL.md is not valid UTF-8'); }
        if (soul !== undefined) {
          if (soul.includes('\0')) soulProblems.push('SOUL.md contains NUL bytes');
          if (soul.trim() === '') soulProblems.push('SOUL.md is empty');
          const h = HIDDEN_RE.exec(soul);
          if (h) soulProblems.push(`SOUL.md contains an invisible/format character U+${h[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
        }
      }
    }
    if (bp && bp.identity.instructionsFile !== SOUL_FILE) soulProblems.push(`identity.instructionsFile must be ${SOUL_FILE}, found ${JSON.stringify(bp.identity.instructionsFile)}`);
    checks.push(soulProblems.length ? fail('soul-file', soulProblems.join('; ')) : ok('soul-file'));
    if (soulProblems.length) soul = undefined;

    // ---- the Python compiler must agree with the TS parser, even when TS rejected (python accepting = disagreement) ----
    if (!bp) {
      for (const n of ['payload-matches', 'deps-match-manifest']) checks.push(skip(n, 'blueprint-parse failed'));
      checks.push(skip('refs-resolve', 'blueprint-parse failed', true), skip('visibility-no-escalation', 'blueprint-parse failed'), skip('permissions-subset', 'blueprint-parse failed'), skip('no-wildcards', 'blueprint-parse failed'), skip('delegation-acyclic', 'blueprint-parse failed'));
      checks.push(secretCheck(undefined, soul, text), skip('persona-scan', 'blueprint-parse failed', true));
      if (opts.bridge && bpBytes && soulBytes && soul !== undefined) {
        const r = await safeBridge(opts.bridge, { op: 'check', listingId: m.id, version: m.version, blueprint: bpBytes, soul: soulBytes, resolved: emptyResolved() });
        if ('unavailable' in r) checks.push(skip('compiles', r.unavailable, true));
        else if (r.ok) checks.push(fail('compiles', 'the TypeScript parser rejected this blueprint but the Python compiler accepted it: the two disagree (failing closed)'));
        else checks.push(skip('compiles', 'blueprint-parse failed'));
      } else checks.push(skip('compiles', 'blueprint-parse failed', true));
      checks.push(skip('dry-run', 'blueprint-parse failed', true), ok('unsupported-reported', { detail: 'none (blueprint did not parse)' }), riskTierCheck('declarative'));
      return checks;
    }

    // ---- payload-matches ----
    const pl = (m.payload ?? {}) as Record<string, unknown>;
    const pp: string[] = [];
    for (const k of Object.keys(pl)) if (!['blueprint', 'schema', 'components'].includes(k)) pp.push(`payload.${k}: unknown field`);
    if (pl.blueprint !== blueprintFileName) pp.push(`payload.blueprint must be ${blueprintFileName}`);
    if (pl.schema !== BLUEPRINT_SCHEMA) pp.push(`payload.schema must be ${BLUEPRINT_SCHEMA}`);
    const comps = presentComponents(bp);
    if (!Array.isArray(pl.components) || pl.components.length !== comps.length || !comps.every(c => (pl.components as unknown[]).includes(c))) pp.push(`payload.components must be exactly [${comps.join(', ')}]`);
    checks.push(pp.length ? fail('payload-matches', pp.join('; ')) : ok('payload-matches'));

    // ---- deps-match-manifest ----
    const refs = blueprintRefs(bp);
    const bpSet = new Set(refs.map(refKey)), mSet = new Set((m.dependencies ?? []).map(refKey));
    const dm: string[] = [];
    for (const k of bpSet) if (!mSet.has(k)) dm.push(`blueprint references ${show(k)} but manifest.dependencies does not pin it`);
    for (const k of mSet) if (!bpSet.has(k)) dm.push(`manifest.dependencies lists ${show(k)} but the blueprint does not reference it`);
    if (refs.some(r => r.id === m.id)) dm.push(`the agent references itself (${m.id})`);
    checks.push(dm.length ? fail('deps-match-manifest', list(dm)) : ok('deps-match-manifest'));

    // ---- refs-resolve ----
    let resolved: ResolvedRefs = emptyResolved();
    let resolvedOk = false;
    if (!opts.catalog && (bp.skillReferences?.length || bp.delegationPolicy?.children.length)) {
      checks.push(skip('refs-resolve', 'no catalog configured', true));
    } else {
      const r = opts.catalog ? await resolveRefs(opts.catalog, bp, { ...audience, rootId: m.id }) : { resolved, findings: [] as BlueprintDiagnostic[] };
      resolved = r.resolved;
      resolvedOk = r.findings.length === 0;
      checks.push(resolvedOk ? ok('refs-resolve', { detail: `${resolved.skills.length} skill(s), ${resolved.agents.size} child agent(s)` }) : fail('refs-resolve', diag(r.findings)));
    }
    const deps = [...resolved.skills, ...resolved.agents.values()];
    const vis = visibilityProblems(audience, deps);
    checks.push(vis.length ? fail('visibility-no-escalation', list(vis)) : ok('visibility-no-escalation'));

    // ---- permissions-subset / no-wildcards / delegation ----
    const declared = m.permissions ?? [];
    // bridge compile first: its requiredCapabilities feed E1
    let compileRes: CheckResult | { unavailable: string } | undefined;
    if (opts.bridge && resolvedOk && bpBytes && soulBytes && soul !== undefined) {
      compileRes = await safeBridge(opts.bridge, { op: 'check', listingId: m.id, version: m.version, blueprint: bpBytes, soul: soulBytes, resolved });
    }
    const required = new Set<PermissionRequest['capability']>(deriveRequired(bp));
    if (compileRes && !('unavailable' in compileRes) && compileRes.report) for (const c of compileRes.report.requiredCapabilities) required.add(c);
    const esc = checkEscalation(bp, declared, [...required], resolved);
    checks.push(esc.length ? fail('permissions-subset', diag(esc)) : ok('permissions-subset'));
    const wc = checkNoWildcards(bp, declared);
    checks.push(wc.length ? fail('no-wildcards', diag(wc)) : ok('no-wildcards'));
    const dg = checkDelegationGraph(m.id, resolved, bp.delegationPolicy?.maxDepth ?? 1);
    checks.push(dg.length ? fail('delegation-acyclic', diag(dg)) : ok('delegation-acyclic'));

    // ---- secrets ----
    checks.push(secretCheck(bp, soul));

    // ---- persona-scan (required) ----
    if (!opts.scanner) checks.push(skip('persona-scan', 'no scanner configured', true));
    else if (soul === undefined || !bpBytes || !soulBytes) checks.push(skip('persona-scan', 'soul-file failed', true));
    else {
      try {
        const r = await opts.scanner(new Map([[SOUL_FILE, soulBytes], [blueprintFileName, bpBytes]]), 'agent-persona');
        checks.push(r.verdict === 'safe' && r.findings.length === 0 ? ok('persona-scan')
          : fail('persona-scan', `verdict ${r.verdict}; ${r.findings.length} finding(s): ` + list(r.findings.map(f => `${f.category}/${f.severity} ${f.file}${f.line ? ':' + f.line : ''}`))));
      } catch (e) { checks.push(fail('persona-scan', `scanner failed: ${e instanceof Error ? e.message : String(e)}`)); }
    }

    // ---- compiles (required) ----
    let compiled: CheckResult | undefined;
    if (!opts.bridge) checks.push(skip('compiles', 'no compiler bridge configured', true));
    else if (!resolvedOk) checks.push(skip('compiles', 'refs-resolve failed or was skipped', true));
    else if (soul === undefined || !compileRes) checks.push(skip('compiles', 'soul-file failed', true));
    else if ('unavailable' in compileRes) checks.push(skip('compiles', compileRes.unavailable, true));
    else if (!compileRes.ok) checks.push(fail('compiles', diag(compileRes.findings)));
    else {
      compiled = compileRes;
      const pySkills = new Set(compileRes.skills ?? []), tsSkills = new Set((bp.skillReferences ?? []).map(s => s.id));
      const disagree = [...tsSkills].filter(s => !pySkills.has(s)).concat([...pySkills].filter(s => !tsSkills.has(s)));
      if (!compileRes.report) checks.push(fail('compiles', 'the compiler returned ok without a report (failing closed)'));
      else if (disagree.length) checks.push(fail('compiles', `the compiler's skill list disagrees with the blueprint: ${list(disagree)} (failing closed)`));
      else checks.push(ok('compiles', { detail: `${compileRes.report.target} ${compileRes.report.targetVersion}` }));
    }

    // ---- dry-run (required) ----
    if (!opts.bridge) checks.push(skip('dry-run', 'no compiler bridge configured', true));
    else if (!compiled || !checks.find(c => c.name === 'compiles')?.ok || checks.find(c => c.name === 'compiles')?.skipped) checks.push(skip('dry-run', 'compiles did not pass', true));
    else {
      const r = await safeBridge(opts.bridge, { op: 'dryrun', listingId: m.id, version: m.version, blueprint: bpBytes!, soul: soulBytes!, resolved });
      if ('unavailable' in r) checks.push(skip('dry-run', r.unavailable, true));
      else if (!r.ok || !r.dryRun?.ok) checks.push(fail('dry-run', r.ok ? 'dry run returned no evidence' : diag(r.findings)));
      else checks.push(ok('dry-run', { detail: `${r.dryRun.steps.length} step(s)` }));
    }

    // ---- unsupported-reported (info) ----
    const un = new Set(localUnsupported(bp));
    for (const u of compiled?.report?.unsupported ?? []) un.add(u.component);
    checks.push(ok('unsupported-reported', { detail: un.size ? `not available yet: ${[...un].join(', ')}` : 'none' }));

    // ---- risk tier: any elevated capability, requested or required, is the highest tier (manual review applies) ----
    const elevated = declared.some(p => ELEVATED.has(p.capability)) || [...required].some(c => ELEVATED.has(c)) || resolved.skills.concat([...resolved.agents.values()]).some(d => (d.permissions ?? []).some(p => ELEVATED.has(p.capability)));
    const tier: RiskTier = elevated ? 'executable' : 'declarative';
    checks.push(riskTierCheck(tier));
    return checks;
  };
}

function secretCheck(bp: AgentBlueprint | undefined, soul: string | undefined, rawBlueprint?: string): ValidationCheck {
  // when the blueprint did not parse, its raw text is still scanned: a secret must not hide behind a parse error
  const texts = bp ? blueprintTexts(bp) : new Map<string, string>(rawBlueprint !== undefined ? [['blueprint.json', rawBlueprint]] : []);
  if (soul !== undefined) texts.set(SOUL_FILE, soul);
  const hits = scanSecrets(texts);
  return hits.length ? fail('no-secrets', diag(hits)) : ok('no-secrets');
}
function emptyResolved(): ResolvedRefs { return { skills: [], children: [], agents: new Map(), graph: new Map(), truncated: false }; }
async function safeBridge(b: Bridge, req: Parameters<Bridge>[0]): Promise<CheckResult | { unavailable: string }> {
  try { return await b(req); } catch (e) { return { unavailable: `bridge threw: ${e instanceof Error ? e.message.slice(0, 160) : 'error'}` }; }
}
