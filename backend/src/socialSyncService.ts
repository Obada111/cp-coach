import { requestCodeforcesApi } from './codeforcesApi.js';
import { decryptCodeforcesCredentials } from './codeforcesCredentials.js';
import {
  isSocialDatabaseConfigured,
  withSystemTransaction,
  type SocialQuery,
} from './socialDatabase.js';
import { isSocialCacheStale } from './socialState.js';

interface EncryptedCredentials {
  user_id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
}

interface CodeforcesUserInfo {
  handle: string;
  rating?: number;
  lastOnlineTimeSeconds?: number;
}

interface CodeforcesBlogEntry {
  id: number;
  authorHandle: string;
  title: string;
  creationTimeSeconds: number;
  tags?: string[];
  content?: string;
}

interface CodeforcesRecentAction {
  timeSeconds: number;
  blogEntry?: CodeforcesBlogEntry;
}

interface DueBlogRefresh {
  user_id: string;
  notify_new_posts: boolean;
  bloggers: Array<{ handle: string; created_at: Date }>;
}

export function selectRecentFollowedEntries(
  actions: readonly CodeforcesRecentAction[],
  bloggers: readonly { handle: string; created_at: Date }[],
): CodeforcesBlogEntry[] {
  const followedAt = new Map<string, number>();
  for (const blogger of bloggers) {
    const followedTime = Math.floor(new Date(blogger.created_at).getTime() / 1_000);
    if (Number.isFinite(followedTime)) followedAt.set(blogger.handle.toLowerCase(), followedTime);
  }
  const entries = new Map<number, CodeforcesBlogEntry>();
  for (const action of actions) {
    const entry = action.blogEntry;
    if (
      !entry ||
      !Number.isSafeInteger(entry.id) ||
      entry.id <= 0 ||
      !Number.isFinite(entry.creationTimeSeconds) ||
      typeof entry.authorHandle !== 'string'
    ) continue;
    const followedTime = followedAt.get(entry.authorHandle.toLowerCase());
    if (followedTime === undefined || entry.creationTimeSeconds < followedTime) continue;
    entries.set(entry.id, entry);
  }
  return Array.from(entries.values());
}

const REFRESH_INTERVAL = "interval '5 minutes'";
const WORKER_INTERVAL_MS = 60_000;
let workerInterval: NodeJS.Timeout | null = null;
let initialRunTimeout: NodeJS.Timeout | null = null;
let inFlightRun: Promise<void> | null = null;
let recentActionsCache: { value: CodeforcesRecentAction[]; fetchedAt: number } | null = null;
let recentActionsInFlight: Promise<CodeforcesRecentAction[]> | null = null;

async function claimFriendRefresh(): Promise<EncryptedCredentials | null> {
  return withSystemTransaction(async (client) => {
    const result = await client.query<EncryptedCredentials>(`
      SELECT s.user_id, c.ciphertext, c.nonce, c.auth_tag
      FROM public.social_sync_state s
      JOIN public.codeforces_credentials c ON c.user_id = s.user_id
      JOIN public.social_profiles p ON p.user_id = s.user_id
      WHERE s.next_friends_refresh_at IS NOT NULL
        AND s.next_friends_refresh_at <= now()
        AND p.handle_verified_at IS NOT NULL
      ORDER BY s.next_friends_refresh_at
      FOR UPDATE OF s SKIP LOCKED
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return null;
    await client.query(`
      UPDATE public.social_sync_state
      SET next_friends_refresh_at = now() + ${REFRESH_INTERVAL}, updated_at = now()
      WHERE user_id = $1
    `, [row.user_id]);
    return row;
  });
}

async function refreshCodeforcesFriends(row: EncryptedCredentials): Promise<void> {
  const credentials = decryptCodeforcesCredentials(row.user_id, {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
  });
  const [allHandles, onlineHandles] = await Promise.all([
    requestCodeforcesApi<string[]>('user.friends', { onlyOnline: false }, credentials, 'background'),
    requestCodeforcesApi<string[]>('user.friends', { onlyOnline: true }, credentials, 'background'),
  ]);
  const handlesByLower = new Map<string, string>();
  for (const handle of [...allHandles, ...onlineHandles]) {
    if (typeof handle === 'string' && /^[A-Za-z0-9_.-]{2,64}$/.test(handle)) {
      handlesByLower.set(handle.toLowerCase(), handle);
    }
  }
  const handles = Array.from(handlesByLower.values()).slice(0, 10_000);
  const onlineSet = new Set(onlineHandles.map((handle) => handle.toLowerCase()));
  const usersByLower = new Map<string, CodeforcesUserInfo>();

  for (let offset = 0; offset < handles.length; offset += 100) {
    const batch = handles.slice(offset, offset + 100);
    if (batch.length === 0) continue;
    const users = await requestCodeforcesApi<CodeforcesUserInfo[]>('user.info', {
      handles: batch.join(';'),
      checkHistoricHandles: false,
    }, undefined, 'background');
    for (const user of users) usersByLower.set(user.handle.toLowerCase(), user);
  }

  await withSystemTransaction(async (client) => {
    if (handles.length === 0) {
      await client.query('DELETE FROM public.codeforces_friends_cache WHERE user_id = $1', [row.user_id]);
    } else {
      await client.query(`
        DELETE FROM public.codeforces_friends_cache
        WHERE user_id = $1 AND NOT (friend_handle = ANY($2::text[]))
      `, [row.user_id, handles]);
      for (const handle of handles) {
        const info = usersByLower.get(handle.toLowerCase());
        await client.query(`
          INSERT INTO public.codeforces_friends_cache
            (user_id, friend_handle, rating, last_online_time_seconds, is_online, refreshed_at)
          VALUES ($1, $2, $3, $4, $5, now())
          ON CONFLICT (user_id, friend_handle) DO UPDATE SET
            rating = COALESCE(EXCLUDED.rating, public.codeforces_friends_cache.rating),
            last_online_time_seconds = COALESCE(
              EXCLUDED.last_online_time_seconds,
              public.codeforces_friends_cache.last_online_time_seconds
            ),
            is_online = EXCLUDED.is_online,
            refreshed_at = now()
        `, [
          row.user_id,
          handle,
          info?.rating ?? null,
          info?.lastOnlineTimeSeconds ?? null,
          onlineSet.has(handle.toLowerCase()),
        ]);
      }
    }
    await client.query(`
      UPDATE public.social_sync_state
      SET friends_refreshed_at = now(), last_error_code = NULL, updated_at = now()
      WHERE user_id = $1
    `, [row.user_id]);
  });
}

async function claimBlogRefresh(): Promise<DueBlogRefresh | null> {
  return withSystemTransaction(async (client) => {
    const result = await client.query<{ user_id: string; notify_new_posts: boolean }>(`
      SELECT s.user_id, p.notify_new_posts
      FROM public.social_sync_state s
      JOIN public.social_profiles p ON p.user_id = s.user_id
      WHERE s.next_blogs_refresh_at IS NOT NULL
        AND s.next_blogs_refresh_at <= now()
        AND EXISTS (SELECT 1 FROM public.blog_watchlist w WHERE w.user_id = s.user_id)
      ORDER BY s.next_blogs_refresh_at
      FOR UPDATE OF s SKIP LOCKED
      LIMIT 1
    `);
    const user = result.rows[0];
    if (!user) return null;
    const bloggers = await client.query<{ handle: string; created_at: Date }>(`
      SELECT handle, created_at FROM public.blog_watchlist WHERE user_id = $1
    `, [user.user_id]);
    await client.query(`
      UPDATE public.social_sync_state
      SET next_blogs_refresh_at = now() + ${REFRESH_INTERVAL}, updated_at = now()
      WHERE user_id = $1
    `, [user.user_id]);
    return { ...user, bloggers: bloggers.rows };
  });
}

async function getRecentActions(): Promise<CodeforcesRecentAction[]> {
  if (recentActionsCache && !isSocialCacheStale(recentActionsCache.fetchedAt, 5 * 60_000)) {
    return recentActionsCache.value;
  }
  if (!recentActionsInFlight) {
    recentActionsInFlight = requestCodeforcesApi<CodeforcesRecentAction[]>(
      'recentActions',
      { maxCount: 100 },
      undefined,
      'background',
    ).then((actions) => {
      recentActionsCache = { value: actions, fetchedAt: Date.now() };
      return actions;
    }).finally(() => {
      recentActionsInFlight = null;
    });
  }
  return recentActionsInFlight;
}

function plainPreview(content: string): string {
  return content.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/[ \t\r\n]+/g, ' ').trim().slice(0, 500);
}

async function syncRecentBlogs(due: DueBlogRefresh): Promise<void> {
  const actions = await getRecentActions();
  const entries = selectRecentFollowedEntries(actions, due.bloggers);

  await withSystemTransaction(async (client) => {
    for (const entry of entries) {
      const inserted = await client.query(`
        INSERT INTO public.blog_entries
          (user_id, entry_id, author_handle, title, preview, tags, creation_time_seconds)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, entry_id) DO NOTHING
        RETURNING entry_id
      `, [
        due.user_id,
        entry.id,
        entry.authorHandle,
        entry.title.slice(0, 400),
        plainPreview(entry.content || ''),
        Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string').slice(0, 32) : [],
        entry.creationTimeSeconds,
      ]);
      if (inserted.rowCount && due.notify_new_posts) {
        await client.query(`
          INSERT INTO public.social_notifications (user_id, event_key, kind, title, body, href)
          VALUES ($1, $2, 'new_blog_post', $3, $4, $5)
          ON CONFLICT (user_id, event_key) DO NOTHING
        `, [
          due.user_id,
          `blog-post:${entry.id}`,
          'New Codeforces blog post',
          `${entry.authorHandle}: ${entry.title.slice(0, 300)}`,
          `https://codeforces.com/blog/entry/${entry.id}`,
        ]);
      }
    }
    await client.query(`
      UPDATE public.social_sync_state
      SET blogs_refreshed_at = now(), last_error_code = NULL, updated_at = now()
      WHERE user_id = $1
    `, [due.user_id]);
  });
}

async function setRefreshError(userId: string, kind: 'friends' | 'blogs'): Promise<void> {
  await withSystemTransaction(async (client) => {
    await client.query(`
      UPDATE public.social_sync_state
      SET ${kind === 'friends' ? 'next_friends_refresh_at' : 'next_blogs_refresh_at'} =
            now() + ${REFRESH_INTERVAL},
          last_error_code = $2,
          updated_at = now()
      WHERE user_id = $1
    `, [userId, `${kind}_refresh_failed`]);
  });
}

export class SocialSyncService {
  startBackgroundWorker(intervalMs = WORKER_INTERVAL_MS): void {
    if (workerInterval || !isSocialDatabaseConfigured()) return;
    workerInterval = setInterval(() => {
      this.runScheduledPass();
    }, intervalMs);
    workerInterval.unref();
    initialRunTimeout = setTimeout(() => {
      initialRunTimeout = null;
      this.runScheduledPass();
    }, 5_000);
    initialRunTimeout.unref();
  }

  async runOnce(): Promise<void> {
    if (inFlightRun || !isSocialDatabaseConfigured()) return;
    const run = this.processDueRefreshes();
    inFlightRun = run;
    try {
      await run;
    } finally {
      if (inFlightRun === run) inFlightRun = null;
    }
  }

  async shutdown(): Promise<void> {
    if (workerInterval) clearInterval(workerInterval);
    workerInterval = null;
    if (initialRunTimeout) clearTimeout(initialRunTimeout);
    initialRunTimeout = null;
    await inFlightRun;
  }

  private runScheduledPass(): void {
    void this.runOnce().catch((error: unknown) => {
      console.error('[SocialSync] Background run failed:', error instanceof Error ? error.name : 'UnknownError');
    });
  }

  private async processDueRefreshes(): Promise<void> {
    for (let processed = 0; processed < 4; processed += 1) {
      const friend = await claimFriendRefresh();
      const blog = await claimBlogRefresh();
      if (!friend && !blog) return;
      if (friend) {
        try {
          await refreshCodeforcesFriends(friend);
        } catch (error) {
          await setRefreshError(friend.user_id, 'friends');
          console.warn('[SocialSync] Codeforces friend refresh failed:', error instanceof Error ? error.name : 'UnknownError');
        }
      }
      if (blog) {
        try {
          await syncRecentBlogs(blog);
        } catch (error) {
          await setRefreshError(blog.user_id, 'blogs');
          console.warn('[SocialSync] Blog watchlist refresh failed:', error instanceof Error ? error.name : 'UnknownError');
        }
      }
    }
  }
}

export const socialSyncService = new SocialSyncService();

export async function insertSocialNotification(
  client: SocialQuery,
  userId: string,
  eventKey: string,
  title: string,
  body: string,
): Promise<void> {
  await client.query(`
    INSERT INTO public.social_notifications (user_id, event_key, kind, title, body)
    VALUES ($1, $2, 'friend_activity', $3, $4)
    ON CONFLICT (user_id, event_key) DO NOTHING
  `, [userId, eventKey, title, body]);
}
