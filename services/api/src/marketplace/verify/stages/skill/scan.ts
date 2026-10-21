// Stage 4 (required): the injected Skills Guard scanner. Any finding blocks. No scanner => skipped (verdict incomplete), never pass.
import type { Evidence, StageDef } from '../../types.ts';
import { skillPayload, tooLarge, treeProblem } from './util.ts';

export function scanStage(timeoutMs = 90_000): StageDef {
  return {
    id: 'scan', title: 'Security scan (Skills Guard)', required: true, timeoutMs, after: ['manifest'],
    run: async ({ pkg, tools }) => {
      if (!tools.scanner) return { status: 'skipped', reason: 'tool-missing:scanner', evidence: [] };
      const bad = treeProblem(pkg); if (bad) return tooLarge(bad);
      const { name } = skillPayload(pkg);
      if (!name) return { status: 'fail', reason: 'payload.name is missing, the scanner needs the skill name', evidence: [] };
      let r;
      try { r = await tools.scanner(pkg.files, name); }
      catch (e) { return { status: 'fail', reason: `scanner-error: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`, evidence: [] }; }
      const evidence: Evidence[] = r.findings.slice(0, 40).map((f) => ({
        kind: 'check', label: `${f.category}/${f.severity}`, detail: `${f.file}${f.line ? ':' + f.line : ''}${f.match ? ' ' + JSON.stringify(f.match.slice(0, 80)) : ''}`,
      }));
      if (r.findings.length > 40) evidence.push({ kind: 'text', label: 'more findings', detail: `${r.findings.length - 40} more finding(s) not listed` });
      if (r.verdict === 'safe' && r.findings.length === 0) return { status: 'pass', evidence: [{ kind: 'check', label: 'verdict safe', detail: `${pkg.files.size} files scanned` }] };
      return { status: 'fail', reason: `verdict ${r.verdict}; ${r.findings.length} finding(s)`, evidence };
    },
  };
}
