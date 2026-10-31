import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  db,
  deletePublicProfile,
  getOrCreatePublicProfile,
  getProfilesForOwner,
  getPublicProfileOwner,
} from './db.js';
import { codeforcesService } from './codeforcesService.js';
import { exportPublicContext, importPublicContext } from './publicContextService.js';
import { apiRouter } from './routes.js';
import { notificationsService } from './notificationsService.js';
import { cloudflareNotificationRepository } from './cloudflareNotificationRepository.js';

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

const NOTIFICATION_SNAPSHOT_MIN_INTERVAL_MS = 60_000;
const lastNotificationSnapshotSyncAt = new Map<string, number>();
const inFlightNotificationSnapshots = new Map<string, Promise<void>>();

function scheduleNotificationSnapshotSync(profileId: string, ownerId: string, force = false): void {
  if (inFlightNotificationSnapshots.has(profileId)) return;
  const lastSyncAt = lastNotificationSnapshotSyncAt.get(profileId) || 0;
  if (!force && Date.now() - lastSyncAt < NOTIFICATION_SNAPSHOT_MIN_INTERVAL_MS) return;

  const task = cloudflareNotificationRepository
    .syncDailySnapshot(profileId, ownerId)
    .then(() => {
      lastNotificationSnapshotSyncAt.set(profileId, Date.now());
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'Unknown synchronization error';
      console.warn('[Notifications] Daily snapshot synchronization to Cloudflare failed:', reason);
    })
    .finally(() => {
      if (inFlightNotificationSnapshots.get(profileId) === task) {
        inFlightNotificationSnapshots.delete(profileId);
      }
    });

  inFlightNotificationSnapshots.set(profileId, task);
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
      if (validation.error?.startsWith('Codeforces check failed:')) {
        return fail(res, 503, 'Codeforces could not be reached right now. Please try again in a moment.');
      }
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

publicRouter.delete('/profiles/:id', async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return fail(res, 400, 'A valid X-Coach-Client-Id header is required');
  const ownerId = clientId.trim().toLowerCase();
  if (getPublicProfileOwner(req.params.id) !== ownerId) return fail(res, 404, 'Profile not found');
  if (cloudflareNotificationRepository.isConfigured()) {
    try {
      await cloudflareNotificationRepository.deleteProfile(req.params.id, ownerId);
    } catch {
      console.warn('[Notifications] Profile removal could not be synchronized to Cloudflare.');
      return fail(res, 503, 'Could not remove notification data. Please try again.');
    }
  }
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
      if (validation.error?.startsWith('Codeforces check failed:')) {
        return fail(res, 503, 'Codeforces could not be reached right now. Please try again in a moment.');
      }
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
    const ownerId = clientId.trim().toLowerCase();
    const profile = getOrCreatePublicProfile(clientId, handle);
    (req as any).publicProfile = profile;
    (req as any).publicClientId = ownerId;

    if (req.query && typeof req.query === 'object') {
      (req.query as any).profileId = profile.id;
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      req.body.profileId = profile.id;
    }
    const shouldSyncNotificationSnapshot =
      (req.method === 'GET' && ['/dashboard', '/daily'].includes(req.path)) ||
      (req.method !== 'GET' && [
        '/context',
        '/sync',
        '/daily/replace',
      ].includes(req.path)) ||
      (req.method === 'POST' && /^\/problems\/[^/]+\/feedback$/.test(req.path));
    if (shouldSyncNotificationSnapshot && cloudflareNotificationRepository.isConfigured()) {
      const sendJson = res.json.bind(res);
      let snapshotScheduled = false;
      res.json = ((body?: any) => {
        const result = sendJson(body);
        if (res.statusCode < 400 && !snapshotScheduled) {
          snapshotScheduled = true;
          scheduleNotificationSnapshotSync(profile.id, ownerId, req.method !== 'GET');
        }
        return result;
      }) as typeof res.json;
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

publicRouter.post('/context', rateLimit('context-import', 25, 60_000), (req, res) => {
  try {
    const profileId = (req as any).publicProfile.id as string;
    const context = req.body?.context ?? req.body;
    const requestedMode = req.body?.mode;
    if (requestedMode !== undefined && requestedMode !== 'merge' && requestedMode !== 'replace') {
      return fail(res, 400, 'Import mode must be merge or replace');
    }
    const result = importPublicContext(profileId, context, { mode: requestedMode || 'merge' });
    res.json(result);
  } catch (err: any) {
    const message = String(err?.message || '');
    const safeMessage = (
      message === 'Context must be an object' ||
      message === 'Import mode must be merge or replace' ||
      message === 'This backup belongs to a different Codeforces handle' ||
      message.startsWith('Unsupported context version:') ||
      message.startsWith('Invalid browser context') ||
      message.startsWith('Invalid learner-state timestamp') ||
      message.startsWith('Backup ')
    ) ? message : 'Could not restore browser context';
    console.warn('[PublicAPI] Context restore rejected:', message || err);
    fail(res, 400, safeMessage);
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

publicRouter.get('/notifications/config', (_req, res) => {
  res.json(notificationsService.getPublicConfig());
});

publicRouter.get('/notifications/settings', async (req, res) => {
  try {
    const profileId = (req as any).publicProfile.id as string;
    if (cloudflareNotificationRepository.isConfigured()) {
      const ownerId = (req as any).publicClientId as string;
      const handle = (req as any).publicProfile.handle as string;
      const settings = await cloudflareNotificationRepository.getSettings(profileId, ownerId, handle);
      return res.json({ available: notificationsService.isAvailable(), settings });
    }
    res.json({
      available: notificationsService.isAvailable(),
      settings: notificationsService.getSettings(profileId),
    });
  } catch (err) {
    console.error('[PublicAPI] Failed to load notification settings:', err);
    fail(res, 500, 'Could not load notification settings');
  }
});

publicRouter.get('/notifications/subscriptions/status', async (req, res) => {
  const profileId = (req as any).publicProfile.id as string;
  const ownerId = (req as any).publicClientId as string;
  const handle = (req as any).publicProfile.handle as string;
  try {
    const registered = cloudflareNotificationRepository.isConfigured()
      ? await cloudflareNotificationRepository.hasSubscription(profileId, ownerId, handle, req.query.endpoint)
      : notificationsService.hasSubscription(profileId, ownerId, req.query.endpoint);
    res.json({ registered });
  } catch (err) {
    console.error('[PublicAPI] Failed to verify push subscription state:', err);
    fail(res, 503, 'Could not verify this device subscription');
  }
});

publicRouter.put('/notifications/settings', async (req, res) => {
  try {
    const profileId = (req as any).publicProfile.id as string;
    const ownerId = (req as any).publicClientId as string;
    const handle = (req as any).publicProfile.handle as string;
    const input = {
      contestReminders: req.body?.contestReminders,
      dailyReminders: req.body?.dailyReminders,
      reminderTime: req.body?.reminderTime,
    };
    if (
      typeof input.contestReminders !== 'boolean' ||
      typeof input.dailyReminders !== 'boolean'
    ) {
      return fail(res, 400, 'Reminder settings must be boolean values');
    }
    if (typeof input.reminderTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.reminderTime)) {
      return fail(res, 400, 'Reminder time must use 24-hour HH:mm format');
    }
    const settings = cloudflareNotificationRepository.isConfigured()
      ? await cloudflareNotificationRepository.updateSettings(profileId, ownerId, handle, input)
      : notificationsService.updateSettings(profileId, input);
    res.json({ success: true, settings });
  } catch (err: any) {
    const message = err?.message === 'Reminder time must use 24-hour HH:mm format' ||
      err?.message === 'Reminder settings must be boolean values'
      ? err.message
      : 'Could not update notification settings';
    if (message !== 'Could not update notification settings') return fail(res, 400, message);
    console.error('[PublicAPI] Failed to update notification settings:', err);
    fail(res, 500, message);
  }
});

publicRouter.post('/notifications/subscriptions', async (req, res) => {
  if (!notificationsService.isAvailable()) {
    return fail(res, 503, 'Push notifications are not configured for this deployment');
  }
  try {
    const profileId = (req as any).publicProfile.id as string;
    const ownerId = (req as any).publicClientId as string;
    const handle = (req as any).publicProfile.handle as string;
    if (cloudflareNotificationRepository.isConfigured()) {
      await cloudflareNotificationRepository.registerSubscription(profileId, ownerId, handle, req.body?.subscription);
    } else {
      notificationsService.registerSubscription(profileId, ownerId, req.body?.subscription);
    }
    res.status(201).json({ success: true });
  } catch (err: any) {
    if (
      err?.message === 'A valid HTTPS push subscription is required' ||
      err?.message === 'This device is already registered to another profile'
    ) {
      return fail(res, err.message.startsWith('This device') ? 409 : 400, err.message);
    }
    console.error('[PublicAPI] Failed to register push subscription:', err);
    fail(res, 500, 'Could not register this device for push notifications');
  }
});

publicRouter.delete('/notifications/subscriptions', async (req, res) => {
  try {
    const profileId = (req as any).publicProfile.id as string;
    const ownerId = (req as any).publicClientId as string;
    const handle = (req as any).publicProfile.handle as string;
    if (cloudflareNotificationRepository.isConfigured()) {
      await cloudflareNotificationRepository.removeSubscription(profileId, ownerId, handle, req.body?.endpoint);
    } else {
      notificationsService.removeSubscription(profileId, ownerId, req.body?.endpoint);
    }
    res.json({ success: true });
  } catch (err: any) {
    if (err?.message === 'A valid push endpoint is required') return fail(res, 400, err.message);
    console.error('[PublicAPI] Failed to remove push subscription:', err);
    fail(res, 500, 'Could not remove this device subscription');
  }
});

// Codeforces-backed operations are more expensive than ordinary reads and
// writes, so they get a tighter per-IP budget in addition to the global one.
publicRouter.post('/sync', rateLimit('sync', 5, 60_000));
publicRouter.post('/contests/sync', rateLimit('contest-sync', 5, 60_000));
publicRouter.post('/contests/import', rateLimit('contest-import', 10, 60_000));

publicRouter.use(apiRouter);
