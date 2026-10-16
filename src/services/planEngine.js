import { EXERCISES, POOLS, TEMPLATES, SPLITS, FOODS, FOOD_BY_ID } from '../data/index.js';

const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725 };
const GOAL_ADJ = { lose: -0.2, muscle: 0.1, strength: 0.05, fit: 0, maintain: 0 };
const PROTEIN_PER_KG = { lose: 1.8, muscle: 2, strength: 1.8, fit: 1.5, maintain: 1.4 };
const REPS = { lose: ['12-15', 45], muscle: ['8-12', 75], strength: ['5-8', 120], fit: ['10-12', 60], maintain: ['10-12', 60] };
const DIET_RANK = { vegan: 0, veg: 1, egg: 2, nonveg: 3 };
/** Bump when workout rules change; older saved plans get their workouts rebuilt on next load. */
export const PLAN_VERSION = 2;

/** Sets for every exercise in a session, by experience level. */
export const SETS_BY_LEVEL = { beginner: 2, novice: 3, intermediate: 4, advanced: 7 };
const HOLD_SECONDS = { beginner: 30, novice: 35, intermediate: 40, advanced: 50 };
const ALLOWED_EQUIPMENT = { gym: ['gym', 'db', 'none'], db: ['db', 'none'], none: ['none'] };
export const MEAL_SLOTS = {
  3: [['b', 'Breakfast', 0.3], ['l', 'Lunch', 0.4], ['d', 'Dinner', 0.3]],
  4: [['b', 'Breakfast', 0.25], ['l', 'Lunch', 0.35], ['s', 'Evening snack', 0.1], ['d', 'Dinner', 0.3]],
  5: [['b', 'Breakfast', 0.25], ['s', 'Mid-morning snack', 0.1], ['l', 'Lunch', 0.3], ['s', 'Evening snack', 0.1], ['d', 'Dinner', 0.25]],
};

const round1 = (n) => Math.round(n * 10) / 10;
export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Calories, macros, water and body numbers from height (cm), weight (kg), age, sex, activity and goal. */
export function nutrition(p) {
  const w = p.weight, h = p.height;
  const sexOffset = p.gender === 'male' ? 5 : p.gender === 'female' ? -161 : -78;
  const bmr = 10 * w + 6.25 * h - 5 * p.age + sexOffset; // Mifflin–St Jeor
  const tdee = bmr * (ACTIVITY[p.activity] ?? 1.375);
  const adj = GOAL_ADJ[p.goal] ?? 0;
  const floor = p.gender === 'male' ? 1500 : 1200;
  const kcal = Math.max(Math.round((tdee * (1 + adj)) / 10) * 10, floor);
  const protein = Math.round(w * (PROTEIN_PER_KG[p.goal] ?? 1.5));
  const fat = Math.round((kcal * 0.25) / 9);
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const water = Math.min(16, Math.max(8, Math.round((w * 35) / 250)));
  const hm = h / 100, bmi = w / (hm * hm);
  const category = bmi < 18.5 ? 'Underweight' : bmi < 25 ? 'Healthy' : bmi < 30 ? 'Overweight' : 'Obese';
  let eta = null;
  if (p.targetWeight) {
    const diff = w - p.targetWeight;
    if (diff > 0.4) eta = { direction: 'lose', kgPerWeek: 0.5, weeks: Math.ceil(diff / 0.5) };
    else if (diff < -0.4) eta = { direction: 'gain', kgPerWeek: 0.25, weeks: Math.ceil(-diff / 0.25) };
  }
  return {
    bmr: Math.round(bmr), tdee: Math.round(tdee), adjustment: adj, kcal, protein, carbs, fat, waterGlasses: water,
    bmi: round1(bmi), bmiCategory: category, healthyWeightKg: [round1(18.5 * hm * hm), round1(24.9 * hm * hm)], eta,
  };
}

function pickExercise(slot, p) {
  const allowed = ALLOWED_EQUIPMENT[p.location];
  let id = (POOLS[slot] || []).find((x) => allowed.includes(EXERCISES[x].equipment)) || 'plank';
  const c = p.conditions || [];
  const newer = p.level === 'beginner' || p.level === 'novice';
  if (newer && id === 'backsquat') id = 'legpress';
  if (newer && id === 'bench') id = 'machinepress';
  if (c.includes('knee') && ['lunge', 'dblunge', 'stepup'].includes(id)) id = 'glutebridge';
  if (c.includes('back') && ['backsquat', 'rdl'].includes(id)) id = allowed.includes('gym') ? 'legpress' : 'glutebridge';
  return id;
}

function prescription(p, id) {
  const [reps, rest] = REPS[p.goal];
  const sets = SETS_BY_LEVEL[p.level];
  if (EXERCISES[id].timed) return { id, sets, seconds: HOLD_SECONDS[p.level], rest: 40 };
  return { id, sets, reps, rest };
}

/** Realistic session length: ~40 s per set of reps (or the hold time) plus rest, plus 10 min warm-up and cool-down. */
export function sessionMinutes(exercises) {
  const secs = exercises.reduce((t, e) => t + e.sets * ((e.seconds ?? 40) + e.rest), 0);
  return Math.round((secs / 60 + 10) / 5) * 5;
}

/** 7 entries indexed by JS weekday (0 = Sunday). */
export function workoutWeek(p) {
  const split = SPLITS[p.days] || SPLITS[3];
  const perSession = { 30: 4, 45: 5, 60: 6 }[p.duration] || 5;
  const week = [];
  for (let d = 0; d < 7; d++) {
    const key = split[d];
    if (!key) {
      week.push({ type: 'rest', name: 'Recovery day', focus: 'Stretch, then walk 20–30 min' });
      continue;
    }
    const t = TEMPLATES[key];
    const seen = new Set(), exercises = [];
    for (const slot of t.slots) {
      if (exercises.length >= perSession) break;
      const id = pickExercise(slot, p);
      if (seen.has(id)) continue;
      seen.add(id);
      exercises.push(prescription(p, id));
    }
    if (p.goal === 'lose' || p.goal === 'fit') {
      const id = (p.conditions || []).includes('knee') ? 'march' : 'highknees';
      exercises.push({ id, sets: SETS_BY_LEVEL[p.level], seconds: 30, rest: 30, finisher: true });
    }
    week.push({ type: 'workout', key, name: t.name, focus: t.focus, minutes: sessionMinutes(exercises), exercises });
  }
  return week;
}

/** Dishes for a meal slot that fit the user's cuisine, diet and allergies, ordered for their goal. */
export function foodsFor(p, slot) {
  const rank = DIET_RANK[p.diet], allergies = p.allergies || [];
  const fits = (f) => f.s === slot && DIET_RANK[f.d] <= rank;
  const safe = (f) => !f.al.some((a) => allergies.includes(a));
  const local = (f) => f.c === p.cuisine || (slot === 's' && f.c === 'all');
  // Never relax allergies before cuisine: a safe dish from another cuisine beats an unsafe local one.
  let list = FOODS.filter((f) => fits(f) && safe(f) && local(f));
  if (!list.length) list = FOODS.filter((f) => fits(f) && safe(f));
  if (!list.length) list = FOODS.filter((f) => fits(f) && local(f));
  if (p.goal === 'lose') list.sort((a, b) => b.p / b.k - a.p / a.k);
  else if (p.goal === 'muscle' || p.goal === 'strength') list.sort((a, b) => b.p - a.p);
  return list;
}

export function mealTimes(p) {
  const wake = toMinutes(p.wake);
  let sleep = toMinutes(p.sleep);
  if (sleep < wake) sleep += 1440;
  const dinner = Math.min(wake + 750, sleep - 150);
  if (p.meals === 3) return [wake + 60, wake + 330, dinner];
  if (p.meals === 4) return [wake + 60, wake + 330, wake + 540, dinner];
  return [wake + 60, wake + 195, wake + 330, wake + 540, dinner];
}

export function portion(food, name, slot, minute, targetKcal) {
  const mult = Math.min(2, Math.max(0.5, Math.round((targetKcal / food.k) * 4) / 4));
  return { slot, name, minute, foodId: food.id, portion: mult, targetKcal: Math.round(targetKcal) };
}

/** 7 days × meals, indexed by JS weekday. */
export function mealWeek(p, nut) {
  const slots = MEAL_SLOTS[p.meals] || MEAL_SLOTS[4];
  const times = mealTimes(p);
  const days = [];
  for (let d = 0; d < 7; d++) {
    let snackNo = 0;
    days.push(slots.map(([slot, name, share], i) => {
      const list = foodsFor(p, slot);
      const offset = slot === 's' ? snackNo++ * 2 : 0;
      return portion(list[(d + offset) % list.length], name, slot, times[i], nut.kcal * share);
    }));
  }
  return days;
}

export function swapMeal(p, meal) {
  const list = foodsFor(p, meal.slot);
  const next = list[(list.findIndex((f) => f.id === meal.foodId) + 1) % list.length];
  return portion(next, meal.name, meal.slot, meal.minute, meal.targetKcal);
}

export function generatePlan(p) {
  const nut = nutrition(p);
  return { version: PLAN_VERSION, generatedAt: new Date().toISOString(), nutrition: nut, workouts: workoutWeek(p), meals: mealWeek(p, nut) };
}

/** Adds exercise and dish details so the app can render a plan without its own copy of the library. */
export function expandPlan(plan) {
  return {
    ...plan,
    workouts: plan.workouts.map((day) => day.type === 'rest' ? day : {
      ...day,
      exercises: day.exercises.map((e) => ({ ...e, exercise: EXERCISES[e.id] })),
    }),
    meals: plan.meals.map((day) => day.map((m) => {
      const f = FOOD_BY_ID.get(m.foodId);
      return { ...m, food: f, kcal: Math.round(f.k * m.portion), protein: Math.round(f.p * m.portion) };
    })),
  };
}
