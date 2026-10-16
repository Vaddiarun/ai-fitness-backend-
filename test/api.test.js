import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base, token, db;
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const profile = {
  name: 'Priya', age: 29, gender: 'female', height: 162, weight: 66.4, targetWeight: 60, units: 'metric',
  goal: 'lose', activity: 'light', level: 'beginner', location: 'db', days: 4, duration: 45, workoutTime: '18:30',
  conditions: [], cuisine: 'ni', diet: 'veg', meals: 5, allergies: [], wake: '06:30', sleep: '22:30',
};

before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

test('register, then reject a duplicate and a wrong password', async () => {
  const r = await call('POST', '/auth/register', { name: 'Priya', email: 'Priya@Example.com', password: 'secret123' });
  assert.equal(r.status, 201);
  token = r.body.token;
  assert.equal((await call('POST', '/auth/register', { name: 'P', email: 'priya@example.com', password: 'secret123' })).status, 409);
  assert.equal((await call('POST', '/auth/login', { email: 'priya@example.com', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/auth/login', { email: 'priya@example.com', password: 'secret123' })).status, 200);
});

test('plan endpoints ask for a profile first', async () => {
  assert.equal((await call('GET', '/plan')).status, 409);
});

test('profile builds a plan from height, weight and goal', async () => {
  const bad = await call('PUT', '/profile', { ...profile, height: 50 });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.some((f) => f.path === 'height'));

  const r = await call('PUT', '/profile', profile);
  assert.equal(r.status, 200);
  const { nutrition, workouts, meals } = r.body.plan;
  assert.equal(nutrition.kcal, 1510); // Mifflin–St Jeor × 1.375 − 20%
  assert.equal(nutrition.protein, 120); // 1.8 g/kg
  assert.equal(nutrition.bmiCategory, 'Overweight');
  assert.equal(workouts.filter((d) => d.type === 'workout').length, 4);
  const day = workouts.find((d) => d.type === 'workout');
  assert.ok(day.exercises[0].exercise.video.youtubeId, 'exercises carry a tutorial video');
  assert.equal(meals.length, 7);
  assert.equal(meals[0].length, 5);
  assert.ok(meals.flat().every((m) => m.food.c === 'ni' || m.food.c === 'all'), 'meals come from the chosen cuisine');
  assert.ok(meals.flat().every((m) => ['vegan', 'veg'].includes(m.food.d)), 'vegetarian plan has no meat or eggs');
});

test('cuisine switch keeps calories and respects allergies', async () => {
  await call('PUT', '/profile', { ...profile, allergies: ['dairy', 'gluten'] });
  const r = await call('PUT', '/plan/cuisine', { cuisine: 'we' });
  assert.equal(r.status, 200);
  assert.equal(r.body.nutrition.kcal, 1510);
  assert.ok(r.body.meals.flat().every((m) => !m.food.al.includes('dairy') && !m.food.al.includes('gluten')));
  // only one Western breakfast is vegetarian without dairy or gluten, so there is nothing to swap to
  assert.equal((await call('POST', '/plan/meals/swap', { day: 1, index: 0 })).body.swapped, false);
  const lunch = await call('POST', '/plan/meals/swap', { day: 1, index: 2 });
  assert.equal(lunch.body.swapped, true);
  assert.notEqual(lunch.body.meals[1][2].foodId, r.body.meals[1][2].foodId);
});

test('logging a workout feeds history, advice and progress', async () => {
  const today = '2026-10-15', weekday = 4; // a Thursday
  const t = await call('GET', `/today?date=${today}&weekday=${weekday}`);
  assert.equal(t.status, 200);
  const ex = t.body.workout.exercises[0];
  const sets = Array.from({ length: ex.sets }, () => ({ reps: 15, weight: 6, done: true }));
  const w = await call('POST', '/logs/workouts', { date: today, kind: 'plan', name: t.body.workout.name, mins: 42, rpe: 7, feel: 'ok', exercises: [{ id: ex.id, sets }] });
  assert.equal(w.status, 201);
  assert.equal(w.body.volume, 15 * 6 * ex.sets);
  const last = await call('GET', `/exercises/${ex.id}/last`);
  assert.match(last.body.advice, /Add 1–2.5 kg/);
  assert.equal((await call('POST', '/logs/water', { date: today, delta: 2 })).body.glasses, 2);
  await call('POST', '/logs/meals', { date: today, index: 0, eaten: true });
  const t2 = await call('GET', `/today?date=${today}&weekday=${weekday}`);
  assert.equal(t2.body.meals[0].eaten, true);
  assert.equal(t2.body.completed.mins, 42);
  const p = await call('GET', `/progress?date=${today}&weekday=${weekday}`);
  assert.equal(p.body.week.done, 1);
  assert.equal(p.body.streak, 1);
});

test('reminders cover meals, workouts, water and sleep', async () => {
  const r = await call('GET', '/reminders');
  const kinds = new Set(r.body.reminders.map((x) => x.kind));
  for (const k of ['breakfast', 'lunch', 'dinner', 'workout', 'water', 'sleep']) assert.ok(kinds.has(k), k);
  await call('PUT', '/settings', { water: false });
  assert.ok(!(await call('GET', '/reminders')).body.reminders.some((x) => x.kind === 'water'));
});

test('exercise library has the full database with search and filters', async () => {
  const all = await call('GET', '/library/exercises?limit=5');
  assert.ok(all.body.total > 850);
  const chest = await call('GET', '/library/exercises?muscle=chest&equipment=dumbbell');
  assert.ok(chest.body.total > 10 && chest.body.items.every((x) => x.equipment === 'dumbbell'));
  const search = await call('GET', '/library/exercises?q=goblet');
  const goblet = search.body.items.find((x) => x.coachedId === 'goblet');
  assert.ok(goblet.images.length && goblet.video.youtubeId);
  assert.equal((await call('GET', `/library/exercises/${goblet.id}`)).body.name, 'Goblet Squat');
});

test('sets per exercise follow the level: 2 / 3 / 4 / 7', async () => {
  for (const [level, sets] of [['beginner', 2], ['novice', 3], ['intermediate', 4], ['advanced', 7]]) {
    const r = await call('PUT', '/profile', { ...profile, level });
    const all = r.body.plan.workouts.flatMap((d) => d.exercises ?? []);
    assert.ok(all.length && all.every((e) => e.sets === sets), `${level} -> ${sets} sets`);
    const day = r.body.plan.workouts.find((d) => d.type === 'workout');
    assert.ok(day.minutes >= 15 && day.minutes <= 150, `${level} session ${day.minutes} min`);
  }
});

test('plans saved under older rules get their workouts rebuilt on load', async () => {
  await call('PUT', '/profile', { ...profile, level: 'intermediate' });
  const row = db.prepare('SELECT user_id, data FROM plans').get();
  const old = JSON.parse(row.data);
  old.version = 1;
  for (const d of old.workouts) for (const e of d.exercises ?? []) e.sets = 3; // old intermediate rule
  old.meals[0][0].foodId = old.meals[0][1].foodId === 'ni_chana' ? 'ni_makhana' : 'ni_chana'; // a "swap" that must survive
  db.prepare('UPDATE plans SET data = ? WHERE user_id = ?').run(JSON.stringify(old), row.user_id);
  const plan = (await call('GET', '/plan')).body;
  assert.equal(plan.version, 2);
  assert.ok(plan.workouts.flatMap((d) => d.exercises ?? []).every((e) => e.sets === 4));
  assert.equal(plan.meals[0][0].foodId, old.meals[0][0].foodId);
});

test('requests without a token are refused', async () => {
  const saved = token; token = null;
  assert.equal((await call('GET', '/me')).status, 401);
  token = saved;
});
