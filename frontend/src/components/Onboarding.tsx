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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (handle.trim()) onCreateProfile(handle.trim());
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
            Your personal competitive programming trainer. Get three daily problems based on your Codeforces weaknesses.
          </p>
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
            <label className="block text-xs font-medium text-slate-400 mb-1.5 px-1">
              Codeforces Handle
            </label>
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="e.g. tourist"
              autoFocus={profiles.length === 0}
              className="w-full px-4 py-3 rounded-xl bg-slate-900 border border-slate-800 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/20 transition-all"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-950/40 border border-red-900/40 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isCreating || !handle.trim()}
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

        <p className="text-center text-[11px] text-slate-600 leading-relaxed">
          {isPublicMode
            ? 'Your training data stays in this browser. Other browsers stay separate.'
            : 'Your training data stays on this computer.'}
          <br />
          Only the public Codeforces API is used; no passwords required.
        </p>
      </div>
    </div>
  );
};
