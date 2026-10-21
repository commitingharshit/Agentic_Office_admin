// Stage 6 (advisory): tool grounding. check-skill-tool-grounding.py resolves tool names against the Hermes capability map and
// the repo's skills/ tree, and cannot run on a community package; until it can, this is an honest skip, never a pass.
import type { StageDef } from '../../types.ts';

export const toolGroundingStage = (timeoutMs = 10_000): StageDef => ({
  id: 'tool-grounding', title: 'Tool grounding', required: false, timeoutMs, after: ['manifest'],
  run: async () => ({ status: 'skipped', reason: 'tool-missing:capability-map (check-skill-tool-grounding.py is bound to the repo skills tree)', evidence: [] }),
});
