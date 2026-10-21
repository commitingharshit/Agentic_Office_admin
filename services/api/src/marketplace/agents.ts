// Production wiring of the agent and bundle types: the real compiler bridge, the persona scanner, the per-request validators and
// the startup self-check that decides whether the server may say "agents and bundles are supported" (Plan 1 lesson M4: never
// advertise a capability whose backend was not proven at startup).
//   - register(): puts the agent and bundle validator FACTORIES in the registry (they take the caller-scoped catalog and the
//     audience of each request);
//   - selfCheck(): runs the REAL agent validation on a tiny built-in agent through the bridge and the scanner; `ok()` is true only
//     when that report is `verified`. Until then uploads of these types answer 503 and `capabilities` says unsupported.
import { createHash } from 'node:crypto';
import { MANIFEST_NAME, readZipFiles, type ArtifactStore } from './artifacts.ts';
import { createPythonBridge, spawnRunner, type Bridge, type Runner } from './blueprint/pyBridge.ts';
import { isPublishable } from './support.ts';
import type { ListingType, UnpackedPackage } from './types.ts';
import { createAgentValidator } from './validate/agent.ts';
import { createBundleValidator } from './validate/bundle.ts';
import { registerContextValidator } from './validate/index.ts';
import type { SkillScanner } from './validate/skill.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A minimal agent that must compile, dry-run and pass the persona scan: no references, no permissions. */
export function selfCheckAgentPackage(): UnpackedPackage {
  const bp = {
    schema: 'agentic.agent-blueprint/1',
    identity: { name: 'Self-check', role: 'checker', description: 'Built-in compiler self-check.', instructionsFile: 'SOUL.md' },
    objective: { goal: 'Prove the compiler runs.', successCriteria: ['compiles'] },
    executionEnvironments: ['desktop'],
  };
  const files = new Map<string, Uint8Array>([['blueprint.json', enc(JSON.stringify(bp))], ['SOUL.md', enc('# Self-check\n\nYou answer politely and briefly.\n')]]);
  return {
    files,
    manifest: {
      schema: 'agentic.marketplace/1', id: 'selfcheck/agent', type: 'agent', version: '1.0.0', title: 'Self-check', summary: 'Compiler self-check.', license: 'MIT',
      compat: { app: '*' }, dependencies: [], permissions: [],
      files: [...files].map(([path, b]) => ({ path, sha256: sha(b), size: b.length })),
      payload: { blueprint: 'blueprint.json', schema: 'agentic.agent-blueprint/1', components: [] },
    },
  } as UnpackedPackage;
}

// The compiler's dry run loads each referenced skill from its PINNED tree (the exact files of the published artifact). The TypeScript bridge
// request carries the skills' ids and hashes but not their files, so this runner adds them to the dry-run request: read from the artifact
// store by hash, verified against that hash, and capped under the compiler's 1 MiB request limit. A skill whose tree cannot be supplied is
// simply absent, which makes the dry run FAIL for a required skill (fail closed), never pass without having loaded it.
const MAX_TREE_REQUEST_B64 = 640 * 1024;
export function withSkillTrees(store: ArtifactStore | undefined, run: Runner = spawnRunner): Runner {
  return async (i) => {
    if (i.argv[i.argv.length - 1] !== 'dryrun' || !store) return run(i);
    let req: any;
    try { req = JSON.parse(i.stdin); } catch { return run(i); }
    const trees: Record<string, Record<string, string>> = {};
    let budget = MAX_TREE_REQUEST_B64;
    for (const sk of Array.isArray(req?.resolved?.skills) ? req.resolved.skills : []) {
      if (typeof sk?.id !== 'string' || typeof sk?.sha256 !== 'string' || trees[sk.id]) continue;
      try {
        const bytes = await store.get(sk.sha256);
        if (!bytes || sha(bytes) !== sk.sha256) continue;
        const files = readZipFiles(bytes, { maxTotal: 4 * 1024 * 1024, maxFiles: 512 });
        const tree: Record<string, string> = {};
        let size = 0;
        for (const [path, b] of files) { if (path === MANIFEST_NAME) continue; const b64 = Buffer.from(b).toString('base64'); size += b64.length; tree[path] = b64; }
        if (size > budget) continue;
        budget -= size;
        trees[sk.id] = tree;
      } catch { /* absent tree: the dry run reports the skill as not loadable */ }
    }
    return run({ ...i, stdin: JSON.stringify({ ...req, skills: trees }) });
  };
}

/** The production bridge: the Python CLI, with the pinned skill trees added to dry-run requests. */
export function createAgentBridge(opts: { python?: string; repoRoot?: string; timeoutMs?: number; store?: ArtifactStore; runner?: Runner } = {}): Bridge {
  return createPythonBridge({ python: opts.python, repoRoot: opts.repoRoot, timeoutMs: opts.timeoutMs, runner: withSkillTrees(opts.store, opts.runner) });
}

export interface AgentRuntimeOptions { bridge: Bridge; scanner?: SkillScanner }
export interface AgentRuntime {
  /** True only after a self-check whose report was verified. */
  ok(): boolean;
  /** Why it is not ok (for the log), or undefined. */
  detail(): string | undefined;
  selfCheck(): Promise<{ ok: boolean; detail?: string }>;
  register(): void;
}

export function createAgentRuntime(opts: AgentRuntimeOptions): AgentRuntime {
  let ok = false, detail: string | undefined = 'self-check has not run';
  return {
    ok: () => ok,
    detail: () => detail,
    async selfCheck() {
      try {
        const v = createAgentValidator({ bridge: opts.bridge, scanner: opts.scanner, context: { visibility: 'private', teamId: null } });
        const cs = await v(selfCheckAgentPackage());
        const bad = cs.filter((c) => !c.ok || (c.skipped && c.required));
        ok = bad.length === 0;
        detail = ok ? undefined : bad.map((c) => `${c.name}: ${c.detail ?? 'failed'}`).join('; ');
      } catch (e) { ok = false; detail = e instanceof Error ? e.message : String(e); }
      return { ok, ...(detail ? { detail } : {}) };
    },
    register() {
      registerContextValidator('agent', (ctx) => createAgentValidator({ catalog: ctx.catalog, bridge: opts.bridge, scanner: opts.scanner, ...(ctx.audience ? { context: ctx.audience } : {}) }));
      registerContextValidator('bundle', (ctx) => createBundleValidator({
        catalog: ctx.catalog, ...(ctx.audience ? { context: ctx.audience } : {}),
        supported: (t: ListingType) => isPublishable(t) || (t === 'agent' && ok),
      }));
    },
  };
}
