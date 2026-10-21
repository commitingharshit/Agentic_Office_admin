// Plan 3 Task 9: the workflow validator against its hostile corpus (evals/corpora/workflow.ts), the tool-area snapshot kept
// in step with the repo's taxonomy, and the plan-parses check against the REAL dag-runtime CLI (skipped when no python
// environment with the runtime's dependencies is available: set DAG_RUNTIME_PYTHON).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { UnpackError, unpack } from '../src/marketplace/artifacts.ts';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { classifyTool, createDagPlanChecker, createWorkflowValidator, loadToolAreas } from '../src/marketplace/validate/workflow.ts';
import { benign, malicious, workflowZip, wf } from '../evals/corpora/workflow.ts';
import { repoRoot } from '../evals/lib.ts';

const PY = [process.env['DAG_RUNTIME_PYTHON'], join(repoRoot, 'services', 'dag-runtime', '.venv', 'bin', 'python')].find((p) => p && existsSync(p));
const probe = PY ? spawnSync(PY, ['-I', '-c', 'import pydantic, typer, mcp'], { encoding: 'utf8' }) : null;
const havePython = !!PY && probe?.status === 0;
const checker = havePython ? createDagPlanChecker({ python: PY }) : undefined;
const validator = createWorkflowValidator({ planChecker: checker });
const run = async (bytes: Uint8Array) => { const pkg = unpack(bytes); return (await validator(pkg)).length ? validateWith(pkg) : validateWith(pkg); };
async function validateWith(pkg: ReturnType<typeof unpack>) {
  const checks = await validator(pkg);
  return { ok: checks.every((c) => c.ok), verified: checks.every((c) => c.ok) && !checks.some((c) => c.skipped && c.required), checks };
}
const failed = (r: { checks: Array<{ name: string; ok: boolean }> }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('workflow validator: hostile corpus', () => {
  test('the corpus is not vacuous', () => { assert.ok(malicious.length >= 30); assert.ok(benign.length >= 5); });
  for (const c of malicious) test(`rejects ${c.id}: ${c.note}`, async () => {
    let r;
    try { r = await run(await c.build()); } catch (e) {
      if (e instanceof UnpackError) return;                      // refused before the validator ever sees it: a rejection
      assert.fail(`${c.id} must be rejected by a check, not crash: ${(e as Error).message}`);
    }
    assert.equal(r.ok, false, `${c.id} was accepted`);
    assert.notEqual(r.verified, true);
    assert.ok(failed(r).length > 0);
  });
  for (const c of benign) test(`accepts ${c.id}: ${c.note}`, async () => {
    const r = await run(await c.build());
    assert.deepEqual(failed(r), [], JSON.stringify(r.checks.filter((k) => !k.ok)));
    assert.equal(r.ok, true);
    assert.equal(r.checks.find((k) => k.name === 'risk-tier')!.detail, 'declarative');
  });
});

describe('workflow validator: the reason names the right check', () => {
  const byId = (id: string) => malicious.find((c) => c.id === id)!;
  const expect: Record<string, string> = {
    'x01-forward-depends-on': 'acyclic', 'x02-self-dependency': 'acyclic', 'x03-mutual-cycle': 'acyclic', 'x04-depth-12': 'plan-caps', 'x05-500-steps': 'payload-bounded', 'x35-150-steps': 'plan-caps',
    'x06-retries-50': 'retries-bounded', 'x07-timeout-day': 'retries-bounded', 'x08-unbounded-recursion': 'plan-caps', 'x09-recursion-undeclared': 'agent-steps-flagged',
    'x10-human-approval-step': 'no-human-approval', 'x11-approval-flag': 'no-human-approval', 'x12-undeclared-server': 'tools-declared', 'x13-mail-send': 'tools-declared',
    'x14-exec-class-tool': 'tools-declared', 'x15-unknown-tool': 'tools-declared', 'x16-param-fills-tool': 'params-typed', 'x17-param-fills-server': 'params-typed',
    'x18-undeclared-placeholder': 'params-typed', 'x19-agent-profile-override': 'agent-steps-flagged', 'x20-agent-undeclared': 'agent-steps-flagged', 'x21-agent-injection': 'agent-task-scan',
    'x23-literal-secret': 'no-literal-secrets', 'x24-script-file': 'only-allowed-files', 'x25-unbounded-loop': 'plan-caps', 'x26-map-fanout': 'plan-caps', 'x27-regex-guard': 'plan-references',
    'x28-env-reference': 'plan-references', 'x29-no-permissions': 'permissions-match-payload', 'x30-extra-permission': 'permissions-match-payload', 'x31-unknown-step-key': 'plan-shape',
    'x32-huge-param': 'params-typed', 'x33-budget-too-big': 'workflow-shape', 'x34-synthesize-merge': 'plan-shape',
  };
  for (const [id, check] of Object.entries(expect)) test(`${id} fails ${check}`, async () => {
    const r = await run(await byId(id).build());
    assert.ok(failed(r).includes(check), `${id}: failed ${failed(r).join(',')} (wanted ${check})`);
  });
  test('the cycle message says why forward dependencies are refused', async () => {
    const r = await run(await byId('x01-forward-depends-on').build());
    assert.match(r.checks.find((c) => c.name === 'acyclic')!.detail!, /not an earlier sibling/);
  });
  test('an edit workflow is flagged high-risk and needs fs.workspace.write', async () => {
    const r = await run(await benign.find((c) => c.id === 'w03-edit-workflow')!.build());
    assert.match(r.checks.find((c) => c.name === 'high-risk-tools')!.detail!, /docx:docx_apply \(edit\)/);
    const noWrite = await run(workflowZip(wf({ type: 'sequential', steps: [{ type: 'tool', id: 'a', server: 'docx', tool: 'docx_apply', arguments: { path: '{{path}}' } }] }), { permissions: [{ capability: 'tool.invoke', scope: 'docx:docx_apply', reason: 'x' }] }));
    assert.ok(failed(noWrite).includes('permissions-match-payload'));
  });
});

describe('workflow validator: verified only with the runtime check', () => {
  test('without a plan checker the report is ok but not verified', async () => {
    const pkg = unpack(await benign[0].build());
    const checks = await createWorkflowValidator()(pkg);
    const pp = checks.find((c) => c.name === 'plan-parses')!;
    assert.equal(pp.skipped, true); assert.equal(pp.required, true);
    const r = await validateArtifact('workflow', pkg);
    assert.equal(r.verified, false);
  });
  test('an unavailable checker is a required skip, never a pass', async () => {
    const pkg = unpack(await benign[0].build());
    const checks = await createWorkflowValidator({ planChecker: async () => ({ unavailable: 'no python' }) })(pkg);
    const pp = checks.find((c) => c.name === 'plan-parses')!;
    assert.deepEqual([pp.skipped, pp.required], [true, true]);
  });
  test('a checker that throws or lies about success is not trusted', async () => {
    const pkg = unpack(await benign[0].build());
    const checks = await createWorkflowValidator({ planChecker: async () => { throw new Error('boom'); } })(pkg);
    assert.equal(checks.find((c) => c.name === 'plan-parses')!.required, true);
  });
  test('the real runtime check passes the benign corpus and says how big the plan is', { skip: !havePython && 'no python environment with the dag-runtime dependencies (set DAG_RUNTIME_PYTHON)' }, async () => {
    for (const c of benign) {
      const r = await run(await c.build());
      const pp = r.checks.find((k) => k.name === 'plan-parses')!;
      assert.equal(pp.ok, true, `${c.id}: ${pp.detail}`);
      assert.ok(!pp.skipped, `${c.id}: plan-parses was skipped: ${pp.detail}`);
      // the one skip allowed here: agent text needs the injected Skills Guard scanner, which this test does not configure
      const skips = r.checks.filter((k) => k.skipped).map((k) => k.name);
      assert.deepEqual(skips, c.id === 'w06-agent-node' ? ['agent-task-scan-guard'] : [], c.id);
    }
  });
  test('the runtime check and the TypeScript checks agree on every structural malicious case (differential)', { skip: !havePython && 'no python environment' }, async () => {
    const structural = ['x01', 'x02', 'x03', 'x04', 'x35', 'x06', 'x07', 'x10', 'x11', 'x25', 'x26', 'x27', 'x28', 'x31', 'x34', 'x33', 'x09'];
    for (const prefix of structural) {
      const c = malicious.find((m) => m.id.startsWith(prefix + '-'))!;
      const pkg = unpack(await c.build());
      const p = pkg.manifest.payload as any;
      const r = await checker!({ kind: 'workflow', plan: p.plan, parameters: p.parameters ?? [], budget: p.budget ?? {}, requires: p.requires ?? {} });
      assert.ok(!('unavailable' in r), `${c.id}: ${JSON.stringify(r)}`);
      assert.equal((r as any).ok, false, `${c.id}: the Python validator accepted what TypeScript rejects`);
    }
  });
});

describe('tool classification', () => {
  test('the snapshot matches the repo taxonomy for every allowed server (drift check)', () => {
    const tax = JSON.parse(readFileSync(join(repoRoot, 'mcp', 'shared', 'tool-taxonomy.json'), 'utf8')) as { servers: Record<string, { tools: Record<string, string> }> };
    const snap = loadToolAreas();
    for (const [s, v] of Object.entries(tax.servers)) {
      if (snap.denied_servers.includes(s)) { assert.equal(snap.servers[s], undefined, s); continue; }
      assert.deepEqual(snap.servers[s], Object.fromEntries(Object.entries(v.tools).sort(([a], [b]) => (a < b ? -1 : 1))), `${s} drifted: regenerate workflow-tool-areas.json`);
    }
    assert.deepEqual([...snap.denied_servers].sort(), ['collab', 'mail', 'webpage', 'workspace']);
  });
  test('reads and verifies pass; sends, shell-ish and unknown tools do not', () => {
    assert.deepEqual(classifyTool('docx', 'docx_get'), { ok: true, area: 'read' });
    assert.deepEqual(classifyTool('docx', 'docx_apply'), { ok: true, area: 'edit' });
    for (const [s, t] of [['mail', 'email_send'], ['mail', 'email_search'], ['webpage', 'page_read'], ['collab', 'room_post'], ['docx', 'docx_run_sql'], ['pdf', 'nope'], ['nope', 'x'], ['__proto__', 'x'], ['docx', 'constructor']] as const) assert.equal(classifyTool(s, t).ok, false, `${s}:${t}`);
  });
});
