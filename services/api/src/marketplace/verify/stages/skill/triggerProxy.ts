// Stage 7 (advisory): retrieval proxy for description triggering, over the sidecar's declared example prompts. The skill payload
// has no example-prompts field (payload-shape refuses unknown fields), so there is nothing to evaluate: skipped, never pass.
import type { StageDef } from '../../types.ts';

export const triggerProxyStage = (timeoutMs = 10_000): StageDef => ({
  id: 'trigger-proxy', title: 'Trigger proxy (retrieval proxy, not routing)', required: false, timeoutMs, after: ['manifest'],
  run: async ({ pkg }) => {
    const p = pkg.manifest.payload as Record<string, unknown> | undefined;
    if (!Array.isArray(p?.examples) || p.examples.length === 0) return { status: 'skipped', reason: 'no-example-prompts', evidence: [] };
    return { status: 'skipped', reason: 'tool-missing:trigger-eval', evidence: [] };
  },
});
