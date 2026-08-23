/**
 * BrandMark — the app's logo (rounded square + checkmark), matching
 * public/favicon.svg exactly. Rendered inline here rather than as an
 * `<img src="favicon.svg">` (still used for the actual browser-tab favicon,
 * which can't pick up runtime CSS) so its fill can track the live accent
 * color: a custom accent (see themePresets.js) otherwise looked visibly
 * mismatched next to a hardcoded teal logo. Uses the same
 * --color-accent-solid-bg/-text pair the active theme-toggle pill and other
 * solid-accent-fill UI already use, so the logo always matches whatever
 * "the accent, solid" looks like right now.
 */
export default function BrandMark({ className }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--color-accent-solid-bg)" />
      <path
        d="M26.7 8 L12 22.7 L5.3 16"
        fill="none"
        stroke="var(--color-accent-solid-text)"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
