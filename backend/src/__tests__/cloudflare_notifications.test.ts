import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, getOrCreatePublicProfile, initDatabase } from '../db.js';
import { CloudflareNotificationRepository } from '../cloudflareNotificationRepository.js';
import { getLocalDateTime } from '../notificationsService.js';

const profileIds: string[] = [];

function createProfile() {
  initDatabase();
  const suffix = randomUUID().replace(/-/g, '');
  const ownerId = `notification-client-${suffix}`;
  const profile = getOrCreatePublicProfile(ownerId, `Notify${suffix.slice(0, 18)}`);
  profileIds.push(profile.id);
  return { ownerId, profile };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  for (const profileId of profileIds) db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
  profileIds.length = 0;
});

describe('Cloudflare notification repository', () => {
  it('uses the authenticated Worker API for settings and multiple subscription operations', async () => {
    const { ownerId, profile } = createProfile();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/settings/get')) {
        return response({ settings: {
          contestReminders: true,
          dailyReminders: true,
          reminderTime: '20:00',
          timezone: 'Asia/Hebron',
        } });
      }
      if (url.endsWith('/settings/update')) {
        return response({ success: true, settings: {
          contestReminders: false,
          dailyReminders: true,
          reminderTime: '20:30',
          timezone: 'Asia/Hebron',
        } });
      }
      if (url.endsWith('/subscriptions/status')) return response({ registered: true });
      if (url.endsWith('/subscriptions/remove')) return response({ removed: true });
      return response({ success: true }, url.endsWith('/subscriptions/register') ? 201 : 200);
    });
    const repository = new CloudflareNotificationRepository(
      (key) => key === 'CLOUDFLARE_NOTIFICATIONS_URL'
        ? 'https://notifications.example/'
        : key === 'CLOUDFLARE_NOTIFICATIONS_API_SECRET'
          ? 'worker-only-secret'
          : undefined,
      fetcher,
    );
    const endpoint = `https://fcm.googleapis.com/${randomUUID()}`;
    const subscription = {
      endpoint,
      keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
    };

    expect(await repository.getSettings(profile.id, ownerId, profile.handle)).toMatchObject({
      reminderTime: '20:00',
      timezone: 'Asia/Hebron',
    });
    expect(await repository.updateSettings(profile.id, ownerId, profile.handle, {
      contestReminders: false,
      dailyReminders: true,
      reminderTime: '20:30',
    })).toMatchObject({ reminderTime: '20:30' });
    await repository.registerSubscription(profile.id, ownerId, profile.handle, subscription);
    expect(await repository.hasSubscription(profile.id, ownerId, profile.handle, endpoint)).toBe(true);
    expect(await repository.removeSubscription(profile.id, ownerId, profile.handle, endpoint)).toBe(true);

    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/internal/v1/profiles/ensure', '/internal/v1/settings/get',
      '/internal/v1/profiles/ensure', '/internal/v1/settings/update',
      '/internal/v1/profiles/ensure', '/internal/v1/subscriptions/register',
      '/internal/v1/profiles/ensure', '/internal/v1/subscriptions/status',
      '/internal/v1/profiles/ensure', '/internal/v1/subscriptions/remove',
    ]);
    expect(calls.every(({ init }) =>
      new Headers(init?.headers).get('Authorization') === 'Bearer worker-only-secret')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it('synchronizes only verified accepted completion, including an empty recommendations snapshot', async () => {
    const { ownerId, profile } = createProfile();
    const date = getLocalDateTime(new Date()).date;
    const setId = `${profile.id}_${date}`;
    const problemId = '51000_A';
    db.prepare(`
      INSERT OR IGNORE INTO problems (id, contest_id, problem_index, name, tags)
      VALUES (?, 51000, 'A', 'Snapshot problem', '[]')
    `).run(problemId);
    db.prepare('INSERT INTO daily_sets (id, profile_id, date) VALUES (?, ?, ?)').run(setId, profile.id, date);
    db.prepare(`
      INSERT INTO daily_problems
        (id, daily_set_id, profile_id, daily_set_date, problem_id, category, reason,
         target_rating, is_opened, completed, verified_cf_ac)
      VALUES (?, ?, ?, ?, ?, 'WEAKNESS_DRILL', 'Test', 1000, 1, 1, 0)
    `).run(`${setId}_A`, setId, profile.id, date, problemId);

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return response({ success: true });
    });
    const repository = new CloudflareNotificationRepository(
      (key) => key === 'CLOUDFLARE_NOTIFICATIONS_URL'
        ? 'https://notifications.example'
        : key === 'CLOUDFLARE_NOTIFICATIONS_API_SECRET' ? 'worker-secret' : undefined,
      fetcher,
    );

    await repository.syncDailySnapshot(profile.id, ownerId);
    const snapshotCall = calls.find(({ url }) => url.endsWith('/snapshots/sync'));
    expect(JSON.parse(String(snapshotCall?.init?.body))).toMatchObject({
      profileId: profile.id,
      ownerId,
      snapshotDate: date,
      problems: [{ contestId: 51000, problemIndex: 'A', verifiedAccepted: false }],
    });

    db.prepare('DELETE FROM daily_problems WHERE daily_set_id = ?').run(setId);
    await repository.syncDailySnapshot(profile.id, ownerId);
    const snapshots = calls.filter(({ url }) => url.endsWith('/snapshots/sync'));
    expect(JSON.parse(String(snapshots[1]?.init?.body)).problems).toEqual([]);
  });

  it('rejects owner mismatches before making Worker requests and requires valid configuration', async () => {
    const { ownerId, profile } = createProfile();
    const fetcher = vi.fn();
    const repository = new CloudflareNotificationRepository(
      (key) => key === 'CLOUDFLARE_NOTIFICATIONS_URL'
        ? 'https://notifications.example'
        : key === 'CLOUDFLARE_NOTIFICATIONS_API_SECRET' ? 'worker-secret' : undefined,
      fetcher,
    );
    await expect(repository.getSettings(profile.id, 'different-owner', profile.handle))
      .rejects.toThrow('Notification profile ownership mismatch');
    expect(fetcher).not.toHaveBeenCalled();

    const unconfigured = new CloudflareNotificationRepository(() => undefined, fetcher);
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(unconfigured.getSettings(profile.id, ownerId, profile.handle))
      .rejects.toThrow('Cloudflare notification storage is not configured');
  });
});
