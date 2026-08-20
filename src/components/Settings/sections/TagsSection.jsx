/** Settings → Tags — opens LabelsModal, the full list of every tag in use across all tasks. */

import React, { useState } from 'react';
import { Tag } from 'lucide-react';
import LabelsModal from '../../Modals/LabelsModal';

export default function TagsSection({ sectionRef }) {
  const [showLabelsModal, setShowLabelsModal] = useState(false);

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Tags</h3>
      <p className="settings-hint">See every tag you've created across all tasks, with how many tasks currently carry each one.</p>
      <button className="btn settings-inline" onClick={() => setShowLabelsModal(true)}>
        <Tag size={14} />
        View all tags
      </button>
      {showLabelsModal && <LabelsModal onClose={() => setShowLabelsModal(false)} />}
    </div>
  );
}
