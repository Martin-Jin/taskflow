/**
 * ProjectsPageBackground — a quiet, STATIC decorative field behind the
 * Projects page's hero, filling the empty space either side of the centered
 * column on a wide screen. Deliberately not an animation: CLAUDE.md's motion
 * rule ("Motion explains causality or it doesn't ship. No ambient drift.")
 * would reject a looping/drifting background outright, so this is drawn
 * ONCE per mount (and again on resize/theme/accent change) rather than on a
 * requestAnimationFrame loop — there's nothing to gate on useMotionEnabled
 * or prefers-reduced-motion because nothing on the page ever moves. Drawn to
 * a <canvas> rather than hand-authored SVG paths (a generative/decorative
 * graphic, not an icon), per the app's own convention for this kind of
 * background art (see TODO.md's original B5 scoping).
 *
 * The pattern is a soft accent-colored glow in the top-right corner (past
 * the hero's edge, so it never sits behind the actual project rows) plus a
 * loose constellation of nodes/connecting lines drifting from it — reads as
 * "a network of projects", tying the decoration back to what the page
 * actually is rather than being pure ornament. Node positions are FIXED
 * (a seeded layout, not Math.random()) so the pattern never differs between
 * loads or redraws — genuinely static, not merely un-animated.
 *
 * Colour is read from the live `--color-accent-solid-bg` custom property at
 * draw time (via getComputedStyle) — the same value BrandMark's logo uses —
 * so a custom accent color (see themePresets.js) tints this too instead of
 * a hardcoded teal looking out of place next to it.
 *
 * `pointer-events: none` and z-index: 0 (via the .projects-page-bg class)
 * keep it inert and behind real content — it must never sit above
 * interactive elements or create a stacking context that would re-clip the
 * portaled SelectMenu/MentionDropdown menus (see CLAUDE.md).
 */
import React, { useEffect, useRef } from 'react';

function readAccentColor() {
  const root = document.documentElement;
  const value = getComputedStyle(root).getPropertyValue('--color-accent-solid-bg').trim();
  return value || '#0f6e56';
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return { r: 15, g: 110, b: 86 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Fixed constellation layout, expressed as fractions of the canvas's own
// width/height so it rescales cleanly at any viewport size. Deliberately
// hand-placed (not generated) to loosely radiate from the glow's corner
// without ever drifting into the hero's centered column.
const NODES = [
  { x: 0.94, y: 0.06, r: 3.5 },
  { x: 0.8, y: 0.14, r: 2.5 },
  { x: 0.7, y: 0.32, r: 4 },
  { x: 0.88, y: 0.28, r: 2 },
  { x: 0.6, y: 0.12, r: 2.5 },
  { x: 0.5, y: 0.24, r: 3 },
  { x: 0.4, y: 0.4, r: 2 },
  { x: 0.66, y: 0.5, r: 2.5 },
  { x: 0.82, y: 0.46, r: 3 },
  { x: 0.94, y: 0.4, r: 2 },
  { x: 0.3, y: 0.18, r: 2 },
];

const EDGES = [
  [0, 1], [1, 2], [1, 4], [4, 5], [2, 3], [2, 5], [2, 6], [5, 6], [2, 7], [7, 8], [8, 3], [8, 9], [5, 10],
];

function draw(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height } = canvas.getBoundingClientRect();
  if (width === 0 || height === 0) return;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const { r, g, b } = hexToRgb(readAccentColor());
  const glowX = width * 0.92;
  const glowY = height * 0.02;
  const glowRadius = Math.max(width, height) * 0.5;

  const gradient = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, glowRadius);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.16)`);
  gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.05)`);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const points = NODES.map((n) => ({ x: width * n.x, y: height * n.y, r: n.r }));

  ctx.lineWidth = 1;
  EDGES.forEach(([a, bIdx]) => {
    const p1 = points[a];
    const p2 = points[bIdx];
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.14)`;
    ctx.stroke();
  });

  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.32)`;
    ctx.fill();
  });
}

export default function ProjectsPageBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    draw(canvas);

    // Redraw on resize (layout genuinely changed) and when the accent/theme
    // custom properties change on <html> (ThemeContext.jsx sets/clears these
    // as inline styles — see its own effect). Neither is a loop: each is a
    // single one-shot redraw in response to a real change, not a tick.
    const resizeObserver = new ResizeObserver(() => draw(canvas));
    resizeObserver.observe(canvas);

    const attributeObserver = new MutationObserver(() => draw(canvas));
    attributeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });

    return () => {
      resizeObserver.disconnect();
      attributeObserver.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="projects-page-bg" aria-hidden="true" />;
}
