// Hand-rolled SVG charts: no chart library, readable in both themes, every point has a tooltip (<title>).
const W = 600;
const nice = (max: number) => { if (max <= 0) return 1; const p = 10 ** Math.floor(Math.log10(max)); const m = max / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const fmt = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(Math.round(n * 10) / 10));

function Axes({ top, h, labels, x0, x1 }: { top: number; h: number; labels: string[]; x0: number; x1: number }) {
  const ticks = [0, 0.5, 1];
  const shown = labels.length <= 1 ? labels.map((l, i) => [l, i] as const) : ([[labels[0], 0], [labels[Math.floor((labels.length - 1) / 2)], Math.floor((labels.length - 1) / 2)], [labels[labels.length - 1], labels.length - 1]] as const);
  return (
    <>
      {ticks.map((t) => <line key={t} className="grid-line" x1={x0} x2={x1} y1={top + h * (1 - t)} y2={top + h * (1 - t)} />)}
      {shown.map(([l, i]) => <text key={i} className="axis" x={x0 + ((x1 - x0) * (labels.length <= 1 ? 0.5 : i / (labels.length - 1)))} y={top + h + 16} textAnchor={i === 0 && labels.length > 1 ? 'start' : i === labels.length - 1 && labels.length > 1 ? 'end' : 'middle'}>{l}</text>)}
    </>
  );
}

export function AreaChart({ data, labels, height = 170, unit = '' }: { data: number[]; labels: string[]; height?: number; unit?: string }) {
  const top = 8, h = height - 30, x0 = 30, x1 = W - 4;
  const max = nice(Math.max(...data, 0));
  const px = (i: number) => x0 + (data.length <= 1 ? (x1 - x0) / 2 : (i / (data.length - 1)) * (x1 - x0));
  const py = (v: number) => top + h - (v / max) * h;
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(' ');
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Chart">
      <Axes top={top} h={h} labels={labels} x0={x0} x1={x1} />
      <text className="axis" x={x0 - 6} y={top + 4} textAnchor="end">{fmt(max)}</text><text className="axis" x={x0 - 6} y={top + h + 3} textAnchor="end">0</text>
      {data.length > 0 && <path className="area" d={`${line} L${px(data.length - 1)} ${top + h} L${px(0)} ${top + h}Z`} />}
      <path className="line" d={line} />
      {data.map((v, i) => <circle key={i} cx={px(i)} cy={py(v)} r="7" fill="transparent"><title>{`${labels[i]}: ${fmt(v)}${unit}`}</title></circle>)}
    </svg>
  );
}

export function BarChart({ data, labels, alt, height = 170 }: { data: number[]; labels: string[]; alt?: number[]; height?: number }) {
  const top = 8, h = height - 30, x0 = 30, x1 = W - 4;
  const max = nice(Math.max(...data, ...(alt ?? []), 0));
  const slot = (x1 - x0) / Math.max(data.length, 1), bw = Math.max(2, slot * (alt ? 0.36 : 0.62));
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Chart">
      <Axes top={top} h={h} labels={labels} x0={x0} x1={x1} />
      <text className="axis" x={x0 - 6} y={top + 4} textAnchor="end">{fmt(max)}</text><text className="axis" x={x0 - 6} y={top + h + 3} textAnchor="end">0</text>
      {data.map((v, i) => {
        const cx = x0 + slot * i + slot / 2, bh = (v / max) * h, ah = ((alt?.[i] ?? 0) / max) * h;
        return (
          <g key={i}>
            <rect className="bar" x={alt ? cx - bw - 1 : cx - bw / 2} y={top + h - bh} width={bw} height={Math.max(bh, v > 0 ? 1 : 0)} rx="2"><title>{`${labels[i]}: ${fmt(v)}`}</title></rect>
            {alt && <rect className="bar alt" x={cx + 1} y={top + h - ah} width={bw} height={Math.max(ah, (alt[i] ?? 0) > 0 ? 1 : 0)} rx="2"><title>{`${labels[i]}: ${fmt(alt[i] ?? 0)}`}</title></rect>}
          </g>
        );
      })}
    </svg>
  );
}

export function Sparkline({ data, width = 84, height = 24 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - 2 - ((v - min) / (max - min || 1)) * (height - 4)}`).join(' ');
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}
