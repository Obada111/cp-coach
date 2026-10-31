import React, { useState } from 'react';
import { UserPlus, ArrowRight, Loader2, AlertCircle, Sparkles, Users } from 'lucide-react';
import { UserProfile } from '../types';
import { isPublicMode } from '../api';

interface OnboardingProps {
  profiles: UserProfile[];
  onSelectProfile: (profileId: string) => void;
  onCreateProfile: (handle: string) => Promise<void>;
  isCreating: boolean;
  error: string | null;
}

export const Onboarding: React.FC<OnboardingProps> = ({
  profiles,
  onSelectProfile,
  onCreateProfile,
  isCreating,
  error,
}) => {
  const [handle, setHandle] = useState('');
  const cleanHandle = handle.trim();
  const validHandleShape = /^[A-Za-z0-9_.-]{2,64}$/.test(cleanHandle);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validHandleShape) onCreateProfile(cleanHandle);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#0c0f1a]">
      <div className="w-full max-w-md space-y-8">
        {/* Logo / Welcome */}
        <div className="text-center space-y-3">
          <div className="inline-flex p-3 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/20">
            <Sparkles className="w-8 h-8 text-cyan-400" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">CP Coach</h1>
          <p className="text-sm text-slate-400 max-w-xs mx-auto leading-relaxed">
            A personal competitive-programming coach that uses your public Codeforces history and your feedback to choose what to practice next.
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-xs text-slate-300 space-y-2">
          <p className="font-semibold text-white">Your daily set has three goals</p>
          <ul className="space-y-1.5 text-slate-400">
            <li><span className="text-rose-300 font-medium">Weakness drill:</span> practice a topic where your available evidence shows difficulty.</li>
            <li><span className="text-amber-300 font-medium">Reinforcement:</span> keep a familiar skill active.</li>
            <li><span className="text-violet-300 font-medium">Challenge:</span> stretch toward a harder problem.</li>
          </ul>
          <p className="text-slate-500">No Codeforces account access or password is needed—only your public handle.</p>
        </div>

        {/* Existing Profiles */}
        {profiles.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 uppercase tracking-wider px-1">
              <Users className="w-3.5 h-3.5" />
              <span>{isPublicMode ? 'Select a saved handle' : 'Select a profile'}</span>
            </div>
            <div className="space-y-2">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSelectProfile(p.id)}
                  className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-slate-600 hover:bg-slate-800/80 transition-all text-left group"
                >
                  {p.avatar ? (
                    <img src={p.avatar} alt="" className="w-10 h-10 rounded-full border border-slate-700" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-900 to-blue-900 flex items-center justify-center text-sm font-bold text-cyan-300 border border-slate-700">
                      {p.handle[0].toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white truncate">{p.handle}</div>
                    <div className="text-xs text-slate-500">
                      {p.rating ? `Rating ${p.rating}` : 'Not synced yet'}
                      {p.rank ? ` · ${p.rank}` : ''}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-600 group-hover:text-cyan-400 transition-colors" />
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 py-2">
              <div className="flex-1 h-px bg-slate-800" />
              <span className="text-xs text-slate-600">or add new</span>
              <div className="flex-1 h-px bg-slate-800" />
            </div>
          </div>
        )}

        {/* New Profile Form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="codeforces-handle" className="block text-xs font-medium text-slate-400 mb-1.5 px-1">
              Codeforces Handle
            </label>
            <input
              id="codeforces-handle"
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="e.g. tourist"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={Boolean(error) || (cleanHandle.length > 0 && !validHandleShape)}
              aria-describedby={`handle-help${error ? ' handle-error' : ''}`}
              autoFocus={profiles.length === 0}
              className="w-full px-4 py-3 rounded-xl bg-slate-900 border border-slate-800 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/20 transition-all"
            />
            <p id="handle-help" className="mt-1.5 px-1 text-[11px] text-slate-500">
              We check it with Codeforces’ public API. Letters, numbers, dots, underscores, and hyphens; 2–64 characters.
            </p>
            {cleanHandle.length > 0 && !validHandleShape && (
              <p className="mt-1 px-1 text-[11px] text-amber-300">Enter a handle using 2–64 letters, numbers, dots, underscores, or hyphens.</p>
            )}
          </div>

          {error && (
            <div id="handle-error" role="alert" aria-live="polite" className="flex items-start gap-2 p-3 rounded-lg bg-red-950/40 border border-red-900/40 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isCreating || !validHandleShape}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-sm font-semibold transition-all"
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Checking handle on Codeforces...</span>
              </>
            ) : (
              <>
                <UserPlus className="w-4 h-4" />
                <span>{profiles.length > 0 ? 'Add Profile' : 'Get Started'}</span>
              </>
            )}
          </button>
        </form>

        <div className="text-center text-[11px] text-slate-500 leading-relaxed space-y-1">
          <p>
            {isPublicMode
              ? 'Your learning history is saved in this browser and a temporary service cache. It does not sync to other devices.'
              : 'Your training data stays on this computer.'}
          </p>
          <p>Clearing browser data can erase your notes and feedback. Export a backup in Settings before clearing it.</p>
          <p>No account or password is required. Browser separation is for convenience, not account-level security.</p>
        </div>
      </div>
    </div>
  );
};
