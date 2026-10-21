import { createHash } from 'node:crypto';
import { parseManifest, pathProblem } from '../manifest.ts';
import { createTemplateValidator } from './template.ts';
import { createSkillValidator } from './skill.ts';
import { createHookValidator } from './hook.ts';
import { createRoutineValidator } from './routine.ts';
import { createMemoryValidator } from './memory.ts';
import { createBridgeValidator } from './bridge.ts';
import { createConnectorValidator } from './connector.ts';
import { createWorkflowValidator } from './workflow.ts';
import { parseRiskTier } from './advanced-common.ts';
import { TYPE_POLICY, maxTier } from '../support.ts';
import type { ListingType, UnpackedPackage, ValidationCheck, ValidationReport } from '../types.ts';

export type Validator = (pkg: UnpackedPackage) => Promise<ValidationCheck[]> | ValidationCheck[];

const validators = new Map<ListingType, Validator>();
export function registerValidator(type: ListingType, fn: Validator): void { validators.set(type, fn); }
export function getValidator(type: ListingType): Validator | undefined { return validators.get(type); }

function commonChecks(type: ListingType, pkg: UnpackedPackage): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const typeOk = pkg.manifest.type === type;
  checks.push({ name: 'manifest-type-matches', ok: typeOk, ...(typeOk ? {} : { detail: `manifest type ${pkg.manifest.type} != ${type}` }) });

  // pkg.manifest is untrusted: re-validate it rather than assume Task 3's unpacker did.
  let manifestOk = true;
  try { parseManifest(structuredClone(pkg.manifest)); checks.push({ name: 'manifest-valid', ok: true }); }
  catch (e) { manifestOk = false; checks.push({ name: 'manifest-valid', ok: false, detail: (e as Error).message }); }

  const badPaths: string[] = [];
  for (const k of pkg.files.keys()) { const pr = pathProblem(k); if (pr) badPaths.push(`${JSON.stringify(k)}: ${pr}`); }
  checks.push({ name: 'file-paths-safe', ok: badPaths.length === 0, ...(badPaths.length ? { detail: badPaths.join('; ') } : {}) });

  if (!manifestOk) {
    checks.push({ name: 'files-match-hashes', ok: false, detail: 'manifest is invalid' });
    return checks;
  }
  const problems: string[] = [];
  const declared = new Set<string>();
  for (const f of pkg.manifest.files) {
    declared.add(f.path);
    const bytes = pkg.files.get(f.path);
    if (!bytes) { problems.push(`missing file ${f.path}`); continue; }
    const h = createHash('sha256').update(bytes).digest('hex');
    if (h !== f.sha256) problems.push(`hash mismatch for ${f.path}`);
    else if (bytes.length !== f.size) problems.push(`size mismatch for ${f.path}`);
  }
  for (const p of pkg.files.keys()) if (!declared.has(p)) problems.push(`undeclared file ${p}`);
  checks.push({ name: 'files-match-hashes', ok: problems.length === 0, ...(problems.length ? { detail: problems.join('; ') } : {}) });
  return checks;
}

export async function validateArtifact(type: ListingType, pkg: UnpackedPackage): Promise<ValidationReport> {
  const checks = commonChecks(type, pkg);
  const v = validators.get(type);
  // Type validators only ever see a manifest that passed manifest-valid.
  if (checks.some(c => c.name === 'manifest-valid' && !c.ok)) return { ok: false, verified: false, checks };
  if (!v) checks.push({ name: 'type-supported', ok: false, detail: `no validator for type ${type}` });
  else {
    try { checks.push(...((await v(pkg)) ?? [])); }
    catch (e) { checks.push({ name: 'validator-error', ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  }
  const ok = checks.every(c => c.ok);
  // the tier is the payload's own claim, never below the type's policy floor; an unreadable claim on an elevated type is the highest tier
  const floor = TYPE_POLICY[type]?.riskTier ?? 'executable';
  const riskTier = maxTier(floor, parseRiskTier(checks) ?? floor);
  return { ok, verified: ok && !checks.some(c => c.skipped && c.required), checks, riskTier };
}

// template.ts must not import this module (no cycle); the registry wires it here. officecli is injected, none by default.
registerValidator('template', createTemplateValidator());
// skill: the security scan is injected (createSkillsGuardScanner) and REQUIRED; none by default, so reports stay unverified.
registerValidator('skill', createSkillValidator());
// Advanced types (Plan 3): placeholders that answer type-supported:false until each type's own task replaces its file.
registerValidator('hook', createHookValidator());
registerValidator('routine', createRoutineValidator());
registerValidator('memory', createMemoryValidator());
registerValidator('bridge', createBridgeValidator());
registerValidator('connector', createConnectorValidator());
registerValidator('workflow', createWorkflowValidator());
