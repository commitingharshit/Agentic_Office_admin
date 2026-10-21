// Stages 1 and 2: the existing validators, called (not copied) and folded into one stage each via the Plan 4 adapter.
import { commonChecks } from '../../../validate/index.ts';
import { createSkillValidator } from '../../../validate/skill.ts';
import type { ValidationCheck } from '../../../types.ts';
import { fromValidationReport } from '../../adapters.ts';
import type { StageDef, StageOutput } from '../../types.ts';

function fold(checks: ValidationCheck[]): StageOutput {
  const rs = fromValidationReport({ ok: checks.every((c) => c.ok), verified: false, checks });
  const failed = rs.filter((r) => r.status === 'fail'), skipped = rs.filter((r) => r.status === 'skipped');
  const evidence = rs.map((r) => ({ kind: 'check' as const, label: `${r.id}: ${r.status}`, ...(r.reason ?? r.evidence[0]?.detail ? { detail: (r.reason ?? r.evidence[0]?.detail) as string } : {}) }));
  if (failed.length) return { status: 'fail', reason: failed.map((r) => `${r.id}: ${r.reason}`).join('; '), evidence };
  if (skipped.length) return { status: 'skipped', reason: skipped.map((r) => `${r.id}: ${r.reason}`).join('; '), evidence };
  return { status: 'pass', evidence };
}

export const manifestStage = (timeoutMs = 15_000): StageDef => ({
  id: 'manifest', title: 'Manifest, paths and file hashes', required: true, timeoutMs,
  run: async ({ pkg }) => fold(commonChecks('skill', pkg)),
});

/** The skill validator WITHOUT its scanner (the scan has its own stage); security-scan is dropped from the fold. */
export const specStage = (timeoutMs = 30_000): StageDef => ({
  id: 'spec', title: 'agentskills.io spec, file policy and consent checks', required: true, timeoutMs, after: ['manifest'],
  run: async ({ pkg }) => fold((await createSkillValidator()(pkg)).filter((c) => c.name !== 'security-scan')),
});
