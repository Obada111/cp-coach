import { db, getProfileById } from './db.js';
import { createHash } from 'node:crypto';

/**
 * Browser-owned personal state.
 *
 * The public deployment keeps an ephemeral SQLite database so that the full
 * recommendation/analysis engine can run unchanged. The browser stores the
 * authoritative snapshot of everything personal (assignments, feedback,
 * reviews, reflections and goals) and uploads it after a cold start.
 */
export const PUBLIC_CONTEXT_VERSION = 1;

const preparedStatements = new Map<string, ReturnType<typeof db.prepare>>();

function prepareCached(sql: string): ReturnType<typeof db.prepare> {
  let statement = preparedStatements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    preparedStatements.set(sql, statement);
  }
  return statement;
}

const MAX_DAILY_SETS = 10000;
const MAX_DAILY_PROBLEMS = 30000;
const MAX_REVIEW_ITEMS = 20000;
const MAX_SESSIONS = 20000;
const MAX_CONTEST_REVIEWS = 10000;
const MAX_USER_CONTESTS = 5000;
const MAX_WEEKLY_GOALS = 5000;
const MAX_LEARNING_EVENTS = 50000;
const MAX_PROBLEMS = 50000;

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
  const text = String(value);
  if (text.length > max) throw new Error(`Backup text field exceeds the ${max}-character safety limit`);
  return text;
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
    if (value.length > 250000) {
      throw new Error('Backup JSON field exceeds the 250000-character safety limit');
    }
    try {
      JSON.parse(value);
      return value;
    } catch {
      throw new Error('Backup contains malformed JSON data');
    }
  }
  if (Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    if (serialized.length > 250000) {
      throw new Error('Backup JSON field exceeds the 250000-character safety limit');
    }
    return serialized;
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

function pickColumns(row: Row, columns: readonly string[], overrides: Row = {}): Row {
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
  `).all(profileId, config.limit + 1) as Row[];
  if (rows.length > config.limit) {
    throw new Error(`Backup safety limit exceeded for ${config.table}; no records were omitted from the export.`);
  }
  return rows;
}

function selectIn(columns: string[], table: string, ids: string[]): Row[] {
  if (ids.length === 0) return [];
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const rows: Row[] = [];
  for (let offset = 0; offset < unique.length; offset += 500) {
    const batch = unique.slice(offset, offset + 500);
    const placeholders = batch.map(() => '?').join(', ');
    rows.push(...db.prepare(
      `SELECT ${columns.join(', ')} FROM ${table} WHERE id IN (${placeholders})`
    ).all(...batch) as Row[]);
  }
  if (rows.length > MAX_PROBLEMS) {
    throw new Error(`Backup safety limit exceeded for ${table}; no records were omitted from the export.`);
  }
  return rows;
}

export interface PublicContextSnapshot {
  version: number;
  exportedAt: string;
  profileId: string;
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
    profileId,
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

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const sqlite = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?$/.exec(value);
  const match = iso || sqlite;
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (
    !validDate(`${year}-${month}-${day}`) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) return false;
  const timezone = iso?.[8];
  if (timezone && timezone !== 'Z') {
    const [, , offsetHours, offsetMinutes] = /^([+-])(\d{2}):(\d{2})$/.exec(timezone) || [];
    if (
      offsetHours === undefined ||
      Number(offsetHours) > 14 ||
      Number(offsetMinutes) > 59 ||
      (Number(offsetHours) === 14 && Number(offsetMinutes) !== 0)
    ) return false;
  }
  const normalized = sqlite ? `${value.replace(' ', 'T')}Z` : value;
  return Number.isFinite(Date.parse(normalized));
}

function validateContextRows(raw: Row): void {
  const limits: Record<string, number> = {
    dailySets: MAX_DAILY_SETS,
    dailyProblems: MAX_DAILY_PROBLEMS,
    reviewQueue: MAX_REVIEW_ITEMS,
    solveSessions: MAX_SESSIONS,
    contestReviews: MAX_CONTEST_REVIEWS,
    userContests: MAX_USER_CONTESTS,
    weeklyGoals: MAX_WEEKLY_GOALS,
    learningEvents: MAX_LEARNING_EVENTS,
    problems: MAX_PROBLEMS,
    contestProblemsMeta: MAX_PROBLEMS,
  };
  const requiredKeys: Record<string, string[]> = {
    dailySets: ['id'],
    dailyProblems: ['id'],
    reviewQueue: ['profile_id', 'problem_id'],
    solveSessions: ['id'],
    contestReviews: ['profile_id', 'contest_id', 'problem_index'],
    userContests: ['profile_id', 'contest_id'],
    weeklyGoals: ['profile_id', 'week_start_date'],
    learningEvents: ['id'],
    problems: ['id'],
    contestProblemsMeta: ['contest_id', 'problem_index'],
  };
  const timestampKeys: Record<string, string[]> = {
    dailySets: ['generated_at'],
    dailyProblems: ['updated_at', 'opened_at'],
    reviewQueue: ['added_at', 'last_reviewed_at'],
    solveSessions: ['started_at', 'ended_at', 'created_at', 'updated_at'],
    contestReviews: ['updated_at'],
    userContests: ['created_at', 'updated_at'],
    weeklyGoals: ['updated_at'],
    learningEvents: ['occurred_at'],
    problems: ['updated_at'],
  };
  const dateKeys: Record<string, string[]> = {
    dailySets: ['date'],
    dailyProblems: ['daily_set_date'],
    reviewQueue: ['due_date'],
    weeklyGoals: ['week_start_date'],
  };
  for (const [field, limit] of Object.entries(limits)) {
    const rows = raw[field];
    if (!Array.isArray(rows) || rows.length > limit) {
      throw new Error(`Invalid browser context field: ${field}`);
    }
    const required = requiredKeys[field] || [];
    const timestamps = timestampKeys[field] || [];
    const dates = dateKeys[field] || [];
    for (const row of rows) {
      if (!isRecord(row)) throw new Error(`Invalid browser context field: ${field}`);
      for (const key of required) {
        const value = row[key];
        const valid = typeof value === 'string'
          ? value.trim().length > 0
          : typeof value === 'number' && Number.isFinite(value);
        if (!valid) throw new Error(`Invalid browser context field: ${field}`);
      }
      for (const key of timestamps) {
        if (row[key] !== null && row[key] !== undefined && !validTimestamp(row[key])) {
          throw new Error(`Invalid browser context field: ${field}`);
        }
      }
      for (const key of dates) {
        if (row[key] !== null && row[key] !== undefined && !validDate(row[key])) {
          throw new Error(`Invalid browser context field: ${field}`);
        }
      }
    }
  }
  if (raw.exportedAt !== undefined && !validTimestamp(raw.exportedAt)) {
    throw new Error('Invalid browser context export timestamp');
  }
  if (raw.profileId !== undefined && (typeof raw.profileId !== 'string' || !raw.profileId.trim())) {
    throw new Error('Invalid browser context source profile ID');
  }
  if (raw.learnerState !== null && raw.learnerState !== undefined && !isRecord(raw.learnerState)) {
    throw new Error('Invalid browser context field: learnerState');
  }
  if (
    isRecord(raw.learnerState) &&
    raw.learnerState.updated_at !== undefined &&
    !validTimestamp(raw.learnerState.updated_at)
  ) {
    throw new Error('Invalid learner-state timestamp');
  }
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
  const result = prepareCached(`
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
  const result = prepareCached(`
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT DO UPDATE SET ${updates} ${guard}
  `).run(...columns.map((column) => sqlValue(row[column])));
  return Number(result.changes || 0);
}

function canWritePersonalRow(table: string, id: string, profileId: string): boolean {
  const existing = prepareCached(`SELECT profile_id FROM ${table} WHERE id = ?`).get(id) as
    | { profile_id: string }
    | undefined;
  return !existing || existing.profile_id === profileId;
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

function resolveSourceProfileId(raw: Row, destinationProfileId: string): string {
  const sourceIds = new Set<string>();
  if (typeof raw.profileId === 'string' && raw.profileId.trim()) sourceIds.add(raw.profileId.trim());
  for (const field of Object.keys(PERSONAL_TABLES)) {
    const rows = raw[field] as Row[];
    for (const row of rows) {
      if (typeof row.profile_id === 'string' && row.profile_id.trim()) sourceIds.add(row.profile_id.trim());
    }
  }
  if (isRecord(raw.learnerState) && typeof raw.learnerState.profile_id === 'string') {
    sourceIds.add(raw.learnerState.profile_id);
  }
  if (sourceIds.size > 1) {
    throw new Error('Backup contains personal records from multiple source profiles');
  }
  return sourceIds.values().next().value || destinationProfileId;
}

function remappedSourceKey(destinationProfileId: string, sourceProfileId: string, sourceKey: string): string {
  return stableId('restore_source', destinationProfileId, sourceProfileId, sourceKey);
}

function remapLearnerStateProfileIds(value: unknown, sourceProfileId: string, destinationProfileId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => remapLearnerStateProfileIds(item, sourceProfileId, destinationProfileId));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    (key === 'profileId' || key === 'profile_id') && item === sourceProfileId
      ? destinationProfileId
      : remapLearnerStateProfileIds(item, sourceProfileId, destinationProfileId),
  ]));
}

function remapLearnerStateJson(value: unknown, sourceProfileId: string, destinationProfileId: string): string {
  if (typeof value !== 'string' || value.length > 250000) {
    throw new Error('Backup learner state is missing or exceeds the supported size.');
  }
  try {
    return JSON.stringify(remapLearnerStateProfileIds(
      JSON.parse(value),
      sourceProfileId,
      destinationProfileId
    ));
  } catch (error) {
    if (error instanceof Error && error.message.includes('Backup learner state')) throw error;
    throw new Error('Backup learner state contains malformed JSON.');
  }
}

export type ContextImportMode = 'merge' | 'replace';

export interface ImportContextResult {
  imported: boolean;
  counts: Record<string, number>;
  skipped: number;
  mode: ContextImportMode;
}

const PERSONAL_TABLE_NAMES = Object.values(PERSONAL_TABLES).map((table) => table.table);

function clearPersonalContext(profileId: string): void {
  for (const table of PERSONAL_TABLE_NAMES) {
    db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(profileId);
  }
  db.prepare('DELETE FROM learner_profile_state WHERE profile_id = ?').run(profileId);
}

export function importPublicContext(
  profileId: string,
  raw: unknown,
  options: { mode?: ContextImportMode } = {}
): ImportContextResult {
  const profile = getProfileById(profileId);
  if (!profile) throw new Error('Profile not found');
  if (!isRecord(raw)) throw new Error('Context must be an object');
  if (Number(raw.version) !== PUBLIC_CONTEXT_VERSION) {
    throw new Error(`Unsupported context version: ${String(raw.version)}`);
  }

  const mode = options.mode ?? 'merge';
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error('Import mode must be merge or replace');
  }

  const snapshotHandle = stringValue(raw.handle, 64);
  if (snapshotHandle && snapshotHandle.toLowerCase() !== profile.handle.toLowerCase()) {
    throw new Error('This backup belongs to a different Codeforces handle');
  }
  validateContextRows(raw);

  const counts: Record<string, number> = {};
  const skipped = 0;

  const dailySets = asRows(raw.dailySets, MAX_DAILY_SETS);
  const dailyProblems = asRows(raw.dailyProblems, MAX_DAILY_PROBLEMS);
  const reviewQueue = asRows(raw.reviewQueue, MAX_REVIEW_ITEMS);
  const solveSessions = asRows(raw.solveSessions, MAX_SESSIONS);
  const contestReviews = asRows(raw.contestReviews, MAX_CONTEST_REVIEWS);
  const userContests = asRows(raw.userContests, MAX_USER_CONTESTS);
  const weeklyGoals = asRows(raw.weeklyGoals, MAX_WEEKLY_GOALS);
  const learningEvents = asRows(raw.learningEvents, MAX_LEARNING_EVENTS);
  const problems = asRows(raw.problems, MAX_PROBLEMS);
  const contestProblemsMeta = asRows(raw.contestProblemsMeta, MAX_PROBLEMS);
  const sourceProfileId = resolveSourceProfileId(raw, profileId);
  const profileMapping = new Map([[sourceProfileId, profileId]]);
  const mappedProfileId = profileMapping.get(sourceProfileId);
  if (!mappedProfileId) throw new Error('Backup source profile could not be mapped');
  const sourceDailySetIds = new Set<string>();
  for (const row of dailySets) {
    const id = stringValue(row.id, 200);
    const date = stringValue(row.date, 10);
    if (!id || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
      throw new Error('Backup contains an invalid daily set identity or date');
    }
    sourceDailySetIds.add(id);
  }
  for (const row of dailyProblems) {
    if (!sourceDailySetIds.has(String(row.daily_set_id || ''))) {
      throw new Error('Backup contains a daily problem without its source daily set');
    }
  }
  for (const field of Object.keys(PERSONAL_TABLES)) {
    for (const row of asRows(raw[field], PERSONAL_TABLES[field as keyof typeof PERSONAL_TABLES].limit)) {
      if (row.profile_id !== undefined && String(row.profile_id) !== sourceProfileId) {
        throw new Error(`Backup field ${field} contains a record from another source profile`);
      }
    }
  }
  if (
    isRecord(raw.learnerState) &&
    raw.learnerState.profile_id !== undefined &&
    String(raw.learnerState.profile_id) !== sourceProfileId
  ) {
    throw new Error('Backup learner state belongs to another source profile');
  }

  db.exec('BEGIN TRANSACTION');
  try {
    if (mode === 'replace') {
      clearPersonalContext(profileId);
    }

    for (const row of problems) {
      const id = stringValue(row.id, 200);
      const contestId = numberValue(row.contest_id);
      const index = stringValue(row.problem_index, 50);
      if (!id || contestId === null || !index) throw new Error('Backup contains an invalid problem identity');
      const cleaned = pickColumns(row, PROBLEM_COLUMNS, { id, contest_id: contestId, problem_index: index });
      if (cleaned) counts.problems = (counts.problems || 0) + upsertRow('problems', PROBLEM_COLUMNS, cleaned, 'id', false);
    }

    for (const row of contestProblemsMeta) {
      const id = stringValue(row.id, 200);
      const contestId = numberValue(row.contest_id);
      const index = stringValue(row.problem_index, 50);
      if (!id || contestId === null || !index) throw new Error('Backup contains an invalid contest-problem identity');
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
    const dailySetIdMap = new Map<string, string>();

    for (const row of dailySets) {
      const sourceId = stringValue(row.id, 200);
      const date = stringValue(row.date, 10);
      if (!sourceId || !date) throw new Error('Backup contains an invalid daily set identity');
      const existingId = existingSetByDate.get(date);
      if (existingId) {
        availableSetIds.add(existingId);
        dailySetIdMap.set(sourceId, existingId);
        continue;
      }
      const id = `${profileId}_${date}`;
      const cleaned = pickColumns(row, PERSONAL_TABLES.dailySets.columns, {
        id,
        profile_id: mappedProfileId,
        date,
      });
      const changed = upsertRow('daily_sets', [...PERSONAL_TABLES.dailySets.columns], cleaned, 'id', false);
      counts.dailySets = (counts.dailySets || 0) + changed;
      availableSetIds.add(id);
      existingSetByDate.set(date, id);
      dailySetIdMap.set(sourceId, id);
    }

    const problemExists = (problemId: string): boolean => Boolean(
      prepareCached('SELECT 1 FROM problems WHERE id = ?').get(problemId)
    );
    const dailyProblemIdMap = new Map<string, string>();

    for (const row of dailyProblems) {
      const sourceId = stringValue(row.id, 200);
      const sourceSetId = stringValue(row.daily_set_id, 200);
      const problemId = stringValue(row.problem_id, 200);
      const setId = sourceSetId ? dailySetIdMap.get(sourceSetId) : undefined;
      if (!sourceId || !setId || !problemId) throw new Error('Backup contains a daily problem with an unresolved parent');
      if (!availableSetIds.has(setId)) throw new Error('Backup daily problem references an unavailable destination set');
      if (!problemExists(problemId)) throw new Error(`Backup daily problem references missing problem '${problemId}'`);
      const existing = prepareCached(
        'SELECT id FROM daily_problems WHERE daily_set_id = ? AND problem_id = ?'
      ).get(setId, problemId) as { id: string } | undefined;
      const category = stringValue(row.category, 100);
      const id = existing?.id || (category
        ? `${setId}_${category}`
        : stableId('daily_problem', profileId, setId, problemId));
      if (!canWritePersonalRow('daily_problems', id, profileId)) {
        throw new Error('Backup daily problem identity conflicts with another profile');
      }
      dailyProblemIdMap.set(sourceId, id);
      const cleaned = pickColumns(row, PERSONAL_TABLES.dailyProblems.columns, {
        id,
        daily_set_id: setId,
        profile_id: mappedProfileId,
        problem_id: problemId,
      });
      counts.dailyProblems = (counts.dailyProblems || 0) + upsertPersonalRow(
        'daily_problems',
        [...PERSONAL_TABLES.dailyProblems.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of reviewQueue) {
      const sourceId = stringValue(row.id, 300);
      const problemId = stringValue(row.problem_id, 200);
      if (!sourceId || !problemId) throw new Error('Backup contains an invalid review identity');
      const existing = prepareCached(
        'SELECT id FROM review_queue WHERE profile_id = ? AND problem_id = ?'
      ).get(profileId, problemId) as { id: string } | undefined;
      const id = existing?.id || stableId('review', profileId, problemId);
      if (!canWritePersonalRow('review_queue', id, profileId)) throw new Error('Backup review identity conflicts with another profile');
      const cleaned = pickColumns(row, PERSONAL_TABLES.reviewQueue.columns, {
        id,
        profile_id: profileId,
        problem_id: problemId,
      });
      counts.reviewQueue = (counts.reviewQueue || 0) + upsertPersonalRow(
        'review_queue',
        [...PERSONAL_TABLES.reviewQueue.columns],
        cleaned,
        'id',
        null
      );
    }

    const solveSessionIdMap = new Map<string, string>();
    for (const row of solveSessions) {
      const sourceId = stringValue(row.id, 200);
      const problemId = stringValue(row.problem_id, 200);
      if (!sourceId || !problemId) throw new Error('Backup contains an invalid solve-session identity');
      const sourceOwner = prepareCached('SELECT profile_id FROM solve_sessions WHERE id = ?').get(sourceId) as
        | { profile_id: string }
        | undefined;
      const id = sourceProfileId === profileId && (!sourceOwner || sourceOwner.profile_id === profileId)
        ? sourceId
        : stableId('session', profileId, sourceProfileId, sourceId);
      solveSessionIdMap.set(sourceId, id);
      if (!canWritePersonalRow('solve_sessions', id, profileId)) throw new Error('Backup solve session identity conflicts with another profile');
      const cleaned = pickColumns(row, PERSONAL_TABLES.solveSessions.columns, {
        id,
        profile_id: mappedProfileId,
        problem_id: problemId,
      });
      counts.solveSessions = (counts.solveSessions || 0) + upsertPersonalRow(
        'solve_sessions',
        [...PERSONAL_TABLES.solveSessions.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    const contestReviewIdMap = new Map<string, string>();
    for (const row of contestReviews) {
      const sourceId = stringValue(row.id, 300);
      const contestId = numberValue(row.contest_id);
      const index = stringValue(row.problem_index, 50);
      if (!sourceId || contestId === null || !index) throw new Error('Backup contains an invalid contest-review identity');
      const existing = prepareCached(
        'SELECT id FROM contest_problem_reviews WHERE profile_id = ? AND contest_id = ? AND problem_index = ?'
      ).get(profileId, contestId, index) as { id: string } | undefined;
      const id = existing?.id || stableId('contest_review', profileId, String(contestId), index);
      contestReviewIdMap.set(sourceId, id);
      if (!canWritePersonalRow('contest_problem_reviews', id, profileId)) throw new Error('Backup contest review identity conflicts with another profile');
      const cleaned = pickColumns(row, PERSONAL_TABLES.contestReviews.columns, {
        id,
        profile_id: mappedProfileId,
        contest_id: contestId,
        problem_index: index,
      });
      counts.contestReviews = (counts.contestReviews || 0) + upsertPersonalRow(
        'contest_problem_reviews',
        [...PERSONAL_TABLES.contestReviews.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of userContests) {
      const sourceId = stringValue(row.id, 300);
      const contestId = numberValue(row.contest_id);
      if (!sourceId || contestId === null) throw new Error('Backup contains an invalid user-contest identity');
      const existing = prepareCached(
        'SELECT id FROM user_contests WHERE profile_id = ? AND contest_id = ?'
      ).get(profileId, contestId) as { id: string } | undefined;
      const id = existing?.id || stableId('user_contest', profileId, String(contestId));
      if (!canWritePersonalRow('user_contests', id, profileId)) throw new Error('Backup contest identity conflicts with another profile');
      const cleaned = pickColumns(row, PERSONAL_TABLES.userContests.columns, {
        id,
        profile_id: mappedProfileId,
        contest_id: contestId,
      });
      counts.userContests = (counts.userContests || 0) + upsertPersonalRow(
        'user_contests',
        [...PERSONAL_TABLES.userContests.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of weeklyGoals) {
      const sourceId = stringValue(row.id, 300);
      const weekStart = stringValue(row.week_start_date, 10);
      if (!sourceId || !weekStart) throw new Error('Backup contains an invalid weekly-goal identity');
      const existing = prepareCached(
        'SELECT id FROM weekly_goals WHERE profile_id = ? AND week_start_date = ?'
      ).get(profileId, weekStart) as { id: string } | undefined;
      const id = existing?.id || stableId('weekly_goal', profileId, weekStart);
      if (!canWritePersonalRow('weekly_goals', id, profileId)) throw new Error('Backup weekly goal identity conflicts with another profile');
      const cleaned = pickColumns(row, PERSONAL_TABLES.weeklyGoals.columns, {
        id,
        profile_id: mappedProfileId,
        week_start_date: weekStart,
      });
      counts.weeklyGoals = (counts.weeklyGoals || 0) + upsertPersonalRow(
        'weekly_goals',
        [...PERSONAL_TABLES.weeklyGoals.columns],
        cleaned,
        'id',
        'updated_at'
      );
    }

    for (const row of learningEvents) {
      const sourceId = stringValue(row.id, 200);
      const problemId = stringValue(row.problem_id, 200);
      const source = stringValue(row.source, 50);
      if (!sourceId || !problemId || !source) throw new Error('Backup contains an invalid learning-event identity');
      const originalSourceKey = stringValue(row.source_key, 500);
      let relatedSourceKey = originalSourceKey;
      if (originalSourceKey?.startsWith('daily_open_')) {
        const sourceDailyProblemId = originalSourceKey.slice('daily_open_'.length);
        const destinationDailyProblemId = dailyProblemIdMap.get(sourceDailyProblemId);
        if (!destinationDailyProblemId) {
          throw new Error('Backup learning event references a missing daily problem');
        }
        relatedSourceKey = `daily_open_${destinationDailyProblemId}`;
      } else if (originalSourceKey?.startsWith('legacy_daily_')) {
        const sourceDailyProblemId = originalSourceKey.slice('legacy_daily_'.length);
        const destinationDailyProblemId = dailyProblemIdMap.get(sourceDailyProblemId);
        if (!destinationDailyProblemId) {
          throw new Error('Backup learning event references a missing legacy daily problem');
        }
        relatedSourceKey = `legacy_daily_${destinationDailyProblemId}`;
      } else if (originalSourceKey?.startsWith('legacy_session_')) {
        const sourceSessionId = originalSourceKey.slice('legacy_session_'.length);
        const destinationSessionId = solveSessionIdMap.get(sourceSessionId);
        if (!destinationSessionId) throw new Error('Backup learning event references a missing solve session');
        relatedSourceKey = `legacy_session_${destinationSessionId}`;
      } else if (originalSourceKey?.startsWith('legacy_contest_')) {
        const sourceReviewId = originalSourceKey.slice('legacy_contest_'.length);
        const destinationReviewId = contestReviewIdMap.get(sourceReviewId);
        if (!destinationReviewId) throw new Error('Backup learning event references a missing contest review');
        relatedSourceKey = `legacy_contest_${destinationReviewId}`;
      }
      const logicalIdentity = relatedSourceKey || sourceId;
      const existingEventOwner = prepareCached(
        'SELECT profile_id FROM problem_learning_events WHERE id = ?'
      ).get(sourceId) as { profile_id: string } | undefined;
      const id = sourceProfileId === profileId && (!existingEventOwner || existingEventOwner.profile_id === profileId)
        ? sourceId
        : stableId('learning_event', profileId, sourceProfileId, logicalIdentity);
      const sourceKey = relatedSourceKey
        ? sourceProfileId === profileId && originalSourceKey?.startsWith('restore_source_')
          ? originalSourceKey
          : remappedSourceKey(profileId, sourceProfileId, relatedSourceKey)
        : null;
      if (!canWritePersonalRow('problem_learning_events', id, profileId)) {
        throw new Error('Backup learning-event identity conflicts with another profile');
      }
      const cleaned = pickColumns(row, PERSONAL_TABLES.learningEvents.columns, {
        id,
        profile_id: mappedProfileId,
        problem_id: problemId,
        source,
        source_key: sourceKey,
      });
      const result = prepareCached(`
        INSERT OR IGNORE INTO problem_learning_events (${PERSONAL_TABLES.learningEvents.columns.join(', ')})
        VALUES (${PERSONAL_TABLES.learningEvents.columns.map(() => '?').join(', ')})
      `).run(...PERSONAL_TABLES.learningEvents.columns.map((column) => sqlValue(cleaned[column])));
      if (Number(result.changes || 0) === 0) {
        const existingById = prepareCached(
          'SELECT profile_id FROM problem_learning_events WHERE id = ?'
        ).get(id) as { profile_id: string } | undefined;
        const existingBySourceKey = sourceKey
          ? prepareCached('SELECT profile_id FROM problem_learning_events WHERE source_key = ?').get(sourceKey) as
              | { profile_id: string }
              | undefined
          : undefined;
        if (existingById?.profile_id !== profileId && existingBySourceKey?.profile_id !== profileId) {
          throw new Error('Backup learning-event source identity conflicts with another profile');
        }
      }
      counts.learningEvents = (counts.learningEvents || 0) + Number(result.changes || 0);
    }

    if (isRecord(raw.learnerState)) {
      const dataJson = remapLearnerStateJson(raw.learnerState.data_json, sourceProfileId, profileId);
      const updatedAt = stringValue(raw.learnerState.updated_at, 40) || new Date().toISOString();
      if (dataJson) {
        const result = prepareCached(`
          INSERT INTO learner_profile_state (profile_id, handle, data_json, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(profile_id) DO UPDATE SET
            handle = excluded.handle,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
          WHERE excluded.updated_at >= COALESCE(learner_profile_state.updated_at, '')
        `).run(mappedProfileId, profile.handle, dataJson, updatedAt);
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

  return { imported: true, counts, skipped, mode };
}
