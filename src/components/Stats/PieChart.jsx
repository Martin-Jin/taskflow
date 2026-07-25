/**
 * PieChart — minimal, dependency-free SVG donut chart. Renders
 * {label, value, color} slices as an arc path each, plus a legend with
 * hour totals and percentage share. No external charting library —
 * consistent with this project's lean-bundle approach.
 */

import React, { useState } from 'react';

const SIZE = 180;
const RADIUS = 70; // + half the hover stroke width must stay inside SIZE/2, or the ring clips against the viewBox edge
const STROKE = 26; // donut ring thickness
const CENTER = SIZE / 2;

function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  // Full-circle special case: SVG arcs can't describe a 360° sweep in one
  // path, so nudge just shy of it.
  const clampedEnd = endAngle - startAngle >= 359.999 ? startAngle + 359.999 : endAngle;
  const start = polarToCartesian(cx, cy, r, clampedEnd);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = clampedEnd - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

export default function PieChart({ data, emptyMessage = 'No data yet.' }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (data.length === 0 || total <= 0) {
    return <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, padding: '20px 0' }}>{emptyMessage}</div>;
  }

  let cursor = 0;
  const slices = data.map((d, i) => {
    const sweep = (d.value / total) * 360;
    const slice = { ...d, startAngle: cursor, endAngle: cursor + sweep, index: i };
    cursor += sweep;
    return slice;
  });

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ flexShrink: 0 }}>
        {slices.map((s) => (
          <path
            key={s.label}
            d={describeArc(CENTER, CENTER, RADIUS, s.startAngle, s.endAngle)}
            fill="none"
            stroke={s.color}
            strokeWidth={hoverIdx === s.index ? STROKE + 6 : STROKE}
            style={{ transition: 'stroke-width 0.12s ease', cursor: 'pointer', opacity: hoverIdx === null || hoverIdx === s.index ? 1 : 0.45 }}
            onMouseEnter={() => setHoverIdx(s.index)}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <title>{`${s.label}: ${s.value.toFixed(1)}h (${((s.value / total) * 100).toFixed(0)}%)`}</title>
          </path>
        ))}
        <text x={CENTER} y={CENTER - 4} textAnchor="middle" fontSize="19" fontWeight="700" fill="var(--color-text-primary)">
          {total.toFixed(0)}h
        </text>
        <text x={CENTER} y={CENTER + 14} textAnchor="middle" fontSize="10.5" fill="var(--color-text-secondary)">
          total
        </text>
      </svg>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 160 }}>
        {slices.map((s) => (
          <div
            key={s.label}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', opacity: hoverIdx === null || hoverIdx === s.index ? 1 : 0.5 }}
            onMouseEnter={() => setHoverIdx(s.index)}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
            <span style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }}>
              {s.value.toFixed(1)}h · {((s.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}