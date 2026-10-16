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
  const app = getApp();
  return app(req, res);
}
