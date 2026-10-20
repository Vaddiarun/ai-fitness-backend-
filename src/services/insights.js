import { EXERCISES } from '../data/index.js';
import { addDays, weekdayOf, weekStart } from './progress.js';

export const RANGES = { '30': 30, '90': 90, '365': 365 };

const monthKey = (iso) => iso.slice(0, 7);

/**
 * Everything the Progress charts need for one member over a range, ending on `today` (their local date).
 * `full` is the expanded plan (meals with kcal/protein, dayNutrition targets); logs are raw rows.
 * Amounts the member typed (weights, volume) stay in their own units.
 */
export function buildInsights({ today, days, full, startedOn, workouts, weights, meals, water }) {
  // Start at the range start or when the account began, whichever is later, so new members don't see empty months.
  const rangeStart = addDays(today, -(days - 1));
  const from = startedOn && startedOn > rangeStart ? startedOn : rangeStart;
  const dates = [];
  for (let d = from; d <= today; d = addDays(d, 1)) dates.push(d);
  const inRange = (r) => r.date >= from && r.date <= today;

  /* ---------- strength: best set per session for each exercise ---------- */
  const byExercise = new Map();
  for (const w of workouts.filter(inRange)) {
    for (const e of w.exercises) {
      const done = (e.sets ?? []).filter((s) => s.done);
      if (!done.length) continue;
      const weight = Math.max(0, ...done.map((s) => Number(s.weight) || 0));
      const reps = Math.max(0, ...done.map((s) => Number(s.reps) || 0));
      const list = byExercise.get(e.id) ?? [];
      list.push({ date: w.date, weight, reps, sets: done.length });
      byExercise.set(e.id, list);
    }
  }
  const strength = [...byExercise.entries()]
    .map(([id, points]) => {
      points.sort((a, b) => a.date.localeCompare(b.date));
      const weighted = points.some((p) => p.weight > 0);
      return { id, name: EXERCISES[id]?.name ?? id, metric: weighted ? 'weight' : 'reps', sessions: points.length, points };
    })
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));

  /* ---------- training load per month (always the last 12 months) ---------- */
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  const load = months.map((m) => {
    const ws = workouts.filter((w) => monthKey(w.date) === m);
    return { month: m, volume: Math.round(ws.reduce((s, w) => s + (w.volume || 0), 0)), sessions: ws.filter((w) => w.kind === 'plan').length, mins: ws.reduce((s, w) => s + (w.mins || 0), 0) };
  });

  /* ---------- nutrition per day: what was eaten vs that day's target ---------- */
  const mealsOn = new Map();
  for (const m of meals.filter(inRange)) {
    const list = mealsOn.get(m.date) ?? [];
    list.push(m);
    mealsOn.set(m.date, list);
  }
  const nutrition = dates.map((date) => {
    const wd = weekdayOf(date);
    const planned = full.meals[wd] ?? [];
    let kcal = 0, protein = 0;
    for (const log of mealsOn.get(date) ?? []) {
      const status = log.status ?? 'eaten';
      if (status === 'skipped') continue;
      // Eaten meals carry the kcal/protein saved when ticked; older ticks fall back to today's plan for that slot.
      kcal += log.kcal ?? (status === 'eaten' ? planned[log.slot_index]?.kcal ?? 0 : 0);
      protein += log.protein ?? (status === 'eaten' ? planned[log.slot_index]?.protein ?? 0 : 0);
    }
    const target = full.dayNutrition?.[wd] ?? full.nutrition;
    return { date, kcal: Math.round(kcal), protein: Math.round(protein), kcalTarget: target.kcal, proteinTarget: target.protein, logged: mealsOn.has(date) };
  });

  /* ---------- weekly: meal adherence and workouts ---------- */
  const weeks = [];
  for (const date of dates) {
    const ws = weekStart(date);
    if (!weeks.length || weeks.at(-1).week !== ws) weeks.push({ week: ws, days: [] });
    weeks.at(-1).days.push(date);
  }
  const adherence = weeks.map(({ week, days: ds }) => {
    const logs = ds.flatMap((d) => mealsOn.get(d) ?? []);
    const count = (s) => logs.filter((l) => (l.status ?? 'eaten') === s).length;
    const planned = ds.reduce((s, d) => s + (full.meals[weekdayOf(d)]?.length ?? 0), 0);
    const eaten = count('eaten'), cheated = count('cheated'), skipped = count('skipped');
    return { week, planned, eaten, cheated, skipped, notLogged: Math.max(0, planned - eaten - cheated - skipped) };
  });
  const training = weeks.map(({ week, days: ds }) => {
    const ws = workouts.filter((w) => w.date >= ds[0] && w.date <= ds.at(-1));
    return {
      week,
      planned: ds.filter((d) => full.workouts[weekdayOf(d)]?.type === 'workout').length,
      done: new Set(ws.filter((w) => w.kind === 'plan').map((w) => w.date)).size,
      mins: ws.reduce((s, w) => s + (w.mins || 0), 0),
    };
  });

  /* ---------- body weight and water ---------- */
  const bodyWeight = weights.filter(inRange).map((w) => ({ date: w.date, kg: w.kg }));
  const waterByDate = new Map(water.map((w) => [w.date, w.glasses]));
  const hydration = dates.map((date) => ({ date, glasses: waterByDate.get(date) ?? 0, target: (full.dayNutrition?.[weekdayOf(date)] ?? full.nutrition).waterGlasses }));

  return { range: { from, to: today, days }, strength, load, nutrition, adherence, training, bodyWeight, water: hydration };
}
