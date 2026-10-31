import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, Suspense, lazy } from 'react';
import {
  fetchDashboard, fetchProfiles, createProfile as apiCreateProfile,
  selectProfile as apiSelectProfile, triggerSync, submitProblemFeedback, fetchHistory,
  fetchProblemJournal, replaceDailyProblem, enqueueReview, fetchReviewQueue, fetchWeeklyGoals, openProblem,
  fetchUpcomingContests,
  isPublicMode, getPublicHandle, restorePublicContext, capturePublicContext, serverRestarted,
  saveOfflineDashboard, readOfflineDashboard, setPublicHandle,
  type OfflineDashboardSnapshot,
} from './api';
import { perfMark, perfMeasure } from './perf';
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
import { ReviewQueueCard } from './components/ReviewQueueCard';
import { SolveSessionModal } from './components/SolveSessionModal';

const LazyContestsView = lazy(() => import('./components/ContestsView').then((module) => ({ default: module.ContestsView })));
const LazySkillTracksView = lazy(() => import('./components/SkillTracksView').then((module) => ({ default: module.SkillTracksView })));
const LazyKnowledgeJournal = lazy(() => import('./components/KnowledgeJournal').then((module) => ({ default: module.KnowledgeJournal })));
const LazyWeeklyCoachReport = lazy(() => import('./components/WeeklyCoachReport').then((module) => ({ default: module.WeeklyCoachReport })));
const LazyNotificationsSettings = lazy(() => import('./components/NotificationsSettings').then((module) => ({ default: module.NotificationsSettings })));
const LazyDataBackupPanel = lazy(() => import('./components/DataBackupPanel').then((module) => ({ default: module.DataBackupPanel })));
const LazyGettingStartedHelp = lazy(() => import('./components/GettingStartedHelp').then((module) => ({ default: module.GettingStartedHelp })));
import { getRankColor, formatDateHebron, formatRelativeTimeAgo } from './utils';
import {
  RefreshCw, ChevronDown, Flame, TrendingUp, CheckCircle2,
  Calendar, Layers, Settings, Loader2, AlertCircle, UserPlus, Sparkles, Trophy,
  BrainCircuit, ClipboardList, AlertTriangle, Clock, Compass, RotateCcw, Target, BookOpen, Download
} from 'lucide-react';

type Tab = 'home' | 'skill-tracks' | 'reviews' | 'contests' | 'journal' | 'topics' | 'history' | 'settings';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export const App: React.FC = () => {
  // ─── State ───
  const initialSnapshotRef = useRef<OfflineDashboardSnapshot | null | undefined>(undefined);
  if (initialSnapshotRef.current === undefined) {
    initialSnapshotRef.current = readOfflineDashboard();
  }
  const initialSnapshot = initialSnapshotRef.current;
  const [data, setData] = useState<DashboardOverview | null>(() => initialSnapshot?.data ?? null);
  const [history, setHistory] = useState<DailySet[]>(() => initialSnapshot?.history ?? []);
  const [journal, setJournal] = useState<ProblemLearningEvent[]>(() => initialSnapshot?.journal ?? []);
  const [profiles, setProfiles] = useState<UserProfile[]>(() => (
    initialSnapshot?.data.availableProfiles || (initialSnapshot?.data.activeProfile ? [initialSnapshot.data.activeProfile] : [])
  ));
  const [loading, setLoading] = useState(() => !initialSnapshot);
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
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(() => initialSnapshot?.savedAt ?? null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(() => (
    initialSnapshot ? 'Showing browser-saved training data while the latest data refreshes.' : null
  ));
  const [upcomingContests, setUpcomingContests] = useState<Array<{ id: number; name: string; startTimeSeconds: number; durationSeconds: number; phase: string; url: string }>>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [appInstalled, setAppInstalled] = useState(() => (
    typeof window !== 'undefined' && (
      window.matchMedia('(display-mode: standalone)').matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
    )
  ));
  const [installError, setInstallError] = useState<string | null>(null);
  const [showWakeupHint, setShowWakeupHint] = useState(false);
  const dataRef = useRef<DashboardOverview | null>(initialSnapshot?.data ?? null);
  const initStartedRef = useRef(false);
  const initialLoadCompletedRef = useRef(false);
  const backgroundPollRef = useRef<number | null>(null);
  const loadInFlightRef = useRef<Map<string, Promise<void>>>(new Map());

  // New Training Plan & Metacognitive states
  const [dueReviews, setDueReviews] = useState<ReviewQueueItem[]>(() => initialSnapshot?.dueReviews ?? []);
  const [reviewSummary, setReviewSummary] = useState<any>(() => initialSnapshot?.reviewSummary ?? null);
  const [weeklyGoal, setWeeklyGoal] = useState<WeeklyGoal | null>(() => initialSnapshot?.weeklyGoal ?? null);
  const [activeSolveProblem, setActiveSolveProblem] = useState<DailyProblem | null>(null);
  const firstPaintMarkedRef = useRef(false);
  const dashboardReadyMarkedRef = useRef(false);

  useLayoutEffect(() => {
    if (firstPaintMarkedRef.current) return;
    firstPaintMarkedRef.current = true;
    perfMark(dataRef.current ? 'dashboard-shell-visible' : 'loading-shell-visible');
    perfMark('first-render');
    perfMeasure('navigation-to-first-render', 'navigation-start', 'first-render');
  }, []);

  useEffect(() => {
    if (!data || dashboardReadyMarkedRef.current) return;
    dashboardReadyMarkedRef.current = true;
    perfMark('dashboard-data-ready');
    perfMeasure('navigation-to-dashboard-data', 'navigation-start', 'dashboard-data-ready');
  }, [data]);

  const restoreOfflineSnapshot = (message: string): boolean => {
    const snapshot = readOfflineDashboard();
    if (!snapshot) return false;
    dataRef.current = snapshot.data;
    setData(snapshot.data);
    setProfiles(snapshot.data.availableProfiles || [snapshot.data.activeProfile]);
    setHistory(snapshot.history);
    setJournal(snapshot.journal);
    setDueReviews(snapshot.dueReviews);
    setReviewSummary(snapshot.reviewSummary);
    setWeeklyGoal(snapshot.weeklyGoal);
    setLastRefreshedAt(snapshot.savedAt);
    setRefreshNotice(`${message} Showing browser-saved data last updated ${formatDateHebron(snapshot.savedAt)}.`);
    setError(null);
    setLoading(false);
    return true;
  };

  const formatContestCountdown = useCallback((startTimeSeconds: number): string => {
    const diffMs = Math.max(0, startTimeSeconds * 1000 - nowMs);
    const totalSeconds = Math.floor(diffMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }, [nowMs]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!data?.activeProfile?.id) {
      setUpcomingContests([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const contests = await fetchUpcomingContests();
        if (!cancelled) setUpcomingContests(contests.slice(0, 3));
      } catch {
        if (!cancelled) setUpcomingContests([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data?.activeProfile?.id]);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  useEffect(() => {
    const handleNotificationNavigation = () => {
      if (window.location.hash === '#daily-recommendations') setTab('home');
    };
    window.addEventListener('hashchange', handleNotificationNavigation);
    handleNotificationNavigation();
    return () => window.removeEventListener('hashchange', handleNotificationNavigation);
  }, []);

  useEffect(() => {
    if (tab !== 'home' || loading || window.location.hash !== '#daily-recommendations') return;
    document.getElementById('daily-recommendations')?.scrollIntoView({ behavior: 'smooth' });
  }, [tab, loading]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setAppInstalled(true);
      setInstallPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallApp = async () => {
    if (!installPrompt) return;
    setInstallError(null);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') setAppInstalled(true);
    } catch (error) {
      console.error('Could not open the app installation prompt:', error);
      setInstallError('The installation prompt could not be opened. Use your browser menu to install the app.');
    } finally {
      setInstallPrompt(null);
    }
  };

  useEffect(() => {
    if (!loading || !isPublicMode) {
      setShowWakeupHint(false);
      return;
    }
    const timer = window.setTimeout(() => setShowWakeupHint(true), 1800);
    return () => window.clearTimeout(timer);
  }, [loading]);

  // ─── Load data ───
  const loadAll = useCallback((profileId?: string, options?: { silent?: boolean }): Promise<void> => {
    const silent = options?.silent === true;
    const requestKey = profileId || 'active';
    const existingRequest = loadInFlightRef.current.get(requestKey);
    if (existingRequest) return existingRequest;

    const task = (async () => {
      if (!silent) {
        if (!dataRef.current) setLoading(true);
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
        perfMark('dashboard-request-start');
        const dashboard = await fetchDashboard(profileId);
        perfMark('dashboard-request-end');
        perfMeasure('dashboard-request', 'dashboard-request-start', 'dashboard-request-end');

        // Dashboard data is the only essential payload. Make the app usable and
        // cache it immediately; history/journal/reviews are loaded afterwards so
        // a slow secondary endpoint can never keep the loading screen visible.
        const activeProfileId = dashboard.activeProfile.id;
        const refreshedAt = new Date().toISOString();
        const previousSnapshot = readOfflineDashboard(dashboard.activeProfile.handle);
        dataRef.current = dashboard;
        setData(dashboard);
        setLoading(false);
        setError(null);
        if (!isPublicMode && dashboard.availableProfiles?.length) {
          setProfiles(dashboard.availableProfiles);
        }
        setLastRefreshedAt(refreshedAt);
        saveOfflineDashboard({
          savedAt: refreshedAt,
          data: dashboard,
          history: previousSnapshot?.history ?? [],
          journal: previousSnapshot?.journal ?? [],
          dueReviews: previousSnapshot?.dueReviews ?? [],
          reviewSummary: previousSnapshot?.reviewSummary ?? null,
          weeklyGoal: previousSnapshot?.weeklyGoal ?? null,
        });
        setRefreshNotice(null);
        perfMark('app-usable');
        perfMeasure('navigation-to-app-usable', 'navigation-start', 'app-usable');
        if (isPublicMode) {
          void capturePublicContext(dashboard.activeProfile.handle);
        }

        perfMark('secondary-requests-start');
        const [historyResult, journalResult, reviewResult, weeklyGoalResult] = await Promise.allSettled([
          fetchHistory(activeProfileId, 30),
          fetchProblemJournal(activeProfileId, 100),
          fetchReviewQueue(activeProfileId),
          fetchWeeklyGoals(activeProfileId),
        ]);
        perfMark('secondary-requests-end');
        perfMeasure('secondary-requests', 'secondary-requests-start', 'secondary-requests-end');

        const hist = historyResult.status === 'fulfilled' ? historyResult.value : [];
        setHistory(hist);

        const nextJournal = journalResult.status === 'fulfilled' ? journalResult.value : [];
        setJournal(nextJournal);

        const nextReview = reviewResult.status === 'fulfilled' ? reviewResult.value : null;
        const nextDueReviews = nextReview?.dueReviews || [];
        const nextReviewSummary = nextReview?.summary || null;
        setDueReviews(nextDueReviews);
        setReviewSummary(nextReviewSummary);

        const nextWeeklyGoal = weeklyGoalResult.status === 'fulfilled' ? weeklyGoalResult.value : null;
        setWeeklyGoal(nextWeeklyGoal);

        const completedAt = new Date().toISOString();
        setLastRefreshedAt(completedAt);
        saveOfflineDashboard({
          savedAt: completedAt,
          data: dashboard,
          history: hist,
          journal: nextJournal,
          dueReviews: nextDueReviews,
          reviewSummary: nextReviewSummary,
          weeklyGoal: nextWeeklyGoal,
        });
        if (!initialLoadCompletedRef.current) {
          initialLoadCompletedRef.current = true;
          perfMark('initial-data-complete');
          perfMeasure('navigation-to-initial-data-complete', 'navigation-start', 'initial-data-complete');
        }
      } catch (err: any) {
        const message = err.message || 'Cannot connect to backend';
        if (silent && dataRef.current) {
          setRefreshNotice(message);
        } else if (!dataRef.current && restoreOfflineSnapshot('The service is unreachable.')) {
          return;
        } else {
          setError(message);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    })();

    loadInFlightRef.current.set(requestKey, task);
    void task.finally(() => {
      if (loadInFlightRef.current.get(requestKey) === task) {
        loadInFlightRef.current.delete(requestKey);
      }
    }).catch(() => {});
    return task;
  }, []);

  useEffect(() => {
    // On mount: show cached data immediately, then restore the browser context
    // only when the backend actually restarted. A full context upload on every
    // visit used to add seconds to the dashboard's critical path.
    //
    // Do not cancel this initialization in an effect cleanup: React StrictMode
    // deliberately runs mount effects twice in development, and cancelling the
    // first run used to leave the app stuck on the loading screen forever.
    if (initStartedRef.current) return;
    initStartedRef.current = true;
    const silentInitialLoad = Boolean(dataRef.current);

    void (async () => {
      try {
        if (isPublicMode && getPublicHandle()) {
          const preferred = getPublicHandle()!;
          void fetchProfiles()
            .then(({ profiles: nextProfiles }) => setProfiles(nextProfiles))
            .catch(() => {});

          perfMark('context-check-start');
          if (await serverRestarted()) {
            const restore = await restorePublicContext(preferred);
            if (restore.failed) {
              throw new Error(
                'The backend restarted and this browser\'s saved data could not be restored yet. Your local data is safe; retry in a moment.'
              );
            }
          }
          perfMark('context-check-end');
          perfMeasure('context-check', 'context-check-start', 'context-check-end');
          await loadAll(undefined, { silent: silentInitialLoad });
          return;
        }

        const { profiles: p, activeProfileId: aId } = await fetchProfiles();
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
          perfMark('context-check-start');
          if (await serverRestarted()) {
            const restore = await restorePublicContext(target.handle);
            if (restore.failed) {
              throw new Error(
                'The backend restarted and this browser\'s saved data could not be restored yet. Your local data is safe; retry in a moment.'
              );
            }
          }
          perfMark('context-check-end');
          perfMeasure('context-check', 'context-check-start', 'context-check-end');
        } else {
          target = p.find((profile) => profile.handle.toLowerCase() === 'obadajo') || target;
        }

        await loadAll(target.id, { silent: silentInitialLoad });
      } catch (err: any) {
        if (!restoreOfflineSnapshot('The service is unreachable.')) {
          setError(err.message || 'Cannot connect to backend.');
          setLoading(false);
        }
      }
    })();
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

  // A dashboard request must never wait for Codeforces. When the backend
  // reports a background refresh in progress, poll the cheap dashboard route
  // until it finishes instead of blocking the first render.
  useEffect(() => {
    const profileId = data?.activeProfile.id;
    if (!profileId || !data?.syncStatus?.isSyncing) return;

    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const dashboard = await fetchDashboard(isPublicMode ? undefined : profileId);
        if (cancelled) return;
        dataRef.current = dashboard;
        setData(dashboard);
        if (dashboard.syncStatus?.isSyncing && attempts < 24) {
          backgroundPollRef.current = window.setTimeout(poll, 1500);
          return;
        }
        await loadAll(isPublicMode ? undefined : profileId, { silent: true });
      } catch {
        if (!cancelled && attempts < 8) {
          backgroundPollRef.current = window.setTimeout(poll, 2500);
        }
      }
    };

    backgroundPollRef.current = window.setTimeout(poll, 1200);
    return () => {
      cancelled = true;
      if (backgroundPollRef.current !== null) {
        window.clearTimeout(backgroundPollRef.current);
        backgroundPollRef.current = null;
      }
    };
  }, [data?.activeProfile.id, data?.syncStatus?.isSyncing, loadAll]);

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
    const previousHandle = data?.activeProfile.handle || null;
    try {
      await apiSelectProfile(id);
      await loadAll(id);
      if (dataRef.current?.activeProfile.id !== id && isPublicMode && previousHandle) {
        setPublicHandle(previousHandle);
      }
    } catch (err: any) {
      if (isPublicMode && previousHandle) setPublicHandle(previousHandle);
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
      <div className="min-h-screen flex flex-col">
        <header className="sticky top-0 z-50 bg-[#0c0f1a]/90 backdrop-blur-lg border-b border-slate-800/60">
          <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-extrabold text-white tracking-tight flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-cyan-400" />
                CP Coach
              </span>
              <span className="text-[10px] font-mono font-bold text-cyan-300 bg-cyan-950/80 border border-cyan-800/60 px-2 py-0.5 rounded-full">
                {isPublicMode ? 'public' : 'local'}
              </span>
            </div>
            <div className="h-7 w-24 rounded-lg bg-slate-900 border border-slate-800 animate-pulse" />
          </div>
        </header>
        <nav aria-label="Main sections" className="border-b border-slate-800/40 bg-[#0c0f1a]/60 backdrop-blur-sm">
          <div className="max-w-4xl mx-auto px-4 flex gap-1 overflow-x-auto no-scrollbar">
            {([
              { key: 'home', icon: Sparkles, label: 'Training Plan' },
              { key: 'skill-tracks', icon: Compass, label: 'Mastery Map' },
              { key: 'reviews', icon: RotateCcw, label: 'Reviews' },
              { key: 'contests', icon: Trophy, label: 'Contests' },
              { key: 'journal', icon: BookOpen, label: 'Knowledge Journal' },
              { key: 'topics', icon: Layers, label: 'Topics' },
              { key: 'history', icon: Calendar, label: 'History' },
              { key: 'settings', icon: Settings, label: 'Settings' },
            ]).map((item) => (
              <span key={item.key} className="flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium border-b-2 border-transparent text-slate-600 whitespace-nowrap">
                <item.icon className="w-3.5 h-3.5" />
                {item.label}
              </span>
            ))}
          </div>
        </nav>
        <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-6">
          <div role="status" aria-live="polite" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center space-y-3">
            <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mx-auto" />
            <p className="text-sm text-slate-300">Loading your training data...</p>
            <div className="mx-auto grid max-w-md grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-20 rounded-xl border border-slate-800 bg-slate-950/60 animate-pulse" />
              ))}
            </div>
            {showWakeupHint && (
              <p className="text-xs leading-relaxed text-slate-500">
                {isOnline
                  ? 'The free Coach service may be waking after inactivity. The interface is ready; your training data will appear as soon as the service responds.'
                  : 'You appear to be offline. Reconnect to load your profile and recommendations.'}
              </p>
            )}
          </div>
        </main>
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
          <button onClick={() => window.location.reload()} className="px-4 py-2 rounded-lg bg-cyan-600 text-white text-xs font-semibold">
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
  const dueCount = typeof reviewSummary?.dueCount === 'number' ? reviewSummary.dueCount : dueReviews.length;
  const trainingPending = !todaySet?.problems?.length && Boolean(data.syncStatus?.isSyncing);

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
              <div className="hidden sm:flex items-center gap-1 text-xs font-semibold text-amber-400">
                <Flame className="w-3.5 h-3.5" />
                <span>{data.streakDays}d</span>
              </div>
            )}
            {(lastRefreshedAt || data.syncStatus.lastSyncedAt) && (
              <span
                className="hidden sm:inline-flex items-center gap-1 text-[11px] text-slate-500 font-mono whitespace-nowrap"
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
      <nav aria-label="Main sections" className="border-b border-slate-800/40 bg-[#0c0f1a]/60 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 flex gap-1 overflow-x-auto no-scrollbar">
          {([
            { key: 'home' as const, icon: Sparkles, label: 'Training Plan' },
            { key: 'skill-tracks' as const, icon: Compass, label: 'Mastery Map' },
            { key: 'reviews' as const, icon: RotateCcw, label: `Reviews ${dueCount > 0 ? `(${dueCount})` : ''}` },
            { key: 'contests' as const, icon: Trophy, label: 'Contests' },
            { key: 'journal' as const, icon: BookOpen, label: 'Knowledge Journal' },
            { key: 'topics' as const, icon: Layers, label: 'Topics' },
            { key: 'history' as const, icon: Calendar, label: 'History' },
            { key: 'settings' as const, icon: Settings, label: 'Settings' },
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
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
        {error && (
          <div role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-rose-900/60 bg-rose-950/30 p-3 text-xs text-rose-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}
        {!isOnline && (
          <div role="status" className="mb-5 flex items-center gap-2 p-3 rounded-xl bg-amber-950/40 border border-amber-800/50 text-xs text-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Offline. Showing saved training data; Codeforces and server information may be out of date.</span>
          </div>
        )}

        {/* ──── HOME TAB ──── */}
        {tab === 'home' && (
          <div className="space-y-6">
            <Suspense fallback={<div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-slate-300">Loading help…</div>}>
              <LazyGettingStartedHelp />
            </Suspense>
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

            {upcomingContests.length > 0 && (
              <div className="p-4 rounded-xl border border-cyan-800/60 bg-gradient-to-r from-cyan-950/40 via-slate-900 to-slate-900 shadow-sm">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-white">
                    <Trophy className="w-4 h-4 text-cyan-400" />
                    Upcoming Contest
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">Asia/Hebron</span>
                </div>
                <div className="space-y-2">
                  {upcomingContests.map((contest) => (
                    <div key={contest.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white truncate">{contest.name}</div>
                        <div className="text-[11px] text-slate-400 font-mono">{formatDateHebron(new Date(contest.startTimeSeconds * 1000).toISOString())}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[11px] text-cyan-300 font-semibold">{formatContestCountdown(contest.startTimeSeconds)}</div>
                        <a
                          href={contest.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[10px] text-slate-400 underline underline-offset-2 hover:text-slate-200"
                        >
                          Open CF
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.availableProfiles.length > 1 && (
              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <Clock className="w-4 h-4 text-cyan-400" />
                    Recent Activity
                  </h2>
                  <span className="text-[10px] text-slate-500">Last active</span>
                </div>
                <div className="space-y-2">
                  {data.availableProfiles.map((profile) => {
                    const lastActiveMs = new Date(profile.lastActiveAt).getTime();
                    const isRecentlyActive = Number.isFinite(lastActiveMs) && Date.now() - lastActiveMs < 10 * 60 * 1000;
                    return (
                      <div key={profile.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`h-2.5 w-2.5 rounded-full ${isRecentlyActive ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                          <span className="text-xs text-slate-200 truncate">{profile.handle}</span>
                        </div>
                        <span className="text-[11px] text-slate-400 font-mono whitespace-nowrap">
                          {formatRelativeTimeAgo(profile.lastActiveAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Stats row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
            {dueCount > 0 && (
              <div className="p-4 rounded-xl bg-indigo-950/30 border border-indigo-800/40 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-400">
                    <RotateCcw className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white flex items-center gap-2">
                      <span>{dueCount} Problem{dueCount > 1 ? 's' : ''} Due for Review</span>
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
            <section id="daily-recommendations">
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

                <button
                  onClick={() => setShowWeeklyReview(!showWeeklyReview)}
                  className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-800/40 px-2.5 py-1 rounded-lg transition-all"
                >
                  <ClipboardList className="w-3.5 h-3.5" />
                  <span>{showWeeklyReview ? 'Hide Report' : 'Weekly Coach Report'}</span>
                </button>
              </div>

              {/* Weekly Review Slide-down Card */}
              {showWeeklyReview && (
                <>
                <Suspense fallback={<div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-slate-300">Loading coach report…</div>}>
                  <LazyWeeklyCoachReport profileId={data.activeProfile.id} />
                </Suspense>
                {data.learnerModel?.weeklyReview && (
                <div className="mb-4 p-4 rounded-xl bg-slate-900/95 border border-slate-700/80 space-y-3 shadow-md">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                      <ClipboardList className="w-3.5 h-3.5 text-cyan-400" />
                      Longer-Term Coach Context
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
                </>
              )}

              {trainingPending ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="py-10 text-center text-xs text-slate-400 bg-slate-900/40 rounded-xl border border-slate-800"
                >
                  <Loader2 className="w-6 h-6 text-cyan-400 animate-spin mx-auto mb-2" />
                  <p className="font-medium text-slate-300">Preparing today's recommendations...</p>
                  <p className="mt-1 text-slate-500">The rest of your dashboard is ready while Codeforces syncs in the background.</p>
                </div>
              ) : todaySet && todaySet.problems.length > 0 ? (
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
          <Suspense fallback={<div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-slate-300">Loading mastery map...</div>}>
            <LazySkillTracksView profileId={data.activeProfile.id} events={journal} />
          </Suspense>
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
          <Suspense fallback={<div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-slate-300">Loading contests...</div>}>
            <LazyContestsView
              profileId={data.activeProfile.id}
              onNavigateToPractice={() => setTab('home')}
            />
          </Suspense>
        )}

        {tab === 'journal' && (
          <Suspense fallback={<div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-slate-300">Loading knowledge journal…</div>}>
            <LazyKnowledgeJournal
              handle={data.activeProfile.handle}
              weakTopics={data.topics.weak.map((topic) => topic.tag.toLowerCase())}
            />
          </Suspense>
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
            <section className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3" aria-labelledby="install-app-title">
              <div>
                <h3 id="install-app-title" className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                  <Download className="w-4 h-4 text-cyan-400" />
                  Install Codeforces Coach
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  Add the app to your home screen for a standalone app window. Updates do not clear your browser-saved data.
                </p>
              </div>
              {appInstalled ? (
                <p className="text-xs text-emerald-300" role="status">Codeforces Coach is installed on this device.</p>
              ) : installPrompt ? (
                <button
                  type="button"
                  onClick={handleInstallApp}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Install App
                </button>
              ) : (
                <div className="text-xs text-slate-400 space-y-1">
                  <p>On Android, open this site in Chrome and use the ⋮ menu → <span className="text-slate-200">Install app</span>, or <span className="text-slate-200">Add to Home screen</span> if that is the option shown.</p>
                  <p>If neither option appears, open the HTTPS site in Chrome, load it once while online, then check the menu again. Menu wording and automatic prompts vary by browser and device.</p>
                </div>
              )}
              {installError && <p className="text-xs text-rose-300" role="alert">{installError}</p>}
            </section>
            <LazyDataBackupPanel
              enabled={isPublicMode}
              onImported={async () => { await loadAll(data.activeProfile.id); }}
            />
            <LazyNotificationsSettings profileId={data.activeProfile.id} />

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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
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
                  ? 'Each handle gets a separate plan and learning history in this browser. Adding a handle does not sign in or sync data from another device.'
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
                  <p>Feedback, notes, journal entries, reviews, and virtual-contest history are tied to the selected handle in this browser. A temporary service cache is also used to calculate recommendations and may be lost when free hosting restarts.</p>
                  <p>Data does not automatically sync to another browser or device. Clearing this browser's site data can erase the local copy, so export a backup in Settings first. The browser-generated ID is not account authentication or a guarantee of account-level privacy.</p>
                  <p>When enabled, this device's push subscription and reminder preferences are stored on the backend. The current Free Render deployment keeps notifications disabled until durable storage is configured.</p>
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
