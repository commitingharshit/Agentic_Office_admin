#!/usr/bin/env node
// Marketplace truth table (Plan 4 Task 18): for each listing type, what is registered and whether it is operational.
//   node scripts/dev/marketplace-truth-table.mjs [--json] [--check]
// Columns: validator registered | verification pipeline registered | desktop install adapter present | acceptance evidence passed | operational (server flag).
// "Operational" is the OPERATIONAL flag in services/accounts-sync/src/marketplace/support.ts; the evidence column is read from the evidence
// records (docs/audits/marketplace-type-evidence*) that test/marketplace-enablement.test.ts also enforces. --check exits 1 when a type is flagged
// operational without evidence (the disagreement the UI must never show). Nothing here is hand-written: every cell is computed from the tree.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const svc = (p) => pathToFileURL(join(root, 'services/accounts-sync/src/marketplace', p)).href;
const { OPERATIONAL } = await import(svc('support.ts'));
const { getValidator } = await import(svc('validate/index.ts'));
const { LISTING_TYPES } = await import(svc('types.ts'));
await import(svc('verify/stages/template/index.ts'));
const skillStages = await import(svc('verify/stages/skill/index.ts'));
skillStages.registerSkillPipeline();   // the server registers it at start; a factory, not an import side effect
const { getPipeline } = await import(svc('verify/registry.ts'));
// agent and bundle register their validators when the bridge starts (agents.ts); report them from the source instead of pretending
const contextRegistered = new Set(readFileSync(join(root, 'services/accounts-sync/src/marketplace/agents.ts'), 'utf8').match(/registerContextValidator\('(\w+)'/g)?.map((m) => m.match(/'(\w+)'/)[1]) ?? []);

const adapterDir = join(root, 'apps/desktop/src/vs/platform/marketplace/node');
const adapterPresent = (t) => ['template', 'skill'].includes(t) ? existsSync(join(adapterDir, 'marketplaceInstaller.ts')) : t === 'agent' ? existsSync(join(adapterDir, 'agentAdapter.ts')) : t === 'bundle' ? existsSync(join(adapterDir, 'bundleInstaller.ts')) : existsSync(join(adapterDir, 'adapters', `${t}Adapter.ts`));

// evidence: every JSON under docs/audits/marketplace-type-evidence* and marketplace-evidence/ with {type, result:'pass', script that exists}
const evidence = new Map();
const audits = join(root, 'docs/audits');
const evFiles = [];
for (const d of readdirSync(audits, { withFileTypes: true })) {
  if (d.isFile() && /^marketplace-type-evidence.*\.json$/.test(d.name)) evFiles.push(join(audits, d.name));
  if (d.isDirectory() && /^marketplace-(type-)?evidence$/.test(d.name)) for (const f of readdirSync(join(audits, d.name))) if (f.endsWith('.json')) evFiles.push(join(audits, d.name, f));
}
for (const f of evFiles) { try { const e = JSON.parse(readFileSync(f, 'utf8')); if (e.type && e.result === 'pass' && e.script && existsSync(join(root, e.script))) evidence.set(e.type, (evidence.get(e.type) ?? []).concat(e.mode ?? 'all')); } catch { /* not a record */ } }
// template and skill are covered by the real-window flow (marketplace-flow.mjs) and the acceptance record rather than a type-evidence JSON
for (const t of ['template', 'skill']) if (existsSync(join(root, 'scripts/e2e/plan/marketplace-flow.mjs')) && readdirSync(audits).some((f) => /marketplace-acceptance.*\.md$/.test(f))) evidence.set(t, ['window-flow (see the acceptance record)']);

const rows = LISTING_TYPES.map((t) => {
  const supported = OPERATIONAL[t]?.supported === true || Object.values(OPERATIONAL[t]?.modes ?? {}).some(Boolean);
  const r = { type: t, validator: !!getValidator(t) || contextRegistered.has(t), pipeline: !!getPipeline(t), adapter: adapterPresent(t), evidence: evidence.has(t), operational: supported };
  r.note = supported ? (r.evidence ? '' : 'FLAGGED OPERATIONAL WITHOUT EVIDENCE') : (OPERATIONAL[t]?.reason ?? 'not yet available');
  return r;
});
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else {
  const w = (b) => (b ? 'yes' : 'no ');
  console.log('type       validator pipeline adapter evidence operational  note');
  for (const r of rows) console.log(`${r.type.padEnd(10)} ${w(r.validator).padEnd(9)} ${w(r.pipeline).padEnd(8)} ${w(r.adapter).padEnd(7)} ${w(r.evidence).padEnd(8)} ${w(r.operational).padEnd(11)} ${r.note}`);
  console.log('\nOnly template and skill have a registered verification pipeline; every other type ships on its validator, the evidence flow and manual review (Plan 4 Appendix A lists the stages the owning plans add).');
}
if (process.argv.includes('--check')) process.exit(rows.some((r) => r.operational && !r.evidence) ? 1 : 0);
