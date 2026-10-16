# AI Fitness — backend (Node.js)

Express API for the AI Fitness app: accounts, profile, generated workout and meal plans, logging, progress, reminder schedule and a full exercise library.

- **Node 22.13+** (uses the built-in `node:sqlite`, so no database install).
- Express 5 · JWT auth · bcrypt · zod validation · helmet · CORS.

## Run

```bash
npm install
cp .env.example .env      # change JWT_SECRET before deploying
npm run dev               # http://localhost:4000/api
npm test                  # end-to-end API tests (in-memory DB)
npm run seed              # demo account with ~3 weeks of history (login is in scripts/seed-demo.mjs)
```

## How plans are built (`src/services/planEngine.js`)

| Input | Effect |
|---|---|
| Height, weight, age, sex | BMR (Mifflin–St Jeor), BMI, healthy weight range |
| Daily activity | TDEE multiplier (1.2–1.725) |
| Goal | Calories −20% (fat loss) … +10% (muscle); protein 1.4–2 g/kg; rep ranges and rest |
| Target weight | Weeks to goal at 0.5 kg/week (loss) or 0.25 kg/week (gain) |
| Days/week, minutes, equipment, level | Split (full body / upper-lower / push-pull-legs), exercise picks, sets |
| Knee / back pain | Swaps lunges, step-ups, heavy hinges and jumping for safer moves |
| Cuisine, diet, allergies, meals/day | 7-day menu from 145 dishes in 7 cuisines; allergies are never relaxed |
| Wake / sleep time | Meal times and reminder schedule |

## Data

- `src/data/exercises.json`: 38 coached plan exercises, each with steps, a coach tip and a real YouTube tutorial.
- `src/data/library.json`: **881 exercises** built from [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (public domain): instructions, muscles, equipment, level, start/end photos. Coached ones link to their videos. Rebuild with `npm run build:library` (add `-- --download` to refresh the source).
- `src/data/foods.json`, `cuisines.json`: dishes with kcal, protein, diet type and allergens.

## API (all under `/api`; 🔒 = `Authorization: Bearer <token>`)

| Method | Path | |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | `{ token, user, profile }` |
| GET / DELETE | `/me` 🔒 | account + profile / delete account |
| PUT | `/profile` 🔒 | save profile and regenerate plan |
| PUT | `/settings` 🔒 | reminder toggles |
| GET | `/plan` 🔒 · POST `/plan/regenerate` 🔒 | expanded plan (exercise + dish details) |
| POST | `/plan/meals/swap` 🔒 `{day, index}` | next dish that fits; `swapped:false` if none |
| PUT | `/plan/cuisine` 🔒 `{cuisine}` | rebuild meals, same calories |
| GET | `/today?date=&weekday=` 🔒 | workout, meals with eaten flags, water, completed workout |
| GET | `/reminders` 🔒 | weekly schedule the app turns into local notifications |
| POST | `/logs/meals`, `/logs/water`, `/logs/weights`, `/logs/workouts` 🔒 | logging |
| GET | `/logs/weights`, `/logs/workouts`, `/logs/workouts/:id` 🔒 | history |
| GET | `/exercises/:id/last` 🔒 | last sets + progression advice |
| GET | `/progress?date=&weekday=` 🔒 | week count, streak, weights, history |
| GET | `/library/exercises?q=&muscle=&equipment=&level=&category=&page=&limit=` | search the 881-exercise library |
| GET | `/library/exercises/:id`, `/catalog`, `/health` | |

Dates come from the phone (`YYYY-MM-DD` + weekday) so "today" always matches the user's timezone.

## Before production

- Set a strong `JWT_SECRET`, restrict `CORS_ORIGIN`, serve over HTTPS.
- Move to Postgres when you need multiple server instances (queries are in `src/app.js`).
- Add phone-OTP / Google sign-in, rate limiting on `/auth/*`, and password reset.
- Host your own exercise clips; YouTube videos can be removed by their owners.
