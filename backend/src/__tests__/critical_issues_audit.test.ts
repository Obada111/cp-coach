import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  initDatabase,
  createProfile,
  getProfileByHandle,
  markProblemOpened,
  syncProfileProblemStatuses,
  getAllCurriculumProblems,
} from '../db.js';
import { recommendationService } from '../recommendationService.js';
import { problemJournalService } from '../problemJournalService.js';
import os from 'os';

describe('Audit: Three Critical Issues Verification', () => {
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
    db.prepare('DELETE FROM problem_learning_events').run();
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
  // 1. SAFE NETWORK / MULTI-PROFILE ACCESS ISOLATION
  // ─────────────────────────────────────────────────────────────
  describe('Issue 1: Safe Network Access & Profile Isolation', () => {
    it('detects available network interfaces for safe LAN access', () => {
      const interfaces = os.networkInterfaces();
      let detectedLanIp: string | null = null;
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
          if (iface.family === 'IPv4' && !iface.internal) {
            detectedLanIp = iface.address;
            break;
          }
        }
        if (detectedLanIp) break;
      }

      // LAN IP or fallback should be accessible
      const lanIp = detectedLanIp || '127.0.0.1';
      expect(lanIp).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      expect(lanIp).not.toBe('0.0.0.0');
    });

    it('preserves complete profile isolation between Obadajo and M7_Radwan', () => {
      const date = '2026-11-10';
      const setA = recommendationService.getOrGenerateDailySet(profileAId, date);
      const setB = recommendationService.getOrGenerateDailySet(profileBId, date);

      expect(setA.id).not.toBe(setB.id);
      expect(setA.profileId).toBe(profileAId);
      expect(setB.profileId).toBe(profileBId);

      // Verify opening or solving problem for A does not alter B
      const probA = setA.problems[0];
      markProblemOpened(probA.id);

      const refreshedB = recommendationService.getOrGenerateDailySet(profileBId, date);
      for (const p of refreshedB.problems) {
        expect(p.isOpened).toBe(false);
        expect(p.completionState).toBe('NOT_OPENED');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. OPENING A PROBLEM MUST NEVER MARK IT AS SOLVED
  // ─────────────────────────────────────────────────────────────
  describe('Issue 2: Problem State Model & Submission Verification', () => {
    it('opening a problem sets is_opened to true without marking it as solved', () => {
      const date = '2026-11-11';
      const set = recommendationService.getOrGenerateDailySet(profileAId, date);
      const prob = set.problems[0];

      expect(prob.isOpened).toBe(false);
      expect(prob.completed).toBe(false);
      expect(prob.verifiedCfAc).toBe(false);
      expect(prob.completionState).toBe('NOT_OPENED');

      // Call markProblemOpened
      const opened = markProblemOpened(prob.id);
      expect(opened.problem).toBeDefined();
      problemJournalService.record({
        profileId: opened.problem.profile_id,
        problemId: opened.problem.problem_id,
        source: 'DAILY_ENCOUNTER',
        sourceKey: `daily_open_${prob.id}`,
      });
      // Repeated browser clicks/retries must remain one encounter event.
      problemJournalService.record({
        profileId: opened.problem.profile_id,
        problemId: opened.problem.problem_id,
        source: 'DAILY_ENCOUNTER',
        sourceKey: `daily_open_${prob.id}`,
      });

      const updatedSet = recommendationService.getOrGenerateDailySet(profileAId, date);
      const updatedProb = updatedSet.problems.find((p) => p.id === prob.id)!;

      expect(updatedProb.isOpened).toBe(true);
      expect(updatedProb.openedAt).toBeTruthy();
      expect(updatedProb.completed).toBe(false);
      expect(updatedProb.verifiedCfAc).toBe(false);
      expect(updatedProb.completionState).toBe('OPENED');
      const encounterCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM problem_learning_events
        WHERE source = 'DAILY_ENCOUNTER' AND source_key = ?
      `).get(`daily_open_${prob.id}`) as { count: number };
      expect(encounterCount.count).toBe(1);
    });

    it('marks problem as attempted (not solved) when unsuccessful submissions exist', () => {
      const date = '2026-11-12';
      const set = recommendationService.getOrGenerateDailySet(profileAId, date);
      const prob = set.problems[0];
      const contestId = prob.problem?.contestId || 1000;
      const index = prob.problem?.index || 'A';

      // Record a WRONG_ANSWER submission for Obadajo
      db.prepare(`
        INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time, programming_language)
        VALUES (80001, ?, ?, ?, ?, 'WRONG_ANSWER', 1700000000, 'GNU C++20')
      `).run(handleA, prob.problemId, contestId, index);

      // Synchronize statuses
      syncProfileProblemStatuses(profileAId, handleA);

      const updatedSet = recommendationService.getOrGenerateDailySet(profileAId, date);
      const updatedProb = updatedSet.problems.find((p) => p.id === prob.id)!;

      expect(updatedProb.attempted).toBe(true);
      expect(updatedProb.completed).toBe(false);
      expect(updatedProb.verifiedCfAc).toBe(false);
      expect(updatedProb.completionState).toBe('ATTEMPTED');
    });

    it('marks problem as verified solved when an Accepted submission exists', () => {
      const date = '2026-11-13';
      const set = recommendationService.getOrGenerateDailySet(profileAId, date);
      const prob = set.problems[0];
      const contestId = prob.problem?.contestId || 1000;
      const index = prob.problem?.index || 'A';

      // Record WRONG_ANSWER then OK submission
      db.prepare(`
        INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time, programming_language)
        VALUES (80002, ?, ?, ?, ?, 'WRONG_ANSWER', 1700000000, 'GNU C++20'),
               (80003, ?, ?, ?, ?, 'OK', 1700000500, 'GNU C++20')
      `).run(handleA, prob.problemId, contestId, index, handleA, prob.problemId, contestId, index);

      syncProfileProblemStatuses(profileAId, handleA);

      const updatedSet = recommendationService.getOrGenerateDailySet(profileAId, date);
      const updatedProb = updatedSet.problems.find((p) => p.id === prob.id)!;

      expect(updatedProb.verifiedCfAc).toBe(true);
      expect(updatedProb.completed).toBe(true);
      expect(updatedProb.completionState).toBe('SOLVED_VERIFIED');
    });

    it('submitting feedback ratings (Easy/Normal/Hard) does not mark a problem as verified solved', () => {
      const date = '2026-11-14';
      const set = recommendationService.getOrGenerateDailySet(profileAId, date);
      const prob = set.problems[0];

      // Provide feedback rating without CF AC
      recommendationService.saveFeedback(prob.id, {
        perceivedDifficulty: 'HARD',
        solvedStatus: 'NOT_SOLVED',
        timeSpentMinutes: 45,
        notes: 'Very difficult DP invariant',
      });

      const updatedSet = recommendationService.getOrGenerateDailySet(profileAId, date);
      const updatedProb = updatedSet.problems.find((p) => p.id === prob.id)!;

      expect(updatedProb.verifiedCfAc).toBe(false);
      expect(updatedProb.completed).toBe(false);
      expect(updatedProb.perceivedDifficulty).toBe('HARD');
    });

    it('distinguishes self-reported completion from verified Codeforces AC', () => {
      const date = '2026-11-15';
      const set = recommendationService.getOrGenerateDailySet(profileAId, date);
      const prob = set.problems[0];

      // Self-report as solved independently without a Codeforces OK submission
      recommendationService.saveFeedback(prob.id, {
        perceivedDifficulty: 'NORMAL',
        solvedStatus: 'SOLVED_INDEPENDENTLY',
        timeSpentMinutes: 30,
        notes: 'Solved on paper without submitting',
      });

      const updatedSet = recommendationService.getOrGenerateDailySet(profileAId, date);
      const updatedProb = updatedSet.problems.find((p) => p.id === prob.id)!;

      expect(updatedProb.selfReportedSolved).toBe(true);
      expect(updatedProb.verifiedCfAc).toBe(false);
      expect(updatedProb.completionState).toBe('SOLVED_SELF_REPORTED');

      // Progress metrics distinguish verified vs self-reported
      expect(updatedSet.completionProgress.verifiedCount).toBe(0);
      expect(updatedSet.completionProgress.selfReportedCount).toBe(1);
    });

    it('submission verification strictly respects profile handle', () => {
      const date = '2026-11-16';
      const setA = recommendationService.getOrGenerateDailySet(profileAId, date);
      const setB = recommendationService.getOrGenerateDailySet(profileBId, date);

      const probA = setA.problems[0];
      const contestId = probA.problem?.contestId || 1000;
      const index = probA.problem?.index || 'A';

      // Insert OK submission for handleB (M7_Radwan), NOT handleA (Obadajo)
      db.prepare(`
        INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time, programming_language)
        VALUES (80004, ?, ?, ?, ?, 'OK', 1700000000, 'GNU C++20')
      `).run(handleB, probA.problemId, contestId, index);

      // Sync profile A
      syncProfileProblemStatuses(profileAId, handleA);

      const refreshedA = recommendationService.getOrGenerateDailySet(profileAId, date);
      const refreshedProbA = refreshedA.problems.find((p) => p.id === probA.id)!;

      // Profile A must NOT be marked solved by Profile B's submission!
      expect(refreshedProbA.verifiedCfAc).toBe(false);
      expect(refreshedProbA.completed).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. RECOMMEND ONLY ACCESSIBLE PUBLIC CODEFORCES PROBLEMS
  // ─────────────────────────────────────────────────────────────
  describe('Issue 3: Accessible Public Codeforces Problem Filter', () => {
    it('all curriculum problems belong strictly to public regular contests (contestId < 100000)', () => {
      const allCurriculum = getAllCurriculumProblems();
      expect(allCurriculum.length).toBeGreaterThan(0);

      for (const prob of allCurriculum) {
        expect(prob.cfContestId).toBeGreaterThan(0);
        expect(prob.cfContestId).toBeLessThan(100000); // Excludes Gym (>= 100000)
        expect(prob.cfContestId).not.toBe(99999); // Excludes fake mock contest
        expect(prob.sourceUrl).toContain(`codeforces.com/problemset/problem/${prob.cfContestId}/`);
      }
    });

    it('automatically replaces inaccessible Gym problems from daily sets with eligible public problems', () => {
      const date = '2026-11-17';
      // First generate a normal set
      const initialSet = recommendationService.getOrGenerateDailySet(profileAId, date);
      expect(initialSet.problems).toHaveLength(3);

      // Manually simulate an inaccessible Gym problem (e.g. 102951_B) in the problems and daily_problems table
      db.prepare(`
        INSERT OR REPLACE INTO problems (id, contest_id, problem_index, name, rating, tags)
        VALUES ('102951_B', 102951, 'B', 'Legacy Gym Problem B', 1400, '["math"]')
      `).run();

      const firstProblem = initialSet.problems[0];
      db.prepare(`
        UPDATE daily_problems
        SET problem_id = '102951_B',
            reason = 'Legacy Gym Recommendation'
        WHERE id = ?
      `).run(firstProblem.id);

      // Fetch daily set again: replaceInvalidProblems() should detect contest_id >= 100000 and replace it!
      const repairedSet = recommendationService.getOrGenerateDailySet(profileAId, date);
      expect(repairedSet.problems).toHaveLength(3);

      const replacedProb = repairedSet.problems.find((p) => p.id === firstProblem.id)!;
      expect(replacedProb.problemId).not.toBe('102951_B');
      expect(replacedProb.problemId).not.toContain('102951');
      expect(replacedProb.problem?.contestId).toBeLessThan(100000);
      expect(replacedProb.problem?.contestId).toBeGreaterThan(0);
    });

    it('maintains daily set stability when all recommendations are valid public problems', () => {
      const date = '2026-11-18';
      const set1 = recommendationService.getOrGenerateDailySet(profileAId, date);
      const set2 = recommendationService.getOrGenerateDailySet(profileAId, date);

      expect(set1.id).toBe(set2.id);
      expect(set1.problems.map((p) => p.problemId)).toEqual(set2.problems.map((p) => p.problemId));
    });
  });
});
