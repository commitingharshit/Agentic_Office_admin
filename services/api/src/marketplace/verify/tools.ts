import { createSkillsGuardScanner, findRepoRoot } from '../validate/skillsGuard.ts';
import type { PipelineTools } from './types.ts';

/**
 * Builds the in-process PipelineTools from the environment. A member is undefined when its tool is unavailable,
 * which makes the stage that needs it `skipped` (tool-missing), never a pass.
 * SKILLS_GUARD: unset => no scanner; "1" => locate the repo root; any other value => that repo root.
 * OFFICECLI_BIN / VERIFY_WORKER_URL: the officecli, kernel, visual and hermes members are provided by the verifier
 * worker (Task 5) and stay undefined until it exists; the env names are reserved here.
 */
export function defaultTools(env: Record<string, string | undefined> = process.env): PipelineTools {
  const tools: PipelineTools = {};
  const g = env.SKILLS_GUARD;
  if (g) {
    try { tools.scanner = createSkillsGuardScanner({ repoRoot: g === '1' ? findRepoRoot() : g }); } catch { /* unavailable: stage skips */ }
  }
  return tools;
}
