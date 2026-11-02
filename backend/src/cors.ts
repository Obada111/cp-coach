import cors from 'cors';

const DEFAULT_PUBLIC_ORIGIN = 'https://cp-coach-six.vercel.app';

export function getAllowedCorsOrigins(): string[] {
  const configuredOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const publicMode = process.env.PUBLIC_MODE === 'true';
  return configuredOrigins.length > 0
    ? configuredOrigins
    : (publicMode && process.env.NODE_ENV === 'production' ? [DEFAULT_PUBLIC_ORIGIN] : []);
}

export function createCorsMiddleware() {
  const allowedOrigins = getAllowedCorsOrigins();
  const allowVercelPreviews = process.env.ALLOW_VERCEL_PREVIEWS === 'true';

  return cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (allowVercelPreviews && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Coach-Client-Id', 'X-Coach-Handle'],
    exposedHeaders: ['Server-Timing'],
    credentials: false,
    maxAge: 86400,
  });
}
