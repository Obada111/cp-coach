import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  CodeforcesApiError,
  isCodeforcesCredentialRejection,
  requestCodeforcesApi,
} from './codeforcesApi.js';
import {
  decryptCodeforcesCredentials,
  encryptCodeforcesCredentials,
  type CodeforcesCredentialPair,
} from './codeforcesCredentials.js';
import { requireSupabaseUser, type AuthenticatedSocialRequest } from './socialAuth.js';
import {
  isSocialDatabaseConfigured,
  SocialDatabaseConfigurationError,
  withSystemTransaction,
  withUserTransaction,
  type SocialQuery,
} from './socialDatabase.js';
import { isPresenceOnline, isSocialCacheStale } from './socialState.js';

const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{2,64}$/;
const MAX_WATCHED_BLOGGERS = 30;
const CHALLENGE_TTL_MS = 15 * 60_000;

interface CfUserInfo {
  handle: string;
  firstName?: string;
  rating?: number;
  lastOnlineTimeSeconds?: number;
}

interface CfBlogEntry {
  id: number;
  authorHandle: string;
  title: string;
  creationTimeSeconds: number;
  tags?: string[];
  content?: string;
}

interface CfComment {
  id: number;
  commentatorHandle: string;
  creationTimeSeconds: number;
  text: string;
  parentCommentId?: number;
}

interface RecentAction {
  timeSeconds: number;
  blogEntry?: CfBlogEntry;
}

type AsyncRoute = (req: Request, res: Response) => Promise<void>;

class SocialRouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SocialRouteError';
  }
}

function route(handler: AsyncRoute) {
  return (req: Request, res: Response): void => {
    void handler(req, res).catch((error: unknown) => sendRouteError(res, error));
  };
}

function sendRouteError(res: Response, error: unknown): void {
  if (res.headersSent) return;
  if (error instanceof SocialRouteError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') {
    const status = error.statusCode;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: 'The requested social resource was not found or is unavailable.' });
      return;
    }
  }
  if (error instanceof SocialDatabaseConfigurationError) {
    res.status(503).json({ error: error.message });
    return;
  }
  if (error instanceof CodeforcesApiError) {
    res.status(503).json({ error: 'The Codeforces API is temporarily unavailable. Please try again later.' });
    return;
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
    res.status(409).json({ error: 'That item is already linked or a matching request is pending.' });
    return;
  }
  console.error('[SocialAPI] Request failed:', error instanceof Error ? error.name : 'UnknownError');
  res.status(500).json({ error: 'The social request could not be completed.' });
}

function getSocialUser(req: Request) {
  return (req as AuthenticatedSocialRequest).socialUser;
}

function parseHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const handle = value.trim();
  return HANDLE_PATTERN.test(handle) ? handle : null;
}

function plainText(content: string): string {
  return content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexadecimal: string) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function safeBlogEntry(entry: CfBlogEntry) {
  return {
    entryId: entry.id,
    title: entry.title.slice(0, 400),
    authorHandle: entry.authorHandle,
    creationTimeSeconds: entry.creationTimeSeconds,
    tags: Array.isArray(entry.tags)
      ? entry.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 32)
      : [],
    preview: plainText(entry.content || '').slice(0, 500),
  };
}

function requireSocialDatabase(_req: Request, res: Response, next: () => void): void {
  if (!isSocialDatabaseConfigured()) {
    res.status(503).json({ error: 'Social storage is not configured for this deployment.' });
    return;
  }
  next();
}

function limited(scope: string, limit: number, periodMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let requests = 0;
  return (req: Request, res: Response, next: () => void): void => {
    const userId = getSocialUser(req)?.userId || req.ip || 'unknown';
    const key = `${scope}:${userId}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + periodMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    requests += 1;
    if (requests % 1_000 === 0) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: 'Too many social requests. Please retry shortly.' });
      return;
    }
    next();
  };
}

async function ensureSocialProfile(client: SocialQuery, userId: string): Promise<void> {
  await client.query(
    'INSERT INTO public.social_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
}

async function addNotification(
  client: SocialQuery,
  userId: string,
  eventKey: string,
  kind: 'friend_request' | 'new_blog_post' | 'friend_activity',
  title: string,
  body: string,
  href: string | null,
): Promise<void> {
  await client.query(`
    INSERT INTO public.social_notifications (user_id, event_key, kind, title, body, href)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id, event_key) DO NOTHING
  `, [userId, eventKey, kind, title, body, href]);
}

async function notifyUser(
  userId: string,
  eventKey: string,
  kind: 'friend_request' | 'new_blog_post' | 'friend_activity',
  title: string,
  body: string,
  href: string | null,
): Promise<void> {
  await withSystemTransaction(async (client) => {
    await client.query(`
      INSERT INTO public.social_notifications (user_id, event_key, kind, title, body, href)
      SELECT $1, $2, $3, $4, $5, $6
      WHERE EXISTS (SELECT 1 FROM public.social_profiles WHERE user_id = $1)
      ON CONFLICT (user_id, event_key) DO NOTHING
    `, [userId, eventKey, kind, title, body, href]);
  });
}

function credentialKeyIsConfigured(): boolean {
  return Boolean(process.env.CODEFORCES_CREDENTIAL_ENCRYPTION_KEY?.trim());
}

function validCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function decodeCredentialRow(row: {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
}, userId: string): CodeforcesCredentialPair {
  return decryptCodeforcesCredentials(userId, {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
  });
}

export const socialRouter = Router();

socialRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
socialRouter.use(limited('social-ip', 180, 60_000));
socialRouter.use(requireSupabaseUser);
socialRouter.use(limited('social-user', 180, 60_000));
socialRouter.use(requireSocialDatabase);

socialRouter.get('/account', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const result = await withUserTransaction(user, async (client) => {
    await ensureSocialProfile(client, user.userId);
    const profile = await client.query<{
      codeforces_handle: string | null;
      handle_verified_at: Date | null;
      allow_friend_requests: boolean;
      show_cp_presence: boolean;
      show_last_active: boolean;
      notify_friend_requests: boolean;
      notify_new_posts: boolean;
    }>(`
      SELECT codeforces_handle, handle_verified_at, allow_friend_requests,
        show_cp_presence, show_last_active, notify_friend_requests, notify_new_posts
      FROM public.social_profiles WHERE user_id = $1
    `, [user.userId]);
    const credentials = await client.query('SELECT 1 FROM public.codeforces_credentials WHERE user_id = $1', [user.userId]);
    return {
      profile: profile.rows[0],
      credentialsConfigured: credentials.rowCount === 1,
    };
  });
  res.json(result);
}));

socialRouter.post('/codeforces/link/challenge', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const handle = parseHandle(req.body?.handle);
  if (!handle) {
    res.status(400).json({ error: 'Enter a valid Codeforces handle.' });
    return;
  }
  const linked = await withUserTransaction(user, async (client) => {
    const result = await client.query<{ codeforces_handle: string | null }>(
      'SELECT codeforces_handle FROM public.social_profiles WHERE user_id = $1',
      [user.userId],
    );
    return result.rows[0]?.codeforces_handle || null;
  });
  if (linked && linked.toLowerCase() !== handle.toLowerCase()) {
    res.status(409).json({ error: 'Disconnect the currently linked Codeforces account before linking another.' });
    return;
  }

  const users = await requestCodeforcesApi<CfUserInfo[]>('user.info', { handles: handle }, undefined, 'normal');
  const profile = users.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
  if (!profile) {
    res.status(404).json({ error: 'That Codeforces handle was not found.' });
    return;
  }

  const challenge = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await withUserTransaction(user, async (client) => {
    await ensureSocialProfile(client, user.userId);
    await client.query(`
      INSERT INTO public.codeforces_link_challenges (user_id, handle, challenge_hash, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        handle = EXCLUDED.handle,
        challenge_hash = EXCLUDED.challenge_hash,
        expires_at = EXCLUDED.expires_at,
        created_at = now()
    `, [user.userId, profile.handle, createHash('sha256').update(challenge).digest(), expiresAt]);
  });

  res.status(201).json({
    handle: profile.handle,
    challenge,
    expiresAt: expiresAt.toISOString(),
    field: 'firstName',
    originalFirstName: profile.firstName || null,
    instructions: 'Temporarily set your Codeforces profile first name to the challenge, then verify it here. Restore your original first name afterward.',
  });
}));

socialRouter.post('/codeforces/link/verify', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const challenge = typeof req.body?.challenge === 'string' ? req.body.challenge : '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(challenge)) {
    res.status(400).json({ error: 'Enter the verification challenge exactly as shown.' });
    return;
  }
  const pending = await withUserTransaction(user, async (client) => {
    const result = await client.query<{ handle: string; challenge_hash: Buffer; expires_at: Date }>(`
      SELECT handle, challenge_hash, expires_at
      FROM public.codeforces_link_challenges WHERE user_id = $1
    `, [user.userId]);
    return result.rows[0] || null;
  });
  if (!pending || new Date(pending.expires_at).getTime() <= Date.now()) {
    res.status(410).json({ error: 'The verification challenge expired. Start a new challenge.' });
    return;
  }

  const users = await requestCodeforcesApi<CfUserInfo[]>('user.info', { handles: pending.handle }, undefined, 'normal');
  const profile = users.find((item) => item.handle.toLowerCase() === pending.handle.toLowerCase());
  const observedHash = createHash('sha256').update(profile?.firstName || '').digest();
  if (!profile || observedHash.length !== pending.challenge_hash.length || !timingSafeEqual(observedHash, pending.challenge_hash)) {
    res.status(409).json({ error: 'Codeforces has not published the challenge in the profile first-name field yet.' });
    return;
  }

  try {
    await withUserTransaction(user, async (client) => {
      await ensureSocialProfile(client, user.userId);
      await client.query(`
        UPDATE public.social_profiles
        SET codeforces_handle = $2, handle_verified_at = now(), updated_at = now()
        WHERE user_id = $1
      `, [user.userId, profile.handle]);
      await client.query('DELETE FROM public.codeforces_link_challenges WHERE user_id = $1', [user.userId]);
      await client.query(`
        INSERT INTO public.social_sync_state (user_id, next_friends_refresh_at, next_blogs_refresh_at)
        VALUES ($1, now(), now())
        ON CONFLICT (user_id) DO UPDATE SET
          next_friends_refresh_at = now(),
          updated_at = now()
      `, [user.userId]);
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      res.status(409).json({ error: 'That Codeforces handle is already linked to another CP Coach account.' });
      return;
    }
    throw error;
  }
  res.json({ verified: true, handle: profile.handle });
}));

socialRouter.delete('/codeforces/link', route(async (req, res) => {
  const user = getSocialUser(req)!;
  await withUserTransaction(user, async (client) => {
    await client.query('DELETE FROM public.codeforces_credentials WHERE user_id = $1', [user.userId]);
    await client.query('DELETE FROM public.codeforces_friends_cache WHERE user_id = $1', [user.userId]);
    await client.query('DELETE FROM public.codeforces_link_challenges WHERE user_id = $1', [user.userId]);
    await client.query(`
      UPDATE public.social_profiles
      SET codeforces_handle = NULL, handle_verified_at = NULL, updated_at = now()
      WHERE user_id = $1
    `, [user.userId]);
  });
  res.json({ success: true });
}));

socialRouter.put('/codeforces/credentials', route(async (req, res) => {
  const user = getSocialUser(req)!;
  if (!credentialKeyIsConfigured()) {
    res.status(503).json({ error: 'Encrypted Codeforces credential storage is not configured.' });
    return;
  }
  const key = req.body?.key;
  const secret = req.body?.secret;
  if (!validCredential(key) || !validCredential(secret)) {
    res.status(400).json({ error: 'Enter the Codeforces API Key and Secret from Codeforces API settings.' });
    return;
  }
  const profile = await withUserTransaction(user, async (client) => {
    const result = await client.query<{ codeforces_handle: string | null }>(
      'SELECT codeforces_handle FROM public.social_profiles WHERE user_id = $1 AND handle_verified_at IS NOT NULL',
      [user.userId],
    );
    return result.rows[0]?.codeforces_handle || null;
  });
  if (!profile) {
    res.status(409).json({ error: 'Verify Codeforces handle ownership before adding API credentials.' });
    return;
  }

  const credentials = { key, secret };
  try {
    await requestCodeforcesApi<string[]>('user.friends', { onlyOnline: true }, credentials, 'normal');
  } catch (error) {
    if (!isCodeforcesCredentialRejection(error)) throw error;
    res.status(400).json({ error: 'Codeforces rejected these API credentials. Check the key and secret and try again.' });
    return;
  }
  const encrypted = encryptCodeforcesCredentials(user.userId, credentials);
  await withUserTransaction(user, async (client) => {
    await client.query(`
      INSERT INTO public.codeforces_credentials (user_id, ciphertext, nonce, auth_tag, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (user_id) DO UPDATE SET
        ciphertext = EXCLUDED.ciphertext,
        nonce = EXCLUDED.nonce,
        auth_tag = EXCLUDED.auth_tag,
        updated_at = now()
    `, [user.userId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag]);
    await client.query(`
      INSERT INTO public.social_sync_state (user_id, next_friends_refresh_at)
      VALUES ($1, now())
      ON CONFLICT (user_id) DO UPDATE SET next_friends_refresh_at = now(), updated_at = now()
    `, [user.userId]);
  });
  res.json({ success: true, credentialsConfigured: true });
}));

socialRouter.delete('/codeforces/credentials', route(async (req, res) => {
  const user = getSocialUser(req)!;
  await withUserTransaction(user, async (client) => {
    await client.query('DELETE FROM public.codeforces_credentials WHERE user_id = $1', [user.userId]);
    await client.query('DELETE FROM public.codeforces_friends_cache WHERE user_id = $1', [user.userId]);
  });
  res.json({ success: true, credentialsConfigured: false });
}));

socialRouter.get('/codeforces/friends/online', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const data = await withUserTransaction(user, async (client) => {
    const credential = await client.query('SELECT 1 FROM public.codeforces_credentials WHERE user_id = $1', [user.userId]);
    if (credential.rowCount === 0) return { connected: false, friends: [], refreshedAt: null, refreshing: false };
    const rows = await client.query<{
      friend_handle: string;
      rating: number | null;
      last_online_time_seconds: string | null;
      is_online: boolean;
      refreshed_at: Date;
    }>(`
      SELECT friend_handle, rating, last_online_time_seconds, is_online, refreshed_at
      FROM public.codeforces_friends_cache
      WHERE user_id = $1
      ORDER BY is_online DESC, last_online_time_seconds DESC NULLS LAST, lower(friend_handle)
      LIMIT 1000
    `, [user.userId]);
    const state = await client.query<{ friends_refreshed_at: Date | null; next_friends_refresh_at: Date | null }>(`
      SELECT friends_refreshed_at, next_friends_refresh_at
      FROM public.social_sync_state WHERE user_id = $1
    `, [user.userId]);
    const refreshedAt = state.rows[0]?.friends_refreshed_at || null;
    const stale = isSocialCacheStale(refreshedAt, 90_000);
    const nextRefreshAt = state.rows[0]?.next_friends_refresh_at || null;
    if (stale && (!nextRefreshAt || new Date(nextRefreshAt).getTime() <= Date.now())) {
      await client.query(`
        INSERT INTO public.social_sync_state (user_id, next_friends_refresh_at)
        VALUES ($1, now())
        ON CONFLICT (user_id) DO UPDATE SET
          next_friends_refresh_at = LEAST(COALESCE(public.social_sync_state.next_friends_refresh_at, now()), now()),
          updated_at = now()
      `, [user.userId]);
    }
    return {
      connected: true,
      friends: rows.rows.map((friend) => ({
        handle: friend.friend_handle,
        rating: friend.rating,
        lastOnlineTimeSeconds: friend.last_online_time_seconds ? Number(friend.last_online_time_seconds) : null,
        codeforcesOnline: friend.is_online,
        profileUrl: `https://codeforces.com/profile/${encodeURIComponent(friend.friend_handle)}`,
      })),
      refreshedAt: refreshedAt ? new Date(refreshedAt).toISOString() : null,
      refreshing: stale,
    };
  });
  res.json(data);
}));

socialRouter.get('/friends', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const data = await withUserTransaction(user, async (client) => {
    await ensureSocialProfile(client, user.userId);
    const result = await client.query<{
      user_id: string;
      codeforces_handle: string | null;
      show_last_active: boolean;
      heartbeat_at: Date | null;
      expires_at: Date | null;
      show_cp_presence: boolean;
      notify_online: boolean;
    }>(`
      SELECT other.user_id, other.codeforces_handle, other.show_last_active,
        p.heartbeat_at, p.expires_at, other.show_cp_presence,
        COALESCE(pref.notify_online, false) AS notify_online
      FROM public.friendships f
      JOIN public.social_profiles other
        ON other.user_id = CASE
          WHEN f.user_low_id = $1 THEN f.user_high_id ELSE f.user_low_id
        END
      LEFT JOIN public.friend_presence p ON p.user_id = other.user_id
      LEFT JOIN public.friend_activity_preferences pref
        ON pref.user_id = $1 AND pref.friend_id = other.user_id
      WHERE f.user_low_id = $1 OR f.user_high_id = $1
      ORDER BY lower(other.codeforces_handle)
    `, [user.userId]);
    return result.rows.map((friend) => {
      const cpOnline = friend.show_cp_presence && isPresenceOnline(friend.expires_at);
      const lastActive = friend.show_last_active && friend.heartbeat_at
        ? new Date(friend.heartbeat_at).toISOString()
        : null;
      return {
        id: friend.user_id,
        handle: friend.codeforces_handle,
        cpCoachOnline: cpOnline,
        lastActiveAt: lastActive,
        notifyOnOnline: friend.notify_online,
      };
    });
  });
  res.json({ friends: data });
}));

socialRouter.get('/friends/requests', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const requests = await withUserTransaction(user, async (client) => {
    const result = await client.query(`
      SELECT r.id, r.status, r.created_at, r.sender_id, r.recipient_id,
        sender.codeforces_handle AS sender_handle,
        recipient.codeforces_handle AS recipient_handle,
        CASE WHEN r.recipient_id = $1 THEN 'incoming' ELSE 'outgoing' END AS direction
      FROM public.friend_requests r
      JOIN public.social_profiles sender ON sender.user_id = r.sender_id
      JOIN public.social_profiles recipient ON recipient.user_id = r.recipient_id
      WHERE (r.sender_id = $1 OR r.recipient_id = $1)
        AND r.status = 'pending'
      ORDER BY r.created_at DESC
      LIMIT 100
    `, [user.userId]);
    return result.rows;
  });
  res.json({ requests });
}));

socialRouter.post('/friends/requests', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const handle = parseHandle(req.body?.handle);
  if (!handle) {
    res.status(400).json({ error: 'Enter the verified Codeforces handle of the person you want to add.' });
    return;
  }
  const result = await withUserTransaction(user, async (client) => {
    const sender = await client.query<{ codeforces_handle: string | null }>(
      'SELECT codeforces_handle FROM public.social_profiles WHERE user_id = $1 AND handle_verified_at IS NOT NULL',
      [user.userId],
    );
    if (!sender.rows[0]?.codeforces_handle) {
      return { error: 'Link and verify your Codeforces handle before sending friend requests.', status: 409 as const };
    }
    const recipient = await client.query<{ user_id: string; codeforces_handle: string }>(`
      SELECT user_id, codeforces_handle
      FROM public.social_profiles
      WHERE lower(codeforces_handle) = lower($1)
        AND allow_friend_requests = true
        AND handle_verified_at IS NOT NULL
      LIMIT 1
    `, [handle]);
    const target = recipient.rows[0];
    if (!target || target.user_id === user.userId) {
      return { error: 'No eligible CP Coach member is linked to that handle.', status: 404 as const };
    }
    const friendship = await client.query(`
      SELECT 1 FROM public.friendships
      WHERE (user_low_id = LEAST($1::uuid, $2::uuid) AND user_high_id = GREATEST($1::uuid, $2::uuid))
    `, [user.userId, target.user_id]);
    if (friendship.rowCount) return { error: 'You are already CP Coach friends.', status: 409 as const };
    const incoming = await client.query(`
      SELECT id FROM public.friend_requests
      WHERE sender_id = $2 AND recipient_id = $1 AND status = 'pending'
    `, [user.userId, target.user_id]);
    if (incoming.rowCount) return { error: 'That member has already sent you a friend request.', status: 409 as const };
    const request = await client.query<{ id: string }>(`
      INSERT INTO public.friend_requests (sender_id, recipient_id)
      VALUES ($1, $2) RETURNING id
    `, [user.userId, target.user_id]);
    const notify = await client.query<{ notify_friend_requests: boolean }>(
      'SELECT notify_friend_requests FROM public.social_profiles WHERE user_id = $1',
      [target.user_id],
    );
    return {
      requestId: request.rows[0].id,
      recipientId: target.user_id,
      recipientHandle: target.codeforces_handle,
      notify: notify.rows[0]?.notify_friend_requests === true,
    };
  });
  if ('error' in result) {
    res.status(result.status || 409).json({ error: result.error });
    return;
  }
  if (result.notify) {
    try {
      await notifyUser(
        result.recipientId,
        `friend-request:${result.requestId}`,
        'friend_request',
        'New CP Coach friend request',
        'Someone linked to a Codeforces handle sent you a friend request.',
        '/friends',
      );
    } catch (error) {
      console.error('[SocialAPI] Friend request notification could not be saved:', error instanceof Error ? error.name : 'UnknownError');
    }
  }
  res.status(201).json({ success: true, requestId: result.requestId });
}));

socialRouter.post('/friends/requests/:id/respond', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const requestId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    res.status(400).json({ error: 'Invalid friend request.' });
    return;
  }
  if (typeof req.body?.accept !== 'boolean') {
    res.status(400).json({ error: 'Choose whether to accept or reject the friend request.' });
    return;
  }
  const result = await withUserTransaction(user, async (client) => {
    const request = await client.query<{ id: string; sender_id: string; recipient_id: string }>(`
      UPDATE public.friend_requests
      SET status = $3, updated_at = now()
      WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
      RETURNING id, sender_id, recipient_id
    `, [requestId, user.userId, req.body.accept ? 'accepted' : 'rejected']);
    const row = request.rows[0];
    if (!row) return null;
    if (req.body.accept) {
      await client.query(`
        INSERT INTO public.friendships (user_low_id, user_high_id)
        VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
        ON CONFLICT DO NOTHING
      `, [row.sender_id, row.recipient_id]);
      await client.query(`
        INSERT INTO public.social_sync_state (user_id)
        VALUES ($1), ($2) ON CONFLICT (user_id) DO NOTHING
      `, [row.sender_id, row.recipient_id]);
    }
    return row;
  });
  if (!result) {
    res.status(404).json({ error: 'Pending friend request not found.' });
    return;
  }
  if (req.body.accept) {
    try {
      await notifyUser(
        result.sender_id,
        `friend-accepted:${result.id}`,
        'friend_request',
        'Friend request accepted',
        'Your CP Coach friend request was accepted.',
        '/friends',
      );
    } catch (error) {
      console.error('[SocialAPI] Friend acceptance notification could not be saved:', error instanceof Error ? error.name : 'UnknownError');
    }
  }
  res.json({ success: true, status: req.body.accept ? 'accepted' : 'rejected' });
}));

socialRouter.delete('/friends/:friendId', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const friendId = req.params.friendId;
  if (!/^[0-9a-f-]{36}$/i.test(friendId)) {
    res.status(400).json({ error: 'Invalid friend.' });
    return;
  }
  const result = await withUserTransaction(user, async (client) => {
    const deleted = await client.query(`
      DELETE FROM public.friendships
      WHERE user_low_id = LEAST($1::uuid, $2::uuid)
        AND user_high_id = GREATEST($1::uuid, $2::uuid)
    `, [user.userId, friendId]);
    if (deleted.rowCount) {
      await client.query(
        'DELETE FROM public.friend_activity_preferences WHERE user_id = $1 AND friend_id = $2',
        [user.userId, friendId],
      );
    }
    return deleted;
  });
  res.json({ success: true, removed: result.rowCount === 1 });
}));

socialRouter.put('/friends/:friendId/activity-notifications', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const friendId = req.params.friendId;
  if (!/^[0-9a-f-]{36}$/i.test(friendId) || typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ error: 'A valid friend and notification setting are required.' });
    return;
  }
  await withUserTransaction(user, async (client) => {
    const friendship = await client.query(`
      SELECT 1 FROM public.friendships
      WHERE user_low_id = LEAST($1::uuid, $2::uuid)
        AND user_high_id = GREATEST($1::uuid, $2::uuid)
    `, [user.userId, friendId]);
    if (!friendship.rowCount) throw new SocialRouteError(404, 'Friend not found.');
    await client.query(`
      INSERT INTO public.friend_activity_preferences (user_id, friend_id, notify_online, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (user_id, friend_id) DO UPDATE SET notify_online = EXCLUDED.notify_online, updated_at = now()
    `, [user.userId, friendId, req.body.enabled]);
  });
  res.json({ success: true });
}));

socialRouter.get('/presence/settings', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const result = await withUserTransaction(user, async (client) => {
    await ensureSocialProfile(client, user.userId);
    const profile = await client.query<{
      show_cp_presence: boolean;
      show_last_active: boolean;
      allow_friend_requests: boolean;
      notify_friend_requests: boolean;
      notify_new_posts: boolean;
    }>(`
      SELECT show_cp_presence, show_last_active, allow_friend_requests,
        notify_friend_requests, notify_new_posts
      FROM public.social_profiles WHERE user_id = $1
    `, [user.userId]);
    return profile.rows[0];
  });
  res.json(result);
}));

socialRouter.put('/presence/settings', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const settings = req.body;
  const fields = [
    'showCpPresence',
    'showLastActive',
    'allowFriendRequests',
    'notifyFriendRequests',
    'notifyNewPosts',
  ] as const;
  if (!settings || fields.some((field) => typeof settings[field] !== 'boolean')) {
    res.status(400).json({ error: 'All privacy and notification settings must be boolean.' });
    return;
  }
  await withUserTransaction(user, async (client) => {
    await ensureSocialProfile(client, user.userId);
    await client.query(`
      UPDATE public.social_profiles SET
        show_cp_presence = $2,
        show_last_active = $3,
        allow_friend_requests = $4,
        notify_friend_requests = $5,
        notify_new_posts = $6,
        updated_at = now()
      WHERE user_id = $1
    `, [
      user.userId,
      settings.showCpPresence,
      settings.showLastActive,
      settings.allowFriendRequests,
      settings.notifyFriendRequests,
      settings.notifyNewPosts,
    ]);
    if (!settings.showCpPresence) {
      await client.query('DELETE FROM public.friend_presence WHERE user_id = $1', [user.userId]);
    }
  });
  res.json({ success: true });
}));

socialRouter.post('/presence/heartbeat', limited('presence-heartbeat', 3, 60_000), route(async (req, res) => {
  const user = getSocialUser(req)!;
  const becameOnline = await withUserTransaction(user, async (client) => {
    await ensureSocialProfile(client, user.userId);
    const visibility = await client.query<{ show_cp_presence: boolean }>(
      'SELECT show_cp_presence FROM public.social_profiles WHERE user_id = $1',
      [user.userId],
    );
    if (!visibility.rows[0]?.show_cp_presence) {
      await client.query('DELETE FROM public.friend_presence WHERE user_id = $1', [user.userId]);
      return false;
    }
    const previous = await client.query<{ expires_at: Date }>(`
      SELECT expires_at FROM public.friend_presence WHERE user_id = $1 FOR UPDATE
    `, [user.userId]);
    const transitionedOnline = !previous.rows[0] || new Date(previous.rows[0].expires_at).getTime() <= Date.now();
    await client.query(`
      INSERT INTO public.friend_presence (user_id, heartbeat_at, expires_at)
      VALUES ($1, now(), now() + interval '2 minutes')
      ON CONFLICT (user_id) DO UPDATE SET heartbeat_at = now(), expires_at = now() + interval '2 minutes'
    `, [user.userId]);
    return transitionedOnline;
  });
  if (becameOnline) {
    try {
      await withSystemTransaction(async (client) => {
        const recipients = await client.query<{ user_id: string; handle: string | null }>(`
          SELECT pref.user_id, owner.codeforces_handle AS handle
          FROM public.friend_activity_preferences pref
          JOIN public.friendships f
            ON (f.user_low_id = pref.user_id AND f.user_high_id = pref.friend_id)
            OR (f.user_high_id = pref.user_id AND f.user_low_id = pref.friend_id)
          JOIN public.social_profiles owner ON owner.user_id = pref.user_id
          WHERE pref.friend_id = $1
            AND pref.notify_online = true
            AND owner.show_cp_presence = true
        `, [user.userId]);
        const profile = await client.query<{ codeforces_handle: string | null }>(
          'SELECT codeforces_handle FROM public.social_profiles WHERE user_id = $1',
          [user.userId],
        );
        const handle = profile.rows[0]?.codeforces_handle || 'A CP Coach friend';
        for (const recipient of recipients.rows) {
          await client.query(`
            INSERT INTO public.social_notifications (user_id, event_key, kind, title, body)
            VALUES ($1, $2, 'friend_activity', 'A friend is online on CP Coach', $3)
            ON CONFLICT (user_id, event_key) DO NOTHING
          `, [recipient.user_id, `friend-online:${user.userId}:${Date.now()}`, `${handle} is online on CP Coach.`]);
        }
      });
    } catch (error) {
      console.error('[SocialAPI] Friend activity notification could not be saved:', error instanceof Error ? error.name : 'UnknownError');
    }
  }
  res.json({ success: true, expiresInSeconds: 120 });
}));

socialRouter.delete('/presence/heartbeat', route(async (req, res) => {
  const user = getSocialUser(req)!;
  await withUserTransaction(user, async (client) => {
    await client.query('DELETE FROM public.friend_presence WHERE user_id = $1', [user.userId]);
  });
  res.json({ success: true });
}));

socialRouter.get('/blogs/watchlist', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const result = await withUserTransaction(user, async (client) => client.query(`
    SELECT handle, created_at FROM public.blog_watchlist
    WHERE user_id = $1 ORDER BY lower(handle)
  `, [user.userId]));
  res.json({ bloggers: result.rows });
}));

socialRouter.post('/blogs/watchlist', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const handle = parseHandle(req.body?.handle);
  if (!handle) {
    res.status(400).json({ error: 'Enter a valid Codeforces blogger handle.' });
    return;
  }
  const account = await requestCodeforcesApi<CfUserInfo[]>('user.info', { handles: handle }, undefined, 'normal');
  const blogger = account.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
  if (!blogger) {
    res.status(404).json({ error: 'That Codeforces handle was not found.' });
    return;
  }
  const entries = await requestCodeforcesApi<CfBlogEntry[]>(
    'user.blogEntries',
    { handle: blogger.handle },
    undefined,
    'normal',
  );
  const recent = entries
    .filter((entry) => (
      Number.isSafeInteger(entry.id) &&
      entry.id > 0 &&
      Number.isFinite(entry.creationTimeSeconds) &&
      entry.authorHandle.toLowerCase() === blogger.handle.toLowerCase()
    ))
    .sort((a, b) => b.creationTimeSeconds - a.creationTimeSeconds)
    .slice(0, 50)
    .map(safeBlogEntry);

  await withUserTransaction(user, async (client) => {
    await ensureSocialProfile(client, user.userId);
    await client.query('SELECT user_id FROM public.social_profiles WHERE user_id = $1 FOR UPDATE', [user.userId]);
    const count = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.blog_watchlist WHERE user_id = $1',
      [user.userId],
    );
    if (Number(count.rows[0]?.count || 0) >= MAX_WATCHED_BLOGGERS) {
      throw new SocialRouteError(422, 'You can follow up to 30 bloggers.');
    }
    await client.query(
      'INSERT INTO public.blog_watchlist (user_id, handle) VALUES ($1, $2)',
      [user.userId, blogger.handle],
    );
    for (const entry of recent) {
      await client.query(`
        INSERT INTO public.blog_entries
          (user_id, entry_id, author_handle, title, preview, tags, creation_time_seconds)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, entry_id) DO UPDATE SET
          title = EXCLUDED.title,
          preview = CASE WHEN EXCLUDED.preview <> '' THEN EXCLUDED.preview ELSE public.blog_entries.preview END,
          tags = EXCLUDED.tags,
          synced_at = now()
      `, [
        user.userId,
        entry.entryId,
        entry.authorHandle,
        entry.title,
        entry.preview,
        entry.tags,
        entry.creationTimeSeconds,
      ]);
    }
    await client.query(`
      INSERT INTO public.social_sync_state (user_id, blogs_refreshed_at, next_blogs_refresh_at)
      VALUES ($1, now(), now() + interval '5 minutes')
      ON CONFLICT (user_id) DO UPDATE SET
        blogs_refreshed_at = now(),
        next_blogs_refresh_at = now() + interval '5 minutes',
        updated_at = now()
    `, [user.userId]);
  });
  res.status(201).json({ success: true, handle: blogger.handle, initialEntryCount: recent.length });
}));

socialRouter.delete('/blogs/watchlist/:handle', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const handle = parseHandle(req.params.handle);
  if (!handle) {
    res.status(400).json({ error: 'Invalid blogger handle.' });
    return;
  }
  const result = await withUserTransaction(user, async (client) => client.query(`
    DELETE FROM public.blog_watchlist
    WHERE user_id = $1 AND lower(handle) = lower($2)
  `, [user.userId, handle]));
  res.json({ success: true, removed: result.rowCount === 1 });
}));

socialRouter.get('/blogs/entries', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const handle = parseHandle(req.query.handle) || null;
  const topic = typeof req.query.topic === 'string' ? req.query.topic.trim().slice(0, 64) : '';
  const unreadOnly = req.query.unread === 'true';
  const savedOnly = req.query.saved === 'true';
  const result = await withUserTransaction(user, async (client) => {
    const entries = await client.query(`
      SELECT e.entry_id, e.author_handle, e.title, e.preview, e.tags,
        e.creation_time_seconds, e.synced_at,
        COALESCE(s.is_read, false) AS is_read,
        COALESCE(s.is_saved, false) AS is_saved,
        COALESCE(s.personal_note, '') AS personal_note
      FROM public.blog_entries e
      LEFT JOIN public.blog_entry_state s USING (user_id, entry_id)
      WHERE e.user_id = $1
        AND ($2::text IS NULL OR lower(e.author_handle) = lower($2))
        AND ($3::text = '' OR e.title ILIKE '%' || $3 || '%' OR e.preview ILIKE '%' || $3 || '%')
        AND ($4::text = '' OR $4 = ANY(e.tags))
        AND (NOT $5::boolean OR COALESCE(s.is_read, false) = false)
        AND (NOT $6::boolean OR COALESCE(s.is_saved, false) = true)
      ORDER BY e.creation_time_seconds DESC
      LIMIT 100
    `, [user.userId, handle, search, topic, unreadOnly, savedOnly]);
    const topics = await client.query<{ tag: string }>(`
      SELECT DISTINCT tag
      FROM public.blog_entries e
      CROSS JOIN LATERAL unnest(e.tags) AS tag
      WHERE e.user_id = $1
      ORDER BY tag
      LIMIT 100
    `, [user.userId]);
    return { entries, topics };
  });
  res.json({ entries: result.entries.rows.map((entry) => ({
    ...entry,
    entryId: Number(entry.entry_id),
    creationTimeSeconds: Number(entry.creation_time_seconds),
    codeforcesUrl: `https://codeforces.com/blog/entry/${entry.entry_id}`,
  })), topics: result.topics.rows.map(({ tag }) => tag) });
}));

socialRouter.put('/blogs/entries/:entryId/state', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const entryId = Number(req.params.entryId);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: 'Invalid blog entry.' });
    return;
  }
  const state = req.body || {};
  const isRead = state.isRead === undefined ? null : state.isRead;
  const isSaved = state.isSaved === undefined ? null : state.isSaved;
  const note = state.note === undefined ? null : state.note;
  if (
    (isRead !== null && typeof isRead !== 'boolean') ||
    (isSaved !== null && typeof isSaved !== 'boolean') ||
    (note !== null && (typeof note !== 'string' || note.length > 10_000)) ||
    (isRead === null && isSaved === null && note === null)
  ) {
    res.status(400).json({ error: 'Provide valid read, saved, or note values.' });
    return;
  }
  const result = await withUserTransaction(user, async (client) => {
    const exists = await client.query(
      'SELECT 1 FROM public.blog_entries WHERE user_id = $1 AND entry_id = $2',
      [user.userId, entryId],
    );
    if (!exists.rowCount) return false;
    await client.query(`
      INSERT INTO public.blog_entry_state (user_id, entry_id, is_read, is_saved, personal_note)
      VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false), COALESCE($5, ''))
      ON CONFLICT (user_id, entry_id) DO UPDATE SET
        is_read = COALESCE($3, public.blog_entry_state.is_read),
        is_saved = COALESCE($4, public.blog_entry_state.is_saved),
        personal_note = COALESCE($5, public.blog_entry_state.personal_note),
        updated_at = now()
    `, [user.userId, entryId, isRead, isSaved, note]);
    return true;
  });
  if (!result) {
    res.status(404).json({ error: 'Blog entry not found in your watchlist.' });
    return;
  }
  res.json({ success: true });
}));

socialRouter.get('/blogs/entries/:entryId', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const entryId = Number(req.params.entryId);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: 'Invalid blog entry.' });
    return;
  }
  const cached = await withUserTransaction(user, async (client) => {
    const result = await client.query<{
      author_handle: string;
      title: string;
      article_text: string;
      detail_fetched_at: Date | null;
    }>(`
      SELECT author_handle, title, article_text, detail_fetched_at
      FROM public.blog_entries
      WHERE user_id = $1 AND entry_id = $2
    `, [user.userId, entryId]);
    return result.rows[0] || null;
  });
  if (!cached) {
    res.status(404).json({ error: 'Blog entry not found in your watchlist.' });
    return;
  }
  if (cached.detail_fetched_at && Date.now() - new Date(cached.detail_fetched_at).getTime() < 60 * 60_000) {
    res.json({
      entryId,
      authorHandle: cached.author_handle,
      title: cached.title,
      content: cached.article_text,
      codeforcesUrl: `https://codeforces.com/blog/entry/${entryId}`,
    });
    return;
  }
  const entry = await requestCodeforcesApi<CfBlogEntry>(
    'blogEntry.view',
    { blogEntryId: entryId },
    undefined,
    'normal',
  );
  if (!entry || !entry.content) {
    res.status(404).json({ error: 'The article is no longer available from Codeforces.' });
    return;
  }
  const content = plainText(entry.content).slice(0, 200_000);
  await withUserTransaction(user, async (client) => {
    await client.query(`
      UPDATE public.blog_entries
      SET title = $3, article_text = $4, preview = left($4, 500), detail_fetched_at = now(), synced_at = now()
      WHERE user_id = $1 AND entry_id = $2
    `, [user.userId, entryId, entry.title.slice(0, 400), content]);
  });
  res.json({
    entryId,
    authorHandle: entry.authorHandle,
    title: entry.title,
    content,
    codeforcesUrl: `https://codeforces.com/blog/entry/${entryId}`,
  });
}));

socialRouter.get('/blogs/entries/:entryId/comments', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const entryId = Number(req.params.entryId);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: 'Invalid blog entry.' });
    return;
  }
  const cached = await withUserTransaction(user, async (client) => {
    const result = await client.query<{ comments: CfComment[]; fetched_at: Date }>(`
      SELECT comments, fetched_at FROM public.blog_entry_comments
      WHERE user_id = $1 AND entry_id = $2
    `, [user.userId, entryId]);
    return result.rows[0] || null;
  });
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 10 * 60_000) {
    res.json({ comments: cached.comments });
    return;
  }
  const exists = await withUserTransaction(user, async (client) => client.query(
    'SELECT 1 FROM public.blog_entries WHERE user_id = $1 AND entry_id = $2',
    [user.userId, entryId],
  ));
  if (!exists.rowCount) {
    res.status(404).json({ error: 'Blog entry not found in your watchlist.' });
    return;
  }
  const comments = await requestCodeforcesApi<CfComment[]>(
    'blogEntry.comments',
    { blogEntryId: entryId },
    undefined,
    'normal',
  );
  const sanitized = comments.slice(0, 200).map((comment) => ({
    id: comment.id,
    commentatorHandle: comment.commentatorHandle,
    creationTimeSeconds: comment.creationTimeSeconds,
    text: plainText(comment.text).slice(0, 5_000),
    parentCommentId: comment.parentCommentId,
  }));
  await withUserTransaction(user, async (client) => {
    await client.query(`
      INSERT INTO public.blog_entry_comments (user_id, entry_id, comments, fetched_at)
      VALUES ($1, $2, $3::jsonb, now())
      ON CONFLICT (user_id, entry_id) DO UPDATE SET comments = EXCLUDED.comments, fetched_at = now()
    `, [user.userId, entryId, JSON.stringify(sanitized)]);
  });
  res.json({ comments: sanitized });
}));

socialRouter.get('/notifications', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const result = await withUserTransaction(user, async (client) => client.query(`
    SELECT id, kind, title, body, href, is_read, created_at
    FROM public.social_notifications
    WHERE user_id = $1
    ORDER BY created_at DESC LIMIT 50
  `, [user.userId]));
  res.json({ notifications: result.rows });
}));

socialRouter.patch('/notifications/:id/read', route(async (req, res) => {
  const user = getSocialUser(req)!;
  const notificationId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(notificationId)) {
    res.status(400).json({ error: 'Invalid notification.' });
    return;
  }
  const result = await withUserTransaction(user, async (client) => client.query(`
    UPDATE public.social_notifications SET is_read = true
    WHERE user_id = $1 AND id = $2
  `, [user.userId, notificationId]));
  res.json({ success: true, updated: result.rowCount === 1 });
}));

export async function getStoredCodeforcesCredentials(
  client: SocialQuery,
  userId: string,
): Promise<CodeforcesCredentialPair | null> {
  const result = await client.query<{
    ciphertext: Buffer;
    nonce: Buffer;
    auth_tag: Buffer;
  }>(`
    SELECT ciphertext, nonce, auth_tag
    FROM public.codeforces_credentials WHERE user_id = $1
  `, [userId]);
  const row = result.rows[0];
  return row ? decryptCodeforcesCredentials(userId, {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
  }) : null;
}

export { addNotification };
