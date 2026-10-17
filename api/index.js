import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

/** Opened once per serverless instance and reused. */
let appPromise = null;
const getApp = () => (appPromise ??= openDb(config.db).then(createApp));

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    appPromise = null; // let the next request retry opening the database
    console.error('Unhandled serverless error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
  }
}
