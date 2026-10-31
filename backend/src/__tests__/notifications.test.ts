import { createHash, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getOrCreatePublicProfile, initDatabase } from '../db.js';
import { codeforcesService } from '../codeforcesService.js';
import {
  getLocalDateTime,
  isContestReminderDue,
  notificationsService,
} from '../notificationsService.js';
import { requestPushPermission } from '../../../frontend/src/notifications.ts';
import type { CFSubmission } from '../types.js';

const originalEnvironment = {
  publicMode: process.env.PUBLIC_MODE,
  durable: process.env.NOTIFICATIONS_STORAGE_DURABLE,
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT,
};
const vapidKeys = webpush.generateVAPIDKeys();
const profileIds: string[] = [];

function makeProfile() {
  const suffix = randomUUID().replace(/-/g, '');
  const profile = getOrCreatePublicProfile(`notification-client-${suffix}`, `Notify${suffix.slice(0, 18)}`);
  profileIds.push(profile.id);
  return profile;
}

function addSubscription(profileId: string, ownerId: string, deviceId: string): string {
  const endpoint = `https://fcm.googleapis.com/${deviceId}`;
  notificationsService.registerSubscription(profileId, ownerId, {
    endpoint,
    keys: {
      p256dh: 'A'.repeat(87),
      auth: 'B'.repeat(22),
    },
  });
  return endpoint;
}

function hashEndpoint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

function addDailySet(profileId: string, date: string, completedCount: number, total = 3): void {
  const setId = `${profileId}_${date}`;
  db.prepare(`
    INSERT INTO daily_sets (id, profile_id, date, generated_at)
    VALUES (?, ?, ?, ?)
  `).run(setId, profileId, date, new Date().toISOString());
  for (let index = 0; index < total; index += 1) {
    const contestId = 50000 + index;
    const problemId = `${contestId}_A`;
    db.prepare(`
      INSERT OR IGNORE INTO problems (id, contest_id, problem_index, name, tags)
      VALUES (?, ?, 'A', ?, '[]')
    `).run(problemId, contestId, `Notification test problem ${index}`);
    db.prepare(`
      INSERT INTO daily_problems
        (id, daily_set_id, profile_id, daily_set_date, problem_id, category, reason,
         target_rating, verified_cf_ac, completed)
      VALUES (?, ?, ?, ?, ?, 'WEAKNESS_DRILL', 'Test assignment', 1000, ?, ?)
    `).run(
      `${setId}_${index}`,
      setId,
      profileId,
      date,
      problemId,
      index < completedCount ? 1 : 0,
      index < completedCount ? 1 : 0
    );
  }
}

beforeAll(() => {
  initDatabase();
  process.env.PUBLIC_MODE = 'false';
  process.env.NOTIFICATIONS_STORAGE_DURABLE = 'true';
  process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:tests@example.com';
  webpush.setVapidDetails('mailto:tests@example.com', vapidKeys.publicKey, vapidKeys.privateKey);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(webpush, 'sendNotification').mockImplementation(async () => ({
    statusCode: 201,
    headers: {},
    body: '',
  }));
  vi.spyOn(codeforcesService, 'getOfficialContests').mockResolvedValue([]);
  vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([]);
});

afterEach(() => {
  for (const profileId of profileIds) {
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
  }
  profileIds.length = 0;
});

afterAll(() => {
  notificationsService.stopBackgroundWorker();
  if (originalEnvironment.publicMode === undefined) delete process.env.PUBLIC_MODE;
  else process.env.PUBLIC_MODE = originalEnvironment.publicMode;
  if (originalEnvironment.durable === undefined) delete process.env.NOTIFICATIONS_STORAGE_DURABLE;
  else process.env.NOTIFICATIONS_STORAGE_DURABLE = originalEnvironment.durable;
  if (originalEnvironment.publicKey === undefined) delete process.env.VAPID_PUBLIC_KEY;
  else process.env.VAPID_PUBLIC_KEY = originalEnvironment.publicKey;
  if (originalEnvironment.privateKey === undefined) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = originalEnvironment.privateKey;
  if (originalEnvironment.subject === undefined) delete process.env.VAPID_SUBJECT;
  else process.env.VAPID_SUBJECT = originalEnvironment.subject;
});

describe('push subscriptions and settings', () => {
  it('fails closed on public deployments without durable notification storage', () => {
    process.env.PUBLIC_MODE = 'true';
    process.env.NOTIFICATIONS_STORAGE_DURABLE = 'false';
    expect(notificationsService.isAvailable()).toBe(false);
    expect(notificationsService.getPublicConfig()).toMatchObject({
      available: false,
      vapidPublicKey: null,
    });
    process.env.PUBLIC_MODE = 'false';
    process.env.NOTIFICATIONS_STORAGE_DURABLE = 'true';
  });

  it('stores multiple device subscriptions and removes only the matching device', () => {
    const profile = makeProfile();
    const ownerId = 'notification-test-client';
    const first = addSubscription(profile.id, ownerId, randomUUID());
    const second = addSubscription(profile.id, ownerId, randomUUID());

    expect(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE profile_id = ?')
      .get(profile.id)).toMatchObject({ count: 2 });
    expect(notificationsService.removeSubscription(profile.id, ownerId, first)).toBe(true);
    expect(notificationsService.removeSubscription(profile.id, 'other-owner', second)).toBe(false);
    expect(db.prepare('SELECT endpoint FROM push_subscriptions WHERE profile_id = ?')
      .get(profile.id)).toMatchObject({ endpoint: second });
  });

  it('rejects malformed or non-HTTPS subscriptions and invalid reminder settings', () => {
    const profile = makeProfile();
    expect(() => notificationsService.registerSubscription(profile.id, 'owner', {
      endpoint: 'http://push.example.test/subscription',
      keys: { p256dh: 'short', auth: 'short' },
    })).toThrow('A valid HTTPS push subscription is required');
    expect(() => notificationsService.registerSubscription(profile.id, 'owner', {
      endpoint: 'https://127.0.0.1/subscription',
      keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
    })).toThrow('A valid HTTPS push subscription is required');
    expect(() => notificationsService.updateSettings(profile.id, {
      contestReminders: true,
      dailyReminders: false,
      reminderTime: '25:90',
    })).toThrow('Reminder time must use 24-hour HH:mm format');
    expect(notificationsService.getSettings(profile.id).reminderTime).toBe('20:00');
  });
});

describe('reminder scheduling', () => {
  it('uses the 30-minute contest window and excludes contests already started', () => {
    const start = 1_800_000_000;
    expect(isContestReminderDue(start, new Date((start - 30 * 60) * 1000))).toBe(true);
    expect(isContestReminderDue(start, new Date((start - 30 * 60 - 1) * 1000))).toBe(false);
    expect(isContestReminderDue(start, new Date(start * 1000))).toBe(false);
    expect(isContestReminderDue(start, new Date((start + 60) * 1000))).toBe(false);
  });

  it('deduplicates delayed contest reminders across repeated worker runs and devices', async () => {
    const profile = makeProfile();
    const ownerId = 'contest-reminder-client';
    addSubscription(profile.id, ownerId, randomUUID());
    addSubscription(profile.id, ownerId, randomUUID());
    notificationsService.updateSettings(profile.id, {
      contestReminders: true,
      dailyReminders: false,
      reminderTime: '20:00',
    });

    const now = new Date('2026-01-15T12:00:00.000Z');
    const start = Math.floor(now.getTime() / 1000) + 10 * 60;
    vi.spyOn(codeforcesService, 'getOfficialContests').mockResolvedValue([{
      id: 70001,
      name: 'Delayed reminder test round',
      startTimeSeconds: start,
      durationSeconds: 7200,
      phase: 'BEFORE',
    }]);

    await notificationsService.runScheduledJobs(now);
    await notificationsService.runScheduledJobs(new Date(now.getTime() + 60_000));

    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const deliveries = db.prepare(`
      SELECT COUNT(*) AS count FROM notification_deliveries
      WHERE profile_id = ? AND notification_key = 'contest:70001' AND status = 'SENT'
    `).get(profile.id);
    expect(deliveries).toMatchObject({ count: 2 });
  });

  it('sends a delayed daily reminder with the actual incomplete count after checking current accepted submissions', async () => {
    const profile = makeProfile();
    const ownerId = 'daily-reminder-client';
    addSubscription(profile.id, ownerId, randomUUID());
    notificationsService.updateSettings(profile.id, {
      contestReminders: false,
      dailyReminders: true,
      reminderTime: '20:00',
    });
    const now = new Date('2026-01-15T18:05:00.000Z');
    const date = getLocalDateTime(now).date;
    addDailySet(profile.id, date, 1);
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([]);

    await notificationsService.runScheduledJobs(now);
    await notificationsService.runScheduledJobs(new Date(now.getTime() + 5 * 60_000));

    expect(codeforcesService.getUserStatus).toHaveBeenCalledWith(profile.handle, 3000);
    expect(codeforcesService.getUserStatus).toHaveBeenCalledOnce();
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(vi.mocked(webpush.sendNotification).mock.calls[0]?.[1]));
    expect(payload.title).toBe('Your Daily CP Practice');
    expect(payload.body).toContain('2 daily problems');
    expect(payload.data.url).toBe('/#daily-recommendations');
  });

  it('does not count opened or self-reported problems as accepted solves', async () => {
    const profile = makeProfile();
    addSubscription(profile.id, 'self-reported-daily-client', randomUUID());
    notificationsService.updateSettings(profile.id, {
      contestReminders: false,
      dailyReminders: true,
      reminderTime: '20:00',
    });
    const now = new Date('2026-01-15T18:05:00.000Z');
    const date = getLocalDateTime(now).date;
    addDailySet(profile.id, date, 0, 1);
    db.prepare(`
      UPDATE daily_problems
      SET completed = 1, self_reported_solved = 1, is_opened = 1,
          solved_status = 'SOLVED_SELF_REPORTED'
      WHERE profile_id = ? AND daily_set_date = ?
    `).run(profile.id, date);
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([]);

    await notificationsService.runScheduledJobs(now);

    expect(webpush.sendNotification).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(vi.mocked(webpush.sendNotification).mock.calls[0]?.[1]));
    expect(payload.body).toContain('1 daily problem');
  });

  it('recovers a stale delivery claim after a worker restart', async () => {
    const profile = makeProfile();
    const ownerId = 'restarted-daily-client';
    const endpoint = addSubscription(profile.id, ownerId, randomUUID());
    notificationsService.updateSettings(profile.id, {
      contestReminders: false,
      dailyReminders: true,
      reminderTime: '20:00',
    });
    const now = new Date('2026-01-15T18:05:00.000Z');
    const date = getLocalDateTime(now).date;
    addDailySet(profile.id, date, 0, 1);
    db.prepare(`
      INSERT INTO notification_deliveries
        (profile_id, endpoint_hash, notification_key, status, attempted_at)
      VALUES (?, ?, ?, 'CLAIMED', ?)
    `).run(
      profile.id,
      hashEndpoint(endpoint),
      `daily:${date}`,
      new Date(now.getTime() - 20 * 60_000).toISOString()
    );
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([]);

    await notificationsService.runScheduledJobs(now);

    expect(webpush.sendNotification).toHaveBeenCalledOnce();
    expect(db.prepare(`
      SELECT status FROM notification_deliveries
      WHERE profile_id = ? AND endpoint_hash = ? AND notification_key = ?
    `).get(profile.id, hashEndpoint(endpoint), `daily:${date}`)).toMatchObject({ status: 'SENT' });
  });

  it('removes expired push subscriptions after the push service rejects them', async () => {
    const profile = makeProfile();
    const ownerId = 'expired-subscription-client';
    const endpoint = addSubscription(profile.id, ownerId, randomUUID());
    notificationsService.updateSettings(profile.id, {
      contestReminders: false,
      dailyReminders: true,
      reminderTime: '20:00',
    });
    const now = new Date('2026-01-15T18:05:00.000Z');
    const date = getLocalDateTime(now).date;
    addDailySet(profile.id, date, 0, 1);
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([]);
    vi.mocked(webpush.sendNotification).mockRejectedValue(
      Object.assign(new Error('Subscription expired'), { statusCode: 410 })
    );

    await notificationsService.runScheduledJobs(now);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM push_subscriptions WHERE endpoint_hash = ?
    `).get(hashEndpoint(endpoint))).toMatchObject({ count: 0 });
  });

  it('marks live accepted submissions as verified and skips the reminder when all are solved', async () => {
    const profile = makeProfile();
    addSubscription(profile.id, 'daily-completed-client', randomUUID());
    notificationsService.updateSettings(profile.id, {
      contestReminders: false,
      dailyReminders: true,
      reminderTime: '20:00',
    });
    const now = new Date('2026-01-15T18:05:00.000Z');
    const date = getLocalDateTime(now).date;
    addDailySet(profile.id, date, 0, 2);
    const submissions: CFSubmission[] = [0, 1].map((index) => ({
      id: 100 + index,
      contestId: 50000 + index,
      creationTimeSeconds: Math.floor(now.getTime() / 1000),
      problem: {
        contestId: 50000 + index,
        index: 'A',
        name: `Accepted ${index}`,
        tags: [],
      },
      programmingLanguage: 'GNU C++',
      verdict: 'OK',
    }));
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue(submissions);

    await notificationsService.runScheduledJobs(now);

    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM daily_problems
      WHERE profile_id = ? AND daily_set_date = ? AND verified_cf_ac = 1
    `).get(profile.id, date)).toMatchObject({ count: 2 });
  });

  it('does not send a daily reminder when no recommendations exist', async () => {
    const profile = makeProfile();
    addSubscription(profile.id, 'no-set-client', randomUUID());
    notificationsService.updateSettings(profile.id, {
      contestReminders: false,
      dailyReminders: true,
      reminderTime: '20:00',
    });
    const now = new Date('2026-01-15T18:05:00.000Z');

    await notificationsService.runScheduledJobs(now);

    expect(codeforcesService.getUserStatus).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('converts the configured reminder time using Asia/Hebron calendar time', () => {
    expect(getLocalDateTime(new Date('2026-01-15T18:00:00.000Z'))).toEqual({
      date: '2026-01-15',
      time: '20:00',
    });
    expect(getLocalDateTime(new Date('2026-07-15T17:00:00.000Z'))).toEqual({
      date: '2026-07-15',
      time: '20:00',
    });
  });
});

describe('permission request', () => {
  it('returns denied without treating permission as enabled', async () => {
    const requestPermission = vi.fn().mockResolvedValue('denied');
    vi.stubGlobal('Notification', { requestPermission });
    await expect(requestPushPermission()).resolves.toBe('denied');
    expect(requestPermission).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
