/** Settings → Help — replays the app-level guided tour (see App.jsx, which owns the tour's open/step state). */

import React from 'react';
import { HelpCircle } from 'lucide-react';

export default function HelpSection({ sectionRef, onOpenTour }) {
  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Help</h3>
      <button className="btn settings-inline" onClick={onOpenTour}>
        <HelpCircle size={14} />
        Replay guided tour
      </button>
    </div>
  );
}
