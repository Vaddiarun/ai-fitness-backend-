import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  settings      TEXT NOT NULL DEFAULT '{"meals":true,"workout":true,"water":true,"sleep":true}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS plans (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workout_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('plan','extra')),
  name       TEXT NOT NULL,
  mins       INTEGER NOT NULL,
  rpe        INTEGER,
  feel       TEXT,
  notes      TEXT,
  exercises  TEXT NOT NULL DEFAULT '[]',
  volume     REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS workout_logs_user_date ON workout_logs(user_id, date);
CREATE TABLE IF NOT EXISTS weight_logs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  kg      REAL NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS meal_logs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  slot_index INTEGER NOT NULL,
  rev        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, date, slot_index)
);
CREATE TABLE IF NOT EXISTS admins (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS water_logs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  glasses INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);
`;

/**
 * Opens the database: a hosted Turso/libSQL database (libsql://… with an auth token) when configured,
 * otherwise a local SQLite file, or ":memory:" for tests. Same tables and SQL either way.
 * Returns a small `prepare(sql)` → { get, all, run } API (async) so the routes read like before.
 */
export async function openDb({ url, authToken }) {
  if (url.startsWith('file:')) {
    try { mkdirSync(dirname(url.slice('file:'.length)), { recursive: true }); } catch { /* exists or read-only; libsql reports real problems */ }
  }
  const client = createClient({ url, authToken });
  await client.executeMultiple(SCHEMA);
  // Columns added after the first release; ALTER fails harmlessly when the column already exists.
  for (const sql of ["ALTER TABLE meal_logs ADD COLUMN rev TEXT NOT NULL DEFAULT ''"]) {
    try { await client.execute(sql); } catch { /* already there */ }
  }
  // Plain objects keyed by column name (libsql rows are array-like).
  const objects = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
  return {
    client,
    prepare(sql) {
      const exec = (args) => client.execute({ sql, args });
      return {
        get: async (...args) => objects(await exec(args))[0],
        all: async (...args) => objects(await exec(args)),
        run: async (...args) => {
          const r = await exec(args);
          return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid == null ? undefined : Number(r.lastInsertRowid) };
        },
      };
    },
  };
}

export const parse = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
