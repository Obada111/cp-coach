import { db, updateProfileMeta, getProfileByHandle, syncProfileVerifiedAC } from './db.js';
import { requestCodeforcesApi } from './codeforcesApi.js';
import { CFUser, CFRatingChange, CFSubmission, CFProblem, SyncStatus } from './types.js';
import { problemJournalService } from './problemJournalService.js';


export class CodeforcesService {
  private isSyncing = false;

  async validateHandle(handle: string): Promise<{ valid: boolean; user?: CFUser; error?: string }> {
    try {
      const results = await requestCodeforcesApi<CFUser[]>('user.info', { handles: handle });
      if (results && results.length > 0) {
        return { valid: true, user: results[0] };
      }
      return { valid: false, error: `Handle '${handle}' not found on Codeforces` };
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('handles: user')) {
        return { valid: false, error: `Codeforces handle '${handle}' does not exist. Please check the spelling.` };
      }
      return { valid: false, error: `Codeforces check failed: ${msg}` };
    }
  }

  async getUserInfo(handle: string): Promise<CFUser | null> {
    try {
      const results = await requestCodeforcesApi<CFUser[]>('user.info', { handles: handle });
      if (results && results.length > 0) {
        return results[0];
      }
      return null;
    } catch (err) {
      console.warn(`Failed to fetch user.info for ${handle}:`, err);
      throw err;
    }
  }

  async getUserRating(handle: string): Promise<CFRatingChange[] | null> {
    try {
      return await requestCodeforcesApi<CFRatingChange[]>('user.rating', { handle });
    } catch (err) {
      console.warn(`Failed to fetch user.rating for ${handle}:`, err);
      throw err;
    }
  }

  async getUserStatus(handle: string, count = 3000): Promise<CFSubmission[] | null> {
    try {
      return await requestCodeforcesApi<CFSubmission[]>('user.status', { handle, from: 1, count });
    } catch (err) {
      console.warn(`Failed to fetch user.status for ${handle}:`, err);
      throw err;
    }
  }

  async getProblemset(): Promise<{ problems: CFProblem[]; problemStatistics: any[] }> {
    return await requestCodeforcesApi<{ problems: CFProblem[]; problemStatistics: any[] }>('problemset.problems');
  }

  async getOfficialContests(): Promise<Array<{
    id: number;
    name: string;
    startTimeSeconds: number;
    durationSeconds?: number;
    phase?: string;
  }> | null> {
    return await requestCodeforcesApi<Array<{
      id: number;
      name: string;
      startTimeSeconds: number;
      durationSeconds?: number;
      phase?: string;
    }>>('contest.list', { gym: false });
  }

  async syncAll(handle: string, profileId?: string): Promise<{ success: boolean; message: string; error?: string }> {
    if (this.isSyncing) {
      return { success: false, message: 'Sync already in progress' };
    }

    this.isSyncing = true;
    const targetProfileId = profileId || getProfileByHandle(handle)?.id;
    try {
      // 1. Fetch user info
      const userInfo = await this.getUserInfo(handle);
      if (userInfo) {
        db.prepare(`
          INSERT INTO profile_cache (handle, rating, max_rating, rank, max_rank, avatar, title_photo, organization, city, country, raw_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(handle) DO UPDATE SET
            rating = excluded.rating,
            max_rating = excluded.max_rating,
            rank = excluded.rank,
            max_rank = excluded.max_rank,
            avatar = excluded.avatar,
            title_photo = excluded.title_photo,
            organization = excluded.organization,
            city = excluded.city,
            country = excluded.country,
            raw_json = excluded.raw_json,
            updated_at = datetime('now')
        `).run(
          userInfo.handle,
          userInfo.rating ?? null,
          userInfo.maxRating ?? null,
          userInfo.rank ?? null,
          userInfo.maxRank ?? null,
          userInfo.avatar ?? null,
          userInfo.titlePhoto ?? null,
          userInfo.organization ?? null,
          userInfo.city ?? null,
          userInfo.country ?? null,
          JSON.stringify(userInfo)
        );

        // Update profile in profiles table if matching
        if (targetProfileId) {
          updateProfileMeta(targetProfileId, {
            avatar: userInfo.avatar,
            rating: userInfo.rating,
            maxRating: userInfo.maxRating,
            rank: userInfo.rank,
            maxRank: userInfo.maxRank,
          });
        }
      }

      // 2. Fetch rating history
      const ratings = await this.getUserRating(handle);
      if (ratings && ratings.length > 0) {
        const insertRating = db.prepare(`
          INSERT INTO rating_history (handle, contest_id, contest_name, rank, rating_update_time, old_rating, new_rating)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(handle, contest_id) DO UPDATE SET
            contest_name = excluded.contest_name,
            rank = excluded.rank,
            rating_update_time = excluded.rating_update_time,
            old_rating = excluded.old_rating,
            new_rating = excluded.new_rating
        `);

        db.exec('BEGIN TRANSACTION');
        try {
          for (const r of ratings) {
            insertRating.run(
              handle,
              r.contestId,
              r.contestName,
              r.rank,
              r.ratingUpdateTimeSeconds,
              r.oldRating,
              r.newRating
            );
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }

      // 3. Fetch submissions
      const submissions = await this.getUserStatus(handle, 4000);
      if (submissions && submissions.length > 0) {
        const insertSub = db.prepare(`
          INSERT OR REPLACE INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time, programming_language, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        db.exec('BEGIN TRANSACTION');
        try {
          for (const sub of submissions) {
            if (!sub.problem || !sub.problem.contestId || !sub.problem.index) continue;
            const problemId = `${sub.problem.contestId}_${sub.problem.index}`;
            insertSub.run(
              sub.id,
              handle,
              problemId,
              sub.problem.contestId,
              sub.problem.index,
              sub.verdict ?? 'UNKNOWN',
              sub.creationTimeSeconds,
              sub.programmingLanguage ?? '',
              JSON.stringify(sub)
            );
            if (targetProfileId && sub.verdict === 'OK') {
              problemJournalService.record({
                profileId: targetProfileId,
                problemId,
                source: 'VERIFIED_CODEFORCES',
                solvedStatus: 'VERIFIED_ACCEPTED',
                verifiedAc: true,
                sourceKey: `cf_submission_${sub.id}`,
                problemName: sub.problem.name,
                contestId: sub.problem.contestId,
                problemIndex: sub.problem.index,
                rating: sub.problem.rating ?? null,
                tags: sub.problem.tags || [],
              });
            }
          }
          db.exec('COMMIT');
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }

        // Verify Codeforces AC for this profile's daily training problems
        if (targetProfileId) {
          try {
            const verifiedCount = syncProfileVerifiedAC(targetProfileId, handle);
            if (verifiedCount > 0) {
              console.log(`[Codeforces Sync] Verified ${verifiedCount} accepted daily problems for profile ${targetProfileId}`);
            }
          } catch (vErr) {
            console.warn('[Codeforces Sync] Could not verify daily problems AC:', vErr);
          }
        }
      }

      // 4. Fetch problems if table is empty or sparse (<100)
      // Store official round dates separately. The problemset API does not
      // expose problem creation timestamps, so this is the only recency
      // evidence used by the recommendation engine.
      try {
        const contests = await this.getOfficialContests();
        if (contests) {
          const insertContest = db.prepare(`
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
          for (const contest of contests) {
            if (contest.id > 0 && contest.id < 100000 && contest.startTimeSeconds > 0) {
              insertContest.run(contest.id, contest.name, contest.startTimeSeconds, contest.durationSeconds ?? null, contest.phase ?? null);
            }
          }
        }
      } catch (err: any) {
        console.warn('Official contest metadata fetch failed; recency preference unavailable:', err?.message || err);
      }

      const problemsCountRow = db.prepare('SELECT COUNT(*) as count FROM problems').get() as { count: number };
      if (!problemsCountRow || problemsCountRow.count < 100) {
        try {
          const problemset = await this.getProblemset();
          if (problemset && problemset.problems) {
            const insertProblem = db.prepare(`
              INSERT INTO problems (id, contest_id, problem_index, name, type, rating, tags, solved_count, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(id) DO UPDATE SET
                contest_id = excluded.contest_id,
                problem_index = excluded.problem_index,
                name = excluded.name,
                type = excluded.type,
                rating = excluded.rating,
                tags = excluded.tags,
                solved_count = excluded.solved_count,
                updated_at = datetime('now')
            `);

            const solvedMap = new Map<string, number>();
            if (problemset.problemStatistics) {
              for (const stat of problemset.problemStatistics) {
                solvedMap.set(`${stat.contestId}_${stat.index}`, stat.solvedCount || 0);
              }
            }

            db.exec('BEGIN TRANSACTION');
            try {
              for (const p of problemset.problems) {
                if (!p.contestId || !p.index) continue;
                const problemId = `${p.contestId}_${p.index}`;
                const solvedCount = solvedMap.get(problemId) || 0;
                insertProblem.run(
                  problemId,
                  p.contestId,
                  p.index,
                  p.name,
                  p.type ?? 'PROGRAMMING',
                  p.rating ?? null,
                  JSON.stringify(p.tags || []),
                  solvedCount
                );
              }
              db.exec('COMMIT');
            } catch (e) {
              db.exec('ROLLBACK');
              throw e;
            }
          }
        } catch (err: any) {
          console.warn('Problemset fetch failed, continuing with existing problems:', err.message);
        }
      }

      // Update sync meta for this handle
      db.prepare(`
        INSERT INTO sync_meta (key, value, updated_at)
        VALUES ('last_synced_at', datetime('now'), datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')
      `).run();

      db.prepare(`
        INSERT INTO sync_meta (key, value, updated_at)
        VALUES (?, datetime('now'), datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')
      `).run(`last_synced_${handle.toLowerCase()}`);

      return { success: true, message: `Successfully synchronized ${handle} from Codeforces` };
    } catch (err: any) {
      console.error(`Codeforces sync error for ${handle}:`, err);
      return { success: false, message: 'Sync failed partially or completely', error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }

  getSyncStatus(handle: string): SyncStatus {
    const handleKey = `last_synced_${handle.toLowerCase()}`;
    const specificSyncRow = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(handleKey) as { value: string } | undefined;
    const globalSyncRow = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_synced_at'").get() as { value: string } | undefined;
    const subCountRow = db.prepare('SELECT COUNT(*) as count FROM submissions WHERE lower(handle) = lower(?)').get(handle) as { count: number } | undefined;
    const probCountRow = db.prepare('SELECT COUNT(*) as count FROM problems').get() as { count: number } | undefined;
    const solvedRow = db.prepare("SELECT COUNT(DISTINCT problem_id) as count FROM submissions WHERE lower(handle) = lower(?) AND verdict = 'OK'").get(handle) as { count: number } | undefined;

    return {
      lastSyncedAt: specificSyncRow ? specificSyncRow.value : (globalSyncRow ? globalSyncRow.value : null),
      isSyncing: this.isSyncing,
      handle,
      submissionsCount: subCountRow ? subCountRow.count : 0,
      problemsCount: probCountRow ? probCountRow.count : 0,
      solvedDistinctCount: solvedRow ? solvedRow.count : 0,
    };
  }

  getCachedProfile(handle: string): CFUser | null {
    const row = db.prepare('SELECT * FROM profile_cache WHERE lower(handle) = lower(?)').get(handle) as any;
    if (!row) return null;
    return {
      handle: row.handle,
      rating: row.rating,
      maxRating: row.max_rating,
      rank: row.rank,
      maxRank: row.max_rank,
      avatar: row.avatar,
      titlePhoto: row.title_photo,
      organization: row.organization,
      city: row.city,
      country: row.country,
    };
  }

  getCachedRatingHistory(handle: string): CFRatingChange[] {
    const rows = db.prepare('SELECT * FROM rating_history WHERE lower(handle) = lower(?) ORDER BY rating_update_time ASC').all(handle) as any[];
    return rows.map((r) => ({
      contestId: r.contest_id,
      contestName: r.contest_name,
      handle: r.handle,
      rank: r.rank,
      ratingUpdateTimeSeconds: r.rating_update_time,
      oldRating: r.old_rating,
      newRating: r.new_rating,
    }));
  }
}

export const codeforcesService = new CodeforcesService();
