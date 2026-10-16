const env = process.env;

if (!env.JWT_SECRET && env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  port: Number(env.PORT) || 4000,
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '30d',
  dbFile: env.DB_FILE || './data/ai-fitness.db',
  corsOrigin: env.CORS_ORIGIN || '*',
};
