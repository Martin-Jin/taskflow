/** Settings → Versions — opens ChangelogModal ("What's new"), same content shown automatically on a version bump. */

import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';
import ChangelogModal from '../../Modals/ChangelogModal';
import { CURRENT_VERSION } from '../../../changelog';

export default function VersionsSection({ sectionRef }) {
  const [showChangelogModal, setShowChangelogModal] = useState(false);

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Versions</h3>
      <p className="settings-hint">See what changed in each update to TaskFlow — currently v{CURRENT_VERSION}.</p>
      <button className="btn settings-inline" onClick={() => setShowChangelogModal(true)}>
        <Sparkles size={14} />
        What's new
      </button>
      {showChangelogModal && <ChangelogModal onClose={() => setShowChangelogModal(false)} />}
    </div>
  );
}
