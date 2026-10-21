// Managed inference: authorise → hold credits for the worst case → call the upstream model →
// charge what was really used → give back the rest. The model call itself is injected (`Upstream`),
// so the money path is tested against a fake and the real provider is only configuration.
//
// Pricing is credits per 1,000 tokens, per model; a model not in the table is not offered.
//   AO_PRICING='{"gpt-4o-mini":{"in":1,"out":4}}'  AO_UPSTREAM_URL=https://…/v1  AO_UPSTREAM_KEY=…

export interface Price { in: number; out: number }
export type Pricing = Record<string, Price>;
export interface UpstreamResult { status: number; body: Record<string, unknown> }
export type Upstream = (model: string, body: Record<string, unknown>) => Promise<UpstreamResult>;

export const DEFAULT_MAX_OUTPUT = 4096;
export const HARD_MAX_OUTPUT = 16_384;

export function parsePricing(spec: string | undefined): Pricing {
  if (!spec) return {};
  let raw: unknown;
  try { raw = JSON.parse(spec); } catch { throw new Error('AO_PRICING is not valid JSON.'); }
  const out: Pricing = {};
  for (const [m, p] of Object.entries(raw as Record<string, { in?: unknown; out?: unknown }>)) {
    const i = Number(p?.in), o = Number(p?.out);
    if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(m) || !Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) throw new Error(`AO_PRICING has a bad entry for "${m}".`);
    out[m] = { in: i, out: o };
  }
  return out;
}

/** A cheap over-estimate of the prompt's tokens (1 token ≈ 3 characters is deliberately pessimistic). */
export function estimateInputTokens(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body.messages ?? body.input ?? '').length / 3);
}

/** How many output tokens the caller allows itself, clamped to what we will ever reserve. */
export function outputLimit(body: Record<string, unknown>): number {
  const asked = Number(body.max_completion_tokens ?? body.max_tokens);
  return Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), HARD_MAX_OUTPUT) : DEFAULT_MAX_OUTPUT;
}

export const cost = (p: Price, tokensIn: number, tokensOut: number) => Math.ceil((tokensIn * p.in + tokensOut * p.out) / 1000);
/** The most a request can cost: what we hold before calling the model. At least 1 credit. */
export const worstCase = (p: Price, body: Record<string, unknown>) => Math.max(1, cost(p, estimateInputTokens(body), outputLimit(body)));

export function usageOf(body: Record<string, unknown>): { in: number; out: number } | undefined {
  const u = body.usage as { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown } | undefined;
  if (!u) return undefined;
  const i = Number(u.prompt_tokens ?? u.input_tokens), o = Number(u.completion_tokens ?? u.output_tokens);
  return Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0 ? { in: Math.floor(i), out: Math.floor(o) } : undefined;
}

/** An OpenAI-compatible upstream over HTTP. */
export function httpUpstream(baseUrl: string, apiKey: string, timeoutMs = 120_000): Upstream {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async (model, body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...body, model, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let parsed: Record<string, unknown> = {};
    try { parsed = await r.json() as Record<string, unknown>; } catch { /* a non-JSON failure keeps the status */ }
    return { status: r.status, body: parsed };
  };
}

// ── streaming ─────────────────────────────────────────────────────────────────────────────────────
export interface StreamResult { status: number; body: ReadableStream<Uint8Array> | null; error?: Record<string, unknown> }
export type StreamUpstream = (model: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<StreamResult>;

/** An OpenAI-compatible upstream that streams. Asks for usage in the final chunk, so the charge can be exact. */
export function httpStreamUpstream(baseUrl: string, apiKey: string): StreamUpstream {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async (model, body, signal) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...body, model, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    if (r.ok) return { status: r.status, body: r.body };
    let error: Record<string, unknown> = {};
    try { error = await r.json() as Record<string, unknown>; } catch { /* keep the status */ }
    return { status: r.status, body: null, error };
  };
}

/** Watches a server-sent-event stream go by and remembers what it said was used, and how much text there was. */
export class UsageMeter {
  private buf = '';
  private last: { in: number; out: number } | undefined;
  chars = 0;
  feed(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trimEnd();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const o = JSON.parse(data) as Record<string, unknown> & { choices?: Array<{ delta?: { content?: unknown } }> };
        const u = usageOf(o);
        if (u) this.last = u;
        const c = o.choices?.[0]?.delta?.content;
        if (typeof c === 'string') this.chars += c.length;
      } catch { /* a partial or non-JSON line: the next feed carries on */ }
    }
    if (this.buf.length > 1_000_000) this.buf = '';
  }
  get usage(): { in: number; out: number } | undefined { return this.last; }
  /** Used when the stream ended (or was cut) without a usage report: the text seen, the prompt as estimated. */
  estimate(body: Record<string, unknown>): { in: number; out: number } {
    return { in: estimateInputTokens(body), out: Math.ceil(this.chars / 3) };
  }
}
