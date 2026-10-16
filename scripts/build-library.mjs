// Builds src/data/library.json from the public-domain free-exercise-db (github.com/yuhonas/free-exercise-db)
// and links our 38 coached plan exercises (with YouTube tutorials) to their matching database entries.
//   node scripts/build-library.mjs            -> uses src/data/vendor/free-exercise-db.json
//   node scripts/build-library.mjs --download -> refreshes the vendor file first
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../src/data/', import.meta.url);
const vendorFile = new URL('vendor/free-exercise-db.json', root);
const SOURCE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';
const IMAGE_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';

if (process.argv.includes('--download')) {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  mkdirSync(new URL('vendor/', root), { recursive: true });
  writeFileSync(vendorFile, await res.text());
}

const raw = JSON.parse(readFileSync(vendorFile, 'utf8'));
const coached = JSON.parse(readFileSync(new URL('exercises.json', root), 'utf8'));

// coached plan exercise id -> free-exercise-db id (null where the database has no equivalent)
const LINK = {
  pushup: 'Pushups', inclinepush: 'Incline_Push-Up', dbbench: 'Dumbbell_Bench_Press', bench: 'Barbell_Bench_Press_-_Medium_Grip',
  machinepress: 'Machine_Bench_Press', pike: null, dbpress: 'Dumbbell_Shoulder_Press', lateral: 'Side_Lateral_Raise',
  dips: 'Bench_Dips', ohext: 'Dumbbell_One-Arm_Triceps_Extension', pushdown: 'Triceps_Pushdown', tablerow: 'Inverted_Row',
  superman: 'Superman', dbrow: 'One-Arm_Dumbbell_Row', bentrow: 'Bent_Over_Two-Dumbbell_Row', pulldown: 'Wide-Grip_Lat_Pulldown',
  cablerow: 'Seated_Cable_Rows', facepull: 'Face_Pull', revfly: 'Reverse_Flyes', curl: 'Dumbbell_Bicep_Curl', towelcurl: null,
  sqbw: 'Bodyweight_Squat', goblet: 'Goblet_Squat', backsquat: 'Barbell_Squat', legpress: 'Leg_Press', lunge: 'Bodyweight_Walking_Lunge',
  dblunge: 'Dumbbell_Rear_Lunge', rdl: 'Stiff-Legged_Dumbbell_Deadlift', glutebridge: 'Butt_Lift_Bridge', stepup: 'Dumbbell_Step_Ups',
  calf: 'Standing_Calf_Raises', wallsit: null, plank: 'Plank', deadbug: 'Dead_Bug', bicycle: 'Air_Bike', mountain: 'Mountain_Climbers',
  highknees: null, march: null,
};

const byId = new Map(raw.map((x) => [x.id, x]));
const missing = Object.entries(LINK).filter(([, v]) => v && !byId.has(v));
if (missing.length) throw new Error('Unknown database ids: ' + missing.map(([k, v]) => `${k}->${v}`).join(', '));
const coachedFor = new Map(Object.entries(LINK).filter(([, v]) => v).map(([k, v]) => [v, k]));

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ytSearch = (name) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(`how to do ${name} proper form`);

const library = raw.map((x) => {
  const c = coachedFor.get(x.id);
  return {
    id: slug(x.id),
    sourceId: x.id,
    name: x.name,
    category: x.category,
    level: x.level,
    force: x.force ?? null,
    mechanic: x.mechanic ?? null,
    equipment: x.equipment ?? 'none',
    primaryMuscles: x.primaryMuscles,
    secondaryMuscles: x.secondaryMuscles,
    instructions: x.instructions,
    images: x.images.map((p) => IMAGE_BASE + p),
    coachedId: c ?? null,
    video: c ? coached[c].video : null,
    videoSearchUrl: ytSearch(x.name),
  };
});

// coached moves the database lacks still belong in the library
for (const [c, v] of Object.entries(LINK)) {
  if (v) continue;
  const e = coached[c];
  library.push({
    id: 'coached-' + c, sourceId: null, name: e.name, category: e.timed ? 'cardio' : 'strength', level: 'beginner',
    force: null, mechanic: null, equipment: e.equipment === 'none' ? 'body only' : e.equipment, primaryMuscles: [e.muscles.split(',')[0].trim().toLowerCase()],
    secondaryMuscles: [], instructions: e.steps, images: [], coachedId: c, video: e.video, videoSearchUrl: ytSearch(e.name),
  });
}
library.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(new URL('library.json', root), JSON.stringify(library) + '\n');

// write the link back onto coached exercises so plan screens can show photos too
for (const [c, v] of Object.entries(LINK)) {
  const entry = library.find((l) => l.coachedId === c && (v ? l.sourceId === v : true));
  coached[c].libraryId = entry.id;
  coached[c].images = entry.images;
}
writeFileSync(new URL('exercises.json', root), JSON.stringify(coached, null, 1) + '\n');
console.log(`library.json: ${library.length} exercises (${library.filter((l) => l.video).length} with a coached video)`);
