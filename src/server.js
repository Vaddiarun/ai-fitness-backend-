import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const db = await openDb(config.db);
const app = createApp(db);

app.listen(config.port, '0.0.0.0', () => {
  const where = config.db.url.startsWith('libsql') ? 'Turso (hosted)' : config.db.url;
  console.log(`AI Fitness API listening on http://localhost:${config.port}/api · database: ${where}`);
});
