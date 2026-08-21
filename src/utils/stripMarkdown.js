/**
 * stripMarkdown — turns a note's markdown body into clean prose for the
 * collapsed note-tile preview (NotesCard), which shows one plain line of
 * text rather than raw markdown syntax (a tile reading "## Groceries" or
 * "- [ ] milk" would look broken, not formatted). The full-fidelity
 * rendering lives in NoteEditorModal's Tiptap instance — this is only ever
 * used for the plain-text preview line, never for anything editable.
 *
 * Deliberately regex-based rather than pulling in a markdown parser for
 * this one preview-only use — the transformations are simple, order-
 * independent substitutions (strip a syntax marker, keep the text next to
 * it), not anything that needs a real AST.
 */
export function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '') // task list checkboxes
    .replace(/^\s*[-*+]\s+/gm, '') // bullet list markers
    .replace(/^\s*\d+\.\s+/gm, '') // ordered list markers
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim()) // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/~~(.*?)~~/g, '$1') // strikethrough
    .replace(/^\s*-{3,}\s*$/gm, '') // horizontal rules
    .replace(/[ \t]+/g, ' ')
    .trim();
}
