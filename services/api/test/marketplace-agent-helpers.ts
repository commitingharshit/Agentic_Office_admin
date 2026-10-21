// Shared fixtures for the agent validator tests (not a test file: the runner globs *.test.ts).
import { sha256Hex } from '../src/marketplace/artifacts.ts';
import type { CatalogView, ResolvedRef } from '../src/marketplace/blueprint/catalogView.ts';
import type { ManifestV1, PermissionRequest, UnpackedPackage, Visibility } from '../src/marketplace/types.ts';
import type { Bridge, CheckResult } from '../src/marketplace/blueprint/pyBridge.ts';
import { satisfies } from '../src/marketplace/manifest.ts';

export const enc = (s: string) => new TextEncoder().encode(s);
export const baseBp = (over: Record<string, unknown> = {}): any => ({
  schema: 'agentic.agent-blueprint/1',
  identity: { name: 'Analyst', role: 'analyst', description: 'Reads filings.', instructionsFile: 'SOUL.md' },
  objective: { goal: 'Summarize filings', successCriteria: ['accurate'] },
  executionEnvironments: ['desktop'],
  ...over,
});
const COMPONENTS = ['modelPolicy', 'skillReferences', 'toolPermissions', 'memoryBinding', 'knowledgeSources', 'verificationPolicy', 'hookBindings', 'delegationPolicy', 'contextScope', 'schedulingPolicy', 'workflowReferences'];

export function agentPkg(o: { bp?: any; soul?: string; deps?: Array<{ id: string; range: string }>; permissions?: PermissionRequest[]; id?: string; extraFiles?: Record<string, string>; payload?: Record<string, unknown>; rawBlueprint?: string } = {}): UnpackedPackage {
  const bp = o.bp ?? baseBp();
  const blueprintText = o.rawBlueprint ?? JSON.stringify(bp);
  const files = new Map<string, Uint8Array>([['blueprint.json', enc(blueprintText)], ['SOUL.md', enc(o.soul ?? '# Analyst\n\nYou read filings carefully.\n')]]);
  for (const [k, v] of Object.entries(o.extraFiles ?? {})) files.set(k, enc(v));
  const refs: Array<{ id: string; range: string }> = [
    ...(bp.skillReferences ?? []), ...(bp.delegationPolicy?.children ?? []), ...(bp.workflowReferences ?? []), ...(bp.hookBindings ?? []).map((h: any) => h.hook),
  ].map((r: any) => ({ id: r.id, range: r.range }));
  const manifest: ManifestV1 = {
    schema: 'agentic.marketplace/1', id: o.id ?? 'acme/analyst', type: 'agent', version: '1.0.0', title: 'T', summary: 'S', license: 'MIT',
    compat: { app: '^1.0.0' }, dependencies: o.deps ?? refs, permissions: o.permissions ?? [],
    files: [...files].map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })),
    payload: o.payload ?? { blueprint: 'blueprint.json', schema: 'agentic.agent-blueprint/1', components: COMPONENTS.filter(c => bp[c] !== undefined) },
  };
  return { files, manifest };
}

export const row = (id: string, over: Partial<ResolvedRef> = {}): ResolvedRef => ({
  id, range: '^1.0.0', version: '1.2.0', versionId: 'v-' + id, sha256: 'a'.repeat(64), type: 'skill', visibility: 'public', teamId: null,
  state: 'published', scanVerdict: 'clean', permissions: [], dependencies: [], ...over,
});

/** A fake caller-scoped view: `visibleTo` models RLS (a row the caller cannot see is `not_visible`, never leaked). */
export function fakeCatalog(rows: ResolvedRef[], opts: { userId?: string; hiddenFrom?: Record<string, string[]> } = {}): CatalogView & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(ref) {
      calls.push(ref.id);
      const r = rows.find(x => x.id === ref.id);
      if (!r) return { error: 'not_found' };
      if (opts.userId && (opts.hiddenFrom?.[r.id] ?? []).includes(opts.userId)) return { error: 'not_visible' };
      if (!satisfies(r.version, ref.range)) return { error: 'unsatisfiable' };
      return r;
    },
  };
}

export const okReport = (requiredCapabilities: string[] = [], unsupported: any[] = []) => ({
  target: 'hermes-profile-distribution', targetVersion: '1', hermes: 't', components: {}, unsupported, warnings: [], requiredCapabilities,
});
export function fakeBridge(over: { check?: Partial<CheckResult> & { skills?: string[] } | { unavailable: string }; dryrun?: Partial<CheckResult> | { unavailable: string }; skills?: string[] } = {}): Bridge & { ops: string[] } {
  const ops: string[] = [];
  const b = (async (req: any) => {
    ops.push(req.op);
    if (req.op === 'check') return over.check ?? { ok: true, findings: [], report: okReport(), skills: over.skills ?? req.resolved.skills.map((x: any) => x.id) };
    return over.dryrun ?? { ok: true, findings: [], dryRun: { ok: true, steps: [{ name: 'load', ok: true }], networkAttempts: 0 } };
  }) as Bridge & { ops: string[] };
  b.ops = ops;
  return b;
}
export const safeScanner = async () => ({ verdict: 'safe' as const, findings: [] });
export const names = (cs: Array<{ name: string; ok: boolean }>) => cs.filter(c => !c.ok).map(c => c.name);
export const get = (cs: Array<{ name: string }>, n: string): any => cs.find(c => c.name === n);
export type { Visibility };
