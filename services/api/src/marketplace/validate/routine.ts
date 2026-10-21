// Routine validator (type 'routine', Plan 3 Task 4): an agent-prompt blueprint that Hermes turns into ONE cron job.
// A routine is an unattended agent run with the user's credentials, so the validator is an allow-list, not a deny-list:
// every key must be known, every value is bounded, the schedule can never fire more than once per 15 minutes, delivery is
// local only, the toolset list is REQUIRED and drawn from a fixed safe set, and the prompt text is scanned (a local
// pattern list always, plus the injected Hermes Skills Guard scanner, which is REQUIRED for `verified` exactly as for
// skills). Package content is attacker-controlled: no recursion on its depth, no regex over unbounded input.
// Must not import ./index.ts at runtime (cycle): the registry imports this module and registers createRoutineValidator().
// The Hermes handler (hermes_cli/marketplace_ext/handlers/routine.py) re-checks the same rules at apply time.
import type { PermissionRequest, UnpackedPackage, ValidationCheck } from '../types.ts';
import type { Validator } from './index.ts';
import { checkBounded, checkOnlyFiles, impliedPermissions, riskTierCheck } from './advanced-common.ts';
import type { SkillScanner } from './skill.ts';

export interface RoutineValidatorOptions { scanner?: SkillScanner }

// ---------------------------------------------------------------- limits and allow-lists

const MAX_PAYLOAD_BYTES = 64 * 1024, MAX_PROMPT_BYTES = 4096, MAX_SLOTS = 8, MAX_OPTIONS = 20, MAX_LIST = 12, MAX_COMBOS = 4000;
export const MIN_INTERVAL_MINUTES = 15;
export const SLOT_TYPES: readonly string[] = ['time', 'enum', 'text', 'weekdays'];
/** Toolsets a routine may enable: read-only only, because a routine runs unattended. NOT here (and so rejected): file (bundles write/patch tools; use file_read), terminal, code_execution, browser, computer_use, cronjob (persistence), delegation, email/chat/messaging (exfiltration), memory (persistent writes), session_search. */
export const SAFE_TOOLSETS: readonly string[] = ['web', 'search', 'vision', 'file_read', 'todo'];
const DELIVER_OK: readonly string[] = ['local', 'origin'];
const WEEKDAY_PRESETS: readonly string[] = ['everyday', 'weekdays', 'weekends'];
const DAY_NAMES: readonly string[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** Slot names fill_blueprint / _resolve_schedule give a meaning to; a package may not claim them for another purpose (a slot named `deliver` or `schedule` would let the USER-supplied value override the checks below). */
const RESERVED_SLOTS: readonly string[] = ['deliver', 'schedule', 'origin', 'name', 'prompt', 'skills', 'repeat', 'minute', 'hour', 'dow'];

const PAYLOAD_KEYS = new Set(['kind', 'blueprint']);
const BLUEPRINT_KEYS = new Set(['schedule_template', 'prompt_template', 'slots', 'deliver_default', 'skills', 'enabled_toolsets']);
const SLOT_KEYS = new Set(['name', 'type', 'label', 'default', 'options', 'optional', 'help']);

/** Keys that make a cron job executable, redirect inference, chain jobs, or send data elsewhere. Compared after lower-casing and stripping `_-`. */
const FORBIDDEN_KEYS = new Set(['script', 'noagent', 'workdir', 'cwd', 'contextfrom', 'model', 'provider', 'baseurl', 'origin', 'deliver', 'repeat', 'skill',
  'attachtosession', 'command', 'shell', 'exec', 'env', 'url', 'headers', 'mcpservers', 'hooks']);
const EVENT_KEYS = new Set(['event', 'events', 'trigger', 'triggers', 'on', 'when', 'webhook', 'watch']);

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/;
const SLOT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TIME_RE = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
const TOOLSET_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CRON_FIELD_RE = /^[0-9*\-,/]+$/;

const ok = (name: string, detail?: string): ValidationCheck => ({ name, ok: true, ...(detail ? { detail } : {}) });
const fail = (name: string, detail: string): ValidationCheck => ({ name, ok: false, detail });
const list = (xs: string[]) => xs.slice(0, MAX_LIST).join('; ') + (xs.length > MAX_LIST ? `; ... and ${xs.length - MAX_LIST} more` : '');
const q = (s: string) => JSON.stringify(s.length > 80 ? s.slice(0, 80) + '...' : s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keyNorm = (k: string) => k.toLowerCase().replace(/[_\-\s]/g, '');
const utf8 = (s: string) => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------- text hygiene

/** Invisible and formatting characters: they hide instructions from a human reviewer and from naive scanners. */
const HIDDEN_RE = /[\p{Cf}\p{Co}\p{Cs}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u00AD\u180E\u2800\u3164]/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const normText = (s: string) => s.normalize('NFKC').replace(HIDDEN_RE, ' ').toLowerCase();

/** Phrases that are injection or exfiltration by themselves in an unattended prompt. The Hermes scanner runs on top of these. */
const BAD_PHRASES: ReadonlyArray<[string, RegExp]> = [
  ['instruction override', /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|system|all|any|your)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|guidelines?|constraints?)\b/],
  ['system prompt probing', /\b(?:reveal|show|print|repeat|leak|dump)\b[^.\n]{0,30}\b(?:system prompt|hidden prompt|developer message|your instructions)\b/],
  ['persona takeover', /\byou are now\b|\bnew instructions?\s*:|\bact as (?:an? )?(?:root|admin|administrator|unrestricted|jailbroken)\b/],
  ['credential path', /\/\.(?:ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc)\b|(?:^|\s)\.(?:ssh|aws|gnupg|kube|netrc|npmrc|pypirc)\b|\bid_(?:rsa|ed25519|ecdsa)\b|\/etc\/(?:passwd|shadow)\b|\.env\b|\bcredentials?\.json\b|\bkeychain\b/],
  ['secret exfiltration', /\b(?:exfiltrat\w*|steal|smuggle)\b|\b(?:send|post|upload|email|forward|transmit|leak|pipe)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|passwords?|secrets?|tokens?|credentials?|private keys?|ssh|cookies?|env(?:ironment)? variables?)\b/],
  ['shell execution', /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sudo|chmod|powershell|bash|zsh)\b\s+[-\w./~$"']|\|\s*(?:sh|bash|zsh|python3?|node)\b|\bbase64\s+(?:-d|--decode)\b|\beval\s*\(|\bos\.system\b|\bsubprocess\b/],
  ['persistence', /\b(?:crontab|launchctl|systemctl|authorized_keys|\.bashrc|\.zshrc|\.profile|login item)\b/],
];
const URL_RE = /\b[a-z][a-z0-9+.-]{1,10}:\/\/|\bwww\.[a-z0-9-]|\b[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}\.[a-z]{2,}\b/;

/** Why a piece of prompt-bound text is refused, or null. Bounded input only (callers cap length first). */
export function promptProblem(text: string): string | null {
  if (HIDDEN_RE.test(text)) return 'contains invisible or formatting characters';
  const n = normText(text);
  if (URL_RE.test(n)) return 'contains a URL or e-mail address (routines may not name endpoints)';
  for (const [label, re] of BAD_PHRASES) if (re.test(n)) return `matches the ${label} pattern`;
  return null;
}

// ---------------------------------------------------------------- cron

/** Expands one cron field into the sorted set of values it selects; throws on anything outside digits * - , / or out of range. */
export function expandCronField(spec: string, min: number, max: number): number[] {
  if (spec.length === 0 || spec.length > 80 || !CRON_FIELD_RE.test(spec)) throw new Error(`bad field ${q(spec)}`);
  const out = new Set<number>();
  const parts = spec.split(',');
  if (parts.length > 60) throw new Error('too many list items');
  for (const part of parts) {
    const [range, stepRaw, extra] = part.split('/');
    if (extra !== undefined || range === '' || (stepRaw !== undefined && !/^[0-9]{1,3}$/.test(stepRaw))) throw new Error(`bad item ${q(part)}`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!(step >= 1)) throw new Error(`bad step in ${q(part)}`);
    let lo: number, hi: number;
    if (range === '*') { lo = min; hi = max; }
    else if (/^[0-9]{1,3}$/.test(range)) { lo = Number(range); hi = stepRaw === undefined ? lo : max; }
    else if (/^[0-9]{1,3}-[0-9]{1,3}$/.test(range)) { [lo, hi] = range.split('-').map(Number); }
    else throw new Error(`bad item ${q(part)}`);
    if (lo < min || hi > max || lo > hi) throw new Error(`${q(part)} is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** The shortest gap, in minutes, between two firings of a 5-field cron expression (a lower bound: day restrictions can only widen it). Throws on a non-cron or malformed schedule. */
export function minCronGapMinutes(expr: string): number {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('a schedule must be a 5-field cron expression');
  const minutes = expandCronField(f[0], 0, 59), hours = expandCronField(f[1], 0, 23);
  expandCronField(f[2], 1, 31); expandCronField(f[3], 1, 12); expandCronField(f[4], 0, 7);
  const times: number[] = [];
  for (const h of hours) for (const m of minutes) times.push(h * 60 + m);
  times.sort((a, b) => a - b);
  let gap = 1440 - times[times.length - 1] + times[0];     // across midnight (the next day can match too)
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
  return gap;
}

interface Slot { name: string; type: string; label: string; default: string; options: string[] }

/** Every concrete schedule the template can produce, by substituting each slot value its type allows. Returns a reason when the template cannot be bounded. */
function schedulesOf(template: string, slots: Slot[]): { schedules: string[] } | { problem: string } {
  const uniq = [...new Set([...template.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]))];
  const options: string[][] = [];
  for (const n of uniq) {
    if (n === 'minute' || n === 'hour') {
      // fed by the slot named `time` (the user picks any HH:MM): probe the corners and the default
      const t = slots.find((s) => s.name === 'time' && s.type === 'time');
      if (!t) return { problem: `{${n}} needs a slot named time of type time` };
      const d = t.default.split(':');
      options.push(n === 'minute' ? ['0', '59', String(Number(d[1]))] : ['0', '23', String(Number(d[0]))]);
    } else if (n === 'dow') {
      options.push(['*', '1-5', '0,6', '0', '1', '2', '3', '4', '5', '6']);
    } else {
      const slot = slots.find((s) => s.name === n);
      if (!slot) return { problem: `{${n}} in the schedule is not a declared slot` };
      // text slots pass through verbatim and weekdays/time slots do not map by name: only an enum bounds the schedule
      if (slot.type !== 'enum') return { problem: `slot ${n} (${slot.type}) cannot appear in the schedule` };
      options.push(slot.options);
    }
  }
  let combos: string[] = [template];
  for (let i = 0; i < uniq.length; i++) {
    const next: string[] = [];
    for (const c of combos) for (const v of options[i]) { next.push(c.split(`{${uniq[i]}}`).join(v)); if (next.length > MAX_COMBOS) return { problem: 'the schedule has too many slot combinations to check' }; }
    combos = next;
  }
  return { schedules: combos };
}

// ---------------------------------------------------------------- the validator

function strList(v: unknown, label: string, problems: string[], max: number, re: RegExp): string[] {
  if (!Array.isArray(v) || v.length > max) { problems.push(`${label} must be a list of at most ${max}`); return []; }
  const out: string[] = [];
  for (const x of v) { if (typeof x !== 'string' || !re.test(x)) { problems.push(`${label} has an invalid entry ${q(String(x))}`); continue; } out.push(x); }
  if (new Set(out).size !== out.length) problems.push(`${label} has duplicates`);
  return out;
}

/** Walks every key at every depth (bounded: callers run checkBounded first). */
function* keysOf(root: unknown): Generator<{ key: string; path: string }> {
  const stack: Array<{ v: unknown; p: string }> = [{ v: root, p: '$' }];
  while (stack.length) {
    const { v, p } = stack.pop()!;
    if (Array.isArray(v)) { v.forEach((x, i) => stack.push({ v: x, p: `${p}[${i}]` })); continue; }
    if (!isObj(v)) continue;
    for (const k of Object.keys(v)) { const seg = `${p}.${k.length <= 40 ? k : '<key>'}`; yield { key: k, path: seg }; stack.push({ v: v[k], p: seg }); }
  }
}

export function createRoutineValidator(opts: RoutineValidatorOptions = {}): Validator {
  return async (pkg: UnpackedPackage): Promise<ValidationCheck[]> => {
    const checks: ValidationCheck[] = [];
    const payload: unknown = pkg.manifest.payload;

    const bounded = checkBounded(payload, { maxBytes: MAX_PAYLOAD_BYTES, maxDepth: 6, maxKeys: 300 });
    checks.push(bounded);
    if (!bounded.ok) { checks.push(riskTierCheck('declarative')); return checks; }

    // ---- forbidden fields and events (named, so the reviewer sees exactly what was refused)
    const forbidden: string[] = [], events: string[] = [];
    for (const { key, path } of keysOf(payload)) {
      const n = keyNorm(key);
      if (FORBIDDEN_KEYS.has(n)) forbidden.push(path);
      else if (EVENT_KEYS.has(n)) events.push(path);
    }
    checks.push(forbidden.length ? fail('no-forbidden-fields', `${list(forbidden)}: these fields make a job executable, redirect inference or delivery, or chain jobs, and are never allowed in a routine`) : ok('no-forbidden-fields'));
    checks.push(events.length ? fail('no-events', `${list(events)}: routines are time-based; event-driven behaviour is a hook`) : ok('no-events'));
    const known = (k: string) => FORBIDDEN_KEYS.has(keyNorm(k)) || EVENT_KEYS.has(keyNorm(k));   // already reported above

    // ---- shape
    const shape: string[] = [];
    const slots: Slot[] = [];
    let promptTpl = '', scheduleTpl = '', deliver = 'local';
    let skills: string[] = [], toolsets: string[] = [];
    const bp = isObj(payload) && isObj(payload.blueprint) ? payload.blueprint : undefined;
    if (!isObj(payload)) shape.push('payload must be an object');
    else {
      if (payload.kind !== 'routine') shape.push('payload.kind must be "routine"');
      for (const k of Object.keys(payload)) if (!PAYLOAD_KEYS.has(k) && !known(k)) shape.push(`unknown payload key ${q(k)}`);
      if (!bp) shape.push('payload.blueprint must be an object');
    }
    if (bp) {
      for (const k of Object.keys(bp)) if (!BLUEPRINT_KEYS.has(k) && !known(k)) shape.push(`unknown blueprint key ${q(k)}`);
      if (typeof bp.schedule_template !== 'string' || bp.schedule_template.length === 0 || bp.schedule_template.length > 120) shape.push('schedule_template must be a string of 1-120 characters');
      else scheduleTpl = bp.schedule_template;
      if (typeof bp.prompt_template !== 'string' || bp.prompt_template.length === 0) shape.push('prompt_template must be a non-empty string');
      else if (utf8(bp.prompt_template) > MAX_PROMPT_BYTES) shape.push(`prompt_template is larger than ${MAX_PROMPT_BYTES} bytes`);
      else promptTpl = bp.prompt_template;
      if (bp.deliver_default !== undefined) { if (typeof bp.deliver_default === 'string') deliver = bp.deliver_default; else shape.push('deliver_default must be a string'); }
      if (bp.skills !== undefined) skills = strList(bp.skills, 'skills', shape, 8, ID_RE);
      if (bp.enabled_toolsets === undefined) shape.push('enabled_toolsets is required');
      else toolsets = strList(bp.enabled_toolsets, 'enabled_toolsets', shape, 12, TOOLSET_RE);
      if (!Array.isArray(bp.slots) || bp.slots.length > MAX_SLOTS) shape.push(`slots must be a list of at most ${MAX_SLOTS}`);
      else {
        const seen = new Set<string>();
        bp.slots.forEach((raw, i) => {
          const at = `slots[${i}]`;
          if (!isObj(raw)) { shape.push(`${at} must be an object`); return; }
          for (const k of Object.keys(raw)) if (!SLOT_KEYS.has(k) && !known(k)) shape.push(`${at}: unknown key ${q(k)}`);
          const name = raw.name, type = raw.type;
          if (typeof name !== 'string' || !SLOT_NAME_RE.test(name)) { shape.push(`${at}: name must match ${SLOT_NAME_RE}`); return; }
          if (seen.has(name)) shape.push(`${at}: duplicate slot name ${q(name)}`);
          seen.add(name);
          if (RESERVED_SLOTS.includes(name)) shape.push(`${at}: slot name ${q(name)} is reserved (it would override delivery, schedule or job fields)`);
          if (typeof type !== 'string' || !SLOT_TYPES.includes(type)) { shape.push(`${at}: slot type ${q(String(type))} is not one of ${SLOT_TYPES.join(', ')}`); return; }
          const label = typeof raw.label === 'string' ? raw.label : '';
          if (!label || label.length > 80 || CONTROL_RE.test(label)) shape.push(`${at}: label must be 1-80 characters without control characters`);
          if (raw.help !== undefined && (typeof raw.help !== 'string' || raw.help.length > 200 || CONTROL_RE.test(raw.help))) shape.push(`${at}: help must be text of at most 200 characters without control characters`);
          if (raw.optional !== undefined && typeof raw.optional !== 'boolean') shape.push(`${at}: optional must be a boolean`);
          const def = raw.default;
          if (typeof def !== 'string' || def.length > 200 || CONTROL_RE.test(def)) { shape.push(`${at}: default must be a single-line string of at most 200 characters (a newline could smuggle a second instruction)`); return; }
          let options: string[] = [];
          if (type === 'enum') {
            if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > MAX_OPTIONS || !raw.options.every((o) => typeof o === 'string' && o.length > 0 && o.length <= 40 && !CONTROL_RE.test(o))) shape.push(`${at}: an enum needs 2-${MAX_OPTIONS} single-line options of at most 40 characters`);
            else { options = raw.options as string[]; if (new Set(options).size !== options.length) shape.push(`${at}: duplicate options`); if (!options.includes(def)) shape.push(`${at}: default must be one of the options`); }
          } else if (raw.options !== undefined && type !== 'weekdays') shape.push(`${at}: options only apply to enum and weekdays slots`);
          if (type === 'time' && !TIME_RE.test(def)) shape.push(`${at}: a time default must be HH:MM (24h)`);
          if (type === 'time' && name !== 'time') shape.push(`${at}: the time slot must be named time (that is the name Hermes reads)`);
          if (name === 'time' && type !== 'time') shape.push(`${at}: a slot named time must have type time`);
          if (type === 'weekdays') {
            if (!WEEKDAY_PRESETS.includes(def)) shape.push(`${at}: a weekdays default must be one of ${WEEKDAY_PRESETS.join(', ')}`);
            if (raw.options !== undefined && !(Array.isArray(raw.options) && raw.options.every((o) => typeof o === 'string' && WEEKDAY_PRESETS.includes(o)))) shape.push(`${at}: weekdays options must be from ${WEEKDAY_PRESETS.join(', ')}`);
            if (name !== 'recurrence') shape.push(`${at}: the weekdays slot must be named recurrence (that is the name Hermes reads)`);
          }
          if (name === 'recurrence' && type !== 'weekdays') shape.push(`${at}: a slot named recurrence must have type weekdays`);
          if (name === 'day' && !(type === 'enum' && options.every((o) => DAY_NAMES.includes(o)))) shape.push(`${at}: a slot named day must be an enum of ${DAY_NAMES.join(', ')}`);
          if (type === 'text' && def.length === 0) shape.push(`${at}: a text slot needs a non-empty default`);
          slots.push({ name, type, label, default: def, options });
        });
      }
    }
    checks.push(shape.length ? fail('routine-shape', list(shape)) : ok('routine-shape'));
    const shapeOk = shape.length === 0;
    const skippedShape = (name: string) => fail(name, 'skipped: the shape is invalid');

    // ---- delivery
    checks.push(DELIVER_OK.includes(deliver) ? ok('deliver-local-only') : fail('deliver-local-only', `deliver_default ${q(deliver)} is not allowed: only ${DELIVER_OK.join(' or ')} (delivering elsewhere is data exfiltration and has no consent path here)`));

    // ---- placeholders are closed
    const ph: string[] = [];
    if (shapeOk) {
      const declared = new Set(slots.map((s) => s.name));
      for (const [label, tpl] of [['schedule_template', scheduleTpl], ['prompt_template', promptTpl]] as const) {
        const stripped = tpl.replace(/\{([a-z][a-z0-9_]*)\}/g, (_m, n: string) => {
          if (!declared.has(n) && !(label === 'schedule_template' && (n === 'minute' || n === 'hour' || n === 'dow'))) ph.push(`${label}: {${n}} is not a declared slot`);
          return '';
        });
        if (/[{}]/.test(stripped)) ph.push(`${label}: only plain {name} placeholders are allowed (no {{ }}, attributes, indexes or format specs)`);
      }
    }
    checks.push(shapeOk ? (ph.length ? fail('placeholders-closed', list(ph)) : ok('placeholders-closed')) : skippedShape('placeholders-closed'));

    // ---- toolsets
    const tsProblems: string[] = [];
    const depSlugs = new Set(pkg.manifest.dependencies.map((d) => d.id.split('/')[1]));
    if (shapeOk) {
      if (toolsets.length === 0) tsProblems.push('enabled_toolsets must name at least one toolset (omitting it would load every default tool)');
      for (const t of toolsets) {
        if (SAFE_TOOLSETS.includes(t)) continue;
        if (t.startsWith('mcp-') && depSlugs.has(t.slice(4))) continue;
        tsProblems.push(`${q(t)} is not an allowed toolset (allowed: ${SAFE_TOOLSETS.join(', ')}; mcp-<name> only for a declared bridge dependency)`);
      }
    }
    checks.push(shapeOk ? (tsProblems.length ? fail('toolsets-allowlisted', list(tsProblems)) : ok('toolsets-allowlisted')) : skippedShape('toolsets-allowlisted'));

    // ---- schedule density
    const sched: string[] = [];
    if (shapeOk) {
      const r = schedulesOf(scheduleTpl, slots);
      if ('problem' in r) sched.push(r.problem);
      else {
        for (const s of r.schedules) {
          try { const gap = minCronGapMinutes(s); if (gap < MIN_INTERVAL_MINUTES) sched.push(`${q(s)} can fire every ${gap} minute(s); the minimum is ${MIN_INTERVAL_MINUTES}`); }
          catch (e) { sched.push(`${q(s)}: ${(e as Error).message}`); }
          if (sched.length >= 5) break;
        }
      }
    }
    checks.push(shapeOk ? (sched.length ? fail('min-interval', list(sched)) : ok('min-interval')) : skippedShape('min-interval'));

    // ---- skills are declared dependencies
    const depIds = new Set(pkg.manifest.dependencies.map((d) => d.id));
    const undeclared = skills.filter((s) => !depIds.has(s));
    checks.push(shapeOk ? (undeclared.length ? fail('skills-declared', `${list(undeclared)}: every skill must be a declared dependency`) : ok('skills-declared')) : skippedShape('skills-declared'));

    // ---- prompt scan: local patterns over everything that reaches the prompt, then the injected scanner (required for `verified`)
    if (shapeOk) {
      const texts: Array<[string, string]> = [['prompt_template', promptTpl]];
      for (const s of slots) { texts.push([`slot ${s.name} default`, s.default], [`slot ${s.name} label`, s.label]); for (const o of s.options) texts.push([`slot ${s.name} option`, o]); }
      const bad: string[] = [];
      for (const [where, text] of texts) { const p = promptProblem(text); if (p) bad.push(`${where} ${p}`); }
      checks.push(bad.length ? fail('prompt-patterns', list(bad)) : ok('prompt-patterns'));
      const body = texts.map(([w, t]) => `${w}: ${t}`).join('\n');
      if (!opts.scanner) checks.push({ name: 'prompt-scan', ok: true, skipped: true, required: true, detail: 'skipped: no scanner configured' });
      else {
        try {
          const r = await opts.scanner(new Map([['SKILL.md', new TextEncoder().encode(`# routine prompt\n\n${body}\n`)]]), 'routine-prompt');
          if (r.verdict === 'safe' && r.findings.length === 0) checks.push(ok('prompt-scan'));
          else checks.push(fail('prompt-scan', `verdict ${r.verdict}; ${r.findings.length} finding(s): ${list(r.findings.map((f) => `${f.category}/${f.severity}${f.match ? ' ' + q(f.match) : ''}`))}`));
        } catch (e) { checks.push(fail('prompt-scan', `scanner failed: ${e instanceof Error ? e.message : String(e)}`)); }
      }
    } else {
      checks.push(skippedShape('prompt-patterns'));
      checks.push(skippedShape('prompt-scan'));
    }

    // ---- files: docs only, never executables
    checks.push(checkOnlyFiles(pkg, [/^(?:README|LICENSE|NOTICE)(?:\.md|\.txt)?$/i, /^docs\/[A-Za-z0-9._-]{1,80}\.(?:md|txt)$/]));

    // ---- permissions: the manifest must declare what the toolsets imply (a routine is an unattended agent run)
    const required: PermissionRequest[] = [];
    if (shapeOk) {
      for (const t of toolsets) {
        const reason = `The routine runs the ${t} toolset unattended.`;
        required.push({ capability: 'tool.invoke', scope: t, reason });
        if (t === 'web' || t === 'search') required.push({ capability: 'network', scope: t, reason });
        if (t === 'file_read') required.push({ capability: 'fs.workspace.read', scope: t, reason });
      }
    }
    checks.push(shapeOk ? impliedPermissions(pkg.manifest.permissions, required, { blockUnused: true }) : skippedShape('permissions-match-payload'));

    checks.push(riskTierCheck('declarative'));
    return checks;
  };
}
