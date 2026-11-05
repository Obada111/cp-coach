import type { Session } from '@supabase/supabase-js';

const FALLBACK_API_ORIGIN = 'https://cp-coach-api-9wk2.onrender.com';
const configuredApiOrigin = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
const isVercelHost = typeof window !== 'undefined' && /(^|\.)vercel\.app$/i.test(window.location.hostname);
const API_ORIGIN = configuredApiOrigin || (isVercelHost ? FALLBACK_API_ORIGIN : '');
const SOCIAL_API_BASE = `${API_ORIGIN}/api/social`;

export interface SocialAccount {
  profile: {
    codeforces_handle: string | null;
    handle_verified_at: string | null;
    allow_friend_requests: boolean;
    show_cp_presence: boolean;
    show_last_active: boolean;
    notify_friend_requests: boolean;
    notify_new_posts: boolean;
  };
  credentialsConfigured: boolean;
}

export interface SocialFriend {
  id: string;
  handle: string | null;
  cpCoachOnline: boolean;
  lastActiveAt: string | null;
  notifyOnOnline: boolean;
}

export interface CodeforcesFriend {
  handle: string;
  rating: number | null;
  lastOnlineTimeSeconds: number | null;
  codeforcesOnline: boolean;
  profileUrl: string;
}

export interface BlogEntry {
  entryId: number;
  author_handle: string;
  title: string;
  preview: string;
  tags: string[];
  creationTimeSeconds: number;
  is_read: boolean;
  is_saved: boolean;
  personal_note: string;
  codeforcesUrl: string;
}

export async function socialRequest<T>(
  session: Session,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.access_token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${SOCIAL_API_BASE}${path}`, {
      ...init,
      headers,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new Error('Social services could not be reached. Check the connection and try again.');
  }
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Social request failed with HTTP ${response.status}.`);
  }
  return payload as T;
}
