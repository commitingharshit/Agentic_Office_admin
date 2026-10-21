// E2E HARNESS ONLY (Plan 2 Task 10). A marketplace API on loopback with embedded Postgres, the REAL agent compiler bridge (the vendored Hermes
// python) and the REAL Skills Guard persona scanner, on which this is published THROUGH THE REAL HANDLERS:
//   - agent  acme/ma-analyst 1.0.0 and 1.1.0 (admin submission -> real compile + dry run -> a DIFFERENT admin approves with the permission-summary
//            acknowledgement -> a third publish call), depending on the skill acme/dd-checklist;
//   - bundle u1-pack (creator upload, validated by the real bundle validator) of {skill, agent 1.0.0}.
// The skill itself is seeded straight into the database (a skill listing is not what this flow tests; Plan 1 covers its publish path).
// Never deploy this: it accepts fixed tokens (user token `u1`, admin tokens in the state file).
//
//   node scripts/marketplace-agent-e2e-server.ts --port 0 --state <file>
//
// No stand-in for the capabilities answer: it is the server's real one (agent and bundle operational, compiler self-check passed).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createAgentBridge } from '../src/marketplace/agents.ts';
import { createSkillsGuardScanner, findRepoRoot } from '../src/marketplace/validate/skillsGuard.ts';
import { agentPkg, startHarness, zipOf } from '../test/helpers/agents-harness.ts';
import { bundleOf, pkgOf } from '../test/helpers/bundle-fixtures.ts';
import { baseBp } from '../test/marketplace-agent-helpers.ts';

if (process.env.NODE_ENV === 'production') { console.error('marketplace-agent-e2e-server: refusing to start with NODE_ENV=production.'); process.exit(2); }
const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const STATE = opt('--state');
const WINDOW = args.includes('--window');   // seed what a real-window run of the Team Library needs: a team u1 owns, with assignments
const python = process.env.AO_E2E_PYTHON ?? process.env.HERMES_PYTHON ?? resolve(findRepoRoot(), 'vendor/hermes-agent/venv/bin/python');
const AGENT = 'acme/ma-analyst', SKILL = 'acme/dd-checklist', BUNDLE = 'u-u1/ma-pack';

async function main() {
  const t = await startHarness({ bridgeFor: (store) => createAgentBridge({ python, store }), scanner: createSkillsGuardScanner({ python }) });
  if (!t.runtime.ok()) throw new Error(`the compiler self-check did not pass: ${t.runtime.detail()}`);
  await t.h.owner.query(`INSERT INTO devices(id, user_id) VALUES ('dev_1','u1')`);
  await t.seedSkill(SKILL, { version: '1.0.0' });
  const PERMS = [{ capability: 'tool.invoke' as const, scope: 'skills', reason: 'runs the declared skill' }];
  const bp = (extra: Record<string, unknown> = {}) => baseBp({
    skillReferences: [{ id: SKILL, range: '^1.0.0', required: true }],
    toolPermissions: { mode: 'ask', toolsets: ['skills'], kits: [], deny: [] },
    schedulingPolicy: { triggers: [{ kind: 'schedule', schedule: 'every 24h', prompt: 'Weekly digest' }] },
    ...extra,
  });
  const publish = async (version: string, extra: Record<string, unknown> = {}) => {
    const pkg = agentPkg({ id: AGENT, bp: bp(extra), permissions: PERMS });
    pkg.manifest.version = version;
    const r = await t.call('/admin/marketplace/submissions?visibility=public', { as: 'root', zip: zipOf(pkg) });
    if (r.status !== 201 || r.json.validation?.verified !== true) throw new Error(`agent ${version} did not validate as verified: ${JSON.stringify(r.json).slice(0, 800)}`);
    const ap = await t.call(`/admin/marketplace/versions/${r.json.versionId}/approve`, { as: 'eng', method: 'POST', body: { ack_summary_sha256: r.json.summarySha256 } });
    if (ap.status !== 200) throw new Error(`approve ${version}: ${ap.status} ${JSON.stringify(ap.json)}`);
    const pu = await t.call(`/admin/marketplace/versions/${r.json.versionId}/publish`, { as: 'eng2', method: 'POST', body: { visibility: 'public' } });
    if (pu.status !== 200) throw new Error(`publish ${version}: ${pu.status} ${JSON.stringify(pu.json)}`);
    return r.json.versionId as string;
  };
  const v1 = await publish('1.0.0');
  const v2 = await publish('1.1.0', { modelPolicy: { primary: { provider: 'anthropic', model: 'claude-sonnet-4-5' } } });
  const rows = (await t.admin.query(`SELECT id, listing_id, version, sha256 FROM marketplace_versions WHERE listing_id IN ($1,$2) ORDER BY listing_id, version`, [AGENT, SKILL])).rows;
  const skill = rows.find((r: any) => r.listing_id === SKILL), agent1 = rows.find((r: any) => r.listing_id === AGENT && r.version === '1.0.0');
  const b = bundleOf([]);
  b.items = [{ id: SKILL, type: 'skill', version: '1.0.0', sha256: skill.sha256 }, { id: AGENT, type: 'agent', version: '1.0.0', sha256: agent1.sha256 }];
  b.installOrder = [SKILL, AGENT];
  const bundle = await t.call('/v1/marketplace/listings?visibility=private', { user: 'u1', zip: zipOf(pkgOf(b, { id: BUNDLE, permissions: PERMS })) });
  if (bundle.json?.state !== 'published') throw new Error(`the bundle was not published: ${JSON.stringify(bundle.json).slice(0, 800)}`);
  let teamState: Record<string, string> = {};
  if (WINDOW) {
    // acme/team-notes: v1.0.0 (what the window installs) and v1.1.0 (what the team re-pins later), so the Team Library says "Update available (pinned by your team)"
    const v10 = await t.seedSkill('acme/team-notes', { version: '1.0.0' });
    const v11 = await t.seedSkill('acme/team-notes', { version: '1.1.0' });
    const TEAM = 'team_' + 'a'.repeat(18);
    await t.admin.query(`INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ($1,'Deal team','u1')`, [TEAM]);
    await t.admin.query(`INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ($1,'u1','owner'),($1,'u2','member')`, [TEAM]);
    const assign = async (listingId: string, versionId: string, mode: string) => {
      const r = await t.call(`/v1/marketplace/teams/${TEAM}/assignments`, { user: 'u1', body: { listingId, versionId, mode } });
      if (r.status !== 201 && r.status !== 200) throw new Error(`assign ${listingId}: ${r.status} ${JSON.stringify(r.json)}`);
    };
    await assign('acme/team-notes', v10.versionId, 'required');   // the test re-pins v1.1.0 after the window installed v1.0.0
    await assign(AGENT, v1, 'recommended');
    await assign('acme/dd-checklist', skill.id, 'optional');
    teamState = { teamId: TEAM, teamNotesV10: v10.versionId, teamNotesV11: v11.versionId };
  }
  const state = { ...teamState, url: t.api, token: 'u1', device: 'dev_1', agentId: AGENT, skillId: SKILL, bundleId: BUNDLE, agentV1: v1, agentV2: v2, skillVersionId: skill.id, adminRootToken: 'r'.repeat(30), adminEngToken: 'e'.repeat(30), adminApi: t.adminApi, pid: process.pid };
  if (STATE) { mkdirSync(dirname(resolve(STATE)), { recursive: true }); writeFileSync(STATE, JSON.stringify(state)); }
  console.log(`marketplace agent e2e server: ${t.api} (admin ${t.adminApi})`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await t.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
