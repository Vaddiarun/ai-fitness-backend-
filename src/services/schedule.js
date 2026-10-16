import { FOOD_BY_ID, EXERCISES } from '../data/index.js';
import { toMinutes } from './planEngine.js';

const KIND = { b: 'breakfast', s: 'snack', l: 'lunch', d: 'dinner' };

/**
 * Weekly reminder schedule the app turns into repeating local notifications.
 * `minute` is minutes after midnight (can exceed 1440 for late meals; the app wraps it).
 */
export function weeklyReminders(profile, plan, settings) {
  const out = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    if (settings.meals) plan.meals[weekday].forEach((m, i) => {
      const f = FOOD_BY_ID.get(m.foodId);
      out.push({ id: `meal-${weekday}-${i}`, weekday, minute: m.minute, kind: KIND[m.slot],
        title: `${m.name} time`, body: `${f.n} · ${Math.round(f.k * m.portion)} kcal` });
    });
    const day = plan.workouts[weekday];
    if (settings.workout && day.type === 'workout') {
      const at = toMinutes(profile.workoutTime);
      out.push({ id: `workout-pre-${weekday}`, weekday, minute: at - 15, kind: 'workout',
        title: 'Workout in 15 minutes', body: `${day.name} · ${day.exercises.length} exercises. Fill your water bottle.` });
      out.push({ id: `workout-${weekday}`, weekday, minute: at, kind: 'workout',
        title: `Time for ${day.name}`, body: `Start with ${EXERCISES[day.exercises[0].id].name}. Tap to begin.` });
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
