// GENERATED from packages/promo-card/src/card.ts by tests/tools/sync-promo-card.mjs. Do not edit: change the source and re-run the script.
// promo-card v1: the declarative content of an Agentic Office promotion, and its validator.
//
// SINGLE SOURCE. tests/tools/sync-promo-card.mjs copies this file, byte for byte under a generated header, to the places that
// must not import packages/ (the accounts-sync container, the desktop fork, the admin console); verify-repo-invariants fails if a
// copy drifts. Edit it here only.
//
// A card is data the app renders with its own native widgets: there is no HTML, no script, no style and no URL the app fetches
// on its own. Every action is one of a short, fixed list the app implements. The server validates a card before it can be
// published and the app validates it again before rendering, so a card that passes one and not the other is never shown.
// Media is referred to by role ("image", "poster"); the server attaches the files it produced, never a URL from the card.

export const CARD_VERSION = 1;
export const MAX_CARD_BYTES = 8_000;

export type Block =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'image'; media: 'image' | 'poster'; alt: string }
  | { type: 'metric'; label: string; value: string }
  | { type: 'checklist'; items: string[] }
  | { type: 'badge'; text: string };

export type ActionCommand =
  | 'open_url'               // arg: an https URL, opened in the system browser
  | 'open_marketplace_item'  // arg: a marketplace item id
  | 'open_settings'          // arg: a setting id under agenticOffice.
  | 'insert_prompt'          // arg: text placed in the composer (not sent)
  | 'open_release_notes'     // arg: a release id
  | 'open_plans'             // no arg
  | 'dismiss';               // no arg

export interface Action { command: ActionCommand; arg?: string }
export interface CardAction { label: string; action: Action }
export interface Card {
  v: 1;
  layout: 'stack' | 'row';
  tone?: 'neutral' | 'accent';
  disclosure?: string;       // e.g. "Featured" - shown on the card; the server sets it for promotions
  blocks: Block[];
  actions?: CardAction[];
}

export interface Checked<T> { ok: boolean; errors: string[]; value?: T }

const ID = /^[A-Za-z0-9_.-]{1,80}$/;
const SETTING = /^agenticOffice\.[A-Za-z0-9_.-]{1,80}$/;
const COMMANDS: Record<ActionCommand, 'none' | 'url' | 'id' | 'setting' | 'text'> = {
  open_url: 'url', open_marketplace_item: 'id', open_settings: 'setting', insert_prompt: 'text',
  open_release_notes: 'id', open_plans: 'none', dismiss: 'none',
};
const LIMITS = { heading: 80, text: 280, alt: 120, label: 40, value: 24, item: 80, items: 5, badge: 24, actionLabel: 32, actions: 2, blocks: 8, prompt: 200, url: 500, disclosure: 24 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Printable text only: control characters and bidi overrides are refused, so a card cannot hide or reorder words.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]');

function str(v: unknown, path: string, max: number, errors: string[], min = 1): string {
  if (typeof v !== 'string') { errors.push(`${path} must be text`); return ''; }
  const s = v.trim();
  if (s.length < min || s.length > max) errors.push(`${path} must be ${min}-${max} characters`);
  if (CONTROL.test(s)) errors.push(`${path} contains control characters`);
  return s;
}

function onlyKeys(o: Record<string, unknown>, keys: string[], path: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${path}.${k} is not part of promo-card v1`);
}

/** An action, as used by a card button or by a creative's own call to action. */
export function validateAction(v: unknown, path = 'action'): Checked<Action> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: [`${path} must be an object`] };
  onlyKeys(v, ['command', 'arg'], path, errors);
  const command = v.command as ActionCommand;
  const kind = COMMANDS[command];
  if (!kind) return { ok: false, errors: [...errors, `${path}.command must be one of ${Object.keys(COMMANDS).join(', ')}`] };
  let arg: string | undefined;
  if (kind === 'none') {
    if (v.arg !== undefined) errors.push(`${path}.arg is not used by ${command}`);
  } else {
    arg = str(v.arg, `${path}.arg`, kind === 'url' ? LIMITS.url : kind === 'text' ? LIMITS.prompt : 81, errors);
    if (kind === 'url') {
      let u: URL | undefined;
      try { u = new URL(arg); } catch { errors.push(`${path}.arg must be a URL`); }
      if (u && (u.protocol !== 'https:' || u.username || u.password)) errors.push(`${path}.arg must be an https URL without credentials`);
    } else if (kind === 'id' && !ID.test(arg)) {
      errors.push(`${path}.arg must be an id`);
    } else if (kind === 'setting' && !SETTING.test(arg)) {
      errors.push(`${path}.arg must be an agenticOffice.* setting`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors, value: arg === undefined ? { command } : { command, arg } };
}

function validateBlock(v: unknown, path: string, errors: string[]): Block | undefined {
  if (!isObj(v)) { errors.push(`${path} must be an object`); return undefined; }
  switch (v.type) {
    case 'heading': onlyKeys(v, ['type', 'text'], path, errors); return { type: 'heading', text: str(v.text, `${path}.text`, LIMITS.heading, errors) };
    case 'text': onlyKeys(v, ['type', 'text'], path, errors); return { type: 'text', text: str(v.text, `${path}.text`, LIMITS.text, errors) };
    case 'badge': onlyKeys(v, ['type', 'text'], path, errors); return { type: 'badge', text: str(v.text, `${path}.text`, LIMITS.badge, errors) };
    case 'metric':
      onlyKeys(v, ['type', 'label', 'value'], path, errors);
      return { type: 'metric', label: str(v.label, `${path}.label`, LIMITS.label, errors), value: str(v.value, `${path}.value`, LIMITS.value, errors) };
    case 'image':
      onlyKeys(v, ['type', 'media', 'alt'], path, errors);
      if (v.media !== 'image' && v.media !== 'poster') errors.push(`${path}.media must be "image" or "poster"`);
      return { type: 'image', media: v.media as 'image' | 'poster', alt: str(v.alt, `${path}.alt`, LIMITS.alt, errors) };
    case 'checklist': {
      onlyKeys(v, ['type', 'items'], path, errors);
      const items = Array.isArray(v.items) ? v.items : [];
      if (!Array.isArray(v.items) || items.length < 1 || items.length > LIMITS.items) errors.push(`${path}.items must list 1-${LIMITS.items} lines`);
      return { type: 'checklist', items: items.slice(0, LIMITS.items).map((it, i) => str(it, `${path}.items[${i}]`, LIMITS.item, errors)) };
    }
    default:
      errors.push(`${path}.type must be heading, text, image, metric, checklist or badge`);
      return undefined;
  }
}

/** Validate a card document. On success `value` is a clean copy (trimmed, no unknown fields) - render that, not the input. */
export function validateCard(v: unknown): Checked<Card> {
  const errors: string[] = [];
  let size = 0;
  try { size = new TextEncoder().encode(JSON.stringify(v)).length; } catch { return { ok: false, errors: ['card is not JSON'] }; }
  if (size > MAX_CARD_BYTES) return { ok: false, errors: [`card is ${size} bytes; the limit is ${MAX_CARD_BYTES}`] };
  if (!isObj(v)) return { ok: false, errors: ['card must be an object'] };
  onlyKeys(v, ['v', 'layout', 'tone', 'disclosure', 'blocks', 'actions'], 'card', errors);
  if (v.v !== CARD_VERSION) errors.push(`card.v must be ${CARD_VERSION}`);
  if (v.layout !== 'stack' && v.layout !== 'row') errors.push('card.layout must be "stack" or "row"');
  if (v.tone !== undefined && v.tone !== 'neutral' && v.tone !== 'accent') errors.push('card.tone must be "neutral" or "accent"');
  const disclosure = v.disclosure === undefined ? undefined : str(v.disclosure, 'card.disclosure', LIMITS.disclosure, errors);
  const rawBlocks = Array.isArray(v.blocks) ? v.blocks : [];
  if (!Array.isArray(v.blocks) || rawBlocks.length < 1 || rawBlocks.length > LIMITS.blocks) errors.push(`card.blocks must hold 1-${LIMITS.blocks} blocks`);
  const blocks = rawBlocks.slice(0, LIMITS.blocks).map((b, i) => validateBlock(b, `card.blocks[${i}]`, errors)).filter((b): b is Block => !!b);
  if (!blocks.some((b) => b.type === 'heading' || b.type === 'text')) errors.push('card needs a heading or a text block');
  let actions: CardAction[] | undefined;
  if (v.actions !== undefined) {
    if (!Array.isArray(v.actions) || v.actions.length > LIMITS.actions) errors.push(`card.actions must hold at most ${LIMITS.actions} actions`);
    actions = (Array.isArray(v.actions) ? v.actions : []).slice(0, LIMITS.actions).map((a, i) => {
      const path = `card.actions[${i}]`;
      if (!isObj(a)) { errors.push(`${path} must be an object`); return undefined; }
      onlyKeys(a, ['label', 'action'], path, errors);
      const label = str(a.label, `${path}.label`, LIMITS.actionLabel, errors);
      const act = validateAction(a.action, `${path}.action`);
      errors.push(...act.errors);
      return act.value ? { label, action: act.value } : undefined;
    }).filter((a): a is CardAction => !!a);
  }
  if (errors.length) return { ok: false, errors };
  const card: Card = { v: 1, layout: v.layout as Card['layout'], blocks };
  if (v.tone !== undefined) card.tone = v.tone as Card['tone'];
  if (disclosure !== undefined) card.disclosure = disclosure;
  if (actions && actions.length) card.actions = actions;
  return { ok: true, errors, value: card };
}
