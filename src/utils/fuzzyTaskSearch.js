/**
 * Fuzzy search over task titles, shared by the command palette's Tasks group
 * and the "Schedule task" picker in EventDetailModal.
 *
 * Why not nameSearch.js's rankByNameSearch: task titles are long, multi-word
 * free text. This scorer's streak-weighted subsequence matching (a tighter,
 * denser match ranks above a scattered one) suits that, whereas
 * rankByNameSearch is tuned for short names (projects, views, actions) and
 * would rank long titles worse.
 *
 * An exact substring match always outranks a scattered one, and among
 * substring matches an earlier one wins. A title that doesn't contain the
 * query's letters in order scores -Infinity so callers can filter it out.
 */
export function fuzzyScore(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return -Infinity;
    streak = found === ti ? streak + 1 : 0;
    score += streak * 2 - (found - ti);
    ti = found + 1;
  }
  return score;
}

export function fuzzyFilterTasks(items, query, toText) {
  if (!query) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(toText(item), query) }))
    .filter((r) => r.score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}

