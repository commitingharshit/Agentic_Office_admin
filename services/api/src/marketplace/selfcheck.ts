// Startup self-check of the package scanner: runs the REAL skill validation (registry, injected scanner) on a tiny built-in
// package. A scanner that cannot run (no python3, no vendor/hermes-agent) would otherwise only show up as every upload being
// stored 'rejected'; the server uses this result to refuse uploads with 503 `scanner_unavailable` instead.
import { createHash } from 'node:crypto';
import type { ListingType, UnpackedPackage, ValidationReport } from './types.ts';
import { validateArtifact } from './validate/index.ts';

const enc = (s: string) => new TextEncoder().encode(s);

/** A minimal, clean skill package (the scanner must call it safe). */
export function selfCheckPackage(): UnpackedPackage {
  const files = new Map<string, Uint8Array>([['SKILL.md', enc('---\nname: selfcheck\ndescription: Built-in scanner self-check.\n---\n\n# Self-check\n\nNothing to see.\n')]]);
  return {
    files,
    manifest: {
      schema: 'agentic.marketplace/1', id: 'selfcheck/selfcheck', type: 'skill', version: '1.0.0', title: 'Self-check', summary: 'Scanner self-check.', license: 'MIT',
      compat: { app: '*' }, dependencies: [], permissions: [],
      files: [...files].map(([path, b]) => ({ path, sha256: createHash('sha256').update(b).digest('hex'), size: b.length })),
      payload: { entry: 'SKILL.md', name: 'selfcheck' },
    },
  } as UnpackedPackage;
}

export async function skillScannerSelfCheck(validate: (type: ListingType, pkg: UnpackedPackage) => Promise<ValidationReport> = validateArtifact): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await validate('skill', selfCheckPackage());
    if (r.ok && r.verified) return { ok: true };
    return { ok: false, detail: r.checks.filter((c) => !c.ok || (c.skipped && c.required)).map((c) => `${c.name}: ${c.detail ?? 'failed'}`).join('; ') || 'the report was not verified' };
  } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
}
