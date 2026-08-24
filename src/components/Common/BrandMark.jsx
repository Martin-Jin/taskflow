/**
 * BrandMark — the app's logo (rounded square + checkmark), matching
 * public/favicon.svg exactly. Rendered inline here rather than as an
 * `<img src="favicon.svg">` (still used for the actual browser-tab favicon,
 * which can't pick up runtime CSS) so its background fill can track the
 * live accent color: a custom accent (see themePresets.js) otherwise looked
 * visibly mismatched next to a hardcoded teal logo. Uses
 * --color-accent-solid-bg for the square, the same value the active
 * theme-toggle pill and other solid-accent-fill UI already use.
 *
 * The checkmark itself is deliberately a FIXED white, not tied to any
 * theme or accent token — it's the brand mark's identity, not a piece of
 * text needing its own contrast pairing, and every shipped accent preset
 * reads fine with a white tick. Keeping it fixed also matches
 * public/favicon.svg, which can't vary its tick by accent at all (a static
 * browser-tab icon has no way to read the app's live theme state).
 */
export default function BrandMark({ className }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--color-accent-solid-bg)" />
      <path
        d="M26.7 8 L12 22.7 L5.3 16"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
