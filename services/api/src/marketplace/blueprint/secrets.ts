// Literal-secret scan over the PAYLOAD texts (blueprint strings, SOUL.md). Never over file hashes. Reuses the Plan 3
// scanner so there is one definition of "looks like a credential". The matched value is never echoed.
import { checkNoLiteralSecrets } from '../validate/advanced-common.ts';
import type { BlueprintDiagnostic } from './schema.ts';

export function scanSecrets(texts: Map<string, string>): BlueprintDiagnostic[] {
  const out: BlueprintDiagnostic[] = [];
  for (const [label, text] of texts) {
    if (out.length >= 10) break;
    const c = checkNoLiteralSecrets(text, new Set());
    if (!c.ok) out.push({ path: label, code: 'literal_secret', message: (c.detail ?? 'looks like a credential').replace(/^\$[^:]*:\s*/, '') });
  }
  return out;
}

// A listing id (publisher/slug) in a reference position is validated by the parser and resolved against the catalog; a long
// hyphenated slug such as financial-model-review has Shannon entropy over the secret threshold and would be a false positive.
const REF_ID_PATH = /^blueprint\.(?:skillReferences\[\d+\]|delegationPolicy\.children\[\d+\]|workflowReferences\[\d+\]|hookBindings\[\d+\]\.hook|verificationPolicy\.checks\[\d+\])\.(?:id|ref)$/;
const LISTING_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** Flattens every string of a parsed blueprint to `path -> text`, iteratively. */
export function blueprintTexts(bp: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const stack: Array<{ v: unknown; p: string }> = [{ v: bp, p: 'blueprint' }];
  while (stack.length && out.size < 5000) {
    const { v, p } = stack.pop()!;
    if (typeof v === 'string') { if (!(REF_ID_PATH.test(p) && LISTING_ID.test(v))) out.set(p, v); }
    else if (Array.isArray(v)) v.forEach((x, i) => stack.push({ v: x, p: `${p}[${i}]` }));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) stack.push({ v: x, p: `${p}.${k}` });
  }
  return out;
}
