import { db, getProfileById, getProfileByHandle, getCurriculumProblem } from './db.js';
import { analysisService } from './analysisService.js';
import { tutorialService } from './tutorialService.js';
import { problemJournalService } from './problemJournalService.js';
import { reviewService } from './reviewService.js';
import { 
  DailySet, 
  DailyProblem, 
  DailyProblemCategory, 
  CFProblem, 
  ProblemSolvedStatus, 
  PerceivedDifficulty,
  EducationalSource,
  FeedbackPayload
} from './types.js';

interface PriorDayContext {
  hasPriorSet: boolean;
  priorDate?: string;
  weaknessStruggled: boolean;
  weaknessTag?: string;
  weaknessProblemName?: string;
  weaknessStatus?: ProblemSolvedStatus | null;
  weaknessDifficulty?: PerceivedDifficulty | null;
  weaknessSolvedEasily: boolean;
  recentHintTopics: string[];
  recentStruggledTopics: string[];
  recentChallengeSolved: boolean;
  overallRecentComfort: boolean;
}

export class RecommendationService {
  getTodayDateString(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hebron' }).format(new Date());
  }

  getOrGenerateDailySet(profileIdOrHandle: string, targetDate?: string): DailySet {
    const date = targetDate || this.getTodayDateString();

    // Resolve profile
    let profile = getProfileById(profileIdOrHandle);
    if (!profile) {
      profile = getProfileByHandle(profileIdOrHandle);
    }
    if (!profile) {
      throw new Error(`Profile '${profileIdOrHandle}' not found`);
    }

    const profileId = profile.id;

    // Check if daily set already exists for this profile on this date (Idempotency)
    const existingSetRow = db.prepare('SELECT id, profile_id, date, generated_at FROM daily_sets WHERE profile_id = ? AND date = ?').get(profileId, date) as {
      id: string;
      profile_id: string;
      date: string;
      generated_at: string;
    } | undefined;

    if (existingSetRow) {
      const existingSet = this.loadDailySet(profileId, date);
      const isIncomplete = existingSet.problems.length < 3;
      // Validate that all problems link strictly to public regular Codeforces problems (contest_id < 100000)
      const hasInvalidProblems = existingSet.problems.some(
        (p) =>
          !p.educationalSourceUrl ||
          !p.educationalSourceUrl.startsWith('https://codeforces.com') ||
          !p.problem?.contestId ||
          p.problem.contestId <= 0 ||
          p.problem.contestId >= 100000 ||
          p.problem.contestId === 99999 ||
          p.problemId.startsWith('cses_') ||
          p.problemId.startsWith('atcoder_') ||
          p.problemId.startsWith('102951_')
      );
      if (hasInvalidProblems || isIncomplete) {
        console.log(`[Recommendation] Daily set ${existingSet.id} was incomplete or had restricted/Gym/non-Codeforces problems. Repairing with eligible regular public problems...`);
        const hasFeedback = existingSet.problems.some((p) => p.notes || (p.solvedStatus && p.solvedStatus !== 'NOT_SOLVED'));
        if (!hasFeedback) {
          db.prepare('DELETE FROM daily_problems WHERE daily_set_id = ?').run(existingSet.id);
          db.prepare('DELETE FROM daily_sets WHERE id = ?').run(existingSet.id);
        } else {
          this.replaceInvalidProblems(existingSet, profileId, profile.handle, date);
          return this.loadDailySet(profileId, date);
        }
      } else {
        return existingSet;
      }
    }

    // Otherwise generate a new set adaptively for this profile
    return this.generateDailySet(profileId, profile.handle, date);
  }

  loadDailySet(profileId: string, date: string): DailySet {
    const setRow = db.prepare('SELECT id, profile_id, date, generated_at FROM daily_sets WHERE profile_id = ? AND date = ?').get(profileId, date) as {
      id: string;
      profile_id: string;
      date: string;
      generated_at: string;
    } | undefined;

    if (!setRow) {
      throw new Error(`Daily set for profile ${profileId} on ${date} not found`);
    }

    const problemRows = db.prepare(`
      SELECT dp.*, p.contest_id, p.problem_index, p.name, p.type, p.rating, p.tags, p.solved_count
      FROM daily_problems dp
      JOIN problems p ON dp.problem_id = p.id
      WHERE dp.daily_set_id = ?
      ORDER BY 
        CASE dp.category
          WHEN 'WEAKNESS_DRILL' THEN 1
          WHEN 'REINFORCEMENT' THEN 2
          WHEN 'CHALLENGE' THEN 3
          ELSE 4
        END ASC
    `).all(setRow.id) as any[];

    const problems: DailyProblem[] = problemRows.map((r) => {
      let tags: string[] = [];
      try { tags = JSON.parse(r.tags || '[]'); } catch {}

      let prerequisites: string[] = [];
      try { prerequisites = JSON.parse(r.prerequisites || '[]'); } catch {}

      const isOpened = Boolean(r.is_opened);
      const attempted = Boolean(r.attempted);
      const verifiedCfAc = Boolean(r.verified_cf_ac);
      const selfReportedSolved = Boolean(r.self_reported_solved || (r.solved_status && r.solved_status !== 'NOT_SOLVED'));

      let completionState: 'NOT_OPENED' | 'OPENED' | 'ATTEMPTED' | 'SOLVED_SELF_REPORTED' | 'SOLVED_VERIFIED' = 'NOT_OPENED';
      if (verifiedCfAc) {
        completionState = 'SOLVED_VERIFIED';
      } else if (selfReportedSolved) {
        completionState = 'SOLVED_SELF_REPORTED';
      } else if (attempted) {
        completionState = 'ATTEMPTED';
      } else if (isOpened) {
        completionState = 'OPENED';
      } else {
        completionState = 'NOT_OPENED';
      }

      return {
        id: r.id,
        dailySetId: r.daily_set_id,
        profileId: r.profile_id,
        dailySetDate: r.daily_set_date,
        problemId: r.problem_id,
        category: r.category as DailyProblemCategory,
        reason: r.reason,
        targetRating: r.target_rating,
        completed: Boolean(r.completed),
        solvedStatus: r.solved_status as ProblemSolvedStatus | null,
        perceivedDifficulty: r.perceived_difficulty as PerceivedDifficulty | null,
        difficultyExperience: r.difficulty_experience as DailyProblem['difficultyExperience'],
        solutionMethod: r.solution_method as DailyProblem['solutionMethod'],
        timeSpentMinutes: r.time_spent_minutes,
        notes: r.notes,
        verifiedCfAc,
        isOpened,
        openedAt: r.opened_at,
        attempted,
        selfReportedSolved,
        completionState,
        updatedAt: r.updated_at,
        educationalSource: r.educational_source as EducationalSource | undefined,
        educationalSourceUrl: r.educational_source_url,
        curriculumStage: r.curriculum_stage,
        learningObjective: r.learning_objective,
        prerequisites,
        struggleReason: r.struggle_reason,
        problemOpinion: r.problem_opinion as DailyProblem['problemOpinion'],
        tutorial: tutorialService.getTutorial(r.problem_id),
        problem: {
          contestId: r.contest_id,
          index: r.problem_index,
          name: r.name,
          type: r.type,
          rating: r.rating,
          tags,
          solvedCount: r.solved_count,
        },
      };
    });

    const verifiedCount = problems.filter((p) => p.verifiedCfAc).length;
    const selfReportedCount = problems.filter((p) => p.selfReportedSolved && !p.verifiedCfAc).length;
    const attemptedCount = problems.filter((p) => p.attempted && !p.verifiedCfAc).length;
    const openedCount = problems.filter((p) => p.isOpened && !p.attempted && !p.verifiedCfAc && !p.selfReportedSolved).length;
    const completedCount = verifiedCount;

    return {
      id: setRow.id,
      profileId: setRow.profile_id,
      date: setRow.date,
      generatedAt: setRow.generated_at,
      problems,
      completionProgress: {
        total: problems.length,
        completed: completedCount,
        verifiedCount,
        selfReportedCount,
        attemptedCount,
        openedCount,
        percentage: problems.length > 0 ? Math.round((completedCount / problems.length) * 100) : 0,
      },
    };
  }

  private replaceInvalidProblems(
    existingSet: DailySet,
    profileId: string,
    handle: string,
    date: string
  ): void {
    const validProblems = existingSet.problems.filter(
      (p) =>
        p.educationalSourceUrl &&
        p.educationalSourceUrl.startsWith('https://codeforces.com') &&
        p.problem?.contestId &&
        p.problem.contestId > 0 &&
        p.problem.contestId < 100000 &&
        p.problem.contestId !== 99999 &&
        !p.problemId.startsWith('cses_') &&
        !p.problemId.startsWith('atcoder_') &&
        !p.problemId.startsWith('102951_')
    );

    const invalidProblems = existingSet.problems.filter(
      (p) => !validProblems.some((vp) => vp.id === p.id)
    );

    if (invalidProblems.length === 0) return;

    for (const inv of invalidProblems) {
      db.prepare('DELETE FROM daily_problems WHERE id = ?').run(inv.id);
    }

    const profile = getProfileById(profileId);
    const userRating = profile?.rating || 1300;
    const chosenIds = new Set<string>(validProblems.map((p) => p.problemId));

    const excludedIds = new Set<string>();
    const solvedRows = db.prepare('SELECT problem_id FROM submissions WHERE handle = ? AND verdict = "OK"').all(handle) as { problem_id: string }[];
    solvedRows.forEach((r) => excludedIds.add(r.problem_id));

    for (const inv of invalidProblems) {
      const category = inv.category;
      let minR = Math.max(800, userRating - 200);
      let maxR = userRating + 200;

      if (category === 'WEAKNESS_DRILL') {
        minR = Math.max(800, userRating - 100);
        maxR = userRating + 100;
      } else if (category === 'REINFORCEMENT') {
        minR = Math.max(800, userRating - 50);
        maxR = userRating + 50;
      } else {
        minR = userRating + 50;
        maxR = userRating + 250;
      }

      const cand = db.prepare(`
        SELECT id, contest_id, problem_index, name, type, rating, tags, solved_count
        FROM problems p
        WHERE rating >= ? AND rating <= ?
          AND contest_id > 0 AND contest_id < 100000 AND contest_id != 99999
          AND problem_index IS NOT NULL AND trim(problem_index) != ''
        ORDER BY solved_count DESC, contest_id DESC
        LIMIT 50
      `).all(minR, maxR) as any[];

      const eligible = cand.find((c: any) => !excludedIds.has(c.id) && !chosenIds.has(c.id));
      if (eligible) {
        chosenIds.add(eligible.id);
        const cfUrl = `https://codeforces.com/problemset/problem/${eligible.contest_id}/${eligible.problem_index}`;
        const newReason = `Replacement for inaccessible contest: Public regular Codeforces problemset problem targeting ${category.toLowerCase().replace('_', ' ')}.`;
        db.prepare(`
          INSERT INTO daily_problems (
            id, daily_set_id, profile_id, daily_set_date, problem_id, category, reason,
            target_rating, completed, is_opened, attempted, self_reported_solved, verified_cf_ac,
            educational_source, educational_source_url, learning_objective, prerequisites, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'CODEFORCES_PROBLEMSET', ?, 'Public regular Codeforces practice problem.', '[]', datetime('now'))
        `).run(
          inv.id,
          existingSet.id,
          profileId,
          date,
          eligible.id,
          category,
          newReason,
          eligible.rating || userRating,
          cfUrl
        );
      }
    }
  }

  private analyzePriorDays(profileId: string, currentDate: string): PriorDayContext {
    // 1. Find most recent prior daily set
    const priorSet = db.prepare(`
      SELECT id, date FROM daily_sets
      WHERE profile_id = ? AND date < ?
      ORDER BY date DESC
      LIMIT 1
    `).get(profileId, currentDate) as { id: string; date: string } | undefined;

    if (!priorSet) {
      return {
        hasPriorSet: false,
        weaknessStruggled: false,
        weaknessSolvedEasily: false,
        recentHintTopics: [],
        recentStruggledTopics: [],
        recentChallengeSolved: false,
        overallRecentComfort: false,
      };
    }

    const priorProblems = db.prepare(`
      SELECT dp.*, p.name, p.rating, p.tags
      FROM daily_problems dp
      JOIN problems p ON dp.problem_id = p.id
      WHERE dp.daily_set_id = ?
    `).all(priorSet.id) as any[];

    const priorWeakness = priorProblems.find((p) => p.category === 'WEAKNESS_DRILL');
    let weaknessStruggled = false;
    let weaknessSolvedEasily = false;
    let weaknessTag: string | undefined;

    if (priorWeakness) {
      const tags: string[] = JSON.parse(priorWeakness.tags || '[]');
      weaknessTag = tags[0];

      if (
        priorWeakness.perceived_difficulty === 'HARD' ||
        priorWeakness.solved_status === 'NOT_SOLVED' ||
        priorWeakness.solved_status === 'VIEWED_EDITORIAL'
      ) {
        weaknessStruggled = true;
      } else if (
        priorWeakness.perceived_difficulty === 'EASY' &&
        priorWeakness.solved_status === 'SOLVED_INDEPENDENTLY'
      ) {
        weaknessSolvedEasily = true;
      }
    }

    // Check challenge problem from prior set
    const priorChallenge = priorProblems.find((p) => p.category === 'CHALLENGE');
    const recentChallengeSolved = Boolean(
      priorChallenge &&
      priorChallenge.solved_status === 'SOLVED_INDEPENDENTLY' &&
      priorChallenge.perceived_difficulty !== 'HARD'
    );

    // Look at last 7 days of daily problems for hint topics or struggle topics
    const recentRows = db.prepare(`
      SELECT dp.solved_status, dp.perceived_difficulty, p.tags
      FROM daily_problems dp
      JOIN problems p ON dp.problem_id = p.id
      WHERE dp.profile_id = ? AND dp.daily_set_date >= date(?, '-7 days') AND dp.daily_set_date < ?
    `).all(profileId, currentDate, currentDate) as any[];

    const recentHintTopics = new Set<string>();
    const recentStruggledTopics = new Set<string>();
    let easySolvesCount = 0;
    let hardOrFailedCount = 0;

    for (const r of recentRows) {
      const tags: string[] = JSON.parse(r.tags || '[]');
      if (r.solved_status === 'SOLVED_WITH_HINTS' || r.solved_status === 'VIEWED_EDITORIAL') {
        tags.forEach((t) => recentHintTopics.add(t));
      }
      if (r.perceived_difficulty === 'HARD' || r.solved_status === 'NOT_SOLVED') {
        tags.forEach((t) => recentStruggledTopics.add(t));
        hardOrFailedCount++;
      }
      if (r.solved_status === 'SOLVED_INDEPENDENTLY' && r.perceived_difficulty === 'EASY') {
        easySolvesCount++;
      }
    }

    // Also scan recent contest problem reviews (last 14 days)
    try {
      const recentContestReviews = db.prepare(`
        SELECT r.contest_id, r.problem_index, r.self_review_tag, r.upsolve_status,
               COALESCE(m.tags, p.tags, '[]') as tags
        FROM contest_problem_reviews r
        LEFT JOIN contest_problems_meta m ON r.contest_id = m.contest_id AND r.problem_index = m.problem_index
        LEFT JOIN problems p ON p.id = (r.contest_id || '_' || r.problem_index)
        WHERE r.profile_id = ?
      `).all(profileId) as Array<{
        contest_id: number;
        problem_index: string;
        self_review_tag: string | null;
        upsolve_status: string;
        tags: string;
      }>;

      for (const cr of recentContestReviews) {
        const tags: string[] = JSON.parse(cr.tags || '[]');
        if (
          cr.self_review_tag === 'DID_NOT_RECOGNIZE_ALGORITHM' ||
          cr.self_review_tag === 'STRUGGLED_WITH_IMPLEMENTATION' ||
          cr.self_review_tag === 'BUG_DEBUGGING_DIFFICULTY'
        ) {
          tags.forEach((t) => recentStruggledTopics.add(t));
          hardOrFailedCount++;
        }
        if (cr.upsolve_status === 'UPSOLVED_WITH_EDITORIAL' || cr.upsolve_status === 'UPSOLVED_WITH_HINTS') {
          tags.forEach((t) => recentHintTopics.add(t));
        }
      }
    } catch {}

    const overallRecentComfort = easySolvesCount > hardOrFailedCount && hardOrFailedCount === 0;

    return {
      hasPriorSet: true,
      priorDate: priorSet.date,
      weaknessStruggled,
      weaknessTag,
      weaknessProblemName: priorWeakness?.name,
      weaknessStatus: priorWeakness?.solved_status,
      weaknessDifficulty: priorWeakness?.perceived_difficulty,
      weaknessSolvedEasily,
      recentHintTopics: Array.from(recentHintTopics),
      recentStruggledTopics: Array.from(recentStruggledTopics),
      recentChallengeSolved,
      overallRecentComfort,
    };
  }

  private generateDailySet(profileId: string, handle: string, date: string): DailySet {
    // 1. Profile rating baseline
    const profileRow = db.prepare('SELECT rating FROM profiles WHERE id = ?').get(profileId) as { rating: number | null } | undefined;
    const userRating = profileRow?.rating && profileRow.rating > 0 ? profileRow.rating : 1300;

    // 2. Adaptive topic analysis incorporating longitudinal feedback up to this date
    const topics = analysisService.analyzeTopics(handle, userRating, profileId, date);
    const weakTopics = topics.filter((t) => t.status === 'WEAK');
    const unexploredTopics = topics.filter((t) => t.status === 'UNEXPLORED');
    const strongTopics = topics.filter((t) => t.status === 'STRONG');

    // 3. Prior day & recent week performance context
    const priorContext = this.analyzePriorDays(profileId, date);

    // 4. Strict exclusion list:
    // a) Solved on Codeforces
    const solvedRows = db.prepare(`
      SELECT DISTINCT problem_id FROM submissions
      WHERE handle = ? AND verdict = 'OK'
    `).all(handle) as Array<{ problem_id: string }>;
    const excludedIds = new Set<string>(solvedRows.map((r) => r.problem_id));

    // The submissions table is rebuilt from Codeforces after a cold start. The
    // browser snapshot restores verified learning events first, so honor those
    // too and never recommend a problem this profile has already solved.
    const verifiedEventRows = db.prepare(`
      SELECT DISTINCT problem_id FROM problem_learning_events
      WHERE profile_id = ?
        AND (verified_ac = 1 OR source = 'VERIFIED_CODEFORCES' OR solved_status = 'VERIFIED_ACCEPTED')
    `).all(profileId) as Array<{ problem_id: string }>;
    for (const row of verifiedEventRows) {
      excludedIds.add(row.problem_id);
    }

    // b) Solved in prior daily problems by this profile
    const solvedDailyRows = db.prepare(`
      SELECT DISTINCT problem_id FROM daily_problems
      WHERE profile_id = ? AND (completed = 1 OR solved_status = 'SOLVED_INDEPENDENTLY')
    `).all(profileId) as Array<{ problem_id: string }>;
    for (const r of solvedDailyRows) {
      excludedIds.add(r.problem_id);
    }

    // c) Assigned to this profile in recent 14 days (anti-repetition / cooldown)
    const recentAssignedRows = db.prepare(`
      SELECT DISTINCT problem_id FROM daily_problems
      WHERE profile_id = ? AND daily_set_date >= date(?, '-14 days') AND daily_set_date < ?
    `).all(profileId, date, date) as Array<{ problem_id: string }>;
    for (const r of recentAssignedRows) {
      excludedIds.add(r.problem_id);
    }

    // Query candidate problems using class helper with recency preference
    const findCandidate = (
      preferredTags: string[],
      minRating: number,
      maxRating: number,
      chosenIds: Set<string>
    ) => this.findCandidateProblem(preferredTags, minRating, maxRating, excludedIds, chosenIds);

    const chosenIds = new Set<string>();
    const recommendations: Array<{
      category: DailyProblemCategory;
      problemId: string;
      reason: string;
      targetRating: number;
      problem: CFProblem;
      educationalSource?: EducationalSource;
      educationalSourceUrl?: string;
      curriculumStage?: string;
      learningObjective?: string;
      prerequisites?: string[];
    }> = [];

    // ─────────────────────────────────────────────────────────────
    // SLOT 1: WEAKNESS DRILL (Adaptive to struggle / comfort)
    // ─────────────────────────────────────────────────────────────
    let weaknessTargetRatingMin: number;
    let weaknessTargetRatingMax: number;
    let weaknessTagsToTry: string[] = [];
    let weaknessReasonPrefix = '';

    if (priorContext.weaknessStruggled && priorContext.weaknessTag) {
      weaknessTagsToTry = [priorContext.weaknessTag, ...weakTopics.map((t) => t.tag)];
      weaknessTargetRatingMin = Math.max(800, userRating - 200);
      weaknessTargetRatingMax = Math.max(800, userRating - 50);
      weaknessReasonPrefix = `Weakness Follow-up: Following up on ${priorContext.priorDate}'s drill in '${priorContext.weaknessTag}' (${priorContext.weaknessDifficulty || 'unsolved'}). Calibrated slightly easier to solidify core mechanics without brick-walling.`;
    } else if (priorContext.weaknessSolvedEasily && priorContext.weaknessTag) {
      const remainingWeaknesses = weakTopics.filter((t) => t.tag !== priorContext.weaknessTag);
      weaknessTagsToTry = remainingWeaknesses.length > 0
        ? remainingWeaknesses.map((t) => t.tag)
        : [priorContext.weaknessTag, ...unexploredTopics.map((t) => t.tag)];
      weaknessTargetRatingMin = Math.max(800, userRating - 50);
      weaknessTargetRatingMax = userRating + 50;
      weaknessReasonPrefix = `Weakness Progression: After comfortably solving ${priorContext.priorDate}'s '${priorContext.weaknessTag}' drill, advancing to target priority weakness at contest standard.`;
    } else {
      weaknessTagsToTry = weakTopics.map((t) => t.tag);
      if (weaknessTagsToTry.length === 0) {
        unexploredTopics.forEach((t) => weaknessTagsToTry.push(t.tag));
        if (weaknessTagsToTry.length === 0) weaknessTagsToTry.push('implementation', 'math', 'greedy');
      }
      weaknessTargetRatingMin = Math.max(800, userRating - 150);
      weaknessTargetRatingMax = userRating;
    }

    const cand1 = findCandidate(
      weaknessTagsToTry,
      weaknessTargetRatingMin,
      weaknessTargetRatingMax,
      chosenIds
    );

    if (cand1) {
      chosenIds.add(cand1.problemId);
      const weakMatch = weakTopics.find((t) => t.tag === cand1.tagUsed);
      const userReason = weaknessReasonPrefix || (weakMatch
        ? `Weakness Drill: Targets weak topic '${cand1.tagUsed}' (weakness score ${weakMatch.weaknessScore}, ${weakMatch.solveRate}% solve rate) at calibrated rating ${cand1.problem.rating || userRating}.`
        : `Foundational Drill: Explores topic '${cand1.tagUsed}' at rating ${cand1.problem.rating || userRating} to build consistent patterns.`);
      
      const eduInfo = cand1.learningObjective ? ` Objective: ${cand1.learningObjective}` : '';
      const fullReason = `${userReason}${eduInfo}`;

      recommendations.push({
        category: 'WEAKNESS_DRILL',
        problemId: cand1.problemId,
        reason: fullReason,
        targetRating: cand1.problem.rating || userRating,
        problem: cand1.problem,
        educationalSource: cand1.educationalSource,
        educationalSourceUrl: cand1.educationalSourceUrl,
        curriculumStage: cand1.curriculumStage,
        learningObjective: cand1.learningObjective,
        prerequisites: cand1.prerequisites,
      });
    }

    // ─────────────────────────────────────────────────────────────
    // SLOT 2: REINFORCEMENT (Consolidating hints, secondary weakness, or review)
    // ─────────────────────────────────────────────────────────────
    const reinforcementTags: string[] = [];

    const hintCandidates = priorContext.recentHintTopics.filter((t) => t !== cand1?.tagUsed);
    if (hintCandidates.length > 0) {
      reinforcementTags.push(...hintCandidates);
    }

    for (const t of weakTopics) {
      if (t.tag !== cand1?.tagUsed && !reinforcementTags.includes(t.tag)) {
        reinforcementTags.push(t.tag);
      }
    }

    for (const t of unexploredTopics) {
      if (t.tag !== cand1?.tagUsed && !reinforcementTags.includes(t.tag)) {
        reinforcementTags.push(t.tag);
      }
    }

    for (const t of strongTopics) {
      if (t.tag !== cand1?.tagUsed && !reinforcementTags.includes(t.tag)) {
        reinforcementTags.push(t.tag);
      }
    }

    if (reinforcementTags.length === 0) {
      reinforcementTags.push('greedy', 'data structures', 'binary search', 'two pointers');
    }

    const cand2 = findCandidate(
      reinforcementTags,
      Math.max(800, userRating - 50),
      userRating + 100,
      chosenIds
    );

    if (cand2) {
      chosenIds.add(cand2.problemId);
      const isHintFollowup = priorContext.recentHintTopics.includes(cand2.tagUsed);
      const userReason = isHintFollowup
        ? `Reinforcement: Consolidating '${cand2.tagUsed}' after needing hints in recent sessions. Target rating ${cand2.problem.rating || userRating} to build full independence.`
        : `Reinforcement: Practice '${cand2.tagUsed}' at rating ${cand2.problem.rating || userRating} to maintain speed and avoid mistakes under contest conditions.`;

      const eduInfo = cand2.learningObjective ? ` Objective: ${cand2.learningObjective}` : '';
      const fullReason = `${userReason}${eduInfo}`;

      recommendations.push({
        category: 'REINFORCEMENT',
        problemId: cand2.problemId,
        reason: fullReason,
        targetRating: cand2.problem.rating || userRating,
        problem: cand2.problem,
        educationalSource: cand2.educationalSource,
        educationalSourceUrl: cand2.educationalSourceUrl,
        curriculumStage: cand2.curriculumStage,
        learningObjective: cand2.learningObjective,
        prerequisites: cand2.prerequisites,
      });
    }

    // ─────────────────────────────────────────────────────────────
    // SLOT 3: CHALLENGE (Scaled to comfort vs. fatigue)
    // ─────────────────────────────────────────────────────────────
    const challengeTags: string[] = [];
    for (const t of strongTopics) {
      if (t.tag !== cand1?.tagUsed && t.tag !== cand2?.tagUsed) challengeTags.push(t.tag);
    }
    for (const t of weakTopics) {
      if (t.tag !== cand1?.tagUsed && t.tag !== cand2?.tagUsed) challengeTags.push(t.tag);
    }
    challengeTags.push('dp', 'graphs', 'data structures', 'constructive algorithms', 'math');

    const challengeRatingMin = priorContext.recentChallengeSolved || priorContext.overallRecentComfort
      ? userRating + 150
      : userRating + 50;
    const challengeRatingMax = priorContext.recentChallengeSolved || priorContext.overallRecentComfort
      ? userRating + 250
      : userRating + 150;

    const cand3 = findCandidate(
      challengeTags,
      challengeRatingMin,
      challengeRatingMax,
      chosenIds
    );

    if (cand3) {
      chosenIds.add(cand3.problemId);
      const delta = (cand3.problem.rating || (userRating + 100)) - userRating;
      const userReason = (priorContext.recentChallengeSolved || priorContext.overallRecentComfort)
        ? `Challenge: Advanced stretch problem in '${cand3.tagUsed}' rated ${cand3.problem.rating} (+${delta} above rating) following strong recent performance.`
        : `Challenge: Accessible stretch problem in '${cand3.tagUsed}' rated ${cand3.problem.rating} (+${delta} above rating) to expand problem threshold comfortably.`;

      const eduInfo = cand3.learningObjective ? ` Objective: ${cand3.learningObjective}` : '';
      const fullReason = `${userReason}${eduInfo}`;

      recommendations.push({
        category: 'CHALLENGE',
        problemId: cand3.problemId,
        reason: fullReason,
        targetRating: cand3.problem.rating || (userRating + 100),
        problem: cand3.problem,
        educationalSource: cand3.educationalSource,
        educationalSourceUrl: cand3.educationalSourceUrl,
        curriculumStage: cand3.curriculumStage,
        learningObjective: cand3.learningObjective,
        prerequisites: cand3.prerequisites,
      });
    }

    if (recommendations.length !== 3) {
      throw new Error(
        `Unable to build the three daily recommendations (${recommendations.length} eligible Codeforces problems found). ` +
        'The Codeforces problemset cache may still be syncing; retry shortly.'
      );
    }

    // Strict Codeforces-only invariant validation: Every single recommended problem must link to Codeforces
    for (const rec of recommendations) {
      if (!rec.educationalSourceUrl || !rec.educationalSourceUrl.startsWith('https://codeforces.com')) {
        throw new Error(`CRITICAL: Problem ${rec.problemId} has non-Codeforces URL: ${rec.educationalSourceUrl}`);
      }
      if (!rec.problem.contestId || rec.problem.contestId <= 0 || rec.problem.contestId >= 100000 || rec.problem.contestId === 99999) {
        throw new Error(`CRITICAL: Problem ${rec.problemId} has invalid non-Codeforces contest ID: ${rec.problem.contestId}`);
      }
      if (!rec.problem.index) {
        throw new Error(`CRITICAL: Problem ${rec.problemId} missing Codeforces index`);
      }
    }

    const dailySetId = `${profileId}_${date}`;

    // Write daily set and problems in transaction
    db.exec('BEGIN TRANSACTION');
    try {
      db.prepare(`
        INSERT INTO daily_sets (id, profile_id, date, generated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(profile_id, date) DO UPDATE SET generated_at = datetime('now')
      `).run(dailySetId, profileId, date);

      const ensureProblem = db.prepare(`
        INSERT OR IGNORE INTO problems (id, contest_id, problem_index, name, type, rating, tags, solved_count)
        VALUES (?, ?, ?, ?, 'PROGRAMMING', ?, ?, 500)
      `);

      const insertDailyProb = db.prepare(`
        INSERT INTO daily_problems (
          id, daily_set_id, profile_id, daily_set_date, problem_id, category, reason,
          target_rating, completed, verified_cf_ac, educational_source, educational_source_url,
          curriculum_stage, learning_objective, prerequisites, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, datetime('now'))
      `);

      for (const rec of recommendations) {
        const problemId = rec.problemId;
        const contestId = rec.problem.contestId;
        const index = rec.problem.index;

        ensureProblem.run(
          problemId,
          contestId,
          index,
          rec.problem.name || problemId,
          rec.problem.rating || 1000,
          JSON.stringify(rec.problem.tags || [])
        );

        const id = `${dailySetId}_${rec.category}`;
        insertDailyProb.run(
          id,
          dailySetId,
          profileId,
          date,
          problemId,
          rec.category,
          rec.reason,
          rec.targetRating,
          rec.educationalSource || null,
          rec.educationalSourceUrl || null,
          rec.curriculumStage || null,
          rec.learningObjective || null,
          JSON.stringify(rec.prerequisites || [])
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // Refresh persistent learner model on new generation
    try {
      analysisService.buildLearnerModel(profileId, handle, userRating);
    } catch (mErr) {
      console.warn('Learner model update non-critical warning:', mErr);
    }

    return this.loadDailySet(profileId, date);
  }

  saveFeedback(
    dailyProblemId: string,
    payload: FeedbackPayload
  ): DailyProblem | null {
    const existing = db.prepare(`
      SELECT dp.problem_id, dp.profile_id, dp.verified_cf_ac, p.contest_id, p.problem_index, prof.handle
      FROM daily_problems dp
      JOIN problems p ON dp.problem_id = p.id
      JOIN profiles prof ON dp.profile_id = prof.id
      WHERE dp.id = ?
    `).get(dailyProblemId) as any;

    let isVerifiedAc = existing?.verified_cf_ac === 1 ? 1 : 0;
    if (existing && !isVerifiedAc) {
      const acRow = db.prepare(`
        SELECT id FROM submissions
        WHERE handle = ? AND (problem_id = ? OR (contest_id = ? AND problem_index = ?)) AND verdict = 'OK'
        LIMIT 1
      `).get(existing.handle, existing.problem_id, existing.contest_id, existing.problem_index);
      if (acRow) {
        isVerifiedAc = 1;
      }
    }

    const isSelfReported = (payload.solvedStatus === 'SOLVED_INDEPENDENTLY' || payload.solvedStatus === 'SOLVED_WITH_HINTS' || payload.solvedStatus === 'VIEWED_EDITORIAL') ? 1 : 0;
    const completed = (isVerifiedAc === 1 || isSelfReported === 1) ? 1 : 0;

    db.exec('BEGIN TRANSACTION');
    try {
      db.prepare(`
        UPDATE daily_problems
        SET
          completed = ?,
          self_reported_solved = ?,
          solved_status = ?,
          perceived_difficulty = ?,
          difficulty_experience = ?,
          solution_method = ?,
          time_spent_minutes = ?,
          notes = ?,
          struggle_reason = ?,
          problem_opinion = ?,
          verified_cf_ac = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        completed,
        isSelfReported,
        payload.solvedStatus,
        payload.perceivedDifficulty ?? null,
        payload.difficultyExperience ?? null,
        payload.solutionMethod ?? null,
        payload.timeSpentMinutes ?? null,
        payload.notes ?? null,
        payload.struggleReason ?? null,
        payload.problemOpinion ?? null,
        isVerifiedAc,
        dailyProblemId
      );

      if (existing) {
        problemJournalService.record({
          profileId: existing.profile_id,
          problemId: existing.problem_id,
          source: 'DAILY_FEEDBACK',
          solvedStatus: payload.solvedStatus,
          perceivedDifficulty: payload.perceivedDifficulty ?? null,
          difficultyExperience: payload.difficultyExperience ?? null,
          solutionMethod: payload.solutionMethod ?? null,
          struggleReason: payload.struggleReason ?? null,
          notes: payload.notes ?? null,
          problemOpinion: payload.problemOpinion ?? null,
          verifiedAc: isVerifiedAc === 1,
        });

        const struggleSignals = [
          payload.solvedStatus !== 'SOLVED_INDEPENDENTLY' ? payload.solvedStatus : null,
          payload.solutionMethod && payload.solutionMethod !== 'INDEPENDENT' ? payload.solutionMethod : null,
          payload.perceivedDifficulty === 'HARD' ? 'HARD_DIFFICULTY' : null,
          payload.difficultyExperience === 'CHALLENGING' || payload.difficultyExperience === 'MUCH_HARDER'
            ? payload.difficultyExperience
            : null,
          payload.struggleReason,
          payload.problemOpinion === 'TOO_DIFFICULT' ? payload.problemOpinion : null,
        ].filter((signal): signal is string => Boolean(signal));
        if (struggleSignals.length > 0) {
          reviewService.enqueueProblem(
            existing.profile_id,
            existing.problem_id,
            `Daily feedback: ${struggleSignals.join(', ')}`,
            'DAILY_STRUGGLE'
          );
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }

    // Immediately update learner model to reflect this feedback
    if (existing) {
      try {
        analysisService.buildLearnerModel(existing.profile_id, existing.handle);
      } catch (mErr) {
        console.warn('Could not refresh learner model upon feedback:', mErr);
      }
    }

    return this.loadDailyProblem(dailyProblemId);
  }

  loadDailyProblem(dailyProblemId: string): DailyProblem | null {
    const row = db.prepare(`
      SELECT dp.*, p.contest_id, p.problem_index, p.name, p.type, p.rating, p.tags, p.solved_count
      FROM daily_problems dp
      JOIN problems p ON dp.problem_id = p.id
      WHERE dp.id = ?
    `).get(dailyProblemId) as any;

    if (!row) return null;

    let tags: string[] = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch {}

    let prerequisites: string[] = [];
    try { prerequisites = JSON.parse(row.prerequisites || '[]'); } catch {}

    const isOpened = Boolean(row.is_opened);
    const attempted = Boolean(row.attempted);
    const verifiedCfAc = Boolean(row.verified_cf_ac);
    const selfReportedSolved = Boolean(row.self_reported_solved);

    let completionState: 'NOT_OPENED' | 'OPENED' | 'ATTEMPTED' | 'SOLVED_SELF_REPORTED' | 'SOLVED_VERIFIED' = 'NOT_OPENED';
    if (verifiedCfAc) {
      completionState = 'SOLVED_VERIFIED';
    } else if (selfReportedSolved) {
      completionState = 'SOLVED_SELF_REPORTED';
    } else if (attempted) {
      completionState = 'ATTEMPTED';
    } else if (isOpened) {
      completionState = 'OPENED';
    } else {
      completionState = 'NOT_OPENED';
    }

    return {
      id: row.id,
      dailySetId: row.daily_set_id,
      profileId: row.profile_id,
      dailySetDate: row.daily_set_date,
      problemId: row.problem_id,
      category: row.category as DailyProblemCategory,
      reason: row.reason,
      targetRating: row.target_rating,
      completed: Boolean(row.completed),
      solvedStatus: row.solved_status as ProblemSolvedStatus | null,
      perceivedDifficulty: row.perceived_difficulty as PerceivedDifficulty | null,
      difficultyExperience: row.difficulty_experience as DailyProblem['difficultyExperience'],
      solutionMethod: row.solution_method as DailyProblem['solutionMethod'],
      timeSpentMinutes: row.time_spent_minutes,
      notes: row.notes,
      struggleReason: row.struggle_reason,
      problemOpinion: row.problem_opinion as DailyProblem['problemOpinion'],
      verifiedCfAc,
      isOpened,
      openedAt: row.opened_at,
      attempted,
      selfReportedSolved,
      completionState,
      updatedAt: row.updated_at,
      educationalSource: row.educational_source as EducationalSource | undefined,
      educationalSourceUrl: row.educational_source_url,
      curriculumStage: row.curriculum_stage,
      learningObjective: row.learning_objective,
      prerequisites,
      problem: {
        contestId: row.contest_id,
        index: row.problem_index,
        name: row.name,
        type: row.type,
        rating: row.rating,
        tags,
        solvedCount: row.solved_count,
      },
      tutorial: tutorialService.getTutorial(row.problem_id),
    };
  }

  findCandidateProblem(
    preferredTags: string[],
    minRating: number,
    maxRating: number,
    excludedIds: Set<string>,
    chosenIds: Set<string>
  ): {
    problemId: string;
    problem: CFProblem;
    tagUsed: string;
    educationalSource?: EducationalSource;
    educationalSourceUrl?: string;
    curriculumStage?: string;
    learningObjective?: string;
    prerequisites?: string[];
  } | null {
    const targetMidRating = (minRating + maxRating) / 2;

    const rankCandidates = (rows: any[]): any[] => {
      return [...rows].sort((a, b) => {
        // 1. Recency component: use only verified official contest dates.
        // Missing metadata gets zero, never a guessed date from contest ID.
        const nowSeconds = Math.floor(Date.now() / 1000);
        const ageDays = (startTime: number | null | undefined) => startTime && startTime > 0
          ? Math.max(0, (nowSeconds - startTime) / 86400)
          : Number.POSITIVE_INFINITY;
        const recencyA = Number.isFinite(ageDays(a.start_time_seconds))
          ? Math.max(0, 100 - ageDays(a.start_time_seconds) / 30)
          : 0;
        const recencyB = Number.isFinite(ageDays(b.start_time_seconds))
          ? Math.max(0, 100 - ageDays(b.start_time_seconds) / 30)
          : 0;

        // 2. Solves component: prefer well-tested problems (smooth logarithmic scale)
        const solveA = Math.min(Math.log10(Math.max(10, a.solved_count || 100)) * 20, 80);
        const solveB = Math.min(Math.log10(Math.max(10, b.solved_count || 100)) * 20, 80);

        // 3. Rating proximity to target rating window center
        const rDistA = Math.abs((a.rating || targetMidRating) - targetMidRating);
        const rDistB = Math.abs((b.rating || targetMidRating) - targetMidRating);
        const ratingScoreA = Math.max(0, 40 - rDistA * 0.2);
        const ratingScoreB = Math.max(0, 40 - rDistB * 0.2);

        // Recency is intentionally a modest tie-break preference. Topic and
        // difficulty relevance remain the dominant signals.
        const scoreA = recencyA * 0.12 + solveA * 0.8 + ratingScoreA;
        const scoreB = recencyB * 0.12 + solveB * 0.8 + ratingScoreB;
        return scoreB - scoreA;
      });
    };

    // 1. Prioritize verified Codeforces educational curriculum problems
    for (const tag of preferredTags) {
      const curriculumRows = db.prepare(`
        SELECT cp.*, p.name as prob_name, p.contest_id, p.problem_index, p.rating as prob_rating, p.tags as prob_tags, p.solved_count,
               cc.start_time_seconds
        FROM curriculum_problems cp
        LEFT JOIN problems p ON cp.problem_id = p.id
        LEFT JOIN codeforces_contests cc ON cc.contest_id = cp.cf_contest_id
        WHERE cp.topic = ? AND cp.target_rating >= ? AND cp.target_rating <= ?
          AND cp.cf_contest_id IS NOT NULL AND cp.cf_contest_id > 0 AND cp.cf_contest_id < 100000 AND cp.cf_contest_id != 99999
          AND cp.cf_index IS NOT NULL
          AND (cp.source_url LIKE 'https://codeforces.com/%' OR cp.source_url LIKE 'http://codeforces.com/%')
      `).all(tag, Math.max(800, minRating - 100), maxRating + 100) as any[];

      const eligibleCurriculum = curriculumRows.filter((row) => {
        const problemId = row.problem_id;
        return row.cf_contest_id && row.cf_contest_id > 0 && row.cf_contest_id < 100000 && row.cf_contest_id !== 99999 && row.cf_index && !excludedIds.has(problemId) && !chosenIds.has(problemId);
      });
      for (const row of rankCandidates(eligibleCurriculum)) {
        const problemId = row.problem_id;
        if (row.cf_contest_id && row.cf_index) {
          const contestId = row.cf_contest_id;
          const index = row.cf_index;
          const cfUrl = row.source_url?.startsWith('https://codeforces.com')
            ? row.source_url
            : `https://codeforces.com/problemset/problem/${contestId}/${index}`;

          return {
            problemId,
            problem: {
              contestId,
              index,
              name: row.name || row.prob_name || `Problem ${contestId}${index}`,
              type: 'PROGRAMMING',
              rating: row.target_rating || row.prob_rating,
              tags: [row.topic],
              solvedCount: row.solved_count || 500,
            },
            tagUsed: row.topic,
            educationalSource: row.source as EducationalSource,
            educationalSourceUrl: cfUrl,
            curriculumStage: row.curriculum_stage,
            learningObjective: row.learning_objective,
            prerequisites: JSON.parse(row.prerequisites || '[]'),
          };
        }
      }
    }

    // 2. Query Codeforces problemset candidates with tag matches, ranked preferring recent rounds
    for (const tag of preferredTags) {
      const rows = db.prepare(`
        SELECT p.id, p.contest_id, p.problem_index, p.name, p.type, p.rating, p.tags, p.solved_count,
               cc.start_time_seconds
        FROM problems p
        LEFT JOIN codeforces_contests cc ON cc.contest_id = p.contest_id
        WHERE p.rating >= ? AND p.rating <= ?
          AND p.tags LIKE ?
          AND p.contest_id > 0 AND p.contest_id < 100000 AND p.contest_id != 99999
          AND p.problem_index IS NOT NULL AND trim(p.problem_index) != ''
        -- Rank the complete eligible pool in TypeScript. A hard LIMIT here
        -- can hide newer official-round problems before the recency
        -- preference is applied, especially when SQLite returns older rows
        -- first. Relevance and difficulty still dominate in rankCandidates.
      `).all(minRating, maxRating, `%${tag}%`) as any[];

      const eligible = rows.filter((r) => !excludedIds.has(r.id) && !chosenIds.has(r.id));
      const ranked = rankCandidates(eligible);

      if (ranked.length > 0) {
        const row = ranked[0];
        const curCheck = db.prepare("SELECT * FROM curriculum_problems WHERE problem_id = ? AND (source_url LIKE 'https://codeforces.com/%')").get(row.id) as any;
        const cfUrl = curCheck && curCheck.source_url?.startsWith('https://codeforces.com')
          ? curCheck.source_url
          : `https://codeforces.com/problemset/problem/${row.contest_id}/${row.problem_index}`;

        return {
          problemId: row.id,
          problem: {
            contestId: row.contest_id,
            index: row.problem_index,
            name: row.name,
            type: row.type,
            rating: row.rating,
            tags: JSON.parse(row.tags || '[]'),
            solvedCount: row.solved_count,
          },
          tagUsed: tag,
          educationalSource: curCheck ? (curCheck.source as EducationalSource) : 'CODEFORCES_PROBLEMSET',
          educationalSourceUrl: cfUrl,
          curriculumStage: curCheck ? curCheck.curriculum_stage : undefined,
          learningObjective: curCheck ? curCheck.learning_objective : `Develop consistent pattern recognition for '${tag}' within competitive contest rating constraints.`,
          prerequisites: curCheck ? JSON.parse(curCheck.prerequisites || '[]') : [tag],
        };
      }
    }

    // 3. Fallback within rating bracket without tag constraints
    const fallbackRows = db.prepare(`
      SELECT p.id, p.contest_id, p.problem_index, p.name, p.type, p.rating, p.tags, p.solved_count,
             cc.start_time_seconds
      FROM problems p
      LEFT JOIN codeforces_contests cc ON cc.contest_id = p.contest_id
      WHERE p.rating >= ? AND p.rating <= ?
        AND p.contest_id > 0 AND p.contest_id < 100000 AND p.contest_id != 99999
        AND p.problem_index IS NOT NULL AND trim(p.problem_index) != ''
      -- Keep the full eligible pool so verified contest dates can influence
      -- recency without silently excluding newer problems.
    `).all(Math.max(800, minRating - 100), maxRating + 100) as any[];

    const eligibleFallback = fallbackRows.filter((r) => !excludedIds.has(r.id) && !chosenIds.has(r.id));
    const rankedFallback = rankCandidates(eligibleFallback);

    if (rankedFallback.length > 0) {
      const row = rankedFallback[0];
      const curCheck = db.prepare("SELECT * FROM curriculum_problems WHERE problem_id = ? AND (source_url LIKE 'https://codeforces.com/%')").get(row.id) as any;
      const cfUrl = curCheck && curCheck.source_url?.startsWith('https://codeforces.com')
        ? curCheck.source_url
        : `https://codeforces.com/problemset/problem/${row.contest_id}/${row.problem_index}`;

      return {
        problemId: row.id,
        problem: {
          contestId: row.contest_id,
          index: row.problem_index,
          name: row.name,
          type: row.type,
          rating: row.rating,
          tags: JSON.parse(row.tags || '[]'),
          solvedCount: row.solved_count,
        },
        tagUsed: 'general',
        educationalSource: curCheck ? (curCheck.source as EducationalSource) : 'CODEFORCES_PROBLEMSET',
        educationalSourceUrl: cfUrl,
        curriculumStage: curCheck ? curCheck.curriculum_stage : undefined,
        learningObjective: curCheck ? curCheck.learning_objective : 'Foundational problem solving to maintain contest implementation sharpness.',
        prerequisites: curCheck ? JSON.parse(curCheck.prerequisites || '[]') : ['implementation'],
      };
    }

    return null;
  }

  replaceDailyProblem(
    profileIdOrHandle: string,
    dailyProblemId: string,
    targetDate?: string
  ): DailyProblem {
    let profile = getProfileById(profileIdOrHandle) || getProfileByHandle(profileIdOrHandle);
    if (!profile) {
      throw new Error(`Profile '${profileIdOrHandle}' not found`);
    }
    const profileId = profile.id;
    const date = targetDate || this.getTodayDateString();

    const dailyProb = db.prepare(`
      SELECT dp.*, p.name as prob_name, p.tags as prob_tags, p.rating as prob_rating
      FROM daily_problems dp
      JOIN problems p ON dp.problem_id = p.id
      WHERE dp.id = ? AND dp.profile_id = ?
    `).get(dailyProblemId, profileId) as any;

    if (!dailyProb) {
      throw new Error(`Daily problem '${dailyProblemId}' not found for profile '${profileId}'`);
    }

    const category = dailyProb.category as DailyProblemCategory;

    // Gather existing problems in the daily set to avoid duplicates
    const currentSetProblems = db.prepare(`
      SELECT problem_id FROM daily_problems WHERE daily_set_id = ? AND id != ?
    `).all(dailyProb.daily_set_id, dailyProb.id) as Array<{ problem_id: string }>;

    const chosenIds = new Set<string>(currentSetProblems.map((p) => p.problem_id));
    chosenIds.add(dailyProb.problem_id); // Do not reroll into the exact same problem

    // Strict exclusion list
    const solvedRows = db.prepare(`
      SELECT DISTINCT problem_id FROM submissions
      WHERE handle = ? AND verdict = 'OK'
    `).all(profile.handle) as Array<{ problem_id: string }>;
    const excludedIds = new Set<string>(solvedRows.map((r) => r.problem_id));

    const solvedDailyRows = db.prepare(`
      SELECT DISTINCT problem_id FROM daily_problems
      WHERE profile_id = ? AND (completed = 1 OR solved_status = 'SOLVED_INDEPENDENTLY')
    `).all(profileId) as Array<{ problem_id: string }>;
    for (const r of solvedDailyRows) excludedIds.add(r.problem_id);

    const recentAssignedRows = db.prepare(`
      SELECT DISTINCT problem_id FROM daily_problems
      WHERE profile_id = ? AND daily_set_date >= date(?, '-14 days') AND daily_set_date < ?
    `).all(profileId, date, date) as Array<{ problem_id: string }>;
    for (const r of recentAssignedRows) excludedIds.add(r.problem_id);

    const userRating = profile.rating && profile.rating > 0 ? profile.rating : 1300;
    const topics = analysisService.analyzeTopics(profile.handle, userRating, profileId, date);
    const weakTopics = topics.filter((t) => t.status === 'WEAK');
    const unexploredTopics = topics.filter((t) => t.status === 'UNEXPLORED');
    const strongTopics = topics.filter((t) => t.status === 'STRONG');

    let targetTags: string[] = [];
    let minRating: number;
    let maxRating: number;
    let reasonPrefix = '';

    if (category === 'WEAKNESS_DRILL') {
      targetTags = weakTopics.map((t) => t.tag);
      if (targetTags.length === 0) targetTags = unexploredTopics.map((t) => t.tag);
      if (targetTags.length === 0) targetTags = ['greedy', 'math', 'implementation'];
      minRating = Math.max(800, userRating - 150);
      maxRating = userRating;
      reasonPrefix = 'Replaced Drill: Fresh problem targeting priority weakness with preference for recent rounds.';
    } else if (category === 'REINFORCEMENT') {
      targetTags = weakTopics.slice(1).map((t) => t.tag);
      unexploredTopics.forEach((t) => targetTags.push(t.tag));
      strongTopics.forEach((t) => targetTags.push(t.tag));
      if (targetTags.length === 0) targetTags = ['two pointers', 'binary search', 'greedy'];
      minRating = Math.max(800, userRating - 50);
      maxRating = userRating + 100;
      reasonPrefix = 'Replaced Reinforcement: Alternate consolidation problem from recent contests.';
    } else {
      // CHALLENGE
      strongTopics.forEach((t) => targetTags.push(t.tag));
      weakTopics.forEach((t) => targetTags.push(t.tag));
      targetTags.push('dp', 'graphs', 'data structures', 'constructive algorithms');
      minRating = userRating + 50;
      maxRating = userRating + 250;
      reasonPrefix = 'Replaced Challenge: New stretch problem calibrated above rating threshold.';
    }

    const candidate = this.findCandidateProblem(targetTags, minRating, maxRating, excludedIds, chosenIds);
    if (!candidate) {
      throw new Error(`Unable to find an eligible replacement Codeforces problem for category ${category}`);
    }

    // Ensure problem exists in problems table
    db.prepare(`
      INSERT OR IGNORE INTO problems (id, contest_id, problem_index, name, type, rating, tags, solved_count)
      VALUES (?, ?, ?, ?, 'PROGRAMMING', ?, ?, 500)
    `).run(
      candidate.problemId,
      candidate.problem.contestId,
      candidate.problem.index,
      candidate.problem.name || candidate.problemId,
      candidate.problem.rating || userRating,
      JSON.stringify(candidate.problem.tags || [])
    );

    const fullReason = `${reasonPrefix} ${candidate.learningObjective ? 'Objective: ' + candidate.learningObjective : ''}`.trim();

    db.prepare(`
      UPDATE daily_problems
      SET 
        problem_id = ?,
        reason = ?,
        target_rating = ?,
        completed = 0,
        is_opened = 0,
        opened_at = NULL,
        attempted = 0,
        self_reported_solved = 0,
        verified_cf_ac = 0,
        solved_status = NULL,
        perceived_difficulty = NULL,
        time_spent_minutes = NULL,
        notes = NULL,
        struggle_reason = NULL,
        educational_source = ?,
        educational_source_url = ?,
        curriculum_stage = ?,
        learning_objective = ?,
        prerequisites = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      candidate.problemId,
      fullReason,
      candidate.problem.rating || userRating,
      candidate.educationalSource || 'CODEFORCES_PROBLEMSET',
      candidate.educationalSourceUrl || null,
      candidate.curriculumStage || null,
      candidate.learningObjective || null,
      JSON.stringify(candidate.prerequisites || []),
      dailyProb.id
    );

    const updated = this.loadDailyProblem(dailyProb.id);
    if (!updated) {
      throw new Error(`Failed to load replaced daily problem '${dailyProb.id}'`);
    }
    return updated;
  }

  getHistory(profileId: string, limit = 30): DailySet[] {
    const dateRows = db.prepare(`
      SELECT date FROM daily_sets
      WHERE profile_id = ?
      ORDER BY date DESC
      LIMIT ?
    `).all(profileId, limit) as Array<{ date: string }>;

    return dateRows.map((r) => this.loadDailySet(profileId, r.date));
  }

  calculateStreak(profileId: string): number {
    const completedDays = db.prepare(`
      SELECT DISTINCT daily_set_date
      FROM daily_problems
      WHERE profile_id = ? AND (completed = 1 OR (solved_status IS NOT NULL AND solved_status != 'NOT_SOLVED'))
      ORDER BY daily_set_date DESC
    `).all(profileId) as Array<{ daily_set_date: string }>;

    if (completedDays.length === 0) return 0;

    const today = this.getTodayDateString();
    let streak = 0;
    const mostRecent = completedDays[0].daily_set_date;
    const diffDays = Math.floor((new Date(today).getTime() - new Date(mostRecent).getTime()) / (1000 * 3600 * 24));
    if (diffDays > 1) {
      return 0;
    }

    const completedSet = new Set(completedDays.map((d) => d.daily_set_date));
    let checkDate = new Date(mostRecent);

    while (true) {
      const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hebron' }).format(checkDate);
      if (completedSet.has(dateStr)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }

    return streak;
  }
}

export const recommendationService = new RecommendationService();
