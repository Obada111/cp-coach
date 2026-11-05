import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { UserProfile, CurriculumProblem, LearnerModel } from './types.js';
import { VERIFIED_CURRICULUM_PROBLEMS } from './curriculumData.js';

import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function isEphemeralStoragePath(dirPath: string): boolean {
  const normalized = path.normalize(dirPath).toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  return (
    normalized === '/tmp' ||
    normalized.startsWith('/tmp/') ||
    normalized.startsWith('\\tmp') ||
    normalized.startsWith('/tmp\\') ||
    normalized.includes('/tmp/') ||
    normalized.includes('\\tmp\\') ||
    normalized === tmp ||
    normalized.startsWith(tmp + path.sep)
  );
}

const DB_DIR = process.env.DB_DIR || path.resolve(__dirname, '../data');

if (
  process.env.NODE_ENV === 'production' &&
  isEphemeralStoragePath(DB_DIR) &&
  process.env.ALLOW_EPHEMERAL_DB_FOR_TESTS !== 'true' &&
  process.env.ALLOW_EPHEMERAL_DB_CACHE !== 'true' &&
  !process.env.DATABASE_URL?.trim()
) {
  throw new Error(
    `[Database Configuration Error] Ephemeral storage path ('${DB_DIR}') without durable cloud database backing (DATABASE_URL or ALLOW_EPHEMERAL_DB_CACHE=true) is prohibited for production data persistence.`
  );
}

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export const DB_PATH = path.join(DB_DIR, 'cp_coach.db');
export const db = new DatabaseSync(DB_PATH);
const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';
try {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 8000;');
} catch {}

function backfillProblemJournal(): void {
  try {
    db.exec(`
      INSERT OR IGNORE INTO problem_learning_events (
        id, profile_id, problem_id, source, problem_name, contest_id, problem_index,
        rating, tags, solved_status, perceived_difficulty, struggle_reason, notes,
        verified_ac, source_key, occurred_at
      )
      SELECT
        'legacy_daily_' || dp.id, dp.profile_id, dp.problem_id, 'DAILY_FEEDBACK',
        p.name, p.contest_id, p.problem_index, p.rating, p.tags,
        dp.solved_status, dp.perceived_difficulty, dp.struggle_reason, dp.notes,
        COALESCE(dp.verified_cf_ac, 0), 'legacy_daily_' || dp.id,
        COALESCE(dp.updated_at, dp.daily_set_date)
      FROM daily_problems dp
      JOIN problems p ON p.id = dp.problem_id
      WHERE dp.solved_status IS NOT NULL OR dp.notes IS NOT NULL OR dp.verified_cf_ac = 1;

      INSERT OR IGNORE INTO problem_learning_events (
        id, profile_id, problem_id, source, problem_name, rating, tags,
        solved_status, perceived_difficulty, struggle_reason, notes,
        verified_ac, hints_revealed, editorial_viewed, source_key, occurred_at
      )
      SELECT
        'legacy_session_' || s.id, s.profile_id, s.problem_id, 'SOLVE_SESSION',
        s.problem_name, s.problem_rating, s.tags, s.outcome,
        s.perceived_difficulty, s.struggle_type,
        CASE
          WHEN s.key_takeaway IS NOT NULL AND s.reflection_notes IS NOT NULL
            THEN s.key_takeaway || char(10) || char(10) || s.reflection_notes
          ELSE COALESCE(s.key_takeaway, s.reflection_notes)
        END,
        COALESCE(s.verified_ac, 0), s.hints_revealed, s.editorial_viewed,
        'legacy_session_' || s.id, COALESCE(s.ended_at, s.created_at)
      FROM solve_sessions s
      WHERE s.outcome != 'IN_PROGRESS';

      INSERT OR IGNORE INTO problem_learning_events (
        id, profile_id, problem_id, source, problem_name, contest_id, problem_index,
        rating, tags, solved_status, struggle_reason, notes, source_key, occurred_at
      )
      SELECT
        'legacy_contest_' || r.id, r.profile_id,
        r.contest_id || '_' || r.problem_index, 'CONTEST_REVIEW',
        COALESCE(p.name, m.name, 'Problem ' || r.contest_id || r.problem_index),
        r.contest_id, r.problem_index, COALESCE(p.rating, m.rating),
        COALESCE(p.tags, m.tags, '[]'),
        CASE WHEN r.upsolve_status LIKE 'UPSOLVED%' THEN r.upsolve_status ELSE NULL END,
        r.self_review_tag, r.self_review_notes,
        'legacy_contest_' || r.id, COALESCE(r.updated_at, datetime('now'))
      FROM contest_problem_reviews r
      LEFT JOIN problems p ON p.id = (r.contest_id || '_' || r.problem_index)
      LEFT JOIN contest_problems_meta m ON m.contest_id = r.contest_id AND m.problem_index = r.problem_index;
    `);
  } catch (err) {
    console.warn('[Database] Journal backfill skipped:', err);
  }
}

export function initDatabase() {
  // 1. Create base tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS profile_ownership_migrations (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      previous_owner_id TEXT,
      new_owner_id TEXT NOT NULL,
      performed_by TEXT NOT NULL,
      reason TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      rolled_back_at TEXT,
      rolled_back_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_profile_ownership_migrations_profile
      ON profile_ownership_migrations(profile_id, created_at);

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      owner_id TEXT,
      display_name TEXT,
      avatar TEXT,
      rating INTEGER,
      max_rating INTEGER,
      rank TEXT,
      max_rank TEXT,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      contest_reminders INTEGER NOT NULL DEFAULT 0,
      contest_reminder_offsets TEXT NOT NULL DEFAULT '[30]',
      daily_reminders INTEGER NOT NULL DEFAULT 0,
      reminder_time TEXT NOT NULL DEFAULT '20:00',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint_hash TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_profile
      ON push_subscriptions(profile_id);

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      endpoint_hash TEXT NOT NULL,
      notification_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      retry_after TEXT,
      UNIQUE(profile_id, endpoint_hash, notification_key)
    );

    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_retry
      ON notification_deliveries(status, retry_after);

    CREATE TABLE IF NOT EXISTS profile_cache (
      handle TEXT PRIMARY KEY,
      rating INTEGER,
      max_rating INTEGER,
      rank TEXT,
      max_rank TEXT,
      avatar TEXT,
      title_photo TEXT,
      organization TEXT,
      city TEXT,
      country TEXT,
      raw_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rating_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      contest_name TEXT,
      rank INTEGER,
      rating_update_time INTEGER NOT NULL,
      old_rating INTEGER NOT NULL,
      new_rating INTEGER NOT NULL,
      UNIQUE(handle, contest_id)
    );

    CREATE TABLE IF NOT EXISTS problems (
      id TEXT PRIMARY KEY,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      rating INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      solved_count INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Official Codeforces round metadata. Problemset entries do not include
    -- publication dates, so recommendations only use recency when this
    -- evidence has been synced from contest.list.
    CREATE TABLE IF NOT EXISTS codeforces_contests (
      contest_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      start_time_seconds INTEGER NOT NULL,
      duration_seconds INTEGER,
      phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY,
      handle TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      contest_id INTEGER,
      problem_index TEXT,
      verdict TEXT,
      creation_time INTEGER NOT NULL,
      programming_language TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_leases (
      lease_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_handle_problem ON submissions(handle, problem_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_handle_verdict ON submissions(handle, verdict);
    CREATE INDEX IF NOT EXISTS idx_problems_rating ON problems(rating);

    CREATE TABLE IF NOT EXISTS user_contests (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      contest_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      start_time_seconds INTEGER NOT NULL,
      duration_seconds INTEGER DEFAULT 7200,
      participation_type TEXT NOT NULL DEFAULT 'RATED',
      rank INTEGER,
      old_rating INTEGER,
      new_rating INTEGER,
      rating_change INTEGER,
      problems_solved INTEGER DEFAULT 0,
      problems_attempted INTEGER DEFAULT 0,
      total_submissions INTEGER DEFAULT 0,
      penalties INTEGER DEFAULT 0,
      is_official INTEGER DEFAULT 1,
      report_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, contest_id)
    );

    CREATE TABLE IF NOT EXISTS contest_problems_meta (
      id TEXT PRIMARY KEY,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      name TEXT NOT NULL,
      rating INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      cf_url TEXT,
      UNIQUE(contest_id, problem_index)
    );

    CREATE TABLE IF NOT EXISTS contest_problem_reviews (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      self_review_tag TEXT,
      self_review_notes TEXT,
      upsolve_status TEXT NOT NULL DEFAULT 'UNSOLVED',
      upsolved_submission_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, contest_id, problem_index)
    );

    CREATE TABLE IF NOT EXISTS curriculum_problems (
      id TEXT PRIMARY KEY,
      problem_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT NOT NULL,
      name TEXT NOT NULL,
      curriculum_stage TEXT NOT NULL,
      topic TEXT NOT NULL,
      target_rating INTEGER NOT NULL,
      learning_objective TEXT NOT NULL,
      prerequisites TEXT NOT NULL DEFAULT '[]',
      cf_contest_id INTEGER,
      cf_index TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS learner_profile_state (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      handle TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'DAILY_STRUGGLE',
      contest_id INTEGER,
      problem_index TEXT,
      problem_name TEXT NOT NULL,
      rating INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      trigger_reason TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      due_date TEXT NOT NULL,
      interval_days INTEGER NOT NULL DEFAULT 1,
      repetition_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'DUE',
      last_reviewed_at TEXT,
      review_notes TEXT,
      UNIQUE(profile_id, problem_id)
    );

    CREATE TABLE IF NOT EXISTS solve_sessions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL,
      problem_name TEXT,
      problem_rating INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      active_duration_seconds INTEGER NOT NULL DEFAULT 0,
      hints_revealed INTEGER NOT NULL DEFAULT 0,
      editorial_viewed INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'IN_PROGRESS',
      verified_ac INTEGER NOT NULL DEFAULT 0,
      perceived_difficulty TEXT,
      struggle_type TEXT,
      key_takeaway TEXT,
      reflection_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS problem_learning_events (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL,
      source TEXT NOT NULL,
      problem_name TEXT,
      contest_id INTEGER,
      problem_index TEXT,
      rating INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      solved_status TEXT,
      perceived_difficulty TEXT,
      difficulty_experience TEXT,
      solution_method TEXT,
      struggle_reason TEXT,
      notes TEXT,
      problem_opinion TEXT,
      verified_ac INTEGER NOT NULL DEFAULT 0,
      hints_revealed INTEGER,
      editorial_viewed INTEGER,
      source_key TEXT UNIQUE,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekly_goals (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      week_start_date TEXT NOT NULL,
      target_solves INTEGER NOT NULL DEFAULT 15,
      target_contests INTEGER NOT NULL DEFAULT 1,
      target_upsolves INTEGER NOT NULL DEFAULT 3,
      focus_topics TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, week_start_date)
    );

    CREATE INDEX IF NOT EXISTS idx_user_contests_profile ON user_contests(profile_id);
    CREATE INDEX IF NOT EXISTS idx_user_contests_profile_contest ON user_contests(profile_id, contest_id);
    CREATE INDEX IF NOT EXISTS idx_contest_problem_reviews_profile ON contest_problem_reviews(profile_id, contest_id);
    CREATE INDEX IF NOT EXISTS idx_curriculum_problems_topic ON curriculum_problems(topic);
    CREATE INDEX IF NOT EXISTS idx_curriculum_problems_rating ON curriculum_problems(target_rating);
    CREATE INDEX IF NOT EXISTS idx_review_queue_profile_due ON review_queue(profile_id, due_date, state);
    CREATE INDEX IF NOT EXISTS idx_solve_sessions_profile ON solve_sessions(profile_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_problem_learning_events_profile ON problem_learning_events(profile_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_problem_learning_events_problem ON problem_learning_events(profile_id, problem_id, occurred_at);
  `);

  migrateProfilesForPublicAccess();
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, detail)
    VALUES ('0001_initial_schema', 'Base CP Coach SQLite schema')
  `).run();

  // 2. Ensure the local default profile exists. A public deployment starts
  // empty and creates isolated profiles from validated browser requests.
  if (!PUBLIC_MODE) {
    const existingProfile = db.prepare('SELECT id FROM profiles WHERE handle = ?').get('Obadajo');
    if (!existingProfile) {
      const cached = db.prepare('SELECT * FROM profile_cache WHERE handle = ?').get('Obadajo') as any;
      db.prepare(`
        INSERT INTO profiles (id, handle, display_name, avatar, rating, max_rating, rank, max_rank, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        'prof_obadajo',
        'Obadajo',
        'Obadajo',
        cached?.avatar || null,
        cached?.rating || 1367,
        cached?.max_rating || 1426,
        cached?.rank || 'pupil',
        cached?.max_rank || 'specialist'
      );
    }
  }

  // 3. Schema migration check for daily_sets & daily_problems
  let dailySetsNeedMigration = false;
  try {
    const cols = (db.prepare('PRAGMA table_info(daily_sets)').all() as any[]).map((c) => c.name);
    if (cols.length > 0 && !cols.includes('profile_id')) {
      dailySetsNeedMigration = true;
    }
  } catch {
    // Table doesn't exist yet
  }

  if (dailySetsNeedMigration) {
    console.log('[Database Migration] Safely migrating daily_sets and daily_problems to support multi-profile...');
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN TRANSACTION;');
    try {
      db.exec(`
        CREATE TABLE daily_sets_new (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          generated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(profile_id, date)
        );

        CREATE TABLE daily_problems_new (
          id TEXT PRIMARY KEY,
          daily_set_id TEXT NOT NULL REFERENCES daily_sets_new(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          daily_set_date TEXT NOT NULL,
          problem_id TEXT NOT NULL REFERENCES problems(id),
          category TEXT NOT NULL,
          reason TEXT NOT NULL,
          target_rating INTEGER NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          solved_status TEXT,
          perceived_difficulty TEXT,
          difficulty_experience TEXT,
          solution_method TEXT,
          time_spent_minutes INTEGER,
          notes TEXT,
          problem_opinion TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(daily_set_id, problem_id)
        );
      `);

      const oldSets = db.prepare('SELECT * FROM daily_sets').all() as any[];
      for (const s of oldSets) {
        const newId = `prof_obadajo_${s.date}`;
        db.prepare('INSERT INTO daily_sets_new (id, profile_id, date, generated_at) VALUES (?, ?, ?, ?)').run(
          newId,
          'prof_obadajo',
          s.date,
          s.generated_at
        );
      }

      const oldProbs = db.prepare('SELECT * FROM daily_problems').all() as any[];
      for (const p of oldProbs) {
        const dailySetId = `prof_obadajo_${p.daily_set_date}`;
        db.prepare(`
          INSERT INTO daily_problems_new (
            id, daily_set_id, profile_id, daily_set_date, problem_id, category, reason,
            target_rating, completed, solved_status, perceived_difficulty, time_spent_minutes, notes, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          p.id,
          dailySetId,
          'prof_obadajo',
          p.daily_set_date,
          p.problem_id,
          p.category,
          p.reason,
          p.target_rating,
          p.completed,
          p.solved_status,
          p.perceived_difficulty,
          p.time_spent_minutes,
          p.notes,
          p.updated_at
        );
      }

      db.exec('DROP TABLE daily_problems;');
      db.exec('DROP TABLE daily_sets;');
      db.exec('ALTER TABLE daily_sets_new RENAME TO daily_sets;');
      db.exec('ALTER TABLE daily_problems_new RENAME TO daily_problems;');
      db.exec('COMMIT;');
      console.log('[Database Migration] Migration successfully completed. Existing records preserved.');
    } catch (e) {
      db.exec('ROLLBACK;');
      console.error('[Database Migration] Failed to migrate tables:', e);
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  } else {
    // Create new structure directly if daily_sets does not exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_sets (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(profile_id, date)
      );

      CREATE TABLE IF NOT EXISTS daily_problems (
        id TEXT PRIMARY KEY,
        daily_set_id TEXT NOT NULL REFERENCES daily_sets(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        daily_set_date TEXT NOT NULL,
        problem_id TEXT NOT NULL REFERENCES problems(id),
        category TEXT NOT NULL,
        reason TEXT NOT NULL,
        target_rating INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        solved_status TEXT,
        perceived_difficulty TEXT,
        difficulty_experience TEXT,
        solution_method TEXT,
        time_spent_minutes INTEGER,
        notes TEXT,
        problem_opinion TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(daily_set_id, problem_id)
      );
    `);
  }

  const notificationSettingsColumns = db.prepare('PRAGMA table_info(notification_settings)')
    .all() as Array<{ name: string }>;
  if (!notificationSettingsColumns.some((column) => column.name === 'contest_reminder_offsets')) {
    db.exec("ALTER TABLE notification_settings ADD COLUMN contest_reminder_offsets TEXT NOT NULL DEFAULT '[30]';");
  }

  // Create multi-profile indices
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_daily_sets_profile_date ON daily_sets(profile_id, date);
    CREATE INDEX IF NOT EXISTS idx_daily_problems_profile ON daily_problems(profile_id);
    CREATE INDEX IF NOT EXISTS idx_daily_problems_set ON daily_problems(daily_set_id);
  `);

  // Ensure educational columns and verified_cf_ac exist in daily_problems
  try {
    const cols = (db.prepare('PRAGMA table_info(daily_problems)').all() as any[]).map((c) => c.name);
    if (!cols.includes('verified_cf_ac')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN verified_cf_ac INTEGER DEFAULT 0;');
    }
    if (!cols.includes('educational_source')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN educational_source TEXT;');
    }
    if (!cols.includes('educational_source_url')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN educational_source_url TEXT;');
    }
    if (!cols.includes('curriculum_stage')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN curriculum_stage TEXT;');
    }
    if (!cols.includes('learning_objective')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN learning_objective TEXT;');
    }
    if (!cols.includes('prerequisites')) {
      db.exec("ALTER TABLE daily_problems ADD COLUMN prerequisites TEXT DEFAULT '[]';");
    }
    if (!cols.includes('struggle_reason')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN struggle_reason TEXT;');
    }
    if (!cols.includes('difficulty_experience')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN difficulty_experience TEXT;');
    }
    if (!cols.includes('solution_method')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN solution_method TEXT;');
    }
    if (!cols.includes('problem_opinion')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN problem_opinion TEXT;');
    }
    if (!cols.includes('is_opened')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN is_opened INTEGER NOT NULL DEFAULT 0;');
    }
    if (!cols.includes('opened_at')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN opened_at TEXT;');
    }
    if (!cols.includes('attempted')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN attempted INTEGER NOT NULL DEFAULT 0;');
    }
    if (!cols.includes('self_reported_solved')) {
      db.exec('ALTER TABLE daily_problems ADD COLUMN self_reported_solved INTEGER NOT NULL DEFAULT 0;');
    }
  } catch (err) {
    console.warn('Could not ensure state model columns in daily_problems:', err);
  }

  // Add optional journal fields to databases created before richer feedback.
  try {
    const journalCols = (db.prepare('PRAGMA table_info(problem_learning_events)').all() as any[]).map((c) => c.name);
    if (!journalCols.includes('difficulty_experience')) db.exec('ALTER TABLE problem_learning_events ADD COLUMN difficulty_experience TEXT;');
    if (!journalCols.includes('solution_method')) db.exec('ALTER TABLE problem_learning_events ADD COLUMN solution_method TEXT;');
    if (!journalCols.includes('problem_opinion')) db.exec('ALTER TABLE problem_learning_events ADD COLUMN problem_opinion TEXT;');
  } catch (err) {
    console.warn('Could not ensure rich feedback columns in problem journal:', err);
  }

  // Run after daily tables and their migrated columns are guaranteed to exist.
  // Stable source keys make this safe to run on every startup.
  backfillProblemJournal();

  // Ensure index on submissions for quick contest+index lookups
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_handle_contest_index ON submissions(handle, contest_id, problem_index);');
  } catch {}

  // Purge legacy Gym contests (contest_id >= 100000 or 99999) from curriculum table
  try {
    db.prepare('DELETE FROM curriculum_problems WHERE cf_contest_id >= 100000 OR cf_contest_id = 99999 OR cf_contest_id IS NULL OR cf_contest_id <= 0').run();
  } catch {}

  // Seed verified curriculum problems into curriculum_problems table
  try {
    const insertCurriculum = db.prepare(`
      INSERT INTO curriculum_problems (
        id, problem_id, source, source_url, name, curriculum_stage,
        topic, target_rating, learning_objective, prerequisites,
        cf_contest_id, cf_index, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        source_url = excluded.source_url,
        name = excluded.name,
        curriculum_stage = excluded.curriculum_stage,
        topic = excluded.topic,
        target_rating = excluded.target_rating,
        learning_objective = excluded.learning_objective,
        prerequisites = excluded.prerequisites,
        cf_contest_id = excluded.cf_contest_id,
        cf_index = excluded.cf_index
    `);

    const insertProblemPlaceholder = db.prepare(`
      INSERT OR IGNORE INTO problems (id, contest_id, problem_index, name, type, rating, tags, solved_count)
      VALUES (?, ?, ?, ?, 'PROGRAMMING', ?, ?, 500)
    `);

    db.exec('BEGIN TRANSACTION');
    for (const p of VERIFIED_CURRICULUM_PROBLEMS) {
      insertCurriculum.run(
        p.id,
        p.problemId,
        p.source,
        p.sourceUrl,
        p.name,
        p.curriculumStage,
        p.topic,
        p.targetRating,
        p.learningObjective,
        JSON.stringify(p.prerequisites || []),
        p.cfContestId ?? null,
        p.cfIndex ?? null
      );

      // Ensure problem entry exists in problems table for foreign keys and joins
      const contestId = p.cfContestId || 99999;
      const index = p.cfIndex || p.id;
      insertProblemPlaceholder.run(
        p.problemId,
        contestId,
        index,
        p.name,
        p.targetRating,
        JSON.stringify([p.topic])
      );
    }
    db.exec('COMMIT');
  } catch (seedErr) {
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('Could not seed verified curriculum problems:', seedErr);
  }

  // Default active profile setting (local/private mode only).
  if (!PUBLIC_MODE) {
    const activeSetting = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
    if (!activeSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', 'prof_obadajo')").run();
    }
  }
}

export function getAppliedSchemaMigrations(): Array<{ version: string; appliedAt: string; detail: string | null }> {
  const rows = db.prepare(
    'SELECT version, applied_at, detail FROM schema_migrations ORDER BY version ASC'
  ).all() as Array<{ version: string; applied_at: string; detail: string | null }>;
  return rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    detail: row.detail ?? null,
  }));
}

// Curriculum helpers
export function getAllCurriculumProblems(): CurriculumProblem[] {
  const rows = db.prepare(`
    SELECT * FROM curriculum_problems
    WHERE (source_url LIKE 'https://codeforces.com/%' OR source_url LIKE 'http://codeforces.com/%')
      AND cf_contest_id IS NOT NULL AND cf_contest_id > 0 AND cf_contest_id < 100000 AND cf_contest_id != 99999
    ORDER BY target_rating ASC
  `).all() as any[];
  return rows.map((r) => ({
    id: r.id,
    problemId: r.problem_id,
    source: r.source,
    sourceUrl: r.source_url,
    name: r.name,
    curriculumStage: r.curriculum_stage,
    topic: r.topic,
    targetRating: r.target_rating,
    learningObjective: r.learning_objective,
    prerequisites: JSON.parse(r.prerequisites || '[]'),
    cfContestId: r.cf_contest_id,
    cfIndex: r.cf_index,
  }));
}

export function getCurriculumProblem(problemId: string): CurriculumProblem | null {
  const r = db.prepare('SELECT * FROM curriculum_problems WHERE problem_id = ? OR id = ?').get(problemId, problemId) as any;
  if (!r) return null;
  return {
    id: r.id,
    problemId: r.problem_id,
    source: r.source,
    sourceUrl: r.source_url,
    name: r.name,
    curriculumStage: r.curriculum_stage,
    topic: r.topic,
    targetRating: r.target_rating,
    learningObjective: r.learning_objective,
    prerequisites: JSON.parse(r.prerequisites || '[]'),
    cfContestId: r.cf_contest_id,
    cfIndex: r.cf_index,
  };
}

export function saveLearnerState(profileId: string, handle: string, model: LearnerModel): void {
  db.prepare(`
    INSERT INTO learner_profile_state (profile_id, handle, data_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(profile_id) DO UPDATE SET
      handle = excluded.handle,
      data_json = excluded.data_json,
      updated_at = datetime('now')
  `).run(profileId, handle, JSON.stringify(model));
}

export function getLearnerState(profileId: string): LearnerModel | null {
  const r = db.prepare('SELECT data_json FROM learner_profile_state WHERE profile_id = ?').get(profileId) as { data_json: string } | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.data_json) as LearnerModel;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public multi-tenant profile support
// ---------------------------------------------------------------------------

function getTableColumns(table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name));
  } catch {
    return [];
  }
}

function hasUniqueHandleIndex(): boolean {
  try {
    const indexes = db.prepare('PRAGMA index_list(profiles)').all() as any[];
    for (const index of indexes) {
      if (!index.unique) continue;
      const cols = db.prepare('SELECT name FROM pragma_index_info(?)').all(String(index.name)) as any[];
      if (cols.length === 1 && cols[0].name === 'handle') return true;
    }
  } catch (err) {
    console.warn('[Database] Could not inspect profiles indexes:', err);
  }
  return false;
}

/**
 * Older local builds enforced a globally unique Codeforces handle. Public
 * deployments need one isolated profile per browser + handle, so the unique
 * global constraint has to become a per-owner constraint.
 */
function migrateProfilesForPublicAccess(): void {
  const columns = getTableColumns('profiles');
  if (columns.length === 0) return;

  const hasOwnerColumn = columns.includes('owner_id');
  if (hasOwnerColumn && !hasUniqueHandleIndex()) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profiles_handle ON profiles(handle);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_owner_handle
        ON profiles(owner_id, lower(handle)) WHERE owner_id IS NOT NULL;
    `);
    return;
  }

  console.log('[Database Migration] Preparing profiles for public multi-user access...');
  const ownerSelect = hasOwnerColumn ? 'owner_id' : 'NULL';
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec(`
      CREATE TABLE profiles_new (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        owner_id TEXT,
        display_name TEXT,
        avatar TEXT,
        rating INTEGER,
        max_rating INTEGER,
        rank TEXT,
        max_rank TEXT,
        is_default INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO profiles_new (
        id, handle, owner_id, display_name, avatar, rating, max_rating, rank,
        max_rank, is_default, created_at, last_active_at
      )
      SELECT
        id, handle, ${ownerSelect}, display_name, avatar, rating, max_rating, rank,
        max_rank, is_default, created_at, last_active_at
      FROM profiles;
      DROP TABLE profiles;
      ALTER TABLE profiles_new RENAME TO profiles;
      CREATE INDEX idx_profiles_handle ON profiles(handle);
      CREATE UNIQUE INDEX idx_profiles_owner_handle
        ON profiles(owner_id, lower(handle)) WHERE owner_id IS NOT NULL;
    `);
    db.exec('COMMIT;');
    console.log('[Database Migration] Public profile migration completed.');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    console.error('[Database Migration] Public profile migration failed:', err);
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

export function getPublicProfileId(clientId: string, handle: string): string {
  const digest = createHash('sha256')
    .update(`${clientId.trim().toLowerCase()}|${handle.trim().toLowerCase()}`)
    .digest('hex');
  return `pub_${digest.slice(0, 32)}`;
}

export function getOrCreatePublicProfile(clientId: string, handle: string, displayName?: string): UserProfile {
  const cleanHandle = handle.trim();
  const ownerId = clientId.trim().toLowerCase();
  const id = getPublicProfileId(ownerId, cleanHandle);

  const existing = getProfileById(id);
  if (existing) {
    db.prepare("UPDATE profiles SET last_active_at = datetime('now') WHERE id = ?").run(id);
    return existing;
  }

  const existingForOwner = db.prepare(
    'SELECT id FROM profiles WHERE owner_id = ? AND lower(handle) = lower(?)'
  ).get(ownerId, cleanHandle) as { id: string } | undefined;
  if (existingForOwner) {
    db.prepare("UPDATE profiles SET last_active_at = datetime('now') WHERE id = ?").run(existingForOwner.id);
    return getProfileById(existingForOwner.id)!;
  }

  const fallbackDisplayName = displayName?.trim() || cleanHandle;
  db.prepare(`
    INSERT INTO profiles (id, handle, owner_id, display_name, is_default, created_at, last_active_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO NOTHING
  `).run(id, cleanHandle, ownerId, fallbackDisplayName);

  return getProfileById(id)!;
}

export function getProfilesForOwner(clientId: string): UserProfile[] {
  const ownerId = clientId.trim().toLowerCase();
  const rows = db.prepare(
    'SELECT * FROM profiles WHERE owner_id = ? ORDER BY is_default DESC, created_at ASC'
  ).all(ownerId) as any[];
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    ownerId: r.owner_id ?? null,
    displayName: r.display_name || r.handle,
    avatar: r.avatar,
    rating: r.rating,
    maxRating: r.max_rating,
    rank: r.rank,
    maxRank: r.max_rank,
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  }));
}

export function getProfileForOwner(profileId: string, ownerId: string): UserProfile | null {
  const cleanOwnerId = ownerId.trim().toLowerCase();
  const r = db.prepare('SELECT * FROM profiles WHERE id = ? AND owner_id = ?').get(profileId, cleanOwnerId) as any;
  if (!r) return null;
  return {
    id: r.id,
    handle: r.handle,
    ownerId: r.owner_id ?? null,
    displayName: r.display_name || r.handle,
    avatar: r.avatar,
    rating: r.rating,
    maxRating: r.max_rating,
    rank: r.rank,
    maxRank: r.max_rank,
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  };
}

export function isProfileOwnedBy(profileId: string, ownerId: string): boolean {
  const cleanOwnerId = ownerId.trim().toLowerCase();
  const row = db.prepare('SELECT owner_id FROM profiles WHERE id = ?').get(profileId) as { owner_id: string | null } | undefined;
  return Boolean(row && row.owner_id && row.owner_id.toLowerCase() === cleanOwnerId);
}

const PROFILE_DATA_TABLES = [
  'problem_learning_events',
  'solve_sessions',
  'review_queue',
  'contest_problem_reviews',
  'user_contests',
  'weekly_goals',
  'learner_profile_state',
  'daily_problems',
  'daily_sets',
] as const;

const PROFILE_AUXILIARY_TABLES = [
  'notification_deliveries',
  'push_subscriptions',
  'notification_settings',
] as const;

function countProfileRows(profileId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of [...PROFILE_DATA_TABLES, ...PROFILE_AUXILIARY_TABLES]) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ?`).get(profileId) as { c?: number } | undefined;
      counts[table] = Number(row?.c || 0);
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

function deleteProfileRowsUnsafe(profileId: string): void {
  for (const table of [
    ...PROFILE_AUXILIARY_TABLES,
    ...PROFILE_DATA_TABLES,
  ]) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(profileId);
    } catch {
      // Older databases may not have every optional table yet.
    }
  }
  db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
}

export interface LegacyClaimOptions {
  legacyOwnerId?: string | null;
  performedBy?: string;
  reason?: string;
  dryRun?: boolean;
  allowReassign?: boolean;
}

export interface LegacyClaimResult {
  success: boolean;
  dryRun: boolean;
  profile: UserProfile;
  previousOwnerId: string | null;
  targetOwnerId: string;
  alreadyOwned: boolean;
  migratedCounts: Record<string, number>;
  migrationId: string | null;
  warnings: string[];
}

function resolveLegacyTarget(
  targetIdOrHandle: string,
  legacyOwnerId?: string | null,
): any {
  const byId = db.prepare('SELECT * FROM profiles WHERE id = ?').get(targetIdOrHandle) as any;
  if (byId) return byId;

  const rows = db.prepare('SELECT * FROM profiles WHERE lower(handle) = lower(?)').all(targetIdOrHandle) as any[];
  if (rows.length === 0) {
    throw new Error(`Legacy profile '${targetIdOrHandle}' was not found.`);
  }

  if (legacyOwnerId) {
    const cleanLegacyOwner = legacyOwnerId.trim().toLowerCase();
    const owned = rows.filter((row) => (
      typeof row.owner_id === 'string' && row.owner_id.toLowerCase() === cleanLegacyOwner
    ));
    if (owned.length === 1) return owned[0];
    if (owned.length > 1) {
      throw new Error(`Multiple profiles for handle '${targetIdOrHandle}' are owned by '${legacyOwnerId}'. Specify the profile id instead.`);
    }
  }

  const unowned = rows.filter((row) => row.owner_id === null || row.owner_id === '');
  if (!legacyOwnerId && unowned.length === 1) return unowned[0];
  if (rows.length === 1 && !legacyOwnerId) return rows[0];

  throw new Error(
    `Multiple profiles exist for handle '${targetIdOrHandle}'. Specify the exact profile id and, for client-id owned data, the legacy owner id.`
  );
}

/**
 * Explicitly links legacy data to an authenticated Supabase user. This function
 * never uses a request-supplied owner id as the new owner; the caller must pass
 * a verified `userId`. Reassigning a profile that already has a non-null owner
 * additionally requires `allowReassign` and a matching `legacyOwnerId`.
 */
export function claimLegacyProfile(
  userId: string,
  targetIdOrHandle: string,
  options: LegacyClaimOptions = {},
): LegacyClaimResult {
  const cleanOwnerId = userId.trim().toLowerCase();
  const cleanTarget = targetIdOrHandle.trim();
  const legacyOwnerId = options.legacyOwnerId?.trim().toLowerCase() || null;

  const target = resolveLegacyTarget(cleanTarget, legacyOwnerId);
  const previousOwnerId = typeof target.owner_id === 'string' ? target.owner_id : null;
  const alreadyOwned = Boolean(
    previousOwnerId && previousOwnerId.toLowerCase() === cleanOwnerId
  );
  const migratedCounts = countProfileRows(target.id);
  const warnings: string[] = [];

  if (alreadyOwned) {
    return {
      success: true,
      dryRun: options.dryRun === true,
      profile: getProfileById(target.id)!,
      previousOwnerId,
      targetOwnerId: cleanOwnerId,
      alreadyOwned: true,
      migratedCounts,
      migrationId: null,
      warnings,
    };
  }

  if (previousOwnerId) {
    if (!options.allowReassign) {
      throw new Error(
        `Profile '${target.handle}' is owned by legacy client '${previousOwnerId}' and cannot be reassigned without explicit migration approval.`
      );
    }
    if (!legacyOwnerId || previousOwnerId.toLowerCase() !== legacyOwnerId) {
      throw new Error(
        `The legacy owner id does not match the current owner of profile '${target.handle}'. No data was changed.`
      );
    }
  }

  const existingSameHandle = db.prepare(`
    SELECT * FROM profiles
    WHERE lower(owner_id) = lower(?) AND lower(handle) = lower(?) AND id <> ?
  `).get(cleanOwnerId, target.handle, target.id) as any;

  let emptyProfileToRemove: any = null;
  if (existingSameHandle) {
    const existingCounts = countProfileRows(existingSameHandle.id);
    const existingTotal = Object.values(existingCounts).reduce((total, count) => total + count, 0);
    if (existingTotal > 0) {
      throw new Error(
        `Your account already has non-empty profile data for '${target.handle}'. Export that profile first, then use an administrator-assisted merge; no data was changed.`
      );
    }
    emptyProfileToRemove = existingSameHandle;
    warnings.push(
      `The empty auto-created profile '${existingSameHandle.id}' will be removed and replaced by the legacy profile.`
    );
  }

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      profile: getProfileById(target.id)!,
      previousOwnerId,
      targetOwnerId: cleanOwnerId,
      alreadyOwned: false,
      migratedCounts,
      migrationId: null,
      warnings,
    };
  }

  const migrationId = `pom_${randomUUID().replace(/-/g, '')}`;
  const pushSnapshot = db.prepare(
    'SELECT endpoint_hash, owner_id FROM push_subscriptions WHERE profile_id = ?'
  ).all(target.id);

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    if (emptyProfileToRemove) {
      deleteProfileRowsUnsafe(emptyProfileToRemove.id);
    }

    db.prepare(`
      UPDATE profiles
      SET owner_id = ?, last_active_at = datetime('now')
      WHERE id = ?
    `).run(cleanOwnerId, target.id);

    db.prepare(`
      UPDATE push_subscriptions
      SET owner_id = ?, updated_at = datetime('now')
      WHERE profile_id = ?
    `).run(cleanOwnerId, target.id);

    db.prepare(`
      INSERT INTO profile_ownership_migrations (
        id, profile_id, previous_owner_id, new_owner_id, performed_by, reason, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      migrationId,
      target.id,
      previousOwnerId,
      cleanOwnerId,
      options.performedBy || 'authenticated-user',
      options.reason || 'legacy-profile-claim',
      JSON.stringify({
        pushSubscriptions: pushSnapshot,
        removedEmptyProfileId: emptyProfileToRemove?.id || null,
        migratedCounts,
      }),
    );

    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }

  return {
    success: true,
    dryRun: false,
    profile: getProfileById(target.id)!,
    previousOwnerId,
    targetOwnerId: cleanOwnerId,
    alreadyOwned: false,
    migratedCounts,
    migrationId,
    warnings,
  };
}

export interface OwnershipMigrationRecord {
  id: string;
  profileId: string;
  previousOwnerId: string | null;
  newOwnerId: string;
  performedBy: string;
  reason: string | null;
  createdAt: string;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
}

export function listProfileOwnershipMigrations(profileId?: string): OwnershipMigrationRecord[] {
  const rows = (profileId
    ? db.prepare(`
        SELECT * FROM profile_ownership_migrations
        WHERE profile_id = ?
        ORDER BY created_at DESC, id DESC
      `).all(profileId)
    : db.prepare(`
        SELECT * FROM profile_ownership_migrations
        ORDER BY created_at DESC, id DESC
      `).all()) as any[];
  return rows.map((row) => ({
    id: row.id,
    profileId: row.profile_id,
    previousOwnerId: row.previous_owner_id ?? null,
    newOwnerId: row.new_owner_id,
    performedBy: row.performed_by,
    reason: row.reason ?? null,
    createdAt: row.created_at,
    rolledBackAt: row.rolled_back_at ?? null,
    rolledBackBy: row.rolled_back_by ?? null,
  }));
}

/**
 * Reverts an ownership migration only while the profile is still owned by the
 * account that received it. The previous push-subscription owner ids are
 * restored from the audit snapshot.
 */
export function revertProfileOwnershipMigration(
  migrationId: string,
  performedBy: string = 'administrator',
): { success: boolean; profile: UserProfile; previousOwnerId: string | null } {
  const migration = db.prepare(
    'SELECT * FROM profile_ownership_migrations WHERE id = ?'
  ).get(migrationId) as any;
  if (!migration) throw new Error(`Ownership migration '${migrationId}' was not found.`);
  if (migration.rolled_back_at) throw new Error(`Ownership migration '${migrationId}' was already rolled back.`);

  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(migration.profile_id) as any;
  if (!profile) throw new Error('The migrated profile no longer exists. No data was changed.');
  if (
    typeof profile.owner_id !== 'string' ||
    profile.owner_id.toLowerCase() !== String(migration.new_owner_id).toLowerCase()
  ) {
    throw new Error('The profile owner changed after the migration. Refusing to roll back. No data was changed.');
  }

  let detail: { pushSubscriptions?: Array<{ endpoint_hash: string; owner_id: string }> } = {};
  try {
    detail = migration.detail ? JSON.parse(migration.detail) : {};
  } catch {
    detail = {};
  }

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    db.prepare(`
      UPDATE profiles
      SET owner_id = ?, last_active_at = datetime('now')
      WHERE id = ?
    `).run(migration.previous_owner_id ?? null, migration.profile_id);

    for (const subscription of detail.pushSubscriptions || []) {
      db.prepare(`
        UPDATE push_subscriptions
        SET owner_id = ?, updated_at = datetime('now')
        WHERE endpoint_hash = ? AND profile_id = ?
      `).run(subscription.owner_id, subscription.endpoint_hash, migration.profile_id);
    }

    db.prepare(`
      UPDATE profile_ownership_migrations
      SET rolled_back_at = datetime('now'), rolled_back_by = ?
      WHERE id = ?
    `).run(performedBy, migrationId);

    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }

  return {
    success: true,
    profile: getProfileById(migration.profile_id)!,
    previousOwnerId: migration.previous_owner_id ?? null,
  };
}

export function getPublicProfileOwner(profileId: string): string | null {
  const row = db.prepare('SELECT owner_id FROM profiles WHERE id = ?').get(profileId) as { owner_id: string | null } | undefined;
  return row?.owner_id ?? null;
}

export function deletePublicProfile(clientId: string, profileId: string): boolean {
  const ownerId = clientId.trim().toLowerCase();
  const row = db.prepare('SELECT owner_id FROM profiles WHERE id = ?').get(profileId) as { owner_id: string | null } | undefined;
  if (!row || typeof row.owner_id !== 'string' || row.owner_id.toLowerCase() !== ownerId) return false;

  db.exec('BEGIN TRANSACTION');
  try {
    deleteProfileRowsUnsafe(profileId);
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }
  return true;
}

// Profile management helpers
export function getAllProfiles(): UserProfile[] {
  const rows = db.prepare('SELECT * FROM profiles WHERE owner_id IS NULL ORDER BY is_default DESC, created_at ASC').all() as any[];
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    ownerId: r.owner_id ?? null,
    displayName: r.display_name || r.handle,
    avatar: r.avatar,
    rating: r.rating,
    maxRating: r.max_rating,
    rank: r.rank,
    maxRank: r.max_rank,
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  }));
}

export function getProfileById(id: string): UserProfile | null {
  const r = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
  if (!r) return null;
  return {
    id: r.id,
    handle: r.handle,
    ownerId: r.owner_id ?? null,
    displayName: r.display_name || r.handle,
    avatar: r.avatar,
    rating: r.rating,
    maxRating: r.max_rating,
    rank: r.rank,
    maxRank: r.max_rank,
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  };
}

export function getProfileByHandle(handle: string): UserProfile | null {
  const r = db.prepare('SELECT * FROM profiles WHERE owner_id IS NULL AND lower(handle) = lower(?)').get(handle) as any;
  if (!r) return null;
  return {
    id: r.id,
    handle: r.handle,
    ownerId: r.owner_id ?? null,
    displayName: r.display_name || r.handle,
    avatar: r.avatar,
    rating: r.rating,
    maxRating: r.max_rating,
    rank: r.rank,
    maxRank: r.max_rank,
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  };
}

export function createProfile(handle: string, displayName?: string): UserProfile {
  const existing = getProfileByHandle(handle);
  if (existing) {
    return existing;
  }

  const id = `prof_${handle.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now().toString(36)}`;
  db.prepare(`
    INSERT INTO profiles (id, handle, owner_id, display_name, is_default, created_at, last_active_at)
    VALUES (?, ?, NULL, ?, 0, datetime('now'), datetime('now'))
  `).run(id, handle.trim(), displayName?.trim() || handle.trim());

  return getProfileById(id)!;
}

export function updateProfileMeta(
  id: string,
  meta: {
    avatar?: string | null;
    rating?: number | null;
    maxRating?: number | null;
    rank?: string | null;
    maxRank?: string | null;
  }
) {
  db.prepare(`
    UPDATE profiles
    SET 
      avatar = COALESCE(?, avatar),
      rating = COALESCE(?, rating),
      max_rating = COALESCE(?, max_rating),
      rank = COALESCE(?, rank),
      max_rank = COALESCE(?, max_rank),
      last_active_at = datetime('now')
    WHERE id = ?
  `).run(
    meta.avatar ?? null,
    meta.rating ?? null,
    meta.maxRating ?? null,
    meta.rank ?? null,
    meta.maxRank ?? null,
    id
  );
}

export function getActiveProfileId(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (row && getProfileById(row.value)) {
    return row.value;
  }
  const all = getAllProfiles();
  if (all.length > 0) {
    return all[0].id;
  }
  return 'prof_obadajo';
}

export function setActiveProfileId(id: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('active_profile_id', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(id);

  db.prepare("UPDATE profiles SET last_active_at = datetime('now') WHERE id = ?").run(id);
}

export function markProblemOpened(dailyProblemId: string): { success: boolean; problem?: any } {
  db.prepare(`
    UPDATE daily_problems
    SET is_opened = 1,
        opened_at = COALESCE(opened_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(dailyProblemId);

  const row = db.prepare('SELECT * FROM daily_problems WHERE id = ?').get(dailyProblemId) as any;
  return { success: Boolean(row), problem: row };
}

export function syncProfileProblemStatuses(profileId: string, handle: string): { verifiedCount: number; attemptedCount: number } {
  // Retrieve all daily problems assigned to this profile
  const problems = db.prepare(`
    SELECT dp.id, dp.problem_id, dp.completed, dp.verified_cf_ac, dp.self_reported_solved,
           p.contest_id, p.problem_index
    FROM daily_problems dp
    JOIN problems p ON dp.problem_id = p.id
    WHERE dp.profile_id = ?
  `).all(profileId) as any[];

  let verifiedCount = 0;
  let attemptedCount = 0;

  const updateStmt = db.prepare(`
    UPDATE daily_problems
    SET verified_cf_ac = ?,
        attempted = ?,
        completed = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  for (const prob of problems) {
    const contestId = prob.contest_id;
    const index = prob.problem_index;
    const problemId = prob.problem_id;

    // Check for an OK submission by this handle
    const okSub = db.prepare(`
      SELECT id FROM submissions
      WHERE handle = ?
        AND (problem_id = ? OR (contest_id = ? AND problem_index = ?))
        AND verdict = 'OK'
      LIMIT 1
    `).get(handle, problemId, contestId, index);

    if (okSub) {
      verifiedCount++;
      attemptedCount++;
      // Verified AC on Codeforces marks completed = 1
      updateStmt.run(1, 1, 1, prob.id);
    } else {
      // Check if there are any submissions (e.g. WA, TLE, RE)
      const anySub = db.prepare(`
        SELECT id FROM submissions
        WHERE handle = ?
          AND (problem_id = ? OR (contest_id = ? AND problem_index = ?))
        LIMIT 1
      `).get(handle, problemId, contestId, index);

      const hasAttempts = Boolean(anySub);
      if (hasAttempts) attemptedCount++;

      // If user had self-reported completion, completed stays 1, but verified_cf_ac remains 0
      const isCompleted = prob.self_reported_solved === 1 ? 1 : 0;
      updateStmt.run(0, hasAttempts ? 1 : 0, isCompleted, prob.id);
    }
  }

  return { verifiedCount, attemptedCount };
}

export function syncProfileVerifiedAC(profileId: string, handle: string): number {
  const { verifiedCount } = syncProfileProblemStatuses(profileId, handle);
  return verifiedCount;
}
