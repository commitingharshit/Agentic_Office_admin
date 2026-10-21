// Shared helpers for the skill pipeline stages. The package is untrusted: every read is bounded.
import type { UnpackedPackage } from '../../../types.ts';
import type { StageOutput } from '../../types.ts';

/** Bounds on what the static stages will look at; over them the tree is refused up front (a stage never walks an unbounded tree). */
export const MAX_FILES = 2000;
export const MAX_TREE_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT_READ = 512 * 1024;

export function treeProblem(pkg: UnpackedPackage): string | undefined {
  let total = 0;
  if (pkg.files.size > MAX_FILES) return `${pkg.files.size} files (limit ${MAX_FILES})`;
  for (const b of pkg.files.values()) { total += b.byteLength; if (total > MAX_TREE_BYTES) return `more than ${MAX_TREE_BYTES} bytes unpacked`; }
  return undefined;
}
export const tooLarge = (why: string): StageOutput => ({ status: 'fail', reason: `tree-too-large: ${why}`, evidence: [{ kind: 'check', label: 'tree too large', detail: why }] });

/** Lossy decode of at most MAX_TEXT_READ bytes. Never throws. */
export function text(b: Uint8Array): string { return new TextDecoder('utf-8').decode(b.byteLength > MAX_TEXT_READ ? b.subarray(0, MAX_TEXT_READ) : b); }

export function skillPayload(pkg: UnpackedPackage): { entry: string; dir: string; name: string | undefined } {
  const p = (pkg.manifest.payload ?? {}) as Record<string, unknown>;
  const entry = typeof p.entry === 'string' && p.entry ? p.entry : 'SKILL.md';
  const i = entry.lastIndexOf('/');
  return { entry, dir: i < 0 ? '' : entry.slice(0, i), name: typeof p.name === 'string' ? p.name : undefined };
}
