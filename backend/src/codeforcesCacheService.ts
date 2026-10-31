import { db, getProfileById, getProfileByHandle, updateProfileMeta, syncProfileVerifiedAC } from './db.js';
import { codeforcesService } from './codeforcesService.js';
import { contestService } from './contestService.js';
import { SyncStatus } from './types.js';
import { problemJournalService } from './problemJournalService.js';
import { randomUUID } from 'node:crypto';
import type { TimingSink } from './perf.js';

export interface DataFreshness {
  submissionsLastRefreshed: string | null;
  profileLastRefreshed: string | null;
  ratingLastRefreshed: string | null;
  contestsLastRefreshed: string | null;
  problemsetLastRefreshed: string | null;
  isSubmissionsStale: boolean;
  isRatingStale: boolean;
  isContestsStale: boolean;
  isProblemsetStale: boolean;
  isAnyStale: boolean;
}

export interface ExtendedSyncStatus extends SyncStatus {
  dataFreshness: DataFreshness;
}

export class CodeforcesCacheService {
  // Configurable TTLs (sensible defaults, overridable via env)
  readonly SUBMISSIONS_TTL_MS = process.env.SUBMISSIONS_TTL_MS ? parseInt(process.env.SUBMISSIONS_TTL_MS, 10) : 5 * 60 * 1000;
  readonly PROFILE_TTL_MS = process.env.PROFILE_TTL_MS ? parseInt(process.env.PROFILE_TTL_MS, 10) : 5 * 60 * 1000;
  readonly RATING_TTL_MS = process.env.RATING_TTL_MS ? parseInt(process.env.RATING_TTL_MS, 10) : 60 * 60 * 1000;
  readonly CONTESTS_TTL_MS = process.env.CONTESTS_TTL_MS ? parseInt(process.env.CONTESTS_TTL_MS, 10) : 2 * 60 * 60 * 1000;
  readonly PROBLEMSET_TTL_MS = process.env.PROBLEMSET_TTL_MS ? parseInt(process.env.PROBLEMSET_TTL_MS, 10) : 24 * 60 * 60 * 1000;
  readonly ACTIVE_WINDOW_MS = process.env.ACTIVE_WINDOW_MS ? parseInt(process.env.ACTIVE_WINDOW_MS, 10) : 30 * 60 * 1000;

  // In-flight mutex to avoid duplicate concurrent requests for the same handle
  private inFlightSyncs = new Map<string, Promise<ExtendedSyncStatus>>();
  private inFlightContests = new Map<string, Promise<void>>();
  private inFlightProblemset: Promise<void> | null = null;
  private schedulerInterval: NodeJS.Timeout | null = null;
  private readonly ownerId = randomUUID();
  private readonly leaseTtlMs = 5 * 60 * 1000;

  constructor() {
    // Only start background scheduler in non-test production/development mode
    if (!process.env.VITEST) {
      this.startBackgroundScheduler();
    }
  }

  /**
   * Read timestamp from sync_meta table accurately across UTC and local timezones
   */
  getMetaTimestamp(key: string): number | null {
    try {
      const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key) as { value: string } | undefined;
      if (!row || !row.value) return null;
      const str = row.value.trim();
      const isoStr = str.endsWith('Z') || str.includes('+') ? str : (str.replace(' ', 'T') + 'Z');
      const parsed = new Date(isoStr).getTime();
      return isNaN(parsed) ? new Date(str).getTime() : parsed;
    } catch {
      return null;
    }
  }

  /**
   * Save timestamp or string value in sync_meta table
   */
  setMetaValue(key: string, value: string): void {
    try {
      db.prepare(`
        INSERT INTO sync_meta (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `).run(key, value);
    } catch (err) {
      console.warn(`[CacheService] Failed to set sync_meta key ${key}:`, err);
    }
  }

  private acquireLease(leaseKey: string): boolean {
    const now = Date.now();
    const expiresAt = now + this.leaseTtlMs;
    try {
      const result = db.prepare(`
        INSERT INTO sync_leases (lease_key, owner_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(lease_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        WHERE sync_leases.expires_at <= ? OR sync_leases.owner_id = ?
      `).run(leaseKey, this.ownerId, now, expiresAt, now, this.ownerId) as { changes: number };
      return result.changes > 0;
    } catch (err) {
      console.warn(`[CacheService] Could not acquire refresh lease '${leaseKey}':`, err);
      return false;
    }
  }

  private releaseLease(leaseKey: string): void {
    try {
      db.prepare('DELETE FROM sync_leases WHERE lease_key = ? AND owner_id = ?').run(leaseKey, this.ownerId);
    } catch (err) {
      console.warn(`[CacheService] Could not release refresh lease '${leaseKey}':`, err);
    }
  }

  /**
   * Check if a given resource has expired its TTL
   */
  isStale(lastRefreshTimeMs: number | null, ttlMs: number): boolean {
    if (!lastRefreshTimeMs) return true;
    return Date.now() - lastRefreshTimeMs > ttlMs;
  }

  /**
   * Get comprehensive data freshness info for a handle and profile
   */
  getFreshnessStatus(handle: string, profileId?: string): ExtendedSyncStatus {
    const handleLower = handle.toLowerCase();
    const subsTime = this.getMetaTimestamp(`last_submissions_refresh_${handleLower}`);
    const profTime = this.getMetaTimestamp(`last_profile_refresh_${handleLower}`);
    const rateTime = this.getMetaTimestamp(`last_rating_refresh_${handleLower}`);
    const contestKey = profileId ? `last_contests_refresh_${profileId}` : 'last_contests_refresh_global';
    const contestTime = this.getMetaTimestamp(contestKey);
    const problemsetTime = this.getMetaTimestamp('last_problemset_refresh');

    const isSubmissionsStale = this.isStale(subsTime, this.SUBMISSIONS_TTL_MS);
    const isProfileStale = this.isStale(profTime, this.PROFILE_TTL_MS);
    const isRatingStale = this.isStale(rateTime, this.RATING_TTL_MS);
    const isContestsStale = this.isStale(contestTime, this.CONTESTS_TTL_MS);
    const isProblemsetStale = this.isStale(problemsetTime, this.PROBLEMSET_TTL_MS);

    const errRow = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(`last_sync_error_${handleLower}`) as { value: string } | undefined;
    const baseStatus = codeforcesService.getSyncStatus(handle);

    return {
      ...baseStatus,
      isSyncing: this.inFlightSyncs.has(handleLower),
      error: errRow?.value || null,
      dataFreshness: {
        submissionsLastRefreshed: subsTime ? new Date(subsTime).toISOString() : null,
        profileLastRefreshed: profTime ? new Date(profTime).toISOString() : null,
        ratingLastRefreshed: rateTime ? new Date(rateTime).toISOString() : null,
        contestsLastRefreshed: contestTime ? new Date(contestTime).toISOString() : null,
        problemsetLastRefreshed: problemsetTime ? new Date(problemsetTime).toISOString() : null,
        isSubmissionsStale: isSubmissionsStale || isProfileStale,
        isRatingStale,
        isContestsStale,
        isProblemsetStale,
        isAnyStale: isSubmissionsStale || isProfileStale || isRatingStale || isContestsStale || isProblemsetStale,
      },
    };
  }

  private async refreshProblemsetIfNeeded(force: boolean, trace?: TimingSink): Promise<void> {
    const problemCount = (db.prepare('SELECT COUNT(*) AS count FROM problems').get() as { count: number }).count;
    const lastRefresh = this.getMetaTimestamp('last_problemset_refresh');
    if (!force && problemCount >= 100 && !this.isStale(lastRefresh, this.PROBLEMSET_TTL_MS)) return;
    if (this.inFlightProblemset) return this.inFlightProblemset;
    if (!this.acquireLease('problemset_sync')) return;

    const task = (async () => {
      try {
        const fetchStarted = performance.now();
        const problemset = await codeforcesService.getProblemset();
        trace?.add('sync.problemsetFetch', performance.now() - fetchStarted);
        const writeStarted = performance.now();
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
        for (const stat of problemset.problemStatistics) {
          if (stat.contestId && stat.index) {
            solvedMap.set(`${stat.contestId}_${stat.index}`, stat.solvedCount || 0);
          }
        }

        db.exec('BEGIN TRANSACTION');
        try {
          for (const problem of problemset.problems) {
            if (!problem.contestId || !problem.index) continue;
            const problemId = `${problem.contestId}_${problem.index}`;
            insertProblem.run(
              problemId,
              problem.contestId,
              problem.index,
              problem.name,
              problem.type ?? 'PROGRAMMING',
              problem.rating ?? null,
              JSON.stringify(problem.tags || []),
              solvedMap.get(problemId) || 0
            );
          }
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        trace?.add('sync.problemsetWrite', performance.now() - writeStarted);
        this.setMetaValue('last_problemset_refresh', new Date().toISOString());
      } finally {
        this.releaseLease('problemset_sync');
      }
    })();

    this.inFlightProblemset = task;
    try {
      await task;
    } finally {
      if (this.inFlightProblemset === task) this.inFlightProblemset = null;
    }
  }

  /**
   * Unified auto-refresh method.
   * Refreshes only stale components or all if force=true.
   * Deduplicates concurrent calls via inFlightSyncs.
   * Handles API errors gracefully without wiping existing cached data.
   */
  async autoRefreshIfNeeded(
    profileIdOrHandle: string,
    force = false,
    trace?: TimingSink,
  ): Promise<ExtendedSyncStatus> {
    const profile = getProfileById(profileIdOrHandle) || getProfileByHandle(profileIdOrHandle);
    if (!profile) {
      throw new Error(`Profile '${profileIdOrHandle}' not found`);
    }

    const handle = profile.handle;
    const handleLower = handle.toLowerCase();
    const profileId = profile.id;

    // In-flight deduplication: return existing promise if already syncing
    if (this.inFlightSyncs.has(handleLower)) {
      return this.inFlightSyncs.get(handleLower)!;
    }

    const freshnessStarted = performance.now();
    const freshness = this.getFreshnessStatus(handle, profileId);
    trace?.add('sync.freshness', performance.now() - freshnessStarted);

    // If everything is fresh and force is false, return immediately without network call
    if (!force && !freshness.dataFreshness.isAnyStale && freshness.submissionsCount > 0) {
      return freshness;
    }

    const leaseKey = `profile_sync_${handleLower}`;
    if (!this.acquireLease(leaseKey)) {
      // Another backend process is refreshing this profile. Keep serving the
      // last valid snapshot; its completion will be visible on the next poll.
      return freshness;
    }

    const syncPromise = (async (): Promise<ExtendedSyncStatus> => {
      let syncError: string | null = null;
      let stageStarted = 0;
      try {
        const nowIso = new Date().toISOString();

        // 1. Refresh profile and submissions if stale or forced
        const needSubs = force || freshness.dataFreshness.isSubmissionsStale || freshness.submissionsCount === 0;
        if (needSubs) {
          try {
            // Fetch User Info
            stageStarted = performance.now();
            const userInfo = await codeforcesService.getUserInfo(handle);
            trace?.add('sync.userInfo', performance.now() - stageStarted);
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

              updateProfileMeta(profileId, {
                avatar: userInfo.avatar,
                rating: userInfo.rating,
                maxRating: userInfo.maxRating,
                rank: userInfo.rank,
                maxRank: userInfo.maxRank,
              });
              this.setMetaValue(`last_profile_refresh_${handleLower}`, nowIso);
            }

            // Fetch Submissions: Full 4000 on first sync or force; recent 150 on incremental refresh
            const subCount = freshness.submissionsCount;
            const fetchCount = (force || subCount === 0) ? 4000 : 150;
            stageStarted = performance.now();
            const submissions = await codeforcesService.getUserStatus(handle, fetchCount);
            trace?.add('sync.submissionsFetch', performance.now() - stageStarted);

            if (submissions !== null) {
              if (submissions.length > 0) {
              stageStarted = performance.now();
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
                  if (sub.verdict === 'OK') {
                    problemJournalService.record({
                      profileId,
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

              // Update verified ACs for active daily problems
              syncProfileVerifiedAC(profileId, handle);
              trace?.add('sync.submissionsWrite', performance.now() - stageStarted);
              }
              // An empty successful response is still a successful refresh.
              this.setMetaValue(`last_submissions_refresh_${handleLower}`, nowIso);
            }
          } catch (subErr: any) {
            console.warn(`[CacheService] Submissions refresh error for ${handle}:`, subErr.message);
            syncError = subErr.message;
          }
        }

        // 2. Refresh rating history if stale or forced
        const needRating = force || freshness.dataFreshness.isRatingStale;
        if (needRating) {
          try {
            stageStarted = performance.now();
            const ratings = await codeforcesService.getUserRating(handle);
            trace?.add('sync.ratingFetch', performance.now() - stageStarted);
            if (ratings !== null) {
              if (ratings.length > 0) {
              stageStarted = performance.now();
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
                try { db.exec('ROLLBACK'); } catch {}
                throw e;
              }
              }
              trace?.add('sync.ratingWrite', performance.now() - stageStarted);
              // Unrated users legitimately have an empty rating history.
              this.setMetaValue(`last_rating_refresh_${handleLower}`, nowIso);
            }
          } catch (rateErr: any) {
            console.warn(`[CacheService] Rating refresh error for ${handle}:`, rateErr.message);
            if (!syncError) syncError = rateErr.message;
          }
        }

        // 3. Refresh contest list if stale or forced
        const needContests = force || freshness.dataFreshness.isContestsStale;
        if (needContests) {
          try {
            stageStarted = performance.now();
            await contestService.detectAndSyncContests(profileId, trace);
            trace?.add('sync.contests', performance.now() - stageStarted);
            this.setMetaValue(`last_contests_refresh_${profileId}`, nowIso);
            this.setMetaValue('last_contests_refresh_global', nowIso);
          } catch (cErr: any) {
            console.warn(`[CacheService] Contest refresh error for ${handle}:`, cErr.message);
            if (!syncError) syncError = cErr.message;
          }
        }

        // Keep the candidate pool current for recommendations. The refresh
        // method uses its own global lease so multiple profiles/processes do
        // not download or write the problemset concurrently.
        try {
          stageStarted = performance.now();
          await this.refreshProblemsetIfNeeded(force, trace);
          trace?.add('sync.problemset', performance.now() - stageStarted);
        } catch (problemsetErr: any) {
          console.warn('[CacheService] Problemset refresh error:', problemsetErr.message);
          if (!syncError) syncError = problemsetErr.message;
        }

        // Record global and handle sync completion
        if (!syncError) {
          this.setMetaValue('last_synced_at', nowIso);
          this.setMetaValue(`last_synced_${handleLower}`, nowIso);
          this.setMetaValue(`last_sync_error_${handleLower}`, '');
        } else {
          this.setMetaValue(`last_sync_error_${handleLower}`, syncError || '');
        }
      } catch (err: any) {
        console.error(`[CacheService] Top-level sync error for ${handle}:`, err);
        syncError = err.message || 'Unexpected sync error';
        this.setMetaValue(`last_sync_error_${handleLower}`, syncError || '');
      } finally {
        this.inFlightSyncs.delete(handleLower);
        this.releaseLease(leaseKey);
      }

      return this.getFreshnessStatus(handle, profileId);
    })();

    this.inFlightSyncs.set(handleLower, syncPromise);
    return syncPromise;
  }

  /**
   * Auto-refresh contest listings if stale (> 2 hours) or forced
   */
  async autoRefreshContestsIfNeeded(profileId: string, force = false): Promise<void> {
    const contestKey = `last_contests_refresh_${profileId}`;
    const contestTime = this.getMetaTimestamp(contestKey);
    const stale = this.isStale(contestTime, this.CONTESTS_TTL_MS);

    if (!force && !stale) {
      return;
    }

    if (this.inFlightContests.has(profileId)) {
      return this.inFlightContests.get(profileId);
    }

    const leaseKey = `contest_sync_${profileId}`;
    if (!this.acquireLease(leaseKey)) return;

    const task = (async () => {
      try {
        await contestService.detectAndSyncContests(profileId);
        const nowIso = new Date().toISOString();
        this.setMetaValue(contestKey, nowIso);
        this.setMetaValue('last_contests_refresh_global', nowIso);
      } catch (err: any) {
        console.warn(`[CacheService] Failed to auto-refresh contests for ${profileId}:`, err.message);
      } finally {
        this.inFlightContests.delete(profileId);
        this.releaseLease(leaseKey);
      }
    })();

    this.inFlightContests.set(profileId, task);
    return task;
  }

  /**
   * Start periodic background scheduler for active profiles
   */
  startBackgroundScheduler(intervalMs = 60_000): void {
    if (this.schedulerInterval) return;
    this.schedulerInterval = setInterval(async () => {
      try {
        const activeProfiles = db.prepare(`
          SELECT id, handle, last_active_at
          FROM profiles
          WHERE last_active_at IS NOT NULL
        `).all() as Array<{ id: string; handle: string; last_active_at: string }>;

        const now = Date.now();
        for (const p of activeProfiles) {
          const lastActive = new Date(p.last_active_at).getTime();
          // Only refresh if profile was used recently (active session)
          if (!isNaN(lastActive) && (now - lastActive) < this.ACTIVE_WINDOW_MS) {
            const status = this.getFreshnessStatus(p.handle, p.id);
            // Any stale component should wake the unified refresh path.  The
            // path itself decides which endpoint(s) need refreshing by TTL,
            // so rating and contest metadata are not starved while
            // submissions remain fresh.
            if (status.dataFreshness.isAnyStale) {
              await this.autoRefreshIfNeeded(p.id, false);
            }
          }
        }
      } catch (err) {
        // Suppress background errors
      }
    }, intervalMs);
  }

  stopBackgroundScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
  }

  /** Stop polling and let already-started refreshes finish before shutdown. */
  async shutdown(): Promise<void> {
    this.stopBackgroundScheduler();
    const pending = [
      ...this.inFlightSyncs.values(),
      ...this.inFlightContests.values(),
      ...(this.inFlightProblemset ? [this.inFlightProblemset] : []),
    ];
    await Promise.allSettled(pending);
  }
}

export const codeforcesCacheService = new CodeforcesCacheService();
