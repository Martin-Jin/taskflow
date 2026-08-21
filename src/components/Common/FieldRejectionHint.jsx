/**
 * FieldRejectionHint — the message half of useFieldRejection: a compact
 * warning line shown right above (or beside) the input that was rejected.
 *
 * Distinct from .form-error, which is for a *persistent* form-level failure
 * ("Could not create project."). This one is transient and field-scoped, so
 * it's boxed and icon-led to read as "this specific input, right now" and
 * renders nothing at all when there's no message (direction rule 3: never
 * render the absence of information).
 */

import React from 'react';
import { AlertCircle } from 'lucide-react';

export default function FieldRejectionHint({ message, className = '' }) {
  if (!message) return null;
  return (
    <p className={`field-rejection-hint ${className}`.trim()} role="alert">
      <AlertCircle size={12} aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}
