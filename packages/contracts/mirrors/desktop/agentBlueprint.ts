/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Mirror of services/accounts-sync/src/marketplace/blueprint/schema.ts (types and constants only, no parser: the
// desktop never trusts a blueprint it parsed itself, the Hermes compiler re-validates). Keep in step; the drift test
// (test/common/agentBlueprint.drift.test.ts) and accounts-sync's marketplace-blueprint-schema test both compare the
// exported constants and the AgentBlueprint interface.

export const BLUEPRINT_SCHEMA = 'agentic.agent-blueprint/1' as const;
export const COMPONENT_KEYS = ['modelPolicy', 'skillReferences', 'toolPermissions', 'memoryBinding', 'knowledgeSources',
	'verificationPolicy', 'hookBindings', 'delegationPolicy', 'contextScope', 'schedulingPolicy', 'workflowReferences'] as const;
export type ComponentKey = typeof COMPONENT_KEYS[number];
export const blueprintFileName = 'blueprint.json';
export const SOUL_FILE = 'SOUL.md';
export type Ref = { id: string; range: string };
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface AgentBlueprint {
	schema: typeof BLUEPRINT_SCHEMA;
	identity: { name: string; role: string; description: string; instructionsFile: string };
	objective: { goal: string; successCriteria: string[] };
	executionEnvironments: Array<'desktop' | 'gateway' | 'cron' | 'cloud'>;
	modelPolicy?: { primary: { provider: string; model: string; reasoningEffort?: Effort };
		fallbacks?: Array<{ provider: string; model: string }>; allowProviders?: string[]; localOnly?: boolean; maxCostTier?: 'low' | 'standard' | 'high' };
	skillReferences?: Array<Ref & { required: boolean }>;
	// Task 0 amendment: no 'read-only' mode and no readOnly flag (Hermes has no read-only switch); no approvals 'off'.
	toolPermissions?: { mode: 'ask' | 'auto-edit'; toolsets: string[]; kits: string[]; deny: string[] };
	memoryBinding?: { provider: string; scope: 'agent'; writeApproval: boolean };
	knowledgeSources?: Array<{ name: string; kind: 'workspace' | 'connector' | 'url'; ref: string }>;
	verificationPolicy?: { checks: Array<{ name: string; kind: 'skill' | 'rubric'; ref: string; when: 'before-final' | 'each-edit'; onFail: 'retry' | 'ask' | 'abort'; maxAttempts: number }>; requireEvidence: boolean };
	hookBindings?: Array<{ event: string; hook: Ref }>;
	delegationPolicy?: { maxDepth: number; maxConcurrent: number; childModel?: { provider: string; model: string }; children: Array<Ref & { role: string }> };
	contextScope?: { workspaceAccess: 'none' | 'read' | 'write'; pathGlobs: string[]; includeUserProfile: boolean; maxContextTokens?: number };
	schedulingPolicy?: { triggers: Array<{ kind: 'manual' | 'schedule'; schedule?: string; prompt?: string }> };
	workflowReferences?: Ref[];
}
/** The manifest `payload` of an agent listing: lets search facets be queried without parsing the file. */
export type AgentPayload = { blueprint: 'blueprint.json'; schema: typeof BLUEPRINT_SCHEMA; components: ComponentKey[] };
export type BlueprintDiagnostic = { path: string; code: string; message: string };
