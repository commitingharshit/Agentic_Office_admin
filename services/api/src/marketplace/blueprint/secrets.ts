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

/** Flattens every string of a parsed blueprint to `path -> text`, iteratively. */
export function blueprintTexts(bp: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const stack: Array<{ v: unknown; p: string }> = [{ v: bp, p: 'blueprint' }];
  while (stack.length && out.size < 5000) {
    const { v, p } = stack.pop()!;
    if (typeof v === 'string') out.set(p, v);
    else if (Array.isArray(v)) v.forEach((x, i) => stack.push({ v: x, p: `${p}[${i}]` }));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) stack.push({ v: x, p: `${p}.${k}` });
  }
  return out;
}
