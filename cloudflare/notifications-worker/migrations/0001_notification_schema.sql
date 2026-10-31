PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notification_profiles (
  profile_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  cf_handle TEXT NOT NULL,
  contest_reminders INTEGER NOT NULL DEFAULT 0 CHECK (contest_reminders IN (0, 1)),
  daily_reminders INTEGER NOT NULL DEFAULT 0 CHECK (daily_reminders IN (0, 1)),
  reminder_time TEXT NOT NULL DEFAULT '20:00'
    CHECK (
      length(reminder_time) = 5
      AND reminder_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(reminder_time, 1, 2) AS INTEGER) <= 23
    ),
  timezone TEXT NOT NULL DEFAULT 'Asia/Hebron' CHECK (timezone = 'Asia/Hebron'),
  snapshot_date TEXT,
  daily_snapshot TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(daily_snapshot)),
  snapshot_synced_at TEXT,
  submissions_checked_at TEXT,
  verification_retry_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (profile_id, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_profiles_daily_due
  ON notification_profiles (daily_reminders, reminder_time, profile_id);
CREATE INDEX IF NOT EXISTS idx_notification_profiles_contest_due
  ON notification_profiles (contest_reminders, profile_id);

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  endpoint_hash TEXT PRIMARY KEY CHECK (length(endpoint_hash) = 64),
  profile_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (profile_id, owner_id)
    REFERENCES notification_profiles (profile_id, owner_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_profile_active
  ON notification_subscriptions (profile_id, endpoint_hash) WHERE active = 1;

CREATE TABLE IF NOT EXISTS notification_contests (
  contest_id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'Codeforces' CHECK (platform = 'Codeforces'),
  name TEXT NOT NULL,
  start_time_seconds INTEGER NOT NULL,
  duration_seconds INTEGER,
  phase TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_contests_upcoming
  ON notification_contests (start_time_seconds, contest_id) WHERE phase = 'BEFORE';

CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  notification_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CLAIMED', 'SENT', 'FAILED', 'EXPIRED')),
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  retry_after TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, endpoint_hash, notification_key),
  FOREIGN KEY (profile_id) REFERENCES notification_profiles (profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_pending
  ON notification_deliveries (status, retry_after, claimed_at);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_profile_key
  ON notification_deliveries (profile_id, notification_key, endpoint_hash);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
  ON notification_deliveries (created_at);

CREATE TABLE IF NOT EXISTS notification_worker_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_contest_refresh_at TEXT,
  lock_owner TEXT,
  lock_expires_at TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_success_at TEXT,
  last_status TEXT
);

INSERT OR IGNORE INTO notification_worker_state (singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS notification_worker_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  profiles_checked INTEGER NOT NULL DEFAULT 0,
  pushes_attempted INTEGER NOT NULL DEFAULT 0,
  notifications_sent INTEGER NOT NULL DEFAULT 0,
  duration_ms REAL,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_worker_runs_started
  ON notification_worker_runs (started_at DESC);
