// Follow-up 1: the catalog list rows carry a verification field read from the verification store, keyed to the artifact sha256.
// Fail closed: `verified` is true only for a passed newest result with nothing skipped, for the version's exact sha256.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { skip } from './helpers/marketplace-pg.ts';
import { startHarness, type Harness } from './helpers/agents-harness.ts';
import { fakeBridge } from './marketplace-agent-helpers.ts';

const H = (c: string) => c.repeat(64);
describe('list rows: verification', { skip }, () => {
  let t: Harness; let n = 0;
  const stage = (status: string, required = true) => ({ id: `s${++n}`, title: 'S', required, status, ...(status === 'pass' ? {} : { reason: 'r' }), evidence: [], durationMs: 1 });
  const record = (versionId: string, sha: string, verdict: string, stages: unknown[], o: { rowSha?: string } = {}) =>
    t.admin.query(`INSERT INTO marketplace_verifications(id, version_id, sha256, pipeline, pipeline_version, verdict, stages, result_sha256, started_at, finished_at, run_by)
                   VALUES ($1,$2,$3,'p',1,$4,$5,$6,now(),now(),'t')`, [`ver_${++n}`, versionId, o.rowSha ?? sha, verdict, JSON.stringify(stages), H((n % 10).toString()).slice(0, 60) + String(1000 + n)]);
  const row = async (id: string) => ((await t.call('/v1/marketplace/listings')).json.items as any[]).find((i) => i.id === id);

  before(async () => { t = await startHarness({ bridge: fakeBridge() }); });
  after(async () => { await t?.stop(); });

  test('no result: not verified, verdict null', async () => {
    await t.seedSkill('acme/none');
    assert.deepEqual((await row('acme/none')).verification, { verified: false, verdict: null, skipped: 0 });
  });
  test('passed with nothing skipped: verified', async () => {
    const v = await t.seedSkill('acme/ok'); await record(v.versionId, v.sha256, 'pass', [stage('pass')]);
    assert.equal((await row('acme/ok')).verification.verified, true);
    assert.equal((await row('acme/ok')).verification.verdict, 'pass');
  });
  test('pass with an optional stage skipped is NOT verified (fail closed), and the skip is reported', async () => {
    const v = await t.seedSkill('acme/optskip'); await record(v.versionId, v.sha256, 'pass', [stage('pass'), stage('skipped', false)]);
    assert.deepEqual((await row('acme/optskip')).verification, { verified: false, verdict: 'pass', skipped: 1 });
  });
  test('failed and incomplete are not verified', async () => {
    const f = await t.seedSkill('acme/bad'); await record(f.versionId, f.sha256, 'fail', [stage('fail')]);
    const i = await t.seedSkill('acme/inc'); await record(i.versionId, i.sha256, 'incomplete', [stage('skipped')]);
    assert.deepEqual((await row('acme/bad')).verification, { verified: false, verdict: 'fail', skipped: 0 });
    assert.equal((await row('acme/inc')).verification.verified, false);
  });
  test('a newer failure overrides an older pass', async () => {
    const v = await t.seedSkill('acme/regress'); await record(v.versionId, v.sha256, 'pass', [stage('pass')]); await record(v.versionId, v.sha256, 'fail', [stage('fail')]);
    assert.equal((await row('acme/regress')).verification.verified, false);
  });
  test('a pass recorded for a DIFFERENT sha256 never counts (artifact swapped after verification)', async () => {
    const v = await t.seedSkill('acme/swap');
    await record(v.versionId, v.sha256, 'pass', [stage('pass')]);
    // simulate the swap: point the version at a different artifact sha
    const other = H('e');
    await t.admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,1,'k-e') ON CONFLICT DO NOTHING`, [other]);
    await t.h.owner.query(`ALTER TABLE marketplace_versions DISABLE TRIGGER USER`);
    await t.h.owner.query(`UPDATE marketplace_versions SET sha256 = $2 WHERE id = $1`, [v.versionId, other]);
    await t.h.owner.query(`ALTER TABLE marketplace_versions ENABLE TRIGGER USER`);
    assert.deepEqual((await row('acme/swap')).verification, { verified: false, verdict: null, skipped: 0 });
  });
  test('the single-listing view carries the same field and no key anywhere is a score', async () => {
    const r = await t.call('/v1/marketplace/listings/acme/ok');
    assert.equal(r.json.verification.verified, true);
    assert.ok(!/score|rating_?verif/i.test(JSON.stringify(r.json.verification)));
  });
});
