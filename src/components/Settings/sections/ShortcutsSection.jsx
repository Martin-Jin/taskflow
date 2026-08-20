/** Settings → Keyboard shortcuts — opens ShortcutsModal, the full rebindable shortcut list. */

import React, { useState } from 'react';
import { Keyboard } from 'lucide-react';
import ShortcutsModal from '../../Modals/ShortcutsModal';

export default function ShortcutsSection({ sectionRef }) {
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Keyboard shortcuts</h3>
      <p className="settings-hint">See every shortcut TaskFlow supports and customize its key combo.</p>
      <button className="btn settings-inline" onClick={() => setShowShortcutsModal(true)}>
        <Keyboard size={14} />
        View shortcuts
      </button>
      {showShortcutsModal && <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />}
    </div>
  );
}
