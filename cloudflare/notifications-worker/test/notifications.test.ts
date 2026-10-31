import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../src/api';
import { getLocalDateTime } from '../src/logic';
import { encryptWebPushPayload, sendWebPush } from '../src/push';
import { runScheduledWorker } from '../src/scheduler';
import { NotificationStore } from '../src/store';
import worker from '../src/index';
import type { Env } from '../src/types';

const now = new Date('2026-10-30T18:00:00.000Z');
const ownerId = 'android-browser-client-012345';
const testDb = (env as unknown as { DB: D1Database }).DB;

function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: testDb,
    API_SECRET: 'test-backend-secret',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: 'mailto:tests@example.com',
    ...overrides,
  };
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

function bufferSource(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function hmac(keyBytes: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bufferSource(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bufferSource(value)));
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array();
  for (let counter = 1; blocks.reduce((sum, block) => sum + block.length, 0) < length; counter += 1) {
    previous = await hmac(prk, concat(previous, info, new Uint8Array([counter])));
    blocks.push(previous);
  }
  return concat(...blocks).slice(0, length);
}

async function generateVapid(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: base64UrlEncode(publicKey), privateKey: jwk.d || '' };
}

async function generateSubscription(): Promise<{
  endpoint: string;
  p256dh: string;
  auth: string;
  privateKey: CryptoKey;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    p256dh: base64UrlEncode(publicKey),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    privateKey: pair.privateKey,
  };
}

async function seedProfile(options: {
  contestReminders?: boolean;
  dailyReminders?: boolean;
  reminderTime?: string;
  snapshotDate?: string | null;
  snapshotSyncedAt?: string | null;
  snapshot?: unknown[];
  subscriptions?: number;
} = {}) {
  const store = new NotificationStore(testDb);
  const profileId = `pub_${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;
  const id = { profileId, ownerId, handle: 'CodeforcesUser' };
  expect(await store.ensureProfile(id.profileId, id.ownerId, id.handle)).toBe(true);
  await store.updateSettings(id.profileId, id.ownerId, {
    contestReminders: options.contestReminders ?? false,
    dailyReminders: options.dailyReminders ?? true,
    reminderTime: options.reminderTime ?? '20:00',
  });
  if (options.snapshotDate !== null) {
    await store.updateSnapshot(
      id.profileId,
      id.ownerId,
      options.snapshotDate ?? getLocalDateTime(now).date,
      options.snapshot ?? [
        { contestId: 51000, problemIndex: 'A', verifiedAccepted: false },
        { contestId: 51001, problemIndex: 'B', verifiedAccepted: false },
      ],
      options.snapshotSyncedAt ?? now.toISOString(),
    );
  }
  const subscriptions = [];
  for (let index = 0; index < (options.subscriptions ?? 1); index += 1) {
    const subscription = await generateSubscription();
    const digest = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(subscription.endpoint),
    ));
    const endpointHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    await store.saveSubscription({
      endpoint_hash: endpointHash,
      profile_id: id.profileId,
      owner_id: ownerId,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    });
    subscriptions.push({ ...subscription, endpointHash });
  }
  return { id, store, subscriptions };
}

async function postInternal(path: string, body: unknown, apiSecret = 'test-backend-secret'): Promise<Response> {
  return handleApiRequest(new Request(`https://notifications.example${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), workerEnv());
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await testDb.batch([
    testDb.prepare('DELETE FROM notification_worker_runs'),
    testDb.prepare('DELETE FROM notification_deliveries'),
    testDb.prepare('DELETE FROM notification_subscriptions'),
    testDb.prepare('DELETE FROM notification_profiles'),
    testDb.prepare('DELETE FROM notification_contests'),
    testDb.prepare(`
      UPDATE notification_worker_state SET last_contest_refresh_at = NULL,
        lock_owner = NULL, lock_expires_at = NULL, last_started_at = NULL,
        last_completed_at = NULL, last_success_at = NULL, last_status = NULL
      WHERE singleton = 1
    `),
  ]);
});

describe('Cloudflare D1 notification API', () => {
  it('requires backend authentication and rejects malformed profile ownership', async () => {
    const response = await postInternal('/internal/v1/profiles/ensure', {
      profileId: 'pub_invalid',
      ownerId,
      handle: 'CodeforcesUser',
    }, 'wrong-secret');
    expect(response.status).toBe(401);
    const invalid = await postInternal('/internal/v1/profiles/ensure', {
      profileId: 'pub_invalid',
      ownerId,
      handle: 'CodeforcesUser',
    });
    expect(invalid.status).toBe(400);
  });

  it('registers multiple device subscriptions and only deletes by profile owner', async () => {
    const { id, subscriptions } = await seedProfile({ dailyReminders: false, subscriptions: 2 });
    const subscription = subscriptions[0];
    const registered = await postInternal('/internal/v1/subscriptions/status', {
      ...id,
      endpoint: subscription.endpoint,
      endpointHash: subscription.endpointHash,
    });
    expect(await registered.json()).toMatchObject({ registered: true });

    const removed = await postInternal('/internal/v1/subscriptions/remove', {
      ...id,
      endpoint: subscription.endpoint,
    });
    expect(await removed.json()).toMatchObject({ removed: true });
    const remaining = await testDb.prepare(`
      SELECT COUNT(*) AS count FROM notification_subscriptions WHERE profile_id = ?
    `).bind(id.profileId).first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  it('keeps preferences and validated daily recommendation snapshots in D1', async () => {
    const { id } = await seedProfile({ dailyReminders: false });
    const updated = await postInternal('/internal/v1/settings/update', {
      ...id,
      contestReminders: true,
      dailyReminders: true,
      reminderTime: '20:00',
    });
    expect(updated.status).toBe(200);
    const rejected = await postInternal('/internal/v1/settings/update', {
      ...id,
      contestReminders: true,
      dailyReminders: true,
      reminderTime: '24:00',
    });
    expect(rejected.status).toBe(400);

    const badSnapshot = await postInternal('/internal/v1/snapshots/sync', {
      ...id,
      snapshotDate: getLocalDateTime(now).date,
      syncedAt: now.toISOString(),
      problems: [{ contestId: 51000, problemIndex: 'A', isOpened: true }],
    });
    expect(badSnapshot.status).toBe(400);
  });

  it('enforces schema constraints on invalid times and endpoint ownership', async () => {
    const { id, subscriptions } = await seedProfile({ dailyReminders: false });
    await expect(testDb.prepare(`
      UPDATE notification_profiles SET reminder_time = '25:00' WHERE profile_id = ?
    `).bind(id.profileId).run()).rejects.toThrow();
    const otherProfile = await seedProfile({ dailyReminders: false });
    const response = await postInternal('/internal/v1/subscriptions/register', {
      ...otherProfile.id,
      subscription: {
        endpoint: subscriptions[0].endpoint,
        keys: { p256dh: subscriptions[0].p256dh, auth: subscriptions[0].auth },
      },
    });
    expect(response.status).toBe(409);
  });
});

describe('Cloudflare scheduled reminders', () => {
  it('verifies Accepted submissions and delivers the actual unfinished count in the Worker runtime', async () => {
    const { subscriptions } = await seedProfile();
    const vapid = await generateVapid();
    const externalFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user.status')) {
        return Response.json({
          status: 'OK',
          result: [
            { verdict: 'OK', problem: { contestId: 51000, index: 'A' } },
            { verdict: 'WRONG_ANSWER', problem: { contestId: 51001, index: 'B' } },
          ],
        });
      }
      if (url.startsWith('https://fcm.googleapis.com/')) {
        expect(new Headers(init?.headers).get('Content-Encoding')).toBe('aes128gcm');
        expect(new Headers(init?.headers).get('Authorization')).toContain('vapid t=');
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    vi.stubGlobal('fetch', externalFetch);
    const stats = await runScheduledWorker(workerEnv({
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    }), now);
    expect(stats).toMatchObject({ status: 'SUCCEEDED', pushesAttempted: 1, notificationsSent: 1 });
    const pushRequest = externalFetch.mock.calls.find(([input]) => String(input).startsWith('https://fcm.googleapis.com/'));
    expect(pushRequest).toBeTruthy();
    const deliveries = await testDb.prepare(`
      SELECT status FROM notification_deliveries WHERE endpoint_hash = ?
    `).bind(subscriptions[0].endpointHash).all<{ status: string }>();
    expect(deliveries.results).toEqual([{ status: 'SENT' }]);
    const profile = await testDb.prepare(`
      SELECT daily_snapshot FROM notification_profiles WHERE profile_id = ?
    `).bind((await testDb.prepare('SELECT profile_id FROM notification_profiles LIMIT 1')
      .first<{ profile_id: string }>())!.profile_id).first<{ daily_snapshot: string }>();
    expect(JSON.parse(profile!.daily_snapshot)).toEqual([
      { contestId: 51000, problemIndex: 'A', verifiedAccepted: true },
      { contestId: 51001, problemIndex: 'B', verifiedAccepted: false },
    ]);
  });

  it('sends a 30-minute contest reminder once per device and reconciles stale contests', async () => {
    const { subscriptions } = await seedProfile({ contestReminders: true, dailyReminders: false });
    const vapid = await generateVapid();
    const startSeconds = Math.floor(now.getTime() / 1000) + 30 * 60;
    const externalFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/contest.list')) {
        return Response.json({
          status: 'OK',
          result: [{
            id: 70001,
            name: 'Test contest',
            startTimeSeconds: startSeconds,
            durationSeconds: 7200,
            phase: 'BEFORE',
          }],
        });
      }
      if (url.startsWith('https://fcm.googleapis.com/')) return new Response(null, { status: 201 });
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    vi.stubGlobal('fetch', externalFetch);
    const configuration = workerEnv({
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    });
    const first = await runScheduledWorker(configuration, now);
    const second = await runScheduledWorker(configuration, now);
    expect(first.notificationsSent).toBe(1);
    expect(second.notificationsSent).toBe(0);
    expect(externalFetch.mock.calls.filter(([input]) => String(input).includes('/api/contest.list'))).toHaveLength(1);
    expect(externalFetch.mock.calls.filter(([input]) => String(input).startsWith('https://fcm.googleapis.com/'))).toHaveLength(1);
    const stored = await testDb.prepare(`
      SELECT phase FROM notification_contests WHERE contest_id = 70001
    `).first<{ phase: string }>();
    expect(stored?.phase).toBe('BEFORE');
    expect(subscriptions).toHaveLength(1);
  });

  it('recovers abandoned delivery claims after a Worker restart', async () => {
    const { id, subscriptions } = await seedProfile({ contestReminders: true, dailyReminders: false });
    const vapid = await generateVapid();
    const startTimeSeconds = Math.floor(now.getTime() / 1000) + 20 * 60;
    const endpointHash = subscriptions[0].endpointHash;
    await testDb.prepare(`
      INSERT INTO notification_contests
        (contest_id, platform, name, start_time_seconds, duration_seconds, phase, updated_at)
      VALUES (70002, 'Codeforces', 'Recovered contest', ?, 7200, 'BEFORE', ?)
    `).bind(startTimeSeconds, now.toISOString()).run();
    await testDb.prepare(`
      INSERT INTO notification_deliveries
        (delivery_id, profile_id, endpoint_hash, notification_key, status, claimed_at, created_at)
      VALUES ('abandoned-claim', ?, ?, 'contest:70002', 'CLAIMED', ?, ?)
    `).bind(
      id.profileId,
      endpointHash,
      new Date(now.getTime() - 16 * 60_000).toISOString(),
      new Date(now.getTime() - 16 * 60_000).toISOString(),
    ).run();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/contest.list')) {
        return Response.json({
          status: 'OK',
          result: [{
            id: 70002,
            name: 'Recovered contest',
            startTimeSeconds,
            durationSeconds: 7200,
            phase: 'BEFORE',
          }],
        });
      }
      if (String(input).startsWith('https://fcm.googleapis.com/')) return new Response(null, { status: 201 });
      throw new Error(`Unexpected outbound request: ${String(input)}`);
    }));

    const stats = await runScheduledWorker(workerEnv({
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    }), now);
    const delivery = await testDb.prepare(`
      SELECT status FROM notification_deliveries WHERE profile_id = ? AND notification_key = 'contest:70002'
    `).bind(id.profileId).first<{ status: string }>();
    expect(stats.notificationsSent).toBe(1);
    expect(delivery?.status).toBe('SENT');
  });

  it('marks failed pushes for retry and removes expired device subscriptions', async () => {
    const { id, subscriptions } = await seedProfile();
    const vapid = await generateVapid();
    let pushCount = 0;
    const externalFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/user.status')) {
        return Response.json({ status: 'OK', result: [] });
      }
      if (String(input).startsWith('https://fcm.googleapis.com/')) {
        pushCount += 1;
        return new Response(null, { status: pushCount === 1 ? 503 : 410 });
      }
      throw new Error(`Unexpected outbound request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', externalFetch);
    const configuration = workerEnv({
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    });

    await runScheduledWorker(configuration, now);
    const failed = await testDb.prepare(`
      SELECT status, retry_after FROM notification_deliveries WHERE endpoint_hash = ?
    `).bind(subscriptions[0].endpointHash).first<{ status: string; retry_after: string }>();
    expect(failed?.status).toBe('FAILED');
    expect(failed?.retry_after).toBe(new Date(now.getTime() + 15 * 60_000).toISOString());

    await runScheduledWorker(configuration, new Date(now.getTime() + 16 * 60_000));
    const expired = await testDb.prepare(`
      SELECT status FROM notification_deliveries WHERE endpoint_hash = ?
    `).bind(subscriptions[0].endpointHash).first<{ status: string }>();
    const activeSubscriptions = await testDb.prepare(`
      SELECT COUNT(*) AS count FROM notification_subscriptions WHERE profile_id = ? AND active = 1
    `).bind(id.profileId).first<{ count: number }>();
    expect(expired?.status).toBe('EXPIRED');
    expect(activeSubscriptions?.count).toBe(0);
  });

  it('skips missing, stale, and already-completed daily snapshots', async () => {
    const records = [
      await seedProfile({ snapshotDate: null }),
      await seedProfile({ snapshotSyncedAt: '2026-10-29T17:00:00.000Z' }),
      await seedProfile({
        snapshot: [{ contestId: 51000, problemIndex: 'A', verifiedAccepted: true }],
      }),
      await seedProfile({ snapshot: [] }),
    ];
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const stats = await runScheduledWorker(workerEnv(), now);
    expect(stats.notificationsSent).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(records).toHaveLength(4);
  });

  it('uses Asia/Hebron local date and honors the 20:00 reminder boundary', async () => {
    expect(getLocalDateTime(new Date('2026-01-15T18:00:00.000Z'))).toEqual({
      date: '2026-01-15',
      time: '20:00',
    });
    const { id } = await seedProfile({ reminderTime: '20:01' });
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const stats = await runScheduledWorker(workerEnv(), now);
    expect(stats.notificationsSent).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(id.profileId).toBeTruthy();
  });

  it('runs from a native Cron event and records the execution in D1', async () => {
    await worker.scheduled(
      { cron: '*/5 * * * *', scheduledTime: now.getTime() } as ScheduledController,
      workerEnv(),
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    const run = await testDb.prepare(`
      SELECT status FROM notification_worker_runs ORDER BY started_at DESC LIMIT 1
    `).first<{ status: string }>();
    expect(run?.status).toBe('SUCCEEDED');
    const health = await new NotificationStore(testDb).getHealth();
    expect(health.schedulerHealthy).toBe(true);
  });
});

describe('Web Push on Cloudflare Workers runtime', () => {
  it('creates a verifiable VAPID JWT and decryptable aes128gcm record', async () => {
    const vapidPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const vapidJwk = await crypto.subtle.exportKey('jwk', vapidPair.privateKey);
    const vapidPublic = new Uint8Array(await crypto.subtle.exportKey('raw', vapidPair.publicKey));
    const subscription = await generateSubscription();
    const auth = base64UrlDecode(subscription.auth);
    const payload = JSON.stringify({ title: 'Push test', body: 'Encrypted in Workerd' });
    const started = performance.now();
    const encrypted = await encryptWebPushPayload(payload, subscription.p256dh, subscription.auth);
    const wallTimeMs = performance.now() - started;

    const serverPublicLength = encrypted[20];
    const serverPublic = encrypted.slice(21, 21 + serverPublicLength);
    const serverKey = await crypto.subtle.importKey(
      'raw',
      bufferSource(serverPublic),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const clientPublic = await crypto.subtle.importKey(
      'raw',
      bufferSource(base64UrlDecode(subscription.p256dh)),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'ECDH', public: serverKey },
      subscription.privateKey,
      256,
    ));
    const authPrk = await hmac(auth, sharedSecret);
    const keyInfo = concat(
      new TextEncoder().encode('WebPush: info\0'),
      base64UrlDecode(subscription.p256dh),
      serverPublic,
    );
    const ikm = await hkdfExpand(authPrk, keyInfo, 32);
    const salt = encrypted.slice(0, 16);
    const prk = await hmac(salt, ikm);
    const contentKey = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
    const aesKey = await crypto.subtle.importKey('raw', bufferSource(contentKey), { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bufferSource(nonce) },
      aesKey,
      bufferSource(encrypted.slice(21 + serverPublicLength)),
    );
    const decoded = new Uint8Array(plaintext);
    expect(decoded[decoded.length - 1]).toBe(2);
    expect(new TextDecoder().decode(decoded.slice(0, -1))).toBe(payload);
    expect(Number.isFinite(wallTimeMs)).toBe(true);

    const requests: Array<{ init?: RequestInit }> = [];
    const request: typeof fetch = async (_input, init) => {
      requests.push({ init });
      return new Response(null, { status: 201 });
    };
    const vapid = { publicKey: base64UrlEncode(vapidPublic), privateKey: vapidJwk.d || '', subject: 'mailto:tests@example.com' };
    const jwtStarted = performance.now();
    await sendWebPush(
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
      JSON.parse(payload),
      vapid,
      request,
      now,
    );
    const endToEndWallTimeMs = performance.now() - jwtStarted;
    const headers = new Headers(requests[0]?.init?.headers);
    const token = headers.get('Authorization')?.match(/^vapid t=([^,]+)/)?.[1];
    expect(token).toBeTruthy();
    const [header, claims, signature] = token!.split('.');
    const verifyKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: vapidJwk.x, y: vapidJwk.y, ext: true, key_ops: ['verify'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      bufferSource(base64UrlDecode(signature)),
      bufferSource(new TextEncoder().encode(`${header}.${claims}`)),
    )).toBe(true);
    expect(headers.get('Content-Encoding')).toBe('aes128gcm');
    console.info(JSON.stringify({
      metric: 'workerd_web_push_crypto_wall_time_ms',
      encryption: Number(wallTimeMs.toFixed(3)),
      endToEnd: Number(endToEndWallTimeMs.toFixed(3)),
      cpuLimitConfiguredMs: 10,
    }));
  });
});
