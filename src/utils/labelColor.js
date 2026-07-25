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
const LABEL_PALETTE = [
  '#4fbf8b', // green
  '#4fb8e0', // blue
  '#f0a83e', // amber
  '#a06cf0', // violet
  '#f06ca0', // pink
  '#6bcf6b', // lime
  '#ef5a5a', // red
  '#8390f3', // indigo
];

/** Picks the next palette color for a newly-created label, cycling by how many already exist. */
export function nextLabelColor(existingLabelCount) {
  return LABEL_PALETTE[existingLabelCount % LABEL_PALETTE.length];
}
