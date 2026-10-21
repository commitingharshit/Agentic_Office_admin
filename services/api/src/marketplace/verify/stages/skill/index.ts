// The skill verification pipeline, static stages (Plan 4 Task 4). Task 6 adds `task-evals` here; no placeholder is registered.
import { getPipeline, registerPipeline } from '../../registry.ts';
import type { PipelineDef } from '../../types.ts';
import { permissionsStage } from './permissions.ts';
import { referencesStage } from './references.ts';
import { scanStage } from './scan.ts';
import { manifestStage, specStage } from './spec.ts';
import { toolGroundingStage } from './toolGrounding.ts';
import { triggerProxyStage } from './triggerProxy.ts';

export const SKILL_PIPELINE_NAME = 'skill-static';
export const SKILL_PIPELINE_VERSION = 1;

/** Timeouts are overridable so tests can exercise the deadline without waiting a minute. */
export function createSkillPipeline(o: { scanTimeoutMs?: number; stageTimeoutMs?: number } = {}): PipelineDef {
  const t = o.stageTimeoutMs;
  return {
    type: 'skill', name: SKILL_PIPELINE_NAME, version: SKILL_PIPELINE_VERSION,
    stages: [manifestStage(t), specStage(t), referencesStage(t), scanStage(o.scanTimeoutMs), permissionsStage(t), toolGroundingStage(t), triggerProxyStage(t)],
  };
}

/** Idempotent: registering twice is a no-op, so any entry point (server start, tests) may call it. */
export function registerSkillPipeline(): void { if (!getPipeline('skill')) registerPipeline(createSkillPipeline()); }
