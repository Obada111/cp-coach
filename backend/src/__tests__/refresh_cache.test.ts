import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, initDatabase, createProfile, getProfileByHandle } from '../db.js';
import { CodeforcesCacheService, codeforcesCacheService } from '../codeforcesCacheService.js';
import { codeforcesService } from '../codeforcesService.js';
import { recommendationService } from '../recommendationService.js';

describe('Codeforces Data Refresh & Cache Layer Audit Tests', () => {
  const testHandle = 'Obadajo';
  let testProfileId: string;

  beforeEach(() => {
    initDatabase();
    db.prepare('DELETE FROM sync_leases').run();
    db.prepare('DELETE FROM daily_problems').run();
    db.prepare('DELETE FROM daily_sets').run();
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM sync_meta').run();
    db.prepare('DELETE FROM profile_cache').run();
    db.prepare('DELETE FROM problems').run();
    db.prepare('DELETE FROM problem_learning_events').run();

    // Keep refresh tests offline and deterministic; problemset refresh is
    // part of the unified sync path but is covered with a dedicated fixture.
    vi.spyOn(codeforcesService, 'getProblemset').mockResolvedValue({
      problems: [],
      problemStatistics: [],
    });

    let p = getProfileByHandle(testHandle);
    if (!p) p = createProfile(testHandle, 'Obadajo');
    testProfileId = p.id;
  });

  // 1. Refresh intervals and cache TTL evaluation
  it('correctly tracks TTL and marks data as fresh or stale based on configured intervals', () => {
    const handleLower = testHandle.toLowerCase();

    // Initially with no sync history, data must be stale
    let status = codeforcesCacheService.getFreshnessStatus(testHandle, testProfileId);
    expect(status.dataFreshness.isSubmissionsStale).toBe(true);
    expect(status.dataFreshness.isRatingStale).toBe(true);
    expect(status.dataFreshness.isContestsStale).toBe(true);

    // Simulate fresh refresh 1 minute ago (within 5m TTL)
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    codeforcesCacheService.setMetaValue(`last_submissions_refresh_${handleLower}`, oneMinAgo);
    codeforcesCacheService.setMetaValue(`last_profile_refresh_${handleLower}`, oneMinAgo);
    codeforcesCacheService.setMetaValue(`last_rating_refresh_${handleLower}`, oneMinAgo);
    codeforcesCacheService.setMetaValue(`last_contests_refresh_${testProfileId}`, oneMinAgo);

    status = codeforcesCacheService.getFreshnessStatus(testHandle, testProfileId);
    expect(status.dataFreshness.isSubmissionsStale).toBe(false);
    expect(status.dataFreshness.isRatingStale).toBe(false);
    expect(status.dataFreshness.isContestsStale).toBe(false);

    // Simulate submissions refreshed 10 minutes ago (beyond 5m TTL)
    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    codeforcesCacheService.setMetaValue(`last_submissions_refresh_${handleLower}`, tenMinsAgo);

    status = codeforcesCacheService.getFreshnessStatus(testHandle, testProfileId);
    expect(status.dataFreshness.isSubmissionsStale).toBe(true);
    // Rating (1h TTL) and Contests (2h TTL) should still be fresh
    expect(status.dataFreshness.isRatingStale).toBe(false);
    expect(status.dataFreshness.isContestsStale).toBe(false);
  });

  it('stops the background scheduler during graceful shutdown', async () => {
    vi.useFakeTimers();
    try {
      const service = new CodeforcesCacheService();
      service.startBackgroundScheduler(60_000);
      expect(vi.getTimerCount()).toBe(1);

      await service.shutdown();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes stale rating or contest metadata even when submissions are fresh', async () => {
    vi.useFakeTimers();
    let refresh: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const handleLower = testHandle.toLowerCase();
      const fresh = new Date(Date.now() - 60 * 1000).toISOString();
      const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE profiles SET last_active_at = ? WHERE id = ?').run(new Date().toISOString(), testProfileId);
      codeforcesCacheService.setMetaValue(`last_submissions_refresh_${handleLower}`, fresh);
      codeforcesCacheService.setMetaValue(`last_profile_refresh_${handleLower}`, fresh);
      codeforcesCacheService.setMetaValue(`last_rating_refresh_${handleLower}`, stale);
      codeforcesCacheService.setMetaValue(`last_contests_refresh_${testProfileId}`, fresh);

      refresh = vi.spyOn(codeforcesCacheService, 'autoRefreshIfNeeded')
        .mockResolvedValue(codeforcesCacheService.getFreshnessStatus(testHandle, testProfileId));
      codeforcesCacheService.startBackgroundScheduler(60_000);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(refresh).toHaveBeenCalledWith(testProfileId, false);
    } finally {
      refresh?.mockRestore();
      await codeforcesCacheService.shutdown();
      vi.useRealTimers();
    }
  });

  it('refreshes the problem catalog through the unified path using safe upserts', async () => {
    db.prepare(`
      INSERT INTO problems (id, contest_id, problem_index, name, type, rating, tags, solved_count)
      VALUES ('1700_A', 1700, 'A', 'Old name', 'PROGRAMMING', 1200, '[\"greedy\"]', 10)
    `).run();
    vi.spyOn(codeforcesService, 'getUserInfo').mockResolvedValue({ handle: testHandle, rating: 1350 });
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([]);
    vi.spyOn(codeforcesService, 'getUserRating').mockResolvedValue([]);
    vi.spyOn(codeforcesService, 'getProblemset').mockResolvedValue({
      problems: [
        { contestId: 1700, index: 'A', name: 'Updated name', type: 'PROGRAMMING', rating: 1250, tags: ['greedy', 'math'] },
        { contestId: 1700, index: 'B', name: 'New problem', type: 'PROGRAMMING', rating: 1300, tags: ['dp'] },
      ],
      problemStatistics: [
        { contestId: 1700, index: 'A', solvedCount: 321 },
        { contestId: 1700, index: 'B', solvedCount: 123 },
      ],
    });

    await codeforcesCacheService.autoRefreshIfNeeded(testProfileId, true);

    const updated = db.prepare('SELECT name, rating, tags, solved_count FROM problems WHERE id = ?').get('1700_A') as {
      name: string;
      rating: number;
      tags: string;
      solved_count: number;
    };
    expect(updated).toEqual({
      name: 'Updated name',
      rating: 1250,
      tags: '["greedy","math"]',
      solved_count: 321,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM problems WHERE contest_id = 1700').get()).toEqual({ count: 2 });

    vi.restoreAllMocks();
  });

  // 2. In-flight request deduplication
  it('deduplicates simultaneous refresh requests and reuses the in-flight Promise', async () => {
    // Spy on getUserInfo to count actual external calls
    let callCount = 0;
    vi.spyOn(codeforcesService, 'getUserInfo').mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return {
        handle: testHandle,
        rating: 1350,
        maxRating: 1426,
        rank: 'pupil',
        maxRank: 'specialist',
      };
    });
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([{
      id: 777001,
      contestId: 1700,
      creationTimeSeconds: 1700000000,
      problem: {
        contestId: 1700,
        index: 'A',
        name: 'Verified Journal Problem',
        rating: 1200,
        tags: ['greedy'],
      },
      programmingLanguage: 'GNU C++',
      verdict: 'OK',
    }]);
    vi.spyOn(codeforcesService, 'getUserRating').mockResolvedValue([]);

    // Trigger two simultaneous refresh requests for the same profile
    const [p1, p2] = await Promise.all([
      codeforcesCacheService.autoRefreshIfNeeded(testProfileId, true),
      codeforcesCacheService.autoRefreshIfNeeded(testProfileId, true),
    ]);

    expect(p1.handle).toBe(testHandle);
    expect(p2.handle).toBe(testHandle);
    // getUserInfo should only have been called ONCE due to in-flight deduplication
    expect(callCount).toBe(1);

    const refreshedStatus = codeforcesCacheService.getFreshnessStatus(testHandle, testProfileId);
    expect(refreshedStatus.dataFreshness.isSubmissionsStale).toBe(false);
    expect(refreshedStatus.dataFreshness.isRatingStale).toBe(false);

    const journalEvent = db.prepare(`
      SELECT source, problem_id, problem_name, rating, tags, verified_ac
      FROM problem_learning_events
      WHERE profile_id = ? AND source_key = ?
    `).get(testProfileId, 'cf_submission_777001') as {
      source: string;
      problem_id: string;
      problem_name: string;
      rating: number;
      tags: string;
      verified_ac: number;
    } | undefined;
    expect(journalEvent).toEqual({
      source: 'VERIFIED_CODEFORCES',
      problem_id: '1700_A',
      problem_name: 'Verified Journal Problem',
      rating: 1200,
      tags: '["greedy"]',
      verified_ac: 1,
    });

    vi.restoreAllMocks();
  });

  it('uses a SQLite lease to deduplicate refreshes across service instances', async () => {
    let callCount = 0;
    vi.spyOn(codeforcesService, 'getUserInfo').mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { handle: testHandle, rating: 1350, maxRating: 1426, rank: 'pupil', maxRank: 'specialist' };
    });
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([]);
    vi.spyOn(codeforcesService, 'getUserRating').mockResolvedValue([]);

    const secondCacheService = new CodeforcesCacheService();
    await Promise.all([
      codeforcesCacheService.autoRefreshIfNeeded(testProfileId, true),
      secondCacheService.autoRefreshIfNeeded(testProfileId, true),
    ]);

    expect(callCount).toBe(1);
    vi.restoreAllMocks();
  });

  // 3. Graceful API failure handling (Stale-while-revalidate)
  it('preserves cached database records and returns error notice gracefully when Codeforces API fails', async () => {
    // Seed existing cached submission in SQLite
    db.prepare(`
      INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time, programming_language)
      VALUES (999999, ?, '100_A', 100, 'A', 'OK', 1700000000, 'GNU C++')
    `).run(testHandle);

    db.prepare(`
      INSERT INTO profile_cache (handle, rating, max_rating, rank, max_rank, updated_at)
      VALUES (?, 1350, 1426, 'pupil', 'specialist', datetime('now'))
    `).run(testHandle);

    // Mock CF API failure (e.g. HTTP 429 or network disconnect)
    vi.spyOn(codeforcesService, 'getUserInfo').mockRejectedValue(new Error('Codeforces API returned HTTP 429: Rate limit exceeded'));

    // Trigger refresh: should not throw, should retain cached data
    const status = await codeforcesCacheService.autoRefreshIfNeeded(testProfileId, true);

    expect(status.handle).toBe(testHandle);
    // Cached submission must remain intact in SQLite
    const subRow = db.prepare('SELECT id, verdict FROM submissions WHERE id = 999999').get() as { id: number; verdict: string };
    expect(subRow).toBeDefined();
    expect(subRow.verdict).toBe('OK');

    // Cached profile must remain intact
    const cached = codeforcesService.getCachedProfile(testHandle);
    expect(cached).toBeDefined();
    expect(cached?.rating).toBe(1350);

    // Status records the error message clearly
    expect(status.error).toContain('429');

    vi.restoreAllMocks();
  });

  // 4. Daily recommendations and user feedback preservation across refresh
  it('does not regenerate daily recommendation sets or wipe user feedback during data refresh', async () => {
    // Seed candidate problem
    db.prepare(`
      INSERT INTO problems (id, contest_id, problem_index, name, rating, tags, solved_count)
      VALUES ('1500_A', 1500, 'A', 'Preserved Problem', 1300, '["greedy"]', 500)
    `).run();

    // Generate daily set for test day
    const day = '2026-10-28';
    const initialSet = recommendationService.getOrGenerateDailySet(testProfileId, day);
    const probId = initialSet.problems[0].id;

    // User submits feedback and notes
    recommendationService.saveFeedback(probId, {
      solvedStatus: 'SOLVED_INDEPENDENTLY',
      perceivedDifficulty: 'HARD',
      timeSpentMinutes: 35,
      notes: 'Learned greedy prefix sum technique.',
    });

    // Mock CF sync responses
    vi.spyOn(codeforcesService, 'getUserInfo').mockResolvedValue({
      handle: testHandle,
      rating: 1350,
      maxRating: 1426,
      rank: 'pupil',
      maxRank: 'specialist',
    });
    vi.spyOn(codeforcesService, 'getUserStatus').mockResolvedValue([]);
    vi.spyOn(codeforcesService, 'getUserRating').mockResolvedValue([]);

    // Perform forced data refresh
    await codeforcesCacheService.autoRefreshIfNeeded(testProfileId, true);

    // Reload daily set: must match original set ID and problem IDs
    const reloadedSet = recommendationService.getOrGenerateDailySet(testProfileId, day);
    expect(reloadedSet.id).toBe(initialSet.id);
    expect(reloadedSet.problems[0].id).toBe(probId);

    // User feedback, notes, and difficulty rating must be strictly preserved
    const reloadedProblem = reloadedSet.problems[0];
    expect(reloadedProblem.solvedStatus).toBe('SOLVED_INDEPENDENTLY');
    expect(reloadedProblem.perceivedDifficulty).toBe('HARD');
    expect(reloadedProblem.timeSpentMinutes).toBe(35);
    expect(reloadedProblem.notes).toBe('Learned greedy prefix sum technique.');

    vi.restoreAllMocks();
  });
});
