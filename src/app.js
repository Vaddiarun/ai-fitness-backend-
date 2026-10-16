import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { parse } from './db.js';
import { CUISINES, EXERCISES, EXTRA_VIDEOS, FOODS } from './data/index.js';
import { requireAuth, requireAdmin, validate, signToken, signAdminToken, HttpError, notFound, errorHandler } from './middleware.js';
import * as S from './schemas.js';
import { generatePlan, expandPlan, swapMeal, mealWeek, workoutWeek, restDaysOf, toMinutes, PLAN_VERSION, MEAL_VERSION, TRAINING_DAYS } from './services/planEngine.js';
import { weeklyReminders } from './services/schedule.js';
import { streak, weekStart, volumeOf, advice, addDays, personalRecords, weekSummary } from './services/progress.js';
import { sendMail as defaultSendMail } from './services/mailer.js';

const RESET_TTL_MS = 15 * 60 * 1000;
/** Constant-time string comparison (hash first so lengths always match). */
const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const COACH_LOCKED = 'Your coach set this meal plan. Ask them to change it.';
const RESET_MAX_ATTEMPTS = 5;

const LIBRARY = JSON.parse(readFileSync(new URL('./data/library.json', import.meta.url), 'utf8'));
const LIBRARY_BY_ID = new Map(LIBRARY.map((x) => [x.id, x]));
const facet = (f) => [...new Set(LIBRARY.flatMap((x) => [].concat(x[f] ?? [])))].sort();
const LIBRARY_FILTERS = {
  category: facet('category'), equipment: facet('equipment'), level: facet('level'), muscle: facet('primaryMuscles'),
};

export function createApp(db, { sendMail = defaultSendMail } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()) }));
  app.use(express.json({ limit: '200kb' }));

  /* ---------- data access ---------- */
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, name, settings, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    reset: db.prepare('SELECT * FROM password_resets WHERE user_id = ?'),
    upsertReset: db.prepare(`INSERT INTO password_resets (user_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`),
    resetAttempt: db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?'),
    deleteReset: db.prepare('DELETE FROM password_resets WHERE user_id = ?'),
    setSettings: db.prepare('UPDATE users SET settings = ? WHERE id = ?'),
    setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    profile: db.prepare('SELECT data FROM profiles WHERE user_id = ?'),
    upsertProfile: db.prepare(`INSERT INTO profiles (user_id, data) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
    plan: db.prepare('SELECT data FROM plans WHERE user_id = ?'),
    upsertPlan: db.prepare(`INSERT INTO plans (user_id, data) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, created_at = datetime('now')`),
    mealsOn: db.prepare('SELECT slot_index FROM meal_logs WHERE user_id = ? AND date = ?'),
    eat: db.prepare('INSERT OR IGNORE INTO meal_logs (user_id, date, slot_index) VALUES (?, ?, ?)'),
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
    mealLogsSince: db.prepare('SELECT date, slot_index FROM meal_logs WHERE user_id = ? AND date >= ? ORDER BY date'),
    waterSince: db.prepare('SELECT date, glasses FROM water_logs WHERE user_id = ? AND date >= ? ORDER BY date'),
    adminUsers: db.prepare(`SELECT u.id, u.email, u.name, u.created_at, p.data AS profile, pl.data AS plan,
        (SELECT MAX(date) FROM workout_logs w WHERE w.user_id = u.id) AS last_workout
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN plans pl ON pl.user_id = u.id
      ORDER BY u.id DESC`),
    adminUser: db.prepare('SELECT id, email, name, settings, created_at FROM users WHERE id = ?'),
    countWorkoutsSince: db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM workout_logs WHERE date >= ?'),
  };
  const rowToWorkout = (r) => r && ({
    id: r.id, date: r.date, kind: r.kind, name: r.name, mins: r.mins, rpe: r.rpe, feel: r.feel, notes: r.notes,
    exercises: parse(r.exercises, []), volume: r.volume,
  });
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, settings: parse(u.settings, {}), createdAt: u.created_at });
  // Training days are fixed now; older profiles may still hold the 2–6 they picked, so report the real number.
  const getProfile = (id) => { const p = parse(q.profile.get(id)?.data); return p && { ...p, days: TRAINING_DAYS, restDays: restDaysOf(p) }; };
  const getPlan = (id) => parse(q.plan.get(id)?.data);
  const needPlan = (id) => {
    const plan = getPlan(id), profile = getProfile(id);
    if (!plan || !profile) throw new HttpError(409, 'Finish your profile first so we can build your plan.');
    if (plan.version !== PLAN_VERSION) {
      // Workout rules changed (e.g. sets per level): rebuild workouts, keep the user's meals and swaps.
      plan.workouts = workoutWeek(profile);
      plan.version = PLAN_VERSION;
      savePlan(id, plan);
    }
    if (plan.mealVersion !== MEAL_VERSION && !plan.customDiet) {
      // Meal rules changed (e.g. protein top-ups): rebuild auto meals so targets add up.
      plan.meals = mealWeek(profile, plan.nutrition);
      plan.mealVersion = MEAL_VERSION;
      savePlan(id, plan);
    }
    return { plan, profile };
  };
  const savePlan = (id, plan) => q.upsertPlan.run(id, JSON.stringify(plan));
  /** A coach-set diet survives profile edits and plan rebuilds; only the coach (or "reset") replaces it. */
  const keepCoachDiet = (from, to) => (from?.customDiet
    ? { ...to, meals: from.meals, customDiet: from.customDiet, nutritionOverride: from.nutritionOverride, mealVersion: from.mealVersion }
    : to);

  /* ---------- public ---------- */
  app.get(['/', '/api', '/api/index'], (_req, res) => res.json({ name: 'ai-fitness-backend', status: 'ok', api: '/api' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/register', validate(S.registerSchema), (req, res) => {
    const { name, email, password } = req.body;
    if (q.userByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
    const { lastInsertRowid } = q.insertUser.run(email, name, bcrypt.hashSync(password, 10));
    const user = q.userById.get(Number(lastInsertRowid));
    res.status(201).json({ token: signToken(user), user: publicUser(user), profile: null });
  });

  app.post('/api/auth/login', validate(S.loginSchema), (req, res) => {
    const row = q.userByEmail.get(req.body.email);
    if (!row || !bcrypt.compareSync(req.body.password, row.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
    res.json({ token: signToken(row), user: publicUser(row), profile: getProfile(row.id) });
  });

  /* Password reset: a 6-digit code by email, valid for 15 minutes and 5 tries. */
  app.post('/api/auth/forgot', validate(S.forgotSchema), async (req, res) => {
    const user = q.userByEmail.get(req.body.email);
    // Same answer whether or not the account exists, so the endpoint can't be used to find registered emails.
    if (user) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      q.upsertReset.run(user.id, bcrypt.hashSync(code, 10), Date.now() + RESET_TTL_MS);
      await sendMail({
        to: user.email,
        subject: `Your AI Fitness code: ${code}`,
        text: `Hi ${user.name},\n\nYour code to reset your AI Fitness password is ${code}.\n`
          + 'It expires in 15 minutes. If you didn\'t ask for this, you can ignore this email.',
      });
    }
    res.json({ sent: true });
  });

  app.post('/api/auth/reset', validate(S.resetSchema), (req, res) => {
    const invalid = new HttpError(400, 'That code is wrong or has expired. Request a new one.');
    const user = q.userByEmail.get(req.body.email);
    const reset = user && q.reset.get(user.id);
    if (!reset || reset.expires_at < Date.now() || reset.attempts >= RESET_MAX_ATTEMPTS) throw invalid;
    if (!bcrypt.compareSync(req.body.code, reset.code_hash)) { q.resetAttempt.run(user.id); throw invalid; }
    q.setPassword.run(bcrypt.hashSync(req.body.password, 10), user.id);
    q.deleteReset.run(user.id);
    res.json({ token: signToken(user), user: publicUser(user), profile: getProfile(user.id) });
  });

  app.get('/api/catalog', (_req, res) => res.json({ cuisines: CUISINES, extraVideos: EXTRA_VIDEOS, coachedExercises: EXERCISES }));

  /* Full exercise library (881 exercises): search + filters + paging. */
  app.get('/api/library/exercises', (req, res) => {
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
  app.get('/api/library/exercises/:id', (req, res) => {
    const x = LIBRARY_BY_ID.get(req.params.id);
    if (!x) throw new HttpError(404, 'Exercise not found.');
    res.json(x);
  });

  /* ---------- signed in ---------- */
  const api = express.Router();
  api.use(requireAuth);

  api.get('/me', (req, res) => {
    const u = q.userById.get(req.userId);
    if (!u) throw new HttpError(401, 'Account not found. Sign in again.');
    res.json({ user: publicUser(u), profile: getProfile(req.userId), hasPlan: !!getPlan(req.userId) });
  });

  api.delete('/me', (req, res) => {
    q.deleteUser.run(req.userId);
    res.status(204).end();
  });

  api.put('/profile', validate(S.profileSchema), (req, res) => {
    // Keep rest days the user chose in settings when the profile form doesn't send them.
    const profile = { ...req.body, days: TRAINING_DAYS, restDays: req.body.restDays ?? restDaysOf(getProfile(req.userId)) };
    q.upsertProfile.run(req.userId, JSON.stringify(profile));
    q.setName.run(profile.name, req.userId);
    const plan = keepCoachDiet(getPlan(req.userId), generatePlan(profile));
    savePlan(req.userId, plan);
    if (!q.weights.all(req.userId).length) q.setWeight.run(req.userId, new Date().toISOString().slice(0, 10), profile.weight);
    res.json({ profile, plan: expandPlan(plan) });
  });

  api.put('/settings', validate(S.settingsSchema), (req, res) => {
    const u = q.userById.get(req.userId);
    const settings = { ...parse(u.settings, {}), ...req.body };
    q.setSettings.run(JSON.stringify(settings), req.userId);
    res.json({ settings });
  });

  api.get('/plan', (req, res) => res.json(expandPlan(needPlan(req.userId).plan)));

  api.post('/plan/regenerate', (req, res) => {
    const { plan: old, profile } = needPlan(req.userId);
    const plan = keepCoachDiet(old, generatePlan(profile));
    savePlan(req.userId, plan);
    res.json(expandPlan(plan));
  });

  api.post('/plan/meals/swap', validate(S.swapSchema), (req, res) => {
    const { plan, profile } = needPlan(req.userId);
    if (plan.customDiet) throw new HttpError(409, COACH_LOCKED);
    const day = plan.meals[req.body.day];
    if (!day[req.body.index]) throw new HttpError(400, 'That meal does not exist.');
    const before = day[req.body.index].foodId;
    day[req.body.index] = swapMeal(profile, day[req.body.index]);
    savePlan(req.userId, plan);
    // swapped=false means no other dish fits this person's cuisine, diet and allergies
    res.json({ ...expandPlan(plan), swapped: day[req.body.index].foodId !== before });
  });

  api.put('/plan/cuisine', validate(S.cuisineSchema), (req, res) => {
    const { plan, profile } = needPlan(req.userId);
    if (plan.customDiet) throw new HttpError(409, COACH_LOCKED);
    profile.cuisine = req.body.cuisine;
    q.upsertProfile.run(req.userId, JSON.stringify(profile));
    plan.meals = mealWeek(profile, plan.nutrition);
    savePlan(req.userId, plan);
    res.json(expandPlan(plan));
  });

  /** Move the two recovery days. Workouts are rebuilt; meals and swaps stay. */
  api.put('/plan/rest-days', validate(S.restDaysSchema), (req, res) => {
    const { plan, profile } = needPlan(req.userId);
    profile.restDays = req.body.restDays;
    q.upsertProfile.run(req.userId, JSON.stringify(profile));
    plan.workouts = workoutWeek(profile);
    savePlan(req.userId, plan);
    res.json({ profile, plan: expandPlan(plan) });
  });

  api.get('/reminders', (req, res) => {
    const { plan, profile } = needPlan(req.userId);
    const u = q.userById.get(req.userId);
    const recent = q.workouts.all(req.userId, 100).map(rowToWorkout);
    const lastFor = (id) => recent.map((w) => w.exercises.find((x) => x.id === id)).find(Boolean) ?? null;
    res.json({ reminders: weeklyReminders(profile, plan, parse(u.settings, {}), lastFor) });
  });

  /** Everything the Today screen needs. The app sends its own local date and weekday. */
  api.get('/today', validate(S.dateQuery, 'query'), (req, res) => {
    const { date, weekday } = req.validQuery;
    const { plan } = needPlan(req.userId);
    const full = expandPlan(plan);
    const eaten = new Set(q.mealsOn.all(req.userId, date).map((r) => r.slot_index));
    res.json({
      date, weekday,
      nutrition: full.nutrition,
      workout: full.workouts[weekday],
      completed: rowToWorkout(q.workoutsOn.get(req.userId, date)) || null,
      meals: full.meals[weekday].map((m, i) => ({ ...m, index: i, eaten: eaten.has(i) })),
      water: q.water.get(req.userId, date)?.glasses ?? 0,
    });
  });

  api.post('/logs/meals', validate(S.mealLogSchema), (req, res) => {
    const { date, index, eaten } = req.body;
    (eaten ? q.eat : q.uneat).run(req.userId, date, index);
    res.json({ date, index, eaten });
  });

  api.post('/logs/water', validate(S.waterLogSchema), (req, res) => {
    const { date, delta } = req.body;
    const glasses = Math.max(0, Math.min(30, (q.water.get(req.userId, date)?.glasses ?? 0) + delta));
    q.setWater.run(req.userId, date, glasses);
    res.json({ date, glasses });
  });

  api.post('/logs/weights', validate(S.weightLogSchema), (req, res) => {
    q.setWeight.run(req.userId, req.body.date, req.body.kg);
    const profile = getProfile(req.userId);
    if (profile) { profile.weight = req.body.kg; q.upsertProfile.run(req.userId, JSON.stringify(profile)); }
    res.status(201).json({ weights: q.weights.all(req.userId) });
  });
  api.get('/logs/weights', (req, res) => res.json({ weights: q.weights.all(req.userId) }));

  api.post('/logs/workouts', validate(S.workoutLogSchema), (req, res) => {
    const w = req.body;
    const unknown = w.exercises.find((e) => !EXERCISES[e.id]);
    if (unknown) throw new HttpError(400, `Unknown exercise "${unknown.id}".`);
    const volume = volumeOf(w.exercises);
    const prs = personalRecords(w.exercises, q.workouts.all(req.userId, 500).map(rowToWorkout));
    const { lastInsertRowid } = q.insertWorkout.run(req.userId, w.date, w.kind, w.name, w.mins, w.rpe ?? null, w.feel ?? null,
      w.notes ?? null, JSON.stringify(w.exercises), volume);
    res.status(201).json({ ...rowToWorkout(q.workout.get(req.userId, Number(lastInsertRowid))), prs });
  });
  api.get('/logs/workouts', (req, res) => {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    res.json({ workouts: q.workouts.all(req.userId, limit).map(rowToWorkout) });
  });
  api.get('/logs/workouts/:id', (req, res) => {
    const w = rowToWorkout(q.workout.get(req.userId, Number(req.params.id)));
    if (!w) throw new HttpError(404, 'Workout not found.');
    res.json(w);
  });

  /** Last logged sets for an exercise plus a progression hint for today's prescription. */
  api.get('/exercises/:id/last', (req, res) => {
    const { plan, profile } = needPlan(req.userId);
    const id = req.params.id;
    if (!EXERCISES[id]) throw new HttpError(404, 'Exercise not found.');
    let last = null, lastDate = null;
    for (const w of q.workouts.all(req.userId, 100).map(rowToWorkout)) {
      const e = w.exercises.find((x) => x.id === id);
      if (e) { last = e; lastDate = w.date; break; }
    }
    const rx = plan.workouts.flatMap((d) => d.exercises || []).find((e) => e.id === id) || {};
    res.json({ last, date: lastDate, advice: advice(rx, last, profile.units) });
  });

  api.get('/progress', validate(S.dateQuery, 'query'), (req, res) => {
    const { date } = req.validQuery;
    const { plan, profile } = needPlan(req.userId);
    const dates = new Set(q.planWorkoutDates.all(req.userId).map((r) => r.date));
    const weights = q.weights.all(req.userId);
    const recent = q.workouts.all(req.userId, 60).map(rowToWorkout);
    const thisMonday = weekStart(date), lastMonday = addDays(thisMonday, -7);
    res.json({
      week: { done: q.planWorkoutsSince.get(req.userId, thisMonday, addDays(thisMonday, 6)).n, planned: profile.days },
      // Week-over-week recap for the Progress screen.
      recap: { thisWeek: weekSummary(recent, thisMonday, addDays(thisMonday, 6)), lastWeek: weekSummary(recent, lastMonday, addDays(lastMonday, 6)) },
      streak: streak(plan, dates, date),
      weights,
      weightChangeKg: weights.length > 1 ? Math.round((weights.at(-1).kg - weights[0].kg) * 10) / 10 : 0,
      targetWeight: profile.targetWeight ?? null,
      history: q.workouts.all(req.userId, 30).map(rowToWorkout),
    });
  });


  /* ---------- admin portal ---------- */
  app.post('/api/admin/login', validate(S.adminLoginSchema), (req, res) => {
    const missing = [!config.adminEmail && 'ADMIN_EMAIL', !config.adminPassword && 'ADMIN_PASSWORD'].filter(Boolean);
    if (missing.length) throw new HttpError(503, `The admin portal is not set up: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing on the server.`);
    const ok = req.body.email === config.adminEmail && sameSecret(req.body.password, config.adminPassword);
    if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
    res.json({ token: signAdminToken(config.adminEmail), email: config.adminEmail });
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

  admin.get('/stats', (_req, res) => {
    const users = q.adminUsers.all().map(summary);
    const since = addDays(new Date().toISOString().slice(0, 10), -6);
    const w = q.countWorkoutsSince.get(since);
    res.json({ users: users.length, withPlan: users.filter((u) => u.hasPlan).length, coachDiets: users.filter((u) => u.coachDiet).length,
      workouts7d: w.n, activeUsers7d: w.users });
  });

  /** Search by member number ("4" or "#4"), name or email. */
  admin.get('/users', (req, res) => {
    const text = String(req.query.q ?? '').trim().toLowerCase().replace(/^#/, '');
    let users = q.adminUsers.all().map(summary);
    if (text) users = users.filter((u) => String(u.id) === text || u.name.toLowerCase().includes(text) || u.email.includes(text));
    res.json({ users });
  });

  const adminTarget = (id) => {
    const user = q.adminUser.get(Number(id));
    if (!user) throw new HttpError(404, `No member #${id}.`);
    return user;
  };

  admin.get('/users/:id', (req, res) => {
    const user = adminTarget(req.params.id);
    const profile = getProfile(user.id);
    const plan = profile && getPlan(user.id) ? needPlan(user.id).plan : null;
    const since = addDays(new Date().toISOString().slice(0, 10), -13);
    res.json({
      user: publicUser(user),
      profile,
      plan: plan ? expandPlan(plan) : null,
      // What the app would build automatically, so the coach can start from it or compare.
      autoNutrition: profile ? generatePlan(profile).nutrition : null,
      logs: {
        meals: q.mealLogsSince.all(user.id, since),
        water: q.waterSince.all(user.id, since),
        weights: q.weights.all(user.id),
        workouts: q.workouts.all(user.id, 20).map(rowToWorkout),
      },
    });
  });

  admin.get('/foods', (_req, res) => res.json({ foods: FOODS, cuisines: CUISINES }));

  /** Replace a member's whole week of meals (and optionally their daily targets). Shows in their app right away. */
  admin.put('/users/:id/diet', validate(S.adminDietSchema), (req, res) => {
    const user = adminTarget(req.params.id);
    const { plan } = needPlan(user.id);
    const unknown = req.body.days.flat().find((m) => !m.custom && !FOODS.some((f) => f.id === m.foodId));
    if (unknown) throw new HttpError(400, `Unknown dish "${unknown.foodId}".`);
    let n = 0;
    plan.meals = req.body.days.map((day) => day
      .map((m) => (m.custom
        ? { slot: m.slot, name: m.name, minute: toMinutes(m.time), foodId: `custom-${Date.now().toString(36)}-${n++}`, portion: m.portion, targetKcal: Math.round(m.custom.k * m.portion), custom: m.custom }
        : { slot: m.slot, name: m.name, minute: toMinutes(m.time), foodId: m.foodId, portion: m.portion, targetKcal: Math.round(FOODS.find((f) => f.id === m.foodId).k * m.portion) }))
      .sort((a, b) => a.minute - b.minute));
    plan.customDiet = { by: req.adminEmail, at: new Date().toISOString(), note: req.body.note ?? '' };
    plan.nutritionOverride = req.body.targets && Object.keys(req.body.targets).length ? req.body.targets : undefined;
    savePlan(user.id, plan);
    res.json({ plan: expandPlan(plan) });
  });

  /** Hand the member back to the automatic meal plan. */
  admin.delete('/users/:id/diet', (req, res) => {
    const user = adminTarget(req.params.id);
    const { plan, profile } = needPlan(user.id);
    delete plan.customDiet;
    delete plan.nutritionOverride;
    plan.meals = mealWeek(profile, plan.nutrition);
    plan.mealVersion = MEAL_VERSION;
    savePlan(user.id, plan);
    res.json({ plan: expandPlan(plan) });
  });

  app.use('/api/admin', admin);

  app.use('/api', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
