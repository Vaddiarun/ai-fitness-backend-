// Creates (or refreshes) a demo account with a profile, plan and ~3 weeks of history so every screen has data.
//   npm run dev            (in another terminal)
//   node scripts/seed-demo.mjs [http://localhost:4000/api]
// Demo login — local testing only:
export const DEMO = { name: 'Priya', email: 'demo@aifitness.test', password: 'demo-pass-123' };

import { pathToFileURL } from 'node:url';

// Only seed when run directly, so importing DEMO elsewhere has no side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await seed(process.argv[2] || 'http://localhost:4000/api');

async function seed(API) {
let token = '';
const call = async (method, path, body) => {
  const res = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return { status: res.status, data };
};

let reg = await call('POST', '/auth/register', DEMO);
if (reg.status === 409) {
  // start from a clean account each time so history is never duplicated
  token = (await call('POST', '/auth/login', DEMO)).data.token;
  await call('DELETE', '/me');
  token = '';
  reg = await call('POST', '/auth/register', DEMO);
}
token = reg.data.token;

const { data } = await call('PUT', '/profile', {
  name: 'Priya', age: 29, gender: 'female', height: 162, weight: 66.4, targetWeight: 60, units: 'metric',
  goal: 'lose', activity: 'light', level: 'beginner', location: 'db', days: 4, duration: 45, workoutTime: '18:30',
  conditions: [], cuisine: 'ni', diet: 'veg', meals: 5, allergies: [], wake: '06:30', sleep: '22:30',
});
const plan = data.plan;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
const weights = [68.0, 67.8, 67.5, 67.6, 67.1, 66.9, 66.4];
for (let i = 0; i < weights.length; i++) {
  const d = new Date(today); d.setDate(d.getDate() - (weights.length - 1 - i) * 4);
  await call('POST', '/logs/weights', { date: iso(d), kg: weights[i] });
}
let logged = 0;
for (let back = 24; back >= 1; back--) {
  const d = new Date(today); d.setDate(d.getDate() - back);
  const day = plan.workouts[d.getDay()];
  if (day.type !== 'workout' || back === 9) continue;
  const prog = Math.floor((24 - back) / 7);
  await call('POST', '/logs/workouts', {
    date: iso(d), kind: 'plan', name: day.name, mins: 40 + (back % 7), rpe: 7, feel: 'ok',
    exercises: day.exercises.map((e) => ({
      id: e.id,
      sets: Array.from({ length: e.sets }, () => ({ reps: e.seconds ?? 10 + prog, weight: e.exercise.equipment === 'db' && !e.seconds ? 4 + prog : null, done: true })),
    })),
  });
  logged++;
}
await call('POST', '/logs/water', { date: iso(today), delta: 3 });
await call('POST', '/logs/meals', { date: iso(today), index: 0, eaten: true });
console.log(`Demo account ready: ${DEMO.email} · ${logged} past workouts · ${weights.length} weigh-ins`);
}
