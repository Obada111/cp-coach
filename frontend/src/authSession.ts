import type { Session } from '@supabase/supabase-js';
import { getSupabaseAuthClient } from './socialAuthClient';

export interface ActiveAuthSession {
  userId: string;
  email: string | null;
  accessToken: string;
  expiresAt: number;
}

let activeSession: ActiveAuthSession | null = null;

function toActiveSession(session: Session | null): ActiveAuthSession | null {
  if (!session?.access_token || !session.user?.id) return null;
  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    accessToken: session.access_token,
    expiresAt: session.expires_at ?? 0,
  };
}

export function setActiveAuthSession(session: Session | null): ActiveAuthSession | null {
  activeSession = toActiveSession(session);
  return activeSession;
}

export function getActiveAuthSession(): ActiveAuthSession | null {
  return activeSession;
}

export function getAccessToken(): string | null {
  return activeSession?.accessToken || null;
}

export function getAuthHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let refreshInFlight: Promise<boolean> | null = null;

export async function refreshActiveAuthSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const client = getSupabaseAuthClient();
  if (!client) return false;
  refreshInFlight = client.auth.refreshSession()
    .then(({ data, error }) => {
      if (error || !data.session) {
        setActiveAuthSession(null);
        window.dispatchEvent(new Event('cp-coach:auth-expired'));
        return false;
      }
      setActiveAuthSession(data.session);
      return true;
    })
    .catch(() => {
      setActiveAuthSession(null);
      window.dispatchEvent(new Event('cp-coach:auth-expired'));
      return false;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export async function signOutOfCoach(): Promise<void> {
  const client = getSupabaseAuthClient();
  setActiveAuthSession(null);
  if (client) await client.auth.signOut();
}
