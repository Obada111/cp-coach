import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  db,
  deletePublicProfile,
  getOrCreatePublicProfile,
  getProfilesForOwner,
  getPublicProfileOwner,
  getProfileForOwner,
  isProfileOwnedBy,
  claimLegacyProfile,
  getProfileById,
} from './db.js';
import type { UserProfile } from './types.js';
import { codeforcesService } from './codeforcesService.js';
import { codeforcesCacheService } from './codeforcesCacheService.js';
import { exportPublicContext, importPublicContext } from './publicContextService.js';
import { apiRouter } from './routes.js';
import { notificationsService } from './notificationsService.js';
import { cloudflareNotificationRepository } from './cloudflareNotificationRepository.js';
import { requireAuthUser, type AuthenticatedRequest } from './authMiddleware.js';
import { isSocialDatabaseConfigured, withUserTransaction } from './socialDatabase.js';
import { getDatabaseHealthSummary } from './databaseMaintenance.js';
import { saveDurableCloudContext, loadDurableCloudContext } from './durableContextStorage.js';

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

export function getVerifiedOwnerId(req: Request): string | null {
  const authUser = (req as AuthenticatedRequest).user;
  return authUser?.userId ? authUser.userId.trim().toLowerCase() : null;
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

function dailyProblemOwnedBy(profileId: string, ownerId: string, dailyProblemId: string): boolean {
  const row = db.prepare(`
    SELECT dp.id FROM daily_problems dp
    JOIN profiles p ON p.id = dp.profile_id
    WHERE dp.id = ? AND dp.profile_id = ? AND lower(p.owner_id) = lower(?)
  `).get(dailyProblemId, profileId, ownerId);
  return Boolean(row);
}

function requireDailyProblemOwnership(req: Request, res: Response, next: NextFunction): void {
  const profileId = (req as any).publicProfile?.id as string | undefined;
  const ownerId = (req as any).publicClientId as string | undefined;
  const dailyProblemId = String(req.params.id || req.body?.dailyProblemId || '');
  if (!profileId || !ownerId || !dailyProblemId || !dailyProblemOwnedBy(profileId, ownerId, dailyProblemId)) {
    fail(res, 404, 'Daily problem assignment not found');
    return;
  }
  next();
}

function requireReviewOwnership(req: Request, res: Response, next: NextFunction): void {
  const profileId = (req as any).publicProfile?.id as string | undefined;
  const ownerId = (req as any).publicClientId as string | undefined;
  const problemId = String(req.params.problemId || '');
  if (!profileId || !ownerId || !problemId) {
    fail(res, 404, 'Review item not found');
    return;
  }
  const row = db.prepare(`
    SELECT rq.id FROM review_queue rq
    JOIN profiles p ON p.id = rq.profile_id
    WHERE rq.problem_id = ? AND rq.profile_id = ? AND lower(p.owner_id) = lower(?)
  `).get(problemId, profileId, ownerId);
  if (!row) {
    fail(res, 404, 'Review item not found');
    return;
  }
  next();
}

function requireSessionOwnership(req: Request, res: Response, next: NextFunction): void {
  const profileId = (req as any).publicProfile?.id as string | undefined;
  const ownerId = (req as any).publicClientId as string | undefined;
  const sessionId = String(req.params.id || '');
  if (!profileId || !ownerId || !sessionId) {
    fail(res, 404, 'Solve session not found');
    return;
  }
  const row = db.prepare(`
    SELECT ss.id FROM solve_sessions ss
    JOIN profiles p ON p.id = ss.profile_id
    WHERE ss.id = ? AND ss.profile_id = ? AND lower(p.owner_id) = lower(?)
  `).get(sessionId, profileId, ownerId);
  if (!row) {
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

// ============================================================================
// 1. Genuine Public Endpoints (Unprotected)
// ============================================================================

publicRouter.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    const database = getDatabaseHealthSummary();
    const healthy = database.integrity !== 'failed';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      mode: 'public',
      instanceId: PUBLIC_INSTANCE_ID,
      database,
    });
  } catch {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      mode: 'public',
      instanceId: PUBLIC_INSTANCE_ID,
      database: { integrity: 'unknown' },
    });
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

publicRouter.get('/notifications/config', async (_req, res) => {
  const config = notificationsService.getPublicConfig();
  const backendVapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() || null;
  const readiness = {
    storage: {
      configured: cloudflareNotificationRepository.isConfigured(),
      ready: false,
      detail: 'Configure the notification worker URL and shared API secret.',
    },
    vapid: {
      configured: Boolean(backendVapidPublicKey),
      matchesWorker: null as boolean | null,
      detail: backendVapidPublicKey
        ? 'The worker VAPID key pair has not been verified yet.'
        : 'Set VAPID_PUBLIC_KEY in the backend configuration.',
    },
    worker: {
      configured: cloudflareNotificationRepository.isConfigured(),
      reachable: false,
      apiSecretConfigured: false,
      schedulerHealthy: null as boolean | null,
      lastStatus: null as string | null,
      lastSuccessAt: null as string | null,
      lastRun: null as {
        status?: string;
        started_at?: string;
        notifications_sent?: number;
        pushes_attempted?: number;
        error_code?: string | null;
      } | null,
      detail: cloudflareNotificationRepository.isConfigured()
        ? 'The notification worker has not been reached yet.'
        : 'Set CLOUDFLARE_NOTIFICATIONS_URL and CLOUDFLARE_NOTIFICATIONS_API_SECRET.',
    },
  };

  if (cloudflareNotificationRepository.isConfigured()) {
    try {
      const health = await cloudflareNotificationRepository.getHealth();
      const matchesWorker = Boolean(
        backendVapidPublicKey &&
        health.vapidPublicKey &&
        backendVapidPublicKey === health.vapidPublicKey
      );
      readiness.storage.ready = health.status === 'ok' && health.storageReady;
      readiness.storage.detail = readiness.storage.ready
        ? 'The notification worker can read its D1 database and required schema.'
        : 'The notification worker is reachable, but D1 or its migrations are not ready.';
      readiness.vapid.matchesWorker = matchesWorker;
      readiness.vapid.configured = Boolean(backendVapidPublicKey && health.vapidConfigured);
      readiness.vapid.detail = !backendVapidPublicKey
        ? 'Set VAPID_PUBLIC_KEY in the backend configuration.'
        : !health.vapidConfigured
          ? 'Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on the notification worker.'
          : matchesWorker
            ? 'The backend and worker VAPID public keys match.'
            : 'The backend and worker VAPID public keys do not match.';
      readiness.worker.reachable = health.status === 'ok';
      readiness.worker.apiSecretConfigured = health.apiSecretConfigured;
      readiness.worker.schedulerHealthy = health.schedulerHealthy;
      readiness.worker.lastStatus = health.state?.last_status || null;
      readiness.worker.lastSuccessAt = health.state?.last_success_at || null;
      readiness.worker.lastRun = health.latestRun || null;
      readiness.worker.detail = !health.apiSecretConfigured
        ? 'The worker API_SECRET is missing.'
        : !health.schedulerHealthy
          ? 'The worker has no successful scheduled run in the last 15 minutes.'
          : 'The worker and its scheduled runner are healthy.';
    } catch (error) {
      readiness.worker.detail = error instanceof Error
        ? error.message
        : 'Could not reach the Cloudflare notification worker.';
      readiness.storage.detail = 'Could not verify durable D1 storage until the worker responds.';
      readiness.vapid.detail = backendVapidPublicKey
        ? 'Could not verify the VAPID key pair until the worker responds.'
        : readiness.vapid.detail;
    }
  }

  const ready = config.available &&
    readiness.storage.ready &&
    readiness.vapid.configured &&
    readiness.vapid.matchesWorker === true &&
    readiness.worker.reachable &&
    readiness.worker.apiSecretConfigured &&
    readiness.worker.schedulerHealthy === true;
  res.json({
    ...config,
    available: ready,
    readiness,
  });
});

publicRouter.get('/network-info', (_req, res) => {
  fail(res, 404, 'Not found');
});

// ============================================================================
// 2. Authentication Enforcement for Protected Training Routes
// ============================================================================

publicRouter.use(async (req, res, next) => {
  return requireAuthUser(req, res, next);
});

// ============================================================================
// 3. Protected Profile Management (Strictly Scoped to Authenticated User)
// ============================================================================

publicRouter.get('/profiles', (req, res) => {
  const ownerId = getVerifiedOwnerId(req);
  if (!ownerId) return fail(res, 401, 'Authentication required');

  try {
    const requestedHandles = parseHandleList(req.query.handles);
    for (const handle of requestedHandles) {
      getOrCreatePublicProfile(ownerId, handle);
    }
    const profiles = getProfilesForOwner(ownerId);
    const headerHandle = String(req.header('x-coach-handle') || '').trim().toLowerCase();
    const active = profiles.find((profile) => profile.handle.toLowerCase() === headerHandle) || profiles[0];
    res.json({ profiles, activeProfileId: active?.id || '' });
  } catch (err) {
    console.error('[PublicAPI] Failed to list profiles:', err);
    fail(res, 500, 'Could not load user profiles');
  }
});

publicRouter.post('/profiles', rateLimit('profile-create', 8, 60_000), async (req, res) => {
  const ownerId = getVerifiedOwnerId(req);
  if (!ownerId) return fail(res, 401, 'Authentication required');

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
      ownerId,
      validation.user.handle,
      displayName || validation.user.firstName || validation.user.handle
    );
    codeforcesCacheService.cacheValidatedProfile(profile.id, validation.user);
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
  const ownerId = getVerifiedOwnerId(req);
  if (!ownerId) return fail(res, 401, 'Authentication required');

  const profile = getProfileForOwner(req.params.id, ownerId);
  if (!profile) return fail(res, 404, 'Profile not found');
  res.json({ success: true, profile });
});

publicRouter.delete('/profiles/:id', async (req, res) => {
  const ownerId = getVerifiedOwnerId(req);
  if (!ownerId) return fail(res, 401, 'Authentication required');

  if (!isProfileOwnedBy(req.params.id, ownerId)) return fail(res, 404, 'Profile not found');
  if (cloudflareNotificationRepository.isConfigured()) {
    try {
      await cloudflareNotificationRepository.deleteProfile(req.params.id, ownerId);
    } catch {
      console.warn('[Notifications] Profile removal could not be synchronized to Cloudflare.');
      return fail(res, 503, 'Could not remove notification data. Please try again.');
    }
  }
  try {
    if (!deletePublicProfile(ownerId, req.params.id)) return fail(res, 404, 'Profile not found');
    res.json({ success: true, message: 'Profile removed.' });
  } catch (err) {
    console.error('[PublicAPI] Failed to delete profile:', err);
    fail(res, 500, 'Could not remove this profile');
  }
});

// Explicit, verifiable legacy profile claim endpoint
publicRouter.post('/profiles/claim-legacy', rateLimit('profile-claim', 5, 60_000), async (req, res) => {
  const ownerId = getVerifiedOwnerId(req);
  if (!ownerId) return fail(res, 401, 'Authentication required');

  const handle = String(req.body?.handle || req.body?.profileId || '').trim();
  const legacyOwnerId = String(req.body?.legacyOwnerId || req.body?.legacyClientId || '').trim() || null;
  const dryRun = req.body?.dryRun === true;
  const secret = String(req.body?.claimSecret || req.body?.migrationSecret || '').trim();
  if (!HANDLE_PATTERN.test(handle)) return fail(res, 400, 'A valid Codeforces handle or profile id is required');

  const expectedSecret = process.env.LEGACY_MIGRATION_SECRET?.trim() || process.env.COACH_ADMIN_TOKEN?.trim();
  let authorized = false;
  let secretAuthorized = false;

  // 1. Secret authorization
  if (expectedSecret && secret && secret === expectedSecret) {
    authorized = true;
    secretAuthorized = true;
  }

  // 2. Verified Codeforces link via Supabase social handle check
  if (!authorized && isSocialDatabaseConfigured()) {
    try {
      const socialUser = (req as AuthenticatedRequest).user;
      if (socialUser) {
        const linked = await withUserTransaction(socialUser, async (client) => {
          const r = await client.query<{ codeforces_handle: string | null; handle_verified_at: Date | null }>(
            'SELECT codeforces_handle, handle_verified_at FROM public.social_profiles WHERE user_id = $1',
            [socialUser.userId]
          );
          return r.rows[0];
        });
        if (linked?.codeforces_handle?.toLowerCase() === handle.toLowerCase() && linked.handle_verified_at) {
          authorized = true;
        }
      }
    } catch {}
  }

  // 3. Test environment fixture secret
  if (!authorized && process.env.NODE_ENV === 'test' && secret === 'test-migration-secret') {
    authorized = true;
  }

  if (!authorized) {
    return fail(
      res,
      403,
      'Verification required to claim this legacy profile. Provide the migration secret or complete handle verification.'
    );
  }

  try {
    const result = claimLegacyProfile(ownerId, handle, {
      legacyOwnerId,
      dryRun,
      allowReassign: secretAuthorized,
      performedBy: `user:${ownerId}`,
      reason: secretAuthorized ? 'legacy-claim-secret' : 'legacy-claim-verified-handle',
    });
    res.json({
      success: true,
      dryRun: result.dryRun,
      alreadyOwned: result.alreadyOwned,
      migrationId: result.migrationId,
      profile: result.profile,
      previousOwnerId: result.previousOwnerId,
      migratedCounts: result.migratedCounts,
      warnings: result.warnings,
      message: result.dryRun
        ? `Dry run: legacy profile '${result.profile.handle}' can be claimed. No data was changed.`
        : `Legacy profile '${result.profile.handle}' successfully associated with your account.`,
    });
  } catch (err: any) {
    fail(res, 400, err?.message || 'Could not claim legacy profile');
  }
});

// ============================================================================
// 4. Scoped Context & Route Profile Resolver Middleware
// ============================================================================

publicRouter.use(async (req, res, next) => {
  const ownerId = getVerifiedOwnerId(req);
  if (!ownerId) return fail(res, 401, 'Authentication required');

  const handle = getHandle(req);
  const candidateProfileId = String(req.query.profileId || req.body?.profileId || '').trim();

  try {
    let profile: UserProfile | null = null;

    if (candidateProfileId) {
      profile = getProfileById(candidateProfileId);
      if (!profile || !profile.ownerId || profile.ownerId.toLowerCase() !== ownerId) {
        return fail(res, 403, 'Forbidden. You do not have permission to access this profile.');
      }
    } else if (handle) {
      profile = getOrCreatePublicProfile(ownerId, handle);
    } else {
      const userProfiles = getProfilesForOwner(ownerId);
      profile = userProfiles[0] || null;
    }

    if (!profile) {
      return fail(res, 400, 'A valid Codeforces handle or profile is required');
    }

    (req as any).publicProfile = profile;
    (req as any).publicClientId = ownerId;

    if (req.query && typeof req.query === 'object') {
      (req.query as any).profileId = profile.id;
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      req.body.profileId = profile.id;
    }

    // Zero-cost durable auto-hydration: if local SQLite is empty for this profile,
    // hydrate from permanent Supabase PostgreSQL cloud storage.
    const personalRowCount = (db.prepare('SELECT COUNT(*) as count FROM daily_sets WHERE profile_id = ?').get(profile.id) as any)?.count || 0;
    if (personalRowCount === 0 && isSocialDatabaseConfigured()) {
      try {
        const cloudContext = await loadDurableCloudContext(ownerId);
        if (cloudContext) {
          importPublicContext(profile.id, cloudContext, { mode: 'merge' });
        }
      } catch (e) {
        console.warn('[PublicAPI] Failed to hydrate cloud context:', e);
      }
    }

    const shouldSyncNotificationSnapshot =
      (req.method === 'GET' && ['/dashboard', '/daily'].includes(req.path)) ||
      (req.method !== 'GET' && [
        '/context',
        '/sync',
        '/daily/replace',
      ].includes(req.path)) ||
      (req.method === 'POST' && /^\/problems\/[^/]+\/feedback$/.test(req.path));

    const sendJson = res.json.bind(res);
    let snapshotScheduled = false;
    let cloudPersistScheduled = false;

    res.json = ((body?: any) => {
      const result = sendJson(body);
      if (res.statusCode < 400) {
        if (!snapshotScheduled && shouldSyncNotificationSnapshot && cloudflareNotificationRepository.isConfigured()) {
          snapshotScheduled = true;
          scheduleNotificationSnapshotSync(profile.id, ownerId, req.method !== 'GET');
        }
        if (!cloudPersistScheduled && req.method !== 'GET' && isSocialDatabaseConfigured()) {
          cloudPersistScheduled = true;
          try {
            const currentContext = exportPublicContext(profile.id);
            void saveDurableCloudContext(ownerId, profile.handle, currentContext);
          } catch {}
        }
      }
      return result;
    }) as typeof res.json;

    next();
  } catch (err) {
    console.error('[PublicAPI] Failed to resolve user profile:', err);
    fail(res, 500, 'Could not resolve user profile');
  }
});

// ============================================================================
// 5. Context Import/Export
// ============================================================================

publicRouter.get('/context', (req, res) => {
  try {
    const profileId = (req as any).publicProfile.id as string;
    res.json(exportPublicContext(profileId));
  } catch (err) {
    console.error('[PublicAPI] Failed to export context:', err);
    fail(res, 500, 'Could not export user context');
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
    ) ? message : 'Could not restore user context';
    console.warn('[PublicAPI] Context restore rejected:', message || err);
    fail(res, 400, safeMessage);
  }
});

// ============================================================================
// 6. Resource Ownership Guards
// ============================================================================

publicRouter.post('/problems/:id/open', requireDailyProblemOwnership);
publicRouter.post('/problems/:id/feedback', requireDailyProblemOwnership);
publicRouter.post('/daily/replace', requireDailyProblemOwnership);
publicRouter.post('/reviews/:problemId/action', requireReviewOwnership);
publicRouter.post('/sessions/:id/hint', requireSessionOwnership);
publicRouter.post('/sessions/:id/editorial', requireSessionOwnership);
publicRouter.post('/sessions/:id/finish', requireSessionOwnership);

// ============================================================================
// 7. Notification Settings & Subscriptions (Strictly Scoped)
// ============================================================================

publicRouter.get('/notifications/settings', async (req, res) => {
  try {
    const profileId = (req as any).publicProfile.id as string;
    const ownerId = (req as any).publicClientId as string;
    if (cloudflareNotificationRepository.isConfigured()) {
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
      contestReminderOffsets: req.body?.contestReminderOffsets ?? [30],
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
      err?.message === 'Reminder settings must be boolean values' ||
      err?.message === 'Contest reminder offsets are invalid'
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

// Codeforces-backed operations rate limits
publicRouter.post('/sync', rateLimit('sync', 5, 60_000));
publicRouter.post('/contests/sync', rateLimit('contest-sync', 5, 60_000));
publicRouter.post('/contests/import', rateLimit('contest-import', 10, 60_000));

// Mount underlying core API router
publicRouter.use(apiRouter);
