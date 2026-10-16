import { EXERCISES } from '../data/index.js';
import { foodOf, toMinutes } from './planEngine.js';

const KIND = { b: 'breakfast', s: 'snack', l: 'lunch', d: 'dinner', x: 'protein' };

const clock = (minute) => {
  const m = ((minute % 1440) + 1440) % 1440, h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

/** "3×12 @ 20 kg" from the best completed set of the last log, or null if there's nothing to quote. */
function lastLine(last, unit) {
  const done = last?.sets?.filter((s) => s.done) ?? [];
  if (!done.length) return null;
  const top = done.reduce((a, b) => ((b.weight || 0) > (a.weight || 0) ? b : a));
  return `${done.length}×${top.reps ?? '–'}${top.weight ? ` @ ${top.weight} ${unit}` : ''}`;
}

/** The next workout day after `weekday`, wrapping round the week. */
function nextWorkout(plan, weekday) {
  for (let i = 1; i <= 7; i++) {
    const day = plan.workouts[(weekday + i) % 7];
    if (day.type === 'workout') return { day, inDays: i };
  }
  return null;
}

/**
 * Weekly reminder schedule the app turns into repeating local notifications.
 * `minute` is minutes after midnight (can exceed 1440 for late meals; the app wraps it).
 * `lastFor(exerciseId)` returns the user's last logged sets for an exercise, so workout reminders can quote them.
 */
export function weeklyReminders(profile, plan, settings, lastFor = () => null) {
  const unit = profile.units === 'imperial' ? 'lb' : 'kg';
  const out = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    if (settings.meals) plan.meals[weekday].forEach((m, i) => {
      const f = foodOf(m);
      out.push({ id: `meal-${weekday}-${i}`, weekday, minute: m.minute, kind: KIND[m.slot],
        title: `${m.name} time`, body: `${f.n} · ${Math.round(f.k * m.portion)} kcal` });
    });
    const day = plan.workouts[weekday];
    if (settings.workout && day.type === 'workout') {
      const at = toMinutes(profile.workoutTime);
      const first = day.exercises[0], firstName = EXERCISES[first.id].name;
      const beat = lastLine(lastFor(first.id), unit);
      out.push({ id: `workout-pre-${weekday}`, weekday, minute: at - 15, kind: 'workout',
        title: `${day.name} at ${clock(at)}`, body: `${day.exercises.length} exercises, about ${day.minutes ?? 45} min. Fill your water bottle.` });
      out.push({ id: `workout-${weekday}`, weekday, minute: at, kind: 'workout',
        title: `Time for ${day.name}`,
        body: beat ? `Last time: ${firstName} ${beat}. Beat it today.` : `Start with ${firstName}. Tap to begin.` });
    } else if (settings.workout && day.type === 'rest') {
      const next = nextWorkout(plan, weekday);
      out.push({ id: `rest-${weekday}`, weekday, minute: toMinutes(profile.wake) + 60, kind: 'workout',
        title: 'Recovery day: your streak is safe',
        body: `Stretch for 20 min and walk 7,000 steps.${next ? ` ${next.inDays === 1 ? 'Tomorrow' : 'Next up'}: ${next.day.name}.` : ''}` });
    }
    if (settings.water) {
      const wake = toMinutes(profile.wake);
      let sleep = toMinutes(profile.sleep);
      if (sleep < wake) sleep += 1440;
      for (let t = wake + 120; t <= sleep - 60; t += 120) {
        out.push({ id: `water-${weekday}-${t}`, weekday, minute: t, kind: 'water',
          title: 'Drink a glass of water', body: `Aim for ${plan.nutrition.waterGlasses} glasses today.` });
      }
    }
    if (settings.sleep) out.push({ id: `sleep-${weekday}`, weekday, minute: toMinutes(profile.sleep) - 30, kind: 'sleep',
      title: 'Wind down for sleep', body: 'Screens off in 30 minutes. 7–9 hours helps recovery.' });
  }
  return out;
}
