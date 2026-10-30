import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { db, deletePublicProfile, getOrCreatePublicProfile, getProfilesForOwner } from './db.js';
import { codeforcesService } from './codeforcesService.js';
import { exportPublicContext, importPublicContext } from './publicContextService.js';
import { apiRouter } from './routes.js';

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{2,64}$/;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const PUBLIC_INSTANCE_ID = randomUUID();
let requestCounter = 0;

function clientKey(req: Request, scope: string): string {
  return `${req.ip || 'unknown'}|${scope}`;
}

function rateLimit(scope: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = clientKey(req, scope);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    requestCounter += 1;
    if (requestCounter % 1000 === 0) {
      for (const [bucketKey, value] of buckets.entries()) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
      return;
    }
    next();
  };
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function getClientId(req: Request): string | null {
  const value = String(req.header('x-coach-client-id') || '').trim();
  return CLIENT_ID_PATTERN.test(value) ? value : null;
}

function getHandle(req: Request): string | null {
  const value = String(
    req.header('x-coach-handle') ||
    (typeof req.query.handle === 'string' ? req.query.handle : '') ||
    (req.body && typeof req.body === 'object' && typeof req.body.handle === 'string' ? req.body.handle : '')
  ).trim();
  return HANDLE_PATTERN.test(value) ? value : null;
}

function parseHandleList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return Array.from(new Set(
    value.split(',')
      .map((handle) => handle.trim())
      .filter((handle) => HANDLE_PATTERN.test(handle))
  )).slice(0, 10);
}

function dailyProblemOwnedBy(profileId: string, dailyProblemId: string): boolean {
  const row = db.prepare('SELECT profile_id FROM daily_problems WHERE id = ?').get(dailyProblemId) as
    | { profile_id: string }
    | undefined;
  return row?.profile_id === profileId;
}

function requireDailyProblemOwnership(req: Request, res: Response, next: NextFunction): void {
  const profileId = (req as any).publicProfile?.id as string | undefined;
  const dailyProblemId = String(req.params.id || req.body?.dailyProblemId || '');
  if (!profileId || !dailyProblemId || !dailyProblemOwnedBy(profileId, dailyProblemId)) {
    fail(res, 404, 'Daily problem assignment not found');
    return;
  }
  next();
}

function requireReviewOwnership(req: Request, res: Response, next: NextFunction): void {
  const profileId = (req as any).publicProfile?.id as string | undefined;
  const problemId = String(req.params.problemId || '');
  if (!profileId || !problemId) {
    fail(res, 404, 'Review item not found');
    return;
  }
  const row = db.prepare('SELECT id FROM review_queue WHERE profile_id = ? AND problem_id = ?').get(profileId, problemId);
  if (!row) {
    fail(res, 404, 'Review item not found');
    return;
  }
  next();
}

function requireSessionOwnership(req: Request, res: Response, next: NextFunction): void {
  const profileId = (req as any).publicProfile?.id as string | undefined;
  const sessionId = String(req.params.id || '');
  if (!profileId || !sessionId) {
    fail(res, 404, 'Solve session not found');
    return;
  }
  const row = db.prepare('SELECT profile_id FROM solve_sessions WHERE id = ?').get(sessionId) as
    | { profile_id: string }
    | undefined;
  if (row?.profile_id !== profileId) {
    fail(res, 404, 'Solve session not found');
    return;
  }
  next();
}

export const publicRouter = Router();

publicRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Public clients never need internal exception details. Keep the generic
  // error label, but never forward database or filesystem messages.
  const sendJson = res.json.bind(res);
  res.json = ((body: any) => {
    if (res.statusCode >= 500 && body && typeof body === 'object') {
      return sendJson({ error: typeof body.error === 'string' ? body.error : 'Internal server error' });
    }
    return sendJson(body);
  }) as typeof res.json;
  next();
});

publicRouter.use(rateLimit('read', 180, 60_000));
publicRouter.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return rateLimit('write', 30, 60_000)(req, res, next);
});

publicRouter.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      mode: 'public',
      instanceId: PUBLIC_INSTANCE_ID,
    });
  } catch {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      mode: 'public',
      instanceId: PUBLIC_INSTANCE_ID,
    });
  }
});

publicRouter.get('/profiles', (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return fail(res, 400, 'A valid X-Coach-Client-Id header is required');

  try {
    const requestedHandles = parseHandleList(req.query.handles);
    for (const handle of requestedHandles) {
      getOrCreatePublicProfile(clientId, handle);
    }
    const profiles = getProfilesForOwner(clientId);
    const headerHandle = String(req.header('x-coach-handle') || '').trim().toLowerCase();
    const active = profiles.find((profile) => profile.handle.toLowerCase() === headerHandle) || profiles[0];
    res.json({ profiles, activeProfileId: active?.id || '' });
  } catch (err) {
    console.error('[PublicAPI] Failed to list profiles:', err);
    fail(res, 500, 'Could not load browser profiles');
  }
});

publicRouter.post('/profiles', rateLimit('profile-create', 8, 60_000), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return fail(res, 400, 'A valid X-Coach-Client-Id header is required');
  const rawHandle = typeof req.body?.handle === 'string' ? req.body.handle.trim() : '';
  const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : undefined;
  if (!HANDLE_PATTERN.test(rawHandle)) return fail(res, 400, 'A valid Codeforces handle is required');

  try {
    const validation = await codeforcesService.validateHandle(rawHandle);
    if (!validation.valid || !validation.user) {
      return fail(res, 400, validation.error || `Codeforces handle '${rawHandle}' could not be verified.`);
    }
    const profile = getOrCreatePublicProfile(
      clientId,
      validation.user.handle,
      displayName || validation.user.firstName || validation.user.handle
    );
    res.json({
      success: true,
      profile,
      message: `Profile '${profile.handle}' is ready.`,
    });
  } catch (err: any) {
    console.warn('[PublicAPI] Handle validation failed:', err?.message || err);
    fail(res, 503, 'Codeforces is temporarily unavailable. Please try again.');
  }
});

publicRouter.post('/profiles/:id/select', (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return fail(res, 400, 'A valid X-Coach-Client-Id header is required');
  const profile = getProfilesForOwner(clientId).find((item) => item.id === req.params.id);
  if (!profile) return fail(res, 404, 'Profile not found');
  res.json({ success: true, profile });
});

publicRouter.delete('/profiles/:id', (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return fail(res, 400, 'A valid X-Coach-Client-Id header is required');
  try {
    if (!deletePublicProfile(clientId, req.params.id)) return fail(res, 404, 'Profile not found');
    res.json({ success: true, message: 'Profile removed from this browser.' });
  } catch (err) {
    console.error('[PublicAPI] Failed to delete profile:', err);
    fail(res, 500, 'Could not remove this profile');
  }
});

publicRouter.get('/handle/validate', rateLimit('handle-validate', 20, 60_000), async (req, res) => {
  const handle = typeof req.query.handle === 'string' ? req.query.handle.trim() : '';
  if (!HANDLE_PATTERN.test(handle)) return fail(res, 400, 'A valid Codeforces handle is required');
  try {
    const validation = await codeforcesService.validateHandle(handle);
    if (!validation.valid || !validation.user) {
      return fail(res, 400, validation.error || 'Codeforces handle could not be verified');
    }
    res.json({ valid: true, user: validation.user });
  } catch (err: any) {
    console.warn('[PublicAPI] Handle lookup failed:', err?.message || err);
    fail(res, 503, 'Codeforces is temporarily unavailable. Please try again.');
  }
});

publicRouter.use((req, res, next) => {
  const clientId = getClientId(req);
  if (!clientId) return fail(res, 400, 'A valid X-Coach-Client-Id header is required');
  const handle = getHandle(req);
  if (!handle) return fail(res, 400, 'A valid Codeforces handle is required');

  try {
    const profile = getOrCreatePublicProfile(clientId, handle);
    (req as any).publicProfile = profile;
    (req as any).publicClientId = clientId;

    if (req.query && typeof req.query === 'object') {
      (req.query as any).profileId = profile.id;
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      req.body.profileId = profile.id;
    }
    next();
  } catch (err) {
    console.error('[PublicAPI] Failed to resolve public profile:', err);
    fail(res, 500, 'Could not resolve this browser profile');
  }
});

publicRouter.get('/context', (req, res) => {
  try {
    const profileId = (req as any).publicProfile.id as string;
    res.json(exportPublicContext(profileId));
  } catch (err) {
    console.error('[PublicAPI] Failed to export context:', err);
    fail(res, 500, 'Could not export browser context');
  }
});

publicRouter.post('/context', (req, res) => {
  try {
    const profileId = (req as any).publicProfile.id as string;
    const context = req.body?.context ?? req.body;
    const result = importPublicContext(profileId, context);
    res.json(result);
  } catch (err: any) {
    console.warn('[PublicAPI] Context restore rejected:', err?.message || err);
    fail(res, 400, 'Could not restore browser context');
  }
});

publicRouter.get('/network-info', (_req, res) => {
  fail(res, 404, 'Not found');
});

publicRouter.post('/problems/:id/open', requireDailyProblemOwnership);
publicRouter.post('/problems/:id/feedback', requireDailyProblemOwnership);
publicRouter.post('/daily/replace', requireDailyProblemOwnership);
publicRouter.post('/reviews/:problemId/action', requireReviewOwnership);
publicRouter.post('/sessions/:id/hint', requireSessionOwnership);
publicRouter.post('/sessions/:id/editorial', requireSessionOwnership);
publicRouter.post('/sessions/:id/finish', requireSessionOwnership);

// Codeforces-backed operations are more expensive than ordinary reads and
// writes, so they get a tighter per-IP budget in addition to the global one.
publicRouter.post('/sync', rateLimit('sync', 5, 60_000));
publicRouter.post('/contests/sync', rateLimit('contest-sync', 5, 60_000));
publicRouter.post('/contests/import', rateLimit('contest-import', 10, 60_000));

publicRouter.use(apiRouter);
