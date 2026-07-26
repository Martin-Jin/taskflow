import React, { useMemo } from 'react';
import { linkify } from '../../utils/linkify';

/** Renders text with any http(s)/www URLs turned into clickable links. */
export default function Linkified({ text, className }) {
  // Notes/descriptions render live under an editable textarea, so this
  // re-runs on every keystroke otherwise — memoize on the text itself.
  const segments = useMemo(() => linkify(text), [text]);
  if (!segments.some((seg) => seg.type === 'link')) return null;

  return (
    <div className={className}>
      {segments.map((seg, i) =>
        seg.type === 'link' ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer">
            {seg.value}
          </a>
        ) : (
          <React.Fragment key={i}>{seg.value}</React.Fragment>
        )
      )}
    </div>
  );
}
