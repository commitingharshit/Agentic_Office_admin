/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Hermes runtime really emits for each hook event, for the permission view and the installed item (pure data: no node imports).

export type HookEventStatus = 'direct' | 'derived' | 'approximate' | 'unsupported';
export interface HookEventLine { readonly event: string; readonly hermes: string; readonly status: HookEventStatus; readonly note: string }

/**
 * What the Hermes runtime really emits for each event of the brief (mirrors HOOK_EVENTS in accounts-sync and EVENT_MAP in
 * hermes_cli/marketplace_ext/hook_engine.py; a test compares them). The install plan shows these lines, so an event that is
 * only approximated or derived is never presented as if it were direct, and an unsupported one is never claimed.
 */
export const HOOK_EVENT_STATUS: Readonly<Record<string, { readonly hermes: string; readonly status: HookEventStatus; readonly note: string }>> = {
	session_started: { hermes: 'on_session_start', status: 'direct', note: 'When a new session begins. Injected context is delivered with the first model call of the session.' },
	agent_execution_started: { hermes: 'pre_llm_call', status: 'approximate', note: 'Before every model call, which can be several times per user turn.' },
	before_tool_invocation: { hermes: 'pre_tool_call', status: 'direct', note: 'Before any tool the agent calls.' },
	after_tool_invocation: { hermes: 'post_tool_call', status: 'direct', note: 'After any tool the agent called.' },
	before_document_edit: { hermes: 'pre_tool_call', status: 'derived', note: 'Before the agent calls a document-editing tool. Edits you type into an editor are not seen.' },
	after_document_edit: { hermes: 'post_tool_call', status: 'derived', note: 'After the agent called a document-editing tool. Edits you type into an editor are not seen.' },
	before_export: { hermes: 'pre_tool_call', status: 'derived', note: 'Before the agent calls an export tool.' },
	after_export: { hermes: 'post_tool_call', status: 'derived', note: 'After the agent called an export tool.' },
	verification_completed: { hermes: 'post_tool_call', status: 'derived', note: 'After a verification tool returned without a tool error.' },
	verification_failed: { hermes: 'post_tool_call', status: 'derived', note: 'Only when a verification tool itself errored; a failing verdict from a working verifier is not an event.' },
	session_completed: { hermes: 'on_session_end', status: 'derived', note: 'At the end of each conversation run that completed (once per user turn).' },
	session_failed: { hermes: 'on_session_end', status: 'derived', note: 'At the end of a conversation run that did not complete and was not interrupted.' },
	before_publish: { hermes: '', status: 'unsupported', note: 'Not available: publishing is a server-side pipeline, not an agent event.' },
};

/** Per-event honesty lines for the install plan, from the manifest payload. Unknown events are reported unsupported. */
export function describeHookEvents(payload: unknown): HookEventLine[] {
	const rules = payload && typeof payload === 'object' ? (payload as { rules?: unknown }).rules : undefined;
	if (!Array.isArray(rules)) { return []; }
	const out = new Map<string, HookEventLine>();
	for (const r of rules.slice(0, 20)) {
		const ev = r && typeof r === 'object' ? (r as { event?: unknown }).event : undefined;
		if (typeof ev !== 'string' || out.has(ev)) { continue; }
		const spec = Object.prototype.hasOwnProperty.call(HOOK_EVENT_STATUS, ev) ? HOOK_EVENT_STATUS[ev] : undefined;
		const injects = ev === 'session_started' && (r as { action?: { type?: unknown } }).action?.type === 'inject_context';
		out.set(ev, spec ? { event: ev, hermes: spec.hermes, status: injects ? 'approximate' : spec.status, note: spec.note } : { event: ev.slice(0, 60), hermes: '', status: 'unsupported', note: 'Not an event this runtime emits.' });
	}
	return [...out.values()];
}
