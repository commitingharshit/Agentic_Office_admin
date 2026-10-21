import type { ValidationReport } from '../types.ts';
import type { StageResult } from './types.ts';

/** Maps the Plan 1 validator checks 1:1: ok -> pass, !ok -> fail, skipped -> skipped (a skip is never a pass). Names are kept as ids. */
export function fromValidationReport(report: ValidationReport): StageResult[] {
  return report.checks.map(c => {
    const status: StageResult['status'] = c.skipped ? 'skipped' : c.ok ? 'pass' : 'fail';
    const r: StageResult = {
      id: c.name, title: c.name, required: c.required === true, status, evidence: [], durationMs: 0,
    };
    if (status !== 'pass') r.reason = c.detail && c.detail.length ? c.detail : (status === 'skipped' ? 'skipped' : 'check-failed');
    else if (c.detail) r.evidence.push({ kind: 'check', label: c.name, detail: c.detail });
    if (status === 'fail' && c.detail) r.evidence.push({ kind: 'check', label: c.name, detail: c.detail });
    return r;
  });
}
