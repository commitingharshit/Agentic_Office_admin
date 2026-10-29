// Laya shadow mode: the person's request goes to Laya (the router being calibrated) and its prediction is kept (table laya_shadow).
// Two sources: after a managed inference request is answered (next to the model that really answered), and POST /v1/laya/predict,
// where Hermes on the person's laptop posts each chat request after answering it with their own provider. Laya never routes anything.
//   LAYA_URL=http://<host>:8795  LAYA_API_KEY=…   (Laya's own serve.py: POST /predict {"text"} -> {pattern, confidence, probabilities, model})

export interface LayaPrediction { pattern: string; confidence: number; probabilities: Record<string, number>; model: string }
/** Resolves to undefined when the call was skipped because Laya is already busy. */
export type Laya = (text: string, workspace?: string) => Promise<LayaPrediction | undefined>;

/** Longest text sent to Laya and stored. */
export const MAX_TEXT = 20_000;

/** The last user message's text: string content, or the text parts of a content array. */
export function lastUserText(body: Record<string, unknown>): string | undefined {
  const msgs = Array.isArray(body.messages) ? body.messages as Array<{ role?: unknown; content?: unknown }> : [];
  const m = msgs.findLast((x) => x?.role === 'user');
  const c = m?.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.map((p) => (p?.type === 'text' || p?.type === 'input_text') && typeof p.text === 'string' ? p.text : '').filter(Boolean).join('\n')
    : '';
  return text.trim() ? text.slice(0, MAX_TEXT) : undefined;
}

// ponytail: Laya predicts one request at a time (serve.py holds a lock), so beyond `maxInFlight` calls are skipped, not queued;
// raise it, or queue, if too many samples are lost at peak.
export function httpLaya(baseUrl: string, apiKey: string | undefined, timeoutMs = 10_000, maxInFlight = 4): Laya {
  const url = `${baseUrl.replace(/\/+$/, '')}/predict`;
  let inFlight = 0;
  return async (text, workspace) => {
    if (inFlight >= maxInFlight) return undefined;
    inFlight++;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(workspace ? { text, workspace } : { text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`Laya answered ${r.status}`);
      const p = await r.json() as LayaPrediction;
      if (typeof p?.pattern !== 'string' || !Number.isFinite(p.confidence)) throw new Error('Laya answered without a pattern');
      return p;
    } finally { inFlight--; }
  };
}
