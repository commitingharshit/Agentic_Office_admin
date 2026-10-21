// Enablement from evidence (ship step A). OPERATIONAL may say `supported: true` for an advanced type ONLY when a passing end-to-end
// evidence record exists in docs/audits, and a valid record may not sit next to an unsupported row without a documented reason.
// Evidence records were written by different flows over time, so the shapes differ; `normaliseEvidence` reads each shape and
// fails closed on anything it does not understand.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OPERATIONAL, typeSupport, isPublishable, AGENT_BUNDLE_INSTALLABLE } from '../src/marketplace/support.ts';
import { LISTING_TYPES, type ListingType } from '../src/marketplace/types.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALWAYS: readonly ListingType[] = ['template', 'skill'];   // Plan 1 types: shipped before this mechanism, covered by the real-window flow
const ADVANCED = LISTING_TYPES.filter((t) => !ALWAYS.includes(t));

export interface Evidence { type: string; mode: string | null; script: string; result: string; passedAt: string; layers: string[]; skipped: string[]; failing: number }

/** Returns the evidence in one shape, or a list of reasons it is not acceptable. Never throws. */
export function normaliseEvidence(raw: unknown): { ok: true; evidence: Evidence } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const j = raw as Record<string, any>;
  if (!j || typeof j !== 'object') return { ok: false, problems: ['not an object'] };
  if (typeof j.type !== 'string') problems.push('no type');
  if (j.result !== 'pass') problems.push(`result is ${JSON.stringify(j.result)}, not "pass"`);
  if (typeof j.script !== 'string' || !j.script) problems.push('no script (what produced it)');
  else if (!existsSync(join(repo, j.script))) problems.push(`script ${j.script} does not exist`);
  if (typeof j.passedAt !== 'string' || Number.isNaN(Date.parse(j.passedAt))) problems.push('no valid passedAt');
  if (typeof j.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(j.commit)) problems.push('no commit');
  // the layers exercised: any of the shapes the flows write
  const layers: string[] = [];
  for (const key of ['layers', 'covers', 'covered', 'steps']) {
    const v = j[key];
    if (Array.isArray(v)) for (const x of v) layers.push(typeof x === 'string' ? x : typeof x?.name === 'string' ? x.name : '');
  }
  if (layers.length === 0 || layers.some((l) => !l)) problems.push('names no layers / steps exercised');
  // nothing skipped, nothing failing
  const skipped: string[] = [];
  if (j.skipped !== undefined) { if (Array.isArray(j.skipped) ? j.skipped.length > 0 : j.skipped) skipped.push('skipped: ' + JSON.stringify(j.skipped)); }
  if (Array.isArray(j.steps)) for (const s of j.steps) { if (s && typeof s === 'object' && (s.ok === false || s.skipped)) skipped.push(`step ${s.name}: ${s.ok === false ? 'failed' : 'skipped'}`); }
  let failing = 0;
  if (j.tests && typeof j.tests === 'object') {
    failing = Number(j.tests.failing ?? 0) + Number(j.tests.pending ?? 0) + Number(j.tests.skipped ?? 0);
    if (!(Number(j.tests.passing) > 0)) problems.push('tests.passing is not > 0');
  }
  if (failing) problems.push(`tests failing/pending/skipped: ${failing}`);
  if (skipped.length) problems.push(...skipped);
  if (problems.length) return { ok: false, problems };
  return { ok: true, evidence: { type: j.type, mode: j.mode ?? null, script: j.script, result: j.result, passedAt: j.passedAt, layers, skipped, failing } };
}

/** Every evidence-shaped JSON file under docs/audits that declares a type (no per-type path list: an orphan is found too). */
function evidenceFiles(): { path: string; type: string }[] {
  const out: { path: string; type: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (/^marketplace.*evidence/.test(e.name)) walk(rel); }
      else if (e.name.endsWith('.json') && /marketplace.*evidence|marketplace-(type-)?evidence\//.test(rel)) {
        try { const j = JSON.parse(readFileSync(join(repo, rel), 'utf8')); if (typeof j.type === 'string') out.push({ path: rel, type: j.type }); } catch { /* not evidence */ }
      }
    }
  };
  walk('docs/audits');
  return out;
}

describe('operational types are backed by passing end-to-end evidence', () => {
  test('every advanced type with supported:true names an evidence file that exists, is for that type and is valid', () => {
    for (const t of ADVANCED) {
      const e = OPERATIONAL[t];
      if (e.supported !== true) continue;
      assert.ok(e.evidence, `${t} is operational without an evidence path`);
      assert.ok(existsSync(join(repo, e.evidence!)), `${t}: evidence file ${e.evidence} does not exist`);
      const r = normaliseEvidence(JSON.parse(readFileSync(join(repo, e.evidence!), 'utf8')));
      assert.ok(r.ok, `${t}: evidence ${e.evidence} is not acceptable: ${(r as any).problems?.join('; ')}`);
      assert.equal((r as any).evidence.type, t, `${t}: evidence file is for ${(r as any).evidence.type}`);
    }
  });

  test('a mode marked true is the evidence mode, or is listed in unitOnlyModes (never silently claimed)', () => {
    for (const t of ADVANCED) {
      const e = OPERATIONAL[t];
      if (e.supported !== true || !e.modes) continue;
      const ev = JSON.parse(readFileSync(join(repo, e.evidence!), 'utf8'));
      for (const [mode, on] of Object.entries(e.modes)) {
        if (!on) { assert.ok(e.modeReasons?.[mode], `${t}.${mode} is off without a documented reason`); continue; }
        assert.ok(mode === ev.mode || (e.unitOnlyModes ?? []).includes(mode), `${t}.${mode} is on but the evidence covers mode ${ev.mode} and the mode is not listed in unitOnlyModes`);
      }
      for (const m of e.unitOnlyModes ?? []) assert.equal(e.modes[m], true, `unitOnlyModes names ${m} which is not on`);
    }
  });

  test('a type without valid evidence is NOT operational; valid evidence next to an unsupported row needs a documented heldBack reason', () => {
    const files = evidenceFiles();
    for (const t of ADVANCED) {
      const e = OPERATIONAL[t];
      const mine = files.filter((f) => f.type === t);
      const valid = mine.filter((f) => normaliseEvidence(JSON.parse(readFileSync(join(repo, f.path), 'utf8'))).ok);
      if (e.supported === true) { assert.ok(valid.length > 0, `${t} is operational but no valid evidence exists`); continue; }
      assert.ok(e.reason && e.path, `${t}: unsupported rows carry a reason and a path`);
      if (valid.length > 0) assert.ok(e.heldBack && e.heldBack.length > 20, `${t} has valid evidence (${valid.map((v) => v.path).join(', ')}) but is unsupported without a heldBack reason`);
    }
  });

  test('the expected set: exactly these advanced types are operational', () => {
    assert.deepEqual(ADVANCED.filter((t) => OPERATIONAL[t].supported).sort(), ['bridge', 'connector', 'hook', 'memory', 'routine', 'workflow']);
    assert.deepEqual(ADVANCED.filter((t) => !OPERATIONAL[t].supported).sort(), ['agent', 'bundle', 'surface']);
  });

  test('capabilities honesty: hook scripts and oauth2 connectors are not publishable; agent and bundle stay off even when the compiler self-check passes', () => {
    assert.equal(isPublishable('hook', 'declarative'), true);
    assert.equal(isPublishable('hook', 'script'), false);
    assert.equal(isPublishable('connector', 'api_key'), true);
    assert.equal(isPublishable('connector', 'oauth2'), false);
    assert.equal(isPublishable('surface'), false);
    assert.equal(AGENT_BUNDLE_INSTALLABLE, false);
    for (const runtime of [{}, { bridge: true }, { bridge: false }]) {
      const rows = typeSupport(runtime);
      for (const t of ['agent', 'bundle', 'surface']) { const r = rows.find((x) => x.type === t)!; assert.equal(r.supported, false, `${t} with ${JSON.stringify(runtime)}`); assert.ok(r.reason && r.path); }
      assert.deepEqual(rows.filter((r) => r.supported).map((r) => r.type).sort(), ['bridge', 'connector', 'hook', 'memory', 'routine', 'skill', 'template', 'workflow']);
    }
    const hook = typeSupport().find((r) => r.type === 'hook')!;
    assert.deepEqual(hook.modes, { declarative: true, script: false }); assert.ok(hook.modeReasons?.script);
    const con = typeSupport().find((r) => r.type === 'connector')!;
    assert.equal(con.modes?.oauth2, false); assert.ok(con.modeReasons?.oauth2);
  });
});

describe('the enforcement itself fails on bad evidence (mutation checks)', () => {
  const good = JSON.parse(readFileSync(join(repo, 'docs/audits/marketplace-type-evidence.hook.json'), 'utf8'));
  test('accepts a real record', () => assert.equal(normaliseEvidence(good).ok, true));
  test('rejects: failed result, skipped step, failed step, missing layers, missing script, failing tests', () => {
    const bad = (patch: Record<string, unknown>) => normaliseEvidence({ ...good, ...patch }).ok;
    assert.equal(bad({ result: 'fail' }), false);
    assert.equal(bad({ skipped: ['x'] }), false);
    assert.equal(bad({ steps: [...good.steps, { name: 'x', ok: false }] }), false);
    assert.equal(bad({ steps: [...good.steps, { name: 'x', ok: true, skipped: true }] }), false);
    assert.equal(bad({ layers: [], steps: [] }), false);
    assert.equal(bad({ script: 'scripts/does-not-exist.mjs' }), false);
    assert.equal(bad({ tests: { passing: 5, failing: 1, pending: 0 } }), false);
    assert.equal(bad({ passedAt: 'yesterday' }), false);
    assert.equal(normaliseEvidence(null).ok, false);
  });
});
