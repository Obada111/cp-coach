import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { AlertCircle, CheckCircle2, Loader2, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { getSupabaseAuthClient, isSupabaseAuthConfigured } from '../socialAuthClient';
import { setActiveAuthSession, signOutOfCoach } from '../authSession';
import { setStorageScope } from '../storageScope';
import { isPublicMode, resetPublicSessionState } from '../api';
import {
  dismissLegacyBrowserDataMigration,
  hasLegacyBrowserData,
  migrateLegacyBrowserDataToActiveAccount,
} from '../browserLocalMigration';

interface AuthContextValue {
  session: Session;
  user: User;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthGate.');
  return value;
}

type AuthStatus = 'loading' | 'signed_out' | 'signed_in' | 'unconfigured';

function applySession(
  session: Session | null,
  previousUserId: { current: string | null },
  setLegacyDecision: (value: 'pending' | 'done') => void,
): void {
  const nextUserId = session?.user?.id || null;
  if (nextUserId !== previousUserId.current) {
    setStorageScope(nextUserId);
    resetPublicSessionState();
    setLegacyDecision('pending');
    previousUserId.current = nextUserId;
  }
  setActiveAuthSession(session);
}

const AuthScreen: React.FC<{
  onSignedIn: (session: Session) => void;
  notice?: string | null;
}> = ({ onSignedIn, notice }) => {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    const client = getSupabaseAuthClient();
    if (!client) {
      setError('Sign-in is not configured for this deployment.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { data, error: otpError } = await client.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: window.location.origin,
        },
      });
      if (otpError) throw otpError;
      if (data.session) {
        onSignedIn(data.session);
        return;
      }
      setSentTo(cleanEmail);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not send the sign-in link.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-3">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center">
            <ShieldCheck className="w-7 h-7 text-cyan-300" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Codeforces Coach</h1>
            <p className="mt-2 text-sm text-slate-400">
              Sign in to keep your training plan, notes, reviews, and notifications private to your account.
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-2xl shadow-black/30">
          {notice && !sentTo && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="status">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}
          {sentTo ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto w-11 h-11 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-300" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-white">Check your email</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  We sent a secure sign-in link to <span className="text-slate-200">{sentTo}</span>.
                  Open it on this device to continue. The link can take a minute to arrive.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSentTo(null);
                  setError(null);
                }}
                className="text-xs font-medium text-cyan-300 hover:text-cyan-200"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label htmlFor="auth-email" className="block text-xs font-semibold text-slate-300">
                  Email address
                </label>
                <div className="mt-1.5 relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-white placeholder-slate-600 outline-none focus:border-cyan-500/70"
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200" role="alert">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <LockKeyhole className="w-4 h-4" />}
                {submitting ? 'Sending secure link...' : 'Email me a sign-in link'}
              </button>

              <p className="text-[11px] leading-relaxed text-slate-500">
                New here? The same button creates your account. We use passwordless email links,
                so there is no password to store or forget.
              </p>
            </form>
          )}
        </div>

        <p className="text-center text-[11px] leading-relaxed text-slate-600">
          Your browser id is no longer used as authentication. Every training API request is
          authorized by your signed-in session, and another account cannot read your data.
        </p>
      </div>
    </div>
  );
};

const LegacyDataPrompt: React.FC<{
  onImported: () => void;
}> = ({ onImported }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importData = () => {
    setBusy(true);
    setError(null);
    const result = migrateLegacyBrowserDataToActiveAccount();
    if (result.failed > 0) {
      setError('Some browser data could not be imported. Your original data was left untouched; retry after freeing browser storage.');
      setBusy(false);
      return;
    }
    onImported();
  };

  const dismiss = () => {
    dismissLegacyBrowserDataMigration();
    onImported();
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-5 space-y-4 shadow-2xl shadow-black/30">
        <div className="w-11 h-11 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
          <ShieldCheck className="w-5 h-5 text-amber-300" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Existing data found on this browser</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            This browser has CP Coach data saved from before sign-in, including local knowledge
            notes and virtual contests. Importing moves it into this signed-in account so it cannot
            leak to another account on this device.
          </p>
        </div>
        {error && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={importData}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Import into my account
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={dismiss}
            className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
};

const AuthGateInner: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<AuthStatus>(() => (
    isSupabaseAuthConfigured() ? 'loading' : 'unconfigured'
  ));
  const [session, setSession] = useState<Session | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [legacyDecision, setLegacyDecision] = useState<'pending' | 'done'>('pending');
  const previousUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!isSupabaseAuthConfigured()) {
      setStatus('unconfigured');
      return;
    }
    const client = getSupabaseAuthClient();
    if (!client) {
      setStatus('unconfigured');
      return;
    }

    let active = true;
    const apply = (nextSession: Session | null) => {
      if (!active) return;
      applySession(nextSession, previousUserId, setLegacyDecision);
      setSession(nextSession);
      setStatus(nextSession ? 'signed_in' : 'signed_out');
    };

    void client.auth.getSession()
      .then(({ data, error }) => {
        if (error) {
          setFatalError('Could not restore your sign-in session. Please sign in again.');
          apply(null);
          return;
        }
        apply(data.session);
      })
      .catch(() => {
        setFatalError('Could not restore your sign-in session. Check your connection and retry.');
        apply(null);
      });

    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      apply(nextSession);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const handleExpired = () => {
      applySession(null, previousUserId, setLegacyDecision);
      setSession(null);
      setStatus('signed_out');
      setFatalError('Your session expired. Sign in again to continue.');
    };
    window.addEventListener('cp-coach:auth-expired', handleExpired);
    return () => window.removeEventListener('cp-coach:auth-expired', handleExpired);
  }, []);

  const contextValue = useMemo<AuthContextValue | null>(() => (
    session
      ? {
          session,
          user: session.user,
          signOut: async () => {
            await signOutOfCoach();
          },
        }
      : null
  ), [session]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400">
        <div className="text-center space-y-3">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-cyan-300" />
          <p className="text-sm">Restoring your secure session...</p>
        </div>
      </div>
    );
  }

  if (status === 'unconfigured') {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5 space-y-3">
          <AlertCircle className="w-6 h-6 text-rose-300" />
          <h1 className="text-sm font-semibold text-white">Sign-in is not configured</h1>
          <p className="text-xs leading-relaxed text-slate-400">
            Set <code className="text-slate-200">VITE_SUPABASE_URL</code> and{' '}
            <code className="text-slate-200">VITE_SUPABASE_ANON_KEY</code> in the frontend build.
            The public coach will not expose training data without authentication.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <AuthScreen
        notice={fatalError}
        onSignedIn={(nextSession) => {
          applySession(nextSession, previousUserId, setLegacyDecision);
          setSession(nextSession);
          setStatus('signed_in');
        }}
      />
    );
  }

  if (legacyDecision === 'pending' && hasLegacyBrowserData()) {
    return <LegacyDataPrompt onImported={() => setLegacyDecision('done')} />;
  }

  return (
    <AuthContext.Provider value={contextValue!}>
      <React.Fragment key={session.user.id}>{children}</React.Fragment>
    </AuthContext.Provider>
  );
};

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  if (!isPublicMode) return <>{children}</>;
  return <AuthGateInner>{children}</AuthGateInner>;
};
