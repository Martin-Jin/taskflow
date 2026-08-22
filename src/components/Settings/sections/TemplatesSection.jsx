/**
 * Settings → Templates — the place templates are visible from, and the second
 * route to using one.
 *
 * WHY THIS EXISTS. Templates were originally reachable only through the
 * command palette's "New from template", with management folded into that same
 * picker. That's defensible for management but not for DISCOVERY: a template
 * you saved was then invisible unless you already knew a keyboard shortcut,
 * which made "save as template" feel like it had thrown the work away. Settings
 * is where the app already answers "what have I created?" for tags and
 * routines, so templates belong alongside them.
 *
 * It shows the count rather than duplicating the list, then opens the same
 * NewFromTemplateModal the palette does — one picker, one place the rows and
 * their delete buttons are maintained, reached from two places.
 */

import React, { useState } from 'react';
import { FileStack } from 'lucide-react';
import { useScheduler } from '../../../context/SchedulerContext';
import NewFromTemplateModal from '../../Modals/NewFromTemplateModal';
import { MAX_TEMPLATES } from '../../../utils/taskTemplates';

export default function TemplatesSection({ sectionRef, activeProjectId, onNavigateToTasks }) {
  const { taskTemplates, setTaskTemplates, instantiateTemplate, projects, setNotification } = useScheduler();
  const [showPicker, setShowPicker] = useState(false);
  const count = (taskTemplates || []).length;

  return (
    <div className="card settings-card" data-tour="templates-card" ref={sectionRef}>
      <h3>Templates</h3>
      <p className="settings-hint">
        A template saves a task and its sub-tasks — estimates, dependencies and the spacing between their due dates —
        so a process you repeat can be rebuilt in one step. Save one from any task's "⋯" menu; the dates are stored as
        spacing, so you pick a start date each time you use it. You can keep up to {MAX_TEMPLATES}.
      </p>
      <button className="btn settings-inline" onClick={() => setShowPicker(true)}>
        <FileStack size={14} />
        {count === 0 ? 'No templates yet' : `View ${count} template${count === 1 ? '' : 's'}`}
      </button>
      {showPicker && (
        <NewFromTemplateModal
          templates={taskTemplates}
          projects={projects}
          activeProjectId={projects.some((p) => p.id === activeProjectId) ? activeProjectId : ''}
          onInstantiate={(template, options) => {
            const created = instantiateTemplate(template, options);
            // Creating tasks from Settings would otherwise leave the user
            // looking at Settings, with no sign anything happened.
            onNavigateToTasks?.();
            setNotification({
              type: 'success',
              message: `Created ${created.length} task${created.length === 1 ? '' : 's'} from "${template.name}".`,
            });
          }}
          onDeleteTemplate={(id) => setTaskTemplates((prev) => prev.filter((t) => t.id !== id))}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
