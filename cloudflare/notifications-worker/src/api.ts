import { isValidHandle, isValidReminderTime, isValidSubscription } from './logic';
import { NotificationStore } from './store';
import type { Env } from './types';

const PROFILE_ID_PATTERN = /^pub_[a-f0-9]{32}$/;
const OWNER_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

interface ProfileIdentity {
  profileId: string;
  ownerId: string;
  handle: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 32_000) return null;
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function profileIdentity(value: Record<string, unknown>): ProfileIdentity | null {
  const profileId = value.profileId;
  const ownerId = value.ownerId;
  const handle = value.handle;
  if (
    typeof profileId !== 'string' ||
    !PROFILE_ID_PATTERN.test(profileId) ||
    typeof ownerId !== 'string' ||
    !OWNER_ID_PATTERN.test(ownerId) ||
    !isValidHandle(handle)
  ) return null;
  return { profileId, ownerId, handle };
}

function isValidEndpointHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    const health = await new NotificationStore(env.DB).getHealth();
    return jsonResponse({
      status: 'ok',
      timezone: 'Asia/Hebron',
      vapidConfigured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      ...health,
    });
  }

  const authorization = request.headers.get('authorization') || '';
  const providedSecret = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (
    !env.API_SECRET ||
    providedSecret.length > 256 ||
    !constantTimeEqual(providedSecret, env.API_SECRET)
  ) {
    return jsonResponse({ error: 'Authentication required' }, 401);
  }
  if (!url.pathname.startsWith('/internal/v1/')) {
    return jsonResponse({ error: 'Not found' }, 404);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: 'A valid JSON request body is required' }, 400);
  const store = new NotificationStore(env.DB);
  const identity = profileIdentity(body);

  if (url.pathname === '/internal/v1/profiles/ensure') {
    if (!identity) return jsonResponse({ error: 'Invalid notification profile' }, 400);
    const saved = await store.ensureProfile(identity.profileId, identity.ownerId, identity.handle);
    return saved
      ? jsonResponse({ success: true })
      : jsonResponse({ error: 'Notification profile ownership mismatch' }, 409);
  }

  if (url.pathname === '/internal/v1/profiles/delete') {
    if (!identity) return jsonResponse({ error: 'Invalid notification profile' }, 400);
    const deleted = await store.deleteProfile(identity.profileId, identity.ownerId);
    return jsonResponse({ success: true, deleted });
  }

  if (url.pathname === '/internal/v1/settings/get') {
    if (!identity) return jsonResponse({ error: 'Invalid notification profile' }, 400);
    const profile = await store.getProfile(identity.profileId, identity.ownerId);
    if (!profile || profile.cf_handle.toLowerCase() !== identity.handle.toLowerCase()) {
      return jsonResponse({ error: 'Notification profile ownership mismatch' }, 409);
    }
    return jsonResponse({
      settings: {
        contestReminders: Boolean(profile.contest_reminders),
        dailyReminders: Boolean(profile.daily_reminders),
        reminderTime: profile.reminder_time,
        timezone: profile.timezone,
      },
    });
  }

  if (url.pathname === '/internal/v1/settings/update') {
    if (
      !identity ||
      typeof body.contestReminders !== 'boolean' ||
      typeof body.dailyReminders !== 'boolean' ||
      !isValidReminderTime(body.reminderTime)
    ) return jsonResponse({ error: 'Invalid notification settings' }, 400);
    const profile = await store.getProfile(identity.profileId, identity.ownerId);
    if (!profile || profile.cf_handle.toLowerCase() !== identity.handle.toLowerCase()) {
      return jsonResponse({ error: 'Notification profile ownership mismatch' }, 409);
    }
    const updated = await store.updateSettings(identity.profileId, identity.ownerId, {
      contestReminders: body.contestReminders,
      dailyReminders: body.dailyReminders,
      reminderTime: body.reminderTime,
    });
    if (!updated) return jsonResponse({ error: 'Notification profile was not updated' }, 409);
    return jsonResponse({
      success: true,
      settings: {
        contestReminders: body.contestReminders,
        dailyReminders: body.dailyReminders,
        reminderTime: body.reminderTime,
        timezone: 'Asia/Hebron',
      },
    });
  }

  if (url.pathname === '/internal/v1/subscriptions/status') {
    if (
      !identity ||
      typeof body.endpoint !== 'string' ||
      body.endpoint.length > 2048 ||
      !isValidEndpointHash(body.endpointHash)
    ) return jsonResponse({ error: 'Invalid subscription lookup' }, 400);
    const profile = await store.getProfile(identity.profileId, identity.ownerId);
    if (!profile || profile.cf_handle.toLowerCase() !== identity.handle.toLowerCase()) {
      return jsonResponse({ error: 'Notification profile ownership mismatch' }, 409);
    }
    const subscription = await store.getSubscription(identity.profileId, identity.ownerId, body.endpointHash);
    return jsonResponse({ registered: subscription?.endpoint === body.endpoint });
  }

  if (url.pathname === '/internal/v1/subscriptions/register') {
    if (!identity || !isValidSubscription(body.subscription)) {
      return jsonResponse({ error: 'A valid HTTPS push subscription is required' }, 400);
    }
    const profile = await store.getProfile(identity.profileId, identity.ownerId);
    if (!profile || profile.cf_handle.toLowerCase() !== identity.handle.toLowerCase()) {
      return jsonResponse({ error: 'Notification profile ownership mismatch' }, 409);
    }
    const endpointHash = await hashEndpoint(body.subscription.endpoint);
    const saved = await store.saveSubscription({
      endpoint_hash: endpointHash,
      profile_id: identity.profileId,
      owner_id: identity.ownerId,
      endpoint: body.subscription.endpoint,
      p256dh: body.subscription.keys.p256dh,
      auth: body.subscription.keys.auth,
    });
    return saved
      ? jsonResponse({ success: true }, 201)
      : jsonResponse({ error: 'This device is already registered to another profile' }, 409);
  }

  if (url.pathname === '/internal/v1/subscriptions/remove') {
    if (
      !identity ||
      typeof body.endpoint !== 'string' ||
      body.endpoint.length > 2048
    ) return jsonResponse({ error: 'A valid push endpoint is required' }, 400);
    const profile = await store.getProfile(identity.profileId, identity.ownerId);
    if (!profile || profile.cf_handle.toLowerCase() !== identity.handle.toLowerCase()) {
      return jsonResponse({ error: 'Notification profile ownership mismatch' }, 409);
    }
    const endpointHash = await hashEndpoint(body.endpoint);
    const removed = await store.removeSubscription(identity.profileId, identity.ownerId, endpointHash);
    return jsonResponse({ success: true, removed });
  }

  if (url.pathname === '/internal/v1/snapshots/sync') {
    if (
      !identity ||
      typeof body.snapshotDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.snapshotDate) ||
      typeof body.syncedAt !== 'string' ||
      !Number.isFinite(Date.parse(body.syncedAt))
    ) return jsonResponse({ error: 'Invalid daily snapshot' }, 400);
    const profile = await store.getProfile(identity.profileId, identity.ownerId);
    if (!profile || profile.cf_handle.toLowerCase() !== identity.handle.toLowerCase()) {
      return jsonResponse({ error: 'Notification profile ownership mismatch' }, 409);
    }
    const saved = await store.updateSnapshot(
      identity.profileId,
      identity.ownerId,
      body.snapshotDate,
      body.problems,
      body.syncedAt,
    );
    return saved
      ? jsonResponse({ success: true })
      : jsonResponse({ error: 'Daily snapshot is invalid or profile is missing' }, 400);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

async function hashEndpoint(endpoint: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
