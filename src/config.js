const env = process.env;

const isServerless = Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);

if (!env.JWT_SECRET && env.NODE_ENV === 'production') {
  console.warn('⚠️ WARNING: JWT_SECRET not found in environment; using a default fallback. Set JWT_SECRET in your Vercel Project Settings for security.');
}

export const config = {
  port: Number(env.PORT) || 4000,
  jwtSecret: env.JWT_SECRET || 'fitness-ai-production-fallback-secret-2026',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '30d',
  dbFile: env.DB_FILE || (isServerless ? '/tmp/ai-fitness.db' : './data/ai-fitness.db'),
  corsOrigin: env.CORS_ORIGIN || '*',
};
