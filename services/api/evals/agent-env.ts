// Shared environment of the blueprint and bundle evals: the real Python compiler bridge and the real Skills Guard persona scanner
// when the vendored Hermes virtualenv exists, a fake caller-scoped catalog, skill rows backed by real (tiny) skill trees.
// Cases that can only be caught with Python are marked `needsPython`; without it they are SKIPPED, never passed.
import { existsSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { memoryArtifactStore, sha256Hex } from '../src/marketplace/artifacts.ts';
import { createAgentBridge } from '../src/marketplace/agents.ts';
import type { Bridge } from '../src/marketplace/blueprint/pyBridge.ts';
import type { CatalogView, ResolvedRef } from '../src/marketplace/blueprint/catalogView.ts';
import { satisfies } from '../src/marketplace/manifest.ts';
import { createSkillsGuardScanner, findRepoRoot } from '../src/marketplace/validate/skillsGuard.ts';
import type { SkillScanner } from '../src/marketplace/validate/skill.ts';

const VENV = process.env.HERMES_PYTHON ?? '/Users/harshitverma/Desktop/Agentic_Office_ultra/vendor/hermes-agent/venv/bin/python';
export const store = memoryArtifactStore();

export interface PyEnv { bridge: Bridge; scanner: SkillScanner }
export function pythonEnv(): PyEnv | undefined {
  try { findRepoRoot(); } catch { return undefined; }
  if (!existsSync(VENV)) return undefined;
  return { bridge: createAgentBridge({ python: VENV, store }), scanner: createSkillsGuardScanner({ python: VENV }) };
}

/** A published skill row whose pinned tree is in the shared store, so the real dry run can load it. */
export async function skillRow(id: string, o: Partial<ResolvedRef> = {}): Promise<ResolvedRef> {
  const slug = id.split('/')[1];
  const bytes = zipSync({ 'SKILL.md': strToU8(`---\nname: ${slug}\ndescription: A fixture skill.\n---\n\n# ${slug}\n`) });
  const sha = sha256Hex(bytes);
  await store.put(sha, bytes);
  return { id, range: '^1.0.0', version: '1.2.0', versionId: 'v-' + id, sha256: sha, type: 'skill', visibility: 'public', teamId: null,
    state: 'published', scanVerdict: 'clean', permissions: [], dependencies: [], skillName: slug, ...o };
}

/** A fake caller-scoped view: a row in `hidden` models RLS (not_visible), a version that does not satisfy the range is unsatisfiable. */
export function catalog(rows: ResolvedRef[], hidden: string[] = []): CatalogView {
  return { async resolve(ref) {
    const r = rows.find((x) => x.id === ref.id);
    if (!r) return { error: 'not_found' };
    if (hidden.includes(r.id)) return { error: 'not_visible' };
    if (!satisfies(r.version, ref.range)) return { error: 'unsatisfiable' };
    return r;
  } };
}
