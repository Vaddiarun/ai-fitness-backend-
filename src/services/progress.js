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
