import { db, getProfileById } from './db.js';
import { reviewService } from './reviewService.js';
import { problemJournalService } from './problemJournalService.js';

export interface SolveSession {
  id: string;
  profileId: string;
  problemId: string;
  problemName: string;
  problemRating: number | null;
  tags: string[];
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  activeDurationSeconds: number;
  hintsRevealed: number;
  editorialViewed: boolean;
  outcome: 'IN_PROGRESS' | 'SOLVED_INDEPENDENTLY' | 'SOLVED_WITH_HINTS' | 'SOLVED_WITH_EDITORIAL' | 'UNSOLVED' | 'ABANDONED';
  verifiedAc: boolean;
  perceivedDifficulty: string | null;
  struggleType: string | null;
  keyTakeaway: string | null;
  reflectionNotes: string | null;
  createdAt: string;
}

export interface SessionAnalytics {
  totalSessions: number;
  completedSessions: number;
  totalPracticeMinutes: number;
  independentSolveRate: number; // percentage
  hintDependenceRate: number;    // percentage
  averageSolvingMinutes: number;
  timeByRatingBracket: {
    bracket: string;
    avgMinutes: number;
    sessionsCount: number;
  }[];
  struggleBreakdown: {
    struggleType: string;
    label: string;
    count: number;
    percentage: number;
  }[];
  recentTakeaways: {
    problemId: string;
    problemName: string;
    takeaway: string;
    date: string;
  }[];
}

export class SolveSessionService {
  /**
   * Start a live focused solve session for a problem
   */
  startSession(profileId: string, problemId: string): SolveSession {
    const profile = getProfileById(profileId);
    if (!profile) throw new Error(`Profile '${profileId}' not found`);

    const probRow = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId) as any;
    const problemName = probRow?.name || `Problem ${problemId}`;
    const problemRating = probRow?.rating ?? null;
    const tagsJson = probRow?.tags || '[]';

    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO solve_sessions (
        id, profile_id, problem_id, problem_name, problem_rating, tags,
        started_at, duration_seconds, active_duration_seconds, hints_revealed,
        editorial_viewed, outcome, verified_ac, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'IN_PROGRESS', 0, datetime('now'), datetime('now'))
    `).run(sessionId, profileId, problemId, problemName, problemRating, tagsJson, nowIso);

    return this.getSessionById(sessionId)!;
  }

  /**
   * Retrieve session by ID
   */
  getSessionById(sessionId: string): SolveSession | null {
    const row = db.prepare('SELECT * FROM solve_sessions WHERE id = ?').get(sessionId) as any;
    if (!row) return null;

    let tags: string[] = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch {}

    return {
      id: row.id,
      profileId: row.profile_id,
      problemId: row.problem_id,
      problemName: row.problem_name,
      problemRating: row.problem_rating,
      tags,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationSeconds: row.duration_seconds,
      activeDurationSeconds: row.active_duration_seconds,
      hintsRevealed: row.hints_revealed,
      editorialViewed: Boolean(row.editorial_viewed),
      outcome: row.outcome,
      verifiedAc: Boolean(row.verified_ac),
      perceivedDifficulty: row.perceived_difficulty,
      struggleType: row.struggle_type,
      keyTakeaway: row.key_takeaway,
      reflectionNotes: row.reflection_notes,
      createdAt: row.created_at,
    };
  }

  /**
   * Record that a progressive hint was revealed during session
   */
  recordHintRevealed(sessionId: string): void {
    db.prepare(`
      UPDATE solve_sessions
      SET hints_revealed = hints_revealed + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId);
  }

  /**
   * Record that the editorial / full solution was viewed
   */
  recordEditorialViewed(sessionId: string): void {
    db.prepare(`
      UPDATE solve_sessions
      SET editorial_viewed = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId);
  }

  /**
   * Complete and record post-solve reflection
   */
  finishSession(
    sessionId: string,
    payload: {
      outcome?: 'SOLVED_INDEPENDENTLY' | 'SOLVED_WITH_HINTS' | 'SOLVED_WITH_EDITORIAL' | 'UNSOLVED' | 'ABANDONED';
      activeDurationSeconds?: number;
      perceivedDifficulty?: string;
      struggleType?: string;
      keyTakeaway?: string;
      reflectionNotes?: string;
    }
  ): SolveSession {
    const session = this.getSessionById(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);

    const now = Date.now();
    const startMs = new Date(session.startedAt).getTime();
    const durationSeconds = Math.max(0, Math.floor((now - startMs) / 1000));
    const activeDuration = payload.activeDurationSeconds ?? durationSeconds;
    const endedAtIso = new Date().toISOString();

    // Check if user has verified AC in submissions table
    const profile = getProfileById(session.profileId);
    let isVerifiedAc = 0;
    if (profile) {
      const acRow = db.prepare("SELECT id FROM submissions WHERE handle = ? AND problem_id = ? AND verdict = 'OK'").get(profile.handle, session.problemId);
      isVerifiedAc = acRow ? 1 : 0;
    }

    const determinedOutcome = payload.outcome || (isVerifiedAc ? (session.hintsRevealed > 0 ? 'SOLVED_WITH_HINTS' : 'SOLVED_INDEPENDENTLY') : 'UNSOLVED');

    db.prepare(`
      UPDATE solve_sessions
      SET 
        ended_at = ?,
        duration_seconds = ?,
        active_duration_seconds = ?,
        outcome = ?,
        verified_ac = ?,
        perceived_difficulty = ?,
        struggle_type = ?,
        key_takeaway = ?,
        reflection_notes = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      endedAtIso,
      durationSeconds,
      activeDuration,
      determinedOutcome,
      isVerifiedAc,
      payload.perceivedDifficulty || null,
      payload.struggleType || 'NONE',
      payload.keyTakeaway || null,
      payload.reflectionNotes || null,
      sessionId
    );

    problemJournalService.record({
      profileId: session.profileId,
      problemId: session.problemId,
      source: 'SOLVE_SESSION',
      solvedStatus: determinedOutcome,
      perceivedDifficulty: payload.perceivedDifficulty || null,
      struggleReason: payload.struggleType && payload.struggleType !== 'NONE' ? payload.struggleType : null,
      notes: [payload.keyTakeaway, payload.reflectionNotes].filter(Boolean).join('\n\n') || null,
      verifiedAc: isVerifiedAc === 1,
      hintsRevealed: session.hintsRevealed,
      editorialViewed: session.editorialViewed,
    });

    // Auto-enqueue for spaced repetition if struggle occurred
    const hadStruggle = 
      determinedOutcome === 'SOLVED_WITH_HINTS' ||
      determinedOutcome === 'SOLVED_WITH_EDITORIAL' ||
      determinedOutcome === 'UNSOLVED' ||
      payload.perceivedDifficulty === 'HARD' ||
      (payload.struggleType && payload.struggleType !== 'NONE');

    if (hadStruggle) {
      const reason = payload.struggleType && payload.struggleType !== 'NONE'
        ? `Struggled with ${payload.struggleType.replace(/_/g, ' ').toLowerCase()}`
        : `Solve outcome: ${determinedOutcome.replace(/_/g, ' ').toLowerCase()}`;

      try {
        reviewService.enqueueProblem(session.profileId, session.problemId, reason, 'DAILY_STRUGGLE');
      } catch (e) {
        console.warn('[SolveSessionService] Could not enqueue to review:', e);
      }
    }

    return this.getSessionById(sessionId)!;
  }

  /**
   * Compute evidence-based analytics across all recorded solve sessions
   */
  getSessionAnalytics(profileId: string): SessionAnalytics {
    const rows = db.prepare(`
      SELECT * FROM solve_sessions
      WHERE profile_id = ? AND outcome != 'IN_PROGRESS'
      ORDER BY started_at DESC
    `).all(profileId) as any[];

    const totalSessions = rows.length;
    if (totalSessions === 0) {
      return {
        totalSessions: 0,
        completedSessions: 0,
        totalPracticeMinutes: 0,
        independentSolveRate: 0,
        hintDependenceRate: 0,
        averageSolvingMinutes: 0,
        timeByRatingBracket: [],
        struggleBreakdown: [],
        recentTakeaways: [],
      };
    }

    let totalSeconds = 0;
    let independentSolves = 0;
    let hintSolves = 0;
    let completedSolves = 0;

    const bracketStats = new Map<string, { totalSec: number; count: number }>();
    for (const b of ['< 1200', '1200 - 1399', '1400 - 1599', '1600+']) {
      bracketStats.set(b, { totalSec: 0, count: 0 });
    }

    const struggleCounts = new Map<string, number>();

    for (const r of rows) {
      const activeSec = r.active_duration_seconds || r.duration_seconds || 0;
      totalSeconds += activeSec;

      if (r.outcome === 'SOLVED_INDEPENDENTLY') {
        independentSolves++;
        completedSolves++;
      } else if (r.outcome === 'SOLVED_WITH_HINTS' || r.outcome === 'SOLVED_WITH_EDITORIAL') {
        hintSolves++;
        completedSolves++;
      }

      // Rating bracket aggregation
      const rating = r.problem_rating;
      let bracket = '< 1200';
      if (rating >= 1600) bracket = '1600+';
      else if (rating >= 1400) bracket = '1400 - 1599';
      else if (rating >= 1200) bracket = '1200 - 1399';

      const bStat = bracketStats.get(bracket)!;
      bStat.totalSec += activeSec;
      bStat.count++;

      // Struggle breakdown
      if (r.struggle_type && r.struggle_type !== 'NONE') {
        struggleCounts.set(r.struggle_type, (struggleCounts.get(r.struggle_type) || 0) + 1);
      }
    }

    const totalPracticeMinutes = Math.round(totalSeconds / 60);
    const avgMinutes = totalSessions > 0 ? Math.round(totalSeconds / totalSessions / 60) : 0;
    const independentSolveRate = completedSolves > 0 ? Math.round((independentSolves / completedSolves) * 100) : 0;
    const hintDependenceRate = completedSolves > 0 ? Math.round((hintSolves / completedSolves) * 100) : 0;

    const timeByRatingBracket = Array.from(bracketStats.entries()).map(([bracket, stat]) => ({
      bracket,
      avgMinutes: stat.count > 0 ? Math.round(stat.totalSec / stat.count / 60) : 0,
      sessionsCount: stat.count,
    }));

    const struggleLabels: Record<string, string> = {
      ALGORITHM_IDENTIFICATION: 'Algorithm Discovery',
      IMPLEMENTATION_BUG: 'Implementation & Bugs',
      EDGE_CASE: 'Corner / Edge Cases',
      TIME_LIMIT: 'Time Complexity / TLE',
      MATH_TRICK: 'Math / Invariant Formulation',
    };

    const totalStruggles = Array.from(struggleCounts.values()).reduce((a, b) => a + b, 0);
    const struggleBreakdown = Array.from(struggleCounts.entries()).map(([type, count]) => ({
      struggleType: type,
      label: struggleLabels[type] || type.replace(/_/g, ' '),
      count,
      percentage: totalStruggles > 0 ? Math.round((count / totalStruggles) * 100) : 0,
    })).sort((a, b) => b.count - a.count);

    const recentTakeaways = rows
      .filter((r) => r.key_takeaway && r.key_takeaway.trim().length > 0)
      .slice(0, 10)
      .map((r) => ({
        problemId: r.problem_id,
        problemName: r.problem_name,
        takeaway: r.key_takeaway,
        date: r.started_at ? r.started_at.slice(0, 10) : '',
      }));

    return {
      totalSessions,
      completedSessions: completedSolves,
      totalPracticeMinutes,
      independentSolveRate,
      hintDependenceRate,
      averageSolvingMinutes: avgMinutes,
      timeByRatingBracket,
      struggleBreakdown,
      recentTakeaways,
    };
  }
}

export const solveSessionService = new SolveSessionService();
