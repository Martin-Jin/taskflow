/**
 * ============================================================================
 * ESTIMATE ACCURACY
 * ============================================================================
 * Compares what tasks were estimated at against what they actually took, so
 * estimates can improve. In a scheduler, bad estimates are the root cause of
 * nearly every bad plan, and nothing in the app previously closed that loop.
 *
 * WHAT COUNTS. Only tasks with BOTH an `estimatedHours` and a numeric
 * `actualHours`. `actualHours` is set in exactly one place — completing a task
 * that had a running Pomodoro timer, confirmed through CompleteTaskConfirmModal
 * (see SchedulerContext.completeTask) — so the sample is small and
 * self-selected, and every consumer of this module is expected to show
 * `sampleSize` alongside any ratio rather than presenting the number bare.
 *
 * AGGREGATE RATIO, not the mean of per-task ratios. Summing hours and dividing
 * once means a 5-minute task that overran to 15 contributes 10 minutes, not a
 * 3.0× data point that drags the average around. The mean-of-ratios version is
 * the more obvious implementation and is badly misleading on exactly the data
 * this app collects: short timer-tracked tasks.
 *
 * DELIBERATELY NOT APPLIED ANYWHERE. This only reports. Auto-padding future
 * estimates from a ratio the user hasn't seen or agreed with would silently
 * change every schedule, and would be near-impossible to reason about when it
 * went wrong. Show it first; automate later, if ever.
 * ============================================================================
 */

/**
 * Below this many samples, a ratio is noise dressed up as insight — one task
 * that ran long would read as "you underestimate by 60%". Callers still get
 * `sampleSize` so they can say how close the user is to having a useful signal.
 */
export const MIN_RELIABLE_SAMPLE = 5;

/** Tasks that can contribute: a real estimate and a real tracked actual. */
function isMeasurable(task) {
  return (
    typeof task?.actualHours === 'number' &&
    task.actualHours > 0 &&
    typeof task.estimatedHours === 'number' &&
    task.estimatedHours > 0
  );
}

/**
 * Estimate accuracy over a set of tasks.
 *
 * @param {import('../types').Task[]} tasks
 * @returns {{sampleSize: number, totalEstimated: number, totalActual: number,
 *            ratio: number|null, isReliable: boolean}}
 *   `ratio` is actual ÷ estimated: above 1 means work takes longer than
 *   estimated. Null when there's nothing to divide.
 */
export function computeEstimateAccuracy(tasks) {
  let totalEstimated = 0;
  let totalActual = 0;
  let sampleSize = 0;

  for (const task of tasks || []) {
    if (!isMeasurable(task)) continue;
    sampleSize += 1;
    totalEstimated += task.estimatedHours;
    totalActual += task.actualHours;
  }

  return {
    sampleSize,
    totalEstimated,
    totalActual,
    ratio: totalEstimated > 0 ? totalActual / totalEstimated : null,
    isReliable: sampleSize >= MIN_RELIABLE_SAMPLE,
  };
}

/**
 * Per-project accuracy, for projects that have any measurable task at all.
 *
 * Sorted by sample size descending, so the projects the user has the most
 * evidence for come first — a project with two samples shouldn't head the list
 * just because its name sorts early.
 *
 * @param {import('../types').Task[]} tasks
 * @param {{id: string, name: string}[]} projects
 * @returns {Array<{projectId: string|null, projectName: string} & ReturnType<typeof computeEstimateAccuracy>>}
 */
export function computeAccuracyByProject(tasks, projects) {
  const byProject = new Map();
  for (const task of tasks || []) {
    if (!isMeasurable(task)) continue;
    const key = task.projectId || null;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(task);
  }

  const rows = [];
  for (const [projectId, projectTasks] of byProject) {
    rows.push({
      projectId,
      projectName: projects?.find((p) => p.id === projectId)?.name || 'No project',
      ...computeEstimateAccuracy(projectTasks),
    });
  }
  return rows.sort((a, b) => b.sampleSize - a.sampleSize);
}

/**
 * Short fragment for a table cell: "about right", "1.5× longer", "1.5× faster".
 * Returns null when there is no ratio to describe.
 *
 * The ±10% dead band matters: without it a 1.03 ratio reads as "you
 * underestimate", which is both untrue and the kind of false precision that
 * makes someone stop trusting the whole panel.
 *
 * The ratio is inverted when work finishes early so the number always reads
 * above 1 — "0.7×" makes the reader do the arithmetic to work out whether
 * that is good news.
 */
export function describeAccuracy(ratio) {
  if (ratio == null) return null;
  if (ratio >= 0.9 && ratio <= 1.1) return 'about right';
  if (ratio > 1.1) return `${ratio.toFixed(1)}× longer`;
  return `${(1 / ratio).toFixed(1)}× faster`;
}

/**
 * Full sentence for the panel headline. Separate from describeAccuracy rather
 * than glued after a fixed prefix: "Your estimates are" + "1.1× longer than
 * estimated" reads as nonsense, and no single fragment works in both a
 * sentence and a table cell.
 */
export function accuracyHeadline(ratio) {
  if (ratio == null) return null;
  if (ratio >= 0.9 && ratio <= 1.1) return 'Your estimates are about right';
  if (ratio > 1.1) return `Work takes ${ratio.toFixed(1)}× longer than you estimate`;
  return `You finish ${(1 / ratio).toFixed(1)}× faster than you estimate`;
}
