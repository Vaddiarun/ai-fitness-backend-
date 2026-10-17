import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

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
  db = await openDb({ url: ':memory:' });
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
  assert.equal(workouts.filter((d) => d.type === 'workout').length, 5);
  const day = workouts.find((d) => d.type === 'workout');
  assert.ok(day.exercises[0].exercise.video.youtubeId, 'exercises carry a tutorial video');
  assert.equal(meals.length, 7);
  // 5 meals a day, plus a protein top-up on days the dishes alone fall short
  assert.ok(meals.every((d) => d.filter((m) => m.slot !== 'x').length === 5));
  for (const d of meals) {
    const kcal = d.reduce((s, m) => s + m.kcal, 0), protein = d.reduce((s, m) => s + m.protein, 0);
    assert.ok(protein >= nutrition.protein * 0.95, `day protein ${protein} reaches ${nutrition.protein}`);
    assert.ok(Math.abs(kcal - nutrition.kcal) <= nutrition.kcal * 0.15, `day kcal ${kcal} near ${nutrition.kcal}`);
  }
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
  const today = '2026-10-14', weekday = 3; // a Wednesday (leg day)
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

test('every plan trains 5 days with Thursday and Sunday off, whatever days the client sends', async () => {
  for (const days of [2, 4, 6]) {
    const r = await call('PUT', '/profile', { ...profile, days });
    assert.equal(r.body.profile.days, 5);
    const rest = r.body.plan.workouts.flatMap((d, weekday) => (d.type === 'rest' ? [weekday] : []));
    assert.deepEqual(rest, [0, 4], `days=${days}`);
  }
  const { days: _omitted, ...withoutDays } = profile;
  assert.equal((await call('PUT', '/profile', withoutDays)).status, 200);
  assert.equal((await call('GET', '/me')).body.profile.days, 5);
});

test('plans saved under older rules get their workouts rebuilt on load', async () => {
  await call('PUT', '/profile', { ...profile, level: 'intermediate' });
  const row = await db.prepare('SELECT user_id, data FROM plans').get();
  const old = JSON.parse(row.data);
  old.version = 1;
  for (const d of old.workouts) for (const e of d.exercises ?? []) e.sets = 3; // old intermediate rule
  old.meals[0][0].foodId = old.meals[0][1].foodId === 'ni_chana' ? 'ni_makhana' : 'ni_chana'; // a "swap" that must survive
  await db.prepare('UPDATE plans SET data = ? WHERE user_id = ?').run(JSON.stringify(old), row.user_id);
  const plan = (await call('GET', '/plan')).body;
  assert.equal(plan.version, 3);
  assert.ok(plan.workouts.flatMap((d) => d.exercises ?? []).every((e) => e.sets === 4));
  assert.equal(plan.meals[0][0].foodId, old.meals[0][0].foodId);
});

test('requests without a token are refused', async () => {
  const saved = token; token = null;
  assert.equal((await call('GET', '/me')).status, 401);
  token = saved;
});

test('rest days can be moved; workouts follow and meals stay', async () => {
  const before = (await call('GET', '/plan')).body;
  const r = await call('PUT', '/plan/rest-days', { restDays: [6, 0] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.profile.restDays, [6, 0]);
  const rest = r.body.plan.workouts.flatMap((d, weekday) => (d.type === 'rest' ? [weekday] : []));
  assert.deepEqual(rest, [0, 6]);
  assert.deepEqual(r.body.plan.workouts.filter((d) => d.type === 'workout').map((d) => d.key), ['push', 'pull', 'legs', 'upperB', 'lowerB']);
  assert.deepEqual(r.body.plan.meals.map((d) => d.map((m) => m.foodId)), before.meals.map((d) => d.map((m) => m.foodId)));
  assert.equal((await call('PUT', '/plan/rest-days', { restDays: [3, 3] })).status, 400);
  // editing the profile keeps the chosen rest days
  const { restDays: _r, ...form } = { ...profile };
  assert.deepEqual((await call('PUT', '/profile', form)).body.profile.restDays, [6, 0]);
  await call('PUT', '/plan/rest-days', { restDays: [4, 0] });
});

test('beating a previous session reports personal records', async () => {
  const plan = (await call('GET', '/plan')).body;
  const day = plan.workouts.find((d) => d.type === 'workout');
  const ex = day.exercises.find((e) => !e.exercise.timed);
  const log = (weight) => call('POST', '/logs/workouts', { date: '2026-10-12', kind: 'plan', name: day.name, mins: 30,
    exercises: [{ id: ex.id, sets: [{ reps: 10, weight, done: true }] }] });
  assert.deepEqual((await log(8)).body.prs, []);
  const pr = (await log(12)).body.prs;
  assert.equal(pr.length, 1);
  assert.deepEqual([pr[0].kind, pr[0].value, pr[0].previous], ['weight', 12, 8]);
});

test('progress includes a this-week vs last-week recap', async () => {
  const p = await call('GET', '/progress?date=2026-10-14&weekday=3');
  const { thisWeek, lastWeek } = p.body.recap;
  assert.ok(thisWeek.done >= 1 && thisWeek.mins > 0 && thisWeek.volume > 0);
  assert.deepEqual(lastWeek, { done: 0, mins: 0, volume: 0 });
});

test('reminders quote last performance and cover rest days', async () => {
  await call('PUT', '/settings', { workout: true });
  const r = (await call('GET', '/reminders')).body.reminders;
  assert.ok(r.some((x) => x.id.startsWith('rest-') && /streak is safe/.test(x.title)));
  assert.ok(r.filter((x) => x.kind === 'workout' && !x.id.startsWith('rest-')).every((x) => x.title.length > 0));
});


test('admin portal: sign in, find a member by number, set their diet, then hand back to auto', async () => {
  Object.assign(config, { adminEmail: 'coach@example.com', adminPassword: 'coach-pass-123' });
  const member = token;
  const me = (await call('GET', '/me')).body.user;
  token = null;
  assert.equal((await call('POST', '/admin/login', { email: 'coach@example.com', password: 'nope' })).status, 401);
  const login = await call('POST', '/admin/login', { email: 'coach@example.com', password: 'coach-pass-123' });
  assert.equal(login.status, 200);
  const adminToken = login.body.token;

  token = member;
  assert.equal((await call('GET', '/admin/users')).status, 403, 'members cannot use admin routes');
  token = adminToken;
  assert.equal((await call('GET', '/me')).status, 401, 'admin tokens are not member sessions');

  const found = (await call('GET', `/admin/users?q=%23${me.id}`)).body.users;
  assert.deepEqual(found.map((u) => u.id), [me.id]);
  const detail = (await call('GET', `/admin/users/${me.id}`)).body;
  assert.ok(detail.profile && detail.plan && detail.autoNutrition);
  assert.ok((await call('GET', '/admin/foods')).body.foods.length > 100);

  const day = [
    { name: 'Breakfast', time: '07:30', slot: 'b', foodId: 'ni_paratha', portion: 1 },
    { name: 'Lunch', time: '13:00', slot: 'l', custom: { n: 'Coach special thali', q: '1 plate', k: 650, p: 45 } },
    { name: 'Dinner', time: '20:00', slot: 'd', custom: { n: 'Paneer bhurji with 2 rotis', q: '1 plate', k: 520, p: 34 } },
  ];
  const bad = await call('PUT', `/admin/users/${me.id}/diet`, { days: Array(7).fill([{ name: 'X', time: '08:00', slot: 'b' }]) });
  assert.equal(bad.status, 400);
  const set = await call('PUT', `/admin/users/${me.id}/diet`, { days: Array(7).fill(day), targets: { kcal: 1700, protein: 125 }, note: 'Hit 125 g protein daily.' });
  assert.equal(set.status, 200);

  token = member;
  const plan = (await call('GET', '/plan')).body;
  assert.equal(plan.coach.note, 'Hit 125 g protein daily.');
  assert.equal(plan.nutrition.protein, 125);
  assert.equal(plan.meals[3][1].food.n, 'Coach special thali');
  assert.equal(plan.meals[3][1].protein, 45);
  assert.equal((await call('POST', '/plan/meals/swap', { day: 3, index: 0 })).status, 409, 'coach meals are locked');
  assert.equal((await call('GET', '/reminders')).status, 200);
  await call('PUT', '/profile', profile);
  assert.equal((await call('GET', '/plan')).body.meals[3][1].food.n, 'Coach special thali', 'profile edits keep the coach diet');
  const today = (await call('GET', '/today?date=2026-10-14&weekday=3')).body;
  assert.equal(today.meals.length, 3);

  token = adminToken;
  assert.equal((await call('DELETE', `/admin/users/${me.id}/diet`)).status, 200);
  token = member;
  const back = (await call('GET', '/plan')).body;
  assert.equal(back.coach, null);
  assert.notEqual(back.nutrition.protein, 125);
});

test('forgot password sets a new password straight away with the email', async () => {
  const saved = token; token = null;
  assert.equal((await call('POST', '/auth/reset', { email: 'nobody@example.com', password: 'newpass123' })).status, 404);
  assert.equal((await call('POST', '/auth/reset', { email: 'priya@example.com', password: 'short' })).status, 400);
  const ok = await call('POST', '/auth/reset', { email: 'priya@example.com', password: 'newpass123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await call('POST', '/auth/login', { email: 'priya@example.com', password: 'newpass123' })).status, 200);
  token = saved;
});

test('first-run admin setup works once when the server has no admin settings', async () => {
  const saved = { adminEmail: config.adminEmail, adminPassword: config.adminPassword }, member = token;
  Object.assign(config, { adminEmail: '', adminPassword: '' });
  token = null;
  assert.equal((await call('GET', '/admin/setup')).body.needsSetup, true);
  assert.equal((await call('POST', '/admin/login', { email: 'owner@example.com', password: 'owner-pass-1' })).status, 409);
  assert.equal((await call('POST', '/admin/setup', { email: 'owner@example.com', password: 'short' })).status, 400);
  const created = await call('POST', '/admin/setup', { email: 'Owner@Example.com', password: 'owner-pass-1' });
  assert.equal(created.status, 201);
  assert.ok(created.body.token);
  assert.equal((await call('GET', '/admin/setup')).body.needsSetup, false);
  assert.equal((await call('POST', '/admin/setup', { email: 'intruder@example.com', password: 'intruder-123' })).status, 409, 'setup closes after the first admin');
  assert.equal((await call('POST', '/admin/login', { email: 'owner@example.com', password: 'wrong-pass' })).status, 401);
  const login = await call('POST', '/admin/login', { email: 'owner@example.com', password: 'owner-pass-1' });
  assert.equal(login.status, 200);
  token = login.body.token;
  assert.equal((await call('GET', '/admin/stats')).status, 200);
  Object.assign(config, saved);
  token = member;
});

test('after a coach sends a new diet, today counts only the new meals', async () => {
  Object.assign(config, { adminEmail: 'coach@example.com', adminPassword: 'coach-pass-123' });
  const member = token;
  const me = (await call('GET', '/me')).body.user;
  const date = '2026-10-14', weekday = 3;
  await call('POST', '/logs/meals', { date, index: 0, eaten: true });
  await call('POST', '/logs/meals', { date, index: 1, eaten: true });
  assert.equal((await call('GET', `/today?date=${date}&weekday=${weekday}`)).body.meals.filter((m) => m.eaten).length, 2);

  token = (await call('POST', '/admin/login', { email: 'coach@example.com', password: 'coach-pass-123' })).body.token;
  const day = [
    { name: 'Breakfast', time: '08:00', slot: 'b', custom: { n: 'New oats', q: '1 bowl', k: 400, p: 30 } },
    { name: 'Lunch', time: '13:00', slot: 'l', custom: { n: 'New thali', q: '1 plate', k: 700, p: 40 } },
  ];
  assert.equal((await call('PUT', `/admin/users/${me.id}/diet`, { days: Array(7).fill(day) })).status, 200);

  token = member;
  const fresh = (await call('GET', `/today?date=${date}&weekday=${weekday}`)).body;
  assert.equal(fresh.meals.filter((m) => m.eaten).length, 0, 'old ticks do not carry over to the new diet');
  await call('POST', '/logs/meals', { date, index: 1, eaten: true });
  const after = (await call('GET', `/today?date=${date}&weekday=${weekday}`)).body;
  const eaten = after.meals.filter((m) => m.eaten);
  assert.deepEqual(eaten.map((m) => [m.food.n, m.kcal, m.protein]), [['New thali', 700, 40]], 'only the new meal counts');
  await call('POST', '/logs/meals', { date, index: 1, eaten: false });
  assert.equal((await call('GET', `/today?date=${date}&weekday=${weekday}`)).body.meals.filter((m) => m.eaten).length, 0);

  token = (await call('POST', '/admin/login', { email: 'coach@example.com', password: 'coach-pass-123' })).body.token;
  await call('DELETE', `/admin/users/${me.id}/diet`);
  token = member;
});
