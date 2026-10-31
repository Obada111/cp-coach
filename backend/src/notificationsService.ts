import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { db } from './db.js';
import { codeforcesService } from './codeforcesService.js';
import type { CFSubmission } from './types.js';

export const NOTIFICATION_TIMEZONE = 'Asia/Hebron';
const CONTEST_REFRESH_MS = 5 * 60 * 1000;
const WORKER_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 15 * 60 * 1000;
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
const DAILY_ACCEPTED_COUNT = 3000;

export interface NotificationSettings {
  contestReminders: boolean;
  dailyReminders: boolean;
  reminderTime: string;
  timezone: string;
}

interface LocalDateTime {
  date: string;
  time: string;
}

interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface ReminderProfile {
  profile_id: string;
  handle: string;
}

export function getLocalDateTime(date: Date, timeZone = NOTIFICATION_TIMEZONE): LocalDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time,
  };
}

export function isContestReminderDue(startTimeSeconds: number, now: Date): boolean {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const reminderTime = startTimeSeconds - 30 * 60;
  return nowSeconds >= reminderTime && nowSeconds < startTimeSeconds;
}

function isValidReminderTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidPushSubscription(value: unknown): value is PushSubscriptionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<PushSubscriptionInput>;
  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.length > 2048) return false;
  if (!candidate.keys || typeof candidate.keys !== 'object') return false;
  if (typeof candidate.keys.p256dh !== 'string' || candidate.keys.p256dh.length > 256) return false;
  if (typeof candidate.keys.auth !== 'string' || candidate.keys.auth.length > 256) return false;
  if (
    !/^[A-Za-z0-9_-]+$/.test(candidate.keys.p256dh) ||
    !/^[A-Za-z0-9_-]+$/.test(candidate.keys.auth)
  ) return false;

  try {
    const endpoint = new URL(candidate.endpoint);
    const hostname = endpoint.hostname.toLowerCase();
    const trustedPushHost = hostname === 'fcm.googleapis.com' ||
      hostname === 'web.push.apple.com' ||
      hostname === 'push.services.mozilla.com' ||
      hostname.endsWith('.push.services.mozilla.com') ||
      hostname === 'notify.windows.com' ||
      hostname.endsWith('.notify.windows.com');
    return endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password &&
      !endpoint.port && trustedPushHost &&
      Buffer.from(candidate.keys.p256dh, 'base64url').length === 65 &&
      Buffer.from(candidate.keys.auth, 'base64url').length >= 16;
  } catch {
    return false;
  }
}

export function pushEndpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

export class NotificationsService {
  private workerInterval: NodeJS.Timeout | null = null;
  private inFlightRun: Promise<void> | null = null;

  private getVapidConfiguration(): { publicKey: string; privateKey: string; subject: string } | null {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@cp-coach.app';
    if (!publicKey || !privateKey) return null;
    return { publicKey, privateKey, subject };
  }

  private configureVapid(): void {
    const configuration = this.getVapidConfiguration();
    if (!configuration) throw new Error('VAPID keys are not configured');
    webpush.setVapidDetails(configuration.subject, configuration.publicKey, configuration.privateKey);
  }

  private storageIsDurable(): boolean {
    if (process.env.PUBLIC_MODE === 'true') {
      return Boolean(
        process.env.CLOUDFLARE_NOTIFICATIONS_URL?.trim() &&
        process.env.CLOUDFLARE_NOTIFICATIONS_API_SECRET?.trim() &&
        process.env.VAPID_PUBLIC_KEY?.trim()
      );
    }
    return process.env.PUBLIC_MODE !== 'true' || process.env.NOTIFICATIONS_STORAGE_DURABLE === 'true';
  }

  isAvailable(): boolean {
    return process.env.PUBLIC_MODE === 'true'
      ? this.storageIsDurable()
      : Boolean(this.getVapidConfiguration()) && this.storageIsDurable();
  }

  getPublicConfig(): { available: boolean; vapidPublicKey: string | null; timezone: string } {
    if (process.env.PUBLIC_MODE === 'true') {
      const available = this.storageIsDurable();
      return {
        available,
        vapidPublicKey: available ? process.env.VAPID_PUBLIC_KEY!.trim() : null,
        timezone: NOTIFICATION_TIMEZONE,
      };
    }
    const configuration = this.getVapidConfiguration();
    const available = Boolean(configuration) && this.storageIsDurable();
    return {
      available,
      vapidPublicKey: available ? configuration!.publicKey : null,
      timezone: NOTIFICATION_TIMEZONE,
    };
  }

  getSettings(profileId: string): NotificationSettings {
    db.prepare(`
      INSERT OR IGNORE INTO notification_settings (profile_id)
      VALUES (?)
    `).run(profileId);
    const row = db.prepare(`
      SELECT contest_reminders, daily_reminders, reminder_time
      FROM notification_settings
      WHERE profile_id = ?
    `).get(profileId) as {
      contest_reminders: number;
      daily_reminders: number;
      reminder_time: string;
    };
    return {
      contestReminders: Boolean(row.contest_reminders),
      dailyReminders: Boolean(row.daily_reminders),
      reminderTime: row.reminder_time,
      timezone: NOTIFICATION_TIMEZONE,
    };
  }

  updateSettings(
    profileId: string,
    settings: { contestReminders: boolean; dailyReminders: boolean; reminderTime: string }
  ): NotificationSettings {
    if (typeof settings.contestReminders !== 'boolean' || typeof settings.dailyReminders !== 'boolean') {
      throw new Error('Reminder settings must be boolean values');
    }
    if (!isValidReminderTime(settings.reminderTime)) {
      throw new Error('Reminder time must use 24-hour HH:mm format');
    }
    db.prepare(`
      INSERT INTO notification_settings
        (profile_id, contest_reminders, daily_reminders, reminder_time, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(profile_id) DO UPDATE SET
        contest_reminders = excluded.contest_reminders,
        daily_reminders = excluded.daily_reminders,
        reminder_time = excluded.reminder_time,
        updated_at = datetime('now')
    `).run(profileId, settings.contestReminders ? 1 : 0, settings.dailyReminders ? 1 : 0, settings.reminderTime);
    return this.getSettings(profileId);
  }

  registerSubscription(profileId: string, ownerId: string, value: unknown): void {
    if (!isValidPushSubscription(value)) {
      throw new Error('A valid HTTPS push subscription is required');
    }
    const key = pushEndpointHash(value.endpoint);
    const existing = db.prepare(`
      SELECT profile_id, owner_id FROM push_subscriptions WHERE endpoint_hash = ?
    `).get(key) as { profile_id: string; owner_id: string } | undefined;
    if (existing && (existing.profile_id !== profileId || existing.owner_id !== ownerId)) {
      throw new Error('This device is already registered to another profile');
    }
    db.prepare(`
      INSERT INTO push_subscriptions
        (endpoint_hash, profile_id, owner_id, endpoint, p256dh, auth, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(endpoint_hash) DO UPDATE SET
        endpoint = excluded.endpoint,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        updated_at = datetime('now')
    `).run(key, profileId, ownerId, value.endpoint, value.keys.p256dh, value.keys.auth);
  }

  removeSubscription(profileId: string, ownerId: string, endpoint: unknown): boolean {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) {
      throw new Error('A valid push endpoint is required');
    }
    const result = db.prepare(`
      DELETE FROM push_subscriptions
      WHERE endpoint_hash = ? AND profile_id = ? AND owner_id = ?
    `).run(pushEndpointHash(endpoint), profileId, ownerId);
    return result.changes > 0;
  }

  hasSubscription(profileId: string, ownerId: string, endpoint: unknown): boolean {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
    return Boolean(db.prepare(`
      SELECT 1 FROM push_subscriptions
      WHERE endpoint_hash = ? AND profile_id = ? AND owner_id = ?
    `).get(pushEndpointHash(endpoint), profileId, ownerId));
  }

  startBackgroundWorker(intervalMs = WORKER_INTERVAL_MS): void {
    if (this.workerInterval) return;
    if (process.env.PUBLIC_MODE === 'true') {
      console.info('[Notifications] Public-mode reminders are delegated to Cloudflare Cron.');
      return;
    }
    if (!this.isAvailable()) {
      console.info('[Notifications] Background delivery is disabled until VAPID and durable storage are configured.');
      return;
    }
    this.configureVapid();
    void this.runScheduledJobs().catch((error: unknown) => {
      console.error('[Notifications] Initial background run failed:', error);
    });
    this.workerInterval = setInterval(() => {
      void this.runScheduledJobs().catch((error: unknown) => {
        console.error('[Notifications] Background run failed:', error);
      });
    }, intervalMs);
    this.workerInterval.unref();
  }

  stopBackgroundWorker(): void {
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
  }

  async runScheduledJobs(now = new Date()): Promise<void> {
    if (!this.isAvailable()) return;
    if (this.inFlightRun) return this.inFlightRun;
    this.configureVapid();
    const run = this.executeScheduledJobs(now);
    this.inFlightRun = run;
    try {
      await run;
    } finally {
      if (this.inFlightRun === run) this.inFlightRun = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopBackgroundWorker();
    await this.inFlightRun;
  }

  private async executeScheduledJobs(now: Date): Promise<void> {
    this.recoverAbandonedDeliveries(now);
    const settings = db.prepare(`
      SELECT p.id AS profile_id, p.handle, ns.contest_reminders, ns.daily_reminders, ns.reminder_time
      FROM profiles p
      JOIN notification_settings ns ON ns.profile_id = p.id
      WHERE (ns.contest_reminders = 1 OR ns.daily_reminders = 1)
        AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.profile_id = p.id)
    `).all().map((row) => {
      if (
        typeof row.profile_id !== 'string' ||
        typeof row.handle !== 'string' ||
        typeof row.reminder_time !== 'string'
      ) {
        throw new Error('Stored notification settings are invalid');
      }
      return {
        profile_id: row.profile_id,
        handle: row.handle,
        contest_reminders: Number(row.contest_reminders),
        daily_reminders: Number(row.daily_reminders),
        reminder_time: row.reminder_time,
      };
    });
    if (settings.length === 0) return;

    const subscriptionsByProfile = this.loadSubscriptions();
    if (settings.some((profile) => profile.contest_reminders)) {
      try {
        await this.refreshContestCache(now);
        await this.sendDueContestReminders(settings, subscriptionsByProfile, now);
      } catch (error) {
        console.warn('[Notifications] Contest list refresh failed; contest reminders were skipped:', error);
      }
    }
    await this.sendDueDailyReminders(settings, subscriptionsByProfile, now);
  }

  private recoverAbandonedDeliveries(now: Date): void {
    const staleBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
    db.prepare(`
      UPDATE notification_deliveries
      SET status = 'FAILED', retry_after = ?
      WHERE status = 'CLAIMED' AND attempted_at <= ?
    `).run(now.toISOString(), staleBefore);
  }

  private loadSubscriptions(): Map<string, Array<{
    endpoint_hash: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>> {
    const rows = db.prepare(`
      SELECT profile_id, endpoint_hash, endpoint, p256dh, auth
      FROM push_subscriptions
    `).all() as Array<{
      profile_id: string;
      endpoint_hash: string;
      endpoint: string;
      p256dh: string;
      auth: string;
    }>;
    const result = new Map<string, typeof rows>();
    for (const row of rows) {
      const subscriptions = result.get(row.profile_id) || [];
      subscriptions.push(row);
      result.set(row.profile_id, subscriptions);
    }
    return result;
  }

  private async refreshContestCache(now: Date): Promise<void> {
    const row = db.prepare(`
      SELECT value FROM sync_meta WHERE key = 'last_notification_contest_refresh'
    `).get() as { value: string } | undefined;
    const lastRefresh = row ? new Date(row.value).getTime() : 0;
    if (Number.isFinite(lastRefresh) && now.getTime() - lastRefresh < CONTEST_REFRESH_MS) return;

    const contests = await codeforcesService.getOfficialContests();
    if (!contests) throw new Error('Codeforces contest list was unavailable');
    const upsert = db.prepare(`
      INSERT INTO codeforces_contests
        (contest_id, name, start_time_seconds, duration_seconds, phase, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(contest_id) DO UPDATE SET
        name = excluded.name,
        start_time_seconds = excluded.start_time_seconds,
        duration_seconds = excluded.duration_seconds,
        phase = excluded.phase,
        updated_at = datetime('now')
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE codeforces_contests
        SET phase = 'CANCELED', updated_at = datetime('now')
        WHERE start_time_seconds > ?
      `).run(Math.floor(now.getTime() / 1000));
      for (const contest of contests) {
        upsert.run(
          contest.id,
          contest.name,
          contest.startTimeSeconds,
          contest.durationSeconds || 7200,
          contest.phase || null
        );
      }
      db.prepare(`
        INSERT INTO sync_meta (key, value, updated_at)
        VALUES ('last_notification_contest_refresh', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `).run(now.toISOString());
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  private async sendDueContestReminders(
    profiles: Array<ReminderProfile & { contest_reminders: number }>,
    subscriptionsByProfile: ReturnType<NotificationsService['loadSubscriptions']>,
    now: Date
  ): Promise<void> {
    const upcoming = db.prepare(`
      SELECT contest_id, name, start_time_seconds, phase
      FROM codeforces_contests
      WHERE start_time_seconds > ? AND (phase IS NULL OR phase = 'BEFORE')
    `).all(Math.floor(now.getTime() / 1000)) as Array<{
      contest_id: number;
      name: string;
      start_time_seconds: number;
      phase: string | null;
    }>;
    for (const contest of upcoming) {
      if (!isContestReminderDue(contest.start_time_seconds, now)) continue;
      const start = new Date(contest.start_time_seconds * 1000);
      const startTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: NOTIFICATION_TIMEZONE,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(start);
      const payload = {
        title: `Upcoming Codeforces contest`,
        body: `${contest.name} starts at ${startTime} (${NOTIFICATION_TIMEZONE}).`,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: `contest-${contest.contest_id}`,
        data: { url: `https://codeforces.com/contest/${contest.contest_id}` },
        actions: [{ action: 'open', title: 'Open contest' }],
      };
      for (const profile of profiles) {
        if (!profile.contest_reminders) continue;
        await this.deliverToProfile(
          profile.profile_id,
          subscriptionsByProfile.get(profile.profile_id) || [],
          `contest:${contest.contest_id}`,
          payload,
          now
        );
      }
    }
  }

  private async sendDueDailyReminders(
    profiles: Array<ReminderProfile & { daily_reminders: number; reminder_time: string }>,
    subscriptionsByProfile: ReturnType<NotificationsService['loadSubscriptions']>,
    now: Date
  ): Promise<void> {
    const localNow = getLocalDateTime(now);
    for (const profile of profiles) {
      if (!profile.daily_reminders || localNow.time < profile.reminder_time) continue;
      const set = db.prepare(`
        SELECT id FROM daily_sets WHERE profile_id = ? AND date = ?
      `).get(profile.profile_id, localNow.date) as { id: string } | undefined;
      if (!set) continue;
      const notificationKey = `daily:${localNow.date}`;
      const targets = this.getEligibleSubscriptions(
        profile.profile_id,
        subscriptionsByProfile.get(profile.profile_id) || [],
        notificationKey,
        now
      );
      if (targets.length === 0) continue;

      const problems = db.prepare(`
        SELECT dp.id, dp.verified_cf_ac, p.contest_id, p.problem_index
        FROM daily_problems dp
        JOIN problems p ON p.id = dp.problem_id
        WHERE dp.daily_set_id = ?
      `).all(set.id) as Array<{
        id: string;
        verified_cf_ac: number;
        contest_id: number;
        problem_index: string;
      }>;
      if (problems.length === 0) continue;

      if (problems.some((problem) => !problem.verified_cf_ac)) {
        const checkKey = `daily_push_check_${profile.profile_id}_${localNow.date}`;
        const retryRow = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(checkKey) as
          | { value: string }
          | undefined;
        if (retryRow && new Date(retryRow.value).getTime() > now.getTime()) continue;
        const verificationSucceeded = await this.refreshDailyAcceptedStatus(profile, problems, checkKey, now);
        if (!verificationSucceeded) continue;
      }

      const remaining = db.prepare(`
        SELECT COUNT(*) AS count
        FROM daily_problems
        WHERE daily_set_id = ? AND COALESCE(verified_cf_ac, 0) != 1
      `).get(set.id) as { count: number };
      if (remaining.count === 0) continue;

      const payload = {
        title: 'Your Daily CP Practice',
        body: `You still have ${remaining.count} daily problem${remaining.count === 1 ? '' : 's'} to solve. Keep your Codeforces progress going!`,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: `daily-${localNow.date}`,
        data: { url: '/#daily-recommendations' },
        actions: [{ action: 'open', title: 'Open daily practice' }],
      };
      await this.deliverToProfile(
        profile.profile_id,
        targets,
        notificationKey,
        payload,
        now
      );
    }
  }

  private getEligibleSubscriptions(
    profileId: string,
    subscriptions: Array<{ endpoint_hash: string; endpoint: string; p256dh: string; auth: string }>,
    notificationKey: string,
    now: Date
  ): Array<{ endpoint_hash: string; endpoint: string; p256dh: string; auth: string }> {
    return subscriptions.filter((subscription) => {
      const delivery = db.prepare(`
        SELECT status, retry_after FROM notification_deliveries
        WHERE profile_id = ? AND endpoint_hash = ? AND notification_key = ?
      `).get(profileId, subscription.endpoint_hash, notificationKey) as
        | { status: string; retry_after: string | null }
        | undefined;
      if (!delivery) return true;
      if (delivery.status !== 'FAILED') return false;
      return Boolean(delivery.retry_after && new Date(delivery.retry_after).getTime() <= now.getTime());
    });
  }

  private async refreshDailyAcceptedStatus(
    profile: ReminderProfile,
    problems: Array<{ id: string; contest_id: number; problem_index: string }>,
    checkKey: string,
    now: Date
  ): Promise<boolean> {
    let submissions: CFSubmission[] | null;
    try {
      submissions = await codeforcesService.getUserStatus(profile.handle, DAILY_ACCEPTED_COUNT);
    } catch (error) {
      this.deferDailyVerification(checkKey, now);
      console.warn(`[Notifications] Could not verify daily progress for profile ${profile.profile_id}:`, error);
      return false;
    }
    if (!submissions) {
      this.deferDailyVerification(checkKey, now);
      console.warn(`[Notifications] Codeforces returned no submission data for profile ${profile.profile_id}.`);
      return false;
    }
    const accepted = new Map(
      submissions
        .filter((submission) => submission.verdict === 'OK' && submission.problem.contestId)
        .map((submission) => [
          `${submission.problem.contestId}_${submission.problem.index}`,
          submission,
        ])
    );
    const markAccepted = db.prepare(`
      UPDATE daily_problems
      SET verified_cf_ac = 1, attempted = 1, completed = 1, updated_at = datetime('now')
      WHERE id = ?
    `);
    const cacheAcceptedSubmission = db.prepare(`
      INSERT OR IGNORE INTO submissions
        (id, handle, problem_id, contest_id, problem_index, verdict, creation_time,
         programming_language, raw_json)
      VALUES (?, ?, ?, ?, ?, 'OK', ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const problem of problems) {
        const submission = accepted.get(`${problem.contest_id}_${problem.problem_index}`);
        if (submission) {
          cacheAcceptedSubmission.run(
            submission.id,
            profile.handle,
            `${problem.contest_id}_${problem.problem_index}`,
            problem.contest_id,
            problem.problem_index,
            submission.creationTimeSeconds,
            submission.programmingLanguage,
            JSON.stringify(submission)
          );
          markAccepted.run(problem.id);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    db.prepare('DELETE FROM sync_meta WHERE key = ?').run(checkKey);
    return true;
  }

  private deferDailyVerification(checkKey: string, now: Date): void {
    db.prepare(`
      INSERT INTO sync_meta (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(checkKey, new Date(now.getTime() + RETRY_DELAY_MS).toISOString());
  }

  private async deliverToProfile(
    profileId: string,
    subscriptions: Array<{ endpoint_hash: string; endpoint: string; p256dh: string; auth: string }>,
    notificationKey: string,
    payload: Record<string, unknown>,
    now: Date
  ): Promise<void> {
    for (const subscription of subscriptions) {
      const settingColumn = notificationKey.startsWith('contest:')
        ? 'contest_reminders'
        : 'daily_reminders';
      const preference = db.prepare(`
        SELECT ${settingColumn} AS enabled
        FROM notification_settings WHERE profile_id = ?
      `).get(profileId) as { enabled: number } | undefined;
      if (!preference?.enabled) return;
      const activeSubscription = db.prepare(`
        SELECT 1 FROM push_subscriptions
        WHERE endpoint_hash = ? AND profile_id = ?
      `).get(subscription.endpoint_hash, profileId);
      if (!activeSubscription) continue;

      const claim = db.prepare(`
        INSERT INTO notification_deliveries
          (profile_id, endpoint_hash, notification_key, status, attempted_at)
        VALUES (?, ?, ?, 'CLAIMED', ?)
        ON CONFLICT(profile_id, endpoint_hash, notification_key) DO UPDATE SET
          status = 'CLAIMED',
          attempted_at = excluded.attempted_at,
          retry_after = NULL
        WHERE notification_deliveries.status = 'FAILED'
          AND notification_deliveries.retry_after <= ?
      `).run(profileId, subscription.endpoint_hash, notificationKey, now.toISOString(), now.toISOString());
      if (!claim.changes) continue;

      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, JSON.stringify(payload), { TTL: 3600 });
        db.prepare(`
          UPDATE notification_deliveries
          SET status = 'SENT', sent_at = ?
          WHERE profile_id = ? AND endpoint_hash = ? AND notification_key = ?
        `).run(now.toISOString(), profileId, subscription.endpoint_hash, notificationKey);
      } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 0;
        if (statusCode === 404 || statusCode === 410) {
          db.prepare(`
            DELETE FROM push_subscriptions
            WHERE endpoint_hash = ? AND profile_id = ?
          `).run(subscription.endpoint_hash, profileId);
          db.prepare(`
            UPDATE notification_deliveries SET status = 'EXPIRED'
            WHERE profile_id = ? AND endpoint_hash = ? AND notification_key = ?
          `).run(profileId, subscription.endpoint_hash, notificationKey);
          continue;
        }
        db.prepare(`
          UPDATE notification_deliveries
          SET status = 'FAILED', retry_after = ?
          WHERE profile_id = ? AND endpoint_hash = ? AND notification_key = ?
        `).run(new Date(now.getTime() + RETRY_DELAY_MS).toISOString(), profileId, subscription.endpoint_hash, notificationKey);
        console.warn(`[Notifications] Push delivery failed for profile ${profileId}; retry scheduled.`);
      }
    }
  }
}

export const notificationsService = new NotificationsService();
