import { db, saveLearnerState, getLearnerState } from './db.js';
import { TopicAnalysis, TopicStatus, TopicConfidence, LearnerModel, TopicProficiencyState } from './types.js';

interface FeedbackAggregate {
  hard: number;
  easy: number;
  normal: number;
  hintOrEditorial: number;
  notSolved: number;
  independentSolves: number;
  weightedScore: number;
  totalFeedbackCount: number;
  recentHardOrHints: boolean;
  recentEasyIndependent: boolean;
}

export class AnalysisService {
  analyzeTopics(handle: string, userRating = 1300, profileId?: string, referenceDate?: string): TopicAnalysis[] {
    const todayStr = referenceDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hebron' }).format(new Date());
    const todayMs = new Date(todayStr).getTime();

    // 1. Fetch user's submissions strictly for this handle
    const submissions = db.prepare(`
      SELECT s.problem_id, s.verdict, s.creation_time, p.rating, p.tags
      FROM submissions s
      JOIN problems p ON s.problem_id = p.id
      WHERE s.handle = ?
      ORDER BY s.creation_time ASC
    `).all(handle) as Array<{
      problem_id: string;
      verdict: string;
      creation_time: number;
      rating: number | null;
      tags: string;
    }>;

    // 2. Fetch user feedback on daily problems strictly isolated to this profile
    const feedbackRows = (profileId
      ? db.prepare(`
          SELECT dp.solved_status, dp.perceived_difficulty, dp.difficulty_experience,
                 dp.problem_opinion, dp.daily_set_date, dp.notes, p.tags
          FROM daily_problems dp
          JOIN problems p ON dp.problem_id = p.id
          WHERE dp.profile_id = ? AND (dp.completed = 1 OR dp.solved_status IS NOT NULL OR dp.perceived_difficulty IS NOT NULL)
          ORDER BY dp.daily_set_date DESC
        `).all(profileId)
      : db.prepare(`
          SELECT dp.solved_status, dp.perceived_difficulty, dp.difficulty_experience,
                 dp.problem_opinion, dp.daily_set_date, dp.notes, p.tags
          FROM daily_problems dp
          JOIN problems p ON dp.problem_id = p.id
          WHERE dp.completed = 1 OR dp.solved_status IS NOT NULL OR dp.perceived_difficulty IS NOT NULL
          ORDER BY dp.daily_set_date DESC
        `).all()
    ) as Array<{
      solved_status: string | null;
      perceived_difficulty: string | null;
      difficulty_experience: string | null;
      problem_opinion: string | null;
      daily_set_date: string;
      notes: string | null;
      tags: string;
    }>;

    // Build feedback maps per tag with recency weighting
    const feedbackByTag = new Map<string, FeedbackAggregate>();

    for (const fb of feedbackRows) {
      let tags: string[] = [];
      try {
        tags = JSON.parse(fb.tags);
      } catch {
        continue;
      }

      // Calculate recency: problems solved yesterday or in last 3 days carry higher weight
      const fbMs = new Date(fb.daily_set_date).getTime();
      const diffDays = Math.max(0, Math.floor((todayMs - fbMs) / (1000 * 3600 * 24)));
      const recencyWeight = diffDays <= 1 ? 2.0 : diffDays <= 3 ? 1.5 : diffDays <= 7 ? 1.2 : 1.0;

      for (const tag of tags) {
        if (!feedbackByTag.has(tag)) {
          feedbackByTag.set(tag, {
            hard: 0,
            easy: 0,
            normal: 0,
            hintOrEditorial: 0,
            notSolved: 0,
            independentSolves: 0,
            weightedScore: 0,
            totalFeedbackCount: 0,
            recentHardOrHints: false,
            recentEasyIndependent: false,
          });
        }
        const curr = feedbackByTag.get(tag)!;
        curr.totalFeedbackCount++;

        let scoreDelta = 0;

        if (fb.perceived_difficulty === 'HARD') {
          curr.hard++;
          scoreDelta += 18;
          if (diffDays <= 2) curr.recentHardOrHints = true;
        } else if (fb.perceived_difficulty === 'EASY') {
          curr.easy++;
          scoreDelta -= 15;
        } else if (fb.perceived_difficulty === 'NORMAL') {
          curr.normal++;
        }

        if (fb.solved_status === 'NOT_SOLVED') {
          curr.notSolved++;
          scoreDelta += 24;
          if (diffDays <= 2) curr.recentHardOrHints = true;
        } else if (fb.solved_status === 'VIEWED_EDITORIAL') {
          curr.hintOrEditorial++;
          scoreDelta += 20;
          if (diffDays <= 2) curr.recentHardOrHints = true;
        } else if (fb.solved_status === 'SOLVED_WITH_HINTS') {
          curr.hintOrEditorial++;
          scoreDelta += 14;
          if (diffDays <= 2) curr.recentHardOrHints = true;
        } else if (fb.solved_status === 'SOLVED_INDEPENDENTLY') {
          curr.independentSolves++;
          if (fb.perceived_difficulty === 'EASY') {
            scoreDelta -= 12;
            if (diffDays <= 2) curr.recentEasyIndependent = true;
          } else {
            scoreDelta -= 6;
          }
        }

        // Rich optional feedback refines, but does not replace, the coarse
        // difficulty/solve evidence above. Recency weighting keeps one event
        // from permanently redefining a topic.
        if (fb.difficulty_experience === 'MUCH_HARDER') scoreDelta += 22;
        else if (fb.difficulty_experience === 'CHALLENGING') scoreDelta += 10;
        else if (fb.difficulty_experience === 'SLIGHTLY_EASY') scoreDelta -= 8;
        else if (fb.difficulty_experience === 'MUCH_EASIER') scoreDelta -= 16;

        if (fb.problem_opinion === 'TOO_DIFFICULT') scoreDelta += 8;
        else if (fb.problem_opinion === 'POOR_FIT' || fb.problem_opinion === 'REPETITIVE_FAMILIAR') scoreDelta -= 6;

        curr.weightedScore += scoreDelta * recencyWeight;
      }
    }

    // 2b. Ingest contest reviews & upsolving for this profile
    const contestReviews = (profileId ? db.prepare(`
      SELECT r.contest_id, r.problem_index, r.self_review_tag, r.self_review_notes, r.upsolve_status,
             COALESCE(m.tags, p.tags, '[]') as tags
      FROM contest_problem_reviews r
      LEFT JOIN contest_problems_meta m ON r.contest_id = m.contest_id AND r.problem_index = m.problem_index
      LEFT JOIN problems p ON p.id = (r.contest_id || '_' || r.problem_index)
      WHERE r.profile_id = ?
    `).all(profileId) : []) as Array<{
      contest_id: number;
      problem_index: string;
      self_review_tag: string | null;
      self_review_notes: string | null;
      upsolve_status: string;
      tags: string;
    }>;

    for (const cr of contestReviews) {
      let tags: string[] = [];
      try {
        tags = JSON.parse(cr.tags);
      } catch {
        continue;
      }

      for (const tag of tags) {
        if (!feedbackByTag.has(tag)) {
          feedbackByTag.set(tag, {
            hard: 0,
            easy: 0,
            normal: 0,
            hintOrEditorial: 0,
            notSolved: 0,
            independentSolves: 0,
            weightedScore: 0,
            totalFeedbackCount: 0,
            recentHardOrHints: false,
            recentEasyIndependent: false,
          });
        }
        const curr = feedbackByTag.get(tag)!;
        curr.totalFeedbackCount++;

        let scoreDelta = 0;
        if (cr.self_review_tag === 'DID_NOT_RECOGNIZE_ALGORITHM') {
          scoreDelta += 22;
          curr.hard++;
          curr.recentHardOrHints = true;
        } else if (cr.self_review_tag === 'STRUGGLED_WITH_IMPLEMENTATION') {
          scoreDelta += 16;
          curr.hard++;
          curr.recentHardOrHints = true;
        } else if (cr.self_review_tag === 'BUG_DEBUGGING_DIFFICULTY') {
          scoreDelta += 14;
          curr.hard++;
        }

        if (cr.upsolve_status === 'UPSOLVED_INDEPENDENTLY') {
          scoreDelta -= 15;
          curr.independentSolves++;
          curr.recentEasyIndependent = true;
        } else if (cr.upsolve_status === 'UPSOLVED_WITH_EDITORIAL' || cr.upsolve_status === 'UPSOLVED_WITH_HINTS') {
          scoreDelta += 10;
          curr.hintOrEditorial++;
        }

        curr.weightedScore += scoreDelta * 1.5;
      }
    }

    // 2c. Ingest solve sessions for this profile
    if (profileId) {
      try {
        const sessionRows = db.prepare(`
          SELECT s.outcome, s.perceived_difficulty, s.hints_revealed, s.editorial_viewed, s.struggle_type, s.created_at, p.tags
          FROM solve_sessions s
          JOIN problems p ON s.problem_id = p.id
          WHERE s.profile_id = ?
        `).all(profileId) as Array<{
          outcome: string;
          perceived_difficulty: string | null;
          hints_revealed: number;
          editorial_viewed: number;
          struggle_type: string | null;
          created_at: string;
          tags: string;
        }>;

        for (const ses of sessionRows) {
          let tags: string[] = [];
          try {
            tags = JSON.parse(ses.tags);
          } catch {
            continue;
          }

          const sesMs = new Date(ses.created_at).getTime();
          const diffDays = Math.max(0, Math.floor((todayMs - sesMs) / (1000 * 3600 * 24)));
          const recencyWeight = diffDays <= 2 ? 2.0 : diffDays <= 7 ? 1.5 : 1.0;

          for (const tag of tags) {
            if (!feedbackByTag.has(tag)) {
              feedbackByTag.set(tag, {
                hard: 0,
                easy: 0,
                normal: 0,
                hintOrEditorial: 0,
                notSolved: 0,
                independentSolves: 0,
                weightedScore: 0,
                totalFeedbackCount: 0,
                recentHardOrHints: false,
                recentEasyIndependent: false,
              });
            }
            const curr = feedbackByTag.get(tag)!;
            curr.totalFeedbackCount++;

            let scoreDelta = 0;
            if (ses.outcome === 'SOLVED_INDEPENDENTLY') {
              scoreDelta -= 12;
              curr.independentSolves++;
              if (diffDays <= 3) curr.recentEasyIndependent = true;
            } else if (ses.outcome === 'SOLVED_WITH_HINTS' || ses.hints_revealed > 0) {
              scoreDelta += 14;
              curr.hintOrEditorial++;
              if (diffDays <= 3) curr.recentHardOrHints = true;
            } else if (ses.outcome === 'SOLVED_WITH_EDITORIAL' || ses.editorial_viewed) {
              scoreDelta += 20;
              curr.hintOrEditorial++;
              if (diffDays <= 3) curr.recentHardOrHints = true;
            } else if (ses.outcome === 'UNSOLVED' || ses.outcome === 'ABANDONED') {
              scoreDelta += 22;
              curr.notSolved++;
              if (diffDays <= 3) curr.recentHardOrHints = true;
            }

            if (ses.perceived_difficulty === 'HARD') {
              scoreDelta += 10;
              curr.hard++;
            } else if (ses.perceived_difficulty === 'EASY') {
              scoreDelta -= 10;
              curr.easy++;
            }

            curr.weightedScore += scoreDelta * recencyWeight;
          }
        }
      } catch (err) {
        // solve_sessions might be empty or unmigrated in edge cases
      }
    }

    // 3. Aggregate submissions per problem and tag
    const problemStats = new Map<string, {
      solved: boolean;
      attempts: number;
      rating: number | null;
      tags: string[];
      lastCreationTime: number;
    }>();

    for (const sub of submissions) {
      if (!problemStats.has(sub.problem_id)) {
        let tags: string[] = [];
        try {
          tags = JSON.parse(sub.tags);
        } catch {
          tags = [];
        }
        problemStats.set(sub.problem_id, {
          solved: false,
          attempts: 0,
          rating: sub.rating,
          tags,
          lastCreationTime: sub.creation_time,
        });
      }
      const p = problemStats.get(sub.problem_id)!;
      p.attempts++;
      p.lastCreationTime = Math.max(p.lastCreationTime, sub.creation_time);
      if (sub.verdict === 'OK') {
        p.solved = true;
      }
    }

    // 4. Map problemStats to tags with recency windowing (last 60 days)
    const sixtyDaysAgoSeconds = Math.floor(todayMs / 1000) - (60 * 86400);

    const tagStats = new Map<string, {
      distinctAttempted: number;
      distinctSolved: number;
      totalAttempts: number;
      solvedRatings: number[];
      recentAttempted: number;
      recentSolved: number;
    }>();

    const commonCFTags = [
      'implementation', 'math', 'greedy', 'dp', 'data structures',
      'brute force', 'constructive algorithms', 'graphs', 'sortings',
      'binary search', 'dfs and similar', 'trees', 'strings', 'number theory',
      'combinatorics', 'two pointers', 'bitmasks', 'geometry', 'shortest paths'
    ];

    for (const t of commonCFTags) {
      tagStats.set(t, {
        distinctAttempted: 0,
        distinctSolved: 0,
        totalAttempts: 0,
        solvedRatings: [],
        recentAttempted: 0,
        recentSolved: 0,
      });
    }

    for (const p of problemStats.values()) {
      const isRecent = p.lastCreationTime >= sixtyDaysAgoSeconds;
      for (const tag of p.tags) {
        if (!tagStats.has(tag)) {
          tagStats.set(tag, {
            distinctAttempted: 0,
            distinctSolved: 0,
            totalAttempts: 0,
            solvedRatings: [],
            recentAttempted: 0,
            recentSolved: 0,
          });
        }
        const stat = tagStats.get(tag)!;
        stat.distinctAttempted++;
        stat.totalAttempts += p.attempts;
        if (isRecent) stat.recentAttempted++;

        if (p.solved) {
          stat.distinctSolved++;
          if (isRecent) stat.recentSolved++;
          if (p.rating) {
            stat.solvedRatings.push(p.rating);
          }
        }
      }
    }

    // 5. Compute weakness/strength scores and explanations
    const results: TopicAnalysis[] = [];

    for (const [tag, stats] of tagStats.entries()) {
      const fb = feedbackByTag.get(tag) || {
        hard: 0,
        easy: 0,
        normal: 0,
        hintOrEditorial: 0,
        notSolved: 0,
        independentSolves: 0,
        weightedScore: 0,
        totalFeedbackCount: 0,
        recentHardOrHints: false,
        recentEasyIndependent: false,
      };

      const avgSolvedRating = stats.solvedRatings.length > 0
        ? Math.round(stats.solvedRatings.reduce((a, b) => a + b, 0) / stats.solvedRatings.length)
        : 0;

      const distinctAttempted = stats.distinctAttempted;
      const distinctSolved = stats.distinctSolved;
      const solveRate = distinctAttempted > 0 ? (distinctSolved / distinctAttempted) * 100 : 0;
      const recentSolveRate = stats.recentAttempted > 0 ? (stats.recentSolved / stats.recentAttempted) * 100 : solveRate;

      // Evidence threshold: either >= 3 attempts on Codeforces, or at least 1 explicit training feedback
      const hasSufficientEvidence = distinctAttempted >= 3 || fb.totalFeedbackCount >= 1;

      let status: TopicStatus;
      let confidence: TopicConfidence;
      let weaknessScore = 0;
      let explanation = '';
      let recommendedNextStep = '';
      let recentTrend: 'IMPROVING' | 'STABLE' | 'DECLINING' = 'STABLE';

      if (stats.recentAttempted >= 3) {
        if (recentSolveRate >= solveRate + 12 || fb.recentEasyIndependent) {
          recentTrend = 'IMPROVING';
        } else if (recentSolveRate <= solveRate - 15 || fb.recentHardOrHints) {
          recentTrend = 'DECLINING';
        }
      }

      if (!hasSufficientEvidence) {
        status = 'UNEXPLORED';
        confidence = 'LOW';
        weaknessScore = 20;
        if (distinctAttempted === 0) {
          explanation = 'No recorded attempts on Codeforces yet. Needs exploratory practice to gauge skill.';
        } else {
          explanation = `Only ${distinctAttempted} problem(s) attempted (${distinctSolved} solved). Below evidence threshold (min 3) to classify accurately.`;
        }
        recommendedNextStep = `Solve 2-3 exploratory problems rated ~${Math.max(800, userRating - 200)} to establish baseline evidence.`;
      } else {
        if (distinctAttempted >= 10 || fb.totalFeedbackCount >= 5) {
          confidence = 'HIGH';
        } else if (distinctAttempted >= 5 || fb.totalFeedbackCount >= 2) {
          confidence = 'MEDIUM';
        } else {
          confidence = 'LOW';
        }

        // Base score from Codeforces solve rate
        let score = distinctAttempted > 0 ? (100 - solveRate) : 40;

        // Retry penalty
        const avgAttempts = stats.totalAttempts / (distinctAttempted || 1);
        if (avgAttempts > 2.0) {
          score += Math.min(20, (avgAttempts - 2.0) * 10);
        }

        // Below user rating penalty
        if (avgSolvedRating > 0 && userRating > 0 && avgSolvedRating < userRating - 150) {
          score += 15;
        }

        // Subjective training feedback impact (with recency weighting)
        score += fb.weightedScore;

        weaknessScore = Math.max(0, Math.min(100, Math.round(score)));

        // Classification threshold
        if (weaknessScore >= 45 || (solveRate < 60 && distinctAttempted >= 3)) {
          status = 'WEAK';
          const reasons: string[] = [];
          if (distinctAttempted > 0) {
            reasons.push(`${Math.round(solveRate)}% CF solve rate (${distinctSolved}/${distinctAttempted})`);
          }
          if (avgAttempts >= 2.0) {
            reasons.push(`${avgAttempts.toFixed(1)} attempts/prob`);
          }
          if (fb.hard > 0) {
            reasons.push(`${fb.hard} rated Hard in training`);
          }
          if (fb.hintOrEditorial > 0) {
            reasons.push(`${fb.hintOrEditorial} needed hints/editorial`);
          }
          if (fb.notSolved > 0) {
            reasons.push(`${fb.notSolved} unsolved in daily sets`);
          }
          explanation = `Weakness identified: ${reasons.join(', ')}. Target rating ~${Math.max(800, userRating - 100)} to solidify fundamentals.`;
          recommendedNextStep = `Drill foundational ~${Math.max(800, userRating - 100)} problems independently without opening editorial.`;
        } else {
          status = 'STRONG';
          const reasons: string[] = [];
          if (distinctAttempted > 0) {
            reasons.push(`${Math.round(solveRate)}% solve rate across ${distinctAttempted} problems`);
          }
          if (fb.easy > 0) {
            reasons.push(`${fb.easy} marked Easy in training`);
          }
          if (fb.independentSolves > 0) {
            reasons.push(`${fb.independentSolves} solved independently`);
          }
          explanation = `Demonstrated strength: ${reasons.join(', ') || 'consistent solve rate'}. Ready for reinforcement or higher-tier challenges.`;
          recommendedNextStep = `Take on stretch challenges rated ${userRating + 50} to ${userRating + 150} to push rating boundary.`;
        }
      }

      // Mastery score: Positive metric 0-100
      let masteryScore = Math.max(0, Math.min(100, 100 - weaknessScore));
      if (!hasSufficientEvidence) {
        masteryScore = 15;
      }

      // Determine mastery tier
      let masteryTier: 'MASTERED' | 'PROFICIENT' | 'DEVELOPING' | 'EMERGING' | 'UNEXPLORED';
      if (!hasSufficientEvidence) {
        masteryTier = 'UNEXPLORED';
      } else if (masteryScore >= 80 && confidence === 'HIGH') {
        masteryTier = 'MASTERED';
      } else if (masteryScore >= 65) {
        masteryTier = 'PROFICIENT';
      } else if (masteryScore >= 40) {
        masteryTier = 'DEVELOPING';
      } else {
        masteryTier = 'EMERGING';
      }

      results.push({
        tag,
        displayName: tag.charAt(0).toUpperCase() + tag.slice(1),
        status,
        confidence,
        masteryScore,
        masteryTier,
        attemptsCount: stats.distinctAttempted,
        solvedCount: stats.distinctSolved,
        solveRate: Math.round(solveRate),
        avgSolvedRating,
        weaknessScore,
        editorialOrHintsCount: fb.hintOrEditorial,
        hardCount: fb.hard,
        easyCount: fb.easy,
        recentAttemptsCount: stats.recentAttempted,
        recentSolvedCount: stats.recentSolved,
        recentTrend,
        recommendedNextStep,
        explanation,
      });
    }

    return results.sort((a, b) => b.weaknessScore - a.weaknessScore);
  }

  /**
   * Evaluates the 12 core Competitive Programming Skill Tracks
   */
  computeSkillTracks(handle: string, userRating = 1300, profileId?: string, referenceDate?: string): import('./types.js').SkillTrack[] {
    const topicAnalyses = this.analyzeTopics(handle, userRating, profileId, referenceDate);
    const tagMap = new Map<string, TopicAnalysis>();
    for (const t of topicAnalyses) {
      tagMap.set(t.tag, t);
    }

    const TRACK_DEFS = [
      {
        key: 'implementation_constructive',
        name: 'Implementation & Constructive',
        tags: ['implementation', 'constructive algorithms', 'brute force'],
        description: 'Simulation precision, corner-case defense, and invariant construction.'
      },
      {
        key: 'greedy',
        name: 'Greedy Algorithms',
        tags: ['greedy', 'sortings'],
        description: 'Exchange arguments, sorting invariants, and local-to-global optimal choice properties.'
      },
      {
        key: 'binary_search',
        name: 'Binary Search',
        tags: ['binary search'],
        description: 'Binary search on monotonic answer spaces, discrete predicate testing, and boundary handling.'
      },
      {
        key: 'two_pointers',
        name: 'Two Pointers & Sliding Window',
        tags: ['two pointers'],
        description: 'Monotonic ranges, variable-length windows, shrinkable boundaries, and multiset frequency windows.'
      },
      {
        key: 'prefix_sums',
        name: 'Prefix Sums & Difference Arrays',
        tags: ['data structures', 'math'],
        description: '1D/2D prefix sums, range update difference arrays, coordinate compression, and partial sums.'
      },
      {
        key: 'number_theory',
        name: 'Number Theory & GCD',
        tags: ['number theory', 'math'],
        description: 'GCD/LCM, Euclidean algorithm, sieve of Eratosthenes, prime factorization, and modular arithmetic.'
      },
      {
        key: 'bitmasks',
        name: 'Bit Manipulation & Bitmasks',
        tags: ['bitmasks'],
        description: 'Bitwise transitions, subset iteration, parity tricks, and lowbit operations.'
      },
      {
        key: 'dynamic_programming',
        name: 'Dynamic Programming',
        tags: ['dp'],
        description: 'Optimal substructure, memoization, state formulation, knapsack, and transition optimization.'
      },
      {
        key: 'graphs_trees',
        name: 'Graph Algorithms & Trees',
        tags: ['graphs', 'trees', 'dfs and similar', 'shortest paths'],
        description: 'DFS/BFS traversals, connected components, tree rerooting, DAGs, and shortest paths.'
      },
      {
        key: 'data_structures',
        name: 'Data Structures',
        tags: ['data structures', 'dsu'],
        description: 'Disjoint Set Union (DSU), Fenwick trees, Segment trees, heaps, and monotonic stacks/queues.'
      },
      {
        key: 'combinatorics_math',
        name: 'Combinatorics & Mathematics',
        tags: ['combinatorics', 'math', 'probabilities'],
        description: 'Binomial coefficients, permutations, pigeonhole principle, modular inverses, and inclusion-exclusion.'
      },
      {
        key: 'strings',
        name: 'Strings',
        tags: ['strings', 'string suffix structures'],
        description: 'Palindromes, anagrams, substring hashing, KMP, trie prefixes, and string periodicity.'
      }
    ];

    const tracks: import('./types.js').SkillTrack[] = [];

    for (const def of TRACK_DEFS) {
      let totalAttempts = 0;
      let totalSolved = 0;
      let recentAttempts = 0;
      let recentSolved = 0;
      let ratingSum = 0;
      let ratingCount = 0;
      let highConfidenceCount = 0;
      let mediumConfidenceCount = 0;
      let weaknessSum = 0;
      let constituentCount = 0;

      for (const t of def.tags) {
        const analysis = tagMap.get(t);
        if (analysis) {
          totalAttempts += analysis.attemptsCount;
          totalSolved += analysis.solvedCount;
          recentAttempts += analysis.recentAttemptsCount || 0;
          recentSolved += analysis.recentSolvedCount || 0;
          if (analysis.avgSolvedRating > 0) {
            ratingSum += analysis.avgSolvedRating * analysis.solvedCount;
            ratingCount += analysis.solvedCount;
          }
          if (analysis.confidence === 'HIGH') highConfidenceCount++;
          else if (analysis.confidence === 'MEDIUM') mediumConfidenceCount++;
          weaknessSum += analysis.weaknessScore;
          constituentCount++;
        }
      }

      const solveRate = totalAttempts > 0 ? Math.round((totalSolved / totalAttempts) * 100) : 0;
      const avgSolvedRating = ratingCount > 0 ? Math.round(ratingSum / ratingCount) : 0;
      const avgWeakness = constituentCount > 0 ? Math.round(weaknessSum / constituentCount) : 30;

      let confidence: TopicConfidence = 'LOW';
      if (totalAttempts >= 12 || highConfidenceCount >= 1) confidence = 'HIGH';
      else if (totalAttempts >= 5 || mediumConfidenceCount >= 1) confidence = 'MEDIUM';

      let masteryScore = Math.max(0, Math.min(100, 100 - avgWeakness));
      if (totalAttempts < 3) {
        masteryScore = 15;
      }

      let masteryTier: 'MASTERED' | 'PROFICIENT' | 'DEVELOPING' | 'EMERGING' | 'UNEXPLORED';
      if (totalAttempts < 3) {
        masteryTier = 'UNEXPLORED';
      } else if (masteryScore >= 80 && confidence === 'HIGH') {
        masteryTier = 'MASTERED';
      } else if (masteryScore >= 65) {
        masteryTier = 'PROFICIENT';
      } else if (masteryScore >= 40) {
        masteryTier = 'DEVELOPING';
      } else {
        masteryTier = 'EMERGING';
      }

      let recentTrend: 'IMPROVING' | 'STABLE' | 'DECLINING' = 'STABLE';
      if (recentAttempts >= 3) {
        const recentRate = (recentSolved / recentAttempts) * 100;
        if (recentRate >= solveRate + 10) recentTrend = 'IMPROVING';
        else if (recentRate <= solveRate - 15) recentTrend = 'DECLINING';
      }

      let recommendedNextStep = '';
      if (masteryTier === 'UNEXPLORED') {
        recommendedNextStep = `Solve 2-3 exploratory problems rated ~${Math.max(800, userRating - 200)} to establish track baseline.`;
      } else if (masteryTier === 'EMERGING') {
        recommendedNextStep = `Target foundational ~${Math.max(800, userRating - 100)} problems. Focus on proof of correctness before coding.`;
      } else if (masteryTier === 'DEVELOPING') {
        recommendedNextStep = `Practice rating ${userRating}-${userRating + 100} problems independently without opening hints.`;
      } else if (masteryTier === 'PROFICIENT') {
        recommendedNextStep = `Push into rating ${userRating + 100}-${userRating + 200} stretch challenges under contest timing.`;
      } else {
        recommendedNextStep = `Maintain mastery with occasional high-tier (${userRating + 200}+) contest upsolves.`;
      }

      tracks.push({
        key: def.key,
        name: def.name,
        description: def.description,
        tags: def.tags,
        masteryScore,
        masteryTier,
        confidence,
        attemptsCount: totalAttempts,
        solvedCount: totalSolved,
        solveRate,
        avgSolvedRating,
        recentAttemptsCount: recentAttempts,
        recentSolvedCount: recentSolved,
        recentTrend,
        recommendedNextStep,
      });
    }

    return tracks;
  }

  buildLearnerModel(profileId: string, handle: string, userRating = 1300): LearnerModel {
    const topics = this.analyzeTopics(handle, userRating, profileId);
    
    // Submissions stats
    const subRows = db.prepare(`
      SELECT verdict, COUNT(*) as count
      FROM submissions
      WHERE handle = ?
      GROUP BY verdict
    `).all(handle) as Array<{ verdict: string; count: number }>;
    
    let totalSubs = 0;
    let okSubs = 0;
    let waSubs = 0;
    let tleSubs = 0;
    for (const s of subRows) {
      totalSubs += s.count;
      if (s.verdict === 'OK') okSubs += s.count;
      else if (s.verdict === 'WRONG_ANSWER') waSubs += s.count;
      else if (s.verdict === 'TIME_LIMIT_EXCEEDED') tleSubs += s.count;
    }

    // Daily problems feedback stats
    const dailyFbRows = db.prepare(`
      SELECT dp.solved_status, dp.perceived_difficulty, dp.struggle_reason, dp.daily_set_date, p.tags
      FROM daily_problems dp
      JOIN problems p ON dp.problem_id = p.id
      WHERE dp.profile_id = ? AND (dp.completed = 1 OR dp.solved_status IS NOT NULL OR dp.perceived_difficulty IS NOT NULL)
      ORDER BY dp.daily_set_date DESC
    `).all(profileId) as Array<{
      solved_status: string | null;
      perceived_difficulty: string | null;
      struggle_reason: string | null;
      daily_set_date: string;
      tags: string;
    }>;

    let independentSolves = 0;
    let hintSolves = 0;
    let editorialSolves = 0;
    let notSolved = 0;
    const recentStrugglesSet = new Set<string>();
    const recentStrengthsSet = new Set<string>();

    for (const fb of dailyFbRows) {
      if (fb.solved_status === 'SOLVED_INDEPENDENTLY') independentSolves++;
      else if (fb.solved_status === 'SOLVED_WITH_HINTS') hintSolves++;
      else if (fb.solved_status === 'VIEWED_EDITORIAL') editorialSolves++;
      else if (fb.solved_status === 'NOT_SOLVED') notSolved++;

      let tags: string[] = [];
      try { tags = JSON.parse(fb.tags); } catch {}
      if (fb.perceived_difficulty === 'HARD' || fb.solved_status === 'VIEWED_EDITORIAL' || fb.solved_status === 'NOT_SOLVED') {
        tags.forEach((t) => recentStrugglesSet.add(t));
      } else if (fb.perceived_difficulty === 'EASY' && fb.solved_status === 'SOLVED_INDEPENDENTLY') {
        tags.forEach((t) => recentStrengthsSet.add(t));
      }
    }

    // Contest reviews stats
    const contestReviews = db.prepare(`
      SELECT self_review_tag, upsolve_status, tags
      FROM contest_problem_reviews r
      LEFT JOIN contest_problems_meta m ON r.contest_id = m.contest_id AND r.problem_index = m.problem_index
      WHERE r.profile_id = ?
    `).all(profileId) as Array<{ self_review_tag: string | null; upsolve_status: string; tags: string | null }>;

    for (const cr of contestReviews) {
      if (cr.upsolve_status === 'UPSOLVED_INDEPENDENTLY') independentSolves++;
      else if (cr.upsolve_status === 'UPSOLVED_WITH_HINTS') hintSolves++;
      else if (cr.upsolve_status === 'UPSOLVED_WITH_EDITORIAL') editorialSolves++;

      let tags: string[] = [];
      try { tags = JSON.parse(cr.tags || '[]'); } catch {}
      if (cr.self_review_tag) {
        tags.forEach((t) => recentStrugglesSet.add(t));
      }
    }

    const totalTrackedSolves = independentSolves + hintSolves + editorialSolves + notSolved;
    const independentSolveRate = totalTrackedSolves > 0 ? Math.round((independentSolves / totalTrackedSolves) * 100) : 0;
    const hintDependenceRate = totalTrackedSolves > 0 ? Math.round(((hintSolves + editorialSolves) / totalTrackedSolves) * 100) : 0;

    // Per-topic proficiency map
    const topicProficiencies: Record<string, TopicProficiencyState> = {};
    const weakTopics: string[] = [];
    const strongTopics: string[] = [];
    const unexploredTopics: string[] = [];

    for (const t of topics) {
      const proficiency = Math.max(0, 100 - t.weaknessScore);
      let trend: 'IMPROVING' | 'STABLE' | 'DECLINING' = 'STABLE';
      if (recentStrengthsSet.has(t.tag)) trend = 'IMPROVING';
      else if (recentStrugglesSet.has(t.tag)) trend = 'DECLINING';

      topicProficiencies[t.tag] = {
        tag: t.tag,
        proficiencyScore: proficiency,
        confidence: t.confidence,
        status: t.status,
        attemptsCount: t.attemptsCount,
        solvedCount: t.solvedCount,
        solveRate: t.solveRate,
        recentTrend: trend,
        reasons: [t.explanation],
      };

      if (t.status === 'WEAK') weakTopics.push(t.tag);
      else if (t.status === 'STRONG') strongTopics.push(t.tag);
      else if (t.status === 'UNEXPLORED') unexploredTopics.push(t.tag);
    }

    // Grounded Coach Insight
    let coachInsight = '';
    const topWeakness = weakTopics[0];
    const topStrength = strongTopics[0];

    if (recentStrugglesSet.size > 0 && topWeakness) {
      coachInsight = `Recent feedback indicates difficulty in '${topWeakness}'. Training prioritizes foundational mechanics at calibrated rating before stepping up difficulty.`;
    } else if (independentSolveRate >= 70 && topStrength) {
      coachInsight = `High independent solve rate (${independentSolveRate}%) with strong confidence in '${topStrength}'. Next sessions will introduce higher-tier contest applications.`;
    } else if (tleSubs >= 3) {
      coachInsight = `Multiple Time Limit Exceeded verdicts detected (${tleSubs} TLEs). Focusing on asymptotic complexity analysis and algorithm recognition.`;
    } else if (unexploredTopics.length > 5) {
      coachInsight = `Targeting foundational curriculum problems across unexplored topics to build reliable contest coverage.`;
    } else {
      coachInsight = `Balanced practice active. Continuing calibrated drills aligned with current rating ${userRating}.`;
    }

    // Evidence-based Weekly Review
    const whatImproved: string[] = [];
    if (independentSolves > 0) {
      whatImproved.push(`${independentSolves} problem(s) solved independently without hints.`);
    }
    if (strongTopics.length > 0) {
      whatImproved.push(`Demonstrated consistent mastery in: ${strongTopics.slice(0, 3).join(', ')}.`);
    }
    if (okSubs > 0) {
      whatImproved.push(`${okSubs} total accepted solutions logged on Codeforces.`);
    }
    if (whatImproved.length === 0) {
      whatImproved.push('Baseline training profile initialized; awaiting further practice sessions.');
    }

    const difficultiesRemaining: string[] = [];
    if (weakTopics.length > 0) {
      difficultiesRemaining.push(`Persistent lower solve rate observed in: ${weakTopics.slice(0, 3).join(', ')}.`);
    }
    if (hintSolves + editorialSolves > 0) {
      difficultiesRemaining.push(`${hintSolves + editorialSolves} recent problem(s) required hints or editorial guidance.`);
    }
    if (waSubs >= 3) {
      difficultiesRemaining.push(`Wrong Answer frequency (${waSubs} WAs) suggests edge-case testing or unverified submissions.`);
    }
    if (difficultiesRemaining.length === 0) {
      difficultiesRemaining.push('No critical blockers identified; keep expanding problem variety.');
    }

    const evidenceDetails: string[] = [
      `${totalSubs} Codeforces submissions tracked (${okSubs} OK, ${waSubs} WA, ${tleSubs} TLE).`,
      `${dailyFbRows.length} daily training problem feedbacks recorded (${independentSolves} solo, ${hintSolves} hints, ${editorialSolves} editorial).`,
      `${contestReviews.length} contest problems analyzed with post-contest reviews.`,
    ];

    const trainingPrioritiesChanged: string[] = [];
    if (weakTopics.length > 0) {
      trainingPrioritiesChanged.push(`Elevated priority for '${weakTopics[0]}' drill to reinforce fundamentals.`);
    }
    if (recentStrugglesSet.size > 0) {
      trainingPrioritiesChanged.push(`Added reinforcement focus for recent struggle topic(s): ${Array.from(recentStrugglesSet).slice(0, 2).join(', ')}.`);
    }
    if (trainingPrioritiesChanged.length === 0) {
      trainingPrioritiesChanged.push('Standard progressive difficulty track maintained.');
    }

    const planRationale = topWeakness
      ? `Practice plan targets '${topWeakness}' first with verified educational curriculum problems, followed by consolidation and stretch challenges.`
      : `Practice plan reinforces core algorithmic problem patterns suited for rating ~${userRating}.`;

    const model: LearnerModel = {
      profileId,
      handle,
      overallRating: userRating,
      independentSolveRate,
      hintDependenceRate,
      topicProficiencies,
      recentStruggles: Array.from(recentStrugglesSet),
      recentStrengths: Array.from(recentStrengthsSet),
      unexploredTopics,
      coachInsight,
      weeklyReview: {
        whatImproved,
        difficultiesRemaining,
        evidenceDetails,
        trainingPrioritiesChanged,
        planRationale,
        generatedAt: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hebron' }).format(new Date()),
      },
      updatedAt: new Date().toISOString(),
    };

    saveLearnerState(profileId, handle, model);
    return model;
  }

  getOrComputeLearnerModel(profileId: string, handle: string, userRating = 1300): LearnerModel {
    const existing = getLearnerState(profileId);
    if (existing) return existing;
    return this.buildLearnerModel(profileId, handle, userRating);
  }
}

export const analysisService = new AnalysisService();
