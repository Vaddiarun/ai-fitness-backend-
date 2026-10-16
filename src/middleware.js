import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const signToken = (user) => jwt.sign({ sub: String(user.id) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Sign in to continue.');
  try {
    req.userId = Number(jwt.verify(token, config.jwtSecret).sub);
  } catch {
    throw new HttpError(401, 'Your session has expired. Sign in again.');
  }
  next();
}

/** Parses req.body / req.query with a zod schema and replaces it with the clean value. */
export const validate = (schema, where = 'body') => (req, _res, next) => {
  const parsed = schema.parse(req[where] ?? {});
  if (where === 'query') req.validQuery = parsed;
  else req[where] = parsed;
  next();
};

export function notFound(_req, _res, next) {
  next(new HttpError(404, 'Not found.'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Some details are missing or invalid.',
      fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side. Try again.' : err.message });
}
