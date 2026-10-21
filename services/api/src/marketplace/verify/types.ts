// Verification pipeline contracts (marketplace Plan 4). Results are explicit pass | fail | skipped plus evidence:
// there is no score, confidence, grade or percentage anywhere (assertNoScoreKeys enforces it on every result).
import type { ListingType, UnpackedPackage } from '../types.ts';
import type { SkillScanner } from '../validate/skill.ts';

export type StageStatus = 'pass' | 'fail' | 'skipped';
export type EvidenceKind = 'check' | 'text' | 'json' | 'image' | 'log';
export type BlobMime = 'image/png' | 'text/plain' | 'application/json';
export interface Measured { name: string; value: number; threshold: number; op: '>=' | '<=' | '==' }
export interface Evidence {
  kind: EvidenceKind;
  label: string;                 // human text, e.g. "slide 3 render" (untrusted: render as text only)
  detail?: string;               // small inline text (<= 2 KiB), untrusted
  blob?: { sha256: string; mime: BlobMime; size: number };   // content-addressed, untrusted
  measured?: Measured;           // a measurement next to the named threshold it was compared to; never a score
}
export interface StageResult {
  id: string;                    // stable, kebab-case, unique within the pipeline
  title: string;
  required: boolean;             // a skipped required stage makes the verdict 'incomplete'
  status: StageStatus;
  reason?: string;               // REQUIRED when status !== 'pass': a machine code ('tool-missing:officecli') or a sentence
  evidence: Evidence[];
  durationMs: number;
}
/** fail: any stage failed; incomplete: none failed but a required stage skipped; pass: otherwise. */
export type Verdict = 'pass' | 'fail' | 'incomplete';
export interface PipelineResult {
  type: ListingType; pipeline: string; pipelineVersion: number;
  subjectSha256: string;         // the artifact verified
  verdict: Verdict; stages: StageResult[];
  env: Record<string, string>;   // tool versions actually used, for reproducibility
  startedAt: string; finishedAt: string;
}

// The task-eval shapes live with the stage that owns them (stages/skill/taskSchema.ts).
import type { SkillTask, TaskRun } from './stages/skill/taskSchema.ts';
export type { SkillTask, TaskRun };

/** Injected; every member optional so absence yields 'skipped' (tool-missing), not a crash. */
export interface PipelineTools {
  officecli?: { validate(file: Uint8Array, fmt: string): Promise<{ ok: boolean; output: string }>;
                issues(file: Uint8Array, fmt: string, types?: string[]): Promise<{ type: string; message: string; path?: string }[]>;
                renderPages(file: Uint8Array, fmt: string, o: { maxPages: number; width?: number; height?: number; signal?: AbortSignal }): Promise<{ pages: { png: Uint8Array; page: number }[]; totalPages: number }> };
  kernel?: { run(kernel: 'xlsx' | 'docpatch' | 'pptx' | 'pdf', args: string[], file: Uint8Array): Promise<{ code: number; json?: unknown; stderr: string }> };
  visual?: { compare(ref: Uint8Array, rendered: Uint8Array, o: { clip: boolean; dino: boolean }): Promise<{ pixel: Measured; ssim: Measured; clip?: Measured; dino?: Measured }>;
             layout(file: Uint8Array, fmt: string): Promise<{ rule: string; blocking: boolean; slide: number; message: string }[]> };
  scanner?: SkillScanner;
  hermes?: { runTask(skill: UnpackedPackage, task: SkillTask, signal?: AbortSignal): Promise<TaskRun> };
}
export interface EvidenceSink { addBlob(mime: BlobMime, bytes: Uint8Array): Promise<NonNullable<Evidence['blob']>> }
export interface StageContext { pkg: UnpackedPackage; tools: PipelineTools; evidence: EvidenceSink; signal: AbortSignal; previous?: PipelineResult }
/** `required: false` lets a stage lower its own requiredness for a package it does not apply to (e.g. formula-validity on a docx); it can never raise it. */
export type StageOutput = Omit<StageResult, 'id' | 'title' | 'required' | 'durationMs'> & { required?: false };
export interface StageDef {
  id: string; title: string; required: boolean; timeoutMs: number;
  /** Ids of EARLIER stages this one depends on: if any failed or was skipped, this stage is skipped with a reason. */
  after?: string[];
  run(ctx: StageContext): Promise<StageOutput>;
}
export interface PipelineDef { type: ListingType; name: string; version: number; stages: StageDef[] }

export const MAX_EVIDENCE_BLOB_BYTES = 2 * 1024 * 1024;
export const MAX_EVIDENCE_BLOBS_PER_RUN = 40;
export const MAX_EVIDENCE_DETAIL = 2048;
export const MAX_EVIDENCE_PER_STAGE = 50;
export const MAX_LABEL = 256;
export const MAX_REASON = 512;
export const MAX_RESULT_BYTES = 256 * 1024;
