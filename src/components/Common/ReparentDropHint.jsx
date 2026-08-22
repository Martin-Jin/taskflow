/**
 * The "Make sub-task of X" label shown on whichever card/row a reparent drag
 * is currently hovering (see hooks/useReparentDrag.js). Shared by BoardView's
 * cards and TaskListPanel's rows so the wording and treatment can't drift —
 * and so it stays visually distinct from Board's section-drop highlight, which
 * tints a whole column body instead of labelling one card.
 *
 * Overlaid (absolutely positioned) rather than inserted into the flow: growing
 * the card/row mid-drag would shift everything below it out from under the
 * user's cursor/finger.
 */

import React from 'react';
import { CornerDownRight } from 'lucide-react';

export default function ReparentDropHint({ parentTitle }) {
  return (
    <div className="reparent-drop-hint" aria-hidden="true">
      <CornerDownRight size={12} />
      <span className="reparent-drop-hint-text">Make sub-task of “{parentTitle}”</span>
    </div>
  );
}
