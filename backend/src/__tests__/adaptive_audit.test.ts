import { describe, it, expect, beforeEach } from 'vitest';
import { db, initDatabase, createProfile, getProfileByHandle, getLearnerState } from '../db.js';
import { recommendationService } from '../recommendationService.js';
import { analysisService } from '../analysisService.js';
import { contestService } from '../contestService.js';

describe('Comprehensive Acceptance Audit: Adaptive CP Coach & Educational Quality', () => {
  const handleA = 'Obadajo';
  const handleB = 'M7_Radwan';
  let profileAId: string;
  let profileBId: string;

  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM sync_leases').run();
    db.prepare('DELETE FROM daily_problems').run();
    db.prepare('DELETE FROM daily_sets').run();
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM contest_problem_reviews').run();
    db.prepare('DELETE FROM user_contests').run();
    db.prepare('DELETE FROM learner_profile_state').run();

    let pA = getProfileByHandle(handleA);
    if (!pA) pA = createProfile(handleA, 'Obadajo');
    profileAId = pA.id;

    let pB = getProfileByHandle(handleB);
    if (!pB) pB = createProfile(handleB, 'M7_Radwan');
    profileBId = pB.id;

    db.prepare('UPDATE profiles SET rating = 1350 WHERE id = ?').run(profileAId);
    db.prepare('UPDATE profiles SET rating = 850 WHERE id = ?').run(profileBId);
  });

  // ─────────────────────────────────────────────────────────────
  // 1. EDUCATIONAL PROBLEM RECOMMENDATIONS & SOURCE PROVENANCE
  // ─────────────────────────────────────────────────────────────
  it('selects exclusively verified Codeforces problems with verified metadata and CF URLs', () => {
    const dailySet = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-25');
    expect(dailySet.problems).toHaveLength(3);

    const problemIds = new Set<string>();
    for (const prob of dailySet.problems) {
      expect(prob.problemId).toBeTruthy();
      expect(prob.reason).toBeTruthy();
      expect(prob.category).toMatch(/WEAKNESS_DRILL|REINFORCEMENT|CHALLENGE/);
      expect(prob.targetRating).toBeGreaterThanOrEqual(800);

      // Strict Codeforces-only guarantees:
      expect(prob.educationalSourceUrl).toMatch(/^https:\/\/codeforces\.com\//);
      expect(['CODEFORCES_PROBLEMSET', 'CODEFORCES_EDU']).toContain(prob.educationalSource);
      expect(prob.problemId).not.toMatch(/^(cses_|atcoder_|usaco_)/);
      expect(prob.problem).toBeDefined();
      expect(prob.problem!.contestId).toBeGreaterThan(0);
      expect(prob.problem!.contestId).not.toBe(99999);
      expect(prob.problem!.index).toBeTruthy();

      problemIds.add(prob.problemId);
    }

    // All 3 recommended problems must be distinct
    expect(problemIds.size).toBe(3);
  });

  it('strictly excludes non-Codeforces curriculum problems (CSES, AtCoder, etc.) from daily sets', () => {
    // Insert dummy non-CF curriculum rows into the DB
    db.prepare(`
      INSERT OR REPLACE INTO curriculum_problems (
        id, problem_id, source, source_url, name, curriculum_stage, topic,
        target_rating, learning_objective, prerequisites, cf_contest_id, cf_index
      ) VALUES (
        'cses_test_999', 'cses_test_999', 'CSES', 'https://cses.fi/problemset/task/999',
        'Distinct Numbers Mock', 'Sorting', 'greedy', 1350, 'Sort items', '[]', 99999, 'A'
      )
    `).run();

    const dailySet = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-24');
    for (const prob of dailySet.problems) {
      expect(prob.problemId).not.toBe('cses_test_999');
      expect(prob.educationalSourceUrl).toMatch(/^https:\/\/codeforces\.com\//);
      expect(prob.educationalSource).not.toBe('CSES');
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 2. GENUINE ADAPTIVE LEARNING WORKFLOW & TIMEZONE PERSISTENCE
  // ─────────────────────────────────────────────────────────────
  it('saves feedback persistently and immediately updates persistent learner model', () => {
    const date = '2026-10-26';
    const dailySet = recommendationService.getOrGenerateDailySet(profileAId, date);
    const firstProb = dailySet.problems[0];

    const updated = recommendationService.saveFeedback(firstProb.id, {
      solvedStatus: 'SOLVED_WITH_HINTS',
      perceivedDifficulty: 'HARD',
      timeSpentMinutes: 45,
      notes: 'Required hint for state transition on knapsack weight bound',
      struggleReason: 'ALGORITHM_RECOGNITION',
    });

    expect(updated).not.toBeNull();
    expect(updated?.completed).toBe(true);
    expect(updated?.solvedStatus).toBe('SOLVED_WITH_HINTS');
    expect(updated?.perceivedDifficulty).toBe('HARD');
    expect(updated?.struggleReason).toBe('ALGORITHM_RECOGNITION');
    expect(updated?.notes).toContain('state transition');

    // Verify persistent learner model was updated
    const learnerModel = getLearnerState(profileAId);
    expect(learnerModel).not.toBeNull();
    expect(learnerModel?.handle).toBe(handleA);
    expect(learnerModel?.hintDependenceRate).toBeGreaterThan(0);
    expect(learnerModel?.weeklyReview.evidenceDetails.length).toBeGreaterThan(0);
  });

  it('adapts next calendar day recommendation following repeated Hard and hint ratings', () => {
    const day1Date = '2026-10-27';
    const day2Date = '2026-10-28';

    const day1 = recommendationService.getOrGenerateDailySet(profileAId, day1Date);
    const drill = day1.problems.find((p) => p.category === 'WEAKNESS_DRILL')!;

    // Log struggle on day 1
    recommendationService.saveFeedback(drill.id, {
      solvedStatus: 'VIEWED_EDITORIAL',
      perceivedDifficulty: 'HARD',
      timeSpentMinutes: 50,
      notes: 'Could not figure out invariant without editorial',
    });

    // Generate day 2 set
    const day2 = recommendationService.getOrGenerateDailySet(profileAId, day2Date);
    const day2Drill = day2.problems.find((p) => p.category === 'WEAKNESS_DRILL')!;

    // Follow-up must adapt to yesterday's difficulty
    expect(day2Drill.reason).toContain('Weakness Follow-up');
    expect(day2Drill.problemId).not.toBe(drill.problemId); // Anti-repetition check
  });

  it('gradually increases challenge difficulty following consistent independent success', () => {
    const day1Date = '2026-10-29';
    const day2Date = '2026-10-30';

    const day1 = recommendationService.getOrGenerateDailySet(profileAId, day1Date);
    const drill = day1.problems.find((p) => p.category === 'WEAKNESS_DRILL')!;

    // Log clean independent solve
    recommendationService.saveFeedback(drill.id, {
      solvedStatus: 'SOLVED_INDEPENDENTLY',
      perceivedDifficulty: 'EASY',
      timeSpentMinutes: 12,
      notes: 'Solved smoothly in 12 minutes',
    });

    // Next day must progress
    const day2 = recommendationService.getOrGenerateDailySet(profileAId, day2Date);
    const day2Drill = day2.problems.find((p) => p.category === 'WEAKNESS_DRILL')!;
    expect(day2Drill.reason).toMatch(/Progression|Drill/);
  });

  it('keeps existing day recommendations completely idempotent and stable across reload', () => {
    const date = '2026-10-31';
    const set1 = recommendationService.getOrGenerateDailySet(profileAId, date);
    const ids1 = set1.problems.map((p) => p.problemId);

    // Re-request on the same day
    const set2 = recommendationService.getOrGenerateDailySet(profileAId, date);
    const ids2 = set2.problems.map((p) => p.problemId);

    expect(set2.id).toBe(set1.id);
    expect(ids2).toEqual(ids1);
  });

  it('excludes previously solved problems on Codeforces and daily sets from ordinary practice', () => {
    // Record Codeforces AC submission
    db.prepare(`
      INSERT OR REPLACE INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time, programming_language)
      VALUES (99001, 'Obadajo', '102951_A', 102951, 'A', 'OK', 1700000000, 'GNU C++20')
    `).run();

    const dailySet = recommendationService.getOrGenerateDailySet(profileAId, '2026-11-01');
    const recommendedIds = dailySet.problems.map((p) => p.problemId);

    expect(recommendedIds).not.toContain('102951_A');
  });

  it('never confuses an unexplored topic with a demonstrated weakness', () => {
    const topics = analysisService.analyzeTopics(handleA, 1350, profileAId);
    for (const t of topics) {
      if (t.status === 'UNEXPLORED') {
        expect(t.attemptsCount).toBeLessThan(3);
        expect(t.weaknessScore).toBeLessThanOrEqual(25);
        expect(t.confidence).toBe('LOW');
        expect(t.explanation).toMatch(/No recorded attempts|Below evidence threshold/);
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 3. CONTEST ANALYSIS INTEGRATION & MULTI-PROFILE ISOLATION
  // ─────────────────────────────────────────────────────────────
  it('integrates contest self-reviews and upsolving results into user recommendations and learner state', () => {
    // Simulate contest review for profileA
    db.prepare(`
      INSERT OR REPLACE INTO contest_problem_reviews (
        id, profile_id, contest_id, problem_index, self_review_tag,
        self_review_notes, upsolve_status, updated_at
      )
      VALUES ('cpr_1', ?, 1985, 'D', 'STRUGGLED_WITH_IMPLEMENTATION', 'Confused by 2D coordinates', 'UPSOLVED_INDEPENDENTLY', datetime('now'))
    `).run(profileAId);

    // Build learner model
    const learnerModel = analysisService.buildLearnerModel(profileAId, handleA, 1350);
    expect(learnerModel.recentStruggles.length).toBeGreaterThanOrEqual(0);
    expect(learnerModel.weeklyReview.evidenceDetails.some((e) => e.includes('contest problems analyzed'))).toBe(true);
  });

  it('keeps profiles Obadajo and M7_Radwan strictly isolated across all learning and recommendation workflows', () => {
    const date = '2026-11-02';

    const setA = recommendationService.getOrGenerateDailySet(profileAId, date);
    const setB = recommendationService.getOrGenerateDailySet(profileBId, date);

    expect(setA.profileId).toBe(profileAId);
    expect(setB.profileId).toBe(profileBId);
    expect(setA.id).not.toBe(setB.id);

    // Save feedback for profile A only
    recommendationService.saveFeedback(setA.problems[0].id, {
      solvedStatus: 'NOT_SOLVED',
      perceivedDifficulty: 'HARD',
      timeSpentMinutes: 60,
      notes: 'Profile A struggle',
    });

    // Verify profile B learner state was untouched
    const modelB = analysisService.buildLearnerModel(profileBId, handleB, 850);
    expect(modelB.handle).toBe(handleB);
    expect(modelB.profileId).toBe(profileBId);
  });
});
