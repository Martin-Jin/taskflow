/**
 * A small, fixed palette for Labels (tags), distinct from the priority
 * palette (priorityColor.js) and the single indigo accent used for
 * projects — labels need several *different* hues since a task can carry
 * many of them side by side and they should stay visually distinguishable.
 *
 * Colors are assigned once, at creation time, by cycling through this list
 * in creation order (see SchedulerContext.getOrCreateLabelIds) — not
 * hashed from the name — so the assignment is stable and predictable
 * regardless of what a label happens to be called.
 */
// Kept as literal hex (not CSS vars) since callers append an alpha suffix
// (`${color}22`) for the tinted chip background — that only works with a
// literal hex string. One fixed set is used for both light and dark mode;
// each hue sits at a mid lightness that stays legible against both the
// near-white and warm-charcoal surfaces.
const LABEL_PALETTE = [
  '#2b8fa8', // teal-blue
  '#6b8e4e', // olive
  '#b4652e', // burnt orange
  '#8a5fb0', // plum
  '#b0527a', // dusty rose
  '#4f8f6b', // forest green
  '#a4462f', // rust
  '#6d6fa0', // muted indigo
];

/** Picks the next palette color for a newly-created label, cycling by how many already exist. */
export function nextLabelColor(existingLabelCount) {
  return LABEL_PALETTE[existingLabelCount % LABEL_PALETTE.length];
}
