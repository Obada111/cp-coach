import { db, getProfileById } from './db.js';

/**
 * Browser-owned personal state.
 *
 * The public deployment keeps an ephemeral SQLite database so that the full
 * recommendation/analysis engine can run unchanged. The browser stores the
 * authoritative snapshot of everything personal (assignments, feedback,
 * reviews, reflections and goals) and uploads it after a cold start.
 */
export const PUBLIC_CONTEXT_VERSION = 1;

const MAX_DAILY_SETS = 90;
const MAX_DAILY_PROBLEMS = 360;
const MAX_REVIEW_ITEMS = 500;
const MAX_SESSIONS = 300;
const MAX_CONTEST_REVIEWS = 300;
const MAX_USER_CONTESTS = 300;
const MAX_WEEKLY_GOALS = 52;
const MAX_LEARNING_EVENTS = 750;

const PERSONAL_TABLES = {
  dailySets: {
    table: 'daily_sets',
    columns: ['id', 'profile_id', 'date', 'generated_at'],
    limit: MAX_DAILY_SETS,
    orderBy: 'date DESC',
  },
  dailyProblems: {
    table: 'daily_problems',
    columns: [
      'id', 'daily_set_id', 'profile_id', 'daily_set_date', 'problem_id', 'category',
      'reason', 'target_rating', 'completed', 'solved_status', 'perceived_difficulty',
      'difficulty_experience', 'solution_method', 'time_spent_minutes', 'notes',
      'problem_opinion', 'updated_at', 'verified_cf_ac', 'educational_source',
      'educational_source_url', 'curriculum_stage', 'learning_objective',
      'prerequisites', 'struggle_reason', 'is_opened', 'opened_at', 'attempted',
      'self_reported_solved',
    ],
    limit: MAX_DAILY_PROBLEMS,
    orderBy: 'daily_set_date DESC, updated_at DESC',
  },
  reviewQueue: {
    table: 'review_queue',
    columns: [
      'id', 'profile_id', 'problem_id', 'source', 'contest_id', 'problem_index',
      'problem_name', 'rating', 'tags', 'trigger_reason', 'added_at', 'due_date',
      'interval_days', 'repetition_count', 'state', 'last_reviewed_at', 'review_notes',
    ],
    limit: MAX_REVIEW_ITEMS,
    orderBy: 'added_at DESC',
  },
  solveSessions: {
    table: 'solve_sessions',
    columns: [
      'id', 'profile_id', 'problem_id', 'problem_name', 'problem_rating', 'tags',
      'started_at', 'ended_at', 'duration_seconds', 'active_duration_seconds',
      'hints_revealed', 'editorial_viewed', 'outcome', 'verified_ac',
      'perceived_difficulty', 'struggle_type', 'key_takeaway', 'reflection_notes',
      'created_at', 'updated_at',
    ],
    limit: MAX_SESSIONS,
    orderBy: 'started_at DESC',
  },
  contestReviews: {
    table: 'contest_problem_reviews',
    columns: [
      'id', 'profile_id', 'contest_id', 'problem_index', 'self_review_tag',
      'self_review_notes', 'upsolve_status', 'upsolved_submission_id', 'updated_at',
    ],
    limit: MAX_CONTEST_REVIEWS,
    orderBy: 'updated_at DESC',
  },
  userContests: {
    table: 'user_contests',
    columns: [
      'id', 'profile_id', 'contest_id', 'name', 'start_time_seconds',
      'duration_seconds', 'participation_type', 'rank', 'old_rating', 'new_rating',
      'rating_change', 'problems_solved', 'problems_attempted', 'total_submissions',
      'penalties', 'is_official', 'report_json', 'created_at', 'updated_at',
    ],
    limit: MAX_USER_CONTESTS,
    orderBy: 'start_time_seconds DESC',
  },
  weeklyGoals: {
    table: 'weekly_goals',
    columns: [
      'id', 'profile_id', 'week_start_date', 'target_solves', 'target_contests',
      'target_upsolves', 'focus_topics', 'notes', 'updated_at',
    ],
    limit: MAX_WEEKLY_GOALS,
    orderBy: 'week_start_date DESC',
  },
  learningEvents: {
    table: 'problem_learning_events',
    columns: [
      'id', 'profile_id', 'problem_id', 'source', 'problem_name', 'contest_id',
      'problem_index', 'rating', 'tags', 'solved_status', 'perceived_difficulty',
      'difficulty_experience', 'solution_method', 'struggle_reason', 'notes',
      'problem_opinion', 'verified_ac', 'hints_revealed', 'editorial_viewed',
      'source_key', 'occurred_at',
    ],
    limit: MAX_LEARNING_EVENTS,
    orderBy: 'occurred_at DESC',
  },
} as const;

const PROBLEM_COLUMNS = [
  'id', 'contest_id', 'problem_index', 'name', 'type', 'rating', 'tags',
  'solved_count', 'updated_at',
];
const CONTEST_META_COLUMNS = [
  'id', 'contest_id', 'problem_index', 'name', 'rating', 'tags', 'cf_url',
];
const LEARNER_COLUMNS = ['profile_id', 'handle', 'data_json', 'updated_at'];

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, max = 20000): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, max);
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sqlValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

function jsonValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length <= 20000) {
      try {
        JSON.parse(value);
        return value;
      } catch {
        return '[]';
      }
    }
    return '[]';
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value.slice(0, 50).map((item) => String(item).slice(0, 100)));
  }
  return '[]';
}

const NUMERIC_COLUMNS = new Set([
  'rating', 'max_rating', 'solved_count', 'target_rating', 'completed',
  'time_spent_minutes', 'verified_cf_ac', 'is_opened', 'attempted',
  'self_reported_solved', 'contest_id', 'interval_days', 'repetition_count',
  'duration_seconds', 'active_duration_seconds', 'hints_revealed',
  'editorial_viewed', 'verified_ac', 'old_rating', 'new_rating',
  'rating_change', 'problems_solved', 'problems_attempted',
  'total_submissions', 'penalties', 'is_official', 'upsolved_submission_id',
  'target_solves', 'target_contests', 'target_upsolves', 'start_time_seconds',
  'duration_seconds',
]);

const JSON_COLUMNS = new Set(['tags', 'prerequisites', 'focus_topics']);
const DEFAULT_COLUMN_VALUES: Record<string, string | number> = {
  completed: 0,
  is_opened: 0,
  attempted: 0,
  self_reported_solved: 0,
  verified_cf_ac: 0,
  verified_ac: 0,
  duration_seconds: 0,
  active_duration_seconds: 0,
  hints_revealed: 0,
  editorial_viewed: 0,
  interval_days: 1,
  repetition_count: 0,
  state: 'DUE',
  source: 'DAILY_STRUGGLE',
  outcome: 'IN_PROGRESS',
  participation_type: 'RATED',
  is_official: 1,
  problems_solved: 0,
  problems_attempted: 0,
  total_submissions: 0,
  penalties: 0,
  target_solves: 15,
  target_contests: 1,
  target_upsolves: 3,
  upsolve_status: 'UNSOLVED',
};
const TIMESTAMP_DEFAULT_COLUMNS = new Set([
  'generated_at',
  'created_at',
  'updated_at',
  'added_at',
  'occurred_at',
]);

function cleanColumn(column: string, value: unknown): unknown {
  if (JSON_COLUMNS.has(column)) return jsonValue(value);
  if (NUMERIC_COLUMNS.has(column)) return numberValue(value);
  return stringValue(value);
}

function pickColumns(row: Row, columns: readonly string[], overrides: Row = {}): Row | null {
  const picked: Row = {};
  for (const column of columns) {
    let value = Object.prototype.hasOwnProperty.call(overrides, column)
      ? overrides[column]
      : cleanColumn(column, row[column]);
    if (value === null || value === undefined) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_COLUMN_VALUES, column)) {
        value = DEFAULT_COLUMN_VALUES[column];
      } else if (TIMESTAMP_DEFAULT_COLUMNS.has(column)) {
        value = new Date().toISOString();
      }
    }
    picked[column] = value;
  }
  return picked;
}

function selectPersonalRows(
  config: (typeof PERSONAL_TABLES)[keyof typeof PERSONAL_TABLES],
  profileId: string
): Row[] {
  const columns = config.columns.join(', ');
  const rows = db.prepare(`
    SELECT ${columns} FROM ${config.table}
    WHERE profile_id = ?
    ORDER BY ${config.orderBy}
    LIMIT ?
  `).all(profileId, config.limit) as Row[];
  return rows;
}

function selectIn(columns: string[], table: string, ids: string[]): Row[] {
  if (ids.length === 0) return [];
  const unique = Array.from(new Set(ids.filter(Boolean))).slice(0, 1500);
  const placeholders = unique.map(() => '?').join(', ');
  return db.prepare(
    `SELECT ${columns.join(', ')} FROM ${table} WHERE id IN (${placeholders})`
  ).all(...unique) as Row[];
}

export interface PublicContextSnapshot {
  version: number;
  exportedAt: string;
  handle: string;
  profile: {
    handle: string;
    displayName: string;
    avatar: string | null;
    rating: number | null;
    maxRating: number | null;
    rank: string | null;
    maxRank: string | null;
  };
  dailySets: Row[];
  dailyProblems: Row[];
  reviewQueue: Row[];
  solveSessions: Row[];
  contestReviews: Row[];
  userContests: Row[];
  weeklyGoals: Row[];
  learningEvents: Row[];
  learnerState: Row | null;
  problems: Row[];
  contestProblemsMeta: Row[];
}

export function exportPublicContext(profileId: string): PublicContextSnapshot {
  const profile = getProfileById(profileId);
  if (!profile) throw new Error('Profile not found');

  const dailySets = selectPersonalRows(PERSONAL_TABLES.dailySets, profileId);
  const dailyProblems = selectPersonalRows(PERSONAL_TABLES.dailyProblems, profileId);
  const reviewQueue = selectPersonalRows(PERSONAL_TABLES.reviewQueue, profileId);
  const solveSessions = selectPersonalRows(PERSONAL_TABLES.solveSessions, profileId);
  const contestReviews = selectPersonalRows(PERSONAL_TABLES.contestReviews, profileId);
  const userContests = selectPersonalRows(PERSONAL_TABLES.userContests, profileId);
  const weeklyGoals = selectPersonalRows(PERSONAL_TABLES.weeklyGoals, profileId);
  const learningEvents = selectPersonalRows(PERSONAL_TABLES.learningEvents, profileId);

  const problemIds = new Set<string>();
  for (const row of dailyProblems) if (row.problem_id) problemIds.add(String(row.problem_id));
  for (const row of reviewQueue) if (row.problem_id) problemIds.add(String(row.problem_id));
  for (const row of solveSessions) if (row.problem_id) problemIds.add(String(row.problem_id));
  for (const row of learningEvents) if (row.problem_id) problemIds.add(String(row.problem_id));
  for (const row of contestReviews) {
    if (row.contest_id && row.problem_index) problemIds.add(`${row.contest_id}_${row.problem_index}`);
  }

  const problems = selectIn(PROBLEM_COLUMNS, 'problems', Array.from(problemIds));
  const contestProblemsMeta = selectIn(CONTEST_META_COLUMNS, 'contest_problems_meta', Array.from(problemIds));

  const learnerRow = db.prepare(
    `SELECT ${LEARNER_COLUMNS.join(', ')} FROM learner_profile_state WHERE profile_id = ?`
  ).get(profileId) as Row | undefined;

  return {
    version: PUBLIC_CONTEXT_VERSION,
    exportedAt: new Date().toISOString(),
    handle: profile.handle,
    profile: {
      handle: profile.handle,
      displayName: profile.displayName || profile.handle,
      avatar: profile.avatar ?? null,
      rating: profile.rating ?? null,
      maxRating: profile.maxRating ?? null,
      rank: profile.rank ?? null,
      maxRank: profile.maxRank ?? null,
    },
    dailySets,
    dailyProblems,
    reviewQueue,
    solveSessions,
    contestReviews,
    userContests,
    weeklyGoals,
    learningEvents,
    learnerState: learnerRow || null,
    problems,
    contestProblemsMeta,
  };
}

function asRows(value: unknown, max: number): Row[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).filter(isRecord);
}

function upsertRow(
  table: string,
  columns: string[],
  row: Row,
  conflictColumn: string,
  update: boolean
): number {
  const placeholders = columns.map(() => '?').join(', ');
  const conflict = update
    ? `DO UPDATE SET ${columns
        .filter((column) => column !== conflictColumn)
        .map((column) => `${column} = excluded.${column}`)
        .join(', ')}`
    : 'DO NOTHING';
  const result = db.prepare(`
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(${conflictColumn}) ${conflict}
  `).run(...columns.map((column) => sqlValue(row[column])));
  return Number(result.changes || 0);
}

function upsertPersonalRow(
  table: string,
  columns: string[],
  row: Row,
  conflictColumn: string,
  timestampColumn: string | null
): number {
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((column) => column !== conflictColumn)
    .map((column) => {
      if (['notes', 'problem_opinion', 'review_notes', 'self_review_notes', 'reflection_notes', 'key_takeaway'].includes(column)) {
        return `${column} = COALESCE(excluded.${column}, ${table}.${column})`;
      }
      return `${column} = excluded.${column}`;
    })
    .join(', ');
  const guard = timestampColumn
    ? `WHERE excluded.${timestampColumn} >= COALESCE(${table}.${timestampColumn}, '')`
    : '';
  // No conflict target: browser snapshots may reuse a natural key (for
  // example profile_id + week_start_date) with a different generated id.
  const result = db.prepare(`
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT DO UPDATE SET ${updates} ${guard}
  `).run(...columns.map((column) => sqlValue(row[column])));
  return Number(result.changes || 0);
}

function canWritePersonalRow(table: string, id: string, profileId: string): boolean {
  const existing = db.prepare(`SELECT profile_id FROM ${table} WHERE id = ?`).get(id) as
    | { profile_id: string }
    | undefined;
  return !existing || existing.profile_id === profileId;
}

export interface ImportContextResult {
  imported: boolean;
  counts: Record<string, number>;
  skipped: number;
}

export function importPublicContext(profileId: string, raw: unknown): ImportContextResult {
  const profile = getProfileById(profileId);
  if (!profile) throw new Error('Profile not found');
  if (!isRecord(raw)) throw new Error('Context must be an object');
  if (Number(raw.version) !== PUBLIC_CONTEXT_VERSION) {
    throw new Error(`Unsupported context version: ${String(raw.version)}`);
  }

  const counts: Record<string, number> = {};
  let skipped = 0;

  const dailySets = asRows(raw.dailySets, MAX_DAILY_SETS);
  const dailyProblems = asRows(raw.dailyProblems, MAX_DAILY_PROBLEMS);
  const reviewQueue = asRows(raw.reviewQueue, MAX_REVIEW_ITEMS);
  const solveSessions = asRows(raw.solveSessions, MAX_SESSIONS);
  const contestReviews = asRows(raw.contestReviews, MAX_CONTEST_REVIEWS);
  const userContests = asRows(raw.userContests, MAX_USER_CONTESTS);
  const weeklyGoals = asRows(raw.weeklyGoals, MAX_WEEKLY_GOALS);
  const learningEvents = asRows(raw.learningEvents, MAX_LEARNING_EVENTS);
  const problems = asRows(raw.problems, 1500);
  const contestProblemsMeta = asRows(raw.contestProblemsMeta, 1500);

  db.exec('BEGIN TRANSACTION');
  try {
    for (const row of problems) {
      const id = stringValue(row.id, 200);
      const contestId = numberValue(row.contest_id);
      const index = stringValue(row.problem_index, 50);
      if (!id || contestId === null || !index) { skipped++; continue; }
      const cleaned = pickColumns(row, PROBLEM_COLUMNS, { id, contest_id: contestId, problem_index: index });
      if (cleaned) counts.problems = (counts.problems || 0) + upsertRow('problems', PROBLEM_COLUMNS, cleaned, 'id', false);
    }

    for (const row of contestProblemsMeta) {
      const id = stringValue(row.id, 200);
      const contestId = numberValue(row.contest_id);
      const index = stringValue(row.problem_index, 50);
      if (!id || contestId === null || !index) { skipped++; continue; }
      const cleaned = pickColumns(row, CONTEST_META_COLUMNS, { id, contest_id: contestId, problem_index: index });
      if (cleaned) counts.contestProblemsMeta = (counts.contestProblemsMeta || 0) + upsertRow('contest_problems_meta', CONTEST_META_COLUMNS, cleaned, 'id', false);
    }

    const availableSetIds = new Set<string>(
      (db.prepare('SELECT id FROM daily_sets WHERE profile_id = ?').all(profileId) as Array<{ id: string }>)
        .map((row) => row.id)
    );
    const existingSetByDate = new Map<string, string>();
    for (const row of db.prepare('SELECT id, date FROM daily_sets WHERE profile_id = ?').all(profileId) as Array<{ id: string; date: string }>) {
      existingSetByDate.set(String(row.date), String(row.id));
    }

    for (const row of dailySets) {
      const id = stringValue(row.id, 200);
      const date = stringValue(row.date, 10);
      if (
        !id ||
        !date ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !id.startsWith(`${profileId}_`) ||
        !canWritePersonalRow('daily_sets', id, profileId)
      ) {
        skipped++;
        continue;
      }
      const existingId = existingSetByDate.get(date);
      if (existingId) {
        availableSetIds.add(existingId);
        continue;
      }
      const cleaned = pickColumns(row, PERSONAL_TABLES.dailySets.columns, {
        id,
        profile_id: profileId,
        date,
      });
      if (!cleaned) { skipped++; continue; }
      const changed = upsertRow('daily_sets', [...PERSONAL_TABLES.dailySets.columns], cleaned, 'id', false);
      counts.dailySets = (counts.dailySets || 0) + changed;
      if (changed > 0) {
        availableSetIds.add(id);
        existingSetByDate.set(date, id);
      }
    }

    const problemExists = (problemId: string): boolean => Boolean(
      db.prepare('SELECT 1 FROM problems WHERE id = ?').get(problemId)
    );

    for (const row of dailyProblems) {
      const id = stringValue(row.id, 200);
      const setId = stringValue(row.daily_set_id, 200);
      const problemId = stringValue(row.problem_id, 200);
      if (
        !id ||
        !setId ||
        !problemId ||
        !id.startsWith(`${profileId}_`) ||
        !availableSetIds.has(setId) ||
        !problemExists(problemId) ||
        !canWritePersonalRow('daily_problems', id, profileId)
      ) {
        skipped++;
        continue;
      }
      const cleaned = pickColumns(row, PERSONAL_TABLES.dailyProblems.columns, {
        id,
        daily_set_id: setId,
        profile_id: profileId,
        problem_id: problemId,
      });
      if (!cleaned) { skipped++; continue; }
      counts.dailyProblems = (counts.dailyProblems || 0) + upsertPersonalRow(
        'daily_problems',
        [...PERSONAL_TABLES.dailyProblems.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of reviewQueue) {
      const id = stringValue(row.id, 300);
      const problemId = stringValue(row.problem_id, 200);
      if (!id || !problemId || !canWritePersonalRow('review_queue', id, profileId)) { skipped++; continue; }
      const cleaned = pickColumns(row, PERSONAL_TABLES.reviewQueue.columns, {
        id,
        profile_id: profileId,
        problem_id: problemId,
      });
      if (!cleaned) { skipped++; continue; }
      counts.reviewQueue = (counts.reviewQueue || 0) + upsertPersonalRow(
        'review_queue',
        [...PERSONAL_TABLES.reviewQueue.columns],
        cleaned,
        'id',
        null
      );
    }

    for (const row of solveSessions) {
      const id = stringValue(row.id, 200);
      const problemId = stringValue(row.problem_id, 200);
      if (!id || !problemId || !canWritePersonalRow('solve_sessions', id, profileId)) { skipped++; continue; }
      const cleaned = pickColumns(row, PERSONAL_TABLES.solveSessions.columns, {
        id,
        profile_id: profileId,
        problem_id: problemId,
      });
      if (!cleaned) { skipped++; continue; }
      counts.solveSessions = (counts.solveSessions || 0) + upsertPersonalRow(
        'solve_sessions',
        [...PERSONAL_TABLES.solveSessions.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of contestReviews) {
      const id = stringValue(row.id, 300);
      const contestId = numberValue(row.contest_id);
      const index = stringValue(row.problem_index, 50);
      if (!id || contestId === null || !index || !canWritePersonalRow('contest_problem_reviews', id, profileId)) {
        skipped++;
        continue;
      }
      const cleaned = pickColumns(row, PERSONAL_TABLES.contestReviews.columns, {
        id,
        profile_id: profileId,
        contest_id: contestId,
        problem_index: index,
      });
      if (!cleaned) { skipped++; continue; }
      counts.contestReviews = (counts.contestReviews || 0) + upsertPersonalRow(
        'contest_problem_reviews',
        [...PERSONAL_TABLES.contestReviews.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of userContests) {
      const id = stringValue(row.id, 300);
      const contestId = numberValue(row.contest_id);
      if (!id || contestId === null || !canWritePersonalRow('user_contests', id, profileId)) {
        skipped++;
        continue;
      }
      const cleaned = pickColumns(row, PERSONAL_TABLES.userContests.columns, {
        id,
        profile_id: profileId,
        contest_id: contestId,
      });
      if (!cleaned) { skipped++; continue; }
      counts.userContests = (counts.userContests || 0) + upsertPersonalRow(
        'user_contests',
        [...PERSONAL_TABLES.userContests.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of weeklyGoals) {
      const id = stringValue(row.id, 300);
      const weekStart = stringValue(row.week_start_date, 10);
      if (!id || !weekStart || !canWritePersonalRow('weekly_goals', id, profileId)) {
        skipped++;
        continue;
      }
      const cleaned = pickColumns(row, PERSONAL_TABLES.weeklyGoals.columns, {
        id,
        profile_id: profileId,
        week_start_date: weekStart,
      });
      if (!cleaned) { skipped++; continue; }
      counts.weeklyGoals = (counts.weeklyGoals || 0) + upsertPersonalRow(
        'weekly_goals',
        [...PERSONAL_TABLES.weeklyGoals.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of learningEvents) {
      const id = stringValue(row.id, 200);
      const problemId = stringValue(row.problem_id, 200);
      const source = stringValue(row.source, 50);
      if (!id || !problemId || !source) { skipped++; continue; }
      const cleaned = pickColumns(row, PERSONAL_TABLES.learningEvents.columns, {
        id,
        profile_id: profileId,
        problem_id: problemId,
        source,
      });
      if (!cleaned) { skipped++; continue; }
      const result = db.prepare(`
        INSERT OR IGNORE INTO problem_learning_events (${PERSONAL_TABLES.learningEvents.columns.join(', ')})
        VALUES (${PERSONAL_TABLES.learningEvents.columns.map(() => '?').join(', ')})
      `).run(...PERSONAL_TABLES.learningEvents.columns.map((column) => sqlValue(cleaned[column])));
      counts.learningEvents = (counts.learningEvents || 0) + Number(result.changes || 0);
    }

    if (isRecord(raw.learnerState)) {
      const dataJson = stringValue(raw.learnerState.data_json, 250000);
      const updatedAt = stringValue(raw.learnerState.updated_at, 40) || new Date().toISOString();
      if (dataJson) {
        const result = db.prepare(`
          INSERT INTO learner_profile_state (profile_id, handle, data_json, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(profile_id) DO UPDATE SET
            handle = excluded.handle,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
          WHERE excluded.updated_at >= COALESCE(learner_profile_state.updated_at, '')
        `).run(profileId, profile.handle, dataJson, updatedAt);
        counts.learnerState = Number(result.changes || 0);
      }
    }

    const profileMeta = isRecord(raw.profile) ? raw.profile : null;
    if (profileMeta) {
      db.prepare(`
        UPDATE profiles
        SET avatar = COALESCE(?, avatar),
            rating = COALESCE(?, rating),
            max_rating = COALESCE(?, max_rating),
            rank = COALESCE(?, rank),
            max_rank = COALESCE(?, max_rank)
        WHERE id = ?
      `).run(
        stringValue(profileMeta.avatar, 1000),
        numberValue(profileMeta.rating),
        numberValue(profileMeta.maxRating),
        stringValue(profileMeta.rank, 100),
        stringValue(profileMeta.maxRank, 100),
        profileId
      );
    }

    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }

  return { imported: true, counts, skipped };
}
