// An OpenAI-compatible provider (chat + embeddings) with several keys. Keys are used in turn; a key the provider refuses is
// rested (429: a minute, 401/403: ten minutes) and the call goes on with the next one. Key values are never logged or returned:
// status() reports only how many keys exist and how many are resting.
export interface ProviderConfig { baseUrl: string; keys: string[]; chatModel: string; embedModel: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }

export class ProviderError extends Error { readonly status: number | null; constructor(message: string, status: number | null) { super(message); this.status = status; } }

export class HelpProvider {
  private readonly cfg: ProviderConfig;
  private readonly restUntil: number[];
  private next = 0;
  private readonly f: typeof fetch;
  private readonly now: () => number;
  constructor(cfg: ProviderConfig) {
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') };
    const u = new URL(this.cfg.baseUrl);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.internal')))) throw new Error('AO_HELP_BASE_URL must be https (http only for localhost)');
    if (!cfg.keys.length) throw new Error('no provider keys');
    this.restUntil = cfg.keys.map(() => 0);
    this.f = cfg.fetch ?? fetch;
    this.now = cfg.now ?? Date.now;
  }
  get chatModel(): string { return this.cfg.chatModel; }
  get embedModel(): string { return this.cfg.embedModel; }
  status(): { keys: number; resting: number } { const t = this.now(); return { keys: this.cfg.keys.length, resting: this.restUntil.filter((r) => r > t).length }; }

  private async call(path: string, body: unknown): Promise<any> {
    const n = this.cfg.keys.length;
    let last: ProviderError = new ProviderError('every provider key is resting', 429);
    for (let i = 0; i < n; i++) {
      const k = (this.next + i) % n;
      if (this.restUntil[k]! > this.now()) continue;
      let res: Response;
      try {
        res = await this.f(`${this.cfg.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.keys[k]}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 45_000) });
      } catch { last = new ProviderError('provider unreachable', null); continue; }
      if (res.status === 429) { this.restUntil[k] = this.now() + 60_000; last = new ProviderError('provider is rate limiting', 429); continue; }
      if (res.status === 401 || res.status === 403) { this.restUntil[k] = this.now() + 600_000; last = new ProviderError('a provider key was refused', res.status); continue; }
      if (!res.ok) throw new ProviderError(`provider answered ${res.status}`, res.status);
      this.next = (k + 1) % n;
      try { return await res.json(); } catch { throw new ProviderError('provider reply was not JSON', res.status); }
    }
    throw last;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const j = await this.call('/embeddings', { model: this.cfg.embedModel, input: texts.slice(i, i + 64) });
      const data = j?.data;
      if (!Array.isArray(data) || data.length !== Math.min(64, texts.length - i)) throw new ProviderError('embedding reply has the wrong shape', 200);
      for (const d of [...data].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))) {
        if (!Array.isArray(d?.embedding) || !d.embedding.every((x: unknown) => typeof x === 'number')) throw new ProviderError('embedding reply has the wrong shape', 200);
        out.push(d.embedding);
      }
    }
    return out;
  }

  async chat(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string> {
    const j = await this.call('/chat/completions', { model: this.cfg.chatModel, messages, temperature: 0.1, max_tokens: 700 });
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError('chat reply was empty', 200);
    return text;
  }
}

export function providerFromEnv(env: Record<string, string | undefined>): HelpProvider | undefined {
  const keys = [...(env.AO_HELP_API_KEYS ?? '').split(','), env.AO_HELP_API_KEY ?? ''].map((k) => k.trim()).filter(Boolean);
  if (!env.AO_HELP_BASE_URL || !keys.length) return undefined;
  return new HelpProvider({ baseUrl: env.AO_HELP_BASE_URL, keys: [...new Set(keys)], chatModel: env.AO_HELP_CHAT_MODEL || 'gpt-4o-mini', embedModel: env.AO_HELP_EMBED_MODEL || 'text-embedding-3-small' });
}
