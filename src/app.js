import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { parse } from './db.js';
import { CUISINES, EXERCISES, EXTRA_VIDEOS, FOODS } from './data/index.js';
import { requireAuth, requireAdmin, validate, signToken, signAdminToken, HttpError, notFound, errorHandler } from './middleware.js';
import * as S from './schemas.js';
import { generatePlan, expandPlan, swapMeal, mealWeek, workoutWeek, restDaysOf, toMinutes, PLAN_VERSION, MEAL_VERSION, TRAINING_DAYS } from './services/planEngine.js';
import { weeklyReminders } from './services/schedule.js';
import { streak, weekStart, volumeOf, advice, addDays, personalRecords, weekSummary } from './services/progress.js';

/** Constant-time string comparison (hash first so lengths always match). */
const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const COACH_LOCKED = 'Your coach set this meal plan. Ask them to change it.';

const LIBRARY = JSON.parse(readFileSync(new URL('./data/library.json', import.meta.url), 'utf8'));
const LIBRARY_BY_ID = new Map(LIBRARY.map((x) => [x.id, x]));
const facet = (f) => [...new Set(LIBRARY.flatMap((x) => [].concat(x[f] ?? [])))].sort();
const LIBRARY_FILTERS = {
  category: facet('category'), equipment: facet('equipment'), level: facet('level'), muscle: facet('primaryMuscles'),
};

/** Field names whose values never appear in logs. */
const SECRET_FIELDS = /pass(word)?|token|secret/i;
const redact = (v) => JSON.stringify(v, (k, x) => (k && SECRET_FIELDS.test(k) ? '***' : x));

/**
 * One line per API call, written when the response finishes:
 *   2026-10-17T18:20:01.123Z  POST /api/logs/meals  200  12ms  user=#4  {"date":"2026-10-17","index":0,"eaten":true}
 * Shows who did what in the app (and in the admin portal). Passwords and tokens are masked.
 * Set LOG_REQUESTS=false to turn it off (the tests do).
 */
function requestLog(req, res, next) {
  if (process.env.LOG_REQUESTS === 'false') return next();
  const start = Date.now();
  res.on('finish', () => {
    const who = req.adminEmail ? `admin=${req.adminEmail}` : req.userId ? `user=#${req.userId}` : 'guest';
    const body = req.body && Object.keys(req.body).length ? redact(req.body).slice(0, 400) : '';
    console.log(`${new Date().toISOString()}  ${req.method.padEnd(6)} ${req.originalUrl}  ${res.statusCode}  ${Date.now() - start}ms  ${who}${body ? '  ' + body : ''}`);
  });
  next();
}

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()) }));
  app.use(express.json({ limit: '200kb' }));
  app.use(requestLog);

  /* ---------- data access ---------- */
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, name, settings, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    setSettings: db.prepare('UPDATE users SET settings = ? WHERE id = ?'),
    setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    // Account deletion clears every table explicitly (hosted libSQL doesn't keep foreign_keys on between requests).
    deleteUser: ['profiles', 'plans', 'workout_logs', 'weight_logs', 'meal_logs', 'water_logs']
      .map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`))
      .concat(db.prepare('DELETE FROM users WHERE id = ?')),
    profile: db.prepare('SELECT data FROM profiles WHERE user_id = ?'),
    upsertProfile: db.prepare(`INSERT INTO profiles (user_id, data) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
    plan: db.prepare('SELECT data FROM plans WHERE user_id = ?'),
    upsertPlan: db.prepare(`INSERT INTO plans (user_id, data) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, created_at = datetime('now')`),
    mealsOn: db.prepare('SELECT slot_index, status, note, kcal, protein FROM meal_logs WHERE user_id = ? AND date = ? AND rev = ?'),
    eat: db.prepare(`INSERT INTO meal_logs (user_id, date, slot_index, rev, status, note, kcal, protein) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date, slot_index) DO UPDATE SET rev = excluded.rev, status = excluded.status,
        note = excluded.note, kcal = excluded.kcal, protein = excluded.protein`),
    uneat: db.prepare('DELETE FROM meal_logs WHERE user_id = ? AND date = ? AND slot_index = ?'),
    water: db.prepare('SELECT glasses FROM water_logs WHERE user_id = ? AND date = ?'),
    setWater: db.prepare(`INSERT INTO water_logs (user_id, date, glasses) VALUES (?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET glasses = excluded.glasses`),
    weights: db.prepare('SELECT date, kg FROM weight_logs WHERE user_id = ? ORDER BY date'),
    setWeight: db.prepare(`INSERT INTO weight_logs (user_id, date, kg) VALUES (?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg`),
    insertWorkout: db.prepare(`INSERT INTO workout_logs (user_id, date, kind, name, mins, rpe, feel, notes, exercises, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    workouts: db.prepare('SELECT * FROM workout_logs WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?'),
    workout: db.prepare('SELECT * FROM workout_logs WHERE user_id = ? AND id = ?'),
    workoutsOn: db.prepare("SELECT * FROM workout_logs WHERE user_id = ? AND date = ? AND kind = 'plan' ORDER BY id DESC"),
    planWorkoutDates: db.prepare("SELECT DISTINCT date FROM workout_logs WHERE user_id = ? AND kind = 'plan'"),
    planWorkoutsSince: db.prepare("SELECT COUNT(*) AS n FROM workout_logs WHERE user_id = ? AND kind = 'plan' AND date >= ? AND date <= ?"),
    mealLogsSince: db.prepare('SELECT date, slot_index, status, note, kcal, protein FROM meal_logs WHERE user_id = ? AND date >= ? ORDER BY date'),
    waterSince: db.prepare('SELECT date, glasses FROM water_logs WHERE user_id = ? AND date >= ? ORDER BY date'),
    adminUsers: db.prepare(`SELECT u.id, u.email, u.name, u.created_at, p.data AS profile, pl.data AS plan,
        (SELECT MAX(date) FROM workout_logs w WHERE w.user_id = u.id) AS last_workout
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN plans pl ON pl.user_id = u.id
      ORDER BY u.id DESC`),
    adminUser: db.prepare('SELECT id, email, name, settings, created_at FROM users WHERE id = ?'),
    adminCount: db.prepare('SELECT COUNT(*) AS n FROM admins'),
    adminByEmail: db.prepare('SELECT * FROM admins WHERE email = ?'),
    insertAdmin: db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)'),
    countWorkoutsSince: db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM workout_logs WHERE date >= ?'),
  };
  const rowToWorkout = (r) => r && ({
    id: r.id, date: r.date, kind: r.kind, name: r.name, mins: r.mins, rpe: r.rpe, feel: r.feel, notes: r.notes,
    exercises: parse(r.exercises, []), volume: r.volume,
  });
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, settings: parse(u.settings, {}), createdAt: u.created_at });
  // Training days are fixed now; older profiles may still hold the 2–6 they picked, so report the real number.
  const getProfile = async (id) => { const p = parse((await q.profile.get(id))?.data); return p && { ...p, days: TRAINING_DAYS, restDays: restDaysOf(p) }; };
  const getPlan = async (id) => parse((await q.plan.get(id))?.data);
  const needPlan = async (id) => {
    const plan = (await getPlan(id)), profile = (await getProfile(id));
    if (!plan || !profile) throw new HttpError(409, 'Finish your profile first so we can build your plan.');
    if (plan.version !== PLAN_VERSION) {
      // Workout rules changed (e.g. sets per level): rebuild workouts, keep the user's meals and swaps.
      plan.workouts = workoutWeek(profile);
      plan.version = PLAN_VERSION;
      (await savePlan(id, plan));
    }
    if (plan.mealVersion !== MEAL_VERSION && !plan.customDiet) {
      // Meal rules changed (e.g. protein top-ups): rebuild auto meals so targets add up.
      plan.meals = mealWeek(profile, plan.nutrition);
      plan.mealVersion = MEAL_VERSION;
      newMeals(plan);
      (await savePlan(id, plan));
    }
    return { plan, profile };
  };
  const savePlan = (id, plan) => q.upsertPlan.run(id, JSON.stringify(plan));
  /** A coach-set diet survives profile edits and plan rebuilds; only the coach (or "reset") replaces it. */
  const keepCoachDiet = (from, to) => (from?.customDiet
    ? { ...to, meals: from.meals, customDiet: from.customDiet, nutritionOverride: from.nutritionOverride, mealVersion: from.mealVersion, mealsRev: from.mealsRev }
    : newMeals(to));
  /**
   * Marks the meal plan as a new version. Meal ticks are stored per version, so after a new diet (coach save,
   * reset, cuisine change, rebuild) today's calories and protein count only the new meals, not the old ones.
   */
  const newMeals = (plan) => { plan.mealsRev = Date.now().toString(36); return plan; };

  /* ---------- public ---------- */
  app.get(['/', '/api', '/api/index'], async (_req, res) => res.json({ name: 'ai-fitness-backend', status: 'ok', api: '/api' }));
  app.get('/health', async (_req, res) => res.json({ ok: true }));
  // Deployment check: which host/service is answering and which settings it can see (yes/no only, never values).
  app.get('/api/health', async (_req, res) => res.json({
    ok: true,
    host: process.env.RENDER ? 'render' : process.env.VERCEL ? 'vercel' : 'other',
    service: process.env.RENDER_SERVICE_NAME ?? null,
    configured: { ADMIN_EMAIL: !!config.adminEmail, ADMIN_PASSWORD: !!config.adminPassword, JWT_SECRET: !!process.env.JWT_SECRET },
    // 'hosted' survives restarts; 'local-file' on Render is wiped whenever the service restarts or redeploys.
    database: config.db.url.startsWith('libsql') ? 'hosted' : config.db.url === ':memory:' ? 'memory' : 'local-file',
  }));

  app.post('/api/auth/register', validate(S.registerSchema), async (req, res) => {
    const { name, email, password } = req.body;
    if ((await q.userByEmail.get(email))) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
    const { lastInsertRowid } = (await q.insertUser.run(email, name, bcrypt.hashSync(password, 10)));
    const user = (await q.userById.get(Number(lastInsertRowid)));
    res.status(201).json({ token: signToken(user), user: publicUser(user), profile: null });
  });

  app.post('/api/auth/login', validate(S.loginSchema), async (req, res) => {
    const row = (await q.userByEmail.get(req.body.email));
    if (!row || !bcrypt.compareSync(req.body.password, row.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
    res.json({ token: signToken(row), user: publicUser(row), profile: (await getProfile(row.id)) });
  });

  /* Forgot password: set a new one straight away with the account's email, then sign in. No codes. */
  app.post('/api/auth/reset', validate(S.resetSchema), async (req, res) => {
    const user = (await q.userByEmail.get(req.body.email));
    if (!user) throw new HttpError(404, 'No account uses this email. Create an account instead.');
    (await q.setPassword.run(bcrypt.hashSync(req.body.password, 10), user.id));
    res.json({ token: signToken(user), user: publicUser(user), profile: (await getProfile(user.id)) });
  });

  app.get('/api/catalog', async (_req, res) => res.json({ cuisines: CUISINES, extraVideos: EXTRA_VIDEOS, coachedExercises: EXERCISES }));

  /* Full exercise library (881 exercises): search + filters + paging. */
  app.get('/api/library/exercises', async (req, res) => {
    const { q: text = '', category, equipment, level, muscle } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
    let rows = LIBRARY.filter((x) =>
      (!category || x.category === category) && (!equipment || x.equipment === equipment) && (!level || x.level === level) &&
      (!muscle || x.primaryMuscles.includes(muscle) || x.secondaryMuscles.includes(muscle)) &&
      words.every((w) => x.name.toLowerCase().includes(w) || x.primaryMuscles.some((m) => m.includes(w))));
    if (req.query.withVideo === 'true') rows = rows.filter((x) => x.video);
    res.json({ total: rows.length, page, limit, filters: LIBRARY_FILTERS, items: rows.slice((page - 1) * limit, page * limit) });
  });
  app.get('/api/library/exercises/:id', async (req, res) => {
    const x = LIBRARY_BY_ID.get(req.params.id);
    if (!x) throw new HttpError(404, 'Exercise not found.');
    res.json(x);
  });

  /* ---------- signed in ---------- */
  const api = express.Router();
  api.use(requireAuth);

  api.get('/me', async (req, res) => {
    const u = (await q.userById.get(req.userId));
    if (!u) throw new HttpError(401, 'Account not found. Sign in again.');
    res.json({ user: publicUser(u), profile: (await getProfile(req.userId)), hasPlan: !!(await getPlan(req.userId)) });
  });

  api.delete('/me', async (req, res) => {
    for (const del of q.deleteUser) await del.run(req.userId);
    res.status(204).end();
  });

  api.put('/profile', validate(S.profileSchema), async (req, res) => {
    // Keep rest days the user chose in settings when the profile form doesn't send them.
    const profile = { ...req.body, days: TRAINING_DAYS, restDays: req.body.restDays ?? restDaysOf((await getProfile(req.userId))) };
    (await q.upsertProfile.run(req.userId, JSON.stringify(profile)));
    (await q.setName.run(profile.name, req.userId));
    const plan = keepCoachDiet((await getPlan(req.userId)), generatePlan(profile));
    (await savePlan(req.userId, plan));
    if (!(await q.weights.all(req.userId)).length) (await q.setWeight.run(req.userId, new Date().toISOString().slice(0, 10), profile.weight));
    res.json({ profile, plan: expandPlan(plan) });
  });

  api.put('/settings', validate(S.settingsSchema), async (req, res) => {
    const u = (await q.userById.get(req.userId));
    const settings = { ...parse(u.settings, {}), ...req.body };
    (await q.setSettings.run(JSON.stringify(settings), req.userId));
    res.json({ settings });
  });

  api.get('/plan', async (req, res) => res.json(expandPlan((await needPlan(req.userId)).plan)));

  api.post('/plan/regenerate', async (req, res) => {
    const { plan: old, profile } = (await needPlan(req.userId));
    const plan = keepCoachDiet(old, generatePlan(profile));
    (await savePlan(req.userId, plan));
    res.json(expandPlan(plan));
  });

  api.post('/plan/meals/swap', validate(S.swapSchema), async (req, res) => {
    const { plan, profile } = (await needPlan(req.userId));
    if (plan.customDiet) throw new HttpError(409, COACH_LOCKED);
    const day = plan.meals[req.body.day];
    if (!day[req.body.index]) throw new HttpError(400, 'That meal does not exist.');
    const before = day[req.body.index].foodId;
    day[req.body.index] = swapMeal(profile, day[req.body.index]);
    (await savePlan(req.userId, plan));
    // swapped=false means no other dish fits this person's cuisine, diet and allergies
    res.json({ ...expandPlan(plan), swapped: day[req.body.index].foodId !== before });
  });

  api.put('/plan/cuisine', validate(S.cuisineSchema), async (req, res) => {
    const { plan, profile } = (await needPlan(req.userId));
    if (plan.customDiet) throw new HttpError(409, COACH_LOCKED);
    profile.cuisine = req.body.cuisine;
    (await q.upsertProfile.run(req.userId, JSON.stringify(profile)));
    plan.meals = mealWeek(profile, plan.nutrition);
    newMeals(plan);
    (await savePlan(req.userId, plan));
    res.json(expandPlan(plan));
  });

  /** Move the two recovery days. Workouts are rebuilt; meals and swaps stay. */
  api.put('/plan/rest-days', validate(S.restDaysSchema), async (req, res) => {
    const { plan, profile } = (await needPlan(req.userId));
    profile.restDays = req.body.restDays;
    (await q.upsertProfile.run(req.userId, JSON.stringify(profile)));
    plan.workouts = workoutWeek(profile);
    (await savePlan(req.userId, plan));
    res.json({ profile, plan: expandPlan(plan) });
  });

  api.get('/reminders', async (req, res) => {
    const { plan, profile } = (await needPlan(req.userId));
    const u = (await q.userById.get(req.userId));
    const recent = (await q.workouts.all(req.userId, 100)).map(rowToWorkout);
    const lastFor = (id) => recent.map((w) => w.exercises.find((x) => x.id === id)).find(Boolean) ?? null;
    res.json({ reminders: weeklyReminders(profile, plan, parse(u.settings, {}), lastFor) });
  });

  /** Everything the Today screen needs. The app sends its own local date and weekday. */
  api.get('/today', validate(S.dateQuery, 'query'), async (req, res) => {
    const { date, weekday } = req.validQuery;
    const { plan } = (await needPlan(req.userId));
    const full = expandPlan(plan);
    const logs = new Map((await q.mealsOn.all(req.userId, date, plan.mealsRev ?? '')).map((r) => [r.slot_index, r]));
    res.json({
      date, weekday,
      // Today's ring targets: with a coach diet these are today's meal totals, so the rings match the plan.
      nutrition: { ...full.nutrition, ...full.dayNutrition[weekday] },
      workout: full.workouts[weekday],
      completed: rowToWorkout((await q.workoutsOn.get(req.userId, date))) || null,
      meals: full.meals[weekday].map((m, i) => {
        const log = logs.get(i);
        const status = log?.status ?? 'none';
        return {
          ...m, index: i, status,
          eaten: status === 'eaten', // older app builds read this
          cheat: status === 'cheated' ? { note: log.note ?? '', kcal: log.kcal ?? 0, protein: log.protein ?? 0 } : null,
        };
      }),
      water: (await q.water.get(req.userId, date))?.glasses ?? 0,
    });
  });

  /** Mark one of today's meals as eaten, skipped or cheated — or clear it with status "none". */
  api.post('/logs/meals', validate(S.mealLogSchema), async (req, res) => {
    const { date, index, note, kcal, protein } = req.body;
    const status = req.body.status ?? (req.body.eaten ? 'eaten' : 'none');
    if (status === 'none') {
      await q.uneat.run(req.userId, date, index);
    } else {
      const { plan } = (await needPlan(req.userId));
      const cheat = status === 'cheated';
      await q.eat.run(req.userId, date, index, plan.mealsRev ?? '', status,
        cheat ? note ?? null : null, cheat ? kcal ?? 0 : null, cheat ? protein ?? 0 : null);
    }
    res.json({ date, index, status, eaten: status === 'eaten' });
  });

  api.post('/logs/water', validate(S.waterLogSchema), async (req, res) => {
    const { date, delta } = req.body;
    const glasses = Math.max(0, Math.min(30, ((await q.water.get(req.userId, date))?.glasses ?? 0) + delta));
    (await q.setWater.run(req.userId, date, glasses));
    res.json({ date, glasses });
  });

  api.post('/logs/weights', validate(S.weightLogSchema), async (req, res) => {
    (await q.setWeight.run(req.userId, req.body.date, req.body.kg));
    const profile = (await getProfile(req.userId));
    if (profile) { profile.weight = req.body.kg; (await q.upsertProfile.run(req.userId, JSON.stringify(profile))); }
    res.status(201).json({ weights: (await q.weights.all(req.userId)) });
  });
  api.get('/logs/weights', async (req, res) => res.json({ weights: (await q.weights.all(req.userId)) }));

  api.post('/logs/workouts', validate(S.workoutLogSchema), async (req, res) => {
    const w = req.body;
    const unknown = w.exercises.find((e) => !EXERCISES[e.id]);
    if (unknown) throw new HttpError(400, `Unknown exercise "${unknown.id}".`);
    const volume = volumeOf(w.exercises);
    const prs = personalRecords(w.exercises, (await q.workouts.all(req.userId, 500)).map(rowToWorkout));
    const { lastInsertRowid } = (await q.insertWorkout.run(req.userId, w.date, w.kind, w.name, w.mins, w.rpe ?? null, w.feel ?? null,
      w.notes ?? null, JSON.stringify(w.exercises), volume));
    res.status(201).json({ ...rowToWorkout((await q.workout.get(req.userId, Number(lastInsertRowid)))), prs });
  });
  api.get('/logs/workouts', async (req, res) => {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    res.json({ workouts: (await q.workouts.all(req.userId, limit)).map(rowToWorkout) });
  });
  api.get('/logs/workouts/:id', async (req, res) => {
    const w = rowToWorkout((await q.workout.get(req.userId, Number(req.params.id))));
    if (!w) throw new HttpError(404, 'Workout not found.');
    res.json(w);
  });

  /** Last logged sets for an exercise plus a progression hint for today's prescription. */
  api.get('/exercises/:id/last', async (req, res) => {
    const { plan, profile } = (await needPlan(req.userId));
    const id = req.params.id;
    if (!EXERCISES[id]) throw new HttpError(404, 'Exercise not found.');
    let last = null, lastDate = null;
    for (const w of (await q.workouts.all(req.userId, 100)).map(rowToWorkout)) {
      const e = w.exercises.find((x) => x.id === id);
      if (e) { last = e; lastDate = w.date; break; }
    }
    const rx = plan.workouts.flatMap((d) => d.exercises || []).find((e) => e.id === id) || {};
    res.json({ last, date: lastDate, advice: advice(rx, last, profile.units) });
  });

  api.get('/progress', validate(S.dateQuery, 'query'), async (req, res) => {
    const { date } = req.validQuery;
    const { plan, profile } = (await needPlan(req.userId));
    const dates = new Set((await q.planWorkoutDates.all(req.userId)).map((r) => r.date));
    const weights = (await q.weights.all(req.userId));
    const recent = (await q.workouts.all(req.userId, 60)).map(rowToWorkout);
    const thisMonday = weekStart(date), lastMonday = addDays(thisMonday, -7);
    res.json({
      week: { done: (await q.planWorkoutsSince.get(req.userId, thisMonday, addDays(thisMonday, 6))).n, planned: profile.days },
      // Week-over-week recap for the Progress screen.
      recap: { thisWeek: weekSummary(recent, thisMonday, addDays(thisMonday, 6)), lastWeek: weekSummary(recent, lastMonday, addDays(lastMonday, 6)) },
      streak: streak(plan, dates, date),
      weights,
      weightChangeKg: weights.length > 1 ? Math.round((weights.at(-1).kg - weights[0].kg) * 10) / 10 : 0,
      targetWeight: profile.targetWeight ?? null,
      history: (await q.workouts.all(req.userId, 30)).map(rowToWorkout),
    });
  });


  /* ---------- admin portal ---------- */
  // Admins come from ADMIN_EMAIL/ADMIN_PASSWORD on the server, or from a one-time setup in the portal (stored hashed).
  const envAdmin = () => !!(config.adminEmail && config.adminPassword);
  const needsSetup = async () => !envAdmin() && !(await q.adminCount.get()).n;

  app.get('/api/admin/setup', async (_req, res) => res.json({ needsSetup: (await needsSetup()) }));

  /** First-run only: creates the admin account when none exists yet. Closed for good once there is one. */
  app.post('/api/admin/setup', validate(S.adminSetupSchema), async (req, res) => {
    if (!(await needsSetup())) throw new HttpError(409, 'An admin account already exists. Sign in instead.');
    (await q.insertAdmin.run(req.body.email, bcrypt.hashSync(req.body.password, 10)));
    res.status(201).json({ token: signAdminToken(req.body.email), email: req.body.email });
  });

  app.post('/api/admin/login', validate(S.adminLoginSchema), async (req, res) => {
    if ((await needsSetup())) throw new HttpError(409, 'No admin account yet. Create one first.');
    const { email, password } = req.body;
    const viaEnv = envAdmin() && email === config.adminEmail && sameSecret(password, config.adminPassword);
    const row = (await q.adminByEmail.get(email));
    const viaDb = !!row && bcrypt.compareSync(password, row.password_hash);
    if (!viaEnv && !viaDb) throw new HttpError(401, 'Email or password is incorrect.');
    res.json({ token: signAdminToken(email), email });
  });

  const admin = express.Router();
  admin.use(requireAdmin);

  const summary = (r) => {
    const profile = parse(r.profile), plan = parse(r.plan);
    return {
      id: r.id, name: r.name, email: r.email, createdAt: r.created_at, lastWorkout: r.last_workout ?? null,
      goal: profile?.goal ?? null, diet: profile?.diet ?? null, cuisine: profile?.cuisine ?? null, weight: profile?.weight ?? null,
      hasPlan: !!plan, coachDiet: !!plan?.customDiet,
    };
  };

  admin.get('/stats', async (_req, res) => {
    const users = (await q.adminUsers.all()).map(summary);
    const since = addDays(new Date().toISOString().slice(0, 10), -6);
    const w = (await q.countWorkoutsSince.get(since));
    res.json({ users: users.length, withPlan: users.filter((u) => u.hasPlan).length, coachDiets: users.filter((u) => u.coachDiet).length,
      workouts7d: w.n, activeUsers7d: w.users });
  });

  /** Search by member number ("4" or "#4"), name or email. */
  admin.get('/users', async (req, res) => {
    const text = String(req.query.q ?? '').trim().toLowerCase().replace(/^#/, '');
    let users = (await q.adminUsers.all()).map(summary);
    if (text) users = users.filter((u) => String(u.id) === text || u.name.toLowerCase().includes(text) || u.email.includes(text));
    res.json({ users });
  });

  const adminTarget = async (id) => {
    const user = await q.adminUser.get(Number(id));
    if (!user) throw new HttpError(404, `No member #${id}.`);
    return user;
  };

  admin.get('/users/:id', async (req, res) => {
    const user = (await adminTarget(req.params.id));
    const profile = (await getProfile(user.id));
    const plan = profile && (await getPlan(user.id)) ? (await needPlan(user.id)).plan : null;
    const since = addDays(new Date().toISOString().slice(0, 10), -13);
    res.json({
      user: publicUser(user),
      profile,
      plan: plan ? expandPlan(plan) : null,
      // What the app would build automatically, so the coach can start from it or compare.
      autoNutrition: profile ? generatePlan(profile).nutrition : null,
      logs: {
        meals: (await q.mealLogsSince.all(user.id, since)),
        water: (await q.waterSince.all(user.id, since)),
        weights: (await q.weights.all(user.id)),
        workouts: (await q.workouts.all(user.id, 20)).map(rowToWorkout),
      },
    });
  });

  admin.get('/foods', async (_req, res) => res.json({ foods: FOODS, cuisines: CUISINES }));

  /** Replace a member's whole week of meals (and optionally their daily targets). Shows in their app right away. */
  admin.put('/users/:id/diet', validate(S.adminDietSchema), async (req, res) => {
    const user = (await adminTarget(req.params.id));
    const { plan } = (await needPlan(user.id));
    const unknown = req.body.days.flat().find((m) => !m.custom && !FOODS.some((f) => f.id === m.foodId));
    if (unknown) throw new HttpError(400, `Unknown dish "${unknown.foodId}".`);
    let n = 0;
    plan.meals = req.body.days.map((day) => day
      .map((m) => (m.custom
        ? { slot: m.slot, name: m.name, minute: toMinutes(m.time), foodId: `custom-${Date.now().toString(36)}-${n++}`, portion: m.portion, targetKcal: Math.round(m.custom.k * m.portion), custom: m.custom }
        : { slot: m.slot, name: m.name, minute: toMinutes(m.time), foodId: m.foodId, portion: m.portion, targetKcal: Math.round(FOODS.find((f) => f.id === m.foodId).k * m.portion) }))
      .sort((a, b) => a.minute - b.minute));
    plan.customDiet = { by: req.adminEmail, at: new Date().toISOString(), note: req.body.note ?? '' };
    newMeals(plan);
    plan.nutritionOverride = req.body.targets && Object.keys(req.body.targets).length ? req.body.targets : undefined;
    (await savePlan(user.id, plan));
    res.json({ plan: expandPlan(plan) });
  });

  /** Hand the member back to the automatic meal plan. */
  admin.delete('/users/:id/diet', async (req, res) => {
    const user = (await adminTarget(req.params.id));
    const { plan, profile } = (await needPlan(user.id));
    delete plan.customDiet;
    delete plan.nutritionOverride;
    plan.meals = mealWeek(profile, plan.nutrition);
    plan.mealVersion = MEAL_VERSION;
    newMeals(plan);
    (await savePlan(user.id, plan));
    res.json({ plan: expandPlan(plan) });
  });

  app.use('/api/admin', admin);

  app.use('/api', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
