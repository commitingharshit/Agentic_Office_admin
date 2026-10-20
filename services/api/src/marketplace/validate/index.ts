import { createHash } from 'node:crypto';
import type { ListingType, UnpackedPackage, ValidationCheck, ValidationReport } from '../types.ts';

export type Validator = (pkg: UnpackedPackage) => Promise<ValidationCheck[]> | ValidationCheck[];

const validators = new Map<ListingType, Validator>();
export function registerValidator(type: ListingType, fn: Validator): void { validators.set(type, fn); }
export function getValidator(type: ListingType): Validator | undefined { return validators.get(type); }

function commonChecks(type: ListingType, pkg: UnpackedPackage): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const typeOk = pkg.manifest.type === type;
  checks.push({ name: 'manifest-type-matches', ok: typeOk, ...(typeOk ? {} : { detail: `manifest type ${pkg.manifest.type} != ${type}` }) });

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
  if (!v) checks.push({ name: 'type-supported', ok: false, detail: `no validator for type ${type}` });
  else checks.push(...await v(pkg));
  return { ok: checks.every(c => c.ok), checks };
}
