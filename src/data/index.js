import { readFileSync } from 'node:fs';

const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));

/** id -> { id, name, muscles, equipment, timed, steps, tip, video:{youtubeId,length,channel} } */
export const EXERCISES = load('./exercises.json');
/** pools: slot -> exercise ids (heaviest equipment first); templates; splits: daysPerWeek -> { weekday: templateKey } */
export const { pools: POOLS, templates: TEMPLATES, splits: SPLITS } = load('./templates.json');
/** warmup / cooldown / stretch / walk follow-along videos */
export const EXTRA_VIDEOS = load('./extraVideos.json');
export const CUISINES = load('./cuisines.json');
/** { id, c: cuisine | 'all', s: 'b'|'s'|'l'|'d', n, q, k: kcal, p: protein g, d: vegan|veg|egg|nonveg, al: allergens[] } */
export const FOODS = load('./foods.json');
export const FOOD_BY_ID = new Map(FOODS.map((f) => [f.id, f]));
