// Hook validator (type 'hook'), DECLARATIVE mode only (Plan 3 Task 6). A hook package carries rules as data; the Hermes
// engine (hermes_cli/marketplace_ext/hook_engine.py) evaluates them in-process. There is no code, no regex and no schedule
// anywhere in a package: every one of those is rejected here. Script hooks are Task 10 and stay unsupported.
//
// Everything in the payload is attacker-controlled: bounded walks (iterative), no backtracking pattern engine, every
// check runs (so a reviewer sees all problems at once), details never echo a long or secret-looking value.
import { checkBounded, checkNoLiteralSecrets, riskTierCheck } from './advanced-common.ts';
import type { Validator } from './index.ts';
import type { PermissionRequest, UnpackedPackage, ValidationCheck } from '../types.ts';

export const MAX_RULES = 20;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_INJECT_BYTES = 2048;
export const MAX_BLOCK_MESSAGE = 200;
export const MAX_GLOB = 80;
export const MAX_ARG_CONDITIONS = 4;
export const MIN_ARG_VALUE = 3;

export type EventStatus = 'direct' | 'derived' | 'approximate' | 'unsupported';
export interface HookEventSpec {
  /** The Hermes plugin hook that carries it ('' when there is none). */
  hermes: string;
  status: EventStatus;
  /** What the event means in practice; shown to the user in the install plan and the review summary. */
  note: string;
  blockable: boolean;
  injectable: boolean;
  /** Rules on this event may carry a `when` clause (tool glob and argument conditions). */
  toolEvent: boolean;
}

/**
 * The brief's events and what the Hermes runtime really emits (decided from VALID_HOOKS and the invoke_hook call sites).
 * Mirrored by EVENT_MAP in vendor/hermes-agent/hermes_cli/marketplace_ext/hook_engine.py; test/marketplace-hook-validate.test.ts
 * compares the two. An event that is not here, or is `unsupported`, is rejected: the runtime never claims an event it does not emit.
 */
export const HOOK_EVENTS: Readonly<Record<string, HookEventSpec>> = Object.freeze({
  session_started: { hermes: 'on_session_start', status: 'direct', blockable: false, injectable: true, toolEvent: false,
    note: 'Fires when a new session begins. Hermes ignores what this hook returns, so injected context is delivered with the session\'s first model call instead (approximate).' },
  agent_execution_started: { hermes: 'pre_llm_call', status: 'approximate', blockable: false, injectable: true, toolEvent: false,
    note: 'Fires before every model call, which can be several times per user turn (not once per turn).' },
  before_tool_invocation: { hermes: 'pre_tool_call', status: 'direct', blockable: true, injectable: false, toolEvent: true,
    note: 'Fires before any tool the agent calls.' },
  after_tool_invocation: { hermes: 'post_tool_call', status: 'direct', blockable: false, injectable: false, toolEvent: true,
    note: 'Fires after any tool the agent called.' },
  before_document_edit: { hermes: 'pre_tool_call', status: 'derived', blockable: true, injectable: false, toolEvent: true,
    note: 'Derived: fires before the agent calls a document-editing tool (docx, xlsx, pptx, pdf, office, collab). It does not see edits the user types into an editor.' },
  after_document_edit: { hermes: 'post_tool_call', status: 'derived', blockable: false, injectable: false, toolEvent: true,
    note: 'Derived: fires after the agent called a document-editing tool. It does not see edits the user types into an editor.' },
  before_export: { hermes: 'pre_tool_call', status: 'derived', blockable: true, injectable: false, toolEvent: true,
    note: 'Derived: fires before the agent calls an export tool (found by name in the tool taxonomy).' },
  after_export: { hermes: 'post_tool_call', status: 'derived', blockable: false, injectable: false, toolEvent: true,
    note: 'Derived: fires after the agent called an export tool.' },
  verification_completed: { hermes: 'post_tool_call', status: 'derived', blockable: false, injectable: false, toolEvent: true,
    note: 'Derived: fires after a verification tool returned without a tool error. A verifier that returns a failing verdict still counts as completed.' },
  verification_failed: { hermes: 'post_tool_call', status: 'derived', blockable: false, injectable: false, toolEvent: true,
    note: 'Derived, tool errors only: fires when a verification tool itself errored or was blocked. A failing verdict from a working verifier is not an event.' },
  session_completed: { hermes: 'on_session_end', status: 'derived', blockable: false, injectable: false, toolEvent: false,
    note: 'Derived: fires at the end of each conversation run that completed (once per user turn, not once per session).' },
  session_failed: { hermes: 'on_session_end', status: 'derived', blockable: false, injectable: false, toolEvent: false,
    note: 'Derived: fires at the end of a conversation run that did not complete and was not interrupted.' },
  before_publish: { hermes: '', status: 'unsupported', blockable: false, injectable: false, toolEvent: false,
    note: 'Not available: publishing is a server-side pipeline, not an agent event. Path: server webhooks.' },
});

const ok = (name: string, detail?: string): ValidationCheck => ({ name, ok: true, ...(detail ? { detail } : {}) });
const bad = (name: string, problems: string[]): ValidationCheck => problems.length === 0 ? ok(name) : { name, ok: false, detail: problems.slice(0, 8).join('; ') + (problems.length > 8 ? `; ... and ${problems.length - 8} more` : '') };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const q = (s: string) => JSON.stringify(s.length > 60 ? s.slice(0, 60) + '...' : s);

// ---------------------------------------------------------------- text scan

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯︀-️﻿]/g;
const normalise = (s: string) => s.normalize('NFKC').replace(INVISIBLE, '').toLowerCase();
const SENSITIVE_PATHS = ['~/', '/etc/', '/users/', '/home/', '/var/', '/root', 'c:\\', '$home', '%userprofile%', '.ssh', 'id_rsa', 'id_ed25519', '.aws', '.gnupg', '.hermes', '.env', '.netrc', 'authorized_keys'];
const SECRET_WORDS = new Set(['secret', 'secrets', 'password', 'passwords', 'passwd', 'credential', 'credentials', 'apikey', 'api_key', 'token', 'tokens', 'cookie', 'cookies', 'keychain']);
const SECRET_PHRASES = ['api key', 'access key', 'private key', 'ssh key'];
const EXFIL_VERBS = new Set(['send', 'upload', 'post', 'email', 'forward', 'exfiltrate', 'leak', 'transmit', 'copy', 'read', 'cat', 'print', 'reveal', 'dump', 'output', 'include', 'share', 'show', 'fetch', 'curl', 'wget', 'paste', 'write', 'save', 'store']);
const OVERRIDE_PHRASES = ['ignore previous', 'ignore all previous', 'ignore the above', 'ignore prior', 'ignore your', 'disregard', 'forget your instructions', 'forget previous', 'override your', 'system prompt', 'you are now', 'new instructions', 'do not tell the user', 'do not mention', 'without telling', 'developer message', 'jailbreak', 'act as'];
const URL_MARKERS = ['http://', 'https://', 'ftp://', 'file://', 'ws://', 'wss://', 'data:', 'javascript:', 'www.'];
const SHELL_MARKERS = ['`', '$(', '&&', '||', '; rm ', 'sudo ', 'chmod ', '/bin/', 'powershell'];

/** A deterministic, linear-time text scan for hook text that reaches the model (inject text and block messages). Returns the reason, or null when clean. */
export function scanHookText(text: unknown, cap: number): string | null {
  if (typeof text !== 'string' || text.trim() === '') return 'is empty or not text';
  if (new TextEncoder().encode(text).length > cap) return `is longer than ${cap} bytes`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return 'contains control characters';
  const t = normalise(text);
  if (t.includes('<') && (t.includes('extension-context') || t.includes('</'))) return 'contains markup that imitates the extension-context wrapper';
  for (const m of URL_MARKERS) if (t.includes(m)) return 'contains a URL or link (hook text may not point anywhere)';
  for (const s of SHELL_MARKERS) if (t.includes(s)) return 'contains shell syntax';
  for (const p of SENSITIVE_PATHS) if (t.includes(p)) return 'refers to credential or system files';
  const words = t.split(/[^a-z0-9_]+/).filter(Boolean);
  const spaced = ` ${words.join(' ')} `;
  for (const p of OVERRIDE_PHRASES) if (spaced.includes(` ${p} `)) return 'tries to override the agent\'s instructions';
  const secret = words.some((w) => SECRET_WORDS.has(w)) || SECRET_PHRASES.some((p) => spaced.includes(` ${p} `));
  if (secret && words.some((w) => EXFIL_VERBS.has(w))) return 'instructs the agent to handle secrets or credentials';
  return null;
}

// ---------------------------------------------------------------- glob and names

const GLOB_CHARS = /^[A-Za-z0-9_.:*?-]+$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const REGEX_META = /[()+^$|{}\\[\]]/;
const REGEX_KEYS = new Set(['regex', 'regexp', 'pattern', 'match']);
const SCHEDULE_KEYS = new Set(['schedule', 'cron', 'interval', 'every']);

/** Why a tool glob is unacceptable for a hook, or null. Only `*` and `?` are wildcards; there is no regex and no character class. */
export function globProblem(g: string): { reason: string; regex: boolean } | null {
  if (typeof g !== 'string' || g === '') return { reason: 'is empty', regex: false };
  if (g.length > MAX_GLOB) return { reason: `is longer than ${MAX_GLOB} characters`, regex: false };
  if (REGEX_META.test(g)) return { reason: 'contains regex or character-class syntax (only * and ? are wildcards)', regex: true };
  if (!GLOB_CHARS.test(g)) return { reason: 'contains characters other than letters, digits, _ . : - * ?', regex: false };
  const wild = [...g].filter((c) => c === '*' || c === '?').length;
  if (wild > 4) return { reason: 'has more than 4 wildcards', regex: false };
  const literal = g.replace(/[*?]/g, '');
  const rest = literal.startsWith('mcp_') ? literal.slice(4) : literal;
  if (rest.replace(/_/g, '').length < 3) return { reason: 'is too broad (it would match nearly every tool; name the tools it targets)', regex: false };
  return null;
}

// ---------------------------------------------------------------- key walk

function* keysOf(root: unknown, maxNodes = 4000): Generator<{ key: string; path: string }> {
  const stack: Array<{ v: unknown; p: string }> = [{ v: root, p: '$' }];
  let n = 0;
  while (stack.length && n++ < maxNodes) {
    const { v, p } = stack.pop()!;
    if (Array.isArray(v)) { v.forEach((x, i) => stack.push({ v: x, p: `${p}[${i}]` })); continue; }
    if (!isObj(v)) continue;
    for (const k of Object.keys(v)) {
      const seg = k.length <= 24 ? k : '<key>';
      yield { key: k, path: `${p}.${seg}` };
      stack.push({ v: v[k], p: `${p}.${seg}` });
    }
  }
}

// ---------------------------------------------------------------- the validator

const RULE_KEYS = new Set(['id', 'event', 'when', 'action']);
const WHEN_KEYS = new Set(['tool', 'arg_contains', 'arg_equals']);
const ALLOWED_FILES: readonly RegExp[] = [/^README\.md$/, /^LICENSE(?:\.md|\.txt)?$/, /^docs\/[A-Za-z0-9._-]{1,80}\.(?:md|txt)$/];
const SCRIPT_EXT = /\.(?:sh|bash|zsh|fish|py|pyw|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|dll|so|dylib|jar|wasm)$/i;

interface ParsedRule { index: number; id: string; event: string; spec: HookEventSpec; glob?: string; actionType: string }

/** The `tool.invoke` permission scope a rule needs: its tool glob, or `event:<name>` when it has none. */
export function requiredScope(r: { event: string; glob?: string }): string { return r.glob ?? `event:${r.event}`; }

export function createHookValidator(): Validator {
  return (pkg: UnpackedPackage): ValidationCheck[] => {
    const checks: ValidationCheck[] = [];
    const payload = pkg.manifest.payload as unknown;

    const bounded = checkBounded(payload, { maxBytes: MAX_PAYLOAD_BYTES, maxDepth: 8, maxKeys: 800 });
    checks.push(bounded);
    if (!bounded.ok) { checks.push(riskTierCheck('declarative')); return checks; }

    // schedule / regex keys anywhere in the payload (never legitimate here)
    const sched: string[] = [], rx: string[] = [];
    for (const { key, path } of keysOf(payload)) {
      if (SCHEDULE_KEYS.has(key.toLowerCase())) sched.push(`${path}: hooks are event-driven; schedules are routines`);
      if (REGEX_KEYS.has(key.toLowerCase())) rx.push(`${path}: regular expressions are not accepted anywhere in a hook`);
    }

    // shape
    const shape: string[] = [];
    let rules: unknown[] = [];
    if (!isObj(payload)) shape.push('payload must be an object');
    else {
      if (payload.kind === 'script') shape.push('payload.kind: script hooks are not available yet (they need the OS sandbox of a later release); use kind "declarative"');
      else if (payload.kind !== 'declarative') shape.push('payload.kind must be "declarative"');
      for (const k of Object.keys(payload)) if (k !== 'kind' && k !== 'rules') shape.push(`payload.${k.length <= 24 ? k : '<key>'}: unknown key`);
      if (!Array.isArray(payload.rules)) shape.push('payload.rules must be an array');
      else {
        rules = payload.rules;
        if (rules.length === 0) shape.push('payload.rules is empty');
        if (rules.length > MAX_RULES) shape.push(`payload.rules has ${rules.length} rules; the limit is ${MAX_RULES}`);
      }
    }
    checks.push(bad('rules-shape', shape));
    checks.push(bad('no-schedule', sched));

    const eventProblems: string[] = [], blockProblems: string[] = [], textProblems: string[] = [], condProblems: string[] = [], regexProblems: string[] = [...rx];
    const parsed: ParsedRule[] = [];
    const seenIds = new Set<string>();
    rules.slice(0, MAX_RULES).forEach((raw, i) => {
      const at = `rules[${i}]`;
      if (!isObj(raw)) { condProblems.push(`${at}: must be an object`); return; }
      for (const k of Object.keys(raw)) if (!RULE_KEYS.has(k)) condProblems.push(`${at}.${k.length <= 24 ? k : '<key>'}: unknown key`);
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (!RULE_ID.test(id)) condProblems.push(`${at}.id: must match ${RULE_ID.source}`);
      else if (seenIds.has(id)) condProblems.push(`${at}.id: duplicate rule id`);
      else seenIds.add(id);

      const ev = raw.event;
      if (typeof ev !== 'string') { eventProblems.push(`${at}.event: must be a single event name (a list or other value is not accepted)`); return; }
      const spec = Object.prototype.hasOwnProperty.call(HOOK_EVENTS, ev) ? HOOK_EVENTS[ev] : undefined;
      if (!spec) { eventProblems.push(`${at}.event: ${q(ev)} is not an event the runtime emits (known: ${Object.keys(HOOK_EVENTS).filter((e) => HOOK_EVENTS[e].status !== 'unsupported').join(', ')})`); return; }
      if (spec.status === 'unsupported') { eventProblems.push(`${at}.event: ${ev} is not supported. ${spec.note}`); return; }

      const act = raw.action;
      let actionType = '';
      if (!isObj(act)) condProblems.push(`${at}.action: must be an object`);
      else {
        actionType = typeof act.type === 'string' ? act.type : '';
        const allowedKeys = actionType === 'block' ? ['type', 'message'] : actionType === 'inject_context' ? ['type', 'text'] : actionType === 'log' ? ['type'] : [];
        if (!['block', 'inject_context', 'log'].includes(actionType)) condProblems.push(`${at}.action.type: ${q(String(act.type))} is not an action (block, inject_context or log; hooks run no code)`);
        else {
          for (const k of Object.keys(act)) if (!allowedKeys.includes(k)) condProblems.push(`${at}.action.${k.length <= 24 ? k : '<key>'}: unknown key for ${actionType}`);
          if (actionType === 'block') {
            if (!spec.blockable) condProblems.push(`${at}.action: block is only allowed on before_* events (${ev} cannot veto anything)`);
            const why = scanHookText(act.message, MAX_BLOCK_MESSAGE);
            if (why) textProblems.push(`${at}.action.message ${why}`);
          } else if (actionType === 'inject_context') {
            if (!spec.injectable) condProblems.push(`${at}.action: inject_context is only allowed on session_started and agent_execution_started`);
            const why = scanHookText(act.text, MAX_INJECT_BYTES);
            if (why) textProblems.push(`${at}.action.text ${why}`);
          }
        }
      }

      let glob: string | undefined, hasArgCond = false;
      if (raw.when !== undefined) {
        if (!spec.toolEvent) condProblems.push(`${at}.when: ${ev} is not a tool event, so it takes no conditions`);
        if (!isObj(raw.when)) condProblems.push(`${at}.when: must be an object`);
        else {
          for (const k of Object.keys(raw.when)) if (!WHEN_KEYS.has(k)) condProblems.push(`${at}.when.${k.length <= 24 ? k : '<key>'}: unknown condition key`);
          if (raw.when.tool !== undefined) {
            if (typeof raw.when.tool !== 'string') condProblems.push(`${at}.when.tool: must be a string`);
            else {
              const gp = globProblem(raw.when.tool);
              if (gp) (gp.regex ? regexProblems : blockProblems).push(`${at}.when.tool ${gp.reason}`);
              else glob = raw.when.tool;
            }
          }
          for (const kind of ['arg_contains', 'arg_equals'] as const) {
            const c = raw.when[kind];
            if (c === undefined) continue;
            if (!isObj(c)) { condProblems.push(`${at}.when.${kind}: must be an object of argument name to string`); continue; }
            const names = Object.keys(c);
            if (names.length === 0 || names.length > MAX_ARG_CONDITIONS) condProblems.push(`${at}.when.${kind}: needs 1 to ${MAX_ARG_CONDITIONS} entries`);
            for (const n of names.slice(0, MAX_ARG_CONDITIONS + 1)) {
              if (!ARG_NAME.test(n)) { condProblems.push(`${at}.when.${kind}: ${q(n)} is not a top-level argument name (nested paths are not supported)`); continue; }
              const val = c[n];
              if (typeof val !== 'string' || val.length < MIN_ARG_VALUE || val.length > 200) { condProblems.push(`${at}.when.${kind}.${n}: must be a string of ${MIN_ARG_VALUE} to 200 characters`); continue; }
              // eslint-disable-next-line no-control-regex
              if (/[\u0000-\u001F\u007F]/.test(val)) { condProblems.push(`${at}.when.${kind}.${n}: contains control characters`); continue; }
              hasArgCond = true;
            }
          }
        }
      }
      if (actionType === 'block' && !glob && !hasArgCond) blockProblems.push(`${at}: a block rule needs a tool glob or an argument condition (a hook must not be able to deny the whole agent)`);
      parsed.push({ index: i, id, event: ev, spec, glob, actionType });
    });

    checks.push(bad('events-mapped', eventProblems));
    checks.push(bad('block-needs-matcher', blockProblems));
    checks.push(bad('no-regex', regexProblems));
    checks.push(bad('rule-conditions', condProblems));
    checks.push(bad('inject-text-scan', textProblems));
    checks.push(checkNoLiteralSecrets(payload, new Set()));

    // The honest event map, as the user reads it in the install plan (informational; always ok).
    if (parsed.length) {
      const seen = new Map<string, string>();
      for (const r of parsed) {
        const inject = r.event === 'session_started' && r.actionType === 'inject_context';
        seen.set(r.event, `${r.event} -> ${r.spec.hermes} [${inject ? 'approximate' : r.spec.status}]: ${inject ? 'context is delivered with the first model call of the session, because Hermes ignores what on_session_start returns' : r.spec.note}`);
      }
      checks.push(ok('event-mapping', [...seen.values()].join(' | ')));
    }

    // Permissions: tool.invoke scoped to the globs/events used, nothing else (no network, no exec.script, no files).
    const permProblems: string[] = [];
    const need = new Set(parsed.map((r) => requiredScope(r)));
    const declared = new Set<string>();
    for (const p of pkg.manifest.permissions as readonly PermissionRequest[]) {
      if (p.capability !== 'tool.invoke') { permProblems.push(`${p.capability}: a declarative hook may only declare tool.invoke (it has no network, scripts, files or secrets)`); continue; }
      if (typeof p.scope !== 'string' || p.scope.trim() === '' || /^[*?]+$/.test(p.scope)) { permProblems.push('tool.invoke: scope must name the tools or event (no bare wildcard)'); continue; }
      declared.add(p.scope);
    }
    for (const s of need) if (!declared.has(s)) permProblems.push(`undeclared: the rules need tool.invoke on ${q(s)}`);
    for (const s of declared) if (!need.has(s)) permProblems.push(`declared but not used: tool.invoke on ${q(s)}`);
    checks.push(bad('permissions-minimal', permProblems));

    // Files: docs only. A script makes the package executable, which belongs to a later task and is refused here.
    const fileProblems: string[] = [];
    let scripts = 0;
    for (const [path, bytes] of pkg.files) {
      const isScript = SCRIPT_EXT.test(path) || path.startsWith('hooks/') || (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) || (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45);
      if (isScript) { scripts++; fileProblems.push(`${q(path)}: executable files are not accepted in a declarative hook (script hooks are not available yet)`); }
      else if (!ALLOWED_FILES.some((re) => re.test(path))) fileProblems.push(`${q(path)}: only README, LICENSE and docs/*.md are allowed`);
    }
    checks.push(bad('no-files', fileProblems));

    checks.push(riskTierCheck(scripts > 0 ? 'executable' : 'declarative'));
    return checks;
  };
}
