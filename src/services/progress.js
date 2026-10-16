import { EXERCISES } from '../data/index.js';

/** Date-only arithmetic on YYYY-MM-DD strings, independent of the server's timezone. */
export const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};
export const weekdayOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

export function volumeOf(exercises) {
  return exercises.reduce((sum, e) => sum + (EXERCISES[e.id]?.timed ? 0
    : e.sets.reduce((s, set) => s + (set.done ? (set.reps || 0) * (set.weight || 0) : 0), 0)), 0);
}

/** Consecutive planned workout days completed, counting back from today (today doesn't break it yet). */
export function streak(plan, workoutDates, today) {
  let count = 0;
  for (let i = 0; i < 120; i++) {
    const date = addDays(today, -i);
    if (plan.workouts[weekdayOf(date)].type !== 'workout') continue;
    if (workoutDates.has(date)) count++;
    else if (i > 0) break;
  }
  return count;
}

/** Heaviest weight and most reps in any completed set of one exercise. */
function bestOf(sets) {
  const done = sets.filter((s) => s.done);
  return { weight: Math.max(0, ...done.map((s) => s.weight || 0)), reps: Math.max(0, ...done.map((s) => s.reps || 0)) };
}

/**
 * Personal records set by a new workout, compared with every earlier log of the same exercise.
 * Weight PRs need a previous log to beat; first-ever sessions aren't counted as records.
 */
export function personalRecords(exercises, previousLogs) {
  const prs = [];
  for (const e of exercises) {
    const ex = EXERCISES[e.id];
    if (!ex) continue;
    const before = previousLogs.flatMap((w) => w.exercises.filter((x) => x.id === e.id));
    if (!before.length) continue;
    const now = bestOf(e.sets);
    const prev = before.reduce((b, x) => { const o = bestOf(x.sets); return { weight: Math.max(b.weight, o.weight), reps: Math.max(b.reps, o.reps) }; }, { weight: 0, reps: 0 });
    if (!ex.timed && now.weight > prev.weight && now.weight > 0) prs.push({ id: e.id, name: ex.name, kind: 'weight', value: now.weight, previous: prev.weight });
    else if (now.reps > prev.reps && now.reps > 0) prs.push({ id: e.id, name: ex.name, kind: ex.timed ? 'seconds' : 'reps', value: now.reps, previous: prev.reps });
  }
  return prs;
}

/** Planned sessions, minutes and volume for logs in [from, to]. */
export function weekSummary(logs, from, to) {
  const inWeek = logs.filter((w) => w.date >= from && w.date <= to);
  return {
    done: inWeek.filter((w) => w.kind === 'plan').length,
    mins: inWeek.reduce((s, w) => s + w.mins, 0),
    volume: Math.round(inWeek.reduce((s, w) => s + w.volume, 0)),
  };
}

/** Monday-based week containing `today`. */
export const weekStart = (today) => addDays(today, -((weekdayOf(today) + 6) % 7));

/** Progression hint shown before an exercise, from the last time it was logged. */
export function advice(prescription, last, units = 'metric') {
  const bump = units === 'imperial' ? '2.5–5 lb' : '1–2.5 kg';
  if (!last) return 'First time: pick a weight you could lift 2–3 more times than the target.';
  const done = last.sets.filter((s) => s.done);
  if (prescription.seconds) return 'Try to hold 5 seconds longer per set than last time.';
  const top = Number(String(prescription.reps).split('-').pop());
  const hitTop = done.length === last.sets.length && done.every((s) => (s.reps || 0) >= top);
  return hitTop ? `You hit the top of the range last time. Add ${bump} or 2 reps today.` : 'Aim for one more rep than last time.';
}
