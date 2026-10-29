import { describe, it, expect, beforeEach } from 'vitest';
import { db, initDatabase, createProfile, getProfileByHandle } from '../db.js';
import { recommendationService } from '../recommendationService.js';
import { analysisService } from '../analysisService.js';

describe('Adaptive Recommendation Engine & Multi-Profile Logic', () => {
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
    db.prepare('DELETE FROM profile_cache').run();
    db.prepare('DELETE FROM problems').run();
    db.prepare('DELETE FROM codeforces_contests').run();
    db.prepare('DELETE FROM problem_learning_events').run();

    // Ensure profiles exist
    let pA = getProfileByHandle(handleA);
    if (!pA) pA = createProfile(handleA, 'Obadajo');
    profileAId = pA.id;

    let pB = getProfileByHandle(handleB);
    if (!pB) pB = createProfile(handleB, 'M7_Radwan');
    profileBId = pB.id;

    // Seed mock profile ratings
    db.prepare('UPDATE profiles SET rating = 1400 WHERE id = ?').run(profileAId);
    db.prepare('UPDATE profiles SET rating = 900 WHERE id = ?').run(profileBId);

    // Seed pool of problems in database
    const insertProb = db.prepare(`
      INSERT INTO problems (id, contest_id, problem_index, name, rating, tags, solved_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertProb.run('100_A', 100, 'A', 'Greedy Stepping Stone', 1250, JSON.stringify(['greedy']), 1200);
    insertProb.run('100_B', 100, 'B', 'Greedy Advanced', 1350, JSON.stringify(['greedy']), 900);
    insertProb.run('100_C', 100, 'C', 'Math Foundations', 1350, JSON.stringify(['math']), 1100);
    insertProb.run('100_D', 100, 'D', 'Dynamic Planning', 1450, JSON.stringify(['dp']), 800);
    insertProb.run('100_E', 100, 'E', 'Tree Traversal', 1500, JSON.stringify(['trees', 'graphs']), 700);
    insertProb.run('100_F', 100, 'F', 'Graph Challenge', 1600, JSON.stringify(['graphs']), 500);
    insertProb.run('100_G', 100, 'G', 'Previously Solved By A', 1350, JSON.stringify(['dp']), 950);
    insertProb.run('100_H', 100, 'H', 'Previously Solved By B', 900, JSON.stringify(['math']), 850);
    insertProb.run('100_I', 100, 'I', 'Beginner Friendly', 800, JSON.stringify(['greedy', 'implementation']), 1500);
    insertProb.run('100_J', 100, 'J', 'Intermediate Math', 1000, JSON.stringify(['math']), 900);
    insertProb.run('100_K', 100, 'K', 'Stretch Challenge', 1100, JSON.stringify(['data structures']), 600);
    insertProb.run('100_L', 100, 'L', 'Easy Followup Greedy', 1150, JSON.stringify(['greedy']), 1100);
  });

  // 1. Changing feedback from Easy to Hard affects future topic priorities
  it('changing feedback from Easy to Hard directly affects topic weakness score and recommendation priority', () => {
    // Generate initial day set
    const setDay1 = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-10');
    const prob1 = setDay1.problems[0];

    // Case 1: First mark as EASY & SOLVED_INDEPENDENTLY
    recommendationService.saveFeedback(prob1.id, {
      solvedStatus: 'SOLVED_INDEPENDENTLY',
      perceivedDifficulty: 'EASY',
      timeSpentMinutes: 10,
      notes: 'Too easy, solved in 10 minutes',
    });

    const topicsAfterEasy = analysisService.analyzeTopics(handleA, 1400, profileAId, '2026-10-10');
    const targetTag = prob1.problem?.tags[0] || 'greedy';
    const tagEasyScore = topicsAfterEasy.find((t) => t.tag === targetTag)?.weaknessScore ?? 0;

    // Case 2: Now update the same problem's feedback to HARD & NOT_SOLVED
    recommendationService.saveFeedback(prob1.id, {
      solvedStatus: 'NOT_SOLVED',
      perceivedDifficulty: 'HARD',
      timeSpentMinutes: 60,
      notes: 'Completely stuck on greedy choice',
    });

    const topicsAfterHard = analysisService.analyzeTopics(handleA, 1400, profileAId, '2026-10-10');
    const tagHardScore = topicsAfterHard.find((t) => t.tag === targetTag)?.weaknessScore ?? 0;

    // Score must be significantly higher when marked Hard & Unsolved vs Easy
    expect(tagHardScore).toBeGreaterThan(tagEasyScore);
  });

  // 2. Feedback for one profile never changes the other profile's recommendations
  it('feedback for one profile never changes the other profile recommendations', () => {
    const setA = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-11');
    const probA = setA.problems[0];

    // User A struggles on problem A
    recommendationService.saveFeedback(probA.id, {
      solvedStatus: 'VIEWED_EDITORIAL',
      perceivedDifficulty: 'HARD',
      timeSpentMinutes: 50,
      notes: 'Needed editorial for greedy proof',
    });

    // Check analysis for User A vs User B
    const topicsA = analysisService.analyzeTopics(handleA, 1400, profileAId, '2026-10-11');
    const topicsB = analysisService.analyzeTopics(handleB, 900, profileBId, '2026-10-11');

    const affectedTag = probA.problem?.tags[0] || 'greedy';
    const tagA = topicsA.find((t) => t.tag === affectedTag);
    const tagB = topicsB.find((t) => t.tag === affectedTag);

    expect(tagA?.hardCount).toBeGreaterThanOrEqual(1);
    expect(tagA?.editorialOrHintsCount).toBeGreaterThanOrEqual(1);

    // User B must remain completely unaffected (0 hard, 0 editorial)
    expect(tagB?.hardCount).toBe(0);
    expect(tagB?.editorialOrHintsCount).toBe(0);
  });

  // 3. A new day's set uses the latest saved feedback from previous days
  it('a new days set uses the latest saved feedback from previous days to adapt follow-ups', () => {
    // Day 1: Profile A gets a weakness drill problem
    const day1Set = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-12');
    const probDay1 = day1Set.problems.find((p) => p.category === 'WEAKNESS_DRILL')!;

    // User A marks Day 1 weakness problem as HARD and NOT_SOLVED
    recommendationService.saveFeedback(probDay1.id, {
      solvedStatus: 'NOT_SOLVED',
      perceivedDifficulty: 'HARD',
      timeSpentMinutes: 45,
      notes: 'Could not formulate greedy exchange argument',
    });

    // Day 2: generate next day's set
    const day2Set = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-13');
    const probDay2 = day2Set.problems.find((p) => p.category === 'WEAKNESS_DRILL')!;

    // Day 2 recommendation reason must explicitly cite the follow-up from 2026-10-12
    expect(probDay2.reason).toContain('Weakness Follow-up');
    expect(probDay2.reason).toContain('2026-10-12');
  });

  // 4. Refreshing the page does not regenerate the same day's set (Idempotency)
  it('refreshing the page does not regenerate the same days set', () => {
    const set1 = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-14');
    const set2 = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-14');

    expect(set1.id).toBe(set2.id);
    expect(set1.problems.map((p) => p.problemId)).toEqual(set2.problems.map((p) => p.problemId));
    expect(set1.problems.map((p) => p.reason)).toEqual(set2.problems.map((p) => p.reason));
  });

  // 5. A new calendar day generates a fresh set
  it('a new calendar day generates a fresh set', () => {
    const setDay1 = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-15');
    const setDay2 = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-16');

    expect(setDay1.id).not.toBe(setDay2.id);
    expect(setDay1.date).toBe('2026-10-15');
    expect(setDay2.date).toBe('2026-10-16');

    // Both sets exist in the database
    const allSets = db.prepare('SELECT date FROM daily_sets WHERE profile_id = ? ORDER BY date ASC').all(profileAId) as Array<{ date: string }>;
    expect(allSets.map((s) => s.date)).toContain('2026-10-15');
    expect(allSets.map((s) => s.date)).toContain('2026-10-16');
  });

  // 6. Previously solved problems are excluded from ordinary recommendations
  it('previously solved problems are excluded from ordinary recommendations', () => {
    // Record 100_G as solved on Codeforces by handleA
    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
      VALUES (101, ?, '100_G', 100, 'G', 'OK', 1700000000)
    `).run(handleA);

    // Record 100_H as solved on Codeforces by handleB
    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
      VALUES (102, ?, '100_H', 100, 'H', 'OK', 1700000000)
    `).run(handleB);

    const setA = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-17');
    const setB = recommendationService.getOrGenerateDailySet(profileBId, '2026-10-17');

    const probIdsA = setA.problems.map((p) => p.problemId);
    const probIdsB = setB.problems.map((p) => p.problemId);

    expect(probIdsA).not.toContain('100_G');
    expect(probIdsB).not.toContain('100_H');
  });

  // 7. Historical feedback and daily sets remain available after restarting/reloading
  it('historical feedback and daily sets remain available after database reload', () => {
    const set = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-18');
    const prob = set.problems[0];

    // Save full feedback
    recommendationService.saveFeedback(prob.id, {
      solvedStatus: 'SOLVED_WITH_HINTS',
      perceivedDifficulty: 'NORMAL',
      difficultyExperience: 'CHALLENGING',
      solutionMethod: 'HINTS',
      struggleReason: 'ALGORITHM_CHOICE',
      problemOpinion: 'USEFUL_RELEVANT',
      timeSpentMinutes: 35,
      notes: 'Learned new two-pointer optimization from hint 1',
    });

    recommendationService.saveFeedback(prob.id, {
      solvedStatus: 'SOLVED_INDEPENDENTLY',
      perceivedDifficulty: 'EASY',
      difficultyExperience: 'SLIGHTLY_EASY',
      solutionMethod: 'INDEPENDENT',
      struggleReason: 'EDGE_CASES',
      problemOpinion: 'REPETITIVE_FAMILIAR',
      timeSpentMinutes: 20,
      notes: 'Second reflection after revisiting the invariant.',
    });

    const journalRows = db.prepare(`
      SELECT source, solved_status, perceived_difficulty, difficulty_experience,
             solution_method, struggle_reason, problem_opinion, notes, verified_ac
      FROM problem_learning_events
      WHERE profile_id = ? AND problem_id = ?
      ORDER BY rowid ASC
    `).all(profileAId, prob.problemId) as Array<{
      source: string;
      solved_status: string;
      perceived_difficulty: string;
      difficulty_experience: string;
      solution_method: string;
      struggle_reason: string;
      problem_opinion: string;
      notes: string;
      verified_ac: number;
    }>;
    expect(journalRows).toHaveLength(2);
    expect(journalRows.map((row) => row.source)).toEqual(['DAILY_FEEDBACK', 'DAILY_FEEDBACK']);
    expect(journalRows[0].solved_status).toBe('SOLVED_WITH_HINTS');
    expect(journalRows[0].difficulty_experience).toBe('CHALLENGING');
    expect(journalRows[0].solution_method).toBe('HINTS');
    expect(journalRows[0].struggle_reason).toBe('ALGORITHM_CHOICE');
    expect(journalRows[0].problem_opinion).toBe('USEFUL_RELEVANT');
    expect(journalRows[1].solved_status).toBe('SOLVED_INDEPENDENTLY');
    expect(journalRows[0].verified_ac).toBe(0);

    // Re-load daily set fresh from database
    const loaded = recommendationService.loadDailySet(profileAId, '2026-10-18');
    const loadedProb = loaded.problems.find((p) => p.id === prob.id);

    expect(loadedProb).toBeDefined();
    expect(loadedProb?.solvedStatus).toBe('SOLVED_INDEPENDENTLY');
    expect(loadedProb?.perceivedDifficulty).toBe('EASY');
    expect(loadedProb?.difficultyExperience).toBe('SLIGHTLY_EASY');
    expect(loadedProb?.solutionMethod).toBe('INDEPENDENT');
    expect(loadedProb?.struggleReason).toBe('EDGE_CASES');
    expect(loadedProb?.problemOpinion).toBe('REPETITIVE_FAMILIAR');
    expect(loadedProb?.timeSpentMinutes).toBe(20);
    expect(loadedProb?.notes).toBe('Second reflection after revisiting the invariant.');
    expect(loadedProb?.completed).toBe(true);
  });

  // 8. Safely handles unexplored topics without falsely marking unattempted as weak
  it('handles unexplored topics safely without falsely marking unattempted as weak', () => {
    const topics = analysisService.analyzeTopics(handleA, 1400, profileAId, '2026-10-19');
    const unexplored = topics.find((t) => t.tag === 'bitmasks');
    expect(unexplored).toBeDefined();
    if (unexplored) {
      expect(unexplored.status).toBe('UNEXPLORED');
      expect(unexplored.confidence).toBe('LOW');
      expect(unexplored.weaknessScore).toBe(20);
      expect(unexplored.explanation).toContain('No recorded attempts');
    }
  });

  it('prefers a verified newer official round when relevance is equal', () => {
    const oldProblemTime = Math.floor(new Date('2020-01-01T00:00:00Z').getTime() / 1000);
    const newProblemTime = Math.floor(new Date('2026-10-01T00:00:00Z').getTime() / 1000);

    db.prepare(`
      INSERT INTO codeforces_contests (contest_id, name, start_time_seconds, duration_seconds, phase)
      VALUES (?, ?, ?, ?, ?)
    `).run(2000, 'Old Official Round', oldProblemTime, 7200, 'FINISHED');
    db.prepare(`
      INSERT INTO codeforces_contests (contest_id, name, start_time_seconds, duration_seconds, phase)
      VALUES (?, ?, ?, ?, ?)
    `).run(3000, 'Recent Official Round', newProblemTime, 7200, 'FINISHED');

    const insertProblem = db.prepare(`
      INSERT INTO problems (id, contest_id, problem_index, name, type, rating, tags, solved_count)
      VALUES (?, ?, ?, ?, 'PROGRAMMING', ?, ?, ?)
    `);
    insertProblem.run('2000_A', 2000, 'A', 'Older Equivalent', 1200, JSON.stringify(['recency-test-tag']), 1000);
    insertProblem.run('3000_A', 3000, 'A', 'Newer Equivalent', 1200, JSON.stringify(['recency-test-tag']), 1000);

    const candidate = recommendationService.findCandidateProblem(
      ['recency-test-tag'],
      1200,
      1200,
      new Set(),
      new Set()
    );

    expect(candidate?.problemId).toBe('3000_A');
  });
});
