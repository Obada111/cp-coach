import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { db, initDatabase } from './db.js';
import { apiRouter } from './routes.js';
import { publicRouter } from './publicRoutes.js';
import { requireApiToken, requireConfiguredToken } from './auth.js';
import { codeforcesCacheService } from './codeforcesCacheService.js';
import { notificationsService } from './notificationsService.js';

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Keep local loopback traffic off any proxy configuration so localhost API
// checks and browser-local dev servers remain reliable.
process.env.NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.1,[::1],*';
process.env.no_proxy = process.env.no_proxy || process.env.NO_PROXY;

// Initialize SQLite database
const databaseInitStartedAt = performance.now();
initDatabase();
if (process.env.PERF_TIMINGS === 'true') {
  console.log(JSON.stringify({
    scope: 'perf',
    label: 'startup',
    databaseInitMs: Math.round((performance.now() - databaseInitStartedAt) * 10) / 10,
  }));
}
notificationsService.startBackgroundWorker();

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';

const isLoopbackHost = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (process.env.NODE_ENV === 'production' && !isLoopbackHost && !PUBLIC_MODE && !process.env.COACH_API_TOKEN?.trim()) {
  throw new Error('COACH_API_TOKEN is required when the private production backend is exposed beyond loopback');
}

const DEFAULT_PUBLIC_ORIGIN = 'https://cp-coach-six.vercel.app';
const configuredOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins.length > 0
  ? configuredOrigins
  : (PUBLIC_MODE && process.env.NODE_ENV === 'production' ? [DEFAULT_PUBLIC_ORIGIN] : []);
const allowVercelPreviews = process.env.ALLOW_VERCEL_PREVIEWS === 'true';

app.use(cors({
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
  credentials: false,
  maxAge: 86400,
}));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const defaultJsonParser = express.json({ limit: '1mb' });
const backupJsonParser = express.json({ limit: '11mb' });
app.use((req, res, next) => {
  const isContextImport = req.method === 'POST' && req.path === '/api/public/context';
  return (isContextImport ? backupJsonParser : defaultJsonParser)(req, res, next);
});

// Public browser API: no server secret is embedded in the frontend.
app.use('/api/public', publicRouter);

// The legacy profile/database API remains private. On a public deployment it
// is only reachable with an explicitly configured admin token; otherwise it is
// completely disabled.
if (PUBLIC_MODE) {
  app.use('/api/admin', requireConfiguredToken, apiRouter);
} else {
  app.use('/api', requireApiToken, apiRouter);
}

// Health check
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.json({
      status: 'ok',
      database: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Health] Database readiness check failed:', err);
    res.status(503).json({
      status: 'degraded',
      database: 'unavailable',
      timestamp: new Date().toISOString(),
    });
  }
});

// Production: serve built frontend if available
const distPath = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Centralized error handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled server error:', err);
  const message = process.env.NODE_ENV === 'production'
    ? 'An unexpected server error occurred'
    : (err.message || 'An unexpected error occurred');
  res.status(500).json({
    error: 'Internal server error',
    message,
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[CP Coach Backend] Server running on http://${HOST}:${PORT}`);
  console.log(`[CP Coach Backend] Mode: ${PUBLIC_MODE ? 'public browser-local' : 'private local'}`);
  if (PUBLIC_MODE && allowedOrigins.length === 0) {
    console.log('[CP Coach Backend] CORS: allowing browser origins (set CORS_ORIGINS to restrict them).');
  }
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[CP Coach Backend] Received ${signal}; waiting for active work to finish...`);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await codeforcesCacheService.shutdown();
  await notificationsService.shutdown();
  db.close();
  console.log('[CP Coach Backend] Shutdown complete.');
};

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

export default app;
