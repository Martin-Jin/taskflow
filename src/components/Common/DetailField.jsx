/**
 * DetailField — one labeled row in a detail modal's metadata sidebar
 * (Project, Date, Priority, Labels, ...), pairing a small icon+caption with
 * its control. Purely a layout wrapper — see `.detail-field` in
 * styles/forms.css for the hairline-separated look this produces.
 */

import React from 'react';

export default function DetailField({ icon: Icon, label, children }) {
  return (
    <div className="detail-field">
      <div className="detail-field-label">
        {Icon && <Icon size={12} />}
        <span>{label}</span>
      </div>
      <div className="detail-field-value">{children}</div>
    </div>
  );
}
