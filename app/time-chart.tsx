"use client";

import { useState } from "react";
import type { Bucket, WindowKey } from "@/lib/queries";

const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
function clock(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function dayLabel(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Saved-vs-spent area+line chart. Hovering snaps a crosshair to the nearest
// bucket and reads out that bucket's timestamp + exact saved/spent values, so
// the trend lines become legible instead of just suggestive.
export function TimeChart({ series, win }: { series: Bucket[]; win: WindowKey }) {
  const [hover, setHover] = useState<number | null>(null);
  const saved = series.map((b) => b.saved);
  const cached = series.map((b) => b.cachedSaving);
  const spend = series.map((b) => b.cost);
  const max = Math.max(...saved, ...cached, ...spend, 1e-9);
  const w = 1000;
  const h = 130;
  const n = series.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const y = (v: number) => h - (v / max) * h;
  const area = `0,${h} ${saved.map((v, i) => `${x(i)},${y(v)}`).join(" ")} ${w},${h}`;
  const cacheLine = cached.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const line = spend.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const ticks = [0, Math.floor(n / 2), n - 1].filter((i, idx, a) => a.indexOf(i) === idx && i >= 0 && i < n);
  const labelAt = (i: number) =>
    win === "7d" || win === "30d" ? dayLabel(series[i].t) : clock(series[i].t);
  const tipLabel = (i: number) =>
    win === "7d" || win === "30d" ? `${dayLabel(series[i].t)} ${clock(series[i].t)}` : clock(series[i].t);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (n === 0 || rect.width === 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const i = Math.round(frac * (n - 1));
    if (!Number.isFinite(i)) return;
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const leftPct = hover !== null ? (n > 1 ? (hover / (n - 1)) * 100 : 0) : 0;
  // keep the tooltip inside the panel: anchor by edge near the borders
  const tipSide = leftPct > 70 ? "right" : "left";

  return (
    <div className="panel">
      <div className="p-head">
        <span className="p-title">Spend vs savings over time</span>
        <span className="legend">
          <i className="sw dim" /> spent <i className="sw green" /> saved <i className="sw cache" /> cache saved
        </span>
      </div>
      <div className="chart-wrap" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          <polygon points={area} fill="rgba(63,185,80,.16)" />
          <polyline points={saved.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="var(--green)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <polyline points={cacheLine} fill="none" stroke="var(--cache)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <polyline points={line} fill="none" stroke="var(--dim)" strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        </svg>
        {hover !== null && (
          <>
            <span className="chart-cursor" style={{ left: `${leftPct}%` }} />
            <span className="chart-dot dim" style={{ left: `${leftPct}%`, top: `${(y(spend[hover]) / h) * 100}%` }} />
            <span className="chart-dot green" style={{ left: `${leftPct}%`, top: `${(y(saved[hover]) / h) * 100}%` }} />
            <span className="chart-dot cache" style={{ left: `${leftPct}%`, top: `${(y(cached[hover]) / h) * 100}%` }} />
            <div className={`chart-tip ${tipSide}`} style={{ left: `${leftPct}%` }}>
              <div className="ct-time">{tipLabel(hover)}</div>
              <div className="ct-row">
                <span><i className="sw dim" /> spent</span>
                <b>{money(spend[hover])}</b>
              </div>
              <div className="ct-row">
                <span><i className="sw green" /> saved</span>
                <b>{money(saved[hover])}</b>
              </div>
              <div className="ct-row">
                <span><i className="sw cache" /> cache saved</span>
                <b>{money(cached[hover])}</b>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="axis">
        {ticks.map((i) => (
          <span key={i}>{labelAt(i)}</span>
        ))}
      </div>
    </div>
  );
}
