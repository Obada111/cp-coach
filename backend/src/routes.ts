import { Router } from 'express';
import os from 'os';
import { 
  db, 
  getAllProfiles, 
  getProfileById, 
  getProfileByHandle, 
  getProfilesForOwner,
  createProfile, 
  getActiveProfileId, 
  setActiveProfileId,
  getAllCurriculumProblems,
  markProblemOpened,
  syncProfileProblemStatuses
} from './db.js';
import { codeforcesService } from './codeforcesService.js';
import { codeforcesCacheService } from './codeforcesCacheService.js';
import { analysisService } from './analysisService.js';
import { recommendationService } from './recommendationService.js';
import { contestService } from './contestService.js';
import { tutorialService } from './tutorialService.js';
import { reviewService } from './reviewService.js';
import { solveSessionService } from './solveSessionService.js';
import { problemJournalService } from './problemJournalService.js';
import { exportPublicContext, importPublicContext } from './publicContextService.js';
import { weeklyReportService } from './weeklyReportService.js';
import { notificationsService } from './notificationsService.js';
import { DashboardOverview } from './types.js';
import { PerfTrace, attachServerTiming } from './perf.js';

export const apiRouter = Router();

const DASHBOARD_REFRESH_COOLDOWN_MS = 60_000;
const lastDashboardRefreshStartedAt = new Map<string, number>();

const SOLVED_STATUSES = new Set([
  'SOLVED_INDEPENDENTLY',
  'SOLVED_WITH_HINTS',
  'VIEWED_EDITORIAL',
  'NOT_SOLVED',
]);
const PERCEIVED_DIFFICULTIES = new Set(['EASY', 'NORMAL', 'HARD']);
const DIFFICULTY_EXPERIENCES = new Set([
  'MUCH_EASIER',
  'SLIGHTLY_EASY',
  'APPROPRIATE',
  'CHALLENGING',
  'MUCH_HARDER',
]);
const SOLUTION_METHODS = new Set([
  'INDEPENDENT',
  'HINTS',
  'EDITORIAL',
  'IDEA_IMPLEMENTATION',
  'NOT_SOLVED',
]);
const STRUGGLE_REASONS = new Set([
  'KEY_OBSERVATION',
  'ALGORITHM_CHOICE',
  'PROOF',
  'IMPLEMENTATION',
  'DEBUGGING',
  'EDGE_CASES',
]);
const PROBLEM_OPINIONS = new Set([
  'USEFUL_RELEVANT',
  'INTERESTING_TOO_EASY',
  'TOO_DIFFICULT',
  'REPETITIVE_FAMILIAR',
  'POOR_FIT',
]);
const REVIEW_OUTCOMES = new Set(['MASTERED', 'EASY', 'DIFFICULT', 'DEFERRED']);
const REVIEW_SOURCES = new Set(['DAILY_STRUGGLE', 'CONTEST_STRUGGLE', 'MANUAL']);
const SESSION_OUTCOMES = new Set([
  'SOLVED_INDEPENDENTLY',
  'SOLVED_WITH_HINTS',
  'SOLVED_WITH_EDITORIAL',
  'UNSOLVED',
  'ABANDONED',
]);

function optionalAllowed(value: unknown, allowed: Set<string>): boolean {
  return value === undefined || value === null || value === '' || (typeof value === 'string' && allowed.has(value));
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Text fields must be strings');
  return value.slice(0, maxLength);
}

function optionalMinutes(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 24 * 60) {
    throw new Error('timeSpentMinutes must be an integer between 0 and 1440');
  }
  return parsed;
}

// ==========================================
// 1. Profiles API (Multi-Profile Support)
// ==========================================

// Get all profiles + current active profile
apiRouter.get('/profiles', (req, res) => {
  try {
    const profiles = getAllProfiles();
    const activeProfileId = getActiveProfileId();
    res.json({ profiles, activeProfileId });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve profiles', message: err.message });
  }
});

// Create a new profile with handle validation via Codeforces
apiRouter.post('/profiles', async (req, res) => {
  try {
    const { handle, displayName } = req.body;
    if (!handle || typeof handle !== 'string' || handle.trim().length === 0) {
      return res.status(400).json({ error: 'A valid Codeforces handle is required' });
    }

    const cleanHandle = handle.trim();

    // Check if already exists
    const existing = getProfileByHandle(cleanHandle);
    if (existing) {
      setActiveProfileId(existing.id);
      return res.json({ profile: existing, message: `Profile '${cleanHandle}' is already registered and is now selected.` });
    }

    // Validate handle against Codeforces public API
    const validation = await codeforcesService.validateHandle(cleanHandle);
    if (!validation.valid || !validation.user) {
      return res.status(400).json({
        error: validation.error || `Codeforces handle '${cleanHandle}' could not be verified. Please check spelling.`
      });
    }

    // Create profile
    const profile = createProfile(validation.user.handle, displayName || validation.user.firstName || cleanHandle);
    setActiveProfileId(profile.id);

    // Initial background sync uses the same TTL-aware, deduplicated refresh
    // path as dashboard loads and manual synchronization.
    codeforcesCacheService.autoRefreshIfNeeded(profile.id, true)
      .catch((e) => console.warn('Background sync error:', e));

    res.json({ success: true, profile, message: `Profile '${profile.handle}' created successfully!` });
  } catch (err: any) {
    console.error('Create profile error:', err);
    res.status(500).json({ error: 'Failed to create profile', message: err.message });
  }
});

// Switch active profile
apiRouter.post('/profiles/:id/select', (req, res) => {
  try {
    const profileId = req.params.id;
    const profile = getProfileById(profileId);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    setActiveProfileId(profile.id);
    res.json({ success: true, profile });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to switch profile', message: err.message });
  }
});

// Delete a profile (only if at least 1 other profile remains)
apiRouter.delete('/profiles/:id', (req, res) => {
  try {
    const profileId = req.params.id;
    const all = getAllProfiles();
    if (all.length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only remaining profile.' });
    }
    const target = getProfileById(profileId);
    if (!target) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    db.exec('BEGIN TRANSACTION');
    try {
      db.prepare('DELETE FROM daily_problems WHERE profile_id = ?').run(profileId);
      db.prepare('DELETE FROM daily_sets WHERE profile_id = ?').run(profileId);
      db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // If active profile was deleted, switch to first remaining
    const remaining = getAllProfiles();
    if (getActiveProfileId() === profileId && remaining.length > 0) {
      setActiveProfileId(remaining[0].id);
    }

    res.json({ success: true, message: `Profile '${target.handle}' removed.` });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete profile', message: err.message });
  }
});

// ==========================================
// 2. Dashboard Overview (Scoped by Profile)
// ==========================================
apiRouter.get('/dashboard', async (req, res) => {
  const trace = new PerfTrace('GET /dashboard', {
    profileId: typeof req.query.profileId === 'string' ? req.query.profileId : undefined,
  });
  try {
    trace.start('dashboard.profile');
    const profileIdQuery = req.query.profileId as string | undefined;
    const activeId = profileIdQuery || getActiveProfileId();
    let activeProfile = getProfileById(activeId);

    if (!activeProfile) {
      const all = getAllProfiles();
      activeProfile = all[0];
      if (activeProfile) setActiveProfileId(activeProfile.id);
    }

    if (!activeProfile) {
      return res.status(404).json({ error: 'No profiles available' });
    }

    const publicClientId = (req as any).publicClientId as string | undefined;
    const availableProfiles = publicClientId
      ? getProfilesForOwner(publicClientId)
      : getAllProfiles();
    const handle = activeProfile.handle;
    trace.end('dashboard.profile');

    // Track active session for background scheduler
    try {
      db.prepare("UPDATE profiles SET last_active_at = datetime('now') WHERE id = ?").run(activeProfile.id);
    } catch {}

    trace.start('dashboard.freshness');
    const cachedStatus = codeforcesCacheService.getFreshnessStatus(handle, activeProfile.id);
    trace.end('dashboard.freshness');

    // Never make the dashboard wait for Codeforces. Serve the last valid
    // snapshot immediately and refresh stale data in the background.
    const lastRefreshStartedAt = lastDashboardRefreshStartedAt.get(activeProfile.id) || 0;
    const shouldStartRefresh = !cachedStatus.isSyncing &&
      Date.now() - lastRefreshStartedAt >= DASHBOARD_REFRESH_COOLDOWN_MS && (
        cachedStatus.submissionsCount === 0 ||
        cachedStatus.dataFreshness.isAnyStale
      );
    if (shouldStartRefresh) {
      if (lastDashboardRefreshStartedAt.size > 1000) {
        const cutoff = Date.now() - DASHBOARD_REFRESH_COOLDOWN_MS * 2;
        for (const [profileId, startedAt] of lastDashboardRefreshStartedAt) {
          if (startedAt < cutoff) lastDashboardRefreshStartedAt.delete(profileId);
        }
      }
      lastDashboardRefreshStartedAt.set(activeProfile.id, Date.now());
      const syncTrace = new PerfTrace('background-sync', { profileId: activeProfile.id, handle });
      void codeforcesCacheService
        .autoRefreshIfNeeded(activeProfile.id, false, syncTrace)
        .then(() => syncTrace.log({ status: 'complete' }))
        .catch((error: unknown) => {
          syncTrace.log({ status: 'failed' });
          console.warn('[Dashboard] Background Codeforces refresh failed:', error);
        });
    }

    trace.start('dashboard.cachedData');
    const user = codeforcesService.getCachedProfile(handle);
    const ratingHistory = codeforcesService.getCachedRatingHistory(handle);
    const userRating = user?.rating || activeProfile.rating || 1300;
    trace.end('dashboard.cachedData');

    trace.start('dashboard.topics');
    const allTopics = analysisService.analyzeTopics(handle, userRating, activeProfile.id);
    const weak = allTopics.filter((t) => t.status === 'WEAK');
    const strong = allTopics.filter((t) => t.status === 'STRONG');
    const unexplored = allTopics.filter((t) => t.status === 'UNEXPLORED');
    trace.end('dashboard.topics');

    // Generating a new recommendation while submissions or the candidate pool
    // are stale could surface a problem the learner has already solved. Keep
    // the existing set (restored from the browser) and wait for the background
    // refresh before creating a new one.
    let todaySet: DashboardOverview['todaySet'] = null;
    const date = recommendationService.getTodayDateString();
    const existingSet = db.prepare(
      'SELECT 1 AS present FROM daily_sets WHERE profile_id = ? AND date = ?'
    ).get(activeProfile.id, date);
    const canGenerateDailySet = Boolean(existingSet) || (
      !cachedStatus.isSyncing &&
      cachedStatus.submissionsCount > 0 &&
      cachedStatus.problemsCount >= 100 &&
      !cachedStatus.dataFreshness.isSubmissionsStale &&
      !cachedStatus.dataFreshness.isProblemsetStale
    );
    if (canGenerateDailySet) {
      trace.start('dashboard.dailySet');
      try {
        todaySet = recommendationService.getOrGenerateDailySet(activeProfile.id);
      } catch (dailyError) {
        console.warn('[Dashboard] Daily set is not available yet:', dailyError);
      }
      trace.end('dashboard.dailySet');
    }

    trace.start('dashboard.learnerModel');
    const streakDays = recommendationService.calculateStreak(activeProfile.id);
    const learnerModel = analysisService.getOrComputeLearnerModel(activeProfile.id, handle, userRating);
    trace.end('dashboard.learnerModel');

    const syncStatus = {
      ...cachedStatus,
      isSyncing: cachedStatus.isSyncing || shouldStartRefresh,
    };

    const overview: DashboardOverview = {
      activeProfile,
      availableProfiles,
      user,
      ratingHistory,
      streakDays,
      distinctSolvedCount: syncStatus.solvedDistinctCount,
      topics: {
        weak,
        strong,
        unexplored,
        all: allTopics,
      },
      todaySet,
      syncStatus,
      learnerModel,
    };

    trace.log({
      todaySetReady: Boolean(todaySet),
      refreshScheduled: shouldStartRefresh,
      cachedIsStale: cachedStatus.dataFreshness.isAnyStale,
    });
    attachServerTiming(trace, res);
    res.json(overview);
  } catch (err: any) {
    trace.log({ status: 'failed', error: err?.message });
    console.error('Error generating dashboard data:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ==========================================
// 3. Daily Problems & History (Profile Scoped)
// ==========================================
apiRouter.get('/daily', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const date = (req.query.date as string) || undefined;
    const dailySet = recommendationService.getOrGenerateDailySet(profileId, date);
    res.json(dailySet);
  } catch (err: any) {
    console.error('Error getting daily set:', err);
    res.status(500).json({ error: 'Failed to get daily set', message: err.message });
  }
});

apiRouter.post('/problems/:id/open', (req, res) => {
  try {
    const problemId = req.params.id;
    const result = markProblemOpened(problemId);
    if (!result.success) {
      return res.status(404).json({ error: 'Daily problem assignment not found' });
    }
    // Opening a recommendation is the first durable learning-journal event.
    // The stable key makes repeated clicks/retries idempotent and keeps this
    // encounter separate from later self-reported feedback or verified AC.
    if (result.problem) {
      problemJournalService.record({
        profileId: result.problem.profile_id,
        problemId: result.problem.problem_id,
        source: 'DAILY_ENCOUNTER',
        sourceKey: `daily_open_${problemId}`,
      });
    }
    res.json({ success: true, message: 'Problem marked as opened (not solved)', problem: result.problem });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record problem open event', message: err.message });
  }
});

apiRouter.post('/problems/:id/feedback', (req, res) => {
  try {
    const problemId = req.params.id;
    const {
      solvedStatus,
      perceivedDifficulty,
      difficultyExperience,
      solutionMethod,
      timeSpentMinutes,
      notes,
      struggleReason,
      problemOpinion,
    } = req.body;

    if (!solvedStatus) {
      return res.status(400).json({ error: 'solvedStatus is required' });
    }
    if (!SOLVED_STATUSES.has(solvedStatus)) {
      return res.status(400).json({ error: 'Invalid solvedStatus' });
    }
    if (!optionalAllowed(perceivedDifficulty, PERCEIVED_DIFFICULTIES)) {
      return res.status(400).json({ error: 'Invalid perceivedDifficulty' });
    }
    if (!optionalAllowed(difficultyExperience, DIFFICULTY_EXPERIENCES)) {
      return res.status(400).json({ error: 'Invalid difficultyExperience' });
    }
    if (!optionalAllowed(solutionMethod, SOLUTION_METHODS)) {
      return res.status(400).json({ error: 'Invalid solutionMethod' });
    }
    if (!optionalAllowed(struggleReason, STRUGGLE_REASONS)) {
      return res.status(400).json({ error: 'Invalid struggleReason' });
    }
    if (!optionalAllowed(problemOpinion, PROBLEM_OPINIONS)) {
      return res.status(400).json({ error: 'Invalid problemOpinion' });
    }

    let parsedTimeSpent: number | null;
    let cleanNotes: string | null;
    try {
      parsedTimeSpent = optionalMinutes(timeSpentMinutes);
      cleanNotes = optionalText(notes, 5000);
    } catch (validationError: any) {
      return res.status(400).json({ error: validationError.message });
    }

    const updated = recommendationService.saveFeedback(problemId, {
      solvedStatus,
      perceivedDifficulty: perceivedDifficulty || null,
      difficultyExperience: difficultyExperience || null,
      solutionMethod: solutionMethod || null,
      timeSpentMinutes: parsedTimeSpent,
      notes: cleanNotes,
      struggleReason: struggleReason || null,
      problemOpinion: problemOpinion || null,
    });

    if (!updated) {
      return res.status(404).json({ error: 'Daily problem assignment not found' });
    }

    res.json({ success: true, problem: updated });
  } catch (err: any) {
    console.error('Error saving feedback:', err);
    res.status(500).json({ error: 'Failed to save feedback', message: err.message });
  }
});

// ==========================================
// 3b. Educational Curriculum & Learner State
// ==========================================
apiRouter.get('/curriculum', (req, res) => {
  try {
    const problems = getAllCurriculumProblems();
    res.json(problems);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch curriculum problems' });
  }
});

// Masterclass Tutorial & Progressive Hints Endpoint
apiRouter.get('/tutorial/:problemId', (req, res) => {
  try {
    const { problemId } = req.params;
    const tutorial = tutorialService.getTutorial(problemId);
    res.json(tutorial);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch tutorial', message: err.message });
  }
});

apiRouter.get('/contests/:contestId/problems/:problemIndex/tutorial', (req, res) => {
  try {
    const contestId = parseInt(req.params.contestId, 10);
    const { problemIndex } = req.params;
    const tutorial = tutorialService.getContestProblemTutorial(contestId, problemIndex);
    res.json(tutorial);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch contest problem tutorial', message: err.message });
  }
});

apiRouter.get('/learner', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const profile = getProfileById(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const model = analysisService.getOrComputeLearnerModel(profileId, profile.handle, profile.rating || 1300);
    res.json(model);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get learner model' });
  }
});

apiRouter.get('/history', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 30;
    const history = recommendationService.getHistory(profileId, limit);
    res.json(history);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve training history' });
  }
});

apiRouter.get('/journal', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    if (!getProfileById(profileId)) return res.status(404).json({ error: 'Profile not found' });
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    res.json(problemJournalService.getForProfile(profileId, limit));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve problem learning journal', message: err.message });
  }
});

// Versioned browser/local backup. The public API exposes the same underlying
// snapshot through /api/public/context; this route supports local mode.
apiRouter.get('/context', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    if (!getProfileById(profileId)) return res.status(404).json({ error: 'Profile not found' });
    res.json(exportPublicContext(profileId));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to export backup', message: err.message });
  }
});

apiRouter.post('/context', (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    if (!getProfileById(profileId)) return res.status(404).json({ error: 'Profile not found' });
    const mode = req.body?.mode;
    if (mode !== undefined && mode !== 'merge' && mode !== 'replace') {
      return res.status(400).json({ error: 'Import mode must be merge or replace' });
    }
    const context = req.body?.context ?? req.body;
    res.json(importPublicContext(profileId, context, { mode: mode || 'merge' }));
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to restore backup' });
  }
});

// ==========================================
// 4. Synchronization
// ==========================================
apiRouter.post('/sync', async (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const profile = getProfileById(profileId);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Force refresh bypassing TTLs
    const syncStatus = await codeforcesCacheService.autoRefreshIfNeeded(profile.id, true);
    syncProfileProblemStatuses(profile.id, profile.handle);
    res.json({
      success: !syncStatus.error,
      message: syncStatus.error
        ? `Sync completed with notice: ${syncStatus.error}`
        : `Successfully synchronized ${profile.handle} from Codeforces`,
      syncStatus,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Synchronization failed', message: err.message });
  }
});

// Network information for LAN / sharing with friends
apiRouter.get('/network-info', (req, res) => {
  try {
    const publicUrl = process.env.PUBLIC_URL?.trim() || null;
    const interfaces = os.networkInterfaces();
    const lanIps: string[] = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          lanIps.push(iface.address);
        }
      }
    }

    res.json({
      publicUrl,
      localUrl: 'http://localhost:5173',
      lanUrls: lanIps.map((ip) => `http://${ip}:5173`),
      lanIps,
      frontendPort: 5173,
      backendPort: 3001,
      recommendation: publicUrl
        ? `Share ${publicUrl} with friends — accessible from anywhere.`
        : lanIps.length > 0
          ? `Share http://${lanIps[0]}:5173 with friends on the same Wi-Fi network.`
          : 'Connect to Wi-Fi to obtain a shareable LAN address.',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve network info', message: err.message });
  }
});

apiRouter.get('/sync/status', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const profile = getProfileById(profileId);
    const handle = profile ? profile.handle : 'Obadajo';
    const status = codeforcesCacheService.getFreshnessStatus(handle, profile?.id);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// ==========================================
// 5. Contests API
// ==========================================

// Get all detected/imported contests for profile (auto-refreshes if > 2 hours stale)
apiRouter.get('/contests', async (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    await codeforcesCacheService.autoRefreshContestsIfNeeded(profileId, false);
    const contests = contestService.getContestList(profileId);
    res.json(contests);
  } catch (err: any) {
    console.error('Error fetching contests:', err);
    res.status(500).json({ error: 'Failed to fetch contests', message: err.message });
  }
});

// Trigger explicit contest sync
apiRouter.post('/contests/sync', async (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    await codeforcesCacheService.autoRefreshContestsIfNeeded(profileId, true);
    const contests = contestService.getContestList(profileId);
    res.json({ success: true, count: contests.length, contests });
  } catch (err: any) {
    console.error('Error syncing contests:', err);
    res.status(500).json({ error: 'Failed to sync contests', message: err.message });
  }
});

apiRouter.get('/contests/upcoming', async (_req, res) => {
  try {
    const contests = await codeforcesService.getOfficialContests();
    if (!Array.isArray(contests)) {
      return res.json([]);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const upcoming = contests
      .filter((contest) => contest && typeof contest.id === 'number' && contest.id > 0 && contest.startTimeSeconds > nowSeconds)
      .sort((a, b) => Number(a.startTimeSeconds) - Number(b.startTimeSeconds))
      .slice(0, 6)
      .map((contest) => ({
        id: contest.id,
        name: contest.name,
        startTimeSeconds: contest.startTimeSeconds,
        durationSeconds: contest.durationSeconds || 7200,
        phase: contest.phase || 'BEFORE',
        url: `https://codeforces.com/contest/${contest.id}`,
      }));

    res.json(upcoming);
  } catch (err: any) {
    console.error('Error fetching upcoming contests:', err);
    res.status(500).json({ error: 'Failed to fetch upcoming contest list', message: err.message });
  }
});

// Manually import a contest by ID or URL
apiRouter.post('/contests/import', async (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const { input } = req.body;
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'Contest ID or Codeforces URL is required' });
    }

    const postMortem = await contestService.importContest(profileId, input);
    res.json({ success: true, report: postMortem });
  } catch (err: any) {
    console.error('Error importing contest:', err);
    res.status(400).json({ error: err.message || 'Failed to import contest' });
  }
});

// Get detailed post-mortem report for a contest
apiRouter.get('/contests/:contestId', async (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const contestId = parseInt(req.params.contestId, 10);
    if (isNaN(contestId)) {
      return res.status(400).json({ error: 'Invalid contest ID' });
    }

    const report = await contestService.getContestPostMortem(profileId, contestId);
    res.json(report);
  } catch (err: any) {
    console.error('Error generating contest post-mortem:', err);
    res.status(404).json({ error: 'Contest not found', message: err.message });
  }
});

// Save problem self-review and/or upsolving status
apiRouter.post('/contests/:contestId/review', async (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const contestId = parseInt(req.params.contestId, 10);
    const { problemIndex, selfReviewTag, selfReviewNotes, upsolveStatus } = req.body;

    if (!problemIndex) {
      return res.status(400).json({ error: 'problemIndex is required' });
    }

    const report = await contestService.saveProblemReview(profileId, contestId, problemIndex, {
      selfReviewTag,
      selfReviewNotes,
      upsolveStatus,
    });

    res.json({ success: true, report });
  } catch (err: any) {
    console.error('Error saving problem review:', err);
    res.status(500).json({ error: 'Failed to save review', message: err.message });
  }
});

// ==========================================
// 8. Health Check
// ==========================================
apiRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    memoryUsageMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
  });
});

// ==========================================
// 9. Skill Tracks & Evidence-Based Mastery
// ==========================================
apiRouter.get('/skill-tracks', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const profile = getProfileById(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const userRating = profile.rating && profile.rating > 0 ? profile.rating : 1300;
    const date = (req.query.date as string) || recommendationService.getTodayDateString();

    const skillTracks = analysisService.computeSkillTracks(profile.handle, userRating, profileId, date);
    res.json({ skillTracks, profileId, handle: profile.handle });
  } catch (err: any) {
    console.error('Error computing skill tracks:', err);
    res.status(500).json({ error: 'Failed to compute skill tracks', message: err.message });
  }
});

apiRouter.get('/weekly-report', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const profile = getProfileById(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)))) {
      return res.status(400).json({ error: 'Date must use YYYY-MM-DD format' });
    }
    res.json(weeklyReportService.getReport(profileId, date));
  } catch (err: any) {
    console.error('Error generating weekly coach report:', err);
    res.status(500).json({ error: 'Failed to generate weekly report', message: err.message });
  }
});

// ==========================================
// 10. Weekly Goals & Progression Tracking
// ==========================================
function getWeekStartDate(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0, 10);
}

function getOrInitWeeklyGoal(profileId: string, weekStart?: string) {
  const weekStartDate = weekStart || getWeekStartDate();
  let row = db.prepare('SELECT * FROM weekly_goals WHERE profile_id = ? AND week_start_date = ?').get(profileId, weekStartDate) as any;
  if (!row) {
    const id = `wg_${profileId}_${weekStartDate}`;
    db.prepare(`
      INSERT INTO weekly_goals (id, profile_id, week_start_date, target_solves, target_contests, target_upsolves, focus_topics, notes, updated_at)
      VALUES (?, ?, ?, 15, 1, 3, '[]', '', datetime('now'))
    `).run(id, profileId, weekStartDate);
    row = db.prepare('SELECT * FROM weekly_goals WHERE id = ?').get(id) as any;
  }

  const solvesRow = db.prepare(`
    SELECT COUNT(*) as c FROM daily_problems
    WHERE profile_id = ? AND daily_set_date >= ? AND (completed = 1 OR verified_cf_ac = 1 OR (solved_status IS NOT NULL AND solved_status != 'NOT_SOLVED'))
  `).get(profileId, weekStartDate) as { c: number };

  const contestsRow = db.prepare(`
    SELECT COUNT(*) as c FROM user_contests
    WHERE profile_id = ? AND date(created_at) >= ?
  `).get(profileId, weekStartDate) as { c: number };

  const streakDays = recommendationService.calculateStreak(profileId);
  const actualSolvesCount = solvesRow?.c || 0;
  const actualContestsCount = contestsRow?.c || 0;
  const targetSolves = row.target_solves || 15;
  const targetContests = row.target_contests || 1;
  const status = (actualSolvesCount >= targetSolves && actualContestsCount >= targetContests) ? 'ACHIEVED' : 'IN_PROGRESS';

  let focusTopics: string[] = [];
  try { focusTopics = JSON.parse(row.focus_topics || '[]'); } catch {}

  return {
    id: row.id,
    profileId: row.profile_id,
    weekStartDate: row.week_start_date,
    targetSolvesCount: targetSolves,
    targetContestsCount: targetContests,
    focusTopic: focusTopics[0] || null,
    targetRatingFloor: row.target_rating_floor ?? null,
    actualSolvesCount,
    actualContestsCount,
    currentStreakDays: streakDays,
    status,
    updatedAt: row.updated_at,
  };
}

apiRouter.get('/weekly-goals', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const weekStart = req.query.weekStart as string | undefined;
    const goal = getOrInitWeeklyGoal(profileId, weekStart);
    res.json(goal);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve weekly goals', message: err.message });
  }
});

apiRouter.post('/weekly-goals', (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const { targetSolvesCount, targetContestsCount, focusTopic, weekStartDate } = req.body;
    const weekStart = weekStartDate || getWeekStartDate();

    const existing = db.prepare('SELECT id FROM weekly_goals WHERE profile_id = ? AND week_start_date = ?').get(profileId, weekStart) as any;
    const focusTopicsJson = JSON.stringify(focusTopic ? [focusTopic] : []);

    if (existing) {
      db.prepare(`
        UPDATE weekly_goals
        SET target_solves = COALESCE(?, target_solves),
            target_contests = COALESCE(?, target_contests),
            focus_topics = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(targetSolvesCount ?? null, targetContestsCount ?? null, focusTopicsJson, existing.id);
    } else {
      const id = `wg_${profileId}_${weekStart}`;
      db.prepare(`
        INSERT INTO weekly_goals (id, profile_id, week_start_date, target_solves, target_contests, target_upsolves, focus_topics, updated_at)
        VALUES (?, ?, ?, ?, ?, 3, ?, datetime('now'))
      `).run(id, profileId, weekStart, targetSolvesCount || 15, targetContestsCount || 1, focusTopicsJson);
    }

    const updated = getOrInitWeeklyGoal(profileId, weekStart);
    res.json({ success: true, weeklyGoal: updated });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update weekly goal', message: err.message });
  }
});

// ==========================================
// 11. Unified Training Plan
// ==========================================
apiRouter.get('/training-plan', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const profile = getProfileById(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const userRating = profile.rating && profile.rating > 0 ? profile.rating : 1300;
    const date = (req.query.date as string) || recommendationService.getTodayDateString();

    const dailySet = recommendationService.getOrGenerateDailySet(profileId, date);
    const dueReviews = reviewService.getDueReviews(profileId, 5);
    const weeklyGoal = getOrInitWeeklyGoal(profileId);
    const topics = analysisService.analyzeTopics(profile.handle, userRating, profileId, date);
    const skillTracks = analysisService.computeSkillTracks(profile.handle, userRating, profileId, date);

    const weakTopics = topics.filter((t) => t.status === 'WEAK');
    const improvingTopics = topics.filter((t) => t.recentTrend === 'IMPROVING');

    const primaryWeakness = weakTopics[0]?.displayName || weakTopics[0]?.tag || 'core problem solving';
    const recommendedFocus = `Priority training focus: Master '${primaryWeakness}' patterns through calibrated daily drills and spaced repetition consolidation.`;

    const plan = {
      date,
      profileId: profile.id,
      handle: profile.handle,
      currentRating: userRating,
      streakDays: recommendationService.calculateStreak(profile.id),
      dailyProblems: dailySet.problems,
      dueReviews,
      weeklyGoal,
      topWeaknesses: weakTopics.slice(0, 3),
      improvingTopics: improvingTopics.slice(0, 3),
      skillTracks,
      recommendedFocus,
    };

    res.json(plan);
  } catch (err: any) {
    console.error('Error generating training plan:', err);
    res.status(500).json({ error: 'Failed to generate training plan', message: err.message });
  }
});

// ==========================================
// 12. Daily Recommendation Replacement (Reroll)
// ==========================================
apiRouter.post('/daily/replace', (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const { dailyProblemId, date } = req.body;
    if (!dailyProblemId) {
      return res.status(400).json({ error: 'dailyProblemId is required' });
    }

    const replaced = recommendationService.replaceDailyProblem(profileId, dailyProblemId, date);
    res.json({ success: true, problem: replaced });
  } catch (err: any) {
    console.error('Error replacing daily problem:', err);
    res.status(500).json({ error: 'Failed to replace problem', message: err.message });
  }
});

// ==========================================
// 13. Spaced Repetition (Review Queue)
// ==========================================
apiRouter.get('/reviews', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const dueReviews = reviewService.getDueReviews(profileId, 10);
    const summary = reviewService.getQueueSummary(profileId);
    res.json({ dueReviews, summary });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve review queue', message: err.message });
  }
});

apiRouter.post('/reviews/enqueue', (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const { problemId, triggerReason, source } = req.body;
    if (!problemId || typeof problemId !== 'string') {
      return res.status(400).json({ error: 'problemId is required' });
    }
    if (source !== undefined && !REVIEW_SOURCES.has(source)) {
      return res.status(400).json({ error: 'Invalid review source' });
    }
    let cleanReason = 'Manual review request';
    try {
      cleanReason = optionalText(triggerReason, 500) || cleanReason;
    } catch (validationError: any) {
      return res.status(400).json({ error: validationError.message });
    }

    const item = reviewService.enqueueProblem(profileId, problemId, cleanReason, source || 'MANUAL');
    res.json({ success: true, reviewItem: item });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to enqueue review item', message: err.message });
  }
});

apiRouter.post('/reviews/:problemId/action', (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const problemId = req.params.problemId;
    const { outcome, notes } = req.body;
    if (!outcome) return res.status(400).json({ error: 'outcome is required (MASTERED, EASY, DIFFICULT, DEFERRED)' });
    if (!REVIEW_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: 'Invalid review outcome' });
    }
    let cleanNotes: string | null;
    try {
      cleanNotes = optionalText(notes, 5000);
    } catch (validationError: any) {
      return res.status(400).json({ error: validationError.message });
    }

    const item = reviewService.recordReviewOutcome(profileId, problemId, outcome, cleanNotes || undefined);
    res.json({ success: true, reviewItem: item });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record review outcome', message: err.message });
  }
});

// Send contest problem to spaced repetition
apiRouter.post('/contests/:contestId/problems/:problemIndex/send-to-review', (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const contestId = parseInt(req.params.contestId, 10);
    const problemIndex = req.params.problemIndex;
    const problemId = `${contestId}_${problemIndex}`;
    const triggerReason = req.body.triggerReason || `Enqueued from contest ${contestId} problem ${problemIndex}`;

    const reviewItem = reviewService.enqueueProblem(
      profileId,
      problemId,
      triggerReason,
      'CONTEST_STRUGGLE'
    );
    res.json({ success: true, reviewItem });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to enqueue contest problem to review', message: err.message });
  }
});

// ==========================================
// 14. Live Solve Sessions & Reflections
// ==========================================
apiRouter.post('/sessions/start', (req, res) => {
  try {
    const profileId = req.body.profileId || (req.query.profileId as string) || getActiveProfileId();
    const { problemId } = req.body;
    if (!problemId || typeof problemId !== 'string') {
      return res.status(400).json({ error: 'problemId is required' });
    }

    const session = solveSessionService.startSession(profileId, problemId);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to start solve session', message: err.message });
  }
});

apiRouter.post('/sessions/:id/hint', (req, res) => {
  try {
    solveSessionService.recordHintRevealed(req.params.id);
    const session = solveSessionService.getSessionById(req.params.id);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record hint revealed', message: err.message });
  }
});

apiRouter.post('/sessions/:id/editorial', (req, res) => {
  try {
    solveSessionService.recordEditorialViewed(req.params.id);
    const session = solveSessionService.getSessionById(req.params.id);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record editorial viewed', message: err.message });
  }
});

apiRouter.post('/sessions/:id/finish', (req, res) => {
  try {
    const payload = req.body || {};
    if (payload.outcome !== undefined && !SESSION_OUTCOMES.has(payload.outcome)) {
      return res.status(400).json({ error: 'Invalid session outcome' });
    }
    if (!optionalAllowed(payload.perceivedDifficulty, PERCEIVED_DIFFICULTIES)) {
      return res.status(400).json({ error: 'Invalid perceivedDifficulty' });
    }
    if (!optionalAllowed(payload.struggleType, STRUGGLE_REASONS)) {
      return res.status(400).json({ error: 'Invalid struggleType' });
    }
    if (payload.activeDurationSeconds !== undefined) {
      const seconds = Number(payload.activeDurationSeconds);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 24 * 60 * 60) {
        return res.status(400).json({ error: 'Invalid activeDurationSeconds' });
      }
    }
    let keyTakeaway: string | null;
    let reflectionNotes: string | null;
    try {
      keyTakeaway = optionalText(payload.keyTakeaway, 3000);
      reflectionNotes = optionalText(payload.reflectionNotes, 5000);
    } catch (validationError: any) {
      return res.status(400).json({ error: validationError.message });
    }

    const session = solveSessionService.finishSession(req.params.id, {
      ...payload,
      outcome: payload.outcome,
      perceivedDifficulty: payload.perceivedDifficulty || undefined,
      struggleType: payload.struggleType || undefined,
      keyTakeaway: keyTakeaway || undefined,
      reflectionNotes: reflectionNotes || undefined,
    });
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to finish session', message: err.message });
  }
});

apiRouter.get('/sessions/analytics', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    const analytics = solveSessionService.getSessionAnalytics(profileId);
    res.json(analytics);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve session analytics', message: err.message });
  }
});

apiRouter.get('/notifications/config', (_req, res) => {
  res.json(notificationsService.getPublicConfig());
});

apiRouter.get('/notifications/subscriptions/status', (req, res) => {
  const profileId = (req.query.profileId as string) || getActiveProfileId();
  if (!getProfileById(profileId)) return res.status(404).json({ error: 'Profile not found' });
  res.json({
    registered: notificationsService.hasSubscription(profileId, profileId, req.query.endpoint),
  });
});

apiRouter.get('/notifications/settings', (req, res) => {
  try {
    const profileId = (req.query.profileId as string) || getActiveProfileId();
    if (!getProfileById(profileId)) return res.status(404).json({ error: 'Profile not found' });
    res.json({
      available: notificationsService.isAvailable(),
      settings: notificationsService.getSettings(profileId),
    });
  } catch (err) {
    console.error('Failed to load notification settings:', err);
    res.status(500).json({ error: 'Could not load notification settings' });
  }
});

apiRouter.put('/notifications/settings', (req, res) => {
  try {
    const profileId = (req.body?.profileId as string) || (req.query.profileId as string) || getActiveProfileId();
    if (!getProfileById(profileId)) return res.status(404).json({ error: 'Profile not found' });
    const settings = notificationsService.updateSettings(profileId, {
      contestReminders: req.body?.contestReminders,
      dailyReminders: req.body?.dailyReminders,
      reminderTime: req.body?.reminderTime,
    });
    res.json({ success: true, settings });
  } catch (err: any) {
    const expected = new Set([
      'Reminder time must use 24-hour HH:mm format',
      'Reminder settings must be boolean values',
    ]);
    if (expected.has(err?.message)) return res.status(400).json({ error: err.message });
    console.error('Failed to update notification settings:', err);
    res.status(500).json({ error: 'Could not update notification settings' });
  }
});

apiRouter.post('/notifications/subscriptions', (req, res) => {
  if (!notificationsService.isAvailable()) {
    return res.status(503).json({ error: 'Push notifications are not configured for this deployment' });
  }
  try {
    const profileId = (req.body?.profileId as string) || (req.query.profileId as string) || getActiveProfileId();
    if (!getProfileById(profileId)) return res.status(404).json({ error: 'Profile not found' });
    notificationsService.registerSubscription(profileId, profileId, req.body?.subscription);
    res.status(201).json({ success: true });
  } catch (err: any) {
    if (
      err?.message === 'A valid HTTPS push subscription is required' ||
      err?.message === 'This device is already registered to another profile'
    ) {
      return res.status(err.message.startsWith('This device') ? 409 : 400).json({ error: err.message });
    }
    console.error('Failed to register push subscription:', err);
    res.status(500).json({ error: 'Could not register this device for push notifications' });
  }
});

apiRouter.delete('/notifications/subscriptions', (req, res) => {
  try {
    const profileId = (req.body?.profileId as string) || (req.query.profileId as string) || getActiveProfileId();
    if (!getProfileById(profileId)) return res.status(404).json({ error: 'Profile not found' });
    notificationsService.removeSubscription(profileId, profileId, req.body?.endpoint);
    res.json({ success: true });
  } catch (err: any) {
    if (err?.message === 'A valid push endpoint is required') return res.status(400).json({ error: err.message });
    console.error('Failed to remove push subscription:', err);
    res.status(500).json({ error: 'Could not remove this device subscription' });
  }
});
