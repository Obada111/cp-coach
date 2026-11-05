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
  const [method, setMethod] = useState<'google' | 'password' | 'otp'>('google');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitGoogle = async () => {
    const client = getSupabaseAuthClient();
    if (!client) {
      setError('Sign-in is not configured for this deployment.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { error: oauthError } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (oauthError) throw oauthError;
    } catch (err: any) {
      setError(err?.message || 'Google sign-in could not be initiated.');
      setSubmitting(false);
    }
  };

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
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
      if (isSignUp) {
        const { data, error: signUpError } = await client.auth.signUp({
          email: cleanEmail,
          password,
        });
        if (signUpError) throw signUpError;
        if (data.session) {
          onSignedIn(data.session);
          return;
        }
        setSentTo(cleanEmail);
      } else {
        const { data, error: signInError } = await client.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (signInError) throw signInError;
        if (data.session) {
          onSignedIn(data.session);
          return;
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Authentication failed. Check your credentials.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitOtp = async (event: React.FormEvent) => {
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
                  We sent a confirmation or sign-in link to <span className="text-slate-200 font-medium">{sentTo}</span>.
                  Open it on this device to continue.
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
                Use a different email or sign-in method
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {/* 1. Google OAuth Primary Option */}
              <button
                type="button"
                onClick={submitGoogle}
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2.5 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-800 hover:border-slate-600 px-4 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                {submitting ? 'Connecting to Google...' : 'Continue with Google'}
              </button>

              <div className="relative flex items-center justify-center">
                <div className="w-full border-t border-slate-800" />
                <span className="absolute bg-slate-900 px-3 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                  Or with email
                </span>
              </div>

              {/* Method Switcher */}
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-950 p-1 border border-slate-800/80 text-xs">
                <button
                  type="button"
                  onClick={() => { setMethod('password'); setError(null); }}
                  className={`rounded-lg py-1.5 font-medium transition-colors ${
                    method === 'password' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Password
                </button>
                <button
                  type="button"
                  onClick={() => { setMethod('otp'); setError(null); }}
                  className={`rounded-lg py-1.5 font-medium transition-colors ${
                    method === 'otp' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Magic Link
                </button>
              </div>

              {/* Email Form */}
              <form onSubmit={method === 'password' ? submitPassword : submitOtp} className="space-y-3.5">
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

                {method === 'password' && (
                  <div>
                    <div className="flex items-center justify-between">
                      <label htmlFor="auth-password" className="block text-xs font-semibold text-slate-300">
                        Password
                      </label>
                      <button
                        type="button"
                        onClick={() => setIsSignUp(!isSignUp)}
                        className="text-[11px] text-cyan-400 hover:text-cyan-300"
                      >
                        {isSignUp ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
                      </button>
                    </div>
                    <div className="mt-1.5 relative">
                      <LockKeyhole className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                      <input
                        id="auth-password"
                        type="password"
                        autoComplete={isSignUp ? 'new-password' : 'current-password'}
                        required
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="••••••••"
                        className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-white placeholder-slate-600 outline-none focus:border-cyan-500/70"
                      />
                    </div>
                  </div>
                )}

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
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <LockKeyhole className="w-4 h-4" />
                  )}
                  {submitting
                    ? 'Processing...'
                    : method === 'password'
                      ? isSignUp ? 'Create account' : 'Sign in'
                      : 'Email me a sign-in link'}
                </button>
              </form>
            </div>
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
