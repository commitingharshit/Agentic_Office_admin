// How a creative will look on each placement in the app, drawn from the same validated card the app renders (promo-card).
// It is a preview of layout and wording, not a pixel copy of the app: the app draws with its own widgets and theme.
import type { ReactNode } from 'react';
import { validateCard, type Card } from '../../lib/promo-card';

export interface PreviewCreative {
  kind: 'image' | 'clip' | 'card';
  headline?: string; body?: string; cta_label?: string | null; card?: unknown; disclosure?: string | null; mediaUrl?: string | null;
}

const box = (w: number | string, children: ReactNode, label: string) => (
  <figure style={{ margin: 0, display: 'grid', gap: 6 }}>
    <figcaption className="muted" style={{ fontSize: 12 }}>{label}</figcaption>
    <div style={{ width: w, maxWidth: '100%', border: '1px solid var(--line, rgba(255,255,255,0.12))', borderRadius: 10, background: 'var(--bg-surface)', padding: 12 }}>{children}</div>
  </figure>
);

function CardBody({ card }: { card: Card }) {
  return (
    <div style={{ display: card.layout === 'row' ? 'flex' : 'grid', gap: 8, alignItems: 'center' }}>
      {card.blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': return <div key={i} style={{ fontWeight: 600, fontSize: 15 }}>{b.text}</div>;
          case 'text': return <div key={i} style={{ fontSize: 13, opacity: 0.85 }}>{b.text}</div>;
          case 'badge': return <span key={i} style={{ fontSize: 11, padding: '1px 6px', borderRadius: 6, background: 'var(--accent-tint)', color: 'var(--accent-text)', justifySelf: 'start' }}>{b.text}</span>;
          case 'metric': return <div key={i}><div style={{ fontSize: 18, fontWeight: 600 }}>{b.value}</div><div style={{ fontSize: 11, opacity: 0.7 }}>{b.label}</div></div>;
          case 'checklist': return <ul key={i} style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{b.items.map((t, j) => <li key={j}>{t}</li>)}</ul>;
          case 'image': return <div key={i} style={{ height: 70, borderRadius: 6, background: 'var(--bg-raised)', display: 'grid', placeItems: 'center', fontSize: 11, opacity: 0.7 }}>image: {b.alt}</div>;
        }
      })}
      {card.actions?.length ? <div style={{ display: 'flex', gap: 6 }}>{card.actions.map((a, i) => <span key={i} className={i === 0 ? 'btn primary' : 'btn'} style={{ pointerEvents: 'none' }}>{a.label}</span>)}</div> : null}
    </div>
  );
}

function Content({ c, compact }: { c: PreviewCreative; compact?: boolean }) {
  const disclosure = c.disclosure ? <div style={{ fontSize: 10, letterSpacing: 0.3, textTransform: 'uppercase', opacity: 0.6, marginBottom: 6 }}>{c.disclosure}</div> : null;
  if (c.kind === 'card') {
    const v = validateCard(c.card);
    if (!v.ok) return <div className="muted" style={{ fontSize: 12 }}>The app would not show this card: {v.errors.slice(0, 2).join('; ')}</div>;
    if (compact) {
      const head = v.value!.blocks.find((b) => b.type === 'heading' || b.type === 'text') as { text: string } | undefined;
      return <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>{head?.text}{v.value!.actions?.[0] ? <span className="btn" style={{ pointerEvents: 'none' }}>{v.value!.actions[0].label}</span> : null}</div>;
    }
    return <>{disclosure}<CardBody card={v.value!} /></>;
  }
  return (
    <>{!compact && disclosure}
      <div style={{ display: compact ? 'flex' : 'grid', gap: 8, alignItems: 'center' }}>
        {!compact && (c.mediaUrl
          ? (c.kind === 'clip' ? <video src={c.mediaUrl} muted loop playsInline autoPlay style={{ width: '100%', borderRadius: 6 }} /> : <img src={c.mediaUrl} alt="" style={{ width: '100%', borderRadius: 6 }} />)
          : <div style={{ height: 110, borderRadius: 6, background: 'var(--bg-raised)', display: 'grid', placeItems: 'center', fontSize: 11, opacity: 0.7 }}>{c.kind === 'clip' ? 'muted clip (poster first)' : 'image'}</div>)}
        <div style={{ fontWeight: 600, fontSize: compact ? 13 : 15 }}>{c.headline}</div>
        {!compact && c.body ? <div style={{ fontSize: 13, opacity: 0.85 }}>{c.body}</div> : null}
        {c.cta_label ? <span className="btn primary" style={{ pointerEvents: 'none', justifySelf: 'start' }}>{c.cta_label}</span> : null}
      </div>
    </>
  );
}

/** The creative as each placement would show it. Pass only the placements it is made for. */
export function PromoPreview({ creative, placement }: { creative: PreviewCreative; placement: 'chat_empty' | 'inbox' | 'bottom_strip' }) {
  if (placement === 'chat_empty') {
    return box(360, (
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ textAlign: 'center', opacity: 0.55, fontSize: 12 }}>A  ·  Good to see you</div>
        <Content c={creative} />
        <div style={{ border: '1px solid var(--line, rgba(255,255,255,0.12))', borderRadius: 8, padding: '8px 10px', fontSize: 12, opacity: 0.6 }}>Ask Agentic Office…</div>
      </div>), 'Assistant, before a conversation starts: above the composer, collapses once a task starts');
  }
  if (placement === 'inbox') return box(320, <Content c={creative} />, 'Notification inbox: marked as a promotion');
  return box('100%', <Content c={creative} compact />, 'Bottom strip: one line, no video, hidden on narrow windows');
}
