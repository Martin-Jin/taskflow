/**
 * shiftEnterHandler — builds the keydown handler behind the "Shift+Enter saves
 * everything and closes" shortcut used by the add-task, task-detail and event
 * modals.
 *
 * Skips a press that an inner control already handled (e.g. a suggestion
 * popup accepting it) and anything inside a rich-text editor, where
 * Shift+Enter is a line break. Otherwise it cancels the default action (so a
 * text box doesn't also get a newline) and runs `save`.
 */
export function shiftEnterHandler(save) {
  return (e) => {
    if (e.key !== 'Enter' || !e.shiftKey || e.defaultPrevented || e.nativeEvent?.isComposing) return;
    if (e.target?.isContentEditable) return;
    e.preventDefault();
    save();
  };
}
