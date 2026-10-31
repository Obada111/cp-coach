import { db, getProfileById, getPublicProfileOwner } from './db.js';
import { getLocalDateTime, isValidPushSubscription, pushEndpointHash } from './notificationsService.js';
import type { NotificationSettings } from './notificationsService.js';

interface CloudflareConfiguration {
  url: string;
  apiSecret: string;
}

interface DailyNotificationProblem {
  contestId: number;
  problemIndex: string;
  verifiedAccepted: boolean;
}

interface NotificationSettingsInput {
  contestReminders: boolean;
  dailyReminders: boolean;
  reminderTime: string;
}

export class CloudflareNotificationRepository {
  constructor(
    private readonly getEnvironment: (name: string) => string | undefined = (name) => process.env[name],
    private readonly request: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  isConfigured(): boolean {
    return this.getConfiguration() !== null;
  }

  async getSettings(profileId: string, ownerId: string, handle: string): Promise<NotificationSettings> {
    await this.ensureProfile(profileId, ownerId, handle);
    const result = await this.requestJson<{ settings?: NotificationSettings }>(
      '/internal/v1/settings/get',
      { profileId, ownerId, handle },
    );
    if (!result.settings) throw new Error('Notification settings were not returned by the notification service');
    return result.settings;
  }

  async updateSettings(
    profileId: string,
    ownerId: string,
    handle: string,
    settings: NotificationSettingsInput,
  ): Promise<NotificationSettings> {
    await this.ensureProfile(profileId, ownerId, handle);
    const result = await this.requestJson<{ settings?: NotificationSettings }>(
      '/internal/v1/settings/update',
      { profileId, ownerId, handle, ...settings },
    );
    if (!result.settings) throw new Error('Updated notification settings were not returned by the notification service');
    return result.settings;
  }

  async registerSubscription(
    profileId: string,
    ownerId: string,
    handle: string,
    value: unknown,
  ): Promise<void> {
    if (!isValidPushSubscription(value)) throw new Error('A valid HTTPS push subscription is required');
    await this.ensureProfile(profileId, ownerId, handle);
    await this.requestJson('/internal/v1/subscriptions/register', {
      profileId,
      ownerId,
      handle,
      subscription: value,
    });
  }

  async removeSubscription(
    profileId: string,
    ownerId: string,
    handle: string,
    endpoint: unknown,
  ): Promise<boolean> {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) {
      throw new Error('A valid push endpoint is required');
    }
    await this.ensureProfile(profileId, ownerId, handle);
    const result = await this.requestJson<{ removed?: boolean }>(
      '/internal/v1/subscriptions/remove',
      { profileId, ownerId, handle, endpoint },
    );
    return result.removed === true;
  }

  async hasSubscription(
    profileId: string,
    ownerId: string,
    handle: string,
    endpoint: unknown,
  ): Promise<boolean> {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
    await this.ensureProfile(profileId, ownerId, handle);
    const result = await this.requestJson<{ registered?: boolean }>(
      '/internal/v1/subscriptions/status',
      { profileId, ownerId, handle, endpoint, endpointHash: pushEndpointHash(endpoint) },
    );
    return result.registered === true;
  }

  async deleteProfile(profileId: string, ownerId: string): Promise<void> {
    const profile = getProfileById(profileId);
    if (!profile || getPublicProfileOwner(profileId) !== ownerId) {
      throw new Error('Notification profile ownership mismatch');
    }
    await this.requestJson('/internal/v1/profiles/delete', {
      profileId,
      ownerId,
      handle: profile.handle,
    });
  }

  async syncDailySnapshot(profileId: string, ownerId: string): Promise<void> {
    const profile = db.prepare(`
      SELECT id, owner_id, handle FROM profiles WHERE id = ?
    `).get(profileId) as { id: string; owner_id: string | null; handle: string } | undefined;
    if (!profile || profile.owner_id !== ownerId || getPublicProfileOwner(profileId) !== ownerId) {
      throw new Error('Notification snapshot profile ownership mismatch');
    }

    const date = getLocalDateTime(new Date()).date;
    const set = db.prepare(`
      SELECT id FROM daily_sets WHERE profile_id = ? AND date = ?
    `).get(profileId, date) as { id: string } | undefined;
    const problems = set
      ? db.prepare(`
          SELECT p.contest_id, p.problem_index, dp.verified_cf_ac
          FROM daily_problems dp
          JOIN problems p ON p.id = dp.problem_id
          WHERE dp.daily_set_id = ?
          ORDER BY dp.id
        `).all(set.id) as Array<{
          contest_id: number;
          problem_index: string;
          verified_cf_ac: number | null;
        }>
      : [];
    const snapshot: DailyNotificationProblem[] = problems.map((problem) => ({
      contestId: Number(problem.contest_id),
      problemIndex: problem.problem_index,
      verifiedAccepted: problem.verified_cf_ac === 1,
    }));

    await this.ensureProfile(profileId, ownerId, profile.handle);
    await this.requestJson('/internal/v1/snapshots/sync', {
      profileId,
      ownerId,
      handle: profile.handle,
      snapshotDate: date,
      problems: snapshot,
      syncedAt: new Date().toISOString(),
    });
  }

  private async ensureProfile(profileId: string, ownerId: string, handle: string): Promise<void> {
    const existing = getProfileById(profileId);
    if (
      !existing ||
      getPublicProfileOwner(profileId) !== ownerId ||
      existing.handle.toLowerCase() !== handle.toLowerCase()
    ) throw new Error('Notification profile ownership mismatch');

    await this.requestJson('/internal/v1/profiles/ensure', { profileId, ownerId, handle });
  }

  private getConfiguration(): CloudflareConfiguration | null {
    const url = this.getEnvironment('CLOUDFLARE_NOTIFICATIONS_URL')?.trim().replace(/\/+$/, '');
    const apiSecret = this.getEnvironment('CLOUDFLARE_NOTIFICATIONS_API_SECRET')?.trim();
    if (!url || !apiSecret) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        return null;
      }
    } catch {
      return null;
    }
    return { url, apiSecret };
  }

  private async requestJson<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const configuration = this.getConfiguration();
    if (!configuration) throw new Error('Cloudflare notification storage is not configured');

    let response: Response;
    try {
      response = await this.request(`${configuration.url}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${configuration.apiSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('Could not reach Cloudflare notification storage');
    }

    const text = await response.text();
    let result: unknown;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error('Cloudflare notification storage returned invalid data');
      }
    }
    if (!response.ok) {
      const error = result && typeof result === 'object' && 'error' in result
        ? String(result.error)
        : `Cloudflare notification storage returned HTTP ${response.status}`;
      throw new Error(error);
    }
    return result as T;
  }
}

export const cloudflareNotificationRepository = new CloudflareNotificationRepository();
