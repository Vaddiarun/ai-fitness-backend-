import { z } from 'zod';
import { CUISINES } from './data/index.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const cuisineIds = CUISINES.map((c) => c.id);

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const weekday = z.number().int().min(0).max(6);
/** Exactly two different recovery weekdays (0 = Sunday). */
const restDays = z.array(weekday).length(2).refine((d) => d[0] !== d[1], 'Pick two different rest days');
export const restDaysSchema = z.object({ restDays });

/** Height is always centimetres and weight always kilograms; the app converts imperial input before sending. */
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(60),
  age: z.coerce.number().int().min(13).max(90),
  gender: z.enum(['female', 'male', 'other']),
  height: z.coerce.number().min(120).max(230),
  weight: z.coerce.number().min(30).max(250),
  targetWeight: z.coerce.number().min(30).max(250).nullable().optional(),
  units: z.enum(['metric', 'imperial']).default('metric'),
  goal: z.enum(['lose', 'muscle', 'strength', 'fit', 'maintain']),
  activity: z.enum(['sedentary', 'light', 'moderate', 'very']),
  level: z.enum(['beginner', 'novice', 'intermediate', 'advanced']),
  location: z.enum(['none', 'db', 'gym']),
  days: z.coerce.number().int().min(2).max(6).optional(), // ignored: every plan trains 5 days; older app builds still send it
  restDays: restDays.optional(),
  duration: z.union([z.literal(30), z.literal(45), z.literal(60)]),
  workoutTime: hhmm,
  conditions: z.array(z.enum(['knee', 'back', 'bp', 'diabetes', 'pregnant'])).default([]),
  cuisine: z.enum(cuisineIds),
  diet: z.enum(['vegan', 'veg', 'egg', 'nonveg']),
  meals: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  allergies: z.array(z.enum(['dairy', 'nuts', 'gluten', 'egg', 'soy', 'fish'])).default([]),
  wake: hhmm,
  sleep: hhmm,
});

export const settingsSchema = z.object({
  meals: z.boolean(), workout: z.boolean(), water: z.boolean(), sleep: z.boolean(),
}).partial();

export const swapSchema = z.object({ day: z.number().int().min(0).max(6), index: z.number().int().min(0).max(9) });

/* ---------- admin portal ---------- */
export const adminLoginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

/** A dish the coach writes themselves when it isn't in the catalog. */
const customFood = z.object({
  n: z.string().trim().min(1, 'Name the dish').max(120),
  q: z.string().trim().max(80).default(''),
  k: z.coerce.number().min(0).max(3000),
  p: z.coerce.number().min(0).max(300),
});
const adminMeal = z.object({
  name: z.string().trim().min(1, 'Name the meal').max(40),
  time: hhmm,
  slot: z.enum(['b', 's', 'l', 'd', 'x']),
  foodId: z.string().max(40).optional(),
  portion: z.coerce.number().min(0.25).max(5).default(1),
  custom: customFood.optional(),
}).refine((m) => m.foodId || m.custom, 'Pick a dish from the catalog or write one');

export const adminDietSchema = z.object({
  /** 7 days indexed by JS weekday (0 = Sunday), each with 1–8 meals. */
  days: z.array(z.array(adminMeal).min(1, 'Every day needs at least one meal').max(8)).length(7),
  targets: z.object({
    kcal: z.coerce.number().int().min(800).max(6000),
    protein: z.coerce.number().int().min(20).max(400),
    carbs: z.coerce.number().int().min(0).max(900),
    fat: z.coerce.number().int().min(0).max(300),
    waterGlasses: z.coerce.number().int().min(4).max(20),
  }).partial().optional(),
  note: z.string().trim().max(500).optional(),
});
export const cuisineSchema = z.object({ cuisine: z.enum(cuisineIds) });
export const dateQuery = z.object({ date: isoDate, weekday: z.coerce.number().int().min(0).max(6) });

export const mealLogSchema = z.object({ date: isoDate, index: z.number().int().min(0).max(9), eaten: z.boolean() });
export const waterLogSchema = z.object({ date: isoDate, delta: z.number().int().min(-5).max(5) });
export const weightLogSchema = z.object({ date: isoDate, kg: z.number().min(30).max(250) });

const setSchema = z.object({
  reps: z.coerce.number().min(0).max(1000).nullable().optional(),
  weight: z.coerce.number().min(0).max(1000).nullable().optional(),
  done: z.boolean(),
});
export const workoutLogSchema = z.object({
  date: isoDate,
  kind: z.enum(['plan', 'extra']),
  name: z.string().trim().min(1).max(80),
  mins: z.number().int().min(1).max(600),
  rpe: z.number().int().min(1).max(10).optional(),
  feel: z.enum(['great', 'ok', 'tired', 'pain']).optional(),
  notes: z.string().max(1000).optional(),
  exercises: z.array(z.object({ id: z.string().max(40), sets: z.array(setSchema).max(10) })).max(12).default([]),
});
