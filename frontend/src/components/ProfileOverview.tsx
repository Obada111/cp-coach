import React from 'react';
import { CheckCircle2, TrendingUp, Flame, AlertCircle, Clock } from 'lucide-react';
import { CFUser, SyncStatus } from '../types';
import { getRankColor, getRankBadgeBg, formatDateHebron } from '../utils';

interface ProfileOverviewProps {
  user: CFUser | null;
  syncStatus: SyncStatus;
  distinctSolvedCount: number;
  streakDays: number;
  onSync: () => void;
  isSyncing: boolean;
}

export const ProfileOverview: React.FC<ProfileOverviewProps> = ({
  user,
  syncStatus,
  distinctSolvedCount,
  streakDays,
  onSync,
  isSyncing,
}) => {
  const isStale = !syncStatus.lastSyncedAt || 
    (Date.now() - new Date(syncStatus.lastSyncedAt).getTime() > 24 * 60 * 60 * 1000);

  return (
    <div className="space-y-4">
      {/* Stale Warning Banner if applicable */}
      {isStale && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-amber-950/40 border border-amber-800/40 text-amber-200 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              {syncStatus.lastSyncedAt 
                ? `Synchronized data is older than 24 hours (Last sync: ${formatDateHebron(syncStatus.lastSyncedAt)}). Analytics are based on cached history.`
                : 'No data synchronized yet. Click "Sync Now" to fetch your Codeforces profile and problem records.'}
            </span>
          </div>
          <button
            onClick={onSync}
            disabled={isSyncing}
            className="px-2.5 py-1 rounded bg-amber-800/60 hover:bg-amber-700/80 text-white font-medium text-xs whitespace-nowrap transition-all"
          >
            {isSyncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      )}

      {/* Main KPI Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Rating Card */}
        <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Current Rating</span>
            <TrendingUp className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl sm:text-3xl font-extrabold ${getRankColor(user?.rating, user?.rank)}`}>
              {user?.rating ?? '---'}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded border capitalize ${getRankBadgeBg(user?.rating, user?.rank)}`}>
              {user?.rank ?? 'unrated'}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
            Max: <span className="font-semibold text-slate-300">{user?.maxRating ?? '---'}</span> ({user?.maxRank ?? '---'})
          </p>
        </div>

        {/* Distinct Solved Card */}
        <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Solved Problems</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-extrabold text-white">
              {distinctSolvedCount}
            </span>
            <span className="text-xs text-emerald-400 font-medium">distinct</span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
            From <span className="font-semibold text-slate-300">{syncStatus.submissionsCount}</span> synchronized attempts
          </p>
        </div>

        {/* Training Streak Card */}
        <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Training Streak</span>
            <Flame className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-extrabold text-amber-300">
              {streakDays}
            </span>
            <span className="text-xs text-amber-400/80 font-medium">days in a row</span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Hebron timezone (Asia/Hebron)
          </p>
        </div>

        {/* Sync Info Card */}
        <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Sync Status</span>
            <Clock className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex items-baseline gap-1.5 truncate">
            <span className="text-sm font-semibold text-slate-200 truncate">
              {formatDateHebron(syncStatus.lastSyncedAt)}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500 truncate">
            {syncStatus.problemsCount > 0 ? `${syncStatus.problemsCount.toLocaleString()} problems cached` : 'No problem cache'}
          </p>
        </div>
      </div>
    </div>
  );
};
