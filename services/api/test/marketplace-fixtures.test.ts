// The Plan 2 example agents (test fixtures only) and the regressions the Task 8 corpora found.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPythonBridge } from '../src/marketplace/blueprint/pyBridge.ts';
import { parseBlueprintText } from '../src/marketplace/blueprint/schema.ts';
import { blueprintTexts, scanSecrets } from '../src/marketplace/blueprint/secrets.ts';
import { parseBundleText } from '../src/marketplace/bundle/schema.ts';
import { createAgentValidator } from '../src/marketplace/validate/agent.ts';
import { cases as bpCases, fixtureRows, loadFixtureAgent } from '../evals/blueprint-corpus.ts';
import { cases as bundleCases } from '../evals/bundle-corpus.ts';
import { catalog, pythonEnv } from '../evals/agent-env.ts';
import { agentPkg, baseBp, fakeCatalog, row } from './marketplace-agent-helpers.ts';
import { bundleOf, member } from './helpers/bundle-fixtures.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const env = pythonEnv();
const DIRS = ['ma-analyst', 'legal-research'] as const;

describe('agent fixtures (test fixtures only, never listings)', () => {
  test('each fixture directory is a complete package whose manifest hashes match its files', () => {
    for (const d of DIRS) {
      const pkg = loadFixtureAgent(d);
      for (const f of pkg.manifest.files) {
        const bytes = pkg.files.get(f.path);
        assert.ok(bytes, `${d}/${f.path} missing`);
        assert.equal(createHash('sha256').update(bytes!).digest('hex'), f.sha256, `${d}/${f.path}: regenerate the manifest hash`);
        assert.equal(bytes!.length, f.size);
      }
      assert.deepEqual([...pkg.files.keys()].sort(), ['README.md', 'SOUL.md', 'blueprint.json']);
      assert.match(readFileSync(join(here, 'fixtures', 'agents', d, 'README.md'), 'utf8'), /TEST FIXTURE ONLY/);
      assert.equal(pkg.manifest.id.split('/')[0], 'fixture-pub');
    }
    assert.match(readFileSync(join(here, 'fixtures', 'agents', 'README.md'), 'utf8'), /TEST FIXTURES ONLY\. Not listings\./i);
  });

  test('the blueprints exercise what the plan says they do', () => {
    const ma = parseBlueprintText(new TextDecoder().decode(loadFixtureAgent('ma-analyst').files.get('blueprint.json')));
    assert.deepEqual(ma.skillReferences?.map((s) => s.id), ['fixture-pub/dd-checklist', 'fixture-pub/financial-model-review']);
    assert.deepEqual(ma.toolPermissions?.kits, ['xlsx_kit', 'docx_kit', 'pptx_kit']);
    assert.equal(ma.memoryBinding?.provider, 'builtin');
    assert.equal(ma.contextScope?.workspaceAccess, 'write');
    assert.equal(ma.delegationPolicy?.children[0].role, 'comps-researcher');
    assert.ok(ma.schedulingPolicy?.triggers.some((t) => t.kind === 'schedule'));
    const lr = parseBlueprintText(new TextDecoder().decode(loadFixtureAgent('legal-research').files.get('blueprint.json')));
    assert.deepEqual(lr.toolPermissions?.kits, ['docx_kit']);
    assert.ok(lr.toolPermissions?.toolsets.includes('web') && lr.toolPermissions.toolsets.includes('skills'));
    assert.ok(lr.toolPermissions?.deny.includes('terminal'));
    assert.equal(lr.contextScope?.workspaceAccess, 'read');
    assert.equal(lr.schedulingPolicy, undefined);
  });

  test('no production code path or seed script references the fixtures', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p];
    });
    for (const dir of [join(root, 'src'), join(root, '..', '..', 'database')]) for (const f of walk(dir)) {
      if (!/\.(ts|js|mjs|sql|json|sh)$/.test(f)) continue;
      assert.ok(!/fixtures\/agents|fixture-pub\//.test(readFileSync(f, 'utf8')), `${f} mentions the agent fixtures`);
    }
  });

  test('both fixtures validate ok AND verified with the real compiler bridge and persona scanner', { skip: env ? false : 'no python venv with the vendored Hermes' }, async () => {
    const rows = await fixtureRows();
    for (const d of DIRS) {
      const cs = await createAgentValidator({ catalog: catalog(rows), bridge: env!.bridge, scanner: env!.scanner, context: { visibility: 'private', teamId: null } })(loadFixtureAgent(d));
      assert.deepEqual(cs.filter((c) => !c.ok), [], d);
      assert.deepEqual(cs.filter((c) => c.skipped && c.required), [], `${d} is not verified`);
      for (const n of ['compiles', 'dry-run', 'persona-scan', 'permissions-subset']) assert.equal(cs.find((c) => c.name === n)?.ok, true, `${d} ${n}`);
    }
    // the weekly schedule is declared-only: reported, not dropped
    const ma = await createAgentValidator({ catalog: catalog(rows), bridge: env!.bridge, scanner: env!.scanner, context: { visibility: 'private', teamId: null } })(loadFixtureAgent('ma-analyst'));
    assert.match(ma.find((c) => c.name === 'unsupported-reported')!.detail!, /schedulingPolicy/);
  });
});

describe('corpus size and labelling', () => {
  test('at least 40 blueprint and 30 bundle cases, every malicious case names its intended check, ids are unique', () => {
    assert.ok(bpCases.length >= 40, `${bpCases.length}`); assert.ok(bundleCases.length >= 30, `${bundleCases.length}`);
    for (const set of [bpCases, bundleCases] as Array<Array<{ id: string; label: string; catches?: string[]; note: string }>>) {
      assert.equal(new Set(set.map((c) => c.id)).size, set.length);
      for (const c of set) { assert.ok(c.note.length > 10, c.id); if (c.label === 'malicious') assert.ok(c.catches?.length, `${c.id} has no intended check`); }
    }
  });
});

// ---- regressions found by the Task 8 corpora
describe('regressions found by the corpora', () => {
  test('a long hyphenated skill id in a reference position is not a secret (false positive on the Task 8 fixture)', () => {
    const bp = parseBlueprintText(JSON.stringify(baseBp({ skillReferences: [{ id: 'fixture-pub/financial-model-review', range: '^1.0.0', required: true }] })));
    assert.deepEqual(scanSecrets(blueprintTexts(bp)), []);
    // ...but the same shape in free text is still scanned
    const bad = parseBlueprintText(JSON.stringify(baseBp({ objective: { goal: 'use fixture-pub/financial-model-review-token-xyz9', successCriteria: ['a'] } })));
    assert.ok(blueprintTexts(bad).get('blueprint.objective.goal'));
  });

  test('the dry-run request carries the child blueprints (an agent with a child could never pass the real dry run)', async () => {
    let seen: any;
    const bridge = createPythonBridge({ runner: async (i) => { seen = JSON.parse(i.stdin); return { code: 0, stdout: '{"ok":false,"findings":[]}', stderr: '', timedOut: false, overflow: false }; } });
    const childBp = baseBp({ toolPermissions: { mode: 'ask', toolsets: ['web'], kits: [], deny: [] } });
    const r = row('acme/child', { type: 'agent', blueprint: childBp });
    const resolved = { skills: [], children: [r], agents: new Map([['acme/child', r]]), graph: new Map(), truncated: false };
    const enc = (s: string) => new TextEncoder().encode(s);
    await bridge({ op: 'dryrun', listingId: 'acme/a', version: '1.0.0', blueprint: enc('{}'), soul: enc('x'), resolved });
    assert.deepEqual(seen.child_blueprints, { 'acme/child': childBp });
    await bridge({ op: 'check', listingId: 'acme/a', version: '1.0.0', blueprint: enc('{}'), soul: enc('x'), resolved });
    assert.equal(seen.child_blueprints, undefined);
  });

  test('a BOM before blueprint.json is rejected by the TypeScript checks (the decoder used to strip it)', async () => {
    const pkg = agentPkg({ rawBlueprint: '﻿' + JSON.stringify(baseBp()) });
    const cs = await createAgentValidator({ catalog: fakeCatalog([]) })(pkg);
    assert.equal(cs.find((c) => c.name === 'blueprint-parse')!.ok, false);
  });

  test('confusable listing ids (hyphen-only differences) in one reference list are refused', () => {
    const two = (a: string, b: string) => baseBp({ skillReferences: [{ id: a, range: '^1.0.0', required: true }, { id: b, range: '^1.0.0', required: true }] });
    assert.throws(() => parseBlueprintText(JSON.stringify(two('acme/pdf-tool', 'acme/pdftool'))), /confusable/);
    assert.doesNotThrow(() => parseBlueprintText(JSON.stringify(two('acme/pdf-tool', 'acme/pdf-reader'))));
    const kids = baseBp({ delegationPolicy: { maxDepth: 1, maxConcurrent: 1, children: [{ id: 'acme/c-1', range: '^1.0.0', role: 'r' }, { id: 'acme/c1', range: '^1.0.0', role: 'r' }] } });
    assert.throws(() => parseBlueprintText(JSON.stringify(kids)), /confusable/);
  });

  test('bundle.json with a duplicate key is refused (JSON.parse keeps the last, other parsers the first)', () => {
    const items = JSON.stringify(bundleOf([member('acme/a')]).items);
    const dup = `{"schema":"agentic.bundle/1","items":${items},"items":${items},"installOrder":["acme/a"],"teamScope":{"kind":"none"}}`;
    assert.throws(() => parseBundleText(dup), /duplicate/);
    assert.doesNotThrow(() => parseBundleText(JSON.stringify(bundleOf([member('acme/a')]))));
  });
});
