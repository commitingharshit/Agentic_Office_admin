import type { ReactNode } from 'react';
import { Sparkline } from './Charts';
import { Icon, type IconName } from './Icon';

/** One number, honestly labelled. `delta` is shown only when there is a real previous period to compare against. */
export function MetricCard({ label, value, hint, icon, trend, delta }: { label: string; value: ReactNode; hint?: ReactNode; icon?: IconName; trend?: number[]; delta?: { pct: number; of: string } }) {
  return (
    <div className="card kpi">
      <div className="label">{icon && <Icon name={icon} size={14} />}{label}</div>
      <div className="value">{value}</div>
      <div className="foot">
        <span>{delta ? <span className={`delta ${delta.pct >= 0 ? 'up' : 'down'}`}>{delta.pct >= 0 ? '▲' : '▼'} {Math.abs(Math.round(delta.pct))}% <span className="faint">{delta.of}</span></span> : hint}</span>
        {trend && <Sparkline data={trend} />}
      </div>
    </div>
  );
}
