import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  fetchDashboard, fetchProfiles, createProfile as apiCreateProfile,
  selectProfile as apiSelectProfile, triggerSync, submitProblemFeedback, fetchHistory,
  fetchProblemJournal, replaceDailyProblem, enqueueReview, fetchReviewQueue, fetchWeeklyGoals, openProblem,
  isPublicMode, getPublicHandle, restorePublicContext, capturePublicContext, serverRestarted,
} from './api';
import { 
  DashboardOverview, 
  FeedbackPayload, 
  DailySet, 
  UserProfile, 
  ReviewQueueItem, 
  WeeklyGoal, 
  DailyProblem, ProblemLearningEvent
} from './types';
import { Onboarding } from './components/Onboarding';
import { ProblemCard } from './components/ProblemCard';
import { RatingChart } from './components/RatingChart';
import { TopicList } from './components/TopicList';
import { HistoryList } from './components/HistoryList';
import { ProblemJournalList } from './components/ProblemJournalList';
import { ContestsView } from './components/ContestsView';
import { SkillTracksView } from './components/SkillTracksView';
import { ReviewQueueCard } from './components/ReviewQueueCard';
import { SolveSessionModal } from './components/SolveSessionModal';
import { getRankColor, formatDateHebron, formatRelativeTimeAgo } from './utils';
import {
  RefreshCw, ChevronDown, Flame, TrendingUp, CheckCircle2,
  Calendar, Layers, Settings, Loader2, AlertCircle, UserPlus, Sparkles, Trophy,
  BrainCircuit, ClipboardList, AlertTriangle, Clock, Compass, RotateCcw, Target
} from 'lucide-react';

type Tab = 'home' | 'skill-tracks' | 'reviews' | 'contests' | 'topics' | 'history' | 'settings';

export const App: React.FC = () => {
  // ─── State ───
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [history, setHistory] = useState<DailySet[]>([]);
  const [journal, setJournal] = useState<ProblemLearningEvent[]>([]);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [settingsHandle, setSettingsHandle] = useState('');
  const [settingsCreating, setSettingsCreating] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [showWeeklyReview, setShowWeeklyReview] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const dataRef = useRef<DashboardOverview | null>(null);

  // New Training Plan & Metacognitive states
  const [dueReviews, setDueReviews] = useState<ReviewQueueItem[]>([]);
  const [reviewSummary, setReviewSummary] = useState<any>(null);
  const [weeklyGoal, setWeeklyGoal] = useState<WeeklyGoal | null>(null);
  const [activeSolveProblem, setActiveSolveProblem] = useState<DailyProblem | null>(null);

  // ─── Load data ───
  const loadAll = useCallback(async (profileId?: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const publicHandle = isPublicMode ? getPublicHandle() : null;
      if (publicHandle && await serverRestarted()) {
        const restore = await restorePublicContext(publicHandle);
        if (restore.failed) {
          throw new Error(
            'The backend restarted and this browser\'s saved data could not be restored yet. Your local data is safe; retry in a moment.'
          );
        }
      }
      const dashboard = await fetchDashboard(profileId);
      dataRef.current = dashboard;
      setData(dashboard);
      if (!isPublicMode && dashboard.availableProfiles?.length) {
        setProfiles(dashboard.availableProfiles);
      }
      const hist = await fetchHistory(dashboard.activeProfile.id, 30);
      setHistory(hist);
      try {
        setJournal(await fetchProblemJournal(dashboard.activeProfile.id, 100));
      } catch {
        setJournal([]);
      }
      try {
        const rev = await fetchReviewQueue(dashboard.activeProfile.id);
        setDueReviews(rev.dueReviews || []);
        setReviewSummary(rev.summary || null);
      } catch {}
      try {
        const wg = await fetchWeeklyGoals(dashboard.activeProfile.id);
        setWeeklyGoal(wg);
      } catch {}
      setLastRefreshedAt(new Date().toISOString());
      setRefreshNotice(null);
      if (isPublicMode) {
        void capturePublicContext(dashboard.activeProfile.handle);
      }
    } catch (err: any) {
      const message = err.message || 'Cannot connect to backend';
      if (silent && dataRef.current) {
        setRefreshNotice(message);
      } else {
        setError(message);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // On mount: restore this browser's handles and personal context.
    let cancelled = false;
    (async () => {
      try {
        const { profiles: p, activeProfileId: aId } = await fetchProfiles();
        if (cancelled) return;
        if (p.length === 0) {
          setShowOnboarding(true);
          setProfiles([]);
          setLoading(false);
          return;
        }

        setProfiles(p);
        let target = p.find((profile) => profile.id === aId) || p[0];
        if (isPublicMode) {
          const preferred = getPublicHandle();
          target = p.find(
            (profile) => profile.handle.toLowerCase() === preferred?.toLowerCase()
          ) || target;
          await serverRestarted();
          await restorePublicContext(target.handle);
        } else {
          target = p.find((profile) => profile.handle.toLowerCase() === 'obadajo') || target;
        }

        if (!cancelled) await loadAll(target.id);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Cannot connect to backend.');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  useEffect(() => {
    const profileId = data?.activeProfile.id;
    if (!profileId) return;

    let disposed = false;
    let inFlight = false;
    let lastRun = Date.now();
    const REFRESH_MS = 120_000;

    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        await loadAll(profileId, { silent: true });
        lastRun = Date.now();
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(refresh, REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRun >= REFRESH_MS) {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [data?.activeProfile.id, loadAll]);

  // ─── Handlers ───
  const handleCreateProfile = async (handle: string) => {
    setCreatingProfile(true);
    setCreateError(null);
    try {
      const created = await apiCreateProfile(handle);
      setProfiles((current) => (
        current.some((profile) => profile.id === created.profile.id)
          ? current
          : [...current, created.profile]
      ));
      setShowOnboarding(false);
      await loadAll();
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreatingProfile(false);
    }
  };

  const handleSelectProfile = async (id: string) => {
    setProfileMenuOpen(false);
    try {
      await apiSelectProfile(id);
      await loadAll(id);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSync = async () => {
    if (syncing || !data) return;
    setSyncing(true);
    try {
      await triggerSync(data.activeProfile.id);
      await loadAll(data.activeProfile.id);
    } catch (err: any) {
      console.error(err);
    } finally {
      setSyncing(false);
    }
  };

  const handleFeedback = async (problemId: string, payload: FeedbackPayload) => {
    await submitProblemFeedback(problemId, payload);
    if (data) {
      await loadAll(data.activeProfile.id, { silent: true });
    }
  };

  const handleOpenProblem = async (dailyProblemId: string) => {
    await openProblem(dailyProblemId);
    const openedAt = new Date().toISOString();
    setData((current) => {
      if (!current?.todaySet) return current;
      return {
        ...current,
        todaySet: {
          ...current.todaySet,
          problems: current.todaySet.problems.map((problem) => (
            problem.id === dailyProblemId
              ? { ...problem, isOpened: true, openedAt }
              : problem
          )),
        },
      };
    });
  };

  const handleReplaceProblem = async (dailyProblemId: string) => {
    if (!data) return;
    try {
      await replaceDailyProblem(dailyProblemId, data.activeProfile.id);
      await loadAll(data.activeProfile.id);
    } catch (err: any) {
      alert(`Could not replace problem: ${err.message}`);
    }
  };

  const handleSendToReview = async (problemId: string) => {
    if (!data) return;
    try {
      await enqueueReview(problemId, 'Enqueued from daily practice', 'MANUAL', data.activeProfile.id);
      const rev = await fetchReviewQueue(data.activeProfile.id);
      setDueReviews(rev.dueReviews || []);
      setReviewSummary(rev.summary || null);
    } catch (err: any) {
      alert(`Could not enqueue to spaced repetition: ${err.message}`);
    }
  };

  const handleSettingsAddProfile = async () => {
    if (!settingsHandle.trim()) return;
    setSettingsCreating(true);
    setSettingsMsg(null);
    try {
      const created = await apiCreateProfile(settingsHandle.trim());
      setProfiles((current) => (
        current.some((profile) => profile.id === created.profile.id)
          ? current
          : [...current, created.profile]
      ));
      setSettingsMsg(`Profile '${settingsHandle.trim()}' added!`);
      setSettingsHandle('');
      await loadAll(isPublicMode ? undefined : data?.activeProfile.id);
    } catch (err: any) {
      setSettingsMsg(`Error: ${err.message}`);
    } finally {
      setSettingsCreating(false);
    }
  };

  // ─── Onboarding ───
  if (showOnboarding || (!loading && !data && !error)) {
    return (
      <Onboarding
        profiles={profiles}
        onSelectProfile={(id) => { setShowOnboarding(false); handleSelectProfile(id); }}
        onCreateProfile={handleCreateProfile}
        isCreating={creatingProfile}
        error={createError}
      />
    );
  }

  // ─── Loading ───
  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mx-auto" />
          <p className="text-sm text-slate-400">Loading your training data...</p>
        </div>
      </div>
    );
  }

  // ─── Error ───
  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center max-w-sm space-y-4">
          <AlertCircle className="w-10 h-10 text-rose-500 mx-auto" />
          <p className="text-sm text-slate-300">{error}</p>
          <button onClick={() => loadAll()} className="px-4 py-2 rounded-lg bg-cyan-600 text-white text-xs font-semibold">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const user = data.user;
  const todaySet = data.todaySet;
  const { completed: doneCount, total: totalProbs } = todaySet?.completionProgress || { completed: 0, total: 0 };

  // ─── Render ───
  return (
    <div className="min-h-screen flex flex-col">
      {/* ═══ Top Bar ═══ */}
      <header className="sticky top-0 z-50 bg-[#0c0f1a]/90 backdrop-blur-lg border-b border-slate-800/60">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          {/* Left: logo + profile switcher */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-extrabold text-white tracking-tight flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-cyan-400" />
                CP Coach
              </span>
              <span className="text-[10px] font-mono font-bold text-cyan-300 bg-cyan-950/80 border border-cyan-800/60 px-2 py-0.5 rounded-full">
                {isPublicMode ? 'public' : 'local'}
              </span>
            </div>

            {/* Profile Button */}
            <div className="relative">
              <button
                onClick={() => setProfileMenuOpen(!profileMenuOpen)}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-600 transition-all text-xs"
              >
                {data.activeProfile.avatar ? (
                  <img src={data.activeProfile.avatar} alt="" className="w-5 h-5 rounded-full" />
                ) : (
                  <div className="w-5 h-5 rounded-full bg-cyan-900 flex items-center justify-center text-[10px] font-bold text-cyan-300">
                    {data.activeProfile.handle[0]}
                  </div>
                )}
                <span className={`font-semibold ${getRankColor(user?.rating, user?.rank)}`}>
                  {data.activeProfile.handle}
                </span>
                <ChevronDown className="w-3 h-3 text-slate-500" />
              </button>

              {/* Profile Dropdown */}
              {profileMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setProfileMenuOpen(false)} />
                  <div className="absolute top-full left-0 mt-1 w-56 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 py-1 overflow-hidden">
                    {profiles.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => handleSelectProfile(p.id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-xs hover:bg-slate-800 transition-colors ${p.id === data.activeProfile.id ? 'bg-slate-800/60' : ''
                          }`}
                      >
                        {p.avatar ? (
                          <img src={p.avatar} alt="" className="w-6 h-6 rounded-full" />
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-400">
                            {p.handle[0]}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-white truncate">{p.handle}</div>
                          <div className="text-[10px] text-slate-500">{p.rating || 'Unrated'}</div>
                        </div>
                        {p.id === data.activeProfile.id && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        )}
                      </button>
                    ))}
                    <div className="border-t border-slate-800 mt-1 pt-1">
                      <button
                        onClick={() => { setProfileMenuOpen(false); setShowOnboarding(true); }}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        Add profile
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Right: streak + last updated + sync */}
          <div className="flex items-center gap-2.5">
            {data.streakDays > 0 && (
              <div className="flex items-center gap-1 text-xs font-semibold text-amber-400">
                <Flame className="w-3.5 h-3.5" />
                <span>{data.streakDays}d</span>
              </div>
            )}
            {(lastRefreshedAt || data.syncStatus.lastSyncedAt) && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-slate-500 font-mono whitespace-nowrap"
                title={`Last successful update: ${formatDateHebron(lastRefreshedAt || data.syncStatus.lastSyncedAt)}`}
              >
                <Clock className="w-3 h-3 text-slate-600" />
                <span className="hidden sm:inline">Updated&nbsp;</span>
                {formatRelativeTimeAgo(lastRefreshedAt || data.syncStatus.lastSyncedAt)}
              </span>
            )}
            <button
              onClick={handleSync}
              disabled={syncing}
              title={`Last synchronized: ${formatDateHebron(data.syncStatus.lastSyncedAt)} (Click to refresh now)`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-600 text-xs text-slate-300 hover:text-white transition-all shadow-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin text-cyan-400' : 'text-cyan-400'}`} />
              <span className="hidden sm:inline font-medium">{syncing ? 'Refreshing...' : 'Refresh'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* ═══ Tab Navigation ═══ */}
      <nav className="border-b border-slate-800/40 bg-[#0c0f1a]/60 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 flex gap-1 overflow-x-auto no-scrollbar">
          {([
            { key: 'home' as const, icon: Sparkles, label: 'Training Plan' },
            { key: 'skill-tracks' as const, icon: Compass, label: 'Mastery Map' },
            { key: 'reviews' as const, icon: RotateCcw, label: `Reviews ${dueReviews.length > 0 ? `(${dueReviews.length})` : ''}` },
            { key: 'contests' as const, icon: Trophy, label: 'Contests' },
            { key: 'topics' as const, icon: Layers, label: 'Topics' },
            { key: 'history' as const, icon: Calendar, label: 'History' },
            { key: 'settings' as const, icon: Settings, label: 'Settings' },
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${tab === t.key
                  ? 'border-cyan-500 text-white font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* ═══ Content ═══ */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-6">

        {/* ──── HOME TAB ──── */}
        {tab === 'home' && (
          <div className="space-y-6">
            {refreshNotice && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-slate-900/80 border border-slate-700/60 text-xs text-slate-400">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Auto-refresh failed; showing the last successful data. {refreshNotice}</span>
              </div>
            )}

            {/* Stale data / API error banners */}
            {data.syncStatus.error ? (
              <div className="flex items-center justify-between p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/40 text-xs text-amber-300">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <div>
                    <span className="font-semibold text-amber-200">Codeforces Notice: </span>
                    <span>{data.syncStatus.error}. Showing cached data from {formatDateHebron(data.syncStatus.lastSyncedAt)}.</span>
                  </div>
                </div>
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="px-2.5 py-1 rounded-lg bg-amber-800/60 hover:bg-amber-700/70 text-white font-medium shrink-0 transition-all ml-3"
                >
                  {syncing ? 'Retrying...' : 'Retry Refresh'}
                </button>
              </div>
            ) : (!data.syncStatus.lastSyncedAt ||
              Date.now() - new Date(data.syncStatus.lastSyncedAt).getTime() > 24 * 60 * 60 * 1000) ? (
              <div className="flex items-center justify-between p-3 rounded-xl bg-amber-950/30 border border-amber-800/30 text-xs text-amber-300">
                <span>
                  {data.syncStatus.lastSyncedAt
                    ? `Data was last synchronized on ${formatDateHebron(data.syncStatus.lastSyncedAt)}. Click Refresh to update.`
                    : 'No data synced yet. Click Refresh to fetch your Codeforces profile.'}
                </span>
                <button onClick={handleSync} disabled={syncing}
                  className="px-2.5 py-1 rounded-lg bg-amber-800/50 hover:bg-amber-700/60 text-white font-medium shrink-0 transition-all"
                >
                  {syncing ? 'Refreshing...' : 'Refresh now'}
                </button>
              </div>
            ) : null}

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                <div className="text-[11px] text-slate-500 mb-1">Rating</div>
                <div className={`text-xl font-bold ${getRankColor(user?.rating, user?.rank)}`}>
                  {user?.rating || '—'}
                </div>
                <div className="text-[11px] text-slate-600 mt-0.5">
                  Max {user?.maxRating || '—'} · {user?.rank || 'unrated'}
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                <div className="text-[11px] text-slate-500 mb-1">Solved</div>
                <div className="text-xl font-bold text-white">{data.distinctSolvedCount}</div>
                <div className="text-[11px] text-slate-600 mt-0.5">distinct problems</div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                <div className="text-[11px] text-slate-500 mb-1">Today</div>
                <div className="text-xl font-bold text-white">{doneCount}/{totalProbs}</div>
                <div className="text-[11px] text-slate-600 mt-0.5">problems done</div>
              </div>
            </div>

            {/* ── Weekly Goal Progress Card ── */}
            {weeklyGoal && (
              <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 shadow-sm space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Target className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-bold text-white uppercase tracking-wider">Weekly Training Target</span>
                    <span className="text-[10px] text-slate-500 font-mono">Week of {weeklyGoal.weekStartDate}</span>
                  </div>
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                    weeklyGoal.status === 'ACHIEVED' 
                      ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/60'
                      : 'bg-cyan-950/80 text-cyan-300 border border-cyan-800/60'
                  }`}>
                    {weeklyGoal.status === 'ACHIEVED' ? 'Goal Achieved!' : 'In Progress'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                      <span>Problems Solved</span>
                      <span className="font-bold text-white">{weeklyGoal.actualSolvesCount} / {weeklyGoal.targetSolvesCount}</span>
                    </div>
                    <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                      <div 
                        className="bg-gradient-to-r from-cyan-500 to-blue-500 h-full rounded-full transition-all duration-500" 
                        style={{ width: `${Math.min(100, Math.round((weeklyGoal.actualSolvesCount / Math.max(1, weeklyGoal.targetSolvesCount)) * 100))}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                      <span>Rounds / Upsolves</span>
                      <span className="font-bold text-white">{weeklyGoal.actualContestsCount} / {weeklyGoal.targetContestsCount}</span>
                    </div>
                    <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                      <div 
                        className="bg-gradient-to-r from-violet-500 to-indigo-500 h-full rounded-full transition-all duration-500" 
                        style={{ width: `${Math.min(100, Math.round((weeklyGoal.actualContestsCount / Math.max(1, weeklyGoal.targetContestsCount)) * 100))}%` }}
                      />
                    </div>
                  </div>
                </div>

                {weeklyGoal.focusTopic && (
                  <div className="flex items-center gap-2 pt-1 border-t border-slate-800/60 text-[11px]">
                    <span className="text-slate-500">Focus Topic:</span>
                    <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-300 font-mono">
                      {weeklyGoal.focusTopic}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* ── Spaced Repetition Due Alert ── */}
            {dueReviews.length > 0 && (
              <div className="p-4 rounded-xl bg-indigo-950/30 border border-indigo-800/40 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-400">
                    <RotateCcw className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white flex items-center gap-2">
                      <span>{dueReviews.length} Problem{dueReviews.length > 1 ? 's' : ''} Due for Review</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-900/80 text-indigo-300 font-mono">Spaced Repetition</span>
                    </div>
                    <div className="text-[11px] text-slate-400">Strengthen long-term retention of recently practiced concepts</div>
                  </div>
                </div>
                <button
                  onClick={() => setTab('reviews')}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shrink-0 ml-3"
                >
                  Review Now →
                </button>
              </div>
            )}

            {/* ── Grounded Coach Learning Insight ── */}
            {data.learnerModel?.coachInsight && (
              <div className="p-4 rounded-xl bg-gradient-to-r from-slate-900 via-cyan-950/30 to-slate-900 border border-cyan-800/40 shadow-sm flex items-start gap-3">
                <BrainCircuit className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
                <div className="space-y-1 w-full">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-cyan-300 flex items-center gap-1.5">
                      Coach Adaptation Insight
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">Asia/Hebron</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {data.learnerModel.coachInsight}
                  </p>
                </div>
              </div>
            )}

            {/* ── Today's 3 Problems (main focus) ── */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-cyan-400" />
                  Today's Training
                  {todaySet && (
                    <span className="text-[11px] text-slate-500 font-normal font-mono">
                      · {todaySet.date}
                    </span>
                  )}
                </h2>

                {data.learnerModel?.weeklyReview && (
                  <button
                    onClick={() => setShowWeeklyReview(!showWeeklyReview)}
                    className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-800/40 px-2.5 py-1 rounded-lg transition-all"
                  >
                    <ClipboardList className="w-3.5 h-3.5" />
                    <span>{showWeeklyReview ? 'Hide Review' : 'Weekly Review'}</span>
                  </button>
                )}
              </div>

              {/* Weekly Review Slide-down Card */}
              {showWeeklyReview && data.learnerModel?.weeklyReview && (
                <div className="mb-4 p-4 rounded-xl bg-slate-900/95 border border-slate-700/80 space-y-3 shadow-md">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                      <ClipboardList className="w-3.5 h-3.5 text-cyan-400" />
                      Evidence-Grounded Weekly Review
                    </h3>
                    <span className="text-[11px] text-slate-500 font-mono">
                      Generated {data.learnerModel.weeklyReview.generatedAt}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    {/* What improved */}
                    <div className="p-3 rounded-lg bg-emerald-950/20 border border-emerald-900/40">
                      <span className="font-semibold text-emerald-300 block mb-1.5">1. What Improved</span>
                      <ul className="space-y-1 text-slate-300">
                        {data.learnerModel.weeklyReview.whatImproved.map((item, idx) => (
                          <li key={idx} className="flex items-start gap-1.5">
                            <span className="text-emerald-400 font-bold">✓</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Difficulties remaining */}
                    <div className="p-3 rounded-lg bg-rose-950/20 border border-rose-900/40">
                      <span className="font-semibold text-rose-300 block mb-1.5">2. Difficulties Remaining</span>
                      <ul className="space-y-1 text-slate-300">
                        {data.learnerModel.weeklyReview.difficultiesRemaining.map((item, idx) => (
                          <li key={idx} className="flex items-start gap-1.5">
                            <span className="text-rose-400 font-bold">•</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* Supporting Evidence */}
                  <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800 text-xs">
                    <span className="font-semibold text-slate-300 block mb-1">3. Supporting Stored Evidence</span>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {data.learnerModel.weeklyReview.evidenceDetails.map((item, idx) => (
                        <span key={idx} className="text-[11px] text-slate-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Priorities Changed & Plan Rationale */}
                  <div className="text-xs text-slate-300 space-y-1 pt-1 border-t border-slate-800">
                    <div>
                      <span className="font-semibold text-slate-200">4. Priority Changes: </span>
                      <span className="text-slate-400">{data.learnerModel.weeklyReview.trainingPrioritiesChanged.join(' ')}</span>
                    </div>
                    <div>
                      <span className="font-semibold text-slate-200">5. Practice Rationale: </span>
                      <span className="text-slate-400">{data.learnerModel.weeklyReview.planRationale}</span>
                    </div>
                  </div>
                </div>
              )}

              {todaySet && todaySet.problems.length > 0 ? (
                <div className="space-y-3">
                  {todaySet.problems.map((item) => (
                    <ProblemCard 
                      key={item.id} 
                      item={item} 
                      onSaveFeedback={handleFeedback}
                      onOpenProblem={handleOpenProblem}
                      onStartSession={(prob) => setActiveSolveProblem(prob)}
                      onReplaceProblem={handleReplaceProblem}
                      onSendToReview={handleSendToReview}
                    />
                  ))}
                </div>
              ) : (
                <div className="py-10 text-center text-xs text-slate-500 bg-slate-900/40 rounded-xl border border-slate-800">
                  <Sparkles className="w-6 h-6 text-slate-600 mx-auto mb-2" />
                  No problems available. Sync your Codeforces data first.
                </div>
              )}
            </section>

            {/* ── Weak Topics Preview ── */}
            {data.topics.weak.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-400" />
                    Topics to Improve
                  </h2>
                  <button onClick={() => setTab('topics')} className="text-[11px] text-cyan-400 hover:text-cyan-300">
                    View all →
                  </button>
                </div>
                <TopicList topics={data.topics} compact />
              </section>
            )}

            {/* ── Rating Chart ── */}
            {data.ratingHistory.length > 0 && (
              <section>
                <h2 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-cyan-400" />
                  Rating Progress
                </h2>
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                  <RatingChart ratingHistory={data.ratingHistory} currentRating={user?.rating} />
                </div>
              </section>
            )}
          </div>
        )}

        {/* ──── MASTERY MAP TAB ──── */}
        {tab === 'skill-tracks' && (
          <SkillTracksView profileId={data.activeProfile.id} />
        )}

        {/* ──── REVIEWS TAB ──── */}
        {tab === 'reviews' && (
          <div className="space-y-6">
            <ReviewQueueCard
              dueReviews={dueReviews}
              summary={reviewSummary}
              profileId={data.activeProfile.id}
              onReviewUpdated={async () => {
                const rev = await fetchReviewQueue(data.activeProfile.id);
                setDueReviews(rev.dueReviews || []);
                setReviewSummary(rev.summary || null);
              }}
              onStartSession={(problemId) => {
                const revItem = dueReviews.find(r => r.problemId === problemId);
                if (revItem) {
                  setActiveSolveProblem({
                    id: `rev_${problemId}`,
                    dailySetId: '',
                    profileId: data.activeProfile.id,
                    dailySetDate: new Date().toISOString().slice(0, 10),
                    problemId: problemId,
                    category: 'REINFORCEMENT',
                    reason: revItem.triggerReason || 'Spaced Repetition Review',
                    targetRating: revItem.rating || 1350,
                    completed: false,
                    solvedStatus: 'NOT_SOLVED',
                    problem: {
                      contestId: revItem.contestId || 0,
                      index: revItem.problemIndex || '',
                      name: revItem.problemName,
                      rating: revItem.rating ?? undefined,
                      tags: revItem.tags || [],
                    },
                  });
                }
              }}
            />
          </div>
        )}

        {/* ──── CONTESTS TAB ──── */}
        {tab === 'contests' && (
          <ContestsView
            profileId={data.activeProfile.id}
            onNavigateToPractice={() => setTab('home')}
          />
        )}

        {/* ──── TOPICS TAB ──── */}
        {tab === 'topics' && (
          <div className="space-y-4">
            <h2 className="text-sm font-bold text-white">Topic Analysis</h2>
            <p className="text-xs text-slate-500">
              Based on your Codeforces submissions and training feedback. Topics with fewer than 3 attempts are marked Unexplored — not weak.
            </p>
            <TopicList topics={data.topics} />
          </div>
        )}

        {/* ──── HISTORY TAB ──── */}
        {tab === 'history' && (
          <div className="space-y-4">
            <h2 className="text-sm font-bold text-white">Training History</h2>
            <HistoryList history={history} />
            <ProblemJournalList events={journal} />
          </div>
        )}

        {/* ──── SETTINGS TAB ──── */}
        {tab === 'settings' && (
          <div className="space-y-6 max-w-lg">
            <h2 className="text-sm font-bold text-white">Settings</h2>

            {/* Current profile info */}
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Current Profile</h3>
              <div className="flex items-center gap-3">
                {data.activeProfile.avatar ? (
                  <img src={data.activeProfile.avatar} alt="" className="w-10 h-10 rounded-full" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-cyan-900 flex items-center justify-center text-sm font-bold text-cyan-300">
                    {data.activeProfile.handle[0]}
                  </div>
                )}
                <div>
                  <div className={`text-sm font-bold ${getRankColor(user?.rating, user?.rank)}`}>
                    {data.activeProfile.handle}
                  </div>
                  <div className="text-xs text-slate-500">
                    {user?.rating || 'Unrated'} · {user?.rank || '—'} · {data.distinctSolvedCount} solved
                  </div>
                </div>
              </div>
            </div>

            {/* Sync info */}
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Sync Status</h3>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><span className="text-slate-500 block">Last sync</span><span className="text-white font-mono">{formatDateHebron(data.syncStatus.lastSyncedAt)}</span></div>
                <div><span className="text-slate-500 block">Submissions</span><span className="text-white font-mono">{data.syncStatus.submissionsCount.toLocaleString()}</span></div>
                <div><span className="text-slate-500 block">Problems DB</span><span className="text-white font-mono">{data.syncStatus.problemsCount.toLocaleString()}</span></div>
              </div>
              <button
                onClick={handleSync}
                disabled={syncing}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-white font-medium transition-all"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing...' : 'Sync Now'}
              </button>
            </div>

            {/* Add friend profile */}
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {isPublicMode ? 'Add Another Handle on This Browser' : 'Add Another Profile'}
              </h3>
              <p className="text-xs text-slate-500">
                {isPublicMode
                  ? 'Each handle keeps its own plan, notes, and history in this browser. Other browsers stay separate.'
                  : 'Your friend can have their own training plan with separate problems and feedback.'}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={settingsHandle}
                  onChange={(e) => setSettingsHandle(e.target.value)}
                  placeholder="Codeforces handle"
                  className="flex-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500/60"
                />
                <button
                  onClick={handleSettingsAddProfile}
                  disabled={settingsCreating || !settingsHandle.trim()}
                  className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-semibold transition-all"
                >
                  {settingsCreating ? 'Adding...' : 'Add'}
                </button>
              </div>
              {settingsMsg && (
                <p className={`text-xs ${settingsMsg.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'}`}>{settingsMsg}</p>
              )}
            </div>

            {/* Privacy note */}
            <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/60 text-xs text-slate-500 space-y-1">
              <p className="font-medium text-slate-400">Privacy & Security</p>
              {isPublicMode ? (
                <>
                  <p>This browser stores your selected handles and a versioned snapshot of your notes, feedback, reviews, sessions, and goals. The server keeps an ephemeral copy so refreshes do not erase your work.</p>
                  <p>Other browsers are separate. Clearing this browser's site data removes its local copy, and the ephemeral server copy may be lost when the free backend restarts.</p>
                </>
              ) : (
                <>
                  <p>This is a private local application running on <code className="text-slate-300">127.0.0.1</code>. All data stays on your computer in a local SQLite database.</p>
                  <p>If you ever deploy this remotely, add authentication first — a Codeforces handle is not a password.</p>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── Solve Session Modal ── */}
      {activeSolveProblem && (
        <SolveSessionModal
          problem={activeSolveProblem}
          profileId={data.activeProfile.id}
          isOpen={!!activeSolveProblem}
          onClose={() => setActiveSolveProblem(null)}
          onSessionFinished={async () => {
            setActiveSolveProblem(null);
            await loadAll(data.activeProfile.id);
          }}
          onOpenTutorial={() => {}}
        />
      )}

      {/* ═══ Footer ═══ */}
      <footer className="py-3 text-center text-[11px] text-slate-700 border-t border-slate-800/30">
        CP Coach · {isPublicMode ? 'Browser-local data' : 'Local'} · Asia/Hebron timezone
      </footer>
    </div>
  );
};

export default App;
