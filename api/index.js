import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let appInstance = null;

function getApp() {
  if (!appInstance) {
    const db = openDb(config.dbFile);
    appInstance = createApp(db);
  }
  return appInstance;
}

export default function handler(req, res) {
  try {
    const app = getApp();
    return app(req, res);
  } catch (err) {
    console.error('Unhandled serverless error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Internal server error', stack: err.stack }));
  }
}
