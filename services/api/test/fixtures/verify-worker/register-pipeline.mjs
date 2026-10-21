// Loaded by the REAL sandboxed child (child.ts) through VERIFY_MODULES: registers a tiny template pipeline whose stage
// stores one evidence blob, so the whole path (unpack -> runPipeline -> blob upload -> result) is exercised.
import { registerPipeline, getPipeline } from '../../../src/marketplace/verify/registry.ts';
if (!getPipeline('template')) {
  registerPipeline({ type: 'template', name: 'template-basic', version: 1, stages: [
    { id: 'manifest', title: 'Manifest', required: true, timeoutMs: 5000, run: async (ctx) => {
      const blob = await ctx.evidence.addBlob('text/plain', new TextEncoder().encode(`files: ${ctx.pkg.files.size ?? 'n/a'}`));
      return { status: 'pass', evidence: [{ kind: 'text', label: 'summary', blob }] };
    } },
  ] });
}
