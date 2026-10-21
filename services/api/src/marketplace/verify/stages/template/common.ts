// Shared helpers for the template stages. Every stage is a pure function of (package bytes, injected tools): no globals,
// no env reads, no filesystem access of its own; process spawning lives in ../../tools/*.
import type { UnpackedPackage } from '../../../types.ts';
import type { StageOutput } from '../../types.ts';

export type Format = 'docx' | 'pptx' | 'xlsx' | 'pdf';
export const FORMATS: readonly string[] = ['docx', 'pptx', 'xlsx', 'pdf'];
export interface TemplateFile { format: Format; file: string; bytes: Uint8Array; previews: string[] }

/** The payload as the manifest declares it, or undefined when the shape is wrong (stage `manifest` reports that). */
export function templateFile(pkg: UnpackedPackage): TemplateFile | undefined {
  const p = pkg.manifest?.payload as Record<string, unknown> | undefined;
  if (!p || typeof p.format !== 'string' || !FORMATS.includes(p.format) || typeof p.file !== 'string') return undefined;
  const bytes = pkg.files.get(p.file);
  if (!bytes) return undefined;
  const previews = Array.isArray(p.previews) ? p.previews.filter((x): x is string => typeof x === 'string') : [];
  return { format: p.format as Format, file: p.file, bytes, previews };
}

export const skipped = (reason: string, extra: Partial<StageOutput> = {}): StageOutput => ({ status: 'skipped', reason, evidence: [], ...extra });
export const notApplicable = (fmt: string): StageOutput => ({ status: 'skipped', reason: `not-applicable:${fmt}`, required: false, evidence: [] });
export const noFile = (): StageOutput => skipped('no-template-file: the manifest payload does not name a file in the package');
export const failWith = (reason: string, evidence: StageOutput['evidence'] = []): StageOutput => ({ status: 'fail', reason, evidence });

/** A tool call that threw: a timeout is `fail: timeout` (the tool was invoked), anything else `fail: tool-error`. Never a pass, never a skip. */
export function toolFailure(e: unknown): StageOutput {
  const m = e instanceof Error ? e.message : String(e);
  if (/^timeout\b/i.test(m)) return failWith('timeout', [{ kind: 'check', label: 'tool timed out', detail: m.slice(0, 300) }]);
  return failWith(`tool-error: ${m.slice(0, 300)}`, [{ kind: 'log', label: 'tool error', detail: m.slice(0, 1000) }]);
}

/** The kernel tool reports a missing binary as code 127 + `tool-missing:<bin>`, a timeout as code 124 + `timeout: ...`. */
export const kernelMissing = (r: { code: number; stderr: string }): string | undefined => r.code === 127 && /^tool-missing:/.test(r.stderr) ? r.stderr.trim() : undefined;
export const kernelTimedOut = (r: { code: number; stderr: string }): boolean => r.code === 124 || /^timeout\b/.test(r.stderr);
