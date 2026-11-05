import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Database, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from './AuthGate';
import { claimLegacyProfile, getOrCreateClientId, type LegacyClaimResult } from '../api';
import { findLegacyBrowserKeys, migrateLegacyBrowserDataToActiveAccount } from '../browserLocalMigration';

type ClaimPhase = 'idle' | 'previewing' | 'claiming';

export const AccountSecurityPanel: React.FC = () => {
  const { user, signOut } = useAuth();
  const [handle, setHandle] = useState('');
  const [legacyOwnerId, setLegacyOwnerId] = useState(() => getOrCreateClientId());
  const [claimSecret, setClaimSecret] = useState('');
  const [phase, setPhase] = useState<ClaimPhase>('idle');
  const [result, setResult] = useState<LegacyClaimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [legacyBrowserCount, setLegacyBrowserCount] = useState(() => findLegacyBrowserKeys().length);
  const [browserImportMessage, setBrowserImportMessage] = useState<string | null>(null);

  const runClaim = async (dryRun: boolean) => {
    if (!handle.trim()) {
      setError('Enter the Codeforces handle of the old profile.');
      return;
    }
    setPhase(dryRun ? 'previewing' : 'claiming');
    setError(null);
    setResult(null);
    try {
      const claim = await claimLegacyProfile({
        handle: handle.trim(),
        legacyOwnerId: legacyOwnerId.trim() || undefined,
        claimSecret: claimSecret.trim() || undefined,
        dryRun,
      });
      setResult(claim);
      if (!dryRun) {
        window.setTimeout(() => window.location.reload(), 900);
      }
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : 'Could not claim the legacy profile.');
    } finally {
      setPhase('idle');
    }
  };

  return (
    <section className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4" aria-labelledby="account-security-title">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h3 id="account-security-title" className="text-xs font-semibold text-slate-200 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan-400" />
            Account & security
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Signed in as <span className="text-slate-200">{user.email || user.id}</span>. Your training
            API requests are authorized with this session only.
          </p>
        </div>
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void signOut().finally(() => setSigningOut(false));
          }}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-60"
        >
          {signingOut ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
          Sign out
        </button>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-3">
        <div>
          <h4 className="text-xs font-semibold text-slate-300 flex items-center gap-2">
            <Database className="w-3.5 h-3.5 text-amber-300" />
            Import training data from the old browser setup
          </h4>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            Use this only for a profile that belongs to you. A dry run shows exactly what would move.
            Profiles already owned by another account are never reassigned without the administrator
            migration secret.
          </p>
        </div>

        {legacyBrowserCount > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
            <p className="text-[11px] text-amber-200">
              This browser still has {legacyBrowserCount} unscoped data item{legacyBrowserCount === 1 ? '' : 's'} from the previous setup.
            </p>
            <button
              type="button"
              onClick={() => {
                const outcome = migrateLegacyBrowserDataToActiveAccount();
                setLegacyBrowserCount(findLegacyBrowserKeys().length);
                setBrowserImportMessage(
                  `Moved ${outcome.moved}, skipped ${outcome.skipped}, failed ${outcome.failed}.`,
                );
                if (outcome.moved > 0) {
                  window.setTimeout(() => window.location.reload(), 700);
                }
              }}
              className="shrink-0 rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/10"
            >
              Move into this account
            </button>
          </div>
        )}
        {browserImportMessage && (
          <p className="text-[11px] text-emerald-200">{browserImportMessage}</p>
        )}

        <div className="grid grid-cols-1 gap-2">
          <label className="text-[11px] text-slate-400">
            Codeforces handle or legacy profile id
            <input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="Obadajo"
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white placeholder-slate-600 outline-none focus:border-cyan-500/60"
            />
          </label>
          <label className="text-[11px] text-slate-400">
            Legacy browser id (pre-filled from this browser)
            <input
              value={legacyOwnerId}
              onChange={(event) => setLegacyOwnerId(event.target.value)}
              placeholder="Optional unless the old profile was created in public browser mode"
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[11px] text-slate-300 placeholder-slate-600 outline-none focus:border-cyan-500/60"
            />
          </label>
          <label className="text-[11px] text-slate-400">
            Migration secret (only if provided by the administrator)
            <input
              type="password"
              value={claimSecret}
              onChange={(event) => setClaimSecret(event.target.value)}
              autoComplete="off"
              placeholder="Optional when your Codeforces handle is already verified"
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white placeholder-slate-600 outline-none focus:border-cyan-500/60"
            />
          </label>
        </div>

        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200" role="alert">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </p>
        )}

        {result && (
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200 space-y-1">
            <p className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {result.message}
            </p>
            <p className="text-emerald-300/80">
              Profile: {result.profile.handle} | Daily sets: {result.migratedCounts.daily_sets ?? 0} |
              Learning events: {result.migratedCounts.problem_learning_events ?? 0}
            </p>
            {result.warnings.map((warning) => (
              <p key={warning} className="text-amber-200/90">{warning}</p>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={phase !== 'idle'}
            onClick={() => void runClaim(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60"
          >
            {phase === 'previewing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Preview claim
          </button>
          <button
            type="button"
            disabled={phase !== 'idle'}
            onClick={() => void runClaim(false)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-500"
          >
            {phase === 'claiming' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Claim profile
          </button>
        </div>
      </div>
    </section>
  );
};
