import { db, getProfileById, getProfileByHandle } from './db.js';
import { tutorialService } from './tutorialService.js';
import {
  UserContestSummary,
  ContestPostMortem,
  ContestProblemAnalysis,
  ContestSubmissionItem,
  VerdictBreakdown,
  ContestTopicWeakness,
  ContestParticipationType,
  ContestInProblemStatus,
  ContestUpsolveStatus,
  SelfReviewTag,
  CFProblem,
} from './types.js';
import { problemJournalService } from './problemJournalService.js';

export function extractDivision(name: string): string {
  if (!name) return 'Other';
  if (/div\.\s*1\s*\+\s*div\.\s*2/i.test(name) || /div\s*1\s*\+\s*2/i.test(name)) return 'Div. 1 + Div. 2';
  if (/div\.\s*1/i.test(name) || /div\s*1/i.test(name)) return 'Div. 1';
  if (/div\.\s*2/i.test(name) || /div\s*2/i.test(name)) return 'Div. 2';
  if (/div\.\s*3/i.test(name) || /div\s*3/i.test(name)) return 'Div. 3';
  if (/div\.\s*4/i.test(name) || /div\s*4/i.test(name)) return 'Div. 4';
  if (/educational/i.test(name)) return 'Educational';
  if (/global/i.test(name)) return 'Global';
  return 'Other';
}

const CF_API_BASE = 'https://codeforces.com/api';
const MIN_INTERVAL_MS = process.env.VITEST ? 0 : 1500;
let lastCfRequestTime = 0;

async function throttledFetch<T>(url: string): Promise<T | null> {
  if (process.env.VITEST) {
    return null;
  }
  const now = Date.now();
  const diff = now - lastCfRequestTime;
  if (diff < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - diff));
  }
  lastCfRequestTime = Date.now();

  try {
    const res = await fetch(url, { 
      headers: { 'User-Agent': 'CPCoach-App' },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { status: string; result: T };
    if (json.status === 'OK') return json.result;
    return null;
  } catch {
    return null;
  }
}

function formatRelativeTime(seconds: number): string {
  if (seconds < 0) seconds = 0;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `+${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export class ContestService {
  /**
   * Parse a contest ID from either raw ID (e.g. "1985") or Codeforces URL
   */
  parseContestId(input: string): number | null {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
    const match = trimmed.match(/contest\/(\d+)/i) || trimmed.match(/problemset\/problem\/(\d+)/i);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  /**
   * Automatically detect all contests where the user has participation evidence
   * (either in rating_history or via contest submissions)
   */
  async detectAndSyncContests(profileId: string, trace?: import('./perf.js').TimingSink): Promise<UserContestSummary[]> {
    const profile = getProfileById(profileId);
    if (!profile) throw new Error(`Profile '${profileId}' not found`);
    const handle = profile.handle;

    // 1. Contests from rating_history (official rated contests)
    const ratingRows = db.prepare(`
      SELECT contest_id, contest_name, rank, rating_update_time, old_rating, new_rating
      FROM rating_history
      WHERE handle = ?
      ORDER BY rating_update_time DESC
    `).all(handle) as Array<{
      contest_id: number;
      contest_name: string;
      rank: number;
      rating_update_time: number;
      old_rating: number;
      new_rating: number;
    }>;

    // 2. Contests and per-contest submission stats in a single grouped scan.
    const submissionStatsRows = db.prepare(`
      SELECT
        contest_id,
        MIN(creation_time) as min_time,
        MAX(creation_time) as max_time,
        COUNT(*) as sub_count,
        COUNT(DISTINCT CASE WHEN verdict = 'OK' THEN problem_id END) as solved_count,
        COUNT(DISTINCT problem_id) as attempted_count
      FROM submissions
      WHERE handle = ? AND contest_id IS NOT NULL AND contest_id > 0 AND contest_id < 100000
      GROUP BY contest_id
    `).all(handle) as Array<{
      contest_id: number;
      min_time: number | null;
      max_time: number | null;
      sub_count: number;
      solved_count: number;
      attempted_count: number;
    }>;
    const submissionStatsByContest = new Map(submissionStatsRows.map((row) => [row.contest_id, row]));

    const allContestIds = new Set<number>();
    ratingRows.forEach((r) => allContestIds.add(r.contest_id));
    submissionStatsRows.forEach((r) => allContestIds.add(r.contest_id));

    // 0. Pre-fetch public official contests to get genuine names and start times
    const contestMetaMap = new Map<number, { name: string; startTimeSeconds: number; durationSeconds: number }>();
    let publicContests: any[] | null = null;
    const metaFetchStarted = performance.now();
    try {
      publicContests = await throttledFetch<any[]>(`${CF_API_BASE}/contest.list?gym=false`);
      if (publicContests && Array.isArray(publicContests)) {
        for (const c of publicContests) {
          if (c.id && c.id < 100000) {
            contestMetaMap.set(c.id, {
              name: c.name,
              startTimeSeconds: c.startTimeSeconds || 0,
              durationSeconds: c.durationSeconds || 7200,
            });
          }
        }
      }
    } catch {}
    trace?.add('contest.metaFetch', performance.now() - metaFetchStarted);

    // Keep the shared official contest metadata cache warm for recommendation
    // recency ranking, even when this refresh is initiated through the
    // dashboard contest path rather than the full profile sync.
    const metaWriteStarted = performance.now();
    if (contestMetaMap.size > 0) {
      const upsertOfficialContest = db.prepare(`
        INSERT INTO codeforces_contests
          (contest_id, name, start_time_seconds, duration_seconds, phase, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(contest_id) DO UPDATE SET
          name = excluded.name,
          start_time_seconds = excluded.start_time_seconds,
          duration_seconds = excluded.duration_seconds,
          phase = excluded.phase,
          updated_at = datetime('now')
      `);
      db.exec('BEGIN TRANSACTION');
      try {
        for (const [contestId, metadata] of contestMetaMap) {
          if (metadata.startTimeSeconds > 0) {
            upsertOfficialContest.run(
              contestId,
              metadata.name,
              metadata.startTimeSeconds,
              metadata.durationSeconds,
              null
            );
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }

    trace?.add('contest.metaWrite', performance.now() - metaWriteStarted);

    // Upsert each contest record idempotently
    const rowsStarted = performance.now();
    const ratingById = new Map(ratingRows.map((row) => [row.contest_id, row]));
    const problemNameStatement = db.prepare('SELECT name FROM problems WHERE contest_id = ? LIMIT 1');
    const upsertContest = db.prepare(`
      INSERT INTO user_contests (
        id, profile_id, contest_id, name, start_time_seconds, duration_seconds,
        participation_type, rank, old_rating, new_rating, rating_change,
        problems_solved, problems_attempted, total_submissions, is_official, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(profile_id, contest_id) DO UPDATE SET
        name = excluded.name,
        participation_type = excluded.participation_type,
        start_time_seconds = excluded.start_time_seconds,
        duration_seconds = excluded.duration_seconds,
        rank = COALESCE(excluded.rank, user_contests.rank),
        old_rating = COALESCE(excluded.old_rating, user_contests.old_rating),
        new_rating = COALESCE(excluded.new_rating, user_contests.new_rating),
        rating_change = COALESCE(excluded.rating_change, user_contests.rating_change),
        problems_solved = excluded.problems_solved,
        problems_attempted = excluded.problems_attempted,
        total_submissions = excluded.total_submissions,
        is_official = excluded.is_official,
        updated_at = datetime('now')
    `);
    const finishedRounds = publicContests && Array.isArray(publicContests)
      ? publicContests.filter((c) => c.phase === 'FINISHED' && c.id < 100000).slice(0, 50)
      : [];
    const insertMissed = db.prepare(`
      INSERT INTO user_contests (
        id, profile_id, contest_id, name, start_time_seconds, duration_seconds,
        participation_type, rank, old_rating, new_rating, rating_change,
        problems_solved, problems_attempted, total_submissions, is_official, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'MISSED', NULL, NULL, NULL, NULL, 0, 0, 0, 1, datetime('now'))
      ON CONFLICT(profile_id, contest_id) DO NOTHING
    `);

    db.exec('BEGIN TRANSACTION');
    try {
      for (const cId of allContestIds) {
        const ratingInfo = ratingById.get(cId);
        const cfMeta = contestMetaMap.get(cId);

        // Submission stats were collected for every contest in one scan.
        const subStats = submissionStatsByContest.get(cId) || {
          min_time: null,
          max_time: null,
          sub_count: 0,
          solved_count: 0,
          attempted_count: 0,
        };

        let name = ratingInfo?.contest_name || cfMeta?.name;
        if (!name) {
          const probRow = problemNameStatement.get(cId) as { name: string } | undefined;
          name = probRow ? `Codeforces Contest ${cId}` : `Contest #${cId}`;
        }

        const durationSeconds = cfMeta?.durationSeconds || 7200; // Standard 2h
        let startTime = ratingInfo ? ratingInfo.rating_update_time - durationSeconds : (cfMeta?.startTimeSeconds || subStats.min_time || Math.floor(Date.now() / 1000));
        if (subStats.min_time && subStats.min_time < startTime) {
          startTime = subStats.min_time;
        }

        const participationType: ContestParticipationType = ratingInfo ? 'RATED' : 'PRACTICE';
        const ratingChange = ratingInfo ? ratingInfo.new_rating - ratingInfo.old_rating : null;
        const isOfficial = ratingInfo || cfMeta ? 1 : 0;

        const contestRecordId = `c_${profileId}_${cId}`;

        upsertContest.run(
          contestRecordId,
          profileId,
          cId,
          name,
          startTime,
          durationSeconds,
          participationType,
          ratingInfo?.rank ?? null,
          ratingInfo?.old_rating ?? null,
          ratingInfo?.new_rating ?? null,
          ratingChange,
          subStats.solved_count,
          subStats.attempted_count,
          subStats.sub_count,
          isOfficial
        );
      }

      // 3. Sync recent official Codeforces Div rounds to enable tracking every Div
      for (const c of finishedRounds) {
        if (!allContestIds.has(c.id)) {
          insertMissed.run(
            `c_${profileId}_${c.id}`,
            profileId,
            c.id,
            c.name,
            c.startTimeSeconds || Math.floor(Date.now() / 1000),
            c.durationSeconds || 7200
          );
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    trace?.add('contest.rows', performance.now() - rowsStarted);

    return this.getContestList(profileId);
  }

  /**
   * Import a contest manually by contest ID or Codeforces URL
   */
  async importContest(profileId: string, input: string): Promise<ContestPostMortem> {
    const contestId = this.parseContestId(input);
    if (!contestId) {
      throw new Error(`Invalid contest identifier: '${input}'. Enter a contest ID (e.g. 1985) or a Codeforces URL.`);
    }

    const profile = getProfileById(profileId);
    if (!profile) throw new Error(`Profile '${profileId}' not found`);
    const handle = profile.handle;

    // Fetch contest info from Codeforces API
    let contestName = `Contest #${contestId}`;
    let durationSeconds = 7200;
    let startTimeSeconds = Math.floor(Date.now() / 1000);

    const standings = await throttledFetch<any>(
      `${CF_API_BASE}/contest.standings?contestId=${contestId}&from=1&count=1&showUnofficial=true`
    );

    if (standings && standings.contest) {
      contestName = standings.contest.name || contestName;
      durationSeconds = standings.contest.durationSeconds || 7200;
      startTimeSeconds = standings.contest.startTimeSeconds || startTimeSeconds;

      // Populate contest problems in contest_problems_meta
      if (standings.problems && Array.isArray(standings.problems)) {
        const insertMeta = db.prepare(`
          INSERT INTO contest_problems_meta (id, contest_id, problem_index, name, rating, tags, cf_url)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(contest_id, problem_index) DO UPDATE SET
            name = excluded.name,
            rating = COALESCE(excluded.rating, contest_problems_meta.rating),
            tags = excluded.tags
        `);

        for (const p of standings.problems) {
          insertMeta.run(
            `${contestId}_${p.index}`,
            contestId,
            p.index,
            p.name,
            p.rating ?? null,
            JSON.stringify(p.tags || []),
            `https://codeforces.com/contest/${contestId}/problem/${p.index}`
          );
        }
      }
    }

    // Check if user has submissions for this contest in local DB
    const subStats = db.prepare(`
      SELECT 
        COUNT(*) as total_subs,
        COUNT(DISTINCT problem_id) as attempted
      FROM submissions
      WHERE handle = ? AND contest_id = ?
    `).get(handle, contestId) as { total_subs: number; attempted: number };

    const solvedCountRow = db.prepare(`
      SELECT COUNT(DISTINCT problem_id) as count
      FROM submissions
      WHERE handle = ? AND contest_id = ? AND verdict = 'OK'
    `).get(handle, contestId) as { count: number };

    // Check if rating history has this contest
    const ratingRow = db.prepare(`
      SELECT rank, old_rating, new_rating
      FROM rating_history
      WHERE handle = ? AND contest_id = ?
    `).get(handle, contestId) as { rank: number; old_rating: number; new_rating: number } | undefined;

    const contestRecordId = `c_${profileId}_${contestId}`;
    const ratingChange = ratingRow ? ratingRow.new_rating - ratingRow.old_rating : null;

    db.prepare(`
      INSERT INTO user_contests (
        id, profile_id, contest_id, name, start_time_seconds, duration_seconds,
        participation_type, rank, old_rating, new_rating, rating_change,
        problems_solved, problems_attempted, total_submissions, is_official, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(profile_id, contest_id) DO UPDATE SET
        name = excluded.name,
        start_time_seconds = excluded.start_time_seconds,
        duration_seconds = excluded.duration_seconds,
        problems_solved = excluded.problems_solved,
        problems_attempted = excluded.problems_attempted,
        total_submissions = excluded.total_submissions,
        updated_at = datetime('now')
    `).run(
      contestRecordId,
      profileId,
      contestId,
      contestName,
      startTimeSeconds,
      durationSeconds,
      ratingRow ? 'RATED' : 'IMPORTED',
      ratingRow?.rank ?? null,
      ratingRow?.old_rating ?? null,
      ratingRow?.new_rating ?? null,
      ratingChange,
      solvedCountRow.count,
      subStats.attempted,
      subStats.total_subs,
      ratingRow ? 1 : 0
    );

    return this.getContestPostMortem(profileId, contestId);
  }

  /**
   * List all user contests for a profile
   */
  getContestList(profileId: string): UserContestSummary[] {
    const rows = db.prepare(`
      SELECT * FROM user_contests
      WHERE profile_id = ? AND contest_id > 0 AND contest_id < 100000
      ORDER BY start_time_seconds DESC
    `).all(profileId) as any[];

    return rows.map((r) => ({
      id: r.id,
      profileId: r.profile_id,
      contestId: r.contest_id,
      name: r.name,
      division: extractDivision(r.name),
      participated: r.participation_type !== 'MISSED',
      startTimeSeconds: r.start_time_seconds,
      startTimeFormatted: new Date(r.start_time_seconds * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
      durationSeconds: r.duration_seconds,
      participationType: r.participation_type as ContestParticipationType,
      rank: r.rank,
      oldRating: r.old_rating,
      newRating: r.new_rating,
      ratingChange: r.rating_change,
      problemsSolved: r.problems_solved,
      problemsAttempted: r.problems_attempted,
      totalSubmissions: r.total_submissions,
      isOfficial: Boolean(r.is_official),
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Generate comprehensive post-mortem report for a specific contest
   */
  async getContestPostMortem(profileId: string, contestId: number): Promise<ContestPostMortem> {
    const profile = getProfileById(profileId);
    if (!profile) throw new Error(`Profile '${profileId}' not found`);
    const handle = profile.handle;

    // 1. Fetch contest record
    let contestRow = db.prepare('SELECT * FROM user_contests WHERE profile_id = ? AND contest_id = ?').get(profileId, contestId) as any;
    if (!contestRow) {
      // Auto-import if exists in rating_history or submissions
      await this.detectAndSyncContests(profileId);
      contestRow = db.prepare('SELECT * FROM user_contests WHERE profile_id = ? AND contest_id = ?').get(profileId, contestId) as any;
    }
    if (!contestRow) {
      throw new Error(`Contest ${contestId} not found for profile ${profileId}`);
    }

    const startTime = contestRow.start_time_seconds;
    const duration = contestRow.duration_seconds || 7200;
    const endTime = startTime + duration;

    // 2. Fetch all submissions by this handle for this contest
    const subRows = db.prepare(`
      SELECT * FROM submissions
      WHERE handle = ? AND contest_id = ?
      ORDER BY creation_time ASC
    `).all(handle, contestId) as any[];

    // 3. Known contest problems: from contest_problems_meta, problems table, or submissions
    const metaProblemRows = db.prepare(`
      SELECT * FROM contest_problems_meta
      WHERE contest_id = ?
      ORDER BY problem_index ASC
    `).all(contestId) as any[];

    const knownProblemsMap = new Map<string, { name: string; rating?: number | null; tags: string[]; cfUrl: string }>();

    for (const m of metaProblemRows) {
      knownProblemsMap.set(m.problem_index, {
        name: m.name,
        rating: m.rating,
        tags: JSON.parse(m.tags || '[]'),
        cfUrl: m.cf_url || `https://codeforces.com/contest/${contestId}/problem/${m.problem_index}`,
      });
    }

    // Also scan global problems table
    const dbProbRows = db.prepare(`
      SELECT problem_index, name, rating, tags
      FROM problems
      WHERE contest_id = ?
      ORDER BY problem_index ASC
    `).all(contestId) as any[];

    for (const p of dbProbRows) {
      if (!knownProblemsMap.has(p.problem_index)) {
        knownProblemsMap.set(p.problem_index, {
          name: p.name,
          rating: p.rating,
          tags: JSON.parse(p.tags || '[]'),
          cfUrl: `https://codeforces.com/contest/${contestId}/problem/${p.problem_index}`,
        });
      }
    }

    // Also include any problem index present in submissions
    for (const s of subRows) {
      if (s.problem_index && !knownProblemsMap.has(s.problem_index)) {
        knownProblemsMap.set(s.problem_index, {
          name: `Problem ${s.problem_index}`,
          rating: null,
          tags: [],
          cfUrl: `https://codeforces.com/contest/${contestId}/problem/${s.problem_index}`,
        });
      }
    }

    // If still empty (e.g. freshly imported), attempt to fetch problemset from Codeforces API
    if (knownProblemsMap.size === 0) {
      try {
        const standings = await throttledFetch<any>(
          `${CF_API_BASE}/contest.standings?contestId=${contestId}&from=1&count=1`
        );
        if (standings && standings.problems) {
          for (const p of standings.problems) {
            knownProblemsMap.set(p.index, {
              name: p.name,
              rating: p.rating,
              tags: p.tags || [],
              cfUrl: `https://codeforces.com/contest/${contestId}/problem/${p.index}`,
            });
          }
        }
      } catch {}
    }

    // Default problem letters if none found
    if (knownProblemsMap.size === 0) {
      ['A', 'B', 'C', 'D', 'E'].forEach((letter) => {
        knownProblemsMap.set(letter, {
          name: `Problem ${letter}`,
          rating: null,
          tags: [],
          cfUrl: `https://codeforces.com/contest/${contestId}/problem/${letter}`,
        });
      });
    }

    // 4. Fetch self-reviews for this contest & profile
    const reviewRows = db.prepare(`
      SELECT * FROM contest_problem_reviews
      WHERE profile_id = ? AND contest_id = ?
    `).all(profileId, contestId) as any[];

    const reviewMap = new Map<string, { tag: SelfReviewTag | null; notes: string | null; upsolve: ContestUpsolveStatus }>();
    for (const r of reviewRows) {
      reviewMap.set(r.problem_index, {
        tag: r.self_review_tag as SelfReviewTag | null,
        notes: r.self_review_notes,
        upsolve: r.upsolve_status as ContestUpsolveStatus,
      });
    }

    // 5. Build timeline items & verdict breakdowns
    const timeline: ContestSubmissionItem[] = [];
    const verdictBreakdown: VerdictBreakdown = {
      ok: 0,
      wrongAnswer: 0,
      timeLimitExceeded: 0,
      runtimeError: 0,
      compilationError: 0,
      memoryLimitExceeded: 0,
      other: 0,
    };

    const subsByProblem = new Map<string, any[]>();

    for (const s of subRows) {
      const pIdx = s.problem_index;
      if (!subsByProblem.has(pIdx)) subsByProblem.set(pIdx, []);
      subsByProblem.get(pIdx)!.push(s);

      const relSec = s.creation_time - startTime;
      const isAfterContest = s.creation_time > endTime;

      timeline.push({
        id: s.id,
        creationTimeSeconds: s.creation_time,
        relativeTimeSeconds: relSec,
        relativeTimeFormatted: formatRelativeTime(relSec),
        problemIndex: pIdx,
        verdict: s.verdict,
        isAfterContest,
      });

      // Tally in-contest verdicts
      if (!isAfterContest) {
        if (s.verdict === 'OK') verdictBreakdown.ok++;
        else if (s.verdict === 'WRONG_ANSWER') verdictBreakdown.wrongAnswer++;
        else if (s.verdict === 'TIME_LIMIT_EXCEEDED') verdictBreakdown.timeLimitExceeded++;
        else if (s.verdict === 'RUNTIME_ERROR') verdictBreakdown.runtimeError++;
        else if (s.verdict === 'COMPILATION_ERROR') verdictBreakdown.compilationError++;
        else if (s.verdict === 'MEMORY_LIMIT_EXCEEDED') verdictBreakdown.memoryLimitExceeded++;
        else verdictBreakdown.other++;
      }
    }

    // 6. Problem-by-problem analysis
    const problemsAnalysis: ContestProblemAnalysis[] = [];
    let inContestSolvedCount = 0;
    let upsolvedCount = 0;
    let totalUnsuccessful = 0;
    let totalPenalties = 0;

    const sortedIndices = Array.from(knownProblemsMap.keys()).sort();

    for (const idx of sortedIndices) {
      const meta = knownProblemsMap.get(idx)!;
      const subs = subsByProblem.get(idx) || [];
      const review = reviewMap.get(idx);

      // Separate contest submissions from upsolving submissions
      const inContestSubs = subs.filter((s) => s.creation_time <= endTime);
      const postContestSubs = subs.filter((s) => s.creation_time > endTime);

      let status: ContestInProblemStatus = 'NO_RECORDED_SUBMISSION';
      let upsolveStatus: ContestUpsolveStatus = review?.upsolve || 'UNSOLVED';

      let firstAttemptRel: number | null = null;
      let firstAttemptFormatted: string | null = null;
      let solvedRel: number | null = null;
      let solvedFormatted: string | null = null;
      let timeSpentMinutes: number | null = null;
      let unsuccessCount = 0;
      const verdictSequence: string[] = [];
      const observations: string[] = [];

      if (inContestSubs.length > 0) {
        firstAttemptRel = Math.max(0, inContestSubs[0].creation_time - startTime);
        firstAttemptFormatted = formatRelativeTime(firstAttemptRel);

        const acSub = inContestSubs.find((s) => s.verdict === 'OK');
        if (acSub) {
          status = 'SOLVED_IN_CONTEST';
          upsolveStatus = 'IN_CONTEST_SOLVED';
          inContestSolvedCount++;
          solvedRel = Math.max(0, acSub.creation_time - startTime);
          solvedFormatted = formatRelativeTime(solvedRel);

          const attemptsBeforeAC = inContestSubs.indexOf(acSub);
          unsuccessCount = attemptsBeforeAC;
          timeSpentMinutes = Math.round((acSub.creation_time - inContestSubs[0].creation_time) / 60);

          if (attemptsBeforeAC === 0) {
            observations.push('Solved cleanly on the first attempt.');
          } else {
            observations.push(`Solved after ${attemptsBeforeAC} unsuccessful attempt(s).`);
          }

          if (timeSpentMinutes > 35) {
            observations.push(`Consumed ${timeSpentMinutes} minutes of contest time.`);
          }
        } else {
          status = 'ATTEMPTED_UNSOLVED';
          unsuccessCount = inContestSubs.length;
          observations.push(`Unsolved in contest across ${inContestSubs.length} submission(s).`);
        }

        for (const s of inContestSubs) {
          verdictSequence.push(s.verdict);
        }

        totalUnsuccessful += unsuccessCount;
        if (status === 'SOLVED_IN_CONTEST') {
          totalPenalties += unsuccessCount;
        }
      } else {
        observations.push('No recorded submission during contest.');
      }

      // Check if upsolved after contest
      if (status !== 'SOLVED_IN_CONTEST') {
        const postAc = postContestSubs.find((s) => s.verdict === 'OK');
        if (postAc) {
          if (upsolveStatus === 'UNSOLVED') {
            upsolveStatus = 'UPSOLVED_INDEPENDENTLY';
          }
          upsolvedCount++;
          observations.push('Accepted solution recorded after the contest (upsolved).');
        } else if (upsolveStatus !== 'UNSOLVED') {
          upsolvedCount++;
        }
      }

      problemsAnalysis.push({
        index: idx,
        name: meta.name,
        rating: meta.rating,
        tags: meta.tags,
        cfUrl: meta.cfUrl,
        status,
        upsolveStatus,
        submissionsCount: inContestSubs.length,
        unsuccessfulAttempts: unsuccessCount,
        firstAttemptRelativeSeconds: firstAttemptRel,
        firstAttemptFormatted,
        solvedRelativeSeconds: solvedRel,
        solvedFormatted,
        timeSpentMinutes,
        verdictSequence,
        selfReviewTag: review?.tag,
        selfReviewNotes: review?.notes,
        observations,
        tutorial: tutorialService.getContestProblemTutorial(contestId, idx),
      });
    }

    // 7. Detect Verdict Patterns
    const verdictPatterns: string[] = [];
    if (verdictBreakdown.wrongAnswer >= 3) {
      verdictPatterns.push(`High Wrong Answer frequency (${verdictBreakdown.wrongAnswer} WAs): indicates tricky edge cases or early unverified submissions.`);
    }
    if (verdictBreakdown.timeLimitExceeded >= 2) {
      verdictPatterns.push(`Multiple Time Limit Exceeded verdicts (${verdictBreakdown.timeLimitExceeded} TLEs): points to suboptimal time complexity or unoptimized I/O.`);
    }
    if (verdictBreakdown.runtimeError > 0) {
      verdictPatterns.push(`${verdictBreakdown.runtimeError} Runtime Error(s): check array bounds, zero division, or recursion limits.`);
    }
    if (verdictBreakdown.compilationError > 0) {
      verdictPatterns.push(`${verdictBreakdown.compilationError} Compilation Error(s): avoid submitting without local compilation.`);
    }
    if (verdictPatterns.length === 0) {
      verdictPatterns.push('Clean submission discipline with low penalty count.');
    }

    // 8. Time Management & Strategy Observations
    const strategyObservations: string[] = [];
    const attemptedProblems = problemsAnalysis.filter((p) => p.status !== 'NO_RECORDED_SUBMISSION');

    if (attemptedProblems.length > 0) {
      // Check order
      const solvedIndices = attemptedProblems.filter((p) => p.status === 'SOLVED_IN_CONTEST').map((p) => p.index);
      if (solvedIndices.includes('A') && solvedIndices.includes('B')) {
        strategyObservations.push('Solid opening: secured introductory problems A and B before exploring later problems.');
      }

      // Check time sinks
      const timeSinks = attemptedProblems.filter((p) => (p.timeSpentMinutes || 0) >= 40);
      for (const ts of timeSinks) {
        strategyObservations.push(`Time sink on Problem ${ts.index} (${ts.timeSpentMinutes}m): consuming heavy contest bandwidth.`);
      }

      // Check fatigue / late contest productivity
      const lateSubs = timeline.filter((t) => (t.relativeTimeSeconds || 0) > duration * 0.7 && !t.isAfterContest);
      if (lateSubs.length > 0 && lateSubs.some((s) => s.verdict === 'OK')) {
        strategyObservations.push('Strong contest resilience: successfully converted an accepted problem in the final 30% of contest duration.');
      }
    } else {
      strategyObservations.push('No submissions recorded in this event.');
    }

    // 9. Topic and Algorithm Weakness Analysis
    const tagStats = new Map<string, { attempts: number; solved: number; failures: number; reasons: string[] }>();

    for (const p of problemsAnalysis) {
      for (const tag of p.tags) {
        if (!tagStats.has(tag)) tagStats.set(tag, { attempts: 0, solved: 0, failures: 0, reasons: [] });
        const curr = tagStats.get(tag)!;
        if (p.status === 'SOLVED_IN_CONTEST') {
          curr.attempts++;
          curr.solved++;
        } else if (p.status === 'ATTEMPTED_UNSOLVED') {
          curr.attempts++;
          curr.failures++;
          curr.reasons.push(`Unsolved on Problem ${p.index} (${p.unsuccessfulAttempts} attempts)`);
        }
      }
    }

    const topicWeaknesses: ContestTopicWeakness[] = [];
    for (const [tag, stat] of tagStats.entries()) {
      if (stat.attempts === 0) continue;

      let status: 'DEMONSTRATED_WEAKNESS' | 'POSSIBLE_WEAKNESS' | 'UNEXPLORED' | 'STRONG';
      let suggestedAction = '';

      if (stat.failures > 0) {
        if (stat.failures >= 2) {
          status = 'DEMONSTRATED_WEAKNESS';
          suggestedAction = `Priority training: Practice calibrated ${tag} problems in daily sets to fix contest bottlenecks.`;
        } else {
          status = 'POSSIBLE_WEAKNESS';
          suggestedAction = `Review fundamentals: Analyze editorial for Problem ${stat.reasons[0] || tag}.`;
        }
      } else {
        status = 'STRONG';
        suggestedAction = `Consistent performance: Solid contest execution in ${tag}.`;
      }

      topicWeaknesses.push({
        tag,
        status,
        contestAttempts: stat.attempts,
        contestSolved: stat.solved,
        contestFailures: stat.failures,
        historicalAttempts: stat.attempts,
        historicalSolveRate: Math.round((stat.solved / stat.attempts) * 100),
        reasons: stat.reasons,
        suggestedAction,
      });
    }

    // 10. Historical Comparison
    const userContests = db.prepare('SELECT problems_solved, rating_change FROM user_contests WHERE profile_id = ?').all(profileId) as any[];
    const avgSolved = userContests.length > 0
      ? userContests.reduce((a, b) => a + (b.problems_solved || 0), 0) / userContests.length
      : inContestSolvedCount;

    let performanceVsHistorical = 'Baseline contest performance.';
    if (inContestSolvedCount > avgSolved) {
      performanceVsHistorical = `Above average: Solved ${inContestSolvedCount} problem(s) compared to your historical average of ${avgSolved.toFixed(1)}.`;
    } else if (inContestSolvedCount < avgSolved) {
      performanceVsHistorical = `Below average: Solved ${inContestSolvedCount} problem(s) compared to your typical ${avgSolved.toFixed(1)} solves. Targeted upsolving recommended.`;
    } else {
      performanceVsHistorical = `Consistent with your historical average of ${avgSolved.toFixed(1)} solved problems.`;
    }

    const unsolvedCount = Math.max(0, problemsAnalysis.length - inContestSolvedCount - upsolvedCount);

    return {
      contestId,
      profileId,
      handle,
      name: contestRow.name,
      startTimeSeconds: startTime,
      startTimeFormatted: new Date(startTime * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
      durationSeconds: duration,
      participationType: contestRow.participation_type as ContestParticipationType,
      rank: contestRow.rank,
      oldRating: contestRow.old_rating,
      newRating: contestRow.new_rating,
      ratingChange: contestRow.rating_change,
      problemsSolved: inContestSolvedCount,
      problemsAttempted: attemptedProblems.length,
      totalSubmissions: timeline.filter((t) => !t.isAfterContest).length,
      unsuccessfulAttempts: totalUnsuccessful,
      penalties: totalPenalties,
      performanceVsHistorical,
      isStandingsConfirmed: Boolean(contestRow.is_official && contestRow.rank),
      problems: problemsAnalysis,
      verdictBreakdown,
      verdictPatterns,
      strategyObservations,
      timeline,
      topicWeaknesses,
      upsolvingSummary: {
        inContestSolved: inContestSolvedCount,
        upsolvedCount,
        unsolvedCount,
      },
    };
  }

  /**
   * Save a self-review or upsolving status for a specific problem in a contest
   */
  async saveProblemReview(
    profileId: string,
    contestId: number,
    problemIndex: string,
    payload: {
      selfReviewTag?: SelfReviewTag | null;
      selfReviewNotes?: string | null;
      upsolveStatus?: ContestUpsolveStatus;
    }
  ): Promise<ContestPostMortem> {
    const id = `${profileId}_${contestId}_${problemIndex}`;

    db.prepare(`
      INSERT INTO contest_problem_reviews (
        id, profile_id, contest_id, problem_index, self_review_tag, self_review_notes, upsolve_status, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'UNSOLVED'), datetime('now'))
      ON CONFLICT(profile_id, contest_id, problem_index) DO UPDATE SET
        self_review_tag = COALESCE(excluded.self_review_tag, contest_problem_reviews.self_review_tag),
        self_review_notes = COALESCE(excluded.self_review_notes, contest_problem_reviews.self_review_notes),
        upsolve_status = COALESCE(excluded.upsolve_status, contest_problem_reviews.upsolve_status),
        updated_at = datetime('now')
    `).run(
      id,
      profileId,
      contestId,
      problemIndex,
      payload.selfReviewTag ?? null,
      payload.selfReviewNotes ?? null,
      payload.upsolveStatus ?? 'UNSOLVED'
    );

    if (payload.selfReviewTag || payload.selfReviewNotes || payload.upsolveStatus) {
      problemJournalService.record({
        profileId,
        problemId: `${contestId}_${problemIndex}`,
        source: 'CONTEST_REVIEW',
        solvedStatus: payload.upsolveStatus?.startsWith('UPSOLVED') ? payload.upsolveStatus : null,
        struggleReason: payload.selfReviewTag ?? null,
        notes: payload.selfReviewNotes ?? null,
        contestId,
        problemIndex,
      });
    }

    return this.getContestPostMortem(profileId, contestId);
  }
}

export const contestService = new ContestService();
