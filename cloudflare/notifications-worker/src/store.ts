import type {
  NotificationProfile,
  NotificationTask,
  PushSubscription,
  WorkerStats,
} from './types';
import { parseDailySnapshot } from './logic';

const CLAIM_RECOVERY_MS = 15 * 60_000;
const CONTEST_LOOKAHEAD_SECONDS = 30 * 60;
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

interface DeliveryRow {
  delivery_id: string;
}

export class NotificationStore {
  constructor(private readonly db: D1Database) {}

  async ensureProfile(profileId: string, ownerId: string, handle: string): Promise<boolean> {
    const row = await this.db.prepare(`
      INSERT INTO notification_profiles (profile_id, owner_id, cf_handle)
      VALUES (?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        cf_handle = excluded.cf_handle,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE notification_profiles.owner_id = excluded.owner_id
      RETURNING profile_id
    `).bind(profileId, ownerId, handle).first<{ profile_id: string }>();
    return Boolean(row);
  }

  async getProfile(profileId: string, ownerId: string): Promise<NotificationProfile | null> {
    return this.db.prepare(`
      SELECT * FROM notification_profiles WHERE profile_id = ? AND owner_id = ?
    `).bind(profileId, ownerId).first<NotificationProfile>();
  }

  async updateSettings(
    profileId: string,
    ownerId: string,
    settings: { contestReminders: boolean; dailyReminders: boolean; reminderTime: string },
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE notification_profiles
      SET contest_reminders = ?, daily_reminders = ?, reminder_time = ?, updated_at = ?
      WHERE profile_id = ? AND owner_id = ?
    `).bind(
      Number(settings.contestReminders),
      Number(settings.dailyReminders),
      settings.reminderTime,
      new Date().toISOString(),
      profileId,
      ownerId,
    ).run();
    return result.meta.changes === 1;
  }

  async getSubscription(
    profileId: string,
    ownerId: string,
    endpointHash: string,
  ): Promise<PushSubscription | null> {
    return this.db.prepare(`
      SELECT * FROM notification_subscriptions
      WHERE profile_id = ? AND owner_id = ? AND endpoint_hash = ? AND active = 1
    `).bind(profileId, ownerId, endpointHash).first<PushSubscription>();
  }

  async saveSubscription(subscription: PushSubscription): Promise<boolean> {
    const row = await this.db.prepare(`
      INSERT INTO notification_subscriptions
        (endpoint_hash, profile_id, owner_id, endpoint, p256dh, auth, active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(endpoint_hash) DO UPDATE SET
        endpoint = excluded.endpoint,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        active = 1,
        updated_at = excluded.updated_at
      WHERE notification_subscriptions.profile_id = excluded.profile_id
        AND notification_subscriptions.owner_id = excluded.owner_id
      RETURNING endpoint_hash
    `).bind(
      subscription.endpoint_hash,
      subscription.profile_id,
      subscription.owner_id,
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
      new Date().toISOString(),
    ).first<{ endpoint_hash: string }>();
    return Boolean(row);
  }

  async removeSubscription(profileId: string, ownerId: string, endpointHash: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM notification_subscriptions
      WHERE profile_id = ? AND owner_id = ? AND endpoint_hash = ?
    `).bind(profileId, ownerId, endpointHash).run();
    return result.meta.changes > 0;
  }

  async updateSnapshot(
    profileId: string,
    ownerId: string,
    snapshotDate: string,
    problems: unknown,
    syncedAt: string,
  ): Promise<boolean> {
    const parsed = parseDailySnapshot(problems);
    if (!parsed) return false;
    const result = await this.db.prepare(`
      UPDATE notification_profiles
      SET snapshot_date = ?, daily_snapshot = ?, snapshot_synced_at = ?,
          submissions_checked_at = NULL, verification_retry_after = NULL, updated_at = ?
      WHERE profile_id = ? AND owner_id = ?
    `).bind(
      snapshotDate,
      JSON.stringify(parsed),
      syncedAt,
      new Date().toISOString(),
      profileId,
      ownerId,
    ).run();
    return result.meta.changes === 1;
  }

  async deleteProfile(profileId: string, ownerId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM notification_profiles WHERE profile_id = ? AND owner_id = ?
    `).bind(profileId, ownerId).run();
    return result.meta.changes === 1;
  }

  async hasContestSubscribers(): Promise<boolean> {
    return Boolean(await this.db.prepare(`
      SELECT 1
      FROM notification_profiles p
      JOIN notification_subscriptions s
        ON s.profile_id = p.profile_id AND s.owner_id = p.owner_id AND s.active = 1
      WHERE p.contest_reminders = 1
      LIMIT 1
    `).first());
  }

  async getLastContestRefreshAt(): Promise<string | null> {
    const row = await this.db.prepare(`
      SELECT last_contest_refresh_at FROM notification_worker_state WHERE singleton = 1
    `).first<{ last_contest_refresh_at: string | null }>();
    return row?.last_contest_refresh_at || null;
  }

  async refreshContests(
    contests: Array<{
      contest_id: number;
      name: string;
      start_time_seconds: number;
      duration_seconds: number | null;
      phase: string;
      updated_at: string;
    }>,
    now: Date,
  ): Promise<void> {
    const statements = [
      this.db.prepare(`
        UPDATE notification_contests SET phase = 'CANCELED', updated_at = ?
        WHERE start_time_seconds > ? AND phase = 'BEFORE'
      `).bind(now.toISOString(), Math.floor(now.getTime() / 1000)),
      ...contests.map((contest) => this.db.prepare(`
        INSERT INTO notification_contests
          (contest_id, platform, name, start_time_seconds, duration_seconds, phase, updated_at)
        VALUES (?, 'Codeforces', ?, ?, ?, ?, ?)
        ON CONFLICT(contest_id) DO UPDATE SET
          name = excluded.name,
          start_time_seconds = excluded.start_time_seconds,
          duration_seconds = excluded.duration_seconds,
          phase = excluded.phase,
          updated_at = excluded.updated_at
      `).bind(
        contest.contest_id,
        contest.name,
        contest.start_time_seconds,
        contest.duration_seconds,
        contest.phase,
        contest.updated_at,
      )),
      this.db.prepare(`
        UPDATE notification_worker_state SET last_contest_refresh_at = ? WHERE singleton = 1
      `).bind(now.toISOString()),
    ];
    await this.db.batch(statements);
  }

  async findContestTask(now: Date): Promise<NotificationTask | null> {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const retryAt = new Date(now.getTime()).toISOString();
    const staleClaimAt = new Date(now.getTime() - CLAIM_RECOVERY_MS).toISOString();
    const row = await this.db.prepare(`
      SELECT
        p.profile_id, p.owner_id, p.cf_handle, p.contest_reminders, p.daily_reminders,
        p.reminder_time, p.timezone, p.snapshot_date, p.daily_snapshot,
        p.snapshot_synced_at, p.submissions_checked_at, p.verification_retry_after,
        s.endpoint_hash, s.profile_id AS subscription_profile_id, s.owner_id AS subscription_owner_id,
        s.endpoint, s.p256dh, s.auth,
        c.contest_id, c.name AS contest_name, c.start_time_seconds
      FROM notification_contests c
      JOIN notification_profiles p ON p.contest_reminders = 1
      JOIN notification_subscriptions s
        ON s.profile_id = p.profile_id AND s.owner_id = p.owner_id AND s.active = 1
      LEFT JOIN notification_deliveries d
        ON d.profile_id = p.profile_id
        AND d.endpoint_hash = s.endpoint_hash
        AND d.notification_key = 'contest:' || c.contest_id
      WHERE c.phase = 'BEFORE'
        AND c.start_time_seconds > ?
        AND c.start_time_seconds <= ?
        AND (
          d.delivery_id IS NULL
          OR (d.status = 'FAILED' AND d.retry_after <= ?)
          OR (d.status = 'CLAIMED' AND d.claimed_at <= ?)
        )
      ORDER BY c.start_time_seconds, p.profile_id, s.endpoint_hash
      LIMIT 1
    `).bind(
      nowSeconds,
      nowSeconds + CONTEST_LOOKAHEAD_SECONDS,
      retryAt,
      staleClaimAt,
    ).first<Record<string, unknown>>();
    if (!row) return null;
    const profile = this.profileFromJoinedRow(row);
    const subscription = this.subscriptionFromJoinedRow(row);
    return {
      profile,
      subscription,
      notificationKey: `contest:${Number(row.contest_id)}`,
      kind: 'contest',
      contestId: Number(row.contest_id),
      contestName: String(row.contest_name),
      startTimeSeconds: Number(row.start_time_seconds),
    };
  }

  async findDailyTask(now: Date, localDate: string, localTime: string): Promise<NotificationTask | null> {
    const currentTime = now.toISOString();
    const snapshotAfter = new Date(now.getTime() - SNAPSHOT_MAX_AGE_MS).toISOString();
    const retryAt = currentTime;
    const staleClaimAt = new Date(now.getTime() - CLAIM_RECOVERY_MS).toISOString();
    const row = await this.db.prepare(`
      SELECT
        p.profile_id, p.owner_id, p.cf_handle, p.contest_reminders, p.daily_reminders,
        p.reminder_time, p.timezone, p.snapshot_date, p.daily_snapshot,
        p.snapshot_synced_at, p.submissions_checked_at, p.verification_retry_after,
        s.endpoint_hash, s.profile_id AS subscription_profile_id, s.owner_id AS subscription_owner_id,
        s.endpoint, s.p256dh, s.auth
      FROM notification_profiles p
      JOIN notification_subscriptions s
        ON s.profile_id = p.profile_id AND s.owner_id = p.owner_id AND s.active = 1
      LEFT JOIN notification_deliveries d
        ON d.profile_id = p.profile_id
        AND d.endpoint_hash = s.endpoint_hash
        AND d.notification_key = 'daily:' || ?
      WHERE p.daily_reminders = 1
        AND p.timezone = 'Asia/Hebron'
        AND p.reminder_time <= ?
        AND p.snapshot_date = ?
        AND p.snapshot_synced_at >= ?
        AND (p.verification_retry_after IS NULL OR p.verification_retry_after <= ?)
        AND EXISTS (
          SELECT 1 FROM json_each(p.daily_snapshot) problem
          WHERE json_extract(problem.value, '$.verifiedAccepted') != 1
        )
        AND (
          d.delivery_id IS NULL
          OR (d.status = 'FAILED' AND d.retry_after <= ?)
          OR (d.status = 'CLAIMED' AND d.claimed_at <= ?)
        )
      ORDER BY p.profile_id, s.endpoint_hash
      LIMIT 1
    `).bind(
      localDate,
      localTime,
      localDate,
      snapshotAfter,
      retryAt,
      retryAt,
      staleClaimAt,
    ).first<Record<string, unknown>>();
    if (!row) return null;
    const profile = this.profileFromJoinedRow(row);
    const subscription = this.subscriptionFromJoinedRow(row);
    let snapshot: ReturnType<typeof parseDailySnapshot>;
    try {
      snapshot = parseDailySnapshot(JSON.parse(profile.daily_snapshot));
    } catch {
      return null;
    }
    if (!snapshot) return null;
    return {
      profile,
      subscription,
      notificationKey: `daily:${localDate}`,
      kind: 'daily',
      snapshot,
    };
  }

  async claimDelivery(
    task: NotificationTask,
    now: Date,
  ): Promise<string | null> {
    const deliveryId = crypto.randomUUID();
    const currentTime = now.toISOString();
    const staleClaimAt = new Date(now.getTime() - CLAIM_RECOVERY_MS).toISOString();
    const row = await this.db.prepare(`
      INSERT INTO notification_deliveries
        (delivery_id, profile_id, endpoint_hash, notification_key, status, claimed_at, created_at)
      VALUES (?, ?, ?, ?, 'CLAIMED', ?, ?)
      ON CONFLICT(profile_id, endpoint_hash, notification_key) DO UPDATE SET
        delivery_id = excluded.delivery_id,
        status = 'CLAIMED',
        claimed_at = excluded.claimed_at,
        retry_after = NULL,
        error_code = NULL
      WHERE (
        notification_deliveries.status = 'FAILED'
        AND notification_deliveries.retry_after <= ?
      ) OR (
        notification_deliveries.status = 'CLAIMED'
        AND notification_deliveries.claimed_at <= ?
      )
      RETURNING delivery_id
    `).bind(
      deliveryId,
      task.profile.profile_id,
      task.subscription.endpoint_hash,
      task.notificationKey,
      currentTime,
      currentTime,
      currentTime,
      staleClaimAt,
    ).first<DeliveryRow>();
    return row?.delivery_id || null;
  }

  async updateDelivery(deliveryId: string, fields: {
    status: 'SENT' | 'FAILED' | 'EXPIRED';
    sentAt?: string;
    retryAfter?: string;
    errorCode?: string | null;
  }): Promise<void> {
    await this.db.prepare(`
      UPDATE notification_deliveries
      SET status = ?, sent_at = ?, retry_after = ?, error_code = ?
      WHERE delivery_id = ?
    `).bind(
      fields.status,
      fields.sentAt ?? null,
      fields.retryAfter ?? null,
      fields.errorCode ?? null,
      deliveryId,
    ).run();
  }

  async deleteSubscriptionByHash(endpointHash: string): Promise<void> {
    await this.db.prepare(`
      DELETE FROM notification_subscriptions WHERE endpoint_hash = ?
    `).bind(endpointHash).run();
  }

  async updateVerifiedSnapshot(
    profileId: string,
    problems: unknown,
    checkedAt: Date,
    retryAfter: Date | null,
  ): Promise<void> {
    const parsed = parseDailySnapshot(problems);
    if (!parsed) return;
    await this.db.prepare(`
      UPDATE notification_profiles
      SET daily_snapshot = ?,
          submissions_checked_at = ?,
          verification_retry_after = ?,
          updated_at = ?
      WHERE profile_id = ?
    `).bind(
      JSON.stringify(parsed),
      checkedAt.toISOString(),
      retryAfter?.toISOString() ?? null,
      checkedAt.toISOString(),
      profileId,
    ).run();
  }

  async updateWorkerState(fields: {
    lockOwner?: string | null;
    lockExpiresAt?: string | null;
    lastStartedAt?: string | null;
    lastCompletedAt?: string | null;
    lastSuccessAt?: string | null;
    lastStatus?: string | null;
  }): Promise<void> {
    const current = await this.db.prepare(`
      SELECT * FROM notification_worker_state WHERE singleton = 1
    `).first<Record<string, unknown>>();
    await this.db.prepare(`
      UPDATE notification_worker_state
      SET lock_owner = ?, lock_expires_at = ?, last_started_at = ?,
          last_completed_at = ?, last_success_at = ?, last_status = ?
      WHERE singleton = 1
    `).bind(
      fields.lockOwner === undefined ? current?.lock_owner ?? null : fields.lockOwner,
      fields.lockExpiresAt === undefined ? current?.lock_expires_at ?? null : fields.lockExpiresAt,
      fields.lastStartedAt === undefined ? current?.last_started_at ?? null : fields.lastStartedAt,
      fields.lastCompletedAt === undefined ? current?.last_completed_at ?? null : fields.lastCompletedAt,
      fields.lastSuccessAt === undefined ? current?.last_success_at ?? null : fields.lastSuccessAt,
      fields.lastStatus === undefined ? current?.last_status ?? null : fields.lastStatus,
    ).run();
  }

  async acquireWorker(runId: string, now: Date): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE notification_worker_state
      SET lock_owner = ?, lock_expires_at = ?, last_started_at = ?, last_status = 'RUNNING'
      WHERE singleton = 1
        AND (lock_expires_at IS NULL OR lock_expires_at <= ?)
    `).bind(
      runId,
      new Date(now.getTime() + 240_000).toISOString(),
      now.toISOString(),
      now.toISOString(),
    ).run();
    return result.meta.changes === 1;
  }

  async releaseWorker(runId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE notification_worker_state
      SET lock_owner = NULL, lock_expires_at = NULL
      WHERE singleton = 1 AND lock_owner = ?
    `).bind(runId).run();
  }

  async recordRun(runId: string, stats: Partial<WorkerStats> & {
    startedAt: string;
    completedAt?: string;
    status: string;
    errorCode?: string | null;
  }): Promise<void> {
    await this.db.prepare(`
      INSERT INTO notification_worker_runs
        (run_id, started_at, completed_at, status, profiles_checked, pushes_attempted,
         notifications_sent, duration_ms, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        completed_at = excluded.completed_at,
        status = excluded.status,
        profiles_checked = excluded.profiles_checked,
        pushes_attempted = excluded.pushes_attempted,
        notifications_sent = excluded.notifications_sent,
        duration_ms = excluded.duration_ms,
        error_code = excluded.error_code
    `).bind(
      runId,
      stats.startedAt,
      stats.completedAt ?? null,
      stats.status,
      stats.profilesChecked ?? 0,
      stats.pushesAttempted ?? 0,
      stats.notificationsSent ?? 0,
      stats.durationMs ?? null,
      stats.errorCode ?? null,
    ).run();
  }

  async getHealth(now = new Date()): Promise<Record<string, unknown>> {
    const state = await this.db.prepare(`
      SELECT last_started_at, last_completed_at, last_success_at, last_status
      FROM notification_worker_state WHERE singleton = 1
    `).first<Record<string, unknown>>();
    const latestRun = await this.db.prepare(`
      SELECT run_id, started_at, completed_at, status, duration_ms, error_code
      FROM notification_worker_runs ORDER BY started_at DESC LIMIT 1
    `).first<Record<string, unknown>>();
    const lastSuccessAt = typeof state?.last_success_at === 'string'
      ? Date.parse(state.last_success_at)
      : Number.NaN;
    return {
      state,
      latestRun,
      schedulerHealthy: state?.last_status === 'SUCCEEDED' &&
        Number.isFinite(lastSuccessAt) &&
        now.getTime() - lastSuccessAt <= 15 * 60_000,
    };
  }

  async cleanup(now: Date): Promise<void> {
    await this.db.batch([
      this.db.prepare(`
        DELETE FROM notification_worker_runs
        WHERE started_at < ?
      `).bind(new Date(now.getTime() - 45 * 24 * 60 * 60_000).toISOString()),
      this.db.prepare(`
        DELETE FROM notification_deliveries
        WHERE created_at < ?
      `).bind(new Date(now.getTime() - 180 * 24 * 60 * 60_000).toISOString()),
      this.db.prepare(`
        DELETE FROM notification_contests
        WHERE start_time_seconds < ?
      `).bind(Math.floor(now.getTime() / 1000) - 90 * 24 * 60 * 60),
    ]);
  }

  private profileFromJoinedRow(row: Record<string, unknown>): NotificationProfile {
    return {
      profile_id: String(row.profile_id),
      owner_id: String(row.owner_id),
      cf_handle: String(row.cf_handle),
      contest_reminders: Number(row.contest_reminders),
      daily_reminders: Number(row.daily_reminders),
      reminder_time: String(row.reminder_time),
      timezone: String(row.timezone),
      snapshot_date: typeof row.snapshot_date === 'string' ? row.snapshot_date : null,
      daily_snapshot: String(row.daily_snapshot),
      snapshot_synced_at: typeof row.snapshot_synced_at === 'string' ? row.snapshot_synced_at : null,
      submissions_checked_at: typeof row.submissions_checked_at === 'string' ? row.submissions_checked_at : null,
      verification_retry_after: typeof row.verification_retry_after === 'string' ? row.verification_retry_after : null,
    };
  }

  private subscriptionFromJoinedRow(row: Record<string, unknown>): PushSubscription {
    return {
      endpoint_hash: String(row.endpoint_hash),
      profile_id: String(row.subscription_profile_id ?? row.profile_id),
      owner_id: String(row.subscription_owner_id ?? row.owner_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
    };
  }
}
