import { describe, it, expect, beforeEach } from 'vitest';
import { db, initDatabase, createProfile, getProfileByHandle } from '../db.js';
import { contestService } from '../contestService.js';
import { analysisService } from '../analysisService.js';
import { recommendationService } from '../recommendationService.js';

describe('Intelligent Contest Performance Analyzer', () => {
  const handleA = 'Obadajo';
  const handleB = 'M7_Radwan';
  let profileAId: string;
  let profileBId: string;

  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM sync_leases').run();
    db.prepare('DELETE FROM contest_problem_reviews').run();
    db.prepare('DELETE FROM contest_problems_meta').run();
    db.prepare('DELETE FROM user_contests').run();
    db.prepare('DELETE FROM rating_history').run();
    db.prepare('DELETE FROM daily_problems').run();
    db.prepare('DELETE FROM daily_sets').run();
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM problems').run();

    let pA = getProfileByHandle(handleA);
    if (!pA) pA = createProfile(handleA, 'Obadajo');
    profileAId = pA.id;

    let pB = getProfileByHandle(handleB);
    if (!pB) pB = createProfile(handleB, 'M7_Radwan');
    profileBId = pB.id;

    db.prepare('UPDATE profiles SET rating = 1350 WHERE id = ?').run(profileAId);
    db.prepare('UPDATE profiles SET rating = 850 WHERE id = ?').run(profileBId);

    // Seed problems
    const insertProb = db.prepare(`
      INSERT INTO problems (id, contest_id, problem_index, name, rating, tags, solved_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertProb.run('2000_A', 2000, 'A', 'Problem A', 1000, JSON.stringify(['implementation']), 1000);
    insertProb.run('2000_B', 2000, 'B', 'Problem B', 1200, JSON.stringify(['math']), 800);
    insertProb.run('2000_C', 2000, 'C', 'Problem C', 1400, JSON.stringify(['greedy']), 600);
    insertProb.run('2000_D', 2000, 'D', 'Problem D', 1600, JSON.stringify(['dp']), 400);

    // Seed candidate pool for recommendations
    insertProb.run('100_A', 100, 'A', 'Greedy Practice', 1300, JSON.stringify(['greedy']), 1200);
    insertProb.run('100_B', 100, 'B', 'Math Practice', 1350, JSON.stringify(['math']), 900);
    insertProb.run('100_C', 100, 'C', 'DP Challenge', 1500, JSON.stringify(['dp']), 500);

    // Seed default contest 2000 for profile A
    db.prepare(`
      INSERT INTO user_contests (id, profile_id, contest_id, name, start_time_seconds, duration_seconds, participation_type, rank, old_rating, new_rating, rating_change)
      VALUES ('c_prof_obadajo_2000', ?, 2000, 'Codeforces Round 999', 1749992800, 7200, 'RATED', 1420, 1300, 1350, 50)
    `).run(profileAId);
  });

  // 1. Detecting a new contest from reliable submission or rating evidence
  it('detects a new contest from rating history evidence and creates contest record', async () => {
    db.prepare(`
      INSERT INTO rating_history (handle, contest_id, contest_name, rank, rating_update_time, old_rating, new_rating)
      VALUES (?, 2000, 'Codeforces Round 999 (Div. 2)', 1420, 1750000000, 1300, 1350)
    `).run(handleA);

    const contests = await contestService.detectAndSyncContests(profileAId);
    expect(contests.length).toBeGreaterThanOrEqual(1);

    const found = contests.find((c) => c.contestId === 2000);
    expect(found).toBeDefined();
    expect(found?.rank).toBe(1420);
    expect(found?.ratingChange).toBe(50);
    expect(found?.participationType).toBe('RATED');
  });

  // 2. Importing a contest manually
  it('imports a contest manually by Codeforces URL or numeric ID', async () => {
    // Manually import contest 2000 via URL
    const report = await contestService.importContest(profileAId, 'https://codeforces.com/contest/2000');
    expect(report.contestId).toBe(2000);

    const list = contestService.getContestList(profileAId);
    expect(list.some((c) => c.contestId === 2000)).toBe(true);
  });

  // 3. Avoiding duplicate contests and submissions on repeated synchronization (Idempotency)
  it('avoids duplicate contests on repeated synchronization', async () => {
    db.prepare(`
      INSERT INTO rating_history (handle, contest_id, contest_name, rank, rating_update_time, old_rating, new_rating)
      VALUES (?, 2000, 'Codeforces Round 999', 1420, 1750000000, 1300, 1350)
    `).run(handleA);

    await contestService.detectAndSyncContests(profileAId);
    await contestService.detectAndSyncContests(profileAId);

    const countRow = db.prepare('SELECT COUNT(*) as count FROM user_contests WHERE profile_id = ? AND contest_id = 2000').get(profileAId) as { count: number };
    expect(countRow.count).toBe(1);
  });

  // 4. Correctly grouping submissions by contest and problem
  it('correctly groups submissions by contest and problem', async () => {
    const startTime = 1750000000 - 7200;

    // Submissions for Problem A
    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
      VALUES (1, ?, '2000_A', 2000, 'A', 'WRONG_ANSWER', ?)
    `).run(handleA, startTime + 600);

    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
      VALUES (2, ?, '2000_A', 2000, 'A', 'OK', ?)
    `).run(handleA, startTime + 900);

    // Submission for Problem B
    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
      VALUES (3, ?, '2000_B', 2000, 'B', 'OK', ?)
    `).run(handleA, startTime + 1800);

    const report = await contestService.getContestPostMortem(profileAId, 2000);
    const probA = report.problems.find((p) => p.index === 'A');
    const probB = report.problems.find((p) => p.index === 'B');

    expect(probA).toBeDefined();
    expect(probA?.submissionsCount).toBe(2);
    expect(probB).toBeDefined();
    expect(probB?.submissionsCount).toBe(1);
  });

  // 5. Correctly calculating attempt counts, verdict breakdowns, elapsed times, and accepted results
  it('correctly calculates attempt counts, verdict breakdown, and accepted results', async () => {
    const startTime = 1750000000 - 7200;

    // Problem C: 2 Wrong Answers then OK
    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
      VALUES (10, ?, '2000_C', 2000, 'C', 'WRONG_ANSWER', ?)
    `).run(handleA, startTime + 300);

    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
      VALUES (11, ?, '2000_C', 2000, 'C', 'WRONG_ANSWER', ?)
    `).run(handleA, startTime + 600);

    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
      VALUES (12, ?, '2000_C', 2000, 'C', 'OK', ?)
    `).run(handleA, startTime + 1200);

    const report = await contestService.getContestPostMortem(profileAId, 2000);
    const probC = report.problems.find((p) => p.index === 'C')!;

    expect(probC.status).toBe('SOLVED_IN_CONTEST');
    expect(probC.unsuccessfulAttempts).toBe(2);
    expect(probC.verdictSequence).toEqual(['WRONG_ANSWER', 'WRONG_ANSWER', 'OK']);
    expect(report.verdictBreakdown.wrongAnswer).toBeGreaterThanOrEqual(2);
    expect(report.verdictBreakdown.ok).toBeGreaterThanOrEqual(1);
  });

  // 6. Handling missing rating changes, unrated contests, and unavailable data gracefully
  it('handles unrated contests and missing ratings without crashing', async () => {
    db.prepare(`
      INSERT INTO user_contests (id, profile_id, contest_id, name, start_time_seconds, duration_seconds, participation_type, rank, old_rating, new_rating, rating_change)
      VALUES ('c_test_9999', ?, 9999, 'Unrated Mashup', 1750000000, 7200, 'PRACTICE', null, null, null, null)
    `).run(profileAId);

    const report = await contestService.getContestPostMortem(profileAId, 9999);
    expect(report.rank).toBeNull();
    expect(report.ratingChange).toBeNull();
    expect(report.isStandingsConfirmed).toBe(false);
  });

  // 7. Preventing unsupported claims when evidence is insufficient
  it('labels unattempted problems as no recorded submission instead of making assumptions', async () => {
    const report = await contestService.getContestPostMortem(profileAId, 2000);
    const probD = report.problems.find((p) => p.index === 'D')!;

    expect(probD.status).toBe('NO_RECORDED_SUBMISSION');
    expect(probD.observations).toContain('No recorded submission during contest.');
  });

  // 8. Incorporating contest analysis and post-contest feedback into future recommendations
  it('incorporates post-contest self-review into topic weakness analysis and future recommendations', async () => {
    // Record self-review on contest 2000 problem C (tags: greedy)
    await contestService.saveProblemReview(profileAId, 2000, 'C', {
      selfReviewTag: 'DID_NOT_RECOGNIZE_ALGORITHM',
      selfReviewNotes: 'Did not recognize greedy exchange argument under contest pressure',
      upsolveStatus: 'UNSOLVED',
    });

    // Check analysisService includes this contest difficulty
    const topics = analysisService.analyzeTopics(handleA, 1350, profileAId, '2026-10-22');
    const greedyTopic = topics.find((t) => t.tag === 'greedy');

    expect(greedyTopic).toBeDefined();
    expect(greedyTopic?.weaknessScore).toBeGreaterThanOrEqual(40);

    // Verify daily recommendation generates a set targeting greedy
    const dailySet = recommendationService.getOrGenerateDailySet(profileAId, '2026-10-22');
    const weaknessProb = dailySet.problems.find((p) => p.category === 'WEAKNESS_DRILL');

    expect(weaknessProb).toBeDefined();
    // Problem should target greedy or cite difficulty
    expect(weaknessProb?.problem?.tags).toContain('greedy');
  });

  // 9. Keeping contest records and learning models independent between profiles
  it('keeps contest records and learning models strictly isolated between profiles', async () => {
    // Contest 3000 exists only for profile A
    db.prepare(`
      INSERT INTO user_contests (id, profile_id, contest_id, name, start_time_seconds, duration_seconds, participation_type, rank, old_rating, new_rating, rating_change)
      VALUES ('c_a_3000', ?, 3000, 'Contest for A', 1750000000, 7200, 'RATED', 1000, 1300, 1350, 50)
    `).run(profileAId);

    const listA = contestService.getContestList(profileAId);
    const listB = contestService.getContestList(profileBId);

    expect(listA.some((c) => c.contestId === 3000)).toBe(true);
    expect(listB.some((c) => c.contestId === 3000)).toBe(false);
  });

  // 10. Preserving contest reports, self-reviews, and upsolving after database reload
  it('preserves contest reviews and upsolving status persistently', async () => {
    await contestService.saveProblemReview(profileAId, 2000, 'C', {
      selfReviewTag: 'SOLVED_DURING_UPSOLVING',
      selfReviewNotes: 'Upsolved cleanly after reviewing editorial trick',
      upsolveStatus: 'UPSOLVED_INDEPENDENTLY',
    });

    // Reload directly via service
    const reloaded = await contestService.getContestPostMortem(profileAId, 2000);
    const probC = reloaded.problems.find((p) => p.index === 'C')!;

    expect(probC.selfReviewTag).toBe('SOLVED_DURING_UPSOLVING');
    expect(probC.selfReviewNotes).toBe('Upsolved cleanly after reviewing editorial trick');
    expect(probC.upsolveStatus).toBe('UPSOLVED_INDEPENDENTLY');
  });
});
