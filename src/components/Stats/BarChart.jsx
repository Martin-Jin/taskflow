/**
 * BarChart — minimal, dependency-free SVG bar chart. Built by hand instead
 * of pulling in a charting library, matching this project's existing
 * "no heavy deps" approach (see dateUtils.js's comment on avoiding
 * moment/luxon). Renders one bar per {label, value} point, scaled to the
 * tallest bar, with a value label on top and an x-axis label underneath.
 */

import React, { useState } from 'react';

const HEIGHT = 180;
const BAR_GAP = 8;

export default function BarChart({ data, valueFormatter = (v) => v.toFixed(1), barColor = 'var(--color-accent-border)', emptyMessage = 'No data yet.' }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const maxValue = Math.max(1, ...data.map((d) => d.value));
  const hasAnyValue = data.some((d) => d.value > 0);

  if (data.length === 0) {
    return <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, padding: '20px 0' }}>{emptyMessage}</div>;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', height: HEIGHT + 36, gap: BAR_GAP }}>
      {data.map((d, i) => {
        const barHeightPct = hasAnyValue ? Math.max(2, (d.value / maxValue) * 100) : 2;
        const isHovered = hoverIdx === i;
        return (
          <div
            key={d.label + i}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end', minWidth: 0 }}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <div
              style={{
                fontSize: 11,
                color: isHovered ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                marginBottom: 4,
                fontWeight: isHovered ? 700 : 400,
                whiteSpace: 'nowrap',
              }}
            >
              {d.value > 0 ? valueFormatter(d.value) : ''}
            </div>
            <div
              title={`${d.label}: ${valueFormatter(d.value)}`}
              style={{
                width: '100%',
                height: `${barHeightPct}%`,
                minHeight: 3,
                background: d.color || barColor,
                borderRadius: '4px 4px 2px 2px',
                opacity: isHovered ? 1 : 0.85,
                transition: 'opacity 0.12s ease, height 0.2s ease',
              }}
            />
            <div
              style={{
                fontSize: 10.5,
                color: d.isToday ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                fontWeight: d.isToday ? 700 : 400,
                marginTop: 6,
                whiteSpace: 'nowrap',
              }}
            >
              {d.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}