// Pipeline registry: one VerificationPipeline per listing type.
//
// ONBOARDING A NEW EXTENSION TYPE (Plans 2 and 3), the checklist:
//   1. Register a validator in ../validate (registerValidator). The conformance test then FAILS until step 2 is done.
//   2. registerPipeline({ type, name, version, stages }) whose FIRST stage is `manifest` (use fromValidationReport
//      over validateArtifact for the checks the validator already owns); at least one stage `required`; every
//      non-pass result carries a `reason`; give each stage a timeoutMs; use `after` to skip stages that depend on others.
//   3. Install the adapter: map the tools the stages need onto PipelineTools (verify/tools.ts) so absence => skipped.
//   4. Add the type's acceptance flow to scripts/dev/marketplace-acceptance.sh.
//   5. The truth-table row flips automatically (it reads listPipelines()).
// Direction of imports: verify/* may import validate/*; validate/* must never import verify/*.
import { LISTING_TYPES, type ListingType } from '../types.ts';
import { MAX_REASON, type PipelineDef, type StageResult } from './types.ts';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FORBIDDEN_KEYS = new Set(['score', 'confidence', 'grade', 'rating', 'percent']);

export class PipelineContractError extends Error { constructor(msg: string) { super(msg); this.name = 'PipelineContractError'; } }

/** Throws if any object at any depth has a key named score/confidence/grade/rating/percent. */
export function assertNoScoreKeys(value: unknown, path = '$', depth = 0): void {
  if (depth > 64) throw new PipelineContractError(`result nested too deeply at ${path}`);
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoScoreKeys(v, `${path}[${i}]`, depth + 1)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) throw new PipelineContractError(`forbidden key "${k}" at ${path}: results are pass|fail|skipped with evidence, never a score`);
      assertNoScoreKeys(v, `${path}.${k}`, depth + 1);
    }
  }
}

export function assertPipelineContract(def: PipelineDef): void {
  const err = (m: string): never => { throw new PipelineContractError(`pipeline ${def.name || def.type}: ${m}`); };
  if (!(LISTING_TYPES as readonly string[]).includes(def.type)) err(`unknown listing type ${String(def.type)}`);
  if (!def.name || !KEBAB.test(def.name)) err('name must be kebab-case');
  if (!Number.isInteger(def.version) || def.version < 1) err('version must be a positive integer');
  if (!Array.isArray(def.stages) || def.stages.length === 0) err('no stages');
  const seen = new Set<string>();
  for (const s of def.stages) {
    if (!KEBAB.test(s.id)) err(`stage id ${JSON.stringify(s.id)} is not kebab-case`);
    if (seen.has(s.id)) err(`duplicate stage id ${s.id}`);
    if (!Number.isFinite(s.timeoutMs) || s.timeoutMs <= 0) err(`stage ${s.id} needs a positive timeoutMs`);
    for (const a of s.after ?? []) if (!seen.has(a)) err(`stage ${s.id} depends on ${a}, which is not an earlier stage`);
    seen.add(s.id);
  }
  if (!def.stages.some(s => s.required)) err('at least one stage must be required');
  if (def.stages[0].id !== 'manifest') err('the first stage must be "manifest"');
}

/** Contract for a produced result (used by the runner on every stage and by tests): reasons present, no score keys. */
export function assertStageResult(r: StageResult): void {
  if (r.status !== 'pass' && !(typeof r.reason === 'string' && r.reason.length > 0)) throw new PipelineContractError(`stage ${r.id} is ${r.status} without a reason`);
  if (typeof r.reason === 'string' && r.reason.length > MAX_REASON) throw new PipelineContractError(`stage ${r.id} reason too long`);
  assertNoScoreKeys(r);
}

const pipelines = new Map<ListingType, PipelineDef>();
export function registerPipeline(def: PipelineDef): void {
  assertPipelineContract(def);
  if (pipelines.has(def.type)) throw new PipelineContractError(`a pipeline for type ${def.type} is already registered`);
  pipelines.set(def.type, def);
}
export function getPipeline(type: ListingType): PipelineDef | undefined { return pipelines.get(type); }
export function listPipelines(): PipelineDef[] { return [...pipelines.values()]; }
/** Test seam: removes a registration (never used by production code). */
export function unregisterPipelineForTest(type: ListingType): void { pipelines.delete(type); }
