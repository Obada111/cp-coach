import { db, getProfileById } from './db.js';

export type ReviewSource = 'DAILY_STRUGGLE' | 'CONTEST_STRUGGLE' | 'MANUAL';
export type ReviewState = 'DUE' | 'COMPLETED' | 'DEFERRED' | 'MASTERED';
export type ReviewOutcome = 'MASTERED' | 'EASY' | 'DIFFICULT' | 'DEFERRED';

export interface ReviewQueueItem {
  id: string;
  profileId: string;
  problemId: string;
  source: ReviewSource;
  contestId: number | null;
  problemIndex: string | null;
  problemName: string;
  rating: number | null;
  tags: string[];
  triggerReason: string;
  addedAt: string;
  dueDate: string;
  intervalDays: number;
  repetitionCount: number;
  state: ReviewState;
  lastReviewedAt: string | null;
  reviewNotes: string | null;
  isDue: boolean;
  cfUrl: string;
}

export class ReviewService {
  /**
   * Helper to format current date string in local or configured timezone
   */
  getTodayDateString(): string {
    const tz = process.env.TIMEZONE || 'Asia/Hebron';
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  /**
   * Calculate future date string given base date and days offset
   */
  private addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Add or re-queue a problem in the spaced repetition queue
   */
  enqueueProblem(
    profileId: string,
    problemId: string,
    triggerReason: string,
    source: ReviewSource = 'DAILY_STRUGGLE'
  ): ReviewQueueItem {
    const profile = getProfileById(profileId);
    if (!profile) throw new Error(`Profile '${profileId}' not found`);

    // Lookup problem metadata
    const probRow = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId) as any;
    const parts = problemId.split('_');
    const contestId = probRow ? probRow.contest_id : (parts[0] ? parseInt(parts[0], 10) : null);
    const problemIndex = probRow ? probRow.problem_index : (parts[1] || 'A');
    const problemName = probRow ? probRow.name : `Problem ${problemId}`;
    const rating = probRow ? probRow.rating : null;
    const tagsJson = probRow ? probRow.tags : '[]';

    const today = this.getTodayDateString();
    // Default review interval: 1 day after struggle
    const initialDueDate = this.addDays(today, 1);
    const recordId = `rev_${profileId}_${problemId}`;

    db.prepare(`
      INSERT INTO review_queue (
        id, profile_id, problem_id, source, contest_id, problem_index, problem_name,
        rating, tags, trigger_reason, added_at, due_date, interval_days, repetition_count,
        state, last_reviewed_at, review_notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 1, 0, 'DUE', NULL, NULL)
      ON CONFLICT(profile_id, problem_id) DO UPDATE SET
        trigger_reason = excluded.trigger_reason,
        source = excluded.source,
        due_date = CASE 
          WHEN review_queue.state = 'MASTERED' THEN excluded.due_date
          WHEN review_queue.due_date <= excluded.due_date THEN review_queue.due_date
          ELSE excluded.due_date
        END,
        state = CASE 
          WHEN review_queue.state = 'MASTERED' THEN 'DUE' 
          ELSE review_queue.state 
        END,
        interval_days = 1,
        repetition_count = 0
    `).run(
      recordId,
      profileId,
      problemId,
      source,
      contestId,
      problemIndex,
      problemName,
      rating,
      tagsJson,
      triggerReason,
      initialDueDate
    );

    return this.getReviewItem(profileId, problemId)!;
  }

  /**
   * Fetch single review item
   */
  getReviewItem(profileId: string, problemId: string): ReviewQueueItem | null {
    const row = db.prepare('SELECT * FROM review_queue WHERE profile_id = ? AND problem_id = ?').get(profileId, problemId) as any;
    if (!row) return null;

    let tags: string[] = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch {}

    const today = this.getTodayDateString();
    const isDue = row.state === 'DUE' && row.due_date <= today;

    return {
      id: row.id,
      profileId: row.profile_id,
      problemId: row.problem_id,
      source: row.source,
      contestId: row.contest_id,
      problemIndex: row.problem_index,
      problemName: row.problem_name,
      rating: row.rating,
      tags,
      triggerReason: row.trigger_reason,
      addedAt: row.added_at,
      dueDate: row.due_date,
      intervalDays: row.interval_days,
      repetitionCount: row.repetition_count,
      state: row.state,
      lastReviewedAt: row.last_reviewed_at,
      reviewNotes: row.review_notes,
      isDue,
      cfUrl: `https://codeforces.com/contest/${row.contest_id}/problem/${row.problem_index}`,
    };
  }

  /**
   * Get all due review problems for a profile
   */
  getDueReviews(profileId: string, limit = 5): ReviewQueueItem[] {
    const today = this.getTodayDateString();
    const rows = db.prepare(`
      SELECT * FROM review_queue
      WHERE profile_id = ? AND state = 'DUE' AND due_date <= ?
      ORDER BY due_date ASC, rating DESC
      LIMIT ?
    `).all(profileId, today, limit) as any[];

    return rows.map((r) => {
      let tags: string[] = [];
      try { tags = JSON.parse(r.tags || '[]'); } catch {}
      return {
        id: r.id,
        profileId: r.profile_id,
        problemId: r.problem_id,
        source: r.source,
        contestId: r.contest_id,
        problemIndex: r.problem_index,
        problemName: r.problem_name,
        rating: r.rating,
        tags,
        triggerReason: r.trigger_reason,
        addedAt: r.added_at,
        dueDate: r.due_date,
        intervalDays: r.interval_days,
        repetitionCount: r.repetition_count,
        state: r.state,
        lastReviewedAt: r.last_reviewed_at,
        reviewNotes: r.review_notes,
        isDue: true,
        cfUrl: `https://codeforces.com/contest/${r.contest_id}/problem/${r.problem_index}`,
      };
    });
  }

  /**
   * Get total review queue summary (due count, upcoming count, mastered count)
   */
  getQueueSummary(profileId: string): {
    dueCount: number;
    upcomingCount: number;
    masteredCount: number;
    totalCount: number;
  } {
    const today = this.getTodayDateString();
    const dueRow = db.prepare("SELECT COUNT(*) as c FROM review_queue WHERE profile_id = ? AND state = 'DUE' AND due_date <= ?").get(profileId, today) as { c: number };
    const upRow = db.prepare("SELECT COUNT(*) as c FROM review_queue WHERE profile_id = ? AND state = 'DUE' AND due_date > ?").get(profileId, today) as { c: number };
    const masRow = db.prepare("SELECT COUNT(*) as c FROM review_queue WHERE profile_id = ? AND state = 'MASTERED'").get(profileId) as { c: number };

    return {
      dueCount: dueRow?.c || 0,
      upcomingCount: upRow?.c || 0,
      masteredCount: masRow?.c || 0,
      totalCount: (dueRow?.c || 0) + (upRow?.c || 0) + (masRow?.c || 0),
    };
  }

  /**
   * Record review outcome using adaptive spaced repetition schedule
   * Intervals: 1d -> 3d -> 7d -> 14d -> MASTERED
   */
  recordReviewOutcome(
    profileId: string,
    problemId: string,
    outcome: ReviewOutcome,
    notes?: string
  ): ReviewQueueItem {
    const current = this.getReviewItem(profileId, problemId);
    if (!current) throw new Error(`Review item '${problemId}' not found in review queue`);

    const today = this.getTodayDateString();
    let newIntervalDays = current.intervalDays;
    let newRepetitions = current.repetitionCount;
    let newState: ReviewState = 'DUE';
    let newDueDate = current.dueDate;

    switch (outcome) {
      case 'MASTERED':
        newState = 'MASTERED';
        newIntervalDays = 30;
        newRepetitions = current.repetitionCount + 1;
        newDueDate = this.addDays(today, 30);
        break;

      case 'EASY':
        newRepetitions = current.repetitionCount + 1;
        if (newRepetitions === 1) newIntervalDays = 3;
        else if (newRepetitions === 2) newIntervalDays = 7;
        else if (newRepetitions === 3) newIntervalDays = 14;
        else {
          newState = 'MASTERED';
          newIntervalDays = 30;
        }
        newDueDate = this.addDays(today, newIntervalDays);
        break;

      case 'DIFFICULT':
        // Reset interval to 1 day; retain problem in high attention
        newIntervalDays = 1;
        newRepetitions = Math.max(0, current.repetitionCount - 1);
        newState = 'DUE';
        newDueDate = this.addDays(today, 1);
        break;

      case 'DEFERRED':
        // Postpone by 2 days without penalizing repetition count
        newState = 'DUE';
        newDueDate = this.addDays(today, 2);
        break;
    }

    db.prepare(`
      UPDATE review_queue
      SET 
        interval_days = ?,
        repetition_count = ?,
        state = ?,
        due_date = ?,
        last_reviewed_at = datetime('now'),
        review_notes = COALESCE(?, review_notes)
      WHERE profile_id = ? AND problem_id = ?
    `).run(newIntervalDays, newRepetitions, newState, newDueDate, notes || null, profileId, problemId);

    return this.getReviewItem(profileId, problemId)!;
  }
}

export const reviewService = new ReviewService();
